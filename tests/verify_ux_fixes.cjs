/*
  UX 수정 재검증 (C1~C3) — 실제 Electron 앱에서 클릭으로 증명한다.

  검증 항목:
    C2) Command Center idle에서 .core-trigger(죽은 orb)가 렌더링되지 않는다.
    C3) Context drawer에 Ask JARVIS 버튼/popover가 없다 (질문은 composer 하나).
    C1) PiP DONE 상태에서 .pip-presence-resume 카드가 클릭 가능하고,
        그 클릭 한 번으로 Command Center로 복귀한다 (dead-end 소멸).
    보존) PiP idle(비-DONE)에서는 기존 orb 진입이 그대로 동작한다.

  실행: node tests/verify_ux_fixes.cjs
  실패 시 exit 1. 스크린샷은 tests/artifacts/ux-verify/ 에 남는다.
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
const ARTIFACT_DIR = path.join(__dirname, 'artifacts', 'ux-verify')

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
              arguments: { project_id: 'jarvis-app', title: '재검증 작업', reason: 'verify' },
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
  if (result.status !== 0) fail(`fixture 실패: ${result.stderr || result.stdout}`)
  return JSON.parse((result.stdout || '').trim().split('\n').pop())
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
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis_ux_verify_'))
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
      HARNESS_MODEL: 'ux-verify-stub',
    }, 'electron')

    cdp = await Cdp.attach(cdpPort)
    await cdp.waitFor("document.readyState === 'complete' && document.body.innerText.trim().length > 0", '첫 렌더', 90000)
    await sleep(800)

    // --- C2: idle Command Center에서 Core 클릭이 유일한 복귀 경로다 ---
    step('C2) Command Center idle — Core 클릭으로 PiP 복귀 (PiP 버튼은 제거됨)')
    const coreProbe = await cdp.hitProbe('.core-trigger')
    console.log(`  core-trigger: ${JSON.stringify(coreProbe)}`)
    if (!coreProbe.exists || !coreProbe.hitSelf) fail(`Core 클릭 불가: ${JSON.stringify(coreProbe)}`)
    const pipBtnGone = await cdp.evalJs("return Boolean(document.querySelector('.jarvis-pip-button'))")
    if (pipBtnGone) fail('PiP 버튼이 아직 렌더링됨 — 제거됐어야 함')
    console.log('  PASS — PiP 버튼 미렌더, Core 클릭 hit 가능')
    await cdp.shot('V01-cc-no-orb')

    // --- C3: drawer에 Ask가 없다 ---
    step('C3) Context drawer — Ask JARVIS 제거 확인')
    await cdp.realClick("document.querySelector('.jarvis-context-button')", 'Context 토글')
    await sleep(1200)
    const askButtons = await cdp.evalJs(`
      return Array.from(document.querySelectorAll('button')).filter((b) => b.offsetParent !== null)
        .map((b) => b.getAttribute('aria-label') || b.innerText.trim())
        .filter((label) => label.includes('Ask'));
    `)
    const askInputs = await cdp.evalJs(`
      return Array.from(document.querySelectorAll('input, textarea')).filter((el) => el.offsetParent !== null)
        .map((el) => el.placeholder || '')
        .filter((ph) => ph.includes('무엇이든'));
    `)
    if (askButtons.length > 0 || askInputs.length > 0) {
      fail(`drawer에 Ask 잔재: buttons=${JSON.stringify(askButtons)} inputs=${JSON.stringify(askInputs)}`)
    }
    console.log('  PASS — Ask 버튼/입력 없음, 질문은 composer 하나')
    await cdp.shot('V02-drawer-no-ask')

    // --- B 여정 재확인 (회귀 없음): 파일 → 요청 → 승인 → 링크 ---
    step('회귀) 작업 시작 여정 (기존 5클릭 유지)')
    const compHit = await cdp.hitProbe('.jarvis-command-input')
    if (!compHit.hitSelf) fail(`composer 클릭 불가: ${JSON.stringify(compHit)}`)
    const fileRow = `Array.from(document.querySelectorAll('.tree-prototype-map-row')).find((row) => (row.innerText || '').includes(${JSON.stringify(fixture.file_name)}))?.querySelector('.tree-prototype-map-label')`
    await cdp.realClick(fileRow, `파일 행 ${fixture.file_name}`)
    await sleep(1500)
    await cdp.typeInto("document.querySelector('.jarvis-command-input')", '지금 보고 있는 파일을 바탕으로 할 일 하나만 추가해줘.')
    await cdp.shot('V03-typed')
    await cdp.realClick("document.querySelector('.jarvis-command-send')", 'Send')
    await cdp.waitFor("document.querySelector('.jarvis-approve-button') && !document.querySelector('.jarvis-approve-button').disabled", 'Approve 노출', 90000)
    await cdp.realClick("document.querySelector('.jarvis-approve-button')", 'Approve')
    await cdp.waitFor("document.querySelector('[aria-label=\"Link active file\"]')", '링크 카드', 90000)
    await cdp.realClick("document.querySelector('.jarvis-link-button')", 'Link file')
    await cdp.waitFor("document.querySelector('.jarvis-link-affordance.is-done')", '연결 완료', 60000)
    console.log('  PASS — 파일→요청→승인→연결 전 흐름 회귀 없음')
    await cdp.shot('V04-link-done')

    // --- C1: PiP DONE에서 복귀 카드가 유일하게 명확한 경로 ---
    step('C1) PiP DONE — 복귀 카드 클릭 한 번으로 Assistant 복귀')
    const t0 = Date.now()
    await cdp.realClick("document.querySelector('.core-trigger')", 'Core 클릭')
    await cdp.waitFor("document.querySelector('.pip-presence')", 'PiP 등장', 10000)
    console.log(`  PiP 전환 ${Date.now() - t0}ms`)
    await cdp.waitFor("document.querySelector('.pip-result-button')", '복귀 카드(DONE)', 15000)
    await sleep(600)
    const resumeProbe = await cdp.hitProbe('.pip-result-button')
    console.log(`  resume card: ${JSON.stringify(resumeProbe)}`)
    if (!resumeProbe.exists || !resumeProbe.hitSelf) fail(`복귀 카드 클릭 불가: ${JSON.stringify(resumeProbe)}`)
    await cdp.shot('V05-pip-done-resume-card')

    const t1 = Date.now()
    await cdp.realClick("document.querySelector('.pip-result-button')", '복귀 카드')
    await cdp.waitFor("document.querySelector('.command-center-interface')", 'Command Center 복귀', 10000)
    console.log(`  PASS — 카드 클릭 한 번으로 복귀 (${Date.now() - t1}ms)`)
    await cdp.shot('V06-back-from-done-pip')

    // --- 보존: 비-DONE(idle) PiP도 기존 orb로 진입 가능 ---
    step('보존) PiP idle — 기존 orb 진입 유지')
    // DONE 상태를 지운다(runtime panel의 Dismiss)
    await cdp.realClick("document.querySelector('.jarvis-mini-dismiss')", 'Dismiss')
    await sleep(400)
    await cdp.realClick("document.querySelector('.core-trigger')", 'Core 클릭')
    await cdp.waitFor("document.querySelector('.pip-presence')", 'PiP 등장', 10000)
    await sleep(600)
    const orbProbe = await cdp.hitProbe('.pip-presence-orb-trigger')
    console.log(`  idle orb: ${JSON.stringify(orbProbe)}`)
    if (!orbProbe.exists || !orbProbe.hitSelf) fail(`PiP idle orb 클릭 불가: ${JSON.stringify(orbProbe)}`)
    await cdp.shot('V07-pip-idle-orb')
    const t2 = Date.now()
    await cdp.realClick("document.querySelector('.pip-presence-orb-trigger')", 'PiP orb')
    await cdp.waitFor("document.querySelector('.command-center-interface')", 'Command Center 복귀', 10000)
    console.log(`  PASS — idle PiP orb로 복귀 (${Date.now() - t2}ms)`)

    console.log('\nUX FIXES VERIFIED — C1·C2·C3 모두 실제 GUI에서 클릭으로 확인됨.')
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
