/*
  UX AUDIT click-through — 실제 앱에서 A~D 여정을 측정한다 (구현 없음, 관찰만).

  기존 tests/test_gui_link_flow.cjs의 CDP 기법을 재사용한다. 차이:
    - stub model이 "사용자 발화"으로 tool을 고른다(계속→resume_briefing, 할 일→create_task)
    - 각 여정마다 클릭 수·겹침(elementFromPoint)·중복 입력창 수를 JSON으로 기록
    - 실패해도 끝까지 진행해 관찰을 남긴다(audit이므로)

  실행: node tests/audit_ux_clickthrough.cjs
  산출: tests/artifacts/ux-audit/*.png + audit-findings.json
*/
const { spawn, spawnSync } = require('node:child_process')
const http = require('node:http')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const net = require('node:net')

const APP_ROOT = path.join(__dirname, '..')
const HARNESS_HOME = process.env.JARVIS_HARNESS_HOME || path.join(os.homedir(), 'Desktop', 'FB_Soap_LocalLLM')
const ARTIFACT_DIR = path.join(__dirname, 'artifacts', 'ux-audit')
const FINDINGS_FILE = path.join(ARTIFACT_DIR, 'audit-findings.json')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const findings = { startedAt: new Date().toISOString(), journeys: [], probes: [], consoleErrors: [] }
const note = (journey, step, data) => {
  const entry = { journey, step, ...data }
  findings.journeys.push(entry)
  console.log(`  [${journey}] ${step}: ${JSON.stringify(data).slice(0, 300)}`)
}
const probe = (name, data) => {
  findings.probes.push({ name, ...data })
  console.log(`  [probe] ${name}: ${JSON.stringify(data).slice(0, 300)}`)
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

/* stub model — 사용자 발화으로 tool 결정 (결정적) */
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
        message = { role: 'assistant', content: '요청을 처리했습니다.' }
      } else if (text.includes('계속')) {
        message = {
          role: 'assistant',
          content: '',
          tool_calls: [{ function: { name: 'resume_briefing', arguments: { project_id: 'jarvis-app' } } }],
        }
      } else {
        message = {
          role: 'assistant',
          content: '',
          tool_calls: [{
            function: {
              name: 'create_task',
              arguments: { project_id: 'jarvis-app', title: 'UX audit 검증 작업', reason: 'audit' },
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
  const result = spawnSync(
    process.env.PYTHON || 'python',
    ['-m', 'scripts.gui_e2e_fixture', '--state-dir', stateDir, '--workspace-dir', workspaceDir, '--project-id', 'jarvis-app'],
    { cwd: HARNESS_HOME, encoding: 'utf-8' },
  )
  if (result.status !== 0) throw new Error(`fixture 실패: ${result.stderr || result.stdout}`)
  return JSON.parse((result.stdout || '').trim().split('\n').pop())
}

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.nextId = 1
    this.pending = new Map()
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type)) {
        findings.consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 200))
        return
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        findings.consoleErrors.push(String(msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text || 'exception').slice(0, 200))
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
  async realClick(findExpression, description) {
    const point = await this.evalJs(`
      const el = ${findExpression};
      if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
    `)
    if (!point) throw new Error(`클릭 대상 없음: ${description}`)
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
    if (!point) throw new Error('입력 필드 없음')
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1, buttons: 1 })
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1, buttons: 0 })
    await this.send('Input.insertText', { text })
    await sleep(250)
    return point.covered ? 'covered' : 'ok'
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

