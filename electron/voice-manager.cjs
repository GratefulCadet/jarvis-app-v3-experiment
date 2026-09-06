/*
  STT voice worker 자식 프로세스 관리자 (STEP 2).

  Electron main이 spawn하는 Python(`python electron/voice-worker/stt_worker.py`)과
  JSONL(stdin/stdout)로 통신한다. 순수 Node 모듈 — electron 없이도 단독 테스트
  가능하다 (tests/test_stt_worker_transport.cjs 와 같은 경로를 재사용).

  프로토콜 (stt_worker.py와 일치):
    send  {"type":"record_start"} | {"type":"record_stop"} | {"type":"record_cancel"}
          | {"type":"transcribe_file","path"} | {"type":"ping"} | {"type":"shutdown"}
    recv  {"type":"voice_ready"|"recording_started"|"recording_result"|"transcript"|"pong"|..., "id"}

  특징:
  - 첫 요청 시 지연 시작 (lazy) — 앱을 켜자마자 Whisper 메모리를 점유하지 않는다.
  - voice_ready 핸드셰이크 후에만 실제 요청을 보낸다 (모델 로드 1회).
  - 요청/응답은 id로 상관(correlation). 타임아웃/충돌 시 {status:'error'}로 정규화.
  - 프로세스가 죽으면 pending을 reject하고 이후 요청에서 재시작한다.
*/
const { spawn } = require('node:child_process')
const readline = require('node:readline')
const path = require('node:path')
const fs = require('node:fs')

class VoiceManager {
  constructor({
    python,
    workerScript,
    requestTimeoutMs = 180000,
    readyTimeoutMs = 120000,
    onStderr = () => {},
    onEvent = () => {},
  }) {
    this.python = python
    this.workerScript = workerScript
    this.requestTimeoutMs = requestTimeoutMs
    this.readyTimeoutMs = readyTimeoutMs
    this.onStderr = onStderr
    this.onEvent = onEvent
    this.proc = null
    this.rl = null
    this.nextId = 1
    this.pending = new Map() // id -> {resolve, reject, timer}
    this.readyPromise = null
    this.readyResolve = null
    this.readyReject = null
    this.readyInfo = null
  }

  get isRunning() {
    return Boolean(this.proc && !this.proc.killed)
  }

  get isReady() {
    return Boolean(this.readyInfo && this.isRunning)
  }

  start() {
    if (this.isRunning) return
    this.readyInfo = null
    this.readyPromise = new Promise((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject = reject
    })

    this.proc = spawn(this.python, [this.workerScript], {
      cwd: path.dirname(this.workerScript),
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })

    this.proc.on('error', (err) => {
      this._failAllPending(`음성 프로세스 시작 실패: ${err.message}`)
      this._rejectReady(new Error(`음성 프로세스 시작 실패: ${err.message}`))
    })

    this.proc.on('exit', (code, signal) => {
      const message = `음성 프로세스 종료 (code=${code}, signal=${signal})`
      this._failAllPending(message)
      this._rejectReady(new Error(message))
      this.proc = null
      this.rl = null
      this.readyInfo = null
      this.onEvent({ type: 'voice_exit', code, signal })
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
        this.onStderr(`음성 응답 파싱 실패: ${trimmed.slice(0, 200)}`)
        return
      }
      this._dispatch(msg)
    })
  }

  _dispatch(msg) {
    if (msg.type === 'boot') {
      this.onEvent(msg)
      return
    }
    if (msg.type === 'voice_ready') {
      if (msg.status === 'ready' && this.readyResolve) {
        this.readyInfo = msg
        this.readyResolve(msg)
        this.readyResolve = null
      } else if (msg.status === 'exiting') {
        // 정상 종료
      }
      this.onEvent(msg)
      return
    }
    if (msg.type === 'error') {
      this.onEvent(msg)
      // error는 항상 id로 회신되므로 pending에서 처리된다
    }
    const entry = this.pending.get(msg.id)
    if (!entry) {
      if (msg.type !== 'voice_ready') this.onEvent(msg)
      return
    }
    clearTimeout(entry.timer)
    this.pending.delete(msg.id)
    entry.resolve(msg)
  }

  _send(msg) {
    this.start()
    if (!this.proc || !this.rl) {
      return Promise.reject(new Error('음성 프로세스를 시작할 수 없습니다'))
    }
    const id = this.nextId++
    const payload = { ...msg, id }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`음성 응답 시간 초과 (${this.requestTimeoutMs}ms)`))
      }, this.requestTimeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.proc.stdin.write(`${JSON.stringify(payload)}\n`)
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new Error(`음성 요청 전송 실패: ${err.message}`))
      }
    })
  }

  async ensureReady() {
    this.start()
    if (this.isReady) return this.readyInfo
    if (!this.readyPromise) {
      this.start()
    }
    const timer = new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`voice_ready 대기 시간 초과 (${this.readyTimeoutMs}ms)`)), this.readyTimeoutMs)
    })
    return Promise.race([this.readyPromise, timer])
  }

  _failAllPending(message) {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer)
      reject(new Error(message))
    }
    this.pending.clear()
  }

  _rejectReady(err) {
    if (this.readyReject) {
      this.readyReject(err)
      this.readyResolve = null
      this.readyReject = null
    }
  }

  /* ---- 공개 API (모든 실패는 {status:'error', error}로 정규화) ---- */

  async recordStart(options = {}) {
    try {
      await this.ensureReady()
      const msg = await this._send({ type: 'record_start', ...options })
      return { status: msg.ok ? 'ok' : 'error', ...msg }
    } catch (err) {
      return { status: 'error', error: err.message }
    }
  }

  async recordStop(options = {}) {
    try {
      await this.ensureReady()
      const msg = await this._send({ type: 'record_stop', transcribe: true, ...options })
      return { status: msg.ok ? 'ok' : 'error', ...msg }
    } catch (err) {
      return { status: 'error', error: err.message }
    }
  }

  async recordCancel() {
    try {
      await this.ensureReady()
      const msg = await this._send({ type: 'record_cancel' })
      return { status: msg.ok ? 'ok' : 'error', ...msg }
    } catch (err) {
      return { status: 'error', error: err.message }
    }
  }

  async transcribeFile(filePath, options = {}) {
    try {
      await this.ensureReady()
      const msg = await this._send({ type: 'transcribe_file', path: filePath, ...options })
      return { status: msg.ok ? 'ok' : 'error', ...msg }
    } catch (err) {
      return { status: 'error', error: err.message }
    }
  }

  async ping() {
    try {
      await this.ensureReady()
      return await this._send({ type: 'ping' })
    } catch (err) {
      return { type: 'pong', status: 'error', error: err.message }
    }
  }

  statusInfo() {
    return {
      running: this.isRunning,
      ready: this.isReady,
      python: this.python,
      workerScript: this.workerScript,
      model: this.readyInfo ? this.readyInfo.model : null,
      device: this.readyInfo ? this.readyInfo.device : null,
      model_load_seconds: this.readyInfo ? this.readyInfo.model_load_seconds : null,
      mic_input_devices: this.readyInfo ? (this.readyInfo.mic_input_devices || []) : [],
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
    this.readyInfo = null
  }
}

module.exports = { VoiceManager }
