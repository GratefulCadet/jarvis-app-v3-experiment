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

    def score(d: Dict[str, Any]) -> tuple[int, int]:
        name = str(d["name"]).lower()
        low_score = 0 if prefer_hardware else 1
        if avoid_mapper and ("사운드 매퍼" in name or "stereo input" in name or "스테레오 믹스" in name):
            low_score += 1
        return (low_score, -int(d["max_input_channels"]))

    if device_index is not None:
        for d in inputs:
            if int(d["index"]) == device_index:
                return d
        raise RuntimeError(f"Requested mic device {device_index} not found")

    inputs.sort(key=score)
    return inputs[0]


def record_audio(
    *,
    duration_s: float,
    device_index: Optional[int] = None,
    samplerate: Optional[int] = None,
) -> Dict[str, Any]:
    dev = select_input_device(device_index=device_index)
    sr = int(samplerate) if samplerate is not None else int(dev["default_samplerate"])
    frames = int(round(sr * duration_s))
    try:
        audio = sd.rec(frames, samplerate=sr, channels=1, dtype="float32", device=int(dev["index"]))
        sd.wait()
    except Exception as exc:
        return {"ok": False, "error": f"mic record failed: {exc}", "device": dev}
    rms = float(np.sqrt(np.mean(audio**2))) if audio.size else 0.0
    peak = float(np.max(np.abs(audio))) if audio.size else 0.0
    return {
        "ok": True,
        "samples": int(audio.shape[0]),
        "samplerate": sr,
        "device": dev,
        "rms": round(rms, 6),
        "peak": round(peak, 4),
        "duration_s": round(audio.shape[0] / sr, 3),
    }


def record_to_wav(
    *,
    duration_s: float,
    path: Optional[Path] = None,
    device_index: Optional[int] = None,
    samplerate: Optional[int] = None,
) -> Dict[str, Any]:
    rec = record_audio(duration_s=duration_s, device_index=device_index, samplerate=samplerate)
    if not rec["ok"]:
        return rec
    target = path or Path(tempfile.mktemp(suffix=".wav"))
    audio = sd.rec(int(round(rec["samplerate"] * duration_s)),
                   samplerate=rec["samplerate"],
                   channels=1,
                   dtype="float32",
                   device=int(select_input_device(device_index=device_index)["index"]))
    sd.wait()
    write_int16_wav(target, normalize_audio(audio.astype(np.float32)), rec["samplerate"])
    return {"ok": True, "wav": str(target), "record": rec, "note": "temporary recording; clean up after use"}


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
            elif kind == "record_audio":
                rec = record_audio(
                    duration_s=req.get("duration_s", float(CONFIG.get("recording", {}).get("default_duration_s", 8))),
                    device_index=req.get("device_index"),
                    samplerate=req.get("samplerate"),
                )
                emit({"type": "record_result", "id": req.get("id"), **rec})
            elif kind == "record_to_wav":
                rec = record_to_wav(
                    duration_s=req.get("duration_s", float(CONFIG.get("recording", {}).get("default_duration_s", 8))),
                    path=Path(req["path"]) if "path" in req else None,
                    device_index=req.get("device_index"),
                    samplerate=req.get("samplerate"),
                )
                emit({"type": "record_to_wav_result", "id": req.get("id"), **rec})
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
              "  transcribe_file_verbose (same, plus detailed segments)\n"
              "  record_audio      {type, id?, duration_s?, device_index?, samplerate?}\n"
              "  record_to_wav     {type, id?, duration_s?, path?, device_index?, samplerate?}\n"
              "  list_input_devices {type, id?}\n"
              "  select_input_device {type, id?, device_index?}\n"
              "  ping              {type, id?}\n"
              "  shutdown          {type}",
              file=sys.stderr)
        return 0
    return run_worker()


if __name__ == "__main__":
    raise SystemExit(main())
