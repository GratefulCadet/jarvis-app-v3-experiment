# JARVIS Electron App (jarvis-app-v3)

Electron + React UI for the local-first JARVIS assistant: PiP, Command Center,
voice (STT/TTS), and a JSONL bridge to the Python Harness runtime.

## Architecture

```
Renderer (React/Vite)
  ↕ preload IPC
Electron main (voice-ipc / bridge-ipc / tts-manager)
  ↕ JSONL child processes
Python Harness (Qwen → tools → Permission Gate) + faster-whisper STT worker
```

JARVIS runtime reasoning is done by a local model (Qwen3:8B via Ollama) inside
the Python Harness. Electron is UI + process orchestration only.

## Configuration (no machine-specific paths are committed)

All machine-specific locations are resolved in this order:

1. environment variable
2. committed default (portable, repo-relative)
3. built-in fallback derived from the file's own location

| Purpose | Env var | Used by |
| --- | --- | --- |
| Python interpreter for the STT worker | `JARVIS_VOICE_PYTHON` | `electron/voice-ipc.cjs` |
| Whisper model cache directory | `JARVIS_STT_MODEL_DIR` | `electron/voice-worker/stt_worker.py` |
| ElevenLabs API key (optional TTS) | `ELEVENLABS_API_KEY` | `electron/tts-manager.cjs` |
| ElevenLabs voice / model | `ELEVENLABS_VOICE_ID` / `ELEVENLABS_MODEL_ID` | `electron/tts-manager.cjs` |
| Harness repo location | `JARVIS_HARNESS_HOME` | `electron/bridge-ipc.cjs` |
| Real JARVIS memory dir (scratch by default) | `JARVIS_BRIDGE_MEMORY_DIR` | `electron/bridge-ipc.cjs` → Harness bridge |

Without `JARVIS_VOICE_PYTHON`, the worker uses `voice_config.json`'s
`managed_python` if set, then `PYTHON`, then `python` from `PATH`. The
faster-whisper model is downloaded to `<worker>/assets/stt` unless
`JARVIS_STT_MODEL_DIR` is set.

Secrets (`ELEVENLABS_API_KEY`) live only in your environment — never in the
repository (`.env` is gitignored).

## Development

```bash
npm install
npm run dev       # vite + electron
npm run build     # production build
npm run lint
```

Voice worker tests (deterministic, fixture-based):

```bash
node tests/test_stt_worker_transport.cjs
node tests/test_voice_manager.cjs
```

These use the same Python resolution (`JARVIS_VOICE_PYTHON` → `PYTHON` →
`python`); the STT fixtures in `data/voice_stt_fixtures/` are synthetic
TTS-generated WAV files, not real microphone recordings.

## Bridge smoke test

```bash
JARVIS_HARNESS_HOME=<path-to-harness-repo> node scripts/bridge_smoke.cjs
```
