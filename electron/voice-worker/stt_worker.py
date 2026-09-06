# -*- coding: utf-8 -*-
from __future__ import annotations

import json
import os
import sys
import tempfile
import time
import wave
from pathlib import Path
from typing import Any, Dict, List, Optional

import numpy as np

# sounddevice는 마이크 캡처 경로에서만 필요 — 전사-only 구동을 위해 지연 로드
try:
    import sounddevice as sd  # noqa: F811
except ImportError:
    sd = None

from faster_whisper import WhisperModel

# ---- config loading -------------------------------------------------
HERE = Path(__file__).resolve().parent
CONFIG_FILE = HERE / "STT_CONFIG.json"
VOICE_CONFIG_FILE = HERE / "voice_config.json"


def load_json(path: Path) -> Dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


CONFIG: Dict[str, Any] = load_json(CONFIG_FILE)
VOICE_CONFIG: Dict[str, Any] = load_json(VOICE_CONFIG_FILE) if VOICE_CONFIG_FILE.exists() else {}

MODEL_DIR: str = CONFIG.get("model_download_root", str(HERE / "assets" / "stt"))
LANGUAGE: str = CONFIG.get("language", "ko")
BEAM_SIZE: int = int(CONFIG.get("beam_size", 5))
VAD_FILTER_DEFAULT: bool = bool(CONFIG.get("vad_filter", False))
INITIAL_PROMPT: Optional[str] = CONFIG.get("initial_prompt", None)

# ---- Whisper lifecycle ----------------------------------------------
# Loaded ONCE at startup, reused across many transcript requests.
_model: Optional[WhisperModel] = None
_model_load_start: float = 0.0


def build_transcribe_kwargs(
    *,
    language: Optional[str] = None,
    beam_size: Optional[int] = None,
    vad_filter: Optional[bool] = None,
    initial_prompt: Optional[str] = None,
) -> Dict[str, Any]:
    kw: Dict[str, Any] = {}
    if language is None:
        kw["language"] = LANGUAGE
    else:
        kw["language"] = language
    kw["beam_size"] = int(beam_size) if beam_size is not None else BEAM_SIZE
    kw["vad_filter"] = bool(vad_filter) if vad_filter is not None else VAD_FILTER_DEFAULT
    if initial_prompt is None:
        kw["initial_prompt"] = INITIAL_PROMPT
    else:
        kw["initial_prompt"] = initial_prompt
    return kw


def load_model() -> WhisperModel:
    global _model, _model_load_start
    _model_load_start = time.time()
    _model = WhisperModel(
        CONFIG["stt_model"],
        device=str(CONFIG.get("stt_device", "cpu")),
        compute_type=str(CONFIG.get("stt_compute_type", "int8")),
        download_root=MODEL_DIR,
    )
    return _model


def ensure_model() -> WhisperModel:
    global _model
    if _model is None:
        load_model()
    assert _model is not None
    return _model


# ---- WAV normalization ------------------------------------------------
# Legacy voice_assistant.py writes mono float32 and normalizes before int16.
# We reuse the same normalization so Whisper sees the same dynamic range.


def read_wav_float(path: Path) -> tuple[np.ndarray, int]:
    with wave.open(str(path), "rb") as handle:
        channels = handle.getnchannels()
        sampwidth = handle.getsampwidth()
        framerate = handle.getframerate()
        nframes = handle.getnframes()
        raw = handle.readframes(nframes)
    if sampwidth == 2:
        data = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32767.0
    elif sampwidth == 4:
        data = np.frombuffer(raw, dtype="<i4").astype(np.float32) / 2147483647.0
    else:
        data = np.frombuffer(raw, dtype=np.uint8).astype(np.float32) - 128.0
    if channels > 1:
        data = data.reshape(-1, channels).mean(axis=1)
    if framerate <= 0:
        raise ValueError("WAV has invalid framerate")
    return data.astype(np.float32), framerate


def normalize_audio(audio: np.ndarray) -> np.ndarray:
    peak = float(np.max(np.abs(audio))) if audio.size else 0.0
    if peak <= 1e-6:
        return audio.astype(np.float32)
    out = audio / peak
    out = np.clip(out, -1.0, 1.0)
    return out.astype(np.float32)


