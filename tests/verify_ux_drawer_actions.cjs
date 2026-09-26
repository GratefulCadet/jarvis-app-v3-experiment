/*
  UX 레이아웃 재정리 검증 — drawer 헤더 액션행 + Add popover.

  dock 제거 후 drawer 헤더의 3개 액션(+ / ⚙ 설정 / 🗑 삭제)과
  + 가 여는 Add Task popover가 실제로 동작하는지 클릭으로 증명한다.

    H1) drawer 헤더 액션 3개가 렌더되고 클릭 가능하다.
    H2) 루트에서는 삭제 버튼이 disabled다(가드).
    H3) + 클릭 → Add popover(NEW TASK 폼)가 열리고 닫힌다.
    H4) 작업 노드에서 + → 제목 입력 → ADD → drawer 목록에 새 작업이 보인다.
    H5) ⚙ 설정 다이얼로그가 열리고 닫힌다.
    H6) 작업 노드에서 🗑 → Delete 확인 다이얼로그가 열린다(누르지 않는다).

  실행: node tests/verify_ux_drawer_actions.cjs
  실패 시 exit 1. 스크린샷은 tests/artifacts/ux-drawer-actions/ 에 남는다.
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
const ARTIFACT_DIR = path.join(__dirname, 'artifacts', 'ux-drawer-actions')
const SEEDED_TASK = '브리핑 검증용 작업'
const NEW_TASK_TITLE = '헤더 액션 검증 작업'

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
      const message = { role: 'assistant', content: '요청을 처리했습니다.' }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ model: 'stub', message, done: true }))
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
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis_drawer_verify_'))
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
      HARNESS_MODEL: 'drawer-verify-stub',
    }, 'electron')

    cdp = await Cdp.attach(cdpPort)
    await cdp.waitFor("document.readyState === 'complete' && document.body.innerText.trim().length > 0", '첫 렌더', 90000)
    await sleep(800)

    // --- H1: drawer 헤더 액션 3개 ---
    step('H1) drawer 헤더 액션행 (+ / ⚙ / 🗑) 렌더 + 클릭 가능')
    await cdp.realClick("document.querySelector('.jarvis-context-button')", 'Context 토글')
    await cdp.waitFor("document.querySelector('.v4-context-drawer')", 'drawer 등장', 10000)
    await sleep(600)
    const header = await cdp.evalJs(`
      const btns = Array.from(document.querySelectorAll('.v4-context-drawer .tree-prototype-header-btn'));
      return btns.map((b) => ({ label: b.getAttribute('aria-label'), disabled: b.disabled }));
    `)
    console.log(`  헤더 버튼: ${JSON.stringify(header)}`)
    if (header.length !== 3) fail(`헤더 액션 3개여야 함: ${JSON.stringify(header)}`)
    if (header[0].label !== 'Add task under current selection') fail(`+ 라벨 다름: ${header[0].label}`)
    if (header[1].label !== 'Workspace settings') fail(`⚙ 라벨 다름: ${header[1].label}`)
    if (header[2].label !== 'Delete current node') fail(`🗑 라벨 다름: ${header[2].label}`)

    // --- H2: 루트에서 삭제 가드 ---
    step('H2) 루트에서는 삭제 버튼이 disabled')
    if (!header[2].disabled) fail('루트인데 삭제 버튼이 활성화됨 — 가드 없음')
    console.log('  PASS — 루트 삭제 버튼 disabled (가드 동작)')

    for (const [index, label] of header.map((h, i) => [i, h.label])) {
      const probe = await cdp.evalJs(`
        const b = document.querySelectorAll('.v4-context-drawer .tree-prototype-header-btn')[${index}];
        if (b.disabled) return true;
        const r = b.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return Boolean(hit && (hit === b || b.contains(hit)));
      `)
      if (!probe) fail(`헤더 버튼 클릭 불가: ${label}`)
    }
    console.log('  PASS — 활성 버튼 2개 모두 hit 가능')
    await cdp.shot('H01-drawer-header-actions')

    // --- H3: + 클릭 → Add popover ---
    step('H3) + 클릭 → Add popover 열림/닫힘')
    await cdp.realClick("document.querySelector('.v4-context-drawer .tree-prototype-header-btn')", '+ 버튼')
    await cdp.waitFor("document.querySelector('.v4-context-drawer .tree-prototype-add-form')", 'Add popover', 5000)
    await sleep(400)
    const addProbe = await cdp.hitProbe('.v4-context-drawer .tree-prototype-add-form')
    console.log(`  add form: ${JSON.stringify(addProbe)}`)
    if (!addProbe.hitSelf) fail(`Add popover 클릭 불가: ${JSON.stringify(addProbe)}`)
    await cdp.shot('H02-add-popover-open')
    await cdp.realClick("Array.from(document.querySelectorAll('.v4-context-drawer .tree-prototype-add-form button')).find((b) => b.textContent.trim() === 'CANCEL')", 'CANCEL')
    await cdp.waitFor("!document.querySelector('.v4-context-drawer .tree-prototype-add-form')", 'Add popover 닫힘', 5000)
    console.log('  PASS — popover 열림/닫힘')

    // --- H4: 작업 노드에서 Add Task 흐름 ---
    step('H4) 작업 노드 + → 제목 입력 → ADD → 목록 반영')
    // 초기엔 루트+최상위만 펼쳐져 있으므로, 보이는 Expand 쉐브론을 모두 펼친다.
    for (let round = 0; round < 3; round += 1) {
      const expandCount = await cdp.evalJs(`
        const chevrons = Array.from(document.querySelectorAll('.v4-context-drawer .tree-prototype-map-chevron[aria-label^="Expand "]'));
        chevrons.forEach((c) => c.click());
        return chevrons.length;
      `)
      if (!expandCount) break
      await sleep(500)
    }
    const taskRow = `Array.from(document.querySelectorAll('.v4-context-drawer .tree-prototype-map-row')).find((row) => (row.innerText || '').includes(${JSON.stringify(SEEDED_TASK)}))?.querySelector('.tree-prototype-map-label')`
    const drawerRows = await cdp.evalJs(`
      return Array.from(document.querySelectorAll('.v4-context-drawer .tree-prototype-map-row')).map((row) => row.innerText.replace(/\\s+/g, ' ').slice(0, 60));
    `)
    console.log(`  drawer rows: ${JSON.stringify(drawerRows)}`)
    await cdp.realClick(taskRow, `작업 행 ${SEEDED_TASK}`)
    await sleep(900)
    await cdp.realClick("document.querySelector('.v4-context-drawer .tree-prototype-header-btn')", '+ 버튼')
    await cdp.waitFor("document.querySelector('.v4-context-drawer .tree-prototype-add-form')", 'Add popover', 5000)
    await cdp.typeInto("document.querySelector('.v4-context-drawer .tree-prototype-add-form input[aria-label=\"New task title\"]')", NEW_TASK_TITLE)
    await cdp.typeInto("document.querySelector('.v4-context-drawer .tree-prototype-add-form textarea[aria-label=\"New task description\"]')", 'verify_ux_drawer_actions 자동 생성')
    await cdp.shot('H03-add-popover-filled')
    await cdp.realClick("Array.from(document.querySelectorAll('.v4-context-drawer .tree-prototype-add-form button')).find((b) => b.textContent.trim() === 'ADD')", 'ADD')
    const appeared = await cdp.waitFor(
      `Array.from(document.querySelectorAll('.v4-context-drawer .tree-prototype-map-row')).some((row) => (row.innerText || '').includes(${JSON.stringify(NEW_TASK_TITLE)}))`,
      `새 작업 "${NEW_TASK_TITLE}" 목록 반영`,
      15000,
    )
    if (!appeared) fail('새 작업이 drawer 목록에 나타나지 않음')
    console.log(`  PASS — "${NEW_TASK_TITLE}" drawer 목록 반영`)
    await cdp.shot('H04-task-added')

    // --- H5: ⚙ 설정 다이얼로그 ---
    step('H5) ⚙ 클릭 → Workspace 설정 다이얼로그')
    await cdp.realClick(`Array.from(document.querySelectorAll('.v4-context-drawer .tree-prototype-header-btn'))[1]`, '⚙ 버튼')
    await cdp.waitFor("document.querySelector('.v4-context-drawer .tree-prototype-settings-list, .v4-context-drawer .tree-prototype-overview-empty')", '설정 다이얼로그', 5000)
    await sleep(400)
    await cdp.shot('H05-settings-open')
    await cdp.realClick("document.querySelector('.v4-context-drawer [aria-label=\"Close settings\"]')", 'Close settings')
    await sleep(400)
    console.log('  PASS — 설정 열림/닫힘')

    // --- H6: 🗑 삭제 확인 다이얼로그 ---
    step('H6) 작업 노드 🗑 → Delete 확인 다이얼로그 (실행은 안 함)')
    await cdp.realClick(`Array.from(document.querySelectorAll('.v4-context-drawer .tree-prototype-header-btn'))[2]`, '🗑 버튼')
    await cdp.waitFor("document.querySelector('.v4-context-drawer .tree-prototype-dialog')", 'Delete 다이얼로그', 5000)
    const dialogText = await cdp.evalJs("return document.querySelector('.v4-context-drawer .tree-prototype-dialog')?.innerText.replace(/\\s+/g, ' ').slice(0, 160)")
    console.log(`  dialog: ${dialogText}`)
    if (!dialogText || !dialogText.toLowerCase().includes('delete node')) fail(`Delete 다이얼로그 아님: ${dialogText}`)
    await cdp.shot('H06-delete-dialog')
    await cdp.realClick("Array.from(document.querySelectorAll('.v4-context-drawer .tree-prototype-dialog-actions button')).find((b) => b.textContent.trim() === 'CANCEL')", 'CANCEL')
    await cdp.waitFor("!document.querySelector('.v4-context-drawer .tree-prototype-dialog')", 'Delete 다이얼로그 닫힘', 5000)
    console.log('  PASS — 삭제 다이얼로그 열림/취소 (삭제 실행 없음)')

    console.log('\nDRAWER ACTIONS VERIFIED — 헤더 액션행 + Add popover가 실제 GUI에서 동작함.')
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
