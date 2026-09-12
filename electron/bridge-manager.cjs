/*
  Python Harness 브리지 자식 프로세스 관리자 (Task 1).

  Electron main이 spawn하는 Python(`python -m scripts.harness_bridge`)과
  JSONL(stdin/stdout)로 통신한다. 순수 Node 모듈 — electron 없이도 단독
  테스트할 수 있다.

  프로토콜 (harness_bridge.py와 일치):
    send  {"type":"chat","text","project_id"} | {"type":"confirm","tool_call"}
          | {"type":"reject","tool_call"} | {"type":"ping"} | {"type":"shutdown"}
    recv  {"type":"response","id","status": final|awaiting_confirmation|rejected|error|ok, ...}
*/
const { spawn } = require('node:child_process')
const readline = require('node:readline')
const path = require('node:path')

class BridgeManager {
  constructor({
    python = process.env.PYTHON || 'python',
    harnessHome,
    bridgeModule = 'scripts.harness_bridge',
    env = {},
    requestTimeoutMs = 300000,
    onStderr = () => {},
  }) {
    this.python = python
    this.harnessHome = harnessHome
    this.bridgeModule = bridgeModule
    this.env = env
    this.requestTimeoutMs = requestTimeoutMs
    this.onStderr = onStderr
    this.proc = null
    this.rl = null
    this.nextId = 1
    this.pending = new Map() // id -> {resolve, reject, timer}
  }

  get isRunning() {
    return Boolean(this.proc && !this.proc.killed)
  }

  start() {
    if (this.isRunning) return
    this.proc = spawn(this.python, ['-m', this.bridgeModule], {
      cwd: this.harnessHome,
      env: { ...process.env, ...this.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })

    this.proc.on('error', (err) => {
      this._failAllPending(`브리지 프로세스 시작 실패: ${err.message}`)
    })

    this.proc.on('exit', (code, signal) => {
      this._failAllPending(
        `브리지 프로세스 종료 (code=${code}, signal=${signal})`,
      )
      this.proc = null
      this.rl = null
    })

    this.proc.stderr.on('data', (chunk) => {
      const text = chunk.toString().trim()
      if (text) this.onStderr(text)
    })

    this.rl = readline.createInterface({
      input: this.proc.stdout,
      crlfDelay: Infinity,
    })

    this.rl.on('line', (line) => {
      const trimmed = line.trim()
      if (!trimmed) return
      let msg
      try {
        msg = JSON.parse(trimmed)
      } catch {
        this.onStderr(`bridge 응답 파싱 실패: ${trimmed.slice(0, 200)}`)
        return
      }
      const entry = this.pending.get(msg.id)
      if (!entry) return
      clearTimeout(entry.timer)
      this.pending.delete(msg.id)
      entry.resolve(msg)
    })
  }

  _send(msg) {
    this.start()
    if (!this.proc || !this.rl) {
      return Promise.reject(new Error('브리지 프로세스를 시작할 수 없습니다'))
    }
    const id = this.nextId++
    const payload = { ...msg, id }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`브리지 응답 시간 초과 (${this.requestTimeoutMs}ms)`))
      }, this.requestTimeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.proc.stdin.write(`${JSON.stringify(payload)}\n`)
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new Error(`브리지 요청 전송 실패: ${err.message}`))
      }
    })
  }

  _failAllPending(message) {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer)
      reject(new Error(message))
    }
    this.pending.clear()
  }

  /* ---- 내부 유틸 ---- */

  /** _send + try/catch — 모든 실패를 {status:'error', error}로 정규화. */
  async _call(msg) {
    try {
      return await this._send(msg)
    } catch (err) {
      return { type: 'response', status: 'error', error: err.message }
    }
  }

  /* ---- 공개 API ---- */

  async chat(text, projectId) {
    return this._call({ type: 'chat', text, project_id: projectId })
  }

  async confirm(toolCall) {
    return this._call({ type: 'confirm', tool_call: toolCall })
  }

  async reject(toolCall) {
    return this._call({ type: 'reject', tool_call: toolCall })
  }

  async ping() {
    return this._call({ type: 'ping' })
  }

  async treeSnapshot() {
    return this._call({ type: 'tree_snapshot' })
  }

  async pagesSnapshot() {
    return this._call({ type: 'pages_snapshot' })
  }

  async createTask(projectId, title, reason) {
    return this._call({ type: 'create_task', project_id: projectId, title, reason })
  }

  async deleteTask(projectId, taskId) {
    return this._call({ type: 'delete_task', project_id: projectId, task_id: taskId })
  }

  async updateTask(projectId, taskId, done, title, reason) {
    const payload = { type: 'update_task', project_id: projectId, task_id: taskId }
    if (typeof done === 'boolean') payload.done = done
    if (typeof title === 'string') payload.title = title
    if (typeof reason === 'string') payload.reason = reason
    return this._call(payload)
  }

  async discoverProjects() {
    return this._call({ type: 'discover_projects' })
  }

  async searchContext(query, limit) {
    return this._call({ type: 'search_context', query, limit })
  }

  async filesSnapshot(root, relativePath, depth) {
    return this._call({ type: 'files_snapshot', root, path: relativePath, depth })
  }

  async linkProjectFile(projectId, fileId, relation) {
    return this._call({ type: 'link_project_file', project_id: projectId, file_id: fileId, relation })
  }

  async listProjectResources(projectId) {
    return this._call({ type: 'list_project_resources', project_id: projectId })
  }

  async unlinkProjectFile(linkId) {
    return this._call({ type: 'unlink_project_file', link_id: linkId })
  }

  /* PROJECT PRIMARY WORKSPACE V1 — Project → 논리 WorkspaceRoot 관계 */

  async setProjectWorkspace(projectId, rootId) {
    return this._call({ type: 'set_project_workspace', project_id: projectId, root_id: rootId })
  }

  async getProjectWorkspace(projectId) {
    return this._call({ type: 'get_project_workspace', project_id: projectId })
  }

  async clearProjectWorkspace(projectId) {
    return this._call({ type: 'clear_project_workspace', project_id: projectId })
  }

  /* WORKSPACE REGISTRATION + FOLDER PICKER V1 */

  async listWorkspaceRoots() {
    return this._call({ type: 'list_workspace_roots' })
  }

  async registerWorkspaceRoot(devicePath, displayName) {
    return this._call({ type: 'register_workspace_root', device_path: devicePath, display_name: displayName })
  }

  async updateWorkspaceRoot(rootId, displayName, devicePath) {
    return this._call({ type: 'update_workspace_root', root_id: rootId, display_name: displayName, device_path: devicePath })
  }

  async removeWorkspaceRoot(rootId) {
    return this._call({ type: 'remove_workspace_root', root_id: rootId })
  }

  async connectProjectWorkspace(projectId, devicePath, displayName) {
    return this._call({ type: 'connect_project_workspace', project_id: projectId, device_path: devicePath, display_name: displayName })
  }

  async shutdown() {
    if (!this.isRunning) return { status: 'ok' }
    try {
      const response = await this._send({ type: 'shutdown' })
      return response
    } catch {
      this.stop()
      return { status: 'ok' }
    }
  }

  stop() {
    if (this.proc && !this.proc.killed) {
      this.proc.kill()
    }
    this.proc = null
    this.rl = null
  }
}

module.exports = { BridgeManager }