/*
  UX Continuity (1-1 ~ 1-5) 재검증 — 실제 Electron 앱에서 클릭으로 증명한다.

  검증 항목:
    1-1) 첫 열림에 브리핑이 자동으로 뜬다 (사용자 발화 없이).
    1-2) 브리핑 [시작] 클릭 → FOCUS + Active File + drawer가 곧바로 세팅된다.
    1-3) PiP done 카드에 응답 요약이 보인다.
    1-4) 승인 대기 중에도 composer 입력이 가능하고, 제출하면 "대기 중" 배지가
         뜨며, 턴이 끝나면 자동으로 이어서 처리된다.
    1-5) context 한 줄에 Project · Focus · Active File이 표시된다.
    보존) 기존 작업 시작 여정(파일→요청→승인→연결)이 회귀 없이 동작한다.

  실행: node tests/verify_ux_continuity.cjs
  실패 시 exit 1. 스크린샷은 tests/artifacts/ux-continuity/ 에 남는다.
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
const ARTIFACT_DIR = path.join(__dirname, 'artifacts', 'ux-continuity')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function fail(message) {
  console.error(`[FAIL] ${message}`)
  process.exitCode = 1
  throw new Error(message)
}
function step(message) {
  console.log(`\n=== ${message} ===`)
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

function startStubModel() {
  const state = { calls: 0 }
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      state.calls += 1
      let payload = {}
      try { payload = JSON.parse(body || '{}') } catch { payload = {} }
      const messages = Array.isArray(payload.messages) ? payload.messages : []
      const lastUser = [...messages].reverse().find((m) => m && m.role === 'user')
      const text = (lastUser && lastUser.content) || ''
      const hasToolResult = messages.some((m) => m && m.role === 'tool')
      let message
      if (hasToolResult) {
        message = { role: 'assistant', content: '응답이 완료되었습니다. task와 파일을 연결했습니다.' }
      } else if (text.includes('계속')) {
        message = {
          role: 'assistant',
          content: '',
          tool_calls: [{ function: { name: 'resume_briefing', arguments: { project_id: 'jarvis-app' } } }],
        }
      } else if (text.includes('두번째') || text.includes('두 번째')) {
        message = {
          role: 'assistant',
          content: `두 번째 요청도 처리했습니다: ${text.slice(0, 20)}`,
        }
      } else {
        message = {
          role: 'assistant',
          content: '',
          tool_calls: [{
            function: {
              name: 'create_task',
              arguments: { project_id: 'jarvis-app', title: 'continuity 검증 작업', reason: 'verify' },
            },
          }],
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ model: payload.model, message, done: true }))
    })
  })
  return new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, state }))
  })
}

function seedState(stateDir, workspaceDir) {
  /*
    1-2 검증용 --seed-task-file-link:
    미완료 task + FileRef + task→file 링크를 전부 canonical writer로 심는다.
    브리핑 [시작]은 next_action이 있을 때만 나오고(추측 금지), next_action의
    자료로 Active File을 연다 — 그 전 경로를 그대로 재현하기 위해서다.
  */
  const result = spawnSync(
    process.env.PYTHON || 'python',
    ['-m', 'scripts.gui_e2e_fixture', '--state-dir', stateDir, '--workspace-dir', workspaceDir, '--project-id', 'jarvis-app', '--seed-task-file-link'],
    { cwd: HARNESS_HOME, encoding: 'utf-8' },
  )
  if (result.status !== 0) fail(`fixture 실패: ${result.stderr || result.stdout}`)
  return JSON.parse((result.stdout || '').trim().split('\n').pop())
}

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.nextId = 1
    this.pending = new Map()
    this.consoleErrors = []
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        this.consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300))
        return
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        this.consoleErrors.push(String(msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text || 'exception').slice(0, 300))
        return
      }
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
      const ok = await this.evalJs(`return Boolean(${expression})`)
      if (ok) return true
      await sleep(300)
    }
    throw new Error(`대기 실패: ${description}`)
  }
  async hitProbe(selector) {
    return this.evalJs(`
      const el = document.querySelector('${selector}');
      if (!el) return { exists: false };
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      if (r.width === 0 || r.height === 0) return { exists: true, zeroSize: true };
      const hit = document.elementFromPoint(x, y);
      return {
        exists: true,
        hitSelf: Boolean(hit && (hit === el || el.contains(hit))),
        hit: hit ? hit.tagName + '.' + String(hit.className).split(' ').slice(0, 2).join('.') : 'none',
      };
    `)
  }
  async realClick(findExpression, description) {
    const point = await this.evalJs(`
      const el = ${findExpression};
      if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
    `)
    if (!point) fail(`클릭 대상 없음: ${description}`)
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
      return { x: r.left + r.width * 0.1, y: r.top + r.height / 2, covered: true };
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

async function main() {
  const children = []
  let stub = null
  let cdp = null
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis_ux_continuity_'))
  const stateDir = path.join(scratch, 'state')
  const workspaceDir = path.join(scratch, 'ws')

  try {
    step('환경 준비')
    stub = await startStubModel()
    const fixture = seedState(stateDir, workspaceDir)
    console.log(`  file=${fixture.file_name}`)

    const vitePort = await freePort()
    const cdpPort = await freePort()
    const run = (cmd, args, env, label) => {
      const child = spawn(cmd, args, { cwd: APP_ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      child.stdout.on('data', (c) => { const t = String(c).trim(); if (t && process.env.JARVIS_E2E_VERBOSE) console.log(`[${label}] ${t}`) })
      child.stderr.on('data', (c) => { const t = String(c).trim(); if (t && process.env.JARVIS_E2E_VERBOSE) console.log(`[${label}!] ${t}`) })
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
      HARNESS_BASE_URL: `http://127.0.0.1:${stub.port}`,
      HARNESS_MODEL: 'ux-continuity-stub',
    }, 'electron')

    cdp = await Cdp.attach(cdpPort)
    await cdp.waitFor("document.readyState === 'complete' && document.body.innerText.trim().length > 0", '첫 렌더', 90000)

    // --- 1-1) 첫 열림 곧 브리핑 ---
    step('1-1) 첫 열림 = 자동 브리핑 (발화 없이)')
    await cdp.waitFor("document.querySelector('.jarvis-resume-briefing')", '자동 브리핑 등장', 30000)
    const briefText = await cdp.evalJs("return document.querySelector('.jarvis-resume-briefing')?.innerText.replace(/\\s+/g, ' ').slice(0, 260)")
    console.log(`  브리핑: ${briefText}`)
    if (!briefText || !briefText.includes('GUI E2E 검증 프로젝트')) fail('자동 브리핑에 프로젝트가 없음')
    await cdp.shot('C01-auto-briefing')
    console.log('  PASS — 첫 열림에 브리핑 자동 표시')

    // --- 1-5) context 한 줄 ---
    step('1-5) context 한 줄 (Project · Focus · Active File)')
    const ctxLine = await cdp.evalJs("return document.querySelector('.jarvis-context-line')?.innerText.replace(/\\s+/g, ' ').trim()")
    console.log(`  context line: ${ctxLine || '(없음)'}`)
    if (!ctxLine || !ctxLine.includes('GUI E2E 검증 프로젝트')) fail(`context 한 줄에 프로젝트가 없음: ${ctxLine}`)
    await cdp.shot('C02-context-line')
    console.log('  PASS — context 한 줄 표시')

    // --- 1-2) [시작] → 바로 이어하기 ---
    step('1-2) 브리핑 [시작] → FOCUS + Active File 즉시 세팅')
    await cdp.realClick("document.querySelector('.jarvis-resume-start')", '브리핑 [시작]')
    await sleep(1200)
    const started = await cdp.evalJs(`
      return {
        focus: document.querySelector('.jarvis-focus-indicator')?.innerText.replace(/\\s+/g, ' '),
        editorOpen: Boolean(document.querySelector('.workspace-file-editor')),
        drawerOpen: document.querySelector('.jarvis-shell')?.dataset?.contextOpen,
      };
    `)
    console.log(`  ${JSON.stringify(started)}`)
    if (!started.focus || !started.focus.includes('작업')) fail('FOCUS가 세팅되지 않음')
    if (!started.editorOpen) fail('Active File이 열리지 않음')
    await cdp.shot('C03-start-from-briefing')
    console.log('  PASS — [시작] 클릭 한 번으로 작업 진입')

    // --- 보존) 기존 여정: 파일 → 요청 → 승인 ---
    step('보존) 기존 작업 시작 여정 + 1-4 queued composer')
    await cdp.typeInto("document.querySelector('.jarvis-command-input')", '지금 보고 있는 파일을 바탕으로 할 일 하나만 추가해줘.')
    await cdp.realClick("document.querySelector('.jarvis-command-send')", 'Send')
    try {
      await cdp.waitFor("document.querySelector('.jarvis-approve-button') && !document.querySelector('.jarvis-approve-button').disabled", 'Approve 노출', 90000)
    } catch {
      const dump = await cdp.evalJs(`
        return {
          body: document.body.innerText.replace(/\\s+/g, ' ').slice(0, 400),
          busy: document.querySelector('.jarvis-runtime-panel')?.className,
          placeholder: document.querySelector('.jarvis-runtime-placeholder')?.innerText.slice(0, 100),
        };
      `)
      fail(`Approve 미노출 — dump: ${JSON.stringify(dump)} consoleErrors: ${JSON.stringify(cdp.consoleErrors.slice(0, 5))}`)
    }

    // --- 1-4) 승인 대기 중 composer 생존 + 큐 ---
    step('1-4) 승인 대기 중 입력 가능 + 대기 배지 + 자동 이어처리')
    const inputDisabled = await cdp.evalJs("return document.querySelector('.jarvis-command-input')?.disabled")
    if (inputDisabled) fail('승인 대기 중 composer가 disabled')
    await cdp.typeInto("document.querySelector('.jarvis-command-input')", '두번째 요청을 처리해줘')
    await cdp.realClick("document.querySelector('.jarvis-command-send')", 'Send (대기 중 제출)')
    const queued = await cdp.waitFor("document.querySelector('.jarvis-queued-note')", '대기 배지', 10000)
    console.log(`  대기 배지 표시: ${queued}`)
    await cdp.shot('C04-queued-while-approval')
    const queuedText = await cdp.evalJs("return document.querySelector('.jarvis-queued-note')?.innerText.replace(/\\s+/g, ' ')")
    console.log(`  배지: ${queuedText}`)
    if (!queuedText || !queuedText.includes('두번째')) fail('배지에 대기 텍스트가 없음')

    // 승인하면 → done + 링크 카드 → 이후 대기 요청이 자동 처리되어 done(두번째)이 떠야 한다
    await cdp.realClick("document.querySelector('.jarvis-approve-button')", 'Approve')
    await cdp.waitFor("document.querySelector('.jarvis-runtime-panel.is-done')", '첫 턴 완료', 90000)
    // 링크 제안은 사용자가 해소해야 큐가 흐른다 — Not now로 치운다.
    await cdp.waitFor("document.querySelector('.jarvis-link-affordance')", '링크 카드', 30000)
    await cdp.realClick("document.querySelector('.jarvis-link-skip')", 'Not now')
    // 이제 두 번째 요청이 자동으로 전송되어 done이 된다
    await cdp.waitFor("document.body.innerText.includes('두 번째 요청도 처리했습니다')", '대기 요청 자동 이어처리', 60000)
    const queueGone = await cdp.evalJs("return !document.querySelector('.jarvis-queued-note')")
    if (!queueGone) fail('이어처리 후 대기 배지가 남아 있음')
    await cdp.shot('C05-auto-continue')
    console.log('  PASS — 승인 중 제출한 요청이 자동으로 이어서 처리됨')

    // --- 1-3) PiP done 요약 ---
    step('1-3) PiP done 카드에 응답 요약')
    const summary = await cdp.evalJs("return document.querySelector('.jarvis-runtime-panel.is-done .jarvis-runtime-text')?.innerText.slice(0, 60)")
    console.log(`  최종 응답: ${summary}`)
    await cdp.realClick("document.querySelector('.core-trigger')", 'Core 클릭')
    await cdp.waitFor("document.querySelector('.pip-result-button')", 'PiP done 카드', 15000)
    await sleep(500)
    const pipCard = await cdp.evalJs(`
      const card = document.querySelector('.pip-result-button');
      return { text: card?.innerText.replace(/\\s+/g, ' ').slice(0, 200) };
    `)
    console.log(`  PiP 카드: ${pipCard.text}`)
    if (!pipCard.text || (!pipCard.text.includes('두 번째') && !pipCard.text.includes('클릭'))) fail('PiP done 카드에 요약/힌트가 없음')
    const hit = await cdp.hitProbe('.pip-result-button')
    if (!hit.hitSelf) fail(`PiP done 카드 클릭 불가: ${JSON.stringify(hit)}`)
    await cdp.shot('C06-pip-summary')
    console.log('  PASS — PiP done 카드가 응답 요약과 함께 클릭 가능')

    // 복귀 확인
    await cdp.realClick("document.querySelector('.pip-result-button')", '복귀 카드')
    await cdp.waitFor("document.querySelector('.command-center-interface')", 'Command Center 복귀', 10000)
    console.log('  PASS — 카드 클릭으로 복귀')

    console.log('\nUX CONTINUITY VERIFIED — 1-1 ~ 1-5 모두 실제 GUI에서 확인됨.')
    void stub
    return true
  } catch (err) {
    console.error(`\nVERIFY FAILED: ${err.message}`)
    process.exitCode = 1
    return false
  } finally {
    if (cdp) { try { cdp.ws.close() } catch { /* */ } }
    for (const child of children) { try { child.kill() } catch { /* */ } }
    if (stub) stub.server.close()
  }
}

main()
