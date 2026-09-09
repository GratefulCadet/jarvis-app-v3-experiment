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

  ipcMain.handle('jarvis:update-task', async (_event, payload) => {
    const projectId = payload?.projectId
    const taskId = payload?.taskId
    const done = payload?.done
    if (typeof projectId !== 'string' || !projectId.trim()) {
      return { type: 'response', status: 'error', error: 'project_id가 비어 있습니다' }
    }
    if (typeof taskId !== 'string' || !taskId.trim()) {
      return { type: 'response', status: 'error', error: 'task_id가 비어 있습니다' }
    }
    if (typeof done !== 'boolean') {
      return { type: 'response', status: 'error', error: 'done은 boolean이어야 합니다' }
    }
    return manager.updateTask(projectId.trim(), taskId.trim(), done)
  })

  /*
    Context Discovery + FILES (read-only) — renderer는 discovery 결과만 본다.
    파일시스템 접근은 Harness FileStore 경계(승인 루트·민감 차단) 뒤에 있다.
  */
  ipcMain.handle('jarvis:discover-projects', async () => {
    return manager.discoverProjects()
  })

  ipcMain.handle('jarvis:search-context', async (_event, payload) => {
    const query = payload?.query
    if (typeof query !== 'string' || !query.trim()) {
      return { type: 'response', status: 'error', error: '검색어가 비어 있습니다' }
    }
    const limit = payload?.limit
    return manager.searchContext(
      query.trim(),
      typeof limit === 'number' && limit > 0 ? Math.floor(limit) : undefined,
    )
  })

  ipcMain.handle('jarvis:files-snapshot', async (_event, payload) => {
    const root = payload?.root
    const relativePath = payload?.path
    const depth = payload?.depth
    if (root !== undefined && root !== null && typeof root !== 'string') {
      return { type: 'response', status: 'error', error: 'root는 문자열이어야 합니다' }
    }
    if (relativePath !== undefined && relativePath !== null && typeof relativePath !== 'string') {
      return { type: 'response', status: 'error', error: 'path는 문자열이어야 합니다' }
    }
    if (depth !== undefined && depth !== null && typeof depth !== 'number') {
      return { type: 'response', status: 'error', error: 'depth는 숫자여야 합니다' }
    }
    return manager.filesSnapshot(root || undefined, relativePath || undefined, depth)
  })

  ipcMain.handle('jarvis:link-project-file', async (_event, payload) => {
    const projectId = payload?.projectId
    const fileId = payload?.fileId
    const relation = payload?.relation
    if (typeof projectId !== 'string' || !projectId.trim()) {
      return { type: 'response', status: 'error', error: 'project_id가 비어 있습니다' }
    }
    if (typeof fileId !== 'string' || !fileId.trim()) {
      return { type: 'response', status: 'error', error: 'file_id(FileRef identity)가 비어 있습니다' }
    }
    return manager.linkProjectFile(
      projectId.trim(),
      fileId.trim(),
      typeof relation === 'string' && relation.trim() ? relation.trim() : 'reference',
    )
  })

  ipcMain.handle('jarvis:list-project-resources', async (_event, payload) => {
    const projectId = payload?.projectId
    if (typeof projectId !== 'string' || !projectId.trim()) {
      return { type: 'response', status: 'error', error: 'project_id가 비어 있습니다' }
    }
    return manager.listProjectResources(projectId.trim())
  })

  ipcMain.handle('jarvis:unlink-project-file', async (_event, payload) => {
    const linkId = payload?.linkId
    if (typeof linkId !== 'string' || !linkId.trim()) {
      return { type: 'response', status: 'error', error: 'link_id가 비어 있습니다' }
    }
    return manager.unlinkProjectFile(linkId.trim())
  })

  ipcMain.handle('jarvis:set-project-workspace', async (_event, payload) => {
    const projectId = payload?.projectId
    const rootId = payload?.rootId
    if (typeof projectId !== 'string' || !projectId.trim()) {
      return { type: 'response', status: 'error', error: 'project_id가 비어 있습니다' }
    }
    if (typeof rootId !== 'string' || !rootId.trim()) {
      return { type: 'response', status: 'error', error: 'root_id(논리 root identity)가 비어 있습니다' }
    }
    return manager.setProjectWorkspace(projectId.trim(), rootId.trim())
  })

  ipcMain.handle('jarvis:get-project-workspace', async (_event, payload) => {
    const projectId = payload?.projectId
    if (typeof projectId !== 'string' || !projectId.trim()) {
      return { type: 'response', status: 'error', error: 'project_id가 비어 있습니다' }
    }
    return manager.getProjectWorkspace(projectId.trim())
  })

  ipcMain.handle('jarvis:clear-project-workspace', async (_event, payload) => {
    const projectId = payload?.projectId
    if (typeof projectId !== 'string' || !projectId.trim()) {
      return { type: 'response', status: 'error', error: 'project_id가 비어 있습니다' }
    }
    return manager.clearProjectWorkspace(projectId.trim())
  })

  app.on('will-quit', () => {
    manager.stop()
  })

  return manager
}

module.exports = { registerBridgeIpc }