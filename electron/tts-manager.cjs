/*
  ElevenLabs TTS manager — Electron main only (API key never leaves main).

  Responsibilities:
  - hold xi-api-key in main memory only (from env, never renderer)
  - fetch audio from https://api.elevenlabs.io/v1/text-to-speech/{voiceId}
  - return audio bytes to renderer via IPC (renderer plays it)
  - abort on stop(), fallback handled by renderer

  Security: only `text` string is sent to ElevenLabs. No traces, tool JSON,
  internal state. Key never logged, never exposed via IPC, never committed.

  Streaming fit: buffered POST first (simplest, stable). Streaming variant
  (`/stream?optimize_streaming_latency=4`) can be added behind `stream:true`
  without changing renderer contract — keep boundary lean.
*/
const path = require('node:path')
const fs = require('node:fs')

const DEFAULT_VOICE_ID = 'onwK4e9ZLuTAKqWW03F9' // Daniel - Steady Broadcaster (British male)
const DEFAULT_MODEL_ID = 'eleven_flash_v2_5'
const DEFAULT_OUTPUT_FORMAT = 'mp3_44100_128'

function resolveTtsConfig() {
  const configPath = path.join(__dirname, 'tts-config.json')
  if (!fs.existsSync(configPath)) return {}
  try {
    const raw = fs.readFileSync(configPath, 'utf8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function resolveApiKey() {
  // Primary: ELEVENLABS_API_KEY (ElevenLabs docs). Also support JARVIS_ prefix.
  return (
    process.env.ELEVENLABS_API_KEY ||
    process.env.JARVIS_ELEVENLABS_API_KEY ||
    ''
  )
}

class TtsManager {
  constructor({ onLog = () => {} } = {}) {
    this.onLog = onLog
    this.config = resolveTtsConfig()
    // env overrides file, file overrides defaults
    this.voiceId =
      process.env.ELEVENLABS_VOICE_ID ||
      this.config.voice_id ||
      this.config.voiceId ||
      DEFAULT_VOICE_ID
    this.modelId =
      process.env.ELEVENLABS_MODEL_ID ||
      this.config.model_id ||
      this.config.modelId ||
      DEFAULT_MODEL_ID
    this.outputFormat =
      this.config.output_format ||
      this.config.outputFormat ||
      DEFAULT_OUTPUT_FORMAT
    this.currentAbort = null
    this.lastLatencyMs = null
  }

  get hasKey() {
    return Boolean(resolveApiKey())
  }

  statusInfo() {
    const hasKey = this.hasKey
    return {
      available: hasKey,
      hasKey,
      provider: hasKey ? 'elevenlabs' : 'local',
      voiceId: this.voiceId,
      modelId: this.modelId,
      outputFormat: this.outputFormat,
      // never include key
      lastLatencyMs: this.lastLatencyMs,
    }
  }

  async speak(text, options = {}) {
    const trimmed = typeof text === 'string' ? text.trim() : ''
    if (!trimmed) {
      return { status: 'error', error: 'empty text' }
    }
    // Do not send traces/tool JSON — only final user-facing text.
    // Guard length (ElevenLabs limit 40000 for flash, but JARVIS finals <1k)
    if (trimmed.length > 5000) {
      return { status: 'error', error: 'text too long for TTS' }
    }

    const apiKey = resolveApiKey()
    if (!apiKey) {
      return { status: 'error', error: 'ELEVENLABS_API_KEY not set — using local TTS' }
    }

    const voiceId = options.voiceId || this.voiceId
    const modelId = options.modelId || this.modelId
    const outputFormat = options.outputFormat || this.outputFormat

    // Abort previous request if any
    if (this.currentAbort) {
      try {
        this.currentAbort.abort()
      } catch {}
      this.currentAbort = null
    }

    const controller = new AbortController()
    this.currentAbort = controller

    const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(
      voiceId
    )}?output_format=${encodeURIComponent(
      outputFormat
    )}&optimize_streaming_latency=0`

    const startedAt = Date.now()
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json',
          Accept: 'audio/mpeg',
        },
        body: JSON.stringify({
          text: trimmed,
          model_id: modelId,
        }),
        signal: controller.signal,
      })

      if (!res.ok) {
        const errText = await res.text().catch(() => '')
        let errMsg = `ElevenLabs error ${res.status}`
        try {
          const parsed = JSON.parse(errText)
          errMsg = parsed?.detail?.message || parsed?.message || errText.slice(0, 300) || errMsg
        } catch {
          if (errText) errMsg = errText.slice(0, 300)
        }
        // 401 invalid key, 429 quota, etc. — caller will fallback to local
        return { status: 'error', error: errMsg, httpStatus: res.status }
      }

      const arrayBuffer = await res.arrayBuffer()
      const buffer = Buffer.from(arrayBuffer)
      if (!buffer.length) {
        return { status: 'error', error: 'empty audio response' }
      }
      this.lastLatencyMs = Date.now() - startedAt
      // Return base64 — IPC-safe, renderer creates Audio from data URL or Blob
      return {
        status: 'ok',
        audioBase64: buffer.toString('base64'),
        mime: 'audio/mpeg',
        voiceId,
        modelId,
        latencyMs: this.lastLatencyMs,
        bytes: buffer.length,
      }
    } catch (err) {
      if (err && err.name === 'AbortError') {
        return { status: 'error', error: 'aborted', aborted: true }
      }
      return { status: 'error', error: String((err && err.message) || err) }
    } finally {
      if (this.currentAbort === controller) {
        this.currentAbort = null
      }
    }
  }

  stop() {
    if (this.currentAbort) {
      try {
        this.currentAbort.abort()
      } catch {}
      this.currentAbort = null
    }
    return { status: 'ok' }
  }
}

module.exports = { TtsManager, DEFAULT_VOICE_ID, DEFAULT_MODEL_ID, DEFAULT_OUTPUT_FORMAT }
