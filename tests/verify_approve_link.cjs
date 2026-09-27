/*
  UX 통합 검증 — 승인 화면의 '이 파일도 연결' 옵션.

  기존 흐름: 요청 → Approve → (done) 연결 카드 → Link file  (승인과 연결이 2단계)
  새 흐름:   요청 → 체크박스 + '승인하고 연결' → (done + 연결 완료)  (1단계)

    L1) 승인 화면에 '이 파일도 연결' 체크박스가 보인다(Active File + create_task 제안일 때).
    L2) 체크하면 승인 버튼이 '승인하고 연결'로 바뀐다.
    L3) 클릭 한 번으로 done 상태가 되고, 연결 완료 카드(.is-done)가 함께 나타난다.
    L4) canonical 상태(resource_links.json)에 링크가 실제로 기록된다.
    L5) 대조: 체크하지 않고 Approve하면 기존처럼 연결 카드(Link file)가 별도로 뜬다.

  실행: node tests/verify_approve_link.cjs
  실패 시 exit 1. 스크린샷은 tests/artifacts/approve-link/ 에 남는다.
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
const ARTIFACT_DIR = path.join(__dirname, 'artifacts', 'approve-link')

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

/*
  결정적 stub — 모든 일반 요청에 create_task 제안으로 응답한다.
  도구 실행 결과가 오면 최종 응답으로 전환한다(기존 verify 스크립트와 동일).
*/
function startStubModel() {
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      let payload = {}
      try { payload = JSON.parse(body || '{}') } catch { payload = {} }
      const messages = Array.isArray(payload.messages) ? payload.messages : []
      const hasToolResult = messages.some((m) => m && m.role === 'tool')
      let message
      if (hasToolResult) {
        message = { role: 'assistant', content: '작업을 만들었습니다.' }
      } else {
        message = {
          role: 'assistant',
          content: '',
          tool_calls: [{
            function: {
              name: 'create_task',
              arguments: { project_id: 'jarvis-app', title: '승인연결 검증 작업', reason: 'approve-link verify' },
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
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
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
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis_approve_link_'))
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
      HARNESS_MODEL: 'approve-link-stub',
    }, 'electron')

    cdp = await Cdp.attach(cdpPort)
    await cdp.waitFor("document.readyState === 'complete' && document.body.innerText.trim().length > 0", '첫 렌더', 90000)
    await sleep(800)

    // 공통: drawer에서 시드 파일 열기 → Active File 세팅
    step('준비) 파일 열기 → 요청 → 승인 화면까지')
    await cdp.realClick("document.querySelector('.jarvis-context-button')", 'Context 토글')
    await cdp.waitFor("document.querySelector('.v4-context-drawer')", 'drawer 등장', 10000)
    await sleep(800)
    const fileRow = `Array.from(document.querySelectorAll('.tree-prototype-map-row')).find((row) => (row.innerText || '').includes(${JSON.stringify(fixture.file_name)}))?.querySelector('.tree-prototype-map-label')`
    await cdp.realClick(fileRow, `파일 행 ${fixture.file_name}`)
    await sleep(1200)
    await cdp.typeInto("document.querySelector('.jarvis-command-input')", '지금 보고 있는 파일로 작업 하나 만들어줘.')
    await cdp.realClick("document.querySelector('.jarvis-command-send')", '보내기')
    await cdp.waitFor("document.querySelector('.jarvis-approve-button') && !document.querySelector('.jarvis-approve-button').disabled", 'Approve 노출', 90000)
    await sleep(400)

    // --- L1: 체크박스 존재 ---
    step("L1) 승인 화면에 '이 파일도 연결' 옵션")
    const optionInfo = await cdp.evalJs(`
      const label = document.querySelector('.jarvis-permission-link-option');
      if (!label) return { exists: false };
      const r = label.getBoundingClientRect();
      return { exists: true, text: label.innerText.replace(/\\s+/g, ' ').slice(0, 120), fileName: label.innerText.includes('experiment-notes') };
    `)
    console.log(`  option: ${JSON.stringify(optionInfo)}`)
    if (!optionInfo.exists) fail('연결 옵션이 승인 화면에 없음 — Active File을 인식하지 못함')
    if (!optionInfo.fileName) fail(`옵션에 파일 이름이 없음: ${optionInfo.text}`)
    await cdp.shot('L01-permission-with-link-option')

    // --- L2: 체크 → 버튼 라벨 변경 ---
    step("L2) 체크 → '승인하고 연결'로 버튼 변경")
    await cdp.realClick("document.querySelector('.jarvis-permission-link-option input')", '연결 옵션 체크')
    // Under load the React re-render can land after a fixed delay, so wait for the state
    // change instead of assuming it. A fixed sleep made this assertion flake.
    await cdp.waitFor("document.querySelector('.jarvis-permission-link-option input')?.checked === true", '연결 옵션 체크 상태 반영', 8000)
    const linkToggle = await cdp.evalJs(`
      const input = document.querySelector('.jarvis-permission-link-option input');
      const rect = input?.getBoundingClientRect();
      const hit = rect && document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      const label = document.querySelector('.jarvis-permission-link-option');
      const labelRect = label?.getBoundingClientRect();
      return {
        checked: input?.checked,
        hitInput: Boolean(input && hit && (hit === input || input.contains(hit))),
        hitTarget: hit ? hit.tagName + '.' + String(hit.className).split(' ').join('.') : null,
        rect: rect && [rect.left, rect.top, rect.width, rect.height],
      };
    `)
    console.log(`  link checkbox after click: ${JSON.stringify(linkToggle)}`)
    const approveLabel = await cdp.evalJs("return document.querySelector('.jarvis-approve-button')?.innerText.trim()")
    if (!linkToggle.checked || !linkToggle.hitInput) fail(`연결 옵션 클릭이 실제 상태를 변경하지 못함: ${JSON.stringify(linkToggle)}`)
    console.log(`  approve label: ${approveLabel}`)
    if (approveLabel !== '승인하고 연결') fail(`버튼 라벨이 바뀌지 않음: ${approveLabel}`)
    await cdp.shot('L02-checked')

    // --- L3: 한 번의 클릭 → done + 연결 완료 ---
    step('L3) 승인하고 연결 → done + 연결 완료 카드 동시 도달')
    await cdp.realClick("document.querySelector('.jarvis-approve-button')", '승인하고 연결')
    await cdp.waitFor("document.querySelector('.jarvis-runtime-panel.is-done')", 'done 상태', 90000)
    await cdp.waitFor("document.querySelector('.jarvis-link-affordance.is-done')", '연결 완료 카드', 20000)
    const doneText = await cdp.evalJs("return document.querySelector('.jarvis-link-affordance.is-done')?.innerText.replace(/\\s+/g, ' ').slice(0, 160)")
    console.log(`  완료 카드: ${doneText}`)
    if (!doneText || !doneText.includes('연결했습니다')) fail(`연결 완료 문구 없음: ${doneText}`)
    await cdp.shot('L03-approved-and-linked')

    // --- L4: canonical 상태에 링크 기록 확인 ---
    step('L4) canonical resource_links 기록 확인')
    const linksPath = path.join(stateDir, 'resource_links.json')
    if (!fs.existsSync(linksPath)) fail('resource_links.json이 생성되지 않음')
    const links = JSON.parse(fs.readFileSync(linksPath, 'utf8'))
    const linkCount = Array.isArray(links) ? links.length : (links.links?.length ?? 0)
    console.log(`  링크 수: ${linkCount}`)
    if (linkCount < 1) fail('canonical 링크가 기록되지 않음')
    console.log('  PASS — 승인 한 번으로 task 생성 + 파일 연결이 모두 기록됨')

    // --- L5: 대조 — 체크 없이 Approve하면 기존 2단계 흐름 ---
    step('L5) 대조 — 체크 없이 Approve → 연결 카드가 별도로 노출')
    await cdp.realClick("document.querySelector('.jarvis-mini-dismiss')", 'Dismiss')
    await sleep(400)
    await cdp.typeInto("document.querySelector('.jarvis-command-input')", '파일로 작업 하나 더 만들어줘.')
    await cdp.realClick("document.querySelector('.jarvis-command-send')", '보내기')
    await cdp.waitFor("document.querySelector('.jarvis-approve-button') && !document.querySelector('.jarvis-approve-button').disabled", 'Approve 노출', 90000)
    await sleep(400)
    await cdp.realClick("document.querySelector('.jarvis-approve-button')", 'Approve (체크 없음)')
    await cdp.waitFor("document.querySelector('.jarvis-runtime-panel.is-done')", 'done 상태', 90000)
    await cdp.waitFor("document.querySelector('.jarvis-link-affordance:not(.is-done) .jarvis-link-button')", '별도 연결 카드', 20000)
    const offerLabel = await cdp.evalJs("return document.querySelector('.jarvis-link-affordance:not(.is-done) .jarvis-link-button')?.innerText.trim()")
    console.log(`  별도 카드 버튼: ${offerLabel}`)
    if (offerLabel !== 'Link file') fail(`기존 연결 카드가 아님: ${offerLabel}`)
    await cdp.shot('L04-separate-link-card')
    console.log('  PASS — 체크하지 않으면 기존처럼 별도 연결 카드가 뜬다 (하위 호환)')

    console.log('\nAPPROVE-LINK VERIFIED — 승인 한 번으로 생성+연결이 실제 GUI에서 동작함.')
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