def write_int16_wav(path: Path, audio: np.ndarray, framerate: int) -> None:
    pcm = np.clip(audio, -1.0, 1.0)
    pcm16 = (pcm * 32767.0).astype(np.int16)
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(framerate)
        handle.writeframes(pcm16.tobytes())


# ---- transcription ---------------------------------------------------
def transcribe_file(
    path: Path,
    *,
    language: Optional[str] = None,
    beam_size: Optional[int] = None,
    vad_filter: Optional[bool] = None,
    initial_prompt: Optional[str] = None,
    normalize: bool = True,
) -> Dict[str, Any]:
    model_loaded_at = _model_load_start
    model = ensure_model()
    src = Path(path)
    if not src.exists():
        return {"ok": False, "error": f"WAV not found: {src}", "model_loaded_at": model_loaded_at}

    t0 = time.time()
    try:
        audio, sr = read_wav_float(src)
    except Exception as exc:
        return {"ok": False, "error": f"WAV read failed: {exc}", "model_loaded_at": model_loaded_at}

    work_audio = normalize_audio(audio) if normalize else audio.astype(np.float32)

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as temp:
        tmp_path = Path(temp.name)
    try:
        write_int16_wav(tmp_path, work_audio, sr)
        kwargs = build_transcribe_kwargs(
            language=language,
            beam_size=beam_size,
            vad_filter=vad_filter,
            initial_prompt=initial_prompt,
        )
        segments, info = model.transcribe(str(tmp_path), **kwargs)
        seg_texts: List[str] = []
        seg_detail: List[Dict[str, Any]] = []
        for seg in segments:
            txt = seg.text.strip()
            if txt:
                seg_texts.append(txt)
                seg_detail.append(
                    {
                        "text": txt,
                        "start": round(seg.start, 3),
                        "end": round(seg.end, 3),
                        "no_speech_prob": float(seg.no_speech_prob),
                        "avg_logprob": float(seg.avg_logprob),
                    }
                )
        text = " ".join(seg_texts).strip()
        return {
            "ok": True,
            "text": text,
            "language": info.language if info is not None else None,
            "language_probability": float(info.language_probability) if info is not None else None,
            "duration_s": round(info.duration, 3) if info is not None else None,
            "model_loaded_at": model_loaded_at,
            "transcribe_seconds": round(time.time() - t0, 3),
            "segments": seg_detail,
            "config": kwargs,
        }
    except Exception as exc:
        return {"ok": False, "error": f"transcribe failed: {exc}", "model_loaded_at": model_loaded_at}
    finally:
        tmp_path.unlink(missing_ok=True)


# ---- mic capture helpers ---------------------------------------------
def list_input_devices() -> List[Dict[str, Any]]:
    if sd is None:
        return []
    devices = sd.query_devices()
    inputs: List[Dict[str, Any]] = []
    for idx, dev in enumerate(devices):
        if int(dev["max_input_channels"]) > 0:
            inputs.append(
                {
                    "index": idx,
                    "name": str(dev["name"]),
                    "max_input_channels": int(dev["max_input_channels"]),
                    "default_samplerate": float(dev["default_samplerate"]),
                }
            )
    return inputs


def select_input_device(device_index: Optional[int] = None) -> Dict[str, Any]:
    inputs = list_input_devices()
    if not inputs:
        raise RuntimeError("No microphone input devices available (sounddevice 미설치 또는 입력 장치 없음)")
    prefer_hardware = bool(CONFIG.get("mic_selection", {}).get("prefer_hardware_mic", True))
    avoid_mapper = bool(CONFIG.get("mic_selection", {}).get("avoid_mapper_and_stereo_mix", True))

    # Windows 의사 장치(가상 캡처)는 실제 마이크가 있을 때 피한다
    WRAPPER_KEYWORDS = ("사운드 매퍼", "주 사운드 캡처", "stereo input", "스테레오 믹스")

    def score(d: Dict[str, Any]) -> tuple[int, int]:
        name = str(d["name"]).lower()
        low_score = 0 if prefer_hardware else 1
        if avoid_mapper and any(kw in name for kw in WRAPPER_KEYWORDS):
            low_score += 1
        return (low_score, -int(d["max_input_channels"]))

    if device_index is not None:
        for d in inputs:
            if int(d["index"]) == device_index:
                return d
        raise RuntimeError(f"Requested mic device {device_index} not found")

    inputs.sort(key=score)
    return inputs[0]