/* 화면에 보이는 인터랙티브 요소 전수 덤프 */
async function dumpInteractive(cdp) {
  return cdp.evalJs(`
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
      const st = getComputedStyle(el);
      return st.visibility !== 'hidden' && st.display !== 'none';
    };
    return {
      viewport: window.innerWidth + 'x' + window.innerHeight,
      view: document.querySelector('.jarvis-shell')?.dataset?.view,
      contextOpen: document.querySelector('.jarvis-shell')?.dataset?.contextOpen,
      buttons: Array.from(document.querySelectorAll('button')).filter(visible).map((b) => ({
        label: b.getAttribute('aria-label') || b.innerText.trim().slice(0, 24),
        cls: String(b.className).split(' ')[0],
      })),
      inputs: Array.from(document.querySelectorAll('input, textarea')).filter(visible).map((i) => ({
        ph: i.placeholder || i.getAttribute('aria-label') || i.type, cls: String(i.className).split(' ')[0],
      })),
      bodyText: document.body.innerText.replace(/\\s+/g, ' ').slice(0, 500),
    };
  `)
}

/* 겹침 측정: 셀렉터 중심을 눌렀을 때 실제로 눌리는 요소 */
async function hitProbe(cdp, selector) {
  return cdp.evalJs(`
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
      rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)].join(','),
    };
  `)
}

