/*
  Resume(한도 중단 이어가기) 검증 — 실제 Electron에서 클릭으로 증명한다.

  모델만 deterministic stub이고, 그 외는 전부 진짜다:
    Electron 앱 · renderer React 상태 · contextBridge preload · IPC ·
    브리지 매니저 · Python harness_bridge · 툴 실행 · canonical trace(JSON).

    A) 정상 이어가기: tool_loop_limit → ERROR 패널 → '이어가기' 버튼 실제 클릭
       → 기존 transcript가 모델에 그대로 전달 → 이미 실행된 도구는 재실행 없음
       → final 도달 → 버튼 사라짐
    B) 이어가기 상한: 3회까지 허용, 그 다음 resumable=false + 상한 안내,
       4번째 bridge 요청 거부
    C) 낡은 이어가기 차단: 중단 상태에서 새 요청 → 이전 지점 폐기 + 예산 초기화
    D) 중복 변이 없음: resume 전 성공한 도구(edit_file)가 resume 후 재생성되지 않음

  실행: node tests/verify_loop_resume_gui.cjs
  실패 시 exit 1. 스크린샷은 tests/artifacts/loop-resume-gui/ 에 남는다.

  왜 openai_compat 어댑터를 쓰나: 이 검증의 핵심 단언이 "같은 tool_call이 두 번
  실행되지 않는다"인데, ollama native 어댑터는 wire에 tool_call id를 싣지
  않는다(id=None). provider가 실제로 주는 id까지 실경로로 확인해야 그 단언이
  의미를 갖는다.
*/
const { spawn, spawnSync } = require('node:child_process')
const http = require('node:http')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const net = require('node:net')

const APP_ROOT = path.join(__dirname, '..')
const HARNESS_HOME =
  process.env.JARVIS_HARNESS_HOME ||
  path.join(os.homedir(), 'Desktop', 'FB_Soap_LocalLLM')
const ARTIFACT_DIR = path.join(__dirname, 'artifacts', 'loop-resume-gui')
// harness_bridge는 trace를 항상 <HARNESS_HOME>/data/traces 에 쓴다
// (JARVIS_STATE_DIR와 무관 — config.py가 PROJECT_ROOT 기준으로 고정한다).
const TRACE_DIR = path.join(HARNESS_HOME, 'data', 'traces')
const FILE_NAME = 'experiment-notes.md'

// 한도가 3턴으로 낮아야 '막힌 tool call'과 '실행된 tool call'을 갈라 볼 수 있다.
const MAX_TURNS = 3

const MARK_A = 'RESUME-A 요약 좀 이어서 해줘'
const MARK_B = 'RESUME-B 무한 루프 재현'
const MARK_CA = 'RESUME-CA 먼저 끊어둘 작업'
const MARK_CB = 'RESUME-CB 새로 시작한 작업'
const MARK_C1 = 'RESUME-C1 예산 초기화 확인'
const MARK_D = 'RESUME-D 제안 만들고 멈춰줘'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let passed = 0
function fail(message) {
  console.error(`  [FAIL] ${message}`)
  process.exitCode = 1
  throw new Error(message)
}
function step(message) {
  console.log(`\n=== ${message} ===`)
}
function ok(message) {
  passed += 1
  console.log(`  PASS — ${message}`)
}
function assertTrue(cond, message) {
  if (!cond) fail(message)
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.ok) return await res.text()
    } catch { /* 아직 안 뜸 */ }
    await sleep(250)
  }
  return null
}

/* ------------------------------------------------------------------ *
 * 스텁 모델 (openai_compat wire)
 *
 * mode는 테스트가 직접 바꾼다. 각 모드는 "이번 모델 호출에서 무엇을 할지"를
 * transcript 내용으로만 결정한다 — 호출 횟수 카운터 같은 테스트 쪽 상태를
 * 쓰면 "stub이 맞춰준" 증명이 되므로, 실제 메시지 배열만 본다.
 * ------------------------------------------------------------------ */
