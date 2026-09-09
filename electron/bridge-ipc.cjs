/*
  Renderer ↔ Bridge IPC (Task 1·2·6).

  채널:
    jarvis:ping          → {status}
    jarvis:chat          → {text, projectId}
    jarvis:confirm       → {toolCall}   (제안된 call 그대로 — 인자 변경 불가)
    jarvis:reject        → {toolCall}   (0변이)
    jarvis:bridge-status → {running, harnessHome, scratch}

  모든 응답은 Python bridge의 {type:'response', id, status, ...} 형태를 그대로
  돌려주고, 실패는 {status:'error', error}로 정규화한다 — renderer가
  RUNTIME_STATUS.ERROR로 매핑한다 (Task 6).
*/
const os = require('node:os')
const path = require('node:path')

const { BridgeManager } = require('./bridge-manager.cjs')

function resolveHarnessHome() {
  const configured = process.env.JARVIS_HARNESS_HOME
  if (configured) return configured
  return path.join(os.homedir(), 'Desktop', 'FB_Soap_LocalLLM')
}

function registerBridgeIpc({ ipcMain, app }) {
  const harnessHome = resolveHarnessHome()
  const manager = new BridgeManager({
    harnessHome,
    env: {
      // 기본은 격리 scratch — 실 memory는 JARVIS_BRIDGE_MEMORY_DIR로 명시적 opt-in
      JARVIS_BRIDGE_MEMORY_DIR:
        process.env.JARVIS_BRIDGE_MEMORY_DIR || '',
    },
    onStderr: (text) => {
      console.error('[bridge]', text)
    },
  })

  ipcMain.handle('jarvis:ping', async () => {
    return manager.ping()
  })

  ipcMain.handle('jarvis:chat', async (_event, payload) => {
    const text = payload?.text
    const projectId = payload?.projectId
    if (typeof text !== 'string' || !text.trim()) {
      return { type: 'response', status: 'error', error: '요청 문구가 비어 있습니다' }
    }
    return manager.chat(text, projectId || 'jarvis-app')
  })

  ipcMain.handle('jarvis:confirm', async (_event, payload) => {
    const toolCall = payload?.toolCall
    if (!toolCall || !toolCall.name) {
      return { type: 'response', status: 'error', error: 'confirm할 tool_call이 없습니다' }
    }
    return manager.confirm(toolCall)
  })

  ipcMain.handle('jarvis:reject', async (_event, payload) => {
    const toolCall = payload?.toolCall
    if (!toolCall || !toolCall.name) {
      return { type: 'response', status: 'error', error: 'reject할 tool_call이 없습니다' }
    }
    return manager.reject(toolCall)
  })

  ipcMain.handle('jarvis:bridge-status', async () => {
    return {
      running: manager.isRunning,
      harnessHome,
      scratch: !process.env.JARVIS_BRIDGE_MEMORY_DIR,
    }
  })

  ipcMain.handle('jarvis:tree-snapshot', async () => {
    return manager.treeSnapshot()
  })

  ipcMain.handle('jarvis:pages-snapshot', async () => {
    return manager.pagesSnapshot()
  })

  ipcMain.handle('jarvis:create-task', async (_event, payload) => {
    const projectId = payload?.projectId
    const title = payload?.title
    const reason = payload?.reason
    if (typeof projectId !== 'string' || !projectId.trim()) {
      return { type: 'response', status: 'error', error: 'project_id가 비어 있습니다' }
    }
    if (typeof title !== 'string' || !title.trim()) {
      return { type: 'response', status: 'error', error: 'title이 비어 있습니다' }
    }
    return manager.createTask(
      projectId.trim(),
      title.trim(),
      typeof reason === 'string' ? reason.trim() : reason,
    )
  })

  app.on('will-quit', () => {
    manager.stop()
  })

  return manager
}

module.exports = { registerBridgeIpc }