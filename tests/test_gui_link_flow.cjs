/*
  GUI END-TO-END — 실제 앱에서 끝까지 눌러서 증명한다 (V4 §13-B).

  이 테스트가 증명하는 것:
    실제 Electron 앱 · 실제 React 렌더러 · 실제 IPC · 실제 Python bridge ·
    실제 canonical 상태 파일(resource_links.json) — 그리고 사용자가 실제로
    누르는 클릭으로 만든 링크.

  무엇을 stub으로 두는가 (그리고 왜):
    모델 응답만 정해준다. Milestone A/B의 모델 경로는 이미 실모델로 검증했으므로
    여기서는 결정론과 속도를 위해 HTTP 계층만 대체한다. 앱·IPC·bridge·상태
    저장은 전부 실제 코드 경로다. 또한 실모델 서버(기본 11434)를 건드리지
    않기 위해 HARNESS_BASE_URL로 격리 포트에 붙인다.

  실제 사용자 여정:
    1) 앱이 뜬다
    2) WORKSPACE/FILES에서 파일을 연다  → Active File
    3) "할 일 추가해줘"라고 보낸다
    4) 제안된 create_task를 Approve 한다
    5) 뜨는 연결 카드에서 "Link file"을 실제로 누른다
    6) canonical resource_links.json에 링크가 생겼는지 확인한다

  실행: node tests/test_gui_link_flow.cjs
  실패 시 exit 1. 스크린샷은 tests/artifacts/gui-link-flow/ 에 남는다.
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
const ARTIFACT_DIR = path.join(__dirname, 'artifacts', 'gui-link-flow')

const REQUEST_TEXT = '지금 보고 있는 파일을 바탕으로 할 일 하나만 추가해줘.'
const CREATED_TITLE = 'GUI E2E 링크 검증'

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

/** URL이 응답할 때까지 기다리고 본문을 돌려준다. 타임아웃이면 null. */
async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.ok) return await res.text()
    } catch {
      /* 아직 안 뜸 */
    }
    await sleep(250)
  }
  return null
}

/* ------------------------------------------------------------------ *
 * 1) Stub model — 실제 모델 서버 대신, 결정론적인 tool call을 돌려준다.
 *    "이미 tool 결과가 있으면 최종 문장, 없으면 create_task 제안"으로
 *    판정하므로 호출 횟수를 hardcode 하지 않는다.
 * ------------------------------------------------------------------ */
function startStubModel() {
  const state = { calls: 0, sawToolResult: false }
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => {
      body += c
    })
    req.on('end', () => {
      state.calls += 1
      let payload = {}
      try {
        payload = JSON.parse(body || '{}')
      } catch {
        payload = {}
      }
      const messages = Array.isArray(payload.messages) ? payload.messages : []
      const hasToolResult = messages.some((m) => m && m.role === 'tool')

      let message
      if (hasToolResult) {
        state.sawToolResult = true
        message = {
          role: 'assistant',
          content: `${CREATED_TITLE} 작업을 추가했습니다.`,
        }
      } else {
        message = {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              function: {
                name: 'create_task',
                arguments: {
                  project_id: 'jarvis-app',
                  title: CREATED_TITLE,
                  reason: 'GUI end-to-end 검증',
                },
              },
            },
          ],
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ model: payload.model, message, done: true }))
    })
  })
  return new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      console.log(`stub model: http://127.0.0.1:${port}/api/chat`)
      resolve({ server, port, state })
    })
  })
}

/* ------------------------------------------------------------------ *
 * 2) State fixture — 실제 registry 클래스로 canonical 상태를 만든다.
 * ------------------------------------------------------------------ */
function seedState(stateDir, workspaceDir) {
  const result = spawnSync(
    process.env.PYTHON || 'python',
    [
      '-m',
      'scripts.gui_e2e_fixture',
      '--state-dir',
      stateDir,
      '--workspace-dir',
      workspaceDir,
      '--project-id',
      'jarvis-app',
    ],
    { cwd: HARNESS_HOME, encoding: 'utf-8' },
  )
  if (result.status !== 0) {
    fail(`fixture 실패: ${result.stderr || result.stdout}`)
  }
  const line = (result.stdout || '').trim().split('\n').pop()
  return JSON.parse(line)
}