function startStubModel() {
  const state = { mode: 'loop_then_finish', tag: 'X' }
  const received = { calls: [], issued: [], nextId: 1 }
  let nextToolTag = 0

  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      let payload = {}
      try { payload = JSON.parse(body || '{}') } catch { payload = {} }
      const messages = Array.isArray(payload.messages) ? payload.messages : []
      const toolMsgs = messages.filter((m) => m && m.role === 'tool')
      const assistantToolIds = []
      for (const m of messages) {
        if (m && m.role === 'assistant' && Array.isArray(m.tool_calls)) {
          for (const c of m.tool_calls) assistantToolIds.push(c.id || null)
        }
      }
      // "이미 결과를 받은 도구" — assistant tool_call과 tool 응답을 id로 짝지어
      // 구한다. 호출 횟수 카운터를 쓰지 않고 transcript만으로 판단해야
      // "stub이 테스트에 맞춰준" 증명이 되지 않는다.
      const answeredIds = new Set(toolMsgs.map((m) => m.tool_call_id).filter(Boolean))
      const toolsWithResult = []
      for (const m of messages) {
        if (m && m.role === 'assistant' && Array.isArray(m.tool_calls)) {
          for (const c of m.tool_calls) {
            if (answeredIds.has(c.id)) toolsWithResult.push(c.function && c.function.name)
          }
        }
      }
      const hasResult = (name) => toolsWithResult.includes(name)
      // resume은 system 줄로만 구분된다 — 사용자는 아무것도 다시 쓰지 않으므로.
      const resumed = messages.some(
        (m) => m && m.role === 'system' && String(m.content || '').includes('stopped at the tool-call limit'),
      )
      const assistantTurns = assistantToolIds.length

      const record = {
        seq: received.calls.length,
        mode: state.mode,
        resumed,
        messageCount: messages.length,
        roles: messages.map((m) => (m && m.role) || '?'),
        assistantToolIds,
        toolResultCount: toolMsgs.length,
        toolsWithResult,
        text: messages.map((m) => String((m && m.content) || '')).join('\n'),
      }
      received.calls.push(record)

      const readData = toolMsgs
        .map((m) => { try { return JSON.parse(m.content || '{}') } catch { return null } })
        .filter((d) => d && d.ok && d.data && d.data.truncated !== undefined && (d.data.file_id || d.data.id))
        .pop()

      const mkTool = (name, args) => {
        const tag = `${state.tag}${nextToolTag++}`
        const id = `call_${tag}`
        received.issued.push({ id, name, mode: state.mode, resumed, assistantTurns })
        return { id, type: 'function', function: { name, arguments: args } }
      }
      const answer = (content) => ({ role: 'assistant', content })
      const call = (name, args) => {
        const c = mkTool(name, args)
        return { role: 'assistant', content: '', tool_calls: [c] }
      }

      let message
      switch (state.mode) {
        case 'plain':
          message = answer('새 요청을 정상적으로 끝냈습니다.')
          break
        case 'loop':
          // 한도를 넘기기만 한다 — 상한 시나리오용.
          message = call('get_project_context', {})
          break
        case 'loop_then_finish':
          // 이어가기가 실제로 해야 할 일: 앞선 결과를 보고 이어간다.
          if (!resumed) {
            message = assistantTurns === 0
              ? call('read_file', { path: FILE_NAME })
              : call('get_project_context', {})
          } else {
            // 계획에 남은 한 단계(현재 task 목록 확인)만 하고 마무리한다.
            message = !hasResult('list_current_tasks')
              ? call('list_current_tasks', {})
              : answer('이어서 작업을 마무리했습니다.')
          }
          break
        case 'proposal_loop': {
          // 이미 실행된 도구(read_file/edit_file)를 절대 다시 부르지 않는다.
          // model이 정상적으로 지점을 이어받는다면 이것이 유일한 합리적 행동이고,
          // harness가 지점을 제대로 넘겼는지도 이 선택으로 드러난다.
          if (!resumed) {
            if (assistantTurns === 0) {
              message = call('read_file', { path: FILE_NAME })
            } else if (assistantTurns === 1 && readData) {
              message = call('edit_file', {
                file_id: readData.data.file_id || readData.data.id,
                root: readData.data.root_id,
                path: FILE_NAME,
                content: '# Experiment notes\r\n\r\n이어가기 검증 본문.\r\n',
                summary: 'RESUME-D 검증 제안',
                instruction: MARK_D,
              })
            } else {
              message = call('edit_file', {
                file_id: readData ? readData.data.file_id || readData.data.id : 'unknown',
                path: FILE_NAME,
                content: '# Experiment notes\r\n\r\n이어가기 검증 본문.\r\n',
                summary: 'RESUME-D 검증 제안',
                instruction: MARK_D,
              })
            }
          } else {
            message = !hasResult('get_project_context')
              ? call('get_project_context', {})
              : answer('제안을 만들었습니다. 확인해 주세요.')
          }
          break
        }
        default:
          message = answer('무엇을 도와드릴까요?')
      }

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        id: 'cmpl-stub',
        object: 'chat.completion',
        created: 0,
        model: payload.model,
        choices: [{
          index: 0,
          message,
          finish_reason: message.tool_calls ? 'tool_calls' : 'stop',
        }],
      }))
    })
  })

  return new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      port: server.address().port,
      received,
      setMode: (mode, tag) => { state.mode = mode; state.tag = tag },
    }))
  })
}

function seedState(stateDir, workspaceDir) {
  const result = spawnSync(
    process.env.PYTHON || 'python',
    ['-m', 'scripts.gui_e2e_fixture', '--state-dir', stateDir, '--workspace-dir', workspaceDir, '--project-id', 'jarvis-app'],
    { cwd: HARNESS_HOME, encoding: 'utf-8' },
  )
  if (result.status !== 0) fail(`fixture 실패: ${result.stderr || result.stdout}`)
  return JSON.parse((result.stdout || '').trim().split('\n').pop())
}

function snapshotTraces() {
  if (!fs.existsSync(TRACE_DIR)) return new Set()
  return new Set(fs.readdirSync(TRACE_DIR).filter((f) => f.endsWith('.json')))
}

