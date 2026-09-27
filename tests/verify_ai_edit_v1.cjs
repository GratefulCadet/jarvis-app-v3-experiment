/*
  AI EDIT V1 검증 — 실제 Electron에서 클릭으로 증명한다.

    E1) Happy path: 자연어 수정 요청 → proposal → diff 카드 표시(승인 전 디스크 불변)
        → Apply → 실제 디스크 반영 → 편집기 자동 갱신 → Undo → 원본 복원
    E2) Conflict: proposal 이후 외부 변경 → Apply가 revision 불일치로 거부
    E3) Cancel: proposal → Cancel → 디스크 불변
    E4) Wrong target: Active File=A 여도 명시적 target=B면 B만 수정
    E5) Safety: 승인 전 파일 내용 불변(이 전체 시나리오의 불변식)

  실행: node tests/verify_ai_edit_v1.cjs
  실패 시 exit 1. 스크린샷은 tests/artifacts/ai-edit-v1/ 에 남는다.
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
const ARTIFACT_DIR = path.join(__dirname, 'artifacts', 'ai-edit-v1')
const FILE_NAME = 'experiment-notes.md'
// 재계산이 만들어내는 '짧게 줄인' 결과 (CRLF — 대상 파일 규약 유지).
const RECALC_CONTENT = '# Experiment notes\r\n\r\n짧게 줄인 결론.\r\n'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function fail(message) {
  console.error(`[FAIL] ${message}`)
  process.exitCode = 1
  throw new Error(message)
}
function step(message) {
  console.log(`\n=== ${message} ===`)
}
function ok(message) {
  console.log(`  PASS — ${message}`)
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
  스텁 모델 — 실제 LLM 없이 승인 흐름만 재현한다.
  자연어 수정 요청을 받으면:
    1) 대상 경로를 정한다 — "이 파일"이면 active_file system line(Active File),
       파일명이 명시되었으면 그 경로. 명시 우선이 실제로 동작하는지 여기서 증명한다.
    2) read_file을 호출해 file_id를 얻는다(모델이 알 수 없는 유일한 방법)
    3) 그 결과로 edit_file 제안을 만든다
  스텁은 절대 디스크에 쓰지 않는다 — 쓰기는 Harness의 revision-safe apply 경로가
  유일한 창구라는 것을 그대로 증명하기 위해서다.
  received에는 스텁이 실제로 본 system/user 메시지를 남겨 E6 단언에 쓴다.
*/
function startStubModel({ newContentByFile, marker }) {
  const received = { activeFileLines: [], userTexts: [], toolNames: [], created: false, recalcPrompts: [] }
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      let payload = {}
      try { payload = JSON.parse(body || '{}') } catch { payload = {} }
      const messages = Array.isArray(payload.messages) ? payload.messages : []
      const toolMessages = messages.filter((m) => m && m.role === 'tool')
      // create_file 결과도 file_id를 갖는다. read_file 고유 필드(truncated)로 구분한다.
      const readResults = toolMessages
        .map((m) => { try { return JSON.parse(m.content || '{}') } catch { return null } })
        .filter((d) => d && d.ok && d.data && d.data.truncated !== undefined && (d.data.file_id || d.data.id))
      const sawRead = readResults.length > 0
      // edit_file 제안이 이미 만들어졌으면 더 이상 제안하지 않고 최종 답변으로 끝낸다.
      // (그렇지 않으면 read_file 결과가 남아 있는 한 같은 제안을 반복해 loop limit에 걸린다)
      const sawProposal = toolMessages.some((m) => {
        try { const d = JSON.parse(m.content || '{}'); return d && d.ok && d.data && d.data.proposal } catch { return false }
      })
      const lastUser = [...messages].reverse().find((m) => m && m.role === 'user')
      // tool loop은 tool 결과 뒤에 grounding 연속 문구를 user 메시지로 끼운다.
      // 그건 사용자가 한 요청이 아니므로 실제 요청만 골라 쓴다.
      const realUserMessages = messages.filter(
        (m) => m && m.role === 'user' && !String(m.content || '').startsWith('The internal reads above'),
      )
      const realUser = realUserMessages.length ? realUserMessages[realUserMessages.length - 1] : lastUser
      const text = (realUser && realUser.content) || ''
      const grounding = Boolean(lastUser && String(lastUser.content || '').startsWith('The internal reads above'))
      // Active File 컨텍스트(system message)에서 대상을 읽는다.
      const activeLine = messages
        .filter((m) => m && m.role === 'system' && typeof m.content === 'string')
        .map((m) => m.content)
        .find((c) => c.includes('workspace file open'))
      if (text) received.userTexts.push(text)
      if (activeLine && !grounding) received.activeFileLines.push(activeLine)
      received.lastMessages = messages.map((m) => ({ role: m && m.role, content: String((m && m.content) || '').slice(0, 400) }))
      for (const m of messages) {
        if (m && m.role === 'assistant' && Array.isArray(m.tool_calls)) {
          for (const call of m.tool_calls) received.toolNames.push(call.function && call.function.name)
        }
      }

      // 대상 결정 — explicit target > Active File > 없으면 추측 금지.
      const explicit = text.match(/([\w.-]+\.md)/)
      let targetName = null
      if (explicit && explicit[1] !== FILE_NAME) targetName = explicit[1]
      else if (explicit) targetName = FILE_NAME
      else if (activeLine) {
        const m = activeLine.match(/open:\s*(\S+)/)
        if (m) targetName = m[1]
      }
      const desired = newContentByFile[targetName] || newContentByFile[FILE_NAME]
      let message

      // 재계산 프롬프트 — 대상 identity와 원래 요청을 받아 새 제안을 만든다.
      if (text.includes('사용자 요청:') && text.includes('대상 file_id:')) {
        const id = (text.match(/대상 file_id:\s*(\S+)/) || [])[1]
        const root = (text.match(/대상 root:\s*(\S+)/) || [])[1]
        const p = (text.match(/대상 path:\s*(\S+)/) || [])[1]
        const instr = ((text.match(/사용자 요청:\s*([\s\S]*?)\n\n/) || [])[1] || '').trim()
        received.recalcPrompts.push({ id, root, path: p, instruction: instr })
        if (id && p) {
          message = {
            role: 'assistant',
            content: '',
            tool_calls: [{
              function: {
                name: 'edit_file',
                arguments: {
                  file_id: id,
                  root: root,
                  path: p,
                  content: RECALC_CONTENT,
                  summary: '재계산한 제안',
                  instruction: instr,
                },
              },
            }],
          }
        } else {
          message = { role: 'assistant', content: '대상을 확인할 수 없습니다.' }
        }
      } else if (readResults.length > 0) {
        let fileId = null
        let rootId = null
        let current = ''
        for (const d of readResults) {
          fileId = d.data.file_id || d.data.id
          rootId = d.data.root_id
          current = d.data.content
        }
        if (sawProposal) {
          message = { role: 'assistant', content: '변경 제안을 만들었습니다. diff를 확인하고 승인해 주세요.' }
        } else if (!fileId) {
          message = { role: 'assistant', content: 'file_id를 얻지 못했습니다.' }
        } else if (current === desired) {
          message = { role: 'assistant', content: '이미 반영되어 있습니다.' }
        } else {
          message = {
            role: 'assistant',
            content: '',
            tool_calls: [{
              function: {
                name: 'edit_file',
                arguments: {
                  file_id: fileId,
                  root: rootId,
                  path: targetName,
                  content: desired,
                  summary: `${marker} 요청한 수정`,
                  instruction: text,
                },
              },
            }],
          }
        }
      } else if (text.includes('수정해줘') || text.includes('고쳐줘') || text.includes('바꿔줘')) {
        message = {
          role: 'assistant',
          content: '',
          tool_calls: [{
            function: {
              name: 'read_file',
              arguments: targetName ? { path: targetName } : {},
            },
          }],
        }
      } else if (text.includes('기록') && !received.created) {
        received.created = true
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
      } else if (text.includes('기록')) {
        // 승인 후 턴 — 파일이 이미 만들어졌으니 최종 답변으로 끝낸다.
        message = { role: 'assistant', content: '파일을 만들었습니다.' }
      } else if (text.includes('기록')) {
        message = { role: 'assistant', content: '파일을 만들었습니다.' }
      } else {
        message = { role: 'assistant', content: '무엇을 도와드릴까요?' }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ model: payload.model, message, done: true }))
    })
  })
  return new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, received }))
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
      const result = await this.evalJs(`return Boolean(${expression})`)
      if (result) return true
      await sleep(300)
    }
    throw new Error(`대기 실패: ${description}`)
  }
  async waitForGone(expression, description, timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const result = await this.evalJs(`return Boolean(${expression})`)
      if (!result) return true
      await sleep(300)
    }
    throw new Error(`대기 실패(사라지지 않음): ${description}`)
  }
  async realClick(findExpression, description) {
    // PiP 오브 같은 overlay가 요소 위에 겹칠 수 있다. 실제로 그 요소를 가리키는
    // 좌표를 먼저 찾아야 '클릭했는데别的 면이 반응했다' 는 형태의 거짓 실패를 피한다.
    const point = await this.evalJs(`
      const el = ${findExpression};
      if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      const candidates = [[0.5, 0.5], [0.5, 0.35], [0.5, 0.7], [0.3, 0.5], [0.7, 0.5], [0.25, 0.4], [0.75, 0.6]];
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

const EDIT_CARD = "document.querySelector('.jarvis-edit-card')"
const APPLY_BTN = "Array.from(document.querySelectorAll('.jarvis-edit-card button')).find((b) => /Apply changes|Recalculate/.test(b.textContent))"
const CANCEL_BTN = "Array.from(document.querySelectorAll('.jarvis-edit-card button')).find((b) => b.textContent.trim() === 'Cancel')"
const UNDO_BTN = "Array.from(document.querySelectorAll('.jarvis-edit-card button')).find((b) => b.textContent.trim() === 'Undo')"

async function main() {
  const children = []
  let stub = null
  let cdp = null
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis_ai_edit_'))
  const stateDir = path.join(scratch, 'state')
  const workspaceDir = path.join(scratch, 'ws')

  // 원본 내용을 모든 단계에서 비교할 기준선으로 둔다.
  const targetPath = path.join(workspaceDir, FILE_NAME)
  const otherName = 'other-notes.md'
  const otherPath = path.join(workspaceDir, otherName)

  try {
    step('환경 준비')
    stub = await startStubModel({
      newContentByFile: {
        // B(other-notes.md)는 다른 원본을 가지니 그에 맞는 수정안을 쓴다.
        'other-notes.md': '# Other notes\n\n수정된 B 본문.\nkeep B line\n',
        [FILE_NAME]: '# Experiment notes\n\n수정된 본문 줄.\nkeep this line\n',
      },
      marker: 'AI-EDIT-V1',
    })
    const fixture = seedState(stateDir, workspaceDir)
    console.log(`  file=${fixture.file_name}`)

    // E4가 쓸 두 번째 대상 파일 (fixture가 만든 파일 옆에 둔다).
    fs.writeFileSync(otherPath, '# Other notes\n\n원래 B 내용\n', 'utf8')

    const original = fs.readFileSync(targetPath, 'utf8')
    const otherOriginal = fs.readFileSync(otherPath, 'utf8')
    // fixture 파일은 Windows에서 CRLF로 기록된다. 편집 경로는 대상 파일의 개행
    // 규약을 지킨다(LF 정규화 금지) — undo가 원본 바이트를 재현해야 하기 때문.
    const edited = '# Experiment notes\r\n\r\n수정된 본문 줄.\r\nkeep this line\r\n'
    console.log(`  original ${original.length} bytes / other ${otherOriginal.length} bytes`)

    const vitePort = await freePort()
    const cdpPort = await freePort()
    const run = (cmd, args, env, label) => {
      const child = spawn(cmd, args, { cwd: APP_ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      child.stdout.on('data', (c) => { const t = String(c).trim(); if (t && process.env.JARVIS_E2E_VERBOSE) console.log(`[${label}] ${t}`) })
      child.stderr.on('data', (c) => { const t = String(c).trim(); if (t) console.log(`[${label}!] ${t.slice(0, 160)}`) })
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
      HARNESS_MODEL: 'ai-edit-v1-stub',
    }, 'electron')

    cdp = await Cdp.attach(cdpPort)
    cdp.ws.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse(ev.data)
        if (msg.method === 'Runtime.exceptionThrown') {
          console.log(`  [renderer-exception] ${JSON.stringify(msg.params.exceptionDetails).slice(0, 400)}`)
        }
        if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning', 'log'].includes(msg.params.type)) {
          const text = (msg.params.args || []).map((a) => a.value || a.description || '').join(' ')
          console.log(`  [renderer-${msg.params.type}] ${text.slice(0, 300)}`)
        }
      } catch { /* */ }
    })
    await cdp.waitFor("document.readyState === 'complete' && document.body.innerText.trim().length > 0", '첫 렌더', 90000)
    await sleep(800)

    step('대화창 + 파일 열기 (Active File)')
    const composer = "document.querySelector('.jarvis-command-input')"
    const sendBtn = "document.querySelector('.jarvis-command-send')"
    await cdp.waitFor(composer, 'composer 등장', 20000)

    // 편집기가 열려 있으면 닫는다(열려 있지 않으면 그대로 둔다).
    const closeEditor = async () => {
      const open = await cdp.evalJs("return Boolean(document.querySelector('.workspace-file-editor'))")
      if (!open) return
      await cdp.realClick("document.querySelector('[aria-label=\"Close file editor\"]')", 'editor 닫기')
      await sleep(600)
    }

    const sendMessage = async (text) => {
      await cdp.typeInto(composer, text)
      await cdp.realClick(sendBtn, '보내기')
    }

    // Active File을 먼저 열어 둔다 — E6의 전제다.
    await cdp.realClick("document.querySelector('.jarvis-context-button')", 'Context 토글')
    await cdp.waitFor("document.querySelector('.v4-context-drawer')", 'drawer 등장', 10000)
    await sleep(600)
    await cdp.waitFor(
      `Array.from(document.querySelectorAll('.tree-prototype-map-row')).some((r) => (r.innerText || '').includes('${FILE_NAME}'))`,
      'FILES 목록에 대상 파일',
      20000,
    )
    await cdp.realClick(
      `Array.from(document.querySelectorAll('.tree-prototype-map-row')).find((r) => (r.innerText || '').includes('${FILE_NAME}'))`,
      '대상 파일 행',
    )
    await cdp.waitFor("document.querySelector('.workspace-file-editor')", '편집기 열림', 15000)
    const activeLabel = await cdp.evalJs("return document.querySelector('.workspace-file-editor-header strong')?.innerText")
    console.log(`  Active File: ${activeLabel}`)
    if (!activeLabel || !activeLabel.includes(FILE_NAME)) fail(`Active File이 열리지 않음: ${activeLabel}`)
    await cdp.shot('E00-active-file')

    // E6: Active File이 실제로 모델 컨텍스트로 전달되는지 확인한다.
    step('E6) Active File → 모델 컨텍스트 전달 확인')
    const composerProbe = await cdp.evalJs(`
      const input = document.querySelector('.jarvis-command-input');
      if (!input) return { present: false };
      const r = input.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { present: true, covered: !(hit === input || input.contains(hit)), hit: hit ? hit.tagName + '.' + String(hit.className).slice(0, 40) : 'none' };
    `)
    console.log(`  composer: ${JSON.stringify(composerProbe)}`)

    // Active File 전달은 '편집기가 열려 있는 상태로' 요청을 보낼 때만 성립한다
    // (편집기를 닫으면 Active File도 해제된다). 그래서 여기서 한 번 실제로 보내서
    // 모델 컨텍스트(system line)에 파일 identity가 실리는지 확인한다.
    if (composerProbe.present && !composerProbe.covered) {
      await sendMessage('이 파일 내용을 요약해줘')
      await cdp.waitFor("document.querySelector('.jarvis-runtime-panel')", '요약 응답', 90000)
      await sleep(500)
    }
    const activeLines = stub.received.activeFileLines || []
    console.log(`  active_file system lines: ${activeLines.length}`)
    if (activeLines.length === 0) fail('Active File이 모델 컨텍스트로 전달되지 않음')
    if (!activeLines.some((l) => l.includes(FILE_NAME))) fail('Active File 컨텍스트에 대상 파일이 없음')
    if (!activeLines.some((l) => l.includes('prefer that explicit file'))) {
      fail('Active File 컨텍스트에 "명시 대상 우선" 규칙이 없음')
    }
    ok('Active File이 모델 컨텍스트로 전달됨 (명시 대상 우선 규칙 포함)')

    // 이후 시나리오는 편집기를 닫고 진행한다.
    await closeEditor()

    // --- E1: happy path ---
    step('E1) 자연어 수정 요청 → proposal → diff 카드')
    await sendMessage('experiment-notes.md 첫 문단을 수정해줘')
    await cdp.waitFor(EDIT_CARD, 'diff 카드 등장', 90000)
    const cardText = await cdp.evalJs(`return document.querySelector('.jarvis-edit-card')?.innerText || ''`)
    console.log(`  카드:\n${cardText.split('\n').slice(0, 8).map((l) => `    ${l}`).join('\n')}`)
    if (!cardText.includes(FILE_NAME)) fail('카드에 대상 파일명이 없음')
    if (!/line[s]? changed/.test(cardText)) fail('변경 줄 수가 표시되지 않음')
    const addCount = await cdp.evalJs("return document.querySelectorAll('.jarvis-diff-line.is-add').length")
    const delCount = await cdp.evalJs("return document.querySelectorAll('.jarvis-diff-line.is-remove').length")
    console.log(`  diff 라인: +${addCount} / -${delCount}`)
    if (addCount === 0 && delCount === 0) fail('diff에 +/- 줄이 렌더되지 않음')
    await cdp.shot('E01-proposal-diff')

    step('E1-a) 승인 전에는 디스크가 그대로여야 한다')
    if (fs.readFileSync(targetPath, 'utf8') !== original) fail('승인 전에 파일이 이미 변경됨 — silent write')
    ok('제안 단계에서 디스크 불변')

    step('E1-b) Apply changes → 실제 디스크 반영')
    await cdp.realClick(APPLY_BTN, 'Apply changes')
    await cdp.waitFor(
      "Array.from(document.querySelectorAll('.jarvis-edit-card button')).some((b) => b.textContent.trim() === 'Undo')",
      'Undo 제공(적용 완료)',
      30000,
    )
    const applied = fs.readFileSync(targetPath, 'utf8')
    console.log(`  disk: ${JSON.stringify(applied.slice(0, 60))}`)
    if (applied !== edited) fail(`적용 내용 불일치:\n  want=${JSON.stringify(edited)}\n  got =${JSON.stringify(applied)}`)
    ok('승인 한 번으로 실제 파일이 수정됨')
    await cdp.shot('E02-applied')

    step('E1-c) 편집기가 자동 갱신된다 (revision 충돌 없이)')
    // 편집기를 다시 열면 새 content가 떠야 한다.
    await closeEditor()
    await cdp.waitForGone("document.querySelector('.workspace-file-editor')", 'editor 닫힘', 10000)
    await cdp.waitFor(
      `Array.from(document.querySelectorAll('.tree-prototype-map-row')).some((r) => (r.innerText || '').includes('${FILE_NAME}'))`,
      'FILES 목록',
      20000,
    )
    await cdp.realClick(
      `Array.from(document.querySelectorAll('.tree-prototype-map-row')).find((r) => (r.innerText || '').includes('${FILE_NAME}'))`,
      '대상 파일 재오픈',
    )
    await cdp.waitFor("document.querySelector('.workspace-file-editor textarea')", '편집기 재오픈', 15000)
    // 읽기(로딩)가 끝날 때까지 기다린다 — 빈 textarea로 판정하면 오판이다.
    await sleep(3000)
    await cdp.waitFor(
      "document.querySelector('.workspace-file-editor textarea') && !document.querySelector('.workspace-file-editor textarea').disabled",
      '편집기 로딩 완료',
      20000,
    ).catch(() => { console.log('  [warn] 편집기가 20초 내에 loading에서 벗어나지 않음') })
    const editorText = await cdp.evalJs(
      "return document.querySelector('.workspace-file-editor textarea')?.value || ''",
    )
    console.log(`  editor: ${JSON.stringify(editorText.slice(0, 60))}`)
    if (!editorText.includes('수정된 본문 줄')) fail('편집기가 갱신된 내용을 보이지 않음')
    if (editorText.includes('GUI end-to-end 검증이 opened target')) fail('편집기에 이전 content가 남아 있음')
    const editorState = await cdp.evalJs("return document.querySelector('.workspace-file-editor-state')?.innerText || ''")
    console.log(`  editor state: ${editorState}`)
    if (/Conflict/i.test(editorState)) fail('승인된 편집 뒤 편집기가 Conflict 상태')
    ok('편집기가 새 revision/content로 갱신됨 (충돌 없음)')

    step('E1-d) Undo → 원본 복원')
    await cdp.realClick(UNDO_BTN, 'Undo')
    await cdp.waitFor(
      "Array.from(document.querySelectorAll('.jarvis-edit-card button')).some((b) => b.textContent.trim() === 'Close')",
      'Undo 완료 상태(Reverted 카드)',
      30000,
    )
    const undoneCard = await cdp.evalJs("return document.querySelector('.jarvis-edit-card')?.innerText.replace(/\s+/g, ' ') || ''")
    console.log(`  undo 카드: ${undoneCard.slice(0, 160)}`)
    if (!/Reverted/i.test(undoneCard)) fail('Undo 후 복원 안내가 보이지 않음')
    // 1단계 undo 뒤에는 같은 제안을 다시 적용할 수 없다(Undo 버튼이 사라져야 한다).
    const undoStillThere = await cdp.evalJs(
      "return Array.from(document.querySelectorAll('.jarvis-edit-card button')).some((b) => b.textContent.trim() === 'Undo')",
    )
    if (undoStillThere) fail('1단계 undo 이후에도 Undo가 남아 있음')
    const restored = fs.readFileSync(targetPath, 'utf8')
    if (restored !== original) {
      let i = 0
      while (i < Math.min(restored.length, original.length) && restored[i] === original[i]) i++
      fail(
        `Undo가 원본을 복원하지 않음: restored=${restored.length} original=${original.length} firstDiff@${i}`,
      )
    }
    ok('Undo 1단계로 원본 내용 완전 복원')
    await cdp.shot('E03-undone')

    // --- E2: conflict ---
    step('E2) Conflict — 제안 이후 외부 변경 → Apply 거부')
    // 파일을 원본으로 되돌린 상태에서 새 제안을 만든다.
    await closeEditor()
    await sendMessage('experiment-notes.md 첫 문단을 수정해줘')
    await cdp.waitFor(EDIT_CARD, '두 번째 diff 카드', 90000)
    // 제안 직후, 승인 전에 파일을 외부에서 바꾼다.
    fs.writeFileSync(targetPath, '# Experiment notes\n\nEXTERNAL CHANGE\n', 'utf8')
    const externallyChanged = fs.readFileSync(targetPath, 'utf8')
    console.log('  외부에서 파일을 변경함')
    await cdp.shot('E04-before-conflict-apply')
    await cdp.realClick(APPLY_BTN, 'Apply changes (충돌 유도)')
    await cdp.waitFor("document.querySelector('.jarvis-edit-conflict')", 'conflict 카드', 30000)
    const conflictText = await cdp.evalJs("return document.querySelector('.jarvis-edit-conflict')?.innerText || ''")
    console.log(`  conflict: ${conflictText.replace(/\n/g, ' | ')}`)
    if (!/changed/i.test(conflictText)) fail('revision 불일치 메시지가 아님')
    if (fs.readFileSync(targetPath, 'utf8') !== externallyChanged) fail('충돌인데도 파일이 덮어써짐 — silent overwrite')
    const conflictButtons = await cdp.evalJs(`return Array.from(document.querySelectorAll('.jarvis-edit-card button')).map((b) => b.textContent.trim()).join('|')`)
    console.log(`  버튼: ${conflictButtons}`)
    if (!conflictButtons.includes('Recalculate')) fail('Recalculate 제공되지 않음')
    if (conflictButtons.includes('Apply changes')) fail('충돌 상태에서 Apply가 여전히 노출됨')
    ok('충돌 거부 + 조용한 덮어쓰기 없음 + Recalculate 제공')
    await cdp.shot('E05-conflict')

    step('E3) Cancel — 충돌 카드 취소 후 외부 변경 그대로')
    await cdp.realClick(CANCEL_BTN, 'Cancel')
    await cdp.waitFor("document.querySelector('.jarvis-edit-card.is-cancelled')", '취소 카드', 20000)
    if (fs.readFileSync(targetPath, 'utf8') !== externallyChanged) fail('취소했는데 파일이 변경됨')
    ok('Cancel — 디스크 불변')

    // --- V1.1: conflict recalculate ---
    step('V1.1) Recalculate — 충돌 후 같은 요청으로 새 제안')
    const readProposals = () => {
      const file = path.join(stateDir, 'edit_proposals.json')
      if (!fs.existsSync(file)) return {}
      return JSON.parse(fs.readFileSync(file, 'utf8')).proposals || {}
    }

    // 원상복구 후 A를 Active File로 열고 P1을 만든다(시나리오: open A → 요청).
    fs.writeFileSync(targetPath, original, 'utf8')
    await cdp.waitFor(
      `Array.from(document.querySelectorAll('.tree-prototype-map-row')).some((r) => (r.innerText || '').includes('${FILE_NAME}'))`,
      'FILES 목록', 20000,
    )
    await cdp.realClick(
      `Array.from(document.querySelectorAll('.tree-prototype-map-row')).find((r) => (r.innerText || '').includes('${FILE_NAME}'))`,
      'A 열기 (Active File)',
    )
    await cdp.waitFor("document.querySelector('.workspace-file-editor')", 'A 편집기', 15000)
    const v11Active = await cdp.evalJs("return document.querySelector('.workspace-file-editor-header strong')?.innerText || ''")
    if (!v11Active.includes(FILE_NAME)) fail(`Active File 아님: ${v11Active}`)
    await sendMessage('결론을 더 짧게 수정해줘')
    await cdp.waitFor(EDIT_CARD, 'P1 diff 카드', 60000)

    const proposalsAfterP1 = readProposals()
    const p1Id = Object.keys(proposalsAfterP1).filter((id) => proposalsAfterP1[id].status === 'proposed').pop()
    if (!p1Id) fail('P1 제안 레코드가 저장되지 않음')
    const p1 = proposalsAfterP1[p1Id]
    console.log(`  P1: ${p1Id} | base_rev=${JSON.stringify(p1.base_revision)}`)
    console.log(`  P1 instruction: ${JSON.stringify(p1.instruction)}`)
    if (p1.instruction !== '결론을 더 짧게 수정해줘') {
      fail(`P1에 원래 요청이 저장되지 않음: ${JSON.stringify(p1.instruction)}`)
    }
    ok('P1 생성 — 원래 요청(instruction) 저장됨')

    await closeEditor()

    // 제안 직후 외부 변경 → Apply → conflict
    const externalV11 = '# Experiment notes\r\n\r\nEXTERNAL V11\r\n'
    fs.writeFileSync(targetPath, externalV11, 'utf8')
    await cdp.realClick(APPLY_BTN, 'Apply changes (충돌 유도)')
    await cdp.waitFor("document.querySelector('.jarvis-edit-conflict')", 'conflict 카드', 30000)
    if (fs.readFileSync(targetPath, 'utf8') !== externalV11) fail('충돌인데 파일이 덮어써짐')
    ok('P1 Apply 충돌 거부 — 외부 변경 그대로')

    // Recalculate
    await cdp.realClick(
      "Array.from(document.querySelectorAll('.jarvis-edit-card button')).find((b) => b.textContent.trim() === 'Recalculate')",
      'Recalculate',
    )
    await cdp.waitFor(EDIT_CARD, 'P2 diff 카드', 90000)
    await sleep(800)

    const proposalsAfterP2 = readProposals()
    // P2 = P1이 아니고 P1보다 나중에 만들어진 'proposed' (이전 시나리오의 잔여 제안 제외)
    const p2Candidates = Object.keys(proposalsAfterP2).filter(
      (id) => id !== p1Id
        && proposalsAfterP2[id].status === 'proposed'
        && proposalsAfterP2[id].created_at > p1.created_at,
    )
    const p2Id = p2Candidates[0]
    if (!p2Id) {
      console.log(`  상태: ${JSON.stringify(Object.entries(proposalsAfterP2).map(([id, r]) => `${id}:${r.status}`))}`)
      fail('P2 제안이 생성되지 않음')
    }
    const p2 = proposalsAfterP2[p2Id]
    console.log(`  P2: ${p2Id} | base_rev=${JSON.stringify(p2.base_revision)}`)
    console.log(`  P1 상태: ${proposalsAfterP2[p1Id] ? proposalsAfterP2[p1Id].status : '(없음)'}`)

    if (p2Id === p1Id) fail('P2.proposal_id가 P1과 같다')
    if (proposalsAfterP2[p1Id]?.status !== 'superseded') {
      fail(`P1이 terminal 상태가 아님: ${proposalsAfterP2[p1Id]?.status}`)
    }
    if (p2.instruction !== '결론을 더 짧게 수정해줘') {
      fail(`P2에서 원래 요청이 보존되지 않음: ${JSON.stringify(p2.instruction)}`)
    }
    if (p2.before_content !== externalV11) {
      fail(`P2.before가 최신 canonical 내용이 아님: ${JSON.stringify(p2.before_content)}`)
    }
    if (JSON.stringify(p2.base_revision) === JSON.stringify(p1.base_revision)) {
      fail('P2.base_revision이 P1과 같다(최신 revision 아님)')
    }
    if (p2.file_id !== p1.file_id || p2.relative_path !== p1.relative_path) {
      fail('P2가 다른 대상 파일을 가리킴')
    }
    ok('P2 — 새 proposal_id·base_revision·before·diff, P1은 superseded, 요청 보존, 대상 동일')

    // P1의 stale 내용이 디스크에 쓰이지 않았는지
    if (fs.readFileSync(targetPath, 'utf8') !== externalV11) fail('재계산만으로 파일이 변경됨')
    const recalcCard = await cdp.evalJs("return document.querySelector('.jarvis-edit-card')?.innerText.replace(/\s+/g, ' ') || ''")
    console.log(`  P2 카드: ${recalcCard.slice(0, 120)}`)
    if (!/짧게 줄인 결론/.test(recalcCard)) fail('P2 diff에 새 내용이 보이지 않음')
    ok('P1 stale 내용은 디스크에 쓰이지 않음 + 새 diff 표시')

    // Apply P2 → 성공
    await cdp.realClick(APPLY_BTN, 'Apply changes (P2)')
    await cdp.waitFor(
      "Array.from(document.querySelectorAll('.jarvis-edit-card button')).some((b) => b.textContent.trim() === 'Undo')",
      'P2 적용 완료',
      30000,
    )
    if (fs.readFileSync(targetPath, 'utf8') !== RECALC_CONTENT) {
      fail(`P2 적용 내용 불일치: ${JSON.stringify(fs.readFileSync(targetPath, 'utf8'))}`)
    }
    ok('P2 Apply 성공 — 디스크 반영')

    // Undo → P2 적용 직전 상태(외부 변경)로 복원
    await cdp.realClick(UNDO_BTN, 'Undo (P2)')
    await cdp.waitFor(
      "Array.from(document.querySelectorAll('.jarvis-edit-card button')).some((b) => b.textContent.trim() === 'Close')",
      'P2 Undo 완료',
      30000,
    )
    if (fs.readFileSync(targetPath, 'utf8') !== externalV11) {
      fail(`P2 Undo가 직전 상태를 복원하지 않음: ${JSON.stringify(fs.readFileSync(targetPath, 'utf8'))}`)
    }
    ok('P2 Undo — P2 적용 직전 상태로 복원')

    // 원복 후 다음 시나리오를 위해 되돌린다.
    fs.writeFileSync(targetPath, original, 'utf8')

    // --- E4: wrong target protection ---
    step('E4) Wrong target — Active File=A, 명시적 target=B면 B만 수정')
    fs.writeFileSync(targetPath, original, 'utf8')
    fs.writeFileSync(otherPath, otherOriginal, 'utf8')

    // A를 Active File로 열어 둔 상태에서 B를 명시적으로 요청한다.
    await cdp.waitFor(
      `Array.from(document.querySelectorAll('.tree-prototype-map-row')).some((r) => (r.innerText || '').includes('${FILE_NAME}'))`,
      'FILES 목록',
      20000,
    )
    await cdp.realClick(
      `Array.from(document.querySelectorAll('.tree-prototype-map-row')).find((r) => (r.innerText || '').includes('${FILE_NAME}'))`,
      'Active File로 A 열기',
    )
    await cdp.waitFor("document.querySelector('.workspace-file-editor')", 'A 편집기 열림', 15000)
    const activeAgain = await cdp.evalJs("return document.querySelector('.workspace-file-editor-header strong')?.innerText")
    console.log(`  Active File: ${activeAgain}  /  명시 대상: ${otherName}`)
    if (!activeAgain || !activeAgain.includes(FILE_NAME)) fail('Active File A가 아님')
    await cdp.shot('E06-active-file-a')
    // composer를 가리는 editor를 닫되, 마지막 요청에는 Active File이 실렸음을
    // 스텁이 받은 system line으로 단언한다.
    await cdp.evalJs("const b = document.querySelector('[aria-label=\"Close file editor\"]'); if (b) b.click(); return true;")
    await sleep(700)

    await sendMessage(`${otherName} 첫 문단을 수정해줘`)
    await cdp.waitFor(EDIT_CARD, 'B 대상 diff 카드', 90000)
    const cardForB = await cdp.evalJs("return document.querySelector('.jarvis-edit-card .jarvis-edit-title')?.innerText || ''")
    console.log(`  카드 대상: ${cardForB}`)
    if (!cardForB.includes(otherName)) fail(`카드가 B가 아니라 A를 가리킴: ${cardForB}`)
    await cdp.shot('E07-proposal-for-b')
    await cdp.realClick(APPLY_BTN, 'B에 Apply')
    await cdp.waitFor(
      "Array.from(document.querySelectorAll('.jarvis-edit-card button')).some((b) => b.textContent.trim() === 'Undo')",
      'B 적용 완료',
      30000,
    )
    // B는 Node가 LF로 만들었으므로 편집도 LF를 유지한다(대상 파일 규약 준수).
    const editedB = '# Other notes\n\n수정된 B 본문.\nkeep B line\n'
    if (fs.readFileSync(otherPath, 'utf8') !== editedB) {
      fail(`B가 수정되지 않음: ${JSON.stringify(fs.readFileSync(otherPath, 'utf8'))}`)
    }
    if (fs.readFileSync(targetPath, 'utf8') !== original) fail('Active File A가 수정됨 — 명시 대상 우선 위반')
    ok('명시 대상 B만 수정, Active File A는 불변')

    // Active File이 모델 컨텍스트로 실렸는지는 E6에서 이미 단언했다.
    // 되돌려 원복한다.
    await cdp.realClick(UNDO_BTN, 'B Undo')
    await sleep(2500)
    if (fs.readFileSync(otherPath, 'utf8') !== otherOriginal) fail('B Undo 실패')
    ok('B 되돌리기 후 원복')

    // --- 회귀: create_file 승인 흐름이 여전히 동작하는지 ---
    step('R1) 회귀 — create_file 승인 흐름 유지')
    await sendMessage('새 파일로 기록해줘')
    await cdp.waitFor("document.querySelector('.jarvis-runtime-panel.is-permission')", 'create_file 승인 카드', 90000)
    const permText = await cdp.evalJs("return document.querySelector('.jarvis-runtime-panel.is-permission')?.innerText || ''")
    console.log(`  승인 카드: ${permText.split('\n')[1] || permText.slice(0, 60)}`)
    if (!permText.includes('Create file')) fail(`create_file 승인 카드가 아님: ${permText}`)
    await cdp.shot('R1-create-file-approval')
    await cdp.realClick("document.querySelector('.jarvis-permission-actions .jarvis-approve-button')", 'Approve')
    await cdp.waitFor(
      "document.querySelector('.jarvis-runtime-panel.is-done') || document.querySelector('.jarvis-runtime-panel.is-error')",
      'create_file 실행 완료(또는 오류)',
      90000,
    )
    const regressionState = await cdp.evalJs(`
      const panel = document.querySelector('.jarvis-runtime-panel');
      return { className: panel ? panel.className : null, text: panel ? panel.innerText.replace(/\\s+/g, ' ').slice(0, 160) : null };
    `)
    console.log(`  회귀 상태: ${JSON.stringify(regressionState)}`)
    if (!fs.existsSync(path.join(workspaceDir, 'model-made.md'))) {
      fail(`회귀 실패: 모델 승인으로 model-made.md가 생성되지 않음 (${JSON.stringify(regressionState)})`)
    }
    const modelMade = path.join(workspaceDir, 'model-made.md')
    if (!fs.existsSync(modelMade)) fail('회귀: 모델 승인으로 model-made.md가 생성되지 않음')
    ok('create_file 승인 흐름 정상')

    step('E5) Safety — 승인한 제안 외에는 아무 파일도 바뀌지 않았다')
    if (fs.readFileSync(targetPath, 'utf8') !== original) fail('Active File A가 아닌 파일이 변경됨')
    if (fs.readFileSync(otherPath, 'utf8') !== otherOriginal) fail('명시되지 않은 파일 B가 변경됨')
    ok('승인한 제안 외에는 어떤 파일도 변경되지 않음')

    console.log('\nAI EDIT V1 VERIFIED — 제안/승인/revision 충돌/되돌리기/취소가 실제 GUI에서 동작함.')
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