/* ------------------------------------------------------------------ *
 * 3) CDP client — 의존성 추가 없이 실제 창을 붙잡는다.
 * ------------------------------------------------------------------ */
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
          await new Promise((resolve, reject) => {
            ws.onopen = resolve
            ws.onerror = reject
          })
          const client = new Cdp(ws)
          await client.send('Runtime.enable')
          await client.send('Page.enable')
          await client.send('DOM.enable')
          return client
        }
      } catch {
        /* 아직 안 뜸 */
      }
      await sleep(300)
    }
    throw new Error('CDP attach 실패 — 창을 찾지 못했습니다')
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  async evalJs(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression: `(() => { ${expression} })()`,
      returnByValue: true,
      awaitPromise: true,
    })
    if (res.exceptionDetails) {
      throw new Error(`evaluate 실패: ${JSON.stringify(res.exceptionDetails)}`)
    }
    return res.result && res.result.value
  }

  /** 표현식이 true가 될 때까지 대기. */
  async waitFor(expression, description, timeoutMs = 60000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const ok = await this.evalJs(`return Boolean(${expression})`)
      if (ok) return true
      await sleep(300)
    }
    if (process.env.JARVIS_E2E_DEBUG_DOM) {
      await this.dumpDom(`timeout: ${description}`)
    }
    throw new Error(`대기 실패: ${description}`)
  }

  /**
   * 실제 입력 클릭. 표현식이 element를 반환하면 그 DOM에 마커를 붙이고
   * 좌표를 얻어 Input.dispatchMouseEvent로 진짜 마우스 이벤트를 보낸다.
   * (element.click()은 합성 이벤트이므로 "사용자가 눌렀다"의 증거가 약하다)
   */
  async realClick(findExpression, description) {
    // 좌표는 페이지가 직접 알려준다(DOM.getBoxModel은 re-render 사이에
    // 오래된 좌표를 돌려줄 수 있었다). client 좌표는 Input이 원하는
    // viewport 좌표와 같은 좌표계다.
    const point = await this.evalJs(`
      const el = ${findExpression};
      if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
    `)
    if (!point) throw new Error(`클릭 대상 없음: ${description}`)
    if (point.w === 0 || point.h === 0) {
      throw new Error(`클릭 대상 크기 0: ${description}`)
    }
    const { x, y } = point
    const hit = await this.evalJs(`
      const el = document.elementFromPoint(${x}, ${y});
      return el ? (el.tagName + '.' + String(el.className).slice(0, 40) + ' | ' + (el.innerText || '').trim().slice(0, 40)) : 'none';
    `)
    if (process.env.JARVIS_E2E_DEBUG_DOM) {
      console.log(`  [click] ${description} @ (${Math.round(x)}, ${Math.round(y)}) → ${hit}`)
    }
    await this.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1,
    })
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0,
    })
    return { x, y, hit }
  }

  /**
   * 입력 필드에 타이핑한다.
   *
   * 中央을 클릭하지 않는 이유: 장식용 orb(core-*-ring)가 입력창 중앙을
   * 덮고 있어 그 위의 클릭은 input이 아니라 ring이 받는다. 그래서 실제로
   * input이 hit되는 지점을 먼저 찾아 그곳을 클릭한다(사용자가 볼 수 있는
   * 좌표를 그대로 쓴다 — 추측으로 focus 하는 것이 아니다).
   */
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
    if (point.covered) {
      console.warn('  [warn] 입력 필드 전체가 다른 요소에 덮여 있음 — 클릭이 먹지 않을 수 있다')
    }
    await this.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1, buttons: 1,
    })
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1, buttons: 0,
    })
    await this.send('Input.insertText', { text })
    await sleep(300)
    const typed = await this.evalJs(`return (${findExpression}).value || ''`)
    if (!typed.includes(text.slice(0, 12))) {
      throw new Error(`입력 실패: "${typed}"`)
    }
    console.log('  입력 확인')
  }

  async shot(name) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' })
    const file = path.join(ARTIFACT_DIR, `${name}.png`)
    fs.mkdirSync(ARTIFACT_DIR, { recursive: true })
    fs.writeFileSync(file, Buffer.from(data, 'base64'))
    console.log(`  screenshot: ${file}`)
    return file
  }

  /** 실패 지점을 역추적하기 위한 DOM 정황 덤프. */
  async dumpDom(label) {
    const info = await this.evalJs(`
      const pick = (sel) => Array.from(document.querySelectorAll(sel));
      return {
        viewport: window.innerWidth + 'x' + window.innerHeight,
        bodyText: document.body.innerText.slice(0, 700),
        buttons: pick('button').map((b) => b.getAttribute('aria-label') || b.textContent.trim()).slice(0, 30),
        inputs: pick('textarea, input').map((i) => (i.getAttribute('placeholder') || i.tagName) + (i.offsetParent ? '' : ' [hidden]')),
        knowledge: pick('.tree-prototype-overview-knowledge').map((n) => n.innerText.slice(0, 120)),
        mapRows: pick('.tree-prototype-map-row').map((n) => n.innerText.trim().slice(0, 60)),
        contextPanel: pick('[class*="context-drawer"], [class*="context-panel"]').map((n) => n.className),
        pip: Boolean(document.querySelector('.pip-presence-open, .pip-presence-attention')),
        bridge: pick('[class*="status"]').map((n) => n.innerText.trim().slice(0, 40)).slice(0, 6),
      };
    `)
    console.log(`--- DOM DUMP [${label}] ---`)
    console.log(JSON.stringify(info, null, 2))
    return info
  }
}