# ---- press/release mic recorder ------------------------------------
# PTT: record_start → (사용자가 말함) → record_stop → (조용하면 silent,
# 아니면 즉시 전사). 모델은 이미 boot에서 로드되어 있으므로 utterance마다
# 다시 로드하지 않는다. 실패 시에만 디버그 WAV를 보존한다(data/voice/debug,
# gitignore). 정상 동작에서는 임시 WAV를 정리한다.

_rec: Dict[str, Any] = {}  # stream, blocks, samplerate, device, t0
DEBUG_DIR = Path(__file__).resolve().parents[1] / "data" / "voice" / "debug"


def _audio_cb(indata: np.ndarray, frames: int, time_info: Any, status: Any) -> None:
    if _rec.get("stream") is not None:
        if status:
            log(f"audio callback status: {status}")
        _rec.setdefault("blocks", []).append(indata.copy())


def record_start(
    *,
    device_index: Optional[int] = None,
    samplerate: Optional[int] = None,
) -> Dict[str, Any]:
    if sd is None:
        return {"ok": False, "error": "sounddevice 미설치 — 마이크 녹음 불가"}
    if _rec.get("stream") is not None:
        return {"ok": False, "error": "이미 녹음 중입니다 — record_stop 먼저 호출"}
    try:
        dev = select_input_device(device_index=device_index)
        sr = int(samplerate) if samplerate is not None else int(dev["default_samplerate"])
        stream = sd.InputStream(
            samplerate=sr,
            channels=1,
            dtype="float32",
            device=int(dev["index"]),
            callback=_audio_cb,
        )
        stream.start()
    except Exception as exc:
        return {"ok": False, "error": f"recording start failed: {exc}"}
    _rec.update({"stream": stream, "blocks": [], "samplerate": sr, "device": dev, "t0": time.time()})
    return {"ok": True, "device": dev, "samplerate": sr}


def _save_debug_wav(tmp: Path) -> Optional[str]:
    try:
        DEBUG_DIR.mkdir(parents=True, exist_ok=True)
        ts = time.strftime("%Y%m%d-%H%M%S")
        target = DEBUG_DIR / f"stt_debug_{ts}_{os.getpid()}.wav"
        tmp.replace(target)
        return str(target)
    except Exception as exc:
        log(f"debug wav 보존 실패: {exc}")
        return None