async function main() {
  const children = []
  let stub = null
  let cdp = null
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis_ux_audit_'))
  const stateDir = path.join(scratch, 'state')
  const workspaceDir = path.join(scratch, 'ws')

  try {
    console.log('=== 준비 (stub model + canonical fixture) ===')
    stub = await startStubModel()
    const fixture = seedState(stateDir, workspaceDir)
    console.log(`  file=${fixture.file_name} root=${fixture.root_id}`)

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
    if (!html) throw new Error('vite 미기동')
    const entryMatch = html.match(/src="([^"]+\.[jt]sx?)"/)
    if (entryMatch) await waitForHttp(new URL(entryMatch[1], viteUrl).toString(), 30000)

    const electronPath = require('electron')
    run(electronPath, ['.', `--remote-debugging-port=${cdpPort}`], {
      JARVIS_STATE_DIR: stateDir,
      JARVIS_DEV_URL: `http://127.0.0.1:${vitePort}`,
      JARVIS_HARNESS_HOME: HARNESS_HOME,
      HARNESS_BASE_URL: `http://127.0.0.1:${stub.port}`,
      HARNESS_MODEL: 'ux-audit-stub',
    }, 'electron')

    cdp = await Cdp.attach(cdpPort)
    await cdp.waitFor("document.readyState === 'complete' && document.body.innerText.trim().length > 0", '첫 렌더', 90000)
    await sleep(800)

    /* ---------- A. 첫 열림 ---------- */
    console.log('\n=== A. 앱 첫 열림 ===')
    const first = await dumpInteractive(cdp)
    note('A-first-open', 'initial state', first)
    await cdp.shot('A01-first-open')
    probe('A-initial-view', { view: first.view, viewport: first.viewport })
    probe('A-button-count-first-screen', { count: first.buttons.length, buttons: first.buttons.map((b) => b.label || b.cls) })
    probe('A-inputs-first-screen', { count: first.inputs.length, inputs: first.inputs.map((i) => i.ph) })

    /* ---------- B. 작업 시작 ---------- */
    console.log('\n=== B. 작업 시작 (파일 찾기 → 요청 → 승인 → 연결) ===')
    let clicks = 0

    // B1. 파일을 찾으려면 Context 토글이 필요한가?
    const ctxBtn = await hitProbe(cdp, '.jarvis-context-button')
    probe('B-context-button-hit', ctxBtn)
    await cdp.realClick("document.querySelector('.jarvis-context-button')", 'Context 토글')
    clicks += 1
    await sleep(1200)
    const drawer = await dumpInteractive(cdp)
    note('B-start', 'after context toggle', { clicksSoFar: clicks, inputs: drawer.inputs, view: drawer.view })
    await cdp.shot('B02-context-open')

    // composer가 여전히 눌리는가 (drawer가 덮는가)?
    const compHitDrawerOpen = await hitProbe(cdp, '.jarvis-command-input')
    const sendHitDrawerOpen = await hitProbe(cdp, '.jarvis-command-send')
    probe('B-composer-hit-with-drawer-open', compHitDrawerOpen)
    probe('B-send-hit-with-drawer-open', sendHitDrawerOpen)

    // B2. 파일 행 클릭 → Active File
    const fileRow = `Array.from(document.querySelectorAll('.tree-prototype-map-row')).find((row) => (row.innerText || '').includes(${JSON.stringify(fixture.file_name)}))?.querySelector('.tree-prototype-map-label')`
    await cdp.realClick(fileRow, `파일 행 ${fixture.file_name}`)
    clicks += 1
    await sleep(1500)
    const editorOpen = await cdp.evalJs("return Boolean(document.querySelector('.workspace-file-editor'))")
    note('B-open-file', 'editor opened', { clicksSoFar: clicks, editorOpen })
    await cdp.shot('B03-active-file')

    // 중복 입력창 수 (composer vs drawer Ask)
    const inputCount = await cdp.evalJs(`
      return Array.from(document.querySelectorAll('input:not([type=search]), textarea')).filter((el) => el.offsetParent !== null).map((el) => el.placeholder || el.getAttribute('aria-label'));
    `)
    probe('B-visible-text-inputs', { count: inputCount.length, list: inputCount })

    // B3. 요청 입력 → Send
    const typeResult = await cdp.typeInto("document.querySelector('.jarvis-command-input')", '지금 보고 있는 파일을 바탕으로 할 일 하나만 추가해줘.')
    probe('B-typing-into-composer', { result: typeResult })
    await cdp.shot('B04-typed')
    await cdp.realClick("document.querySelector('.jarvis-command-send')", 'Send')
    clicks += 1
    note('B-send', 'request sent', { clicksSoFar: clicks })

    // B4. 승인
    await cdp.waitFor("document.querySelector('.jarvis-approve-button') && !document.querySelector('.jarvis-approve-button').disabled", 'Approve 노출', 90000)
    await cdp.shot('B05-permission')
    const permText = await cdp.evalJs("return document.querySelector('.jarvis-runtime-panel.is-permission')?.innerText.replace(/\\s+/g, ' ').slice(0, 300)")
    note('B-permission-panel', 'content', { text: permText })
    await cdp.realClick("document.querySelector('.jarvis-approve-button')", 'Approve')
    clicks += 1

    // B5. 링크 카드
    await cdp.waitFor("document.querySelector('[aria-label=\"Link active file\"]')", '링크 카드', 90000)
    await cdp.shot('B06-link-card')
    const cardText = await cdp.evalJs("return document.querySelector('.jarvis-link-affordance')?.innerText.replace(/\\s+/g, ' ').slice(0, 200)")
    await cdp.realClick("document.querySelector('.jarvis-link-button')", 'Link file')
    clicks += 1
    await cdp.waitFor("document.querySelector('.jarvis-link-affordance.is-done')", '연결 완료', 60000)
    note('B-link-done', 'journey complete', { clicksSoFar: clicks, cardText })
    await cdp.shot('B07-link-done')
    probe('B-total-clicks-to-start-work', { clicks })

    /* ---------- C. 계속하자 ---------- */
    console.log('\n=== C. "계속하자" → resume briefing → 작업 진입 ===')
    let cClicks = 0
    await cdp.typeInto("document.querySelector('.jarvis-command-input')", '계속하자')
    await cdp.realClick("document.querySelector('.jarvis-command-send')", 'Send')
    cClicks += 2 // input focus + send
    await cdp.waitFor("document.querySelector('.jarvis-resume-briefing')", '브리핑 패널', 90000)
    await sleep(600)
    const briefing = await cdp.evalJs(`
      const b = document.querySelector('.jarvis-resume-briefing');
      if (!b) return { text: null, rect: null, composerTop: null };
      const r = b.getBoundingClientRect();
      const form = document.querySelector('.jarvis-command-form')?.getBoundingClientRect();
      return { text: b.innerText.replace(/\\s+/g, ' ').slice(0, 400), rect: [Math.round(r.top), Math.round(r.height)].join(','), composerTop: form ? Math.round(form.top) : null };
    `)
    note('C-briefing', 'content & position', briefing)
    await cdp.shot('C01-briefing')
    const startBtnHit = await hitProbe(cdp, '.jarvis-resume-start')
    probe('C-start-button-hit', startBtnHit)
    await cdp.realClick("document.querySelector('.jarvis-resume-start')", '[시작]')
    cClicks += 1
    await sleep(1200)
    const afterStart = await cdp.evalJs(`
      return {
        focus: document.querySelector('.jarvis-focus-indicator')?.innerText.replace(/\\s+/g, ' '),
        editorOpen: Boolean(document.querySelector('.workspace-file-editor')),
        drawerOpen: document.querySelector('.jarvis-shell')?.dataset?.contextOpen,
      };
    `)
    note('C-start-task', 'after [시작]', { clicksSoFar: cClicks, ...afterStart })
    await cdp.shot('C02-after-start')
    probe('C-total-clicks-from-continue-to-work', { clicks: cClicks })

    /* ---------- D. Main ↔ PiP ---------- */
    console.log('\n=== D. Main ↔ PiP ===')
    // CC에서 orb는 눌리는가? — 이제 orb가 유일한 PiP 복귀 경로다.
    const coreHitCC = await hitProbe(cdp, '.core-trigger')
    probe('D-core-orb-hit-in-command-center', coreHitCC)

    const t0 = Date.now()
    await cdp.realClick("document.querySelector('.core-trigger')", 'Core 클릭')
    await cdp.waitFor("document.querySelector('.pip-presence')", 'PiP 등장', 10000)
    const pipMs = Date.now() - t0
    await sleep(1200)
    const pipState = await dumpInteractive(cdp)
    note('D-to-pip', 'after collapse', { transitionMs: pipMs, view: pipState.view, viewport: pipState.viewport, buttons: pipState.buttons })
    await cdp.shot('D01-pip')

    // PiP에서 두 orb 겹침 측정
    const pipOrbHit = await hitProbe(cdp, '.pip-presence-orb-trigger')
    const coreHitPip = await hitProbe(cdp, '.core-trigger')
    probe('D-pip-orb-hit', pipOrbHit)
    probe('D-core-orb-hit-in-pip', coreHitPip)

    // PiP → Main 복귀
    const t1 = Date.now()
    await cdp.realClick("document.querySelector('.pip-presence-orb-trigger')", 'PiP orb')
    await cdp.waitFor("document.querySelector('.command-center-interface')", 'Command Center 복귀', 10000)
    const backMs = Date.now() - t1
    await sleep(1000)
    note('D-to-main', 'after expand', { transitionMs: backMs, view: (await dumpInteractive(cdp)).view })
    await cdp.shot('D02-back-to-main')

    // Escape 계층 확인: editor → drawer → pip
    const escState = await cdp.evalJs(`
      return {
        editorOpen: Boolean(document.querySelector('.workspace-file-editor')),
        drawerOpen: document.querySelector('.jarvis-shell')?.dataset?.contextOpen,
      };
    `)
    probe('D-escape-layers-before-esc', escState)
  } catch (err) {
    findings.fatal = String(err && err.message)
    console.error(`[AUDIT ERROR] ${err.message}`)
  } finally {
    if (cdp) { try { cdp.ws.close() } catch { /* */ } }
    for (const child of children) { try { child.kill() } catch { /* */ } }
    if (stub) stub.server.close()
    fs.mkdirSync(ARTIFACT_DIR, { recursive: true })
    fs.writeFileSync(FINDINGS_FILE, JSON.stringify(findings, null, 2))
    console.log(`\nfindings → ${FINDINGS_FILE}`)
  }
}

main()
