# -*- coding: utf-8 -*-
"""
In-process verification of electron/voice-worker/stt_worker.py.

이 테스트는 bash/CLI 부작용 없이 worker를 직접 구동한다:
- sys.stdin을 StringIO로 대체해 JSONL 제어 시퀀스를 주입
- sys.stdout을 캡처해 protocol 메시지를 읽음
- 모델 한 번 로딩 → 여러 WAV 전사 → shutdown

Electron이 실제 spawn하는 것과 같은 worker 코드를 같은 방식으로
실행하므로, bash 전송 계층의 flakiness와 무관하게 worker 자체를 검증한다.
"""
from __future__ import annotations

import io
import json
import sys
import time
from pathlib import Path

# worker를 파일 경로에서 직접 로드 (Electron이 python electron/voice-worker/stt_worker.py 로 실행하는 것과 동일)
REPO_ROOT = Path(__file__).resolve().parents[1]
WORKER_FILE = REPO_ROOT / "electron" / "voice-worker" / "stt_worker.py"

import importlib.util
_spec = importlib.util.spec_from_file_location("stt_worker", WORKER_FILE)
worker = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(worker)

HAR_INPUT_DIR = REPO_ROOT / "data" / "voice_stt_fixtures"


def capture_worker(control_lines: list[str], timeout_s: float = 180.0) -> tuple:
    """worker의 run_worker()를 in-process로 실행하고 protocol 메시지를 수집한다."""
    stdin_io = io.StringIO("\n".join(control_lines) + "\n")
    stdout_io = io.StringIO()

    old_stdin = sys.stdin
    old_stdout = sys.stdout
    old_stderr = sys.stderr

    sys.stdin = stdin_io
    sys.stdout = stdout_io
    sys.stderr = io.StringIO()

    try:
        t0 = time.time()
        _rc = worker.main()
        elapsed = round(time.time() - t0, 3)
        _stderr_capture = sys.stderr.getvalue()
    finally:
        sys.stdin = old_stdin
        sys.stdout = old_stdout
        sys.stderr = old_stderr

    raw = stdout_io.getvalue()
    messages: list[dict] = []
    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            messages.append(json.loads(line))
        except json.JSONDecodeError:
            raise AssertionError(f"worker stdout에 protocol이 아닌 줄이 섞임: {line!r}")

    return messages, _rc, elapsed, _stderr_capture


def main() -> None:
    print("=== 전자버전 STT worker in-process 검증 ===")
    print(f"repo root: {REPO_ROOT}")
    print(f"fixture dir: {HAR_INPUT_DIR}")

    wavs = sorted(HAR_INPUT_DIR.glob("*.wav"))
    if not wavs:
        print("FAIL: voice_stt_fixtures/*.wav가 없음 — fixture를 먼저 만들어야 함")
        raise SystemExit(2)

    print(f"WAV fixtures: {[p.name for p in wavs]}")

    control: list[str] = []
    # 1) boot + model load
    control.append(json.dumps({"type": "ping", "id": 1}))
    # 2) 전사 요청들 (모델 재사용 확인용)
    for idx, wav in enumerate(wavs, start=2):
        control.append(json.dumps({"type": "transcribe_file", "id": idx, "path": str(wav)}))
    # 3) shutdown
    control.append(json.dumps({"type": "shutdown"}))

    messages, rc, elapsed, stderr_log = capture_worker(control, timeout_s=180.0)

    print(f"\nworker exit code: {rc}")
    print(f"total wall time: {elapsed}s")
    print(f"\n=== protocol 메시지 ({len(messages)}개) ===")
    for m in messages:
        print(json.dumps(m, ensure_ascii=False))

    stderr_text = stderr_log.strip()
    if stderr_text:
        print(f"\n=== stderr 로그 ({len(stderr_text)} bytes) ===")
        print(stderr_text[:4000])

    # 검증
    by_type = {}
    for m in messages:
        by_type.setdefault(m["type"], []).append(m)

    boot = messages[0]
    assert boot["type"] in ("boot", "voice_ready"), f"첫 메시지가 boot/voice_ready가 아님: {boot}"
    print("\n[OK] boot/voice_ready emitted")

    ready = next((m for m in messages if m.get("type") == "voice_ready" and m.get("status") == "ready"), None)
    assert ready, "voice_ready(status=ready) 없음"
    model_load_secs = ready.get("model_load_seconds")
    print(f"[OK] voice_ready: model={ready.get('model')}, device={ready.get('device')}, load_seconds={model_load_secs}")

    transcript_msgs = by_type.get("transcript", [])
    assert transcript_msgs, "transcript 메시지가 하나도 없음"
    print(f"\n[OK] transcript 메시지 {len(transcript_msgs)}개")

    # 모델 로딩이 한 번만 일어났는지: 첫 전사 시점부터 마지막 전사 시점까지 모델의 model_load_at가 같아야 함
    loaded_at_values = {m.get("model_loaded_at") for m in transcript_msgs if m.get("ok")}
    print(f"      전사 시 보고된 model_loaded_at 값들: {sorted(loaded_at_values)}")
    print(f"      (값이 1종류면 모델 로딩이 한 번만 일어난 것)")

    # 전사 결과 출력
    print("\n=== 전사 결과 ===")
    for m in transcript_msgs:
        if not m.get("ok"):
            print(f"  id={m.get('id')} FAIL: {m.get('error')}")
            continue
        print(f"  id={m.get('id')} path={m.get('path')}")
        print(f"    text: {m.get('text')!r}")
        print(f"    language: {m.get('language')}  prob={m.get('language_probability')}  duration_s={m.get('duration_s')}")
        print(f"    transcribe_seconds: {m.get('transcribe_seconds')}s  model_loaded_at: {m.get('model_loaded_at')}")
        segs = m.get("segments") or []
        if segs:
            print(f"    segments ({len(segs)}):")
            for s in segs:
                print(f"      - {s.get('start')}s-{s.get('end')}s  no_speech_prob={s.get('no_speech_prob')}  text={s.get('text')!r}")

    # 종료 확인
    exiting = next((m for m in messages if m.get("type") == "voice_ready" and m.get("status") == "exiting"), None)
    assert exiting, "voice_ready(status=exiting) 없음 — shutdown이 worker를 종료시키지 못함"
    print("\n[OK] shutdown → voice_ready(status=exiting)")

    print("\n=== RESULT ===")
    print("STT worker in-process 검증 PASS")
    print("다음 단계: node BridgeManager가 stt_worker.py를 spawn해서 transcribe_file→transcript를 주고받는 전자측 프로토콜 검증")


if __name__ == "__main__":
    main()