/* ------------------------------------------------------------------ *
 * main
 * ------------------------------------------------------------------ */
async function main() {
  const children = []
  let stub = null
  let cdp = null

  const run = (cmd, args, env, label) => {
    const child = spawn(cmd, args, {
      cwd: APP_ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    child.stdout.on('data', (c) => {
      const t = String(c).trim()
      if (t && process.env.JARVIS_E2E_VERBOSE) console.log(`[${label}] ${t}`)
    })
    child.stderr.on('data', (c) => {
      const t = String(c).trim()
      if (t && process.env.JARVIS_E2E_VERBOSE) console.log(`[${label}!] ${t}`)
    })
    children.push(child)
    return child
  }

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis_gui_e2e_'))
  const stateDir = path.join(scratch, 'state')
  const workspaceDir = path.join(scratch, 'ws')
  console.log(`scratch: ${scratch}`)

  try {
    // --- 준비 ---
    step('환경 준비 (stub model + canonical state fixture)')
    stub = await startStubModel()
    const fixture = seedState(stateDir, workspaceDir)
    console.log(`  project=${fixture.project_id} root=${fixture.root_id} file=${fixture.file_name}`)

    const vitePort = await freePort()
    const cdpPort = await freePort()

    run(
      process.execPath,
      [path.join(APP_ROOT, 'node_modules', 'vite', 'bin', 'vite.js'),
       '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'],
      {},
      'vite',
    )

    /*
      vite dev 서버를 미리 예열한다.
      앱을 처음 띄우면 vite가 새 의존성(예: 추가된 아이콘 import)을 만나 dep 최적화를
      돌리고 그 때문에 페이지를 리로드한다 — 그 리로드가 Electron 첫 렌더를
      놓치게 만들면 "앱 첫 렌더" 대기에서 시간 초과로 죽는다. Electron을 띄우기 전에
      엔트리를 한 번 받아 최적화를 끝내 둔다.
    */
    const viteUrl = `http://127.0.0.1:${vitePort}/`
    const html = await waitForHttp(viteUrl, 30000)
    if (!html) fail('vite dev 서버가 뜨지 않음')
    const entryMatch = html.match(/src="([^"]+\.[jt]sx?)"/)
    if (entryMatch) {
      await waitForHttp(new URL(entryMatch[1], viteUrl).toString(), 30000)
    }
    console.log('vite 예열 완료 (dep 최적화 선행)')

    const electronPath = require('electron')
    const electron = run(
      electronPath,
      ['.', `--remote-debugging-port=${cdpPort}`],
      {
        // 실제 앱과 동일한 배선: canonical state만 격리하고, 모델 엔드포인트만
        // stub을 향한다. HARNESS_MEMORY_DIR 같은 우회로 쓰지 않는다 —
        // bridge가 JARVIS_STATE_DIR를 최우선으로 쓰는 그 경로 자체를 증명한다.
        JARVIS_STATE_DIR: stateDir,
        JARVIS_DEV_URL: `http://127.0.0.1:${vitePort}`,
        JARVIS_HARNESS_HOME: HARNESS_HOME,
        HARNESS_BASE_URL: `http://127.0.0.1:${stub.port}`,
        HARNESS_MODEL: 'gui-e2e-stub',
      },
      'electron',
    )

    cdp = await Cdp.attach(cdpPort)
    await cdp.waitFor(
      "document.readyState === 'complete' && document.body.innerText.trim().length > 0",
      '앱 첫 렌더',
      90000,
    )
    console.log('앱 준비 완료')

    // --- 1) Command Center로 ---
    step('1) Command Center 확인 (PiP면 확장)')
    const inPip = await cdp.evalJs(
      "return Boolean(document.querySelector('.pip-presence-open, .pip-presence-attention'))",
    )
    if (inPip) {
      await cdp.realClick(
        "document.querySelector('.pip-presence-open, .pip-presence-attention')",
        'PiP presence (확장)',
      )
      await sleep(1500)
    }
    await cdp.shot('01-command-center')
    const composerCount = await cdp.evalJs(
      "return document.querySelectorAll('textarea, input[type=\"text\"]').length",
    )
    console.log(`  composer 후보: ${composerCount}`)

    // --- 2) 파일을 Active File로 ---
    step('2) WORKSPACE/FILES에서 파일 열기 → Active File')
    const contextBtn = await cdp.evalJs(
      "return Boolean(document.querySelector('[aria-label=\"Toggle JARVIS context\"]'))",
    )
    if (contextBtn) {
      await cdp.realClick(
        "document.querySelector('[aria-label=\"Toggle JARVIS context\"]')",
        'Context 토글',
      )
      await sleep(1200)
    }
    await cdp.shot('02-context-open')
    if (process.env.JARVIS_E2E_DEBUG_DOM) await cdp.dumpDom('after-context-toggle')

    // 행 안의 첫 버튼은 chevron(자식이 없으면 disabled)이다. 실제로 파일을
    // 여는 것은 라벨 버튼(.tree-prototype-map-label)이다.
    const fileRow = `
      Array.from(document.querySelectorAll('.tree-prototype-map-row'))
        .find((row) => (row.innerText || '').includes(${JSON.stringify(fixture.file_name)}))
        ?.querySelector('.tree-prototype-map-label')
    `
    await cdp.realClick(fileRow, `파일 행 (${fixture.file_name})`)
    await sleep(1500)
    await cdp.shot('03-active-file-open')

    // 파일명 문자열은 FILES 목록에도 있으므로, 편집기가 실제로 열렸는지 본다.
    const editorOpen = await cdp.evalJs(
      `return Boolean(document.querySelector('.workspace-file-editor'))`,
    )
    if (!editorOpen) {
      const rows = await cdp.evalJs(
        "return Array.from(document.querySelectorAll('.tree-prototype-map-row')).map((r) => r.innerText.trim())",
      )
      fail(`Active File 편집기가 열리지 않음. mapRows=${JSON.stringify(rows)}`)
    }
    console.log('  Active File 열림 확인 (workspace-file-editor)')

    // --- 3) 요청 보내기 ---
    step('3) 요청 입력 → Send')
    // 회귄 방어: 장식 orb가 입력창 중앙을 덮으면 사용자는 캐럿을 놓을 수 없다.
    // "입력창 중앙이 실제로 그 입력창에 닿는가"를 이 테스트가 지킨다.
    const centerProbe = await cdp.evalJs(`
      const el = document.querySelector('.jarvis-command-input');
      if (!el) return { ok: false, cover: 'no-input' };
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      const box = (sel) => {
        const n = document.querySelector(sel);
        if (!n) return null;
        const b = n.getBoundingClientRect();
        return [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)].join(',');
      };
      return {
        ok: Boolean(hit && (hit === el || el.contains(hit))),
        cover: hit ? hit.tagName + '.' + String(hit.className).slice(0, 60) : 'none',
        viewport: window.innerWidth + 'x' + window.innerHeight,
        input: box('.jarvis-command-input'),
        form: box('.jarvis-command-form'),
        trigger: box('.core-trigger'),
        core: box('.core-container'),
      };
    `)
    if (!centerProbe.ok) {
      // orb와 composer가 같은 중심을 공유하는 레이아웃 회귀를 잡는다.
      // (.jarvis-command-form에 z-index를 준 이유가 이것이다)
      const message =
        `composer 중앙이 ${centerProbe.cover}에 덮여 있음 (입력창 중앙 클릭 불가)\n` +
        `    viewport=${centerProbe.viewport} input=[${centerProbe.input}] form=[${centerProbe.form}] ` +
        `trigger=[${centerProbe.trigger}] core=[${centerProbe.core}]`
      fail(message)
    }
    console.log('  composer 중앙 클릭 가능 확인')

    // 회귀 방어 (2): PiP로 돌아가는 길이 Command Center에 남아 있어야 한다.
    // orb(.core-trigger)은 중앙 컬럼 아래에 숨어 있어 composer 우선 시 클릭을
    // 받지 못한다 — 그래서 명시적 버튼(.jarvis-pip-button)이 그 자리를 대신한다.
    // 존재와 실제 hit 가능성만 확인한다(누르지는 않는다 — view가 바뀌므로).
    const pipReturn = await cdp.evalJs(`
      const btn = document.querySelector('.jarvis-pip-button');
      if (!btn) return { ok: false, why: 'no-button' };
      const r = btn.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return {
        ok: Boolean(hit && (hit === btn || btn.contains(hit))),
        label: btn.getAttribute('aria-label'),
        rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
      };
    `)
    if (!pipReturn.ok) {
      fail(
        `Command Center에서 PiP 복귀 버튼이 클릭 불가 (복귀 경로 소실): ${JSON.stringify(pipReturn)}`,
      )
    }
    console.log(`  PiP 복귀 버튼 확인: "${pipReturn.label}" @ [${pipReturn.rect}]`)
    const composer = `
      Array.from(document.querySelectorAll('textarea, input[type="text"]'))
        .find((el) => el.offsetParent !== null && !el.disabled)
    `
    await cdp.typeInto(composer, REQUEST_TEXT)
    await sleep(300)
    await cdp.shot('04-typed')
    await cdp.realClick(
      "Array.from(document.querySelectorAll('button')).find((b) => b.textContent.trim() === 'Send')",
      'Send 버튼',
    )

    // --- 4) 제안 승인 ---
    step('4) create_task 제안 확인 → Approve')
    await cdp.waitFor(
      "document.querySelector('.jarvis-approve-button') && !document.querySelector('.jarvis-approve-button').disabled",
      'Approve 버튼 노출',
      90000,
    )
    await cdp.shot('05-awaiting-confirmation')
    await cdp.realClick("document.querySelector('.jarvis-approve-button')", 'Approve 버튼')

    // --- 5) 연결 카드 ---
    step('5) 연결 카드 확인 → "Link file" 실제 클릭')
    await cdp.waitFor(
      "document.querySelector('[aria-label=\"Link active file\"]')",
      '링크 제안 카드 노출',
      90000,
    )
    const cardText = await cdp.evalJs(
      "return document.querySelector('.jarvis-link-affordance').innerText",
    )
    console.log(`  카드: ${cardText.replace(/\n/g, ' | ')}`)
    if (!cardText.includes(fixture.file_name)) {
      fail(`카드에 대상 파일명이 없음: ${cardText}`)
    }
    if (!cardText.includes(CREATED_TITLE)) {
      fail(`카드에 생성된 task 제목이 없음: ${cardText}`)
    }
    await cdp.shot('06-link-affordance')

    await cdp.realClick(
      "document.querySelector('.jarvis-link-button')",
      'Link file 버튼',
    )
    await cdp.waitFor(
      "document.querySelector('.jarvis-link-affordance.is-done')",
      '연결 완료 상태',
      60000,
    )
    const doneText = await cdp.evalJs(
      "return document.querySelector('.jarvis-link-affordance.is-done').innerText",
    )
    console.log(`  완료: ${doneText.replace(/\n/g, ' | ')}`)
    await cdp.shot('07-link-done')

    // --- 6) canonical 상태 검증 ---
    step('6) canonical 상태 확인 (실제 파일을 읽는다)')
    const readJson = (name) => {
      const p = path.join(stateDir, name)
      if (!fs.existsSync(p)) fail(`${name}이 없음: ${p}`)
      return JSON.parse(fs.readFileSync(p, 'utf-8'))
    }

    const links = readJson('resource_links.json')
    const linkList = Array.isArray(links) ? links : Object.values(links.links || {})
    console.log(`  링크 수: ${linkList.length}`)
    console.log(`  내용: ${JSON.stringify(linkList).slice(0, 400)}`)
    if (linkList.length !== 1) fail(`연결이 정확히 1개여야 함 (실제 ${linkList.length})`)
    const link = linkList[0]
    if (link.from_type !== 'task' || link.to_type !== 'file') {
      fail(`연결 방향이 task→file이 아님: ${JSON.stringify(link)}`)
    }

    // link는 이름이 아니라 identity를 저장한다. FileRef으로 되돌려 실제로 열었던
    // 파일인지 확인한다(단계 2에서 연 그 파일이어야 한다).
    const refs = readJson('file_refs.json')
    const refList = Array.isArray(refs) ? refs : Object.values(refs.refs || {})
    const ref = refList.find((r) => r.id === link.to_id)
    if (!ref) fail(`연결 대상 FileRef를 찾을 수 없음: to_id=${link.to_id}`)
    console.log(`  FileRef ${ref.id} → ${ref.relative_path}`)
    if (ref.relative_path !== fixture.file_name) {
      fail(`연결된 파일이 우리가 연 파일이 아님: ${ref.relative_path} != ${fixture.file_name}`)
    }

    // task 쪽도 동일하게 — Approve로 생성된 그 task인지 확인한다.
    const tasksRaw = fs.readFileSync(path.join(stateDir, 'tasks.md'), 'utf-8')
    if (!tasksRaw.includes(CREATED_TITLE)) {
      fail(`tasks.md에 생성된 task가 없음: ${tasksRaw.slice(0, 400)}`)
    }
    const taskIdMatch = tasksRaw.match(/- \[[ x]\] (t-[0-9a-f]+):/)
    if (!taskIdMatch) fail(`tasks.md에서 task id를 찾을 못함: ${tasksRaw.slice(0, 400)}`)
    console.log(`  task ${taskIdMatch[1]} → ${CREATED_TITLE}`)
    if (taskIdMatch[1] !== link.from_id) {
      fail(`연결된 task가 생성된 task와 다름: ${link.from_id} != ${taskIdMatch[1]}`)
    }
    console.log('  task 생성 + 파일 연결 확인')

    console.log(`\nGUI END-TO-END PASS — 실제 앱에서 클릭으로 링크가 canonical 상태에 기록됨.`)
    console.log(`stub model 호출 수: ${stub.state.calls}`)
    console.log(`스크린샷: ${ARTIFACT_DIR}`)
    void electron
    return true
  } finally {
    if (cdp) {
      try {
        cdp.ws.close()
      } catch {
        /* ignore */
      }
    }
    for (const child of children) {
      try {
        child.kill()
      } catch {
        /* ignore */
      }
    }
    if (stub) stub.server.close()
  }
}

main()
  .then((ok) => {
    if (!ok) process.exit(1)
  })
  .catch((err) => {
    console.error(`\nGUI END-TO-END FAILED: ${err.message}`)
    process.exit(1)
  })
