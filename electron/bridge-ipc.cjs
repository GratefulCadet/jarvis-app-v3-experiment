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

function _err(msg) {
  return { type: 'response', status: 'error', error: msg }
}

function _str(val) {
  return typeof val === 'string' ? val.trim() : undefined
}

/** Apply multiple {key, alias} lookups from payload, return first non-empty trimmed string. */
function _field(payload, ...keys) {
  for (const k of keys) {
    const v = payload?.[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return undefined
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
    const activeFile = payload?.activeFile
    if (typeof text !== 'string' || !text.trim()) {
      return { type: 'response', status: 'error', error: '요청 문구가 비어 있습니다' }
    }
    return manager.chat(text, projectId || 'jarvis-app', activeFile)
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
    const title = payload?.title
    const reason = payload?.reason
    if (typeof projectId !== 'string' || !projectId.trim()) {
      return { type: 'response', status: 'error', error: 'project_id가 비어 있습니다' }
    }
    if (typeof taskId !== 'string' || !taskId.trim()) {
      return { type: 'response', status: 'error', error: 'task_id가 비어 있습니다' }
    }
    // done toggle or title/reason edit — at least one must be present
    if (typeof done !== 'boolean' && typeof title !== 'string' && typeof reason !== 'string') {
      return { type: 'response', status: 'error', error: 'done, title, reason 중 하나 이상 필요합니다' }
    }
    return manager.updateTask(projectId.trim(), taskId.trim(), done, title, reason)
  })

  ipcMain.handle('jarvis:delete-task', async (_event, payload) => {
    const projectId = payload?.projectId
    const taskId = payload?.taskId
    if (typeof projectId !== 'string' || !projectId.trim()) {
      return { type: 'response', status: 'error', error: 'project_id가 비어 있습니다' }
    }
    if (typeof taskId !== 'string' || !taskId.trim()) {
      return { type: 'response', status: 'error', error: 'task_id가 비어 있습니다' }
    }
    return manager.deleteTask(projectId.trim(), taskId.trim())
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

  ipcMain.handle('jarvis:file-read', async (_event, payload) => {
    const root = payload?.root
    const relativePath = payload?.path
    if (root !== undefined && root !== null && typeof root !== 'string') return _err('root는 문자열이어야 합니다')
    if (typeof relativePath !== 'string' || !relativePath.trim()) return _err('path가 필요합니다')
    return manager.readFile(root || undefined, relativePath.trim())
  })

  ipcMain.handle('jarvis:file-write', async (_event, payload) => {
    const rootId = _field(payload, 'rootId', 'root_id')
    const fileId = _field(payload, 'fileId', 'file_id')
    const relativePath = _field(payload, 'path', 'relativePath', 'relative_path')
    const content = payload?.content
    if (!rootId || !fileId || !relativePath) return _err('root_id, file_id, path가 필요합니다')
    if (typeof content !== 'string') return _err('content는 문자열이어야 합니다')
    if (payload?.revision !== undefined && (payload.revision === null || typeof payload.revision !== 'object')) return _err('revision은 객체여야 합니다')
    return manager.writeFile(rootId, fileId, relativePath, content, payload?.revision)
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

  ipcMain.handle('jarvis:link-task-file', async (_event, payload) => {
    const taskId = payload?.taskId
    const fileId = payload?.fileId
    const relation = payload?.relation
    if (typeof taskId !== 'string' || !taskId.trim()) {
      return { type: 'response', status: 'error', error: 'task_id가 비어 있습니다' }
    }
    if (typeof fileId !== 'string' || !fileId.trim()) {
      return { type: 'response', status: 'error', error: 'file_id(FileRef identity)가 비어 있습니다' }
    }
    return manager.linkTaskFile(
      taskId.trim(),
      fileId.trim(),
      typeof relation === 'string' && relation.trim() ? relation.trim() : 'reference',
    )
  })

  ipcMain.handle('jarvis:list-task-resources', async (_event, payload) => {
    const taskId = payload?.taskId
    if (typeof taskId !== 'string' || !taskId.trim()) {
      return { type: 'response', status: 'error', error: 'task_id가 비어 있습니다' }
    }
    return manager.listTaskResources(taskId.trim())
  })

  ipcMain.handle('jarvis:unlink-task-file', async (_event, payload) => {
    const linkId = payload?.linkId
    if (typeof linkId !== 'string' || !linkId.trim()) {
      return { type: 'response', status: 'error', error: 'link_id가 비어 있습니다' }
    }
    return manager.unlinkTaskFile(linkId.trim())
  })

  ipcMain.handle('jarvis:set-project-workspace', async (_event, payload) => {
    const projectId = _field(payload, 'projectId', 'project_id')
    const rootId = _field(payload, 'rootId', 'root_id')
    if (!projectId) return _err('project_id가 비어 있습니다')
    if (!rootId) return _err('root_id(논리 root identity)가 비어 있습니다')
    return manager.setProjectWorkspace(projectId, rootId)
  })

  ipcMain.handle('jarvis:get-project-workspace', async (_event, payload) => {
    const projectId = _field(payload, 'projectId', 'project_id')
    if (!projectId) return _err('project_id가 비어 있습니다')
    return manager.getProjectWorkspace(projectId)
  })

  ipcMain.handle('jarvis:clear-project-workspace', async (_event, payload) => {
    const projectId = _field(payload, 'projectId', 'project_id')
    if (!projectId) return _err('project_id가 비어 있습니다')
    return manager.clearProjectWorkspace(projectId)
  })

  // WORKSPACE REGISTRATION + FOLDER PICKER V1 — main holds dialog, renderer sends intent only
  ipcMain.handle('jarvis:list-workspace-roots', async () => {
    return manager.listWorkspaceRoots()
  })

  ipcMain.handle('jarvis:register-workspace-root', async (_event, payload) => {
    const devicePath = _field(payload, 'devicePath', 'device_path', 'path')
    if (!devicePath) return _err('device_path(폴더 경로)가 필요합니다')
    const displayName = _str(payload?.displayName || payload?.display_name)
    return manager.registerWorkspaceRoot(devicePath, displayName)
  })

  ipcMain.handle('jarvis:update-workspace-root', async (_event, payload) => {
    const rootId = _field(payload, 'rootId', 'root_id', 'id')
    if (!rootId) return _err('root_id가 필요합니다')
    const displayName = _str(payload?.displayName || payload?.display_name)
    const devicePath = _str(payload?.devicePath || payload?.device_path || payload?.path)
    return manager.updateWorkspaceRoot(rootId, displayName, devicePath)
  })

  ipcMain.handle('jarvis:remove-workspace-root', async (_event, payload) => {
    const rootId = _field(payload, 'rootId', 'root_id', 'id')
    if (!rootId) return _err('root_id가 필요합니다')
    return manager.removeWorkspaceRoot(rootId)
  })

  ipcMain.handle('jarvis:connect-project-workspace', async (_event, payload) => {
    const projectId = _field(payload, 'projectId', 'project_id')
    const devicePath = _field(payload, 'devicePath', 'device_path', 'path', 'folder')
    if (!projectId) return _err('project_id가 필요합니다')
    if (!devicePath) return _err('device_path가 필요합니다')
    const displayName = _str(payload?.displayName || payload?.display_name)
    return manager.connectProjectWorkspace(projectId, devicePath, displayName)
  })

  // OS folder picker — MAIN only (xi-api-key pattern: never expose fs to renderer)
  const { dialog } = require('electron')
  ipcMain.handle('jarvis:pick-folder', async (event) => {
    const win = require('electron').BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showOpenDialog(win || undefined, {
      properties: ['openDirectory'],
      title: 'Connect Workspace — 폴더 선택',
    })
    if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
      return { status: 'cancelled' }
    }
    return { status: 'ok', path: result.filePaths[0] }
  })

  app.on('will-quit', () => {
    manager.stop()
  })

  return manager
}

module.exports = { registerBridgeIpc }