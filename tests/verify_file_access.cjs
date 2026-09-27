/*
  FILE ACCESS 확장 검증 — 실제 Electron에서 클릭으로 증명한다.

    F1) FILES 섹션의 '새 파일…' → 이름 입력 → 만들기 → 목록 반영 + 편집기 열림
    F2) 생성된 파일이 실제 디스크에 존재한다
    F3) 모델이 create_file을 제안하면 승인 카드가 뜨고, 승인하면 실제 파일이 만들어진다
    F4) 덮어쓰기 거부 — 같은 이름 재생성은 실패한다
    F5) 민감 파일(.env) 생성은 차단된다

  실행: node tests/verify_file_access.cjs
  실패 시 exit 1. 스크린샷은 tests/artifacts/file-access/ 에 남는다.
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
const ARTIFACT_DIR = path.join(__dirname, 'artifacts', 'file-access')

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

/* 일반 요청 → create_file 제안, 도구 결과 → 최종 응답 */
function startStubModel() {
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      let payload = {}
      try { payload = JSON.parse(body || '{}') } catch { payload = {} }
      const messages = Array.isArray(payload.messages) ? payload.messages : []
      const hasToolResult = messages.some((m) => m && m.role === 'tool')
      const lastUser = [...messages].reverse().find((m) => m && m.role === 'user')
      const text = (lastUser && lastUser.content) || ''
      let message
      if (hasToolResult) {
        message = { role: 'assistant', content: '파일을 만들었습니다.' }
      } else if (text.includes('기록해줘')) {
        message = {
          role: 'assistant',
          content: '',
          tool_calls: [{
            function: {
              name: 'create_file',
              arguments: { path: 'model-made.md', content: '모델이 승인으로 만든 파일' },
            },
          }],
        }
      } else {
        message = { role: 'assistant', content: '무엇을 도와드릴까요?' }
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
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis_file_access_'))
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
      child.stderr.on('data', (c) => { const t = String(c).trim(); console.log(`[${label}!] ${t.slice(0, 160)}`) })
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
      HARNESS_MODEL: 'file-access-stub',
    }, 'electron')

    cdp = await Cdp.attach(cdpPort)
    cdp.ws.addEventListener("message", (ev) => {
      try {
        const msg = JSON.parse(ev.data)
        if (msg.method === "Runtime.consoleAPICalled" && (msg.params.type === "error" || msg.params.type === "warning")) {
          const text = (msg.params.args || []).map((a) => a.value || a.description || "").join(" ")
          console.log(`  [renderer-${msg.params.type}] ${text.slice(0, 200)}`)
        }
        if (msg.method === "Runtime.exceptionThrown") {
          console.log(`  [renderer-exception] ${JSON.stringify(msg.params.exceptionDetails).slice(0, 250)}`)
        }
      } catch { /* */ }
    })
    await cdp.waitFor("document.readyState === 'complete' && document.body.innerText.trim().length > 0", '첫 렌더', 90000)
    await sleep(800)

    // drawer 열기
    await cdp.realClick("document.querySelector('.jarvis-context-button')", 'Context 토글')
    await cdp.waitFor("document.querySelector('.v4-context-drawer')", 'drawer 등장', 10000)
    await sleep(800)

    // --- F1: UI 새 파일 생성 ---
    step("F1) '새 파일…' → 이름 입력 → 만들기 → 목록 반영 + 편집기")
    await cdp.realClick("document.querySelector('[aria-label=\"Create new file\"]')", '새 파일 버튼')
    await cdp.waitFor("document.querySelector('.tree-prototype-new-file input')", '새 파일 폼', 5000)
    await cdp.typeInto("document.querySelector('.tree-prototype-new-file input')", 'ui-created.md')
    await cdp.shot('F01-new-file-form')
    await cdp.realClick("Array.from(document.querySelectorAll('.tree-prototype-new-file button')).find((b) => b.textContent.trim() === '만들기')", '만들기')
    await cdp.waitFor(
      "Array.from(document.querySelectorAll('.tree-prototype-map-row')).some((row) => (row.innerText || '').includes('ui-created.md'))",
      '목록에 ui-created.md 반영',
      15000,
    )
    await cdp.waitFor("document.querySelector('.workspace-file-editor')", '편집기 열림', 10000)
    const editorLabel = await cdp.evalJs("return document.querySelector('.workspace-file-editor-header strong')?.innerText")
    console.log(`  editor: ${editorLabel}`)
    if (!editorLabel || !editorLabel.includes('ui-created.md')) fail(`생성한 파일이 편집기로 열리지 않음: ${editorLabel}`)
    await cdp.shot('F02-created-and-open')

    // --- F2: 디스크 존재 ---
    step('F2) 실제 디스크에 파일 존재')
    const createdPath = path.join(workspaceDir, 'ui-created.md')
    if (!fs.existsSync(createdPath)) fail('ui-created.md가 디스크에 없음')
    const content = fs.readFileSync(createdPath, 'utf8')
    console.log(`  disk: ${createdPath} (${content.length} bytes)`)
    console.log('  PASS — UI 생성 파일이 실제로 기록됨')

    // --- F3: 모델 create_file 승인 흐름 ---
    step('F3) 모델 create_file 제안 → 승인 → 실제 생성')
    // editor(body 포털)가 composer를 가릴 수 있으니 먼저 닫는다
    const editorOpen = await cdp.evalJs("return Boolean(document.querySelector('.workspace-file-editor'))")
    if (editorOpen) {
      await cdp.realClick("document.querySelector('[aria-label=\"Close file editor\"]')", 'editor 닫기')
      await sleep(600)
    }
    await cdp.typeInto("document.querySelector('.jarvis-command-input')", '노트 파일에 기록해줘')
    const composerState = await cdp.evalJs(`
      const input = document.querySelector('.jarvis-command-input');
      const send = document.querySelector('.jarvis-command-send');
      const r = input && input.getBoundingClientRect();
      const hit = r ? document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) : null;
      return { value: input && input.value, sendDisabled: send && send.disabled, composerHit: hit ? hit.tagName + ':' + String(hit.className).slice(0, 40) : 'none' };
    `)
    console.log(`  composer: ${JSON.stringify(composerState)}`)
    await cdp.realClick("document.querySelector('.jarvis-command-send')", '보내기')
    await cdp.waitFor("document.querySelector('.jarvis-approve-button') && !document.querySelector('.jarvis-approve-button').disabled", 'create_file 승인 카드', 90000)
    const permText = await cdp.evalJs("return document.querySelector('.jarvis-runtime-panel.is-permission')?.innerText.replace(/\\s+/g, ' ').slice(0, 200)")
    console.log(`  승인 카드: ${permText}`)
    if (!permText || !permText.includes('Create file')) fail(`create_file 승인 카드 아님: ${permText}`)
    await cdp.shot('F03-model-create-file-approval')
    await cdp.realClick("document.querySelector('.jarvis-approve-button')", 'Approve')
    await cdp.waitFor("document.querySelector('.jarvis-runtime-panel.is-done')", 'done', 90000)
    const modelPath = path.join(workspaceDir, 'model-made.md')
    if (!fs.existsSync(modelPath)) fail('모델 승인으로 model-made.md가 생성되지 않음')
    const modelContent = fs.readFileSync(modelPath, 'utf8')
    if (!modelContent.includes('모델이')) fail(`생성 내용 다름: ${modelContent}`)
    console.log('  PASS — 승인 한 번으로 모델이 파일을 실제로 생성함')
    await cdp.shot('F04-model-file-created')

    // --- F4: 덮어쓰기 거부 ---
    step('F4) 같은 이름 재생성은 거부된다')
    await cdp.realClick("document.querySelector('[aria-label=\"Create new file\"]')", '새 파일 버튼')
    await cdp.waitFor("document.querySelector('.tree-prototype-new-file input')", '새 파일 폼', 5000)
    await cdp.typeInto("document.querySelector('.tree-prototype-new-file input')", 'ui-created.md')
    await cdp.realClick("Array.from(document.querySelectorAll('.tree-prototype-new-file button')).find((b) => b.textContent.trim() === '만들기')", '만들기')
    await cdp.waitFor("document.querySelector('.tree-prototype-new-file .tree-prototype-add-error')", '거부 오류', 10000)
    const dupError = await cdp.evalJs("return document.querySelector('.tree-prototype-new-file .tree-prototype-add-error')?.innerText")
    console.log(`  오류: ${dupError}`)
    if (!dupError || !dupError.includes('이미 존재')) fail(`덮어쓰기가 거부되지 않음: ${dupError}`)
    await cdp.shot('F05-duplicate-rejected')
    console.log('  PASS — 기존 파일 보호')

    // --- F5: 민감 파일 차단 ---
    step('F5) 민감 파일(.env) 생성 차단')
    // typeInto는 append하므로 기존 값을 먼저 비운다
    await cdp.evalJs(`
      const input = document.querySelector('.tree-prototype-new-file input');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, '');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    `);
    await sleep(200)
    await cdp.typeInto("document.querySelector('.tree-prototype-new-file input')", '.env')
    await cdp.realClick("Array.from(document.querySelectorAll('.tree-prototype-new-file button')).find((b) => b.textContent.trim() === '만들기')", '만들기')
    await cdp.waitFor("document.querySelector('.tree-prototype-new-file .tree-prototype-add-error')", '차단 오류', 10000)
    const envError = await cdp.evalJs("return document.querySelector('.tree-prototype-new-file .tree-prototype-add-error')?.innerText")
    console.log(`  오류: ${envError}`)
    if (!envError || !envError.includes('민감')) fail(`민감 파일이 차단되지 않음: ${envError}`)
    await cdp.shot('F06-sensitive-blocked')
    console.log('  PASS — 민감 파일 생성 차단')

    console.log('\nFILE ACCESS VERIFIED — 읽기 확장·새 파일 생성(모델+UI)이 실제 GUI에서 동작함.')
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
