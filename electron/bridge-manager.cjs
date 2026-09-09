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

  /* ---- 공개 API (모든 실패는 {status:'error', error}로 정규화) ---- */

  async chat(text, projectId) {
    try {
      return await this._send({
        type: 'chat',
        text,
        project_id: projectId,
      })
    } catch (err) {
      return { type: 'response', status: 'error', error: err.message }
    }
  }

  async confirm(toolCall) {
    try {
      return await this._send({
        type: 'confirm',
        tool_call: toolCall,
      })
    } catch (err) {
      return { type: 'response', status: 'error', error: err.message }
    }
  }

  async reject(toolCall) {
    try {
      return await this._send({
        type: 'reject',
        tool_call: toolCall,
      })
    } catch (err) {
      return { type: 'response', status: 'error', error: err.message }
    }
  }

  async ping() {
    try {
      return await this._send({ type: 'ping' })
    } catch (err) {
      return { type: 'response', status: 'error', error: err.message }
    }
  }

  /*
    read-only — 실제 JARVIS memory(projects.md + tasks.md) 기반 구조화 트리.
    모델 호출 없이 Harness가 단일 원천에서 스냅샷을 만든다.
  */
  async treeSnapshot() {
    try {
      return await this._send({ type: 'tree_snapshot' })
    } catch (err) {
      return { type: 'response', status: 'error', error: err.message }
    }
  }

  /*
    read-only — Knowledge Markdown pages의 재귀 트리. PageStore가 단일 원천
    (<memory_dir>/pages)에서 스냅샷을 만든다. 모델 호출 없음.
  */
  async pagesSnapshot() {
    try {
      return await this._send({ type: 'pages_snapshot' })
    } catch (err) {
      return { type: 'response', status: 'error', error: err.message }
    }
  }

  /*
    deterministic canonical write — SYSTEM MAP Add Task.
    Direct user action (Tree UI) → TaskStore via harness_bridge create_task.
    No LLM, no Permission Gate round-trip — TaskStore is the single writer.
  */
  async createTask(projectId, title, reason) {
    try {
      return await this._send({
        type: 'create_task',
        project_id: projectId,
        title,
        reason,
      })
    } catch (err) {
      return { type: 'response', status: 'error', error: err.message }
    }
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