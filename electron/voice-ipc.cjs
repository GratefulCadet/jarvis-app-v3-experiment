/*
  Renderer ↔ Voice worker IPC (STEP 2).

  채널:
    voice:ping            → {type:'pong', ...} | error
    voice:status          → {running, ready, model, mic_input_devices, ...}
    voice:record-start    → recording_started | {status:'error', error}
    voice:record-stop     → recording_result (transcribe 포함) | error
    voice:record-cancel   → recording_cancelled | error
    voice:transcribe-file → transcript | error   (개발/디버그용)

  응답은 항상 정규화된 형태다. renderer는 이 응답만으로 음성 상태를 그린다.
  브리지 실패/충돌이 Electron main이나 text 브리지 흐름을 깨지 않는다 —
  voice manager는 별도 프로세스이며 실패는 {status:'error'}로만 흐른다.
*/
const path = require('node:path')
const fs = require('node:fs')

const { VoiceManager } = require('./voice-manager.cjs')

function resolveVoiceConfig() {
  const configPath = path.join(__dirname, 'voice-worker', 'voice_config.json')
  if (!fs.existsSync(configPath)) return {}
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'))
  } catch {
    return {}
  }
}

function registerVoiceIpc({ ipcMain, app }) {
  const config = resolveVoiceConfig()
  const workerScript = path.join(__dirname, 'voice-worker', 'stt_worker.py')
  const python =
    process.env.JARVIS_VOICE_PYTHON ||
    config.managed_python ||
    process.env.PYTHON ||
    'python'

  const manager = new VoiceManager({
    python,
    workerScript,
    onStderr: (text) => {
      console.error('[voice]', text)
    },
    onEvent: (msg) => {
      if (msg && (msg.type === 'boot' || msg.type === 'voice_ready')) {
        console.error('[voice]', msg.type, msg.status || '')
      }
    },
  })

  ipcMain.handle('voice:ping', async () => {
    return manager.ping()
  })

  ipcMain.handle('voice:status', async () => {
    return manager.statusInfo()
  })

  ipcMain.handle('voice:record-start', async (_event, payload) => {
    const deviceIndex = payload?.deviceIndex
    return manager.recordStart(deviceIndex != null ? { device_index: deviceIndex } : {})
  })

  ipcMain.handle('voice:record-stop', async () => {
    return manager.recordStop()
  })

  ipcMain.handle('voice:record-cancel', async () => {
    return manager.recordCancel()
  })

  ipcMain.handle('voice:transcribe-file', async (_event, payload) => {
    const filePath = payload?.path
    if (typeof filePath !== 'string' || !filePath) {
      return { status: 'error', error: 'transcribe할 wav 경로가 없습니다' }
    }
    return manager.transcribeFile(filePath)
  })

  app.on('will-quit', () => {
    manager.stop()
  })

  return manager
}

module.exports = { registerVoiceIpc }