def record_stop(
    *,
    transcribe: bool = True,
    language: Optional[str] = None,
    beam_size: Optional[int] = None,
    vad_filter: Optional[bool] = None,
    initial_prompt: Optional[str] = None,
) -> Dict[str, Any]:
    state = _rec
    if state.get("stream") is None:
        return {"ok": False, "error": "녹음 중이 아닙니다 — record_start 먼저 호출"}
    stream = state["stream"]
    sr = int(state["samplerate"])
    dev = state["device"]
    t0 = float(state.get("t0", time.time()))
    blocks: List[np.ndarray] = state.get("blocks", [])
    _rec.clear()  # 먼저 비워서 재진입/중복 stop 방지

    try:
        stream.stop()
        stream.close()
    except Exception as exc:
        log(f"stream close warning: {exc}")

    if blocks:
        audio = np.concatenate(blocks) if len(blocks) > 1 else blocks[0]
        audio = audio.astype(np.float32).reshape(-1)
    else:
        audio = np.zeros(0, dtype=np.float32)

    dur_s = round(float(audio.shape[0]) / sr, 3) if audio.size else 0.0
    rms = float(np.sqrt(np.mean(audio**2))) if audio.size else 0.0
    peak = float(np.max(np.abs(audio))) if audio.size else 0.0
    rec_metrics: Dict[str, Any] = {
        "device": dev,
        "samplerate": sr,
        "duration_s": dur_s,
        "rms": round(rms, 6),
        "peak": round(peak, 4),
        "held_seconds": round(time.time() - t0, 3),
    }

    # 무음 판정: 짧거나, 피크/에너지가 문턱 아래면 NO COMMAND
    rec_cfg = CONFIG.get("recording", {})
    min_speech_s = float(rec_cfg.get("min_speech_seconds", 0.25))
    rms_thr = float(rec_cfg.get("silence_rms_threshold", 0.004))
    peak_thr = float(rec_cfg.get("silence_peak_threshold", 0.02))
    if audio.size == 0 or dur_s < min_speech_s or peak < peak_thr or rms < rms_thr:
        return {
            "ok": True,
            "silent": True,
            "text": "",
            "record": rec_metrics,
            "note": "silent recording — no command generated",
        }

    if not transcribe:
        return {"ok": True, "silent": False, "text": "", "record": rec_metrics}

    # 임시 WAV로 변환 후 전사 (정상: 삭제, 실패: 디버그 보존)
    tmp = Path(tempfile.mktemp(suffix=".wav"))
    try:
        write_int16_wav(tmp, normalize_audio(audio), sr)
        res = transcribe_file(
            tmp,
            language=language,
            beam_size=beam_size,
            vad_filter=vad_filter,
            initial_prompt=initial_prompt,
            normalize=False,
        )
    except Exception as exc:
        res = {"ok": False, "error": f"transcribe failed: {exc}"}
    if res.get("ok"):
        tmp.unlink(missing_ok=True)
        return {**res, "silent": False, "record": rec_metrics}
    debug_path = _save_debug_wav(tmp)
    return {"ok": False, **res, "record": rec_metrics, "debug_wav": debug_path}


def record_cancel() -> Dict[str, Any]:
    state = _rec
    if state.get("stream") is None:
        return {"ok": False, "error": "녹음 중이 아닙니다"}
    stream = state["stream"]
    _rec.clear()
    try:
        stream.stop()
        stream.close()
    except Exception as exc:
        log(f"stream close warning on cancel: {exc}")
    return {"ok": True, "note": "recording cancelled — no transcription"}


def record_fixed(
    *,
    duration_s: float,
    device_index: Optional[int] = None,
    samplerate: Optional[int] = None,
    language: Optional[str] = None,
    beam_size: Optional[int] = None,
    vad_filter: Optional[bool] = None,
) -> Dict[str, Any]:
    started = record_start(device_index=device_index, samplerate=samplerate)
    if not started.get("ok"):
        return {"ok": False, "error": started.get("error", "record_start 실패")}
    time.sleep(float(duration_s))
    return record_stop(language=language, beam_size=beam_size, vad_filter=vad_filter)

# ---- worker protocol ------------------------------------------------
# STDOUT = JSONL protocol only.
# STDERR = human/developer logs.


def emit(msg: Dict[str, Any]) -> None:
    line = json.dumps(msg, ensure_ascii=False)
    sys.stdout.write(line + "\n")
    sys.stdout.flush()


def log(msg: str) -> None:
    sys.stderr.write(msg + "\n")
    sys.stderr.flush()