function newTraces(before) {
  if (!fs.existsSync(TRACE_DIR)) return []
  return fs
    .readdirSync(TRACE_DIR)
    .filter((f) => f.endsWith('.json') && !before.has(f))
    .map((f) => JSON.parse(fs.readFileSync(path.join(TRACE_DIR, f), 'utf8')))
}

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.nextId = 1
    this.pending = new Map()
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data)
      const entry = this.pending.get(msg.id)
      if (!entry) return
      this.pending.delete(msg.id)
      msg.error ? entry.reject(new Error(JSON.stringify(msg.error))) : entry.resolve(msg.result)
    }
  }
  static async attach(port, timeoutMs = 60000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json`)
        const targets = await res.json()
        const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
        if (page) {
          const ws = new WebSocket(page.webSocketDebuggerUrl)
          await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
          const client = new Cdp(ws)
          await client.send('Runtime.enable')
          await client.send('Page.enable')
          return client
        }
      } catch { /* retry */ }
      await sleep(300)
    }
    throw new Error('CDP attach 실패')
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  async evalJs(expression) {
    const res = await this.send('Runtime.evaluate', { expression: `(() => { ${expression} })()`, returnByValue: true, awaitPromise: true })
    if (res.exceptionDetails) throw new Error(`evaluate 실패: ${JSON.stringify(res.exceptionDetails).slice(0, 300)}`)
    return res.result && res.result.value
  }
  async waitFor(expression, description, timeoutMs = 60000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (await this.evalJs(`return Boolean(${expression})`)) return true
      await sleep(300)
    }
    throw new Error(`대기 실패: ${description}`)
  }
  async waitForGone(expression, description, timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (!(await this.evalJs(`return Boolean(${expression})`))) return true
      await sleep(300)
    }
    throw new Error(`대기 실패(사라지지 않음): ${description}`)
  }
  async realClick(findExpression, description) {
    const point = await this.evalJs(`
      const el = ${findExpression};
      if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      const candidates = [[0.5, 0.5], [0.5, 0.35], [0.5, 0.7], [0.3, 0.5], [0.7, 0.5]];
      for (const [fx, fy] of candidates) {
        const x = r.left + r.width * fx;
        const y = r.top + r.height * fy;
        if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) continue;
        const hit = document.elementFromPoint(x, y);
        if (hit && (hit === el || el.contains(hit))) return { x, y, w: r.width, h: r.height };
      }
      return { blocked: true, x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
    `)
    if (!point) fail(`클릭 대상 없음: ${description}`)
    if (point.blocked) fail(`클릭 대상이 다른 요소에 가려짐: ${description}`)
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1, buttons: 1 })
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1, buttons: 0 })
    return point
  }
  async typeInto(findExpression, text) {
    const point = await this.evalJs(`
      const el = ${findExpression};
      if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      for (let f = 0.1; f < 0.95; f += 0.05) {
        const x = r.left + r.width * f;
        const y = r.top + r.height / 2;
        const hit = document.elementFromPoint(x, y);
        if (hit && (hit === el || el.contains(hit))) return { x, y };
      }
      return { x: r.left + r.width * 0.1, y: r.top + r.height / 2 };
    `)
    if (!point) fail('입력 필드 없음')
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1, buttons: 1 })
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1, buttons: 0 })
    await this.send('Input.insertText', { text })
    await sleep(250)
  }
  async shot(name) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' })
    fs.mkdirSync(ARTIFACT_DIR, { recursive: true })
    const file = path.join(ARTIFACT_DIR, `${name}.png`)
    fs.writeFileSync(file, Buffer.from(data, 'base64'))
    console.log(`  screenshot: ${path.basename(file)}`)
    return file
  }
}

const ERR_PANEL = "document.querySelector('.jarvis-runtime-panel.is-error')"
const DONE_PANEL = "document.querySelector('.jarvis-runtime-panel.is-done')"
const RESUME_BTN = "document.querySelector('.jarvis-mini-resume')"
const RESUME_HINT = "document.querySelector('.jarvis-runtime-resume-hint')"
const RUNTIME_TEXT = "document.querySelector('.jarvis-runtime-text')"

async function main() {
  const children = []
  let stub = null
  let cdp = null
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis_resume_'))
  const stateDir = path.join(scratch, 'state')
  const workspaceDir = path.join(scratch, 'ws')
  const targetPath = path.join(workspaceDir, FILE_NAME)
  const proposalsPath = path.join(stateDir, 'edit_proposals.json')

  const readProposals = () => {
    if (!fs.existsSync(proposalsPath)) return {}
    try { return JSON.parse(fs.readFileSync(proposalsPath, 'utf8')) } catch { return {} }
  }
  // 저장 형식: {"version": n, "proposals": {proposal_id: record}}
  const proposalRecords = () => Object.values(readProposals().proposals || {})
    .filter((r) => r && typeof r === 'object')

  try {
    step('환경 준비')
    stub = await startStubModel()
    seedState(stateDir, workspaceDir)
    const original = fs.readFileSync(targetPath, 'utf8')
    console.log(`  workspace: ${workspaceDir}`)

    const vitePort = await freePort()
    const cdpPort = await freePort()
    const run = (cmd, args, env, label) => {
      const child = spawn(cmd, args, { cwd: APP_ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      child.stdout.on('data', (c) => { const t = String(c).trim(); if (t && process.env.JARVIS_E2E_VERBOSE) console.log(`[${label}] ${t}`) })
      child.stderr.on('data', (c) => { const t = String(c).trim(); if (t) console.log(`[${label}!] ${t.slice(0, 200)}`) })
      children.push(child)
      return child
    }
    run(process.execPath, [path.join(APP_ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'], {}, 'vite')
    const viteUrl = `http://127.0.0.1:${vitePort}/`
    const html = await waitForHttp(viteUrl, 30000)
    if (!html) fail('vite 미기동')
    const entryMatch = html.match(/src="([^"]+\.[jt]sx?)"/)
    if (entryMatch) await waitForHttp(new URL(entryMatch[1], viteUrl).toString(), 30000)

    const electronPath = require('electron')
    run(electronPath, ['.', `--remote-debugging-port=${cdpPort}`], {
      JARVIS_STATE_DIR: stateDir,
      JARVIS_DEV_URL: `http://127.0.0.1:${vitePort}`,
      JARVIS_HARNESS_HOME: HARNESS_HOME,
      HARNESS_RUNTIME: 'openai',
      HARNESS_API_FORMAT: 'openai_compat',
      HARNESS_BASE_URL: `http://127.0.0.1:${stub.port}`,
      HARNESS_MODEL: 'resume-stub',
      // 한도가 3턴이어야 '마지막 tool 요청(실행 안 함)'이 실제로 남는다.
      // 4(기본)면 2개가 이미 실행되어 차단 지점의 증거가 사라진다.
      JARVIS_TOOL_LOOP_MAX_TURNS: String(MAX_TURNS),
    }, 'electron')

    cdp = await Cdp.attach(cdpPort)
    cdp.ws.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse(ev.data)
        if (msg.method === 'Runtime.exceptionThrown') {
          console.log(`  [renderer-exception] ${JSON.stringify(msg.params.exceptionDetails).slice(0, 400)}`)
        }
      } catch { /* */ }
    })
    await cdp.waitFor("document.readyState === 'complete' && document.body.innerText.trim().length > 0", '첫 렌더', 90000)
    await sleep(1200)

    const composer = "document.querySelector('.jarvis-command-input')"
    const sendBtn = "document.querySelector('.jarvis-command-send')"
    await cdp.waitFor(composer, 'composer 등장', 20000)
    const sendMessage = async (text) => {
      await cdp.typeInto(composer, text)
      await cdp.realClick(sendBtn, '보내기')
    }

    const readText = async (sel) => cdp.evalJs(`const el = ${sel}; return el ? el.innerText : ''`)

    //Resume 버튼이 실제로 눌릴 수 있는지 — 존재 + 보이는 크기 + 비활성 아님 + 히트 테스트
    const probeResume = async () => cdp.evalJs(`
      const btn = ${RESUME_BTN};
      if (!btn) return { present: false };
      const r = btn.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const hit = document.elementFromPoint(cx, cy);
      return {
        present: true,
        label: btn.textContent.trim(),
        disabled: btn.disabled,
        width: r.width,
        height: r.height,
        visible: r.width > 0 && r.height > 0,
        inViewport: cx >= 0 && cy >= 0 && cx <= window.innerWidth && cy <= window.innerHeight,
        clickable: Boolean(hit && (hit === btn || btn.contains(hit))),
        hitTag: hit ? hit.tagName + '.' + String(hit.className).slice(0, 40) : null,
      };
    `)

    const clickResume = async (description) => {
      const probe = await probeResume()
      if (!probe.present) fail(`이어가기 버튼 없음: ${description}`)
      if (probe.disabled) fail(`이어가기 버튼이 비활성 상태: ${description}`)
      if (!probe.visible) fail(`이어가기 버튼이 화면에 없음(크기 0): ${description}`)
      if (!probe.inViewport) fail(`이어가기 버튼이 뷰포트 밖: ${description}`)
      if (!probe.clickable) fail(`이어가기 버튼이 다른 요소에 가려짐(hit=${probe.hitTag}): ${description}`)
      console.log(`  클릭: "${probe.label}" @ ${JSON.stringify({ w: Math.round(probe.width), h: Math.round(probe.height) })}`)
      await cdp.realClick(RESUME_BTN, description)
    }

    const allTraces = []

    /* ================= Scenario A ================= */
    step('A) 정상 이어가기 — 한도 중단 → 실제 클릭 → 완주')
    stub.setMode('loop_then_finish', 'A')
    const callStartA = stub.received.calls.length
    const traceStartA = snapshotTraces()
    await sendMessage(MARK_A)
    await cdp.waitFor(ERR_PANEL, 'A ERROR 패널 등장', 90000)

    const errA = await readText(RUNTIME_TEXT)
    console.log(`  오류 문구: ${errA.slice(0, 120)}`)
    assertTrue(errA.includes(`tool 루프 한도(${MAX_TURNS}회)`), `한도 메시지가 아니다: ${errA}`)
    const panelA = await cdp.evalJs(`const p = ${ERR_PANEL}; return p ? p.className : null`)
    assertTrue(!String(panelA).includes('is-quiet'), `PiP quiet 모드라 버튼이 렌더되지 않는다: ${panelA}`)
    const hintA = await readText(RESUME_HINT)
    console.log(`  안내: ${hintA}`)
    assertTrue(hintA.includes('남은 3회'), `남은 횟수 안내가 없다: ${hintA}`)
    const probeA = await probeResume()
    console.log(`  버튼 상태: ${JSON.stringify(probeA)}`)
    assertTrue(probeA.present && probeA.label === '이어가기', '이어가기 버튼이 없다')
    assertTrue(probeA.visible && probeA.inViewport && probeA.clickable && !probeA.disabled, '이어가기 버튼이 실제로 눌릴 수 없다')
    await cdp.shot('A1-error-panel-with-resume')

    const callsA = stub.received.calls.slice(callStartA)
    console.log(`  모델 호출 ${callsA.length}회: ${callsA.map((c) => (c.resumed ? 'R' : 'T') + c.toolResultCount).join(' ')}`)
    assertTrue(callsA.length === MAX_TURNS, `한도 도달 전 ${MAX_TURNS}회여야 하는데 ${callsA.length}회`)
    assertTrue(!callsA.some((c) => c.resumed), '아직 resume 전인데 resume transcript가 들어왔다')

    const tracesA = newTraces(traceStartA)
    allTraces.push(...tracesA)
    const chatTraceA = tracesA.find((t) => t.response && t.response.finish_reason === 'tool_loop_limit')
    assertTrue(chatTraceA, 'tool_loop_limit trace가 canonical trace에 없다')
    console.log(`  chat trace: ${chatTraceA.trace_id} turns=${chatTraceA.turns} tool_results=${chatTraceA.tool_results.length}`)

    await clickResume('A 이어가기')
    await cdp.waitFor(DONE_PANEL, 'A resume 후 DONE 패널', 90000)
    const finalA = await readText(RUNTIME_TEXT)
    console.log(`  최종 문구: ${finalA.slice(0, 120)}`)
    assertTrue(finalA.includes('마무리'), `이어가기가 최종 응답에 도달하지 않았다: ${finalA}`)
    await cdp.shot('A2-resumed-done')
    await cdp.waitForGone(RESUME_BTN, 'A 이어가기 버튼', 15000)
    ok('이어가기 클릭 → 기존 transcript로 계속 → final 도달 → 버튼 사라짐')

    const tracesA2 = newTraces(traceStartA)
    allTraces.length = 0
    allTraces.push(...tracesA2)
    const resumeTraceA = tracesA2.find(
      (t) => t.trace_id !== chatTraceA.trace_id && t.response && t.response.finish_reason === 'stop',
    )
    assertTrue(resumeTraceA, 'resume 요청에 대응하는 trace가 없다')
    console.log(`  resume trace: ${resumeTraceA.trace_id} turns=${resumeTraceA.turns} tool_results=${resumeTraceA.tool_results.length}`)

    // 7) 이어간 모델 호출이 기존 transcript를 받았는가
    // (trace의 request.messages는 루프의 *마지막* 호출이라, 이어간 뒤 새로
    //  생긴 결과까지 들어 있다. 따라서 "이전 결과가 그대로 남아 있는가"를
    //  순서·내용 동일성으로 확인한다.)
    const toolMsgsOf = (t) => (t.request.messages || []).filter((m) => m.role === 'tool').map((m) => String(m.content || ''))
    const priorToolContents = toolMsgsOf(chatTraceA)
    const resumeToolContents = toolMsgsOf(resumeTraceA)
    const priorToolResults = priorToolContents.length
    console.log(`  resume transcript roles: ${(resumeTraceA.request.messages || []).map((m) => m.role).join(',')}`)
    console.log(`  이전 도구 결과 ${priorToolResults}개 → 이어간 transcript의 도구 결과 ${resumeToolContents.length}개`)
    assertTrue(priorToolResults === (chatTraceA.tool_results || []).length, 'chat trace의 도구 결과 수 불일치')
    assertTrue(resumeToolContents.length >= priorToolResults, `이전 도구 결과가 유실됨 (${resumeToolContents.length} < ${priorToolResults})`)
    const keptPrior = priorToolContents.every((c, i) => resumeToolContents[i] === c)
    assertTrue(keptPrior, '이어간 transcript에서 이전 도구 결과의 순서/내용이 바뀌었다')
    const resumeText = (resumeTraceA.request.messages || []).map((m) => String(m.content || '')).join('\n')
    assertTrue(resumeText.includes(MARK_A), '이어간 transcript에 원래 사용자 요청이 없다')
    assertTrue(resumeText.includes('stopped at the tool-call limit'), '이어가기 system 줄이 없다')
    const blockedNameMatch = String(chatTraceA.response.content || '').match(/마지막 tool 요청\(실행 안 함\): (\w+)/)
    console.log(`  차단된 tool: ${blockedNameMatch ? blockedNameMatch[1] : '?'}`)
    ok('resume가 기존 transcript(사용자 발화 + 실행된 도구 결과 + system 지시)를 그대로 전달')

    // 8) 이미 실행된 도구는 다시 실행되지 않았는가 — canonical trace 기준
    const priorExecuted = (chatTraceA.tool_results || []).map((t) => t.call.id)
    const newExecuted = (resumeTraceA.tool_results || []).map((t) => t.call.id)
    console.log(`  실행됨(이전): ${priorExecuted.join(',')}`)
    console.log(`  실행됨(이어간 뒤): ${newExecuted.join(',')}`)
    const overlap = newExecuted.filter((id) => priorExecuted.includes(id))
    assertTrue(overlap.length === 0, `이미 실행된 tool_call이 재실행됨: ${overlap.join(',')}`)
    const allIds = [...priorExecuted, ...newExecuted]
    assertTrue(new Set(allIds).size === allIds.length, `같은 tool_call id가 두 번 실행됨: ${allIds.join(',')}`)
    const resumeIdsInTrace = (resumeTraceA.request.messages || [])
      .filter((m) => m.role === 'assistant' && Array.isArray(m.tool_calls))
      .flatMap((m) => m.tool_calls.map((c) => c.id))
    const issuedA = stub.received.issued.filter((i) => i.mode === 'loop_then_finish')
    const preResumeIssued = issuedA.filter((i) => !i.resumed)
    // 한도는 "마지막 tool 요청을 실행하지 않고" 멈춘다 → 이어가기 전에 낸 마지막
    // 호출이 곧 실행되지 않은 그 호출이다.
    const blockedId = preResumeIssued[preResumeIssued.length - 1].id
    console.log(`  한도에 막힌 tool_call: ${blockedId} / 이어간 transcript에 있는 ids: ${resumeIdsInTrace.join(',') || '(없음)'}`)
    assertTrue(!resumeIdsInTrace.includes(blockedId), '한도에 막혀 실행되지 않은 tool_call이 이어간 transcript에 남아 있다')
    assertTrue(preResumeIssued.slice(0, -1).every((i) => priorExecuted.includes(i.id)), '실행된 tool_call id와 모델이 낸 id가 대응하지 않는다')
    ok('이미 실행된 tool_call은 재실행되지 않았고, 차단된 tool_call은 transcript에 남지 않음')

    const resumeCallsA = stub.received.calls.slice(callStartA).filter((c) => c.resumed)
    assertTrue(resumeCallsA.length === 2, `이어간 뒤 모델 호출이 ${resumeCallsA.length}회 (기대 2회)`)
    assertTrue(resumeCallsA[0].toolResultCount === priorToolResults, '이어간 첫 호출이 이전 도구 결과를 못 받았다')
    ok('이어간 첫 모델 호출이 이전 도구 결과를 그대로 들고 시작')

    /* ================= Scenario B ================= */
    step('B) 이어가기 상한 — 3회까지 허용, 이후 막힘')
    stub.setMode('loop', 'B')
    const traceStartB = snapshotTraces()
    await sendMessage(MARK_B)
    await cdp.waitFor(ERR_PANEL, 'B 첫 ERROR 패널', 90000)
    const limitsB = [await readText(RUNTIME_TEXT)]
    for (let i = 1; i <= 3; i += 1) {
      const hint = await readText(RESUME_HINT)
      console.log(`  resume #${i} 직전 안내: ${hint || '(안내 없음)'}`)
      assertTrue(hint.includes(`남은 ${4 - i}회`), `resume #${i} 직전 남은 횟수 안내가 이상하다: ${hint}`)
      await clickResume(`B 이어가기 #${i}`)
      await sleep(500)
      await cdp.waitFor(ERR_PANEL, `B resume #${i} 후 ERROR 패널`, 90000)
      limitsB.push(await readText(RUNTIME_TEXT))
      await cdp.shot(`B-resume-${i}`)
    }
    console.log(`  마지막 오류: ${limitsB[3].slice(0, 160)}`)
    const btnAfterCap = await probeResume()
    console.log(`  상한 후 버튼: ${JSON.stringify(btnAfterCap)}`)
    assertTrue(!btnAfterCap.present, `상한 후에도 이어가기 버튼이 남아 있다: ${JSON.stringify(btnAfterCap)}`)
    assertTrue((await readText(RESUME_HINT)) === '', '상한 후 안내 문구가 남아 있다')
    const capNotice = limitsB[3]
    assertTrue(
      capNotice.includes('이어가기를 3번') || capNotice.includes('3번 사용'),
      `상한 안내가 사용자에게 보이지 않는다: ${capNotice}`,
    )
    ok('이어가기 3회까지 허용되고, 그 뒤 버튼 사라짐 + 상한 안내 표시')

    const resume4 = await cdp.evalJs('return window.jarvisRuntime.resume()')
    console.log(`  4번째 bridge resume 응답: ${JSON.stringify(resume4).slice(0, 240)}`)
    assertTrue(resume4 && resume4.status === 'error', `4번째 resume이 안전하게 거부되지 않았다: ${JSON.stringify(resume4)}`)
    assertTrue(String(resume4.error).includes('이어가기를 3번 사용'), `상한 거부 문구가 없다: ${resume4.error}`)
    assertTrue(resume4.resumable === false, '거부 응답이 resumable=false여야 한다')
    ok('4번째 bridge resume 요청도 상한으로 거부됨 (UI 밖 경로)')

    const tracesB = newTraces(traceStartB)
    allTraces.push(...tracesB)
    const limitTracesB = tracesB.filter((t) => t.response && t.response.finish_reason === 'tool_loop_limit')
    console.log(`  B 한도 trace ${limitTracesB.length}개 (기대 4: chat + resume 3회)`)
    assertTrue(limitTracesB.length === 4, `한도에 도달한 횟수가 ${limitTracesB.length}회 (기대 4회)`)
    const loopIdsB = limitTracesB.flatMap((t) => (t.tool_results || []).map((r) => r.call.id))
    assertTrue(new Set(loopIdsB).size === loopIdsB.length, 'B 시나리오에서 같은 도구 실행이 중복됨')

    /* ================= Scenario C ================= */
    step('C) 낡은 이어가기 차단 — 새 요청이 이전 지점을 물려받지 않음')
    stub.setMode('loop', 'CA')
    const callStartC = stub.received.calls.length
    await sendMessage(MARK_CA)
    await cdp.waitFor(ERR_PANEL, 'C 첫 ERROR 패널', 90000)
    assertTrue((await probeResume()).present, 'C 첫 요청 뒤 이어가기 버튼이 없다')
    assertTrue((await readText(RESUME_HINT)).includes('남은 3회'), 'C 첫 요청 뒤 예산이 3회가 아니다')
    const callsCA = stub.received.calls.slice(callStartC)
    assertTrue(callsCA.length === MAX_TURNS, 'C 첫 요청이 한도에 도달하지 않았다')

    stub.setMode('plain', 'CB')
    const callStartCB = stub.received.calls.length
    await sendMessage(MARK_CB)
    await cdp.waitFor(DONE_PANEL, 'C 새 요청 DONE 패널', 90000)
    await cdp.shot('C2-new-request-done')
    assertTrue(!(await probeResume()).present, '새 요청 완주 후 죽은 이어가기 버튼이 남아 있다')
    ok('새 요청이 시작/완주하자 이전 이어가기 UI가 사라짐')

    const probeResumeC = await cdp.evalJs('return window.jarvisRuntime.resume()')
    console.log(`  낡은 지점 probe: ${JSON.stringify(probeResumeC).slice(0, 200)}`)
    assertTrue(probeResumeC && probeResumeC.status === 'error', '이전 지점이 남아 있다')
    assertTrue(
      String(probeResumeC.error).includes('이어서 실행할 작업이 없습니다'),
      `이전 지점이 폐기되었다는 신호가 없다: ${probeResumeC.error}`,
    )
    ok('이전 작업의 continuation은 폐기됨 (bridge resume이 "없음"으로 거부)')

    const callsCB = stub.received.calls.slice(callStartCB)
    assertTrue(callsCB.length === 1, `새 요청이 ${callsCB.length}회 모델 호출 (기대 1회)`)
    const carried = callsCB.filter((c) => c.text.includes(MARK_CA))
    console.log(`  새 요청 모델 호출 roles: ${callsCB[0].roles.join(',')} (tool 결과 ${callsCB[0].toolResultCount}개)`)
    assertTrue(carried.length === 0, '새 요청의 transcript에 이전 작업 내용이 섞여 들어갔다')
    assertTrue(callsCB[0].toolResultCount === 0, '새 요청이 이전 도구 결과를 물려받았다')
    ok('새 요청의 모델 transcript에 이전 작업의 발화·도구 결과가 없음')

    stub.setMode('loop', 'C1')
    await sendMessage(MARK_C1)
    await cdp.waitFor(ERR_PANEL, 'C 예산 초기화 ERROR 패널', 90000)
    const hintC1 = await readText(RESUME_HINT)
    console.log(`  새 작업 예산: ${hintC1}`)
    assertTrue(hintC1.includes('남은 3회'), `이어가기 예산이 초기화되지 않았다: ${hintC1}`)
    ok('새 요청은 이어가기 예산을 3회로 초기화')

    /* ================= Scenario D ================= */
    step('D) 중복 변이 없음 — resume 전 성공한 도구가 재생성되지 않음')
    const proposalsBefore = proposalRecords()
    console.log(`  저장된 제안(전): ${proposalsBefore.length}건`)
    const fileBefore = fs.readFileSync(targetPath, 'utf8')
    stub.setMode('proposal_loop', 'D')
    const callStartD = stub.received.calls.length
    const traceStartD = snapshotTraces()
    await sendMessage(MARK_D)
    await cdp.waitFor(ERR_PANEL, 'D ERROR 패널', 90000)
    const errD = await readText(RUNTIME_TEXT)
    console.log(`  D 오류: ${errD.slice(0, 120)}`)
    assertTrue(errD.includes(`tool 루프 한도(${MAX_TURNS}회)`), 'D 한도 오류가 아니다')

    const proposalsAtLimit = proposalRecords()
    console.log(`  저장된 제안(한도 지점): ${proposalsAtLimit.length}건`)
    const newProposals = proposalsAtLimit.filter((p) => !proposalsBefore.some((b) => b.proposal_id === p.proposal_id))
    assertTrue(newProposals.length === 1, `한도 지점의 새 제안이 ${newProposals.length}건 (기대 1건 — edit_file은 1회만 실행)`)
    const proposalId = newProposals[0].proposal_id
    console.log(`  생성된 제안: ${proposalId}`)

    const callsD = stub.received.calls.slice(callStartD)
    const editCallsD = stub.received.issued.filter((i) => i.mode === 'proposal_loop' && i.name === 'edit_file')
    const executedEditId = editCallsD.find((i) => !i.resumed && i.assistantTurns === 1)
    assertTrue(executedEditId, '실행된 edit_file call을 찾지 못했다')
    console.log(`  edit_file 요청 ${editCallsD.length}회 중 실행된 것 1건: ${executedEditId.id}`)

    await clickResume('D 이어가기')
    await cdp.waitFor(DONE_PANEL, 'D resume 후 DONE 패널', 90000)
    await cdp.shot('D2-resumed-proposal')
    const proposalsAfter = proposalRecords()
    console.log(`  저장된 제안(이어간 뒤): ${proposalsAfter.length}건`)
    const after = proposalsAfter.filter((p) => !proposalsAtLimit.some((b) => b.proposal_id === p.proposal_id))
    assertTrue(after.length === 0, `이어가기 중 같은 변이가 재생성됨: ${after.map((p) => p.proposal_id).join(',')}`)
    assertTrue(proposalsAfter.some((p) => p.proposal_id === proposalId), '원래 제안이 사라졌다')
    assertTrue(fs.readFileSync(targetPath, 'utf8') === fileBefore, '승인 없이 대상 파일이 변경되었다')
    ok('이어가기가 이미 만든 제안을 중복 생성하지 않고, 파일도 건드리지 않음')

    const tracesD = newTraces(traceStartD)
    allTraces.push(...tracesD)
    const chatTraceD = (tracesD.find((t) => t.response && t.response.finish_reason === 'tool_loop_limit') || {}).trace_id
    assertTrue(chatTraceD, 'D chat trace(한도)가 없다')
    const editResultsD = tracesD.flatMap((t) => (t.tool_results || [])).filter((r) => r.call.name === 'edit_file')
    console.log(`  trace상 edit_file 실행 ${editResultsD.length}회: ${editResultsD.map((r) => r.call.id).join(',')}`)
    assertTrue(editResultsD.length === 1, `edit_file이 ${editResultsD.length}회 실행됨 (기대 1회)`)
    assertTrue(editResultsD[0].call.id === executedEditId.id, '실행 기록의 tool_call id가 모델이 낸 것과 다르다')
    const executedIdsD = tracesD.flatMap((t) => (t.tool_results || []).map((r) => r.call.id))
    assertTrue(new Set(executedIdsD).size === executedIdsD.length, '같은 tool_call id가 두 번 실행됨')
    const resumeTraceD = tracesD.find(
      (t) => t.response && t.response.finish_reason === 'stop' && t.trace_id !== chatTraceD,
    )
    if (!resumeTraceD) {
      console.log(`  D trace 목록: ${tracesD.map((t) => `${t.trace_id}/${t.response && t.response.finish_reason}`).join(', ')}`)
    }
    assertTrue(resumeTraceD, 'D resume trace가 없다')
    const dResumeIds = (resumeTraceD.request.messages || [])
      .filter((m) => m.role === 'assistant' && Array.isArray(m.tool_calls))
      .flatMap((m) => m.tool_calls.map((c) => c.id))
    assertTrue(dResumeIds.includes(executedEditId.id), '이어간 transcript에 이미 실행된 edit_file 결과가 없다')
    const blockedEditId = editCallsD.find((i) => i.id !== executedEditId.id)
    assertTrue(blockedEditId, '차단된 edit_file call을 찾지 못했다')
    assertTrue(!dResumeIds.includes(blockedEditId.id), '차단된 edit_file이 이어간 transcript에 남아 있다')
    ok('canonical trace 기준으로 동일 tool_call 재실행·중복 변이가 없음')

    /* ================= 요약 ================= */
    step('증거 요약')
    const executedAll = allTraces.flatMap((t) => (t.tool_results || [])).map((r) => r.call.id)
    console.log(`  session trace ${allTraces.length}건 / 도구 실행 ${executedAll.length}회 / 고유 id ${new Set(executedAll).size}개`)
    assertTrue(new Set(executedAll).size === executedAll.length, '세션 전체에서 중복 tool_call 실행이 있었다')
    const cardText = await cdp.evalJs("const c = document.querySelector('.jarvis-edit-card'); return c ? c.innerText : ''")
    assertTrue(cardText.includes(FILE_NAME), `이어간 뒤 제안 diff 카드가 없다: ${cardText.slice(0, 120)}`)
    await cdp.shot('final-diff-card')
    assertTrue(!(await probeResume()).present, 'final 상태에 이어가기 버튼이 남아 있다')
    ok('최종 상태: 제안 diff 카드 표시, 이어가기 버튼 없음')

    console.log(`\nLOOP RESUME GUI VERIFIED — 이어가기 ${passed}개 단언 통과.`)
    return true
  } catch (err) {
    console.error(`\nVERIFY FAILED: ${err.message}`)
    if (cdp) { try { await cdp.shot('failure') } catch { /* */ } }
    process.exitCode = 1
    return false
  } finally {
    if (cdp) { try { cdp.ws.close() } catch { /* */ } }
    for (const child of children) { try { child.kill() } catch { /* */ } }
    if (stub) stub.server.close()
  }
}

main()
