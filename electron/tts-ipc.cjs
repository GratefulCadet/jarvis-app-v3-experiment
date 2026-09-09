/*
  Renderer ↔ ElevenLabs TTS IPC — Electron main only holds xi-api-key.

  Channels:
    tts:speak  → {text, voiceId?, modelId?} → {status:'ok', audioBase64, mime, ...} | {status:'error', error}
    tts:stop   → {} → {status:'ok'}
    tts:status → {} → {available, hasKey, provider, voiceId, modelId, ...}

  Security:
  - renderer sends only `text` (final Qwen answer). No traces/tool JSON.
  - key never leaves main, never logged, never returned via IPC.
  - failure → renderer falls back to local Web Speech (handled in useVoiceOutput).

  Streaming: buffered POST now; streaming variant can be added later without
  changing preload contract — keep boundary lean.
*/
const { TtsManager } = require('./tts-manager.cjs')

function registerTtsIpc({ ipcMain, app }) {
  const manager = new TtsManager({
    onLog: (msg) => {
      // never log api key — manager guarantees redaction
      console.error('[tts]', msg)
    },
  })

  ipcMain.handle('tts:speak', async (_event, payload) => {
    const text = payload?.text
    if (typeof text !== 'string' || !text.trim()) {
      return { status: 'error', error: 'text is empty' }
    }
    // Only final user-facing text — extra fields stripped here
    // Do not forward raw payload traces; pick only allowed keys
    const voiceId = typeof payload?.voiceId === 'string' ? payload.voiceId : undefined
    const modelId = typeof payload?.modelId === 'string' ? payload.modelId : undefined
    return manager.speak(text, { voiceId, modelId })
  })

  ipcMain.handle('tts:stop', async () => {
    return manager.stop()
  })

  ipcMain.handle('tts:status', async () => {
    return manager.statusInfo()
  })

  app.on('will-quit', () => {
    manager.stop()
  })

  return manager
}

module.exports = { registerTtsIpc }