def run_worker() -> int:
    emit({"type": "boot", "status": "starting", "config_file": str(CONFIG_FILE)})

    try:
        load_model()
    except Exception as exc:
        emit({"type": "boot", "status": "failed", "error": f"model_load_failed: {exc}"})
        log(f"FAILED to load Whisper: {exc}")
        return 2

    load_seconds = round(time.time() - _model_load_start, 3)
    emit(
        {
            "type": "voice_ready",
            "status": "ready",
            "model": CONFIG["stt_model"],
            "device": CONFIG.get("stt_device", "cpu"),
            "compute_type": CONFIG.get("stt_compute_type", "int8"),
            "model_load_seconds": load_seconds,
            "language_default": LANGUAGE,
            "beam_size_default": BEAM_SIZE,
            "vad_default": VAD_FILTER_DEFAULT,
            "mic_input_devices": list_input_devices(),
            "devices_total": len(sd.query_devices()) if sd is not None else 0,
            "sounddevice_available": sd is not None,
        }
    )
    log(f"Whisper loaded in {load_seconds}s; ready for transcript requests")

    try:
        while True:
            line = sys.stdin.readline()
            if not line:
                break
            try:
                req = json.loads(line)
            except json.JSONDecodeError:
                log(f"malformed stdin line ignored: {line!r}")
                emit({"type": "error", "error": "malformed_request"})
                continue
            kind = req.get("type")
            if kind == "transcribe_file":
                result = transcribe_file(
                    Path(req["path"]),
                    language=req.get("language"),
                    beam_size=req.get("beam_size"),
                    vad_filter=req.get("vad_filter"),
                    initial_prompt=req.get("initial_prompt"),
                    normalize=req.get("normalize", True),
                )
                emit({"type": "transcript", "id": req.get("id"), **result})
            elif kind == "transcribe_file_verbose":
                result = transcribe_file(
                    Path(req["path"]),
                    language=req.get("language"),
                    beam_size=req.get("beam_size"),
                    vad_filter=req.get("vad_filter"),
                    initial_prompt=req.get("initial_prompt"),
                    normalize=req.get("normalize", True),
                )
                emit({"type": "transcript_verbose", "id": req.get("id"), **result})
            elif kind == "record_start":
                started = record_start(
                    device_index=req.get("device_index"),
                    samplerate=req.get("samplerate"),
                )
                emit({"type": "recording_started", "id": req.get("id"), **started})
            elif kind == "record_stop":
                result = record_stop(
                    transcribe=req.get("transcribe", True),
                    language=req.get("language"),
                    beam_size=req.get("beam_size"),
                    vad_filter=req.get("vad_filter"),
                    initial_prompt=req.get("initial_prompt"),
                )
                emit({"type": "recording_result", "id": req.get("id"), **result})
            elif kind == "record_cancel":
                cancelled = record_cancel()
                emit({"type": "recording_cancelled", "id": req.get("id"), **cancelled})
            elif kind == "record_fixed":
                result = record_fixed(
                    duration_s=req.get("duration_s", float(CONFIG.get("recording", {}).get("default_duration_s", 8))),
                    device_index=req.get("device_index"),
                    samplerate=req.get("samplerate"),
                    language=req.get("language"),
                    beam_size=req.get("beam_size"),
                    vad_filter=req.get("vad_filter"),
                )
                emit({"type": "recording_result", "id": req.get("id"), **result})
            elif kind == "list_input_devices":
                emit({"type": "list_input_devices_result", "id": req.get("id"), "devices": list_input_devices()})
            elif kind == "select_input_device":
                try:
                    dev = select_input_device(device_index=req.get("device_index"))
                    emit({"type": "select_input_device_result", "id": req.get("id"), "device": dev})
                except Exception as exc:
                    emit({"type": "error", "id": req.get("id"), "error": f"select_mic_failed: {exc}"})
            elif kind == "ping":
                emit({"type": "pong", "id": req.get("id"), "uptime_s": round(time.time() - _model_load_start, 3)})
            elif kind == "shutdown":
                emit({"type": "shutdown", "status": "shutting_down"})
                break
            else:
                log(f"unknown request kind: {kind!r}")
                emit({"type": "error", "error": f"unknown_request_kind: {kind}"})
    except Exception as exc:
        log(f"worker crashed: {exc}")
        emit({"type": "error", "error": f"worker_crash: {exc}"})
        return 3

    emit({"type": "voice_ready", "status": "exiting"})
    return 0


def main() -> int:
    if "--help" in sys.argv:
        print("STT worker protocol:\n"
              "  transcribe_file   {type, path, id?, language?, beam_size?, vad_filter?, initial_prompt?, normalize?}\n"
              "  record_start      {type, id?, device_index?, samplerate?}  → recording_started\n"
              "  record_stop       {type, id?, transcribe?}                → recording_result\n"
              "  record_cancel     {type, id?}                             → recording_cancelled\n"
              "  record_fixed      {type, id?, duration_s?}                → recording_result (자동화/테스트용)\n"
              "  list_input_devices {type, id?}\n"
              "  select_input_device {type, id?, device_index?}\n"
              "  ping              {type, id?}\n"
              "  shutdown          {type}",
              file=sys.stderr)
        return 0
    return run_worker()


if __name__ == "__main__":
    raise SystemExit(main())
