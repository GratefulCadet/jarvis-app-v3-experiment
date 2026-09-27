/*
  Real Electron acceptance for Workspace Explorer and PiP interactions.
  Uses an isolated workspace/state fixture and deterministic local model. Electron,
  renderer, IPC, Python bridge, writes, native BrowserWindow movement, and CDP mouse
  input are real. Screenshots are saved under tests/artifacts/workspace-explorer-pip.
*/
const { spawn, spawnSync } = require('node:child_process')
const http = require('node:http')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const net = require('node:net')

const APP_ROOT = path.join(__dirname, '..')
const HARNESS_HOME = process.env.JARVIS_HARNESS_HOME || path.join(os.homedir(), 'Desktop', 'FB_Soap_LocalLLM')
const ARTIFACT_DIR = path.join(__dirname, 'artifacts', 'workspace-explorer-pip')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

async function waitForHttp(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) return await response.text()
    } catch { /* startup */ }
    await sleep(200)
  }
  return null
}

function nativeDesktopDrag(startX, startY, endX, endY) {
  const coordinates = [startX, startY, endX, endY]
  assert(coordinates.every((value) => Number.isFinite(value) && Math.abs(value) < 100000), `invalid desktop input coordinates: ${coordinates}`)
  const script = `
$source = @'
using System;
using System.Runtime.InteropServices;
using System.Threading;
public static class JarvisDesktopMouse {
  [DllImport("user32.dll", SetLastError = true)]
  private static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")]
  private static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
  private const uint LeftDown = 0x0002;
  private const uint LeftUp = 0x0004;
  private static void Move(int x, int y) {
    if (!SetCursorPos(x, y)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
  }
  public static void Drag(int startX, int startY, int endX, int endY) {
    Move(startX, startY);
    Thread.Sleep(180);
    mouse_event(LeftDown, 0, 0, 0, UIntPtr.Zero);
    Thread.Sleep(180);
    const int steps = 14;
    for (int step = 1; step <= steps; step++) {
      Move(startX + (endX - startX) * step / steps, startY + (endY - startY) * step / steps);
      Thread.Sleep(45);
    }
    Thread.Sleep(220);
    mouse_event(LeftUp, 0, 0, 0, UIntPtr.Zero);
    Thread.Sleep(500);
  }
}
'@
Add-Type -TypeDefinition $source
[JarvisDesktopMouse]::Drag(${coordinates.join(', ')})
`
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true,
  })
  if (result.error || result.status !== 0) {
    throw new Error(`native desktop drag failed: ${result.error?.message || result.stderr || result.stdout || result.status}`)
  }
}

/*
  A real OS drag is asynchronous: the window can settle a frame or more after the
  mouse-up, and Electron debounces the `moved` handler. Sampling once right after the
  helper returns produced intermittent false failures, so wait for the window to
  actually move (or for a short grace period) before asserting.
*/
async function waitForWindowMove(cdp, before, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const current = await cdp.evaluate('return {x: window.screenX, y: window.screenY}')
    if (current.x !== before.x || current.y !== before.y) return current
    await sleep(150)
  }
  return cdp.evaluate('return {x: window.screenX, y: window.screenY}')
}

function seedState(stateDir, workspaceDir) {
  const result = spawnSync(
    process.env.PYTHON || 'python',
    ['-m', 'scripts.gui_e2e_fixture', '--state-dir', stateDir, '--workspace-dir', workspaceDir, '--project-id', 'jarvis-app', '--seed-task-file-link'],
    { cwd: HARNESS_HOME, encoding: 'utf8' },
  )
  if (result.status !== 0) throw new Error(`fixture failed: ${result.stderr || result.stdout}`)
  return JSON.parse(result.stdout.trim().split('\n').pop())
}

function startStubModel(rootId) {
  const server = http.createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      let payload = {}
      try { payload = JSON.parse(body || '{}') } catch { /* empty body */ }
      const messages = Array.isArray(payload.messages) ? payload.messages : []
      const lastUser = [...messages].reverse().find((message) => message?.role === 'user')
      const text = String(lastUser?.content || '')
      const hasToolResult = messages.some((message) => message?.role === 'tool')
      const message = hasToolResult
        ? { role: 'assistant', content: '파일을 만들었습니다.' }
        : text.includes('승인 파일')
          ? { role: 'assistant', content: '', tool_calls: [{ function: {
              name: 'create_file', arguments: { root: rootId, path: 'experiments/model-created.md', content: 'approval gated file' },
            } }] }
          : text.includes('Task 승인')
            ? { role: 'assistant', content: '', tool_calls: [{ function: {
                name: 'create_task', arguments: { project_id: 'jarvis-app', title: 'PiP 승인 작업', reason: 'PiP approval acceptance' },
              } }] }
            : { role: 'assistant', content: '응답입니다.' }
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ model: payload.model, message, done: true }))
    })
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.sequence = 1
    this.pending = new Map()
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data)
      const item = this.pending.get(message.id)
      if (!item) return
      this.pending.delete(message.id)
      message.error ? item.reject(new Error(JSON.stringify(message.error))) : item.resolve(message.result)
    }
  }
  static async attach(port) {
    const deadline = Date.now() + 60000
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json`)
        const pages = await response.json()
        const page = pages.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
        if (page) {
          const ws = new WebSocket(page.webSocketDebuggerUrl)
          await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
          const client = new Cdp(ws)
          await client.send('Runtime.enable')
          await client.send('Page.enable')
          return client
        }
      } catch { /* Electron startup */ }
      await sleep(250)
    }
    throw new Error('Electron CDP attach timeout')
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.sequence++
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  async evaluate(body) {
    const result = await this.send('Runtime.evaluate', {
      expression: `(() => { ${body} })()`, returnByValue: true, awaitPromise: true,
    })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'renderer evaluate failed')
    return result.result?.value
  }
  async waitFor(expression, message, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (await this.evaluate(`return Boolean(${expression})`)) return
      await sleep(200)
    }
    throw new Error(`timeout: ${message}`)
  }
  async setViewport(width, height, deviceScaleFactor) {
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor, mobile: false })
    await this.waitFor(`window.innerWidth === ${width} && window.innerHeight === ${height}`, `renderer viewport set to ${width}x${height}`)
  }
  async point(selector, fraction = 0.5) {
    const point = await this.evaluate(`
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) return null;
      element.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = element.getBoundingClientRect();
      const x = rect.left + rect.width * ${fraction}, y = rect.top + rect.height / 2;
      const hit = document.elementFromPoint(x, y);
      return {
        x, y, width: rect.width, height: rect.height,
        hit: Boolean(hit && (hit === element || element.contains(hit))),
        hitTarget: hit ? hit.tagName + '.' + String(hit.className?.baseVal || hit.className || '').split(' ').join('.') : null,
        stack: document.elementsFromPoint(x, y).slice(0, 5).map((item) => item.tagName + '.' + String(item.className?.baseVal || item.className || '').split(' ').join('.')),
      };
    `)
    assert(point, `not found: ${selector}`)
    return point
  }
  async click(selector, description = selector) {
    const point = await this.point(selector)
    assert(point.hit || point.stack?.some((entry) => entry.startsWith('NAV.tree-prototype-dock')), `${description} center is covered (${JSON.stringify(point)})`)
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1, buttons: 1 })
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1, buttons: 0 })
    return point
  }
  async type(selector, text) {
    const point = await this.point(selector, 0.15)
    assert(point.hit, `${selector} center is covered`)
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1, buttons: 1 })
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1, buttons: 0 })
    await this.send('Input.insertText', { text })
  }
  async shot(name) {
    fs.mkdirSync(ARTIFACT_DIR, { recursive: true })
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' })
    const file = path.join(ARTIFACT_DIR, `${name}.png`)
    fs.writeFileSync(file, Buffer.from(data, 'base64'))
    console.log(`screenshot ${file}`)
  }
}

async function main() {
  const children = []
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-explorer-pip-'))
  const stateDir = path.join(scratch, 'state')
  const workspaceDir = path.join(scratch, 'workspace')
  const nestedFolder = path.join(workspaceDir, 'experiments')
  fs.mkdirSync(nestedFolder, { recursive: true })
  fs.writeFileSync(path.join(nestedFolder, 'nearby-results.csv'), 'epoch,score\n1,0.42\n', 'utf8')
  let stub
  let cdp
  try {
    const fixture = seedState(stateDir, workspaceDir)
    stub = await startStubModel(fixture.root_id)
    const vitePort = await freePort()
    const cdpPort = await freePort()
    const run = (command, args, env, label) => {
      const child = spawn(command, args, { cwd: APP_ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      child.stdout.on('data', (chunk) => { if (process.env.JARVIS_E2E_VERBOSE) console.log(`[${label}] ${String(chunk).trim()}`) })
      child.stderr.on('data', (chunk) => { if (process.env.JARVIS_E2E_VERBOSE) console.error(`[${label}] ${String(chunk).trim()}`) })
      children.push(child)
    }
    run(process.execPath, [path.join(APP_ROOT, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'], {}, 'vite')
    const viteUrl = `http://127.0.0.1:${vitePort}/`
    assert(await waitForHttp(viteUrl), 'vite did not start')
    run(require('electron'), ['.', `--remote-debugging-port=${cdpPort}`], {
      JARVIS_STATE_DIR: stateDir,
      JARVIS_DEV_URL: viteUrl,
      JARVIS_HARNESS_HOME: HARNESS_HOME,
      HARNESS_BASE_URL: `http://127.0.0.1:${stub.port}`,
      HARNESS_MODEL: 'workspace-explorer-pip-stub',
    }, 'electron')
    cdp = await Cdp.attach(cdpPort)
    await cdp.waitFor("document.readyState === 'complete' && document.body.innerText.includes('JARVIS')", 'main initial render')
    await sleep(700)
    await cdp.shot('main-default')

    await cdp.click('.jarvis-context-button', 'open Workspace Explorer')
    await cdp.waitFor("document.querySelector('.v4-context-drawer')", 'context drawer visible')
    await sleep(900)
    const drawerProbe = await cdp.evaluate(`
      return {
        open: document.querySelector('.jarvis-shell')?.dataset.contextOpen,
        drawerText: document.querySelector('.v4-context-drawer')?.innerText.slice(0, 500),
        explorer: Boolean(document.querySelector('.workspace-explorer')),
        roots: Array.from(document.querySelectorAll('[data-workspace-root]')).map((root) => root.dataset.workspaceRoot),
      };
    `)
    assert(drawerProbe.explorer, `Workspace Explorer missing: ${JSON.stringify(drawerProbe)}`)
    const explorerInfo = await cdp.evaluate(`
      return {
        root: document.querySelector('.workspace-explorer-root-heading strong')?.innerText,
        path: document.querySelector('.workspace-explorer-root-path')?.innerText,
        compact: document.querySelector('.workspace-explorer-root-path .workspace-explorer-path-compact')?.innerText,
        fullFromAttr: document.querySelector('.workspace-explorer-root-path')?.dataset.pathFull,
        folders: Array.from(document.querySelectorAll('.workspace-explorer-folder')).map((row) => row.dataset.folderPath),
      };
    `)
    assert(explorerInfo.root && explorerInfo.fullFromAttr === workspaceDir, `root path missing: ${JSON.stringify(explorerInfo)}`)
    assert(explorerInfo.compact?.includes(path.basename(workspaceDir)), `compact root path dropped the folder name: ${JSON.stringify(explorerInfo)}`)
    assert(explorerInfo.folders.includes('experiments'), 'nested folder not listed')
    await cdp.shot('workspace-explorer-open')

    await cdp.click('.workspace-explorer-folder[data-folder-path="experiments"] .tree-prototype-map-label', 'select/expand experiments folder')
    await cdp.waitFor("Array.from(document.querySelectorAll('.workspace-explorer-file')).some((row) => row.innerText.includes('nearby-results.csv'))", 'neighbor file visible')
    await cdp.shot('workspace-folder-expanded')

    const fileSelector = `.workspace-explorer-file[data-file-path=${JSON.stringify(fixture.file_name)}] .tree-prototype-map-label`
    await cdp.click(fileSelector, 'open linked file')
    await cdp.waitFor("document.querySelector('.workspace-file-editor')", 'editor opens')
    await cdp.waitFor("document.querySelector('.workspace-explorer-active')", 'active file context')
    const fileContext = await cdp.evaluate(`
      return {
        name: document.querySelector('.workspace-explorer-active > strong')?.innerText,
        breadcrumb: document.querySelector('.workspace-explorer-active .workspace-explorer-breadcrumb')?.innerText,
        compact: document.querySelector('.workspace-explorer-full-path .workspace-explorer-path-compact')?.innerText,
        fullFromAttr: document.querySelector('.workspace-explorer-full-path')?.dataset.pathFull,
        task: document.querySelector('.workspace-explorer-task-links')?.innerText,
        editorPath: document.querySelector('.workspace-file-editor-path')?.innerText,
      };
    `)
    assert(fileContext.name && fileContext.breadcrumb && fileContext.compact, `file location incomplete: ${JSON.stringify(fileContext)}`)
    assert(fileContext.fullFromAttr?.endsWith(fixture.file_name), `active file full path is not reachable: ${JSON.stringify(fileContext)}`)
    assert(fileContext.compact?.includes(fixture.file_name), `compact path hides the filename: ${JSON.stringify(fileContext)}`)
    assert(fileContext.task?.includes('브리핑 검증용 작업'), `linked Task missing: ${JSON.stringify(fileContext)}`)

    // The compact path must open the full path on a real click, and the full path must
    // actually reach the clipboard.
    const pathToggle = await cdp.point('.workspace-explorer-full-path .workspace-explorer-path-toggle')
    assert(pathToggle.hit, `path toggle is covered: ${JSON.stringify(pathToggle)}`)
    await cdp.click('.workspace-explorer-full-path .workspace-explorer-path-toggle', 'open full active-file path')
    await cdp.waitFor("Boolean(document.querySelector('.workspace-explorer-full-path .workspace-explorer-path-full'))", 'full path revealed')
    const revealed = await cdp.evaluate(`
      const full = document.querySelector('.workspace-explorer-full-path .workspace-explorer-path-full');
      return {
        text: full?.innerText,
        selectable: getComputedStyle(full).userSelect,
        expected: document.querySelector('.workspace-explorer-full-path')?.dataset.pathFull,
      };
    `)
    assert(revealed.text === revealed.expected, `revealed full path does not match the stored path: ${JSON.stringify(revealed)}`)
    assert(revealed.selectable === 'text' || revealed.selectable === 'auto', `full path is not selectable for copying: ${JSON.stringify(revealed)}`)
    await cdp.shot('path-full-revealed')

    const copyPoint = await cdp.point('.workspace-explorer-full-path .workspace-explorer-path-copy')
    assert(copyPoint.hit, `path copy button is covered: ${JSON.stringify(copyPoint)}`)
    await cdp.click('.workspace-explorer-full-path .workspace-explorer-path-copy', 'copy full path')
    await cdp.waitFor("document.querySelector('.workspace-explorer-full-path .workspace-explorer-path-copy')?.innerText.includes('복사됨')", 'copy confirmation')
    const clipboard = await cdp.evaluate('return navigator.clipboard.readText()')
    assert(clipboard === revealed.expected, `clipboard does not hold the full path. expected=${JSON.stringify(revealed.expected)} clipboard=${JSON.stringify(clipboard)}`)
    await cdp.shot('path-copied')
    await cdp.click('.workspace-explorer-full-path .workspace-explorer-path-toggle', 'collapse full active-file path')
    await cdp.waitFor("!document.querySelector('.workspace-explorer-full-path .workspace-explorer-path-full')", 'full path collapsed')
    await cdp.shot('file-editor-open')

    await cdp.click('.workspace-explorer-task-link', 'focus linked Task')
    await cdp.waitFor("document.querySelector('.workspace-explorer-task-link') && Array.from(document.querySelectorAll('.tree-prototype-overview-list [data-task-id]')).some((row) => row.classList.contains('is-descendant') || row.querySelector('.tree-prototype-map-label.is-active'))", 'Task revealed and focused')
    await cdp.shot('linked-task-focused')
    const contextOpenBeforeResponsive = await cdp.evaluate("return document.querySelector('.jarvis-shell')?.dataset.contextOpen === 'true'")
    if (!contextOpenBeforeResponsive) {
      await cdp.click('.jarvis-context-button', 'open Workspace Explorer for narrow-width inspection')
      await cdp.waitFor("document.querySelector('.jarvis-shell')?.dataset.contextOpen === 'true'", 'Workspace Explorer opened for narrow-width inspection')
    }

    const originalViewport = await cdp.evaluate('return { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio }')
    for (const width of [1280, 900, 760, 600]) {
      await cdp.setViewport(width, 800, originalViewport.dpr)
      await sleep(150)
      const responsiveExplorer = await cdp.evaluate(`
        const drawer = document.querySelector('.v4-context-drawer');
        const fileEditor = document.querySelector('.workspace-file-editor');
        const editorTextarea = fileEditor?.querySelector('textarea');
        const panel = document.querySelector('.command-panel-runtime');
        const rootPath = document.querySelector('.workspace-explorer-root-path .workspace-explorer-path-compact');
        const folderPath = document.querySelector('.workspace-explorer-folder-path .workspace-explorer-path-compact');
        const activePath = document.querySelector('.workspace-explorer-full-path .workspace-explorer-path-compact');
        const taskLink = document.querySelector('.workspace-explorer-task-link');
        const measure = (element) => {
          if (!element) return null;
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.5;
          return { text: element.innerText, fontSize: style.fontSize, width: rect.width, height: rect.height, lines: Math.max(1, Math.round(rect.height / lineHeight)), left: rect.left, right: rect.right, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight, overflowX: style.overflowX, overflowY: style.overflowY };
        };
        taskLink?.scrollIntoView({ block: 'center', behavior: 'instant' });
        const drawerRect = drawer?.getBoundingClientRect();
        const panelRect = panel?.getBoundingClientRect();
        const list = drawer?.querySelector('.tree-prototype-overview-list');
        const listRect = list?.getBoundingClientRect();
        const taskRect = taskLink?.getBoundingClientRect();
        return {
          viewport: [window.innerWidth, window.innerHeight],
          contextOpen: document.querySelector('.jarvis-shell')?.dataset.contextOpen,
          drawer: drawerRect && { width: drawerRect.width, height: drawerRect.height, left: drawerRect.left, right: drawerRect.right, visible: drawer.getClientRects().length > 0, display: getComputedStyle(drawer).display, scrollWidth: drawer.scrollWidth, clientWidth: drawer.clientWidth },
          editor: fileEditor && {
            rect: (() => { const rect = fileEditor.getBoundingClientRect(); return [rect.left, rect.top, rect.right, rect.bottom]; })(),
            panelRight: panelRect?.right,
            viewportRight: window.innerWidth,
            textareaRect: (() => { const rect = editorTextarea?.getBoundingClientRect(); return rect && [rect.left, rect.top, rect.right, rect.bottom]; })(),
            textareaHit: (() => {
              if (!editorTextarea) return false;
              const rect = editorTextarea.getBoundingClientRect();
              const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
              return Boolean(hit && (hit === editorTextarea || editorTextarea.contains(hit)));
            })(),
          },
          root: measure(rootPath),
          folder: measure(folderPath),
          active: measure(activePath),
          task: taskLink && { text: taskLink.innerText, fontSize: getComputedStyle(taskLink).fontSize, inDrawer: Boolean(drawerRect && taskRect && taskRect.left >= drawerRect.left && taskRect.right <= drawerRect.right && taskRect.top >= drawerRect.top && taskRect.bottom <= drawerRect.bottom), inScrollableViewport: Boolean(listRect && taskRect && taskRect.left >= listRect.left && taskRect.right <= listRect.right && taskRect.top >= listRect.top && taskRect.bottom <= listRect.bottom), scrollTop: list?.scrollTop, scrollHeight: list?.scrollHeight, clientHeight: list?.clientHeight },
        };
      `)
      console.log(`responsive Explorer ${width}px ${JSON.stringify(responsiveExplorer)}`)
      assert(responsiveExplorer.drawer?.visible && responsiveExplorer.drawer.width > 0, `Workspace Explorer drawer not visible at ${width}px: ${JSON.stringify(responsiveExplorer)}`)
      assert(responsiveExplorer.root?.width > 0 && responsiveExplorer.folder?.width > 0 && responsiveExplorer.active?.width > 0, `Workspace paths not visible at ${width}px: ${JSON.stringify(responsiveExplorer)}`)
      assert(responsiveExplorer.editor && responsiveExplorer.editor.rect[0] >= 0 && responsiveExplorer.editor.rect[2] <= responsiveExplorer.editor.viewportRight, `File editor extends beyond the viewport at ${width}px: ${JSON.stringify(responsiveExplorer.editor)}`)
      assert(responsiveExplorer.editor.textareaHit, `File editor content is covered at ${width}px: ${JSON.stringify(responsiveExplorer.editor)}`)
      assert(responsiveExplorer.editor.panelRight <= responsiveExplorer.editor.rect[0] + 4, `File editor overlaps the assistant panel at ${width}px: ${JSON.stringify(responsiveExplorer.editor)}`)
      assert(responsiveExplorer.task?.inScrollableViewport, `Linked Task cannot be revealed in Explorer's scrollable viewport at ${width}px: ${JSON.stringify(responsiveExplorer)}`)
      // Path awareness: one compact line each, no horizontal overflow, never below 10px,
      // and the filename must survive the elision.
      for (const key of ['root', 'folder', 'active']) {
        const measured = responsiveExplorer[key]
        assert(measured, `${key} compact path missing at ${width}px: ${JSON.stringify(responsiveExplorer)}`)
        assert(measured.lines <= 1, `${key} path stacks into ${measured.lines} lines at ${width}px: ${JSON.stringify(measured)}`)
        // A single ellipsized line is expected to have scrollWidth > clientWidth; what
        // must not happen is the line spilling out of the drawer or forcing a scrollbar.
        assert(['hidden', 'clip'].includes(measured.overflowX), `${key} path is not clipped horizontally at ${width}px: ${JSON.stringify(measured)}`)
        // A path squeezed to a few pixels is unreadable even though it is technically visible.
        assert(measured.width >= 48, `${key} path is squeezed to ${measured.width}px at ${width}px: ${JSON.stringify(measured)}`)
        assert(measured.left >= responsiveExplorer.drawer.left - 1 && measured.right <= responsiveExplorer.drawer.right + 1, `${key} path spills outside the drawer at ${width}px: ${JSON.stringify(measured)} drawer=${JSON.stringify(responsiveExplorer.drawer)}`)
        assert(parseFloat(measured.fontSize) >= 10, `${key} path font shrank to ${measured.fontSize} at ${width}px`)
      }
      assert(responsiveExplorer.active.text.includes(fixture.file_name), `active compact path hides the filename at ${width}px: ${JSON.stringify(responsiveExplorer.active)}`)
      assert(responsiveExplorer.root.text.includes(path.basename(workspaceDir)), `root compact path hides the workspace folder at ${width}px: ${JSON.stringify(responsiveExplorer.root)}`)
      assert(responsiveExplorer.drawer.scrollWidth <= responsiveExplorer.drawer.clientWidth + 1, `Explorer drawer scrolls horizontally at ${width}px: ${JSON.stringify(responsiveExplorer.drawer)}`)
      // The full path must be discoverable and hit-testable at every width, and the
      // editor must not sit on top of the drawer that holds the path/task context.
      const toggle = await cdp.point('.workspace-explorer-full-path .workspace-explorer-path-toggle')
      assert(toggle.hit, `path toggle is not clickable at ${width}px: ${JSON.stringify(toggle)}`)
      const overlap = await cdp.evaluate(`
        const editor = document.querySelector('.workspace-file-editor');
        const drawer = document.querySelector('.v4-context-drawer');
        if (!editor || !drawer) return null;
        const a = editor.getBoundingClientRect();
        const b = drawer.getBoundingClientRect();
        return { overlaps: a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top, editor: [a.left, a.right], drawer: [b.left, b.right] };
      `)
      assert(!overlap?.overlaps, `file editor covers the Workspace Explorer drawer at ${width}px: ${JSON.stringify(overlap)}`)
      await cdp.shot(`explorer-narrow-${width}`)
    }
    await cdp.send('Emulation.clearDeviceMetricsOverride')

    await cdp.click('.workspace-explorer-create', 'open create dialog')
    await cdp.waitFor("document.querySelector('.workspace-explorer-create-form')", 'create form visible')
    const choices = await cdp.evaluate('return document.querySelectorAll(".workspace-explorer-destination-choices input[type=radio]").length')
    assert(choices === 2, `different selected and active folders must require explicit choice: ${choices}`)
    await cdp.type('.workspace-explorer-create-form input[aria-label="New file name"]', 'file-parent-created.md')
    await cdp.click('.workspace-explorer-destination-choices label:nth-of-type(2) input[type="radio"]', 'select active file parent folder')
    const activeDestination = await cdp.evaluate('return document.querySelector(".workspace-explorer-destination")?.innerText')
    assert(activeDestination.includes(path.basename(workspaceDir)), `active parent destination missing: ${activeDestination}`)
    assert(!activeDestination.includes('experiments'), `active parent selection did not change destination: ${activeDestination}`)
    await cdp.click('.workspace-explorer-create-form button[type="submit"]', 'create in explicitly selected active-file folder')
    await cdp.waitFor("document.querySelector('.workspace-file-editor-header strong')?.innerText === 'file-parent-created.md'", 'created file opens')
    assert(fs.existsSync(path.join(workspaceDir, 'file-parent-created.md')), 'active-file-parent file not on disk')
    await cdp.shot('file-creation-destination')

    await cdp.click('[aria-label="Close file editor"]', 'close editor')
    await cdp.click('.workspace-explorer-create', 'open second create dialog')
    await cdp.waitFor("document.querySelector('.workspace-explorer-create-form')", 'second create form visible')
    await cdp.type('.workspace-explorer-create-form input[aria-label="New file name"]', 'folder-created.md')
    const secondChoices = await cdp.evaluate('return document.querySelectorAll(".workspace-explorer-destination-choices input[type=radio]").length')
    assert(secondChoices === 0, `closing the active file should leave the Explorer-selected folder as the default: ${secondChoices}`)
    const creationInfo = await cdp.evaluate(`
      return {
        destination: document.querySelector('.workspace-explorer-destination')?.innerText,
        target: document.querySelector('.workspace-explorer-create-preview')?.innerText,
      };
    `)
    assert(creationInfo.destination.includes('experiments'), `create folder incorrect: ${JSON.stringify(creationInfo)}`)
    assert(creationInfo.target.includes('folder-created.md'), 'absolute creation destination not shown')
    await cdp.shot('creation-form-open')
    await cdp.click('.workspace-explorer-create-form button[type="submit"]', 'create in selected Explorer folder')
    await cdp.waitFor("document.querySelector('.workspace-file-editor-header strong')?.innerText === 'folder-created.md'", 'created file opens')
    assert(fs.existsSync(path.join(nestedFolder, 'folder-created.md')), 'selected-folder file not on disk')
    await cdp.shot('created-file-editor-open')

    await cdp.click('[aria-label="Close file editor"]', 'close editor')
    await cdp.type('.jarvis-command-input', '승인 파일 생성해줘')
    await cdp.click('.jarvis-command-send', 'send create_file request')
    await cdp.waitFor("document.querySelector('.jarvis-permission-file-destination')", 'create destination on approval card')
    const approval = await cdp.evaluate('return document.querySelector(".jarvis-permission-file-destination")?.innerText')
    assert(approval.includes('model-created.md') && approval.includes('experiments'), `approval destination missing: ${approval}`)
    await cdp.shot('create-file-approval-destination')
    await cdp.click('.jarvis-approve-button', 'approve create_file')
    await cdp.waitFor("document.querySelector('.jarvis-runtime-panel.is-done')", 'approved result')
    const approvedFileState = await cdp.evaluate(`
      return {
        exists: Boolean(document.querySelector('.jarvis-runtime-panel.is-done')),
        text: document.querySelector('.jarvis-runtime-panel.is-done')?.innerText,
        error: document.querySelector('.jarvis-runtime-panel.is-error')?.innerText,
        permission: document.querySelector('.jarvis-runtime-panel.is-permission')?.innerText,
      };
    `)
    assert(fs.existsSync(path.join(nestedFolder, 'model-created.md')), `approved file was not created: ${JSON.stringify(approvedFileState)}`)

    const core = await cdp.point('.core-trigger')
    assert(core.width >= 100 && core.height >= 100 && core.hit, `Core target too small/covered: ${JSON.stringify(core)}`)
    const coreStyle = await cdp.evaluate(`
      const core = document.querySelector('.core-trigger').getBoundingClientRect();
      const panel = document.querySelector('.command-panel-runtime').getBoundingClientRect();
      return { core: [core.left, core.top, core.right, core.bottom], panel: [panel.left, panel.top, panel.right, panel.bottom] };
    `)
    const coreTouchesPanel = coreStyle.core[0] < coreStyle.panel[2] && coreStyle.core[2] > coreStyle.panel[0] && coreStyle.core[1] < coreStyle.panel[3] && coreStyle.core[3] > coreStyle.panel[1]
    assert(!coreTouchesPanel, `Core overlaps composer/runtime: ${JSON.stringify(coreStyle)}`)
    await cdp.shot('main-core-hit-area')
    await cdp.click('.core-trigger', 'center Core → PiP')
    await cdp.waitFor("document.querySelector('.jarvis-shell')?.dataset.view === 'pip'", 'PiP view')
    await cdp.shot('pip-idle')

    const beforeDrag = await cdp.evaluate('return {x: window.screenX, y: window.screenY, innerWidth: window.innerWidth, innerHeight: window.innerHeight, dpr: window.devicePixelRatio, availLeft: window.screen.availLeft || 0, availTop: window.screen.availTop || 0, availWidth: window.screen.availWidth, availHeight: window.screen.availHeight}')
    const dragPoint = await cdp.evaluate(`
      const element = document.querySelector('.pip-presence');
      const rect = element.getBoundingClientRect();
      const points = [
        [rect.left + 12, rect.top + 12],
        [rect.right - 12, rect.top + 12],
        [rect.left + 12, rect.bottom - 12],
        [rect.right - 12, rect.bottom - 12],
      ];
      const point = points.find(([x, y]) => getComputedStyle(document.elementFromPoint(x, y)).webkitAppRegion === 'drag');
      if (!point) return null;
      const [x, y] = point;
      const hit = document.elementFromPoint(x, y);
      return {x, y, hit: hit?.className || hit?.tagName, region: getComputedStyle(hit).webkitAppRegion};
    `)
    assert(dragPoint?.region === 'drag', `PiP empty background is not draggable: ${JSON.stringify(dragPoint)}`)
    const askInput = await cdp.evaluate(`
      const input = document.querySelector('.pip-presence-ask input');
      const rect = input.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return { region: getComputedStyle(input).webkitAppRegion, hit: hit === input };
    `)
    assert(askInput.region === 'no-drag' && askInput.hit, `PiP input conflicts with drag: ${JSON.stringify(askInput)}`)
    assert(beforeDrag.innerWidth === 280 && beforeDrag.innerHeight === 280, `unexpected PiP bounds: ${JSON.stringify(beforeDrag)}`)
    assert(beforeDrag.dpr > 0 && beforeDrag.availWidth >= beforeDrag.innerWidth && beforeDrag.availHeight >= beforeDrag.innerHeight, `invalid desktop metrics: ${JSON.stringify(beforeDrag)}`)
    const pixel = (value) => Math.round(value * beforeDrag.dpr)
    nativeDesktopDrag(
      pixel(beforeDrag.x + dragPoint.x),
      pixel(beforeDrag.y + dragPoint.y),
      pixel(beforeDrag.x + dragPoint.x + 92),
      pixel(beforeDrag.y + dragPoint.y + 64),
    )
    await waitForWindowMove(cdp, beforeDrag)
    const afterNativeDrag = await cdp.evaluate('return {x: window.screenX, y: window.screenY, width: window.innerWidth, height: window.innerHeight, availLeft: window.screen.availLeft || 0, availTop: window.screen.availTop || 0, availWidth: window.screen.availWidth, availHeight: window.screen.availHeight}')
    assert(afterNativeDrag.x !== beforeDrag.x || afterNativeDrag.y !== beforeDrag.y, `OS-level drag did not move PiP: before=${JSON.stringify(beforeDrag)} after=${JSON.stringify(afterNativeDrag)}`)
    assert(afterNativeDrag.x >= afterNativeDrag.availLeft && afterNativeDrag.y >= afterNativeDrag.availTop && afterNativeDrag.x + afterNativeDrag.width <= afterNativeDrag.availLeft + afterNativeDrag.availWidth && afterNativeDrag.y + afterNativeDrag.height <= afterNativeDrag.availTop + afterNativeDrag.availHeight, `PiP moved outside the available display area: ${JSON.stringify(afterNativeDrag)}`)
    await cdp.shot('pip-native-moved')

    const edgeDragPoint = await cdp.evaluate(`
      const rect = document.querySelector('.pip-presence').getBoundingClientRect();
      const points = [[rect.left + 12, rect.top + 12], [rect.right - 12, rect.top + 12], [rect.left + 12, rect.bottom - 12], [rect.right - 12, rect.bottom - 12]];
      return points.find(([x, y]) => getComputedStyle(document.elementFromPoint(x, y)).webkitAppRegion === 'drag') || null;
    `)
    assert(edgeDragPoint, 'no native draggable hit target after initial move')
    nativeDesktopDrag(
      pixel(afterNativeDrag.x + edgeDragPoint[0]),
      pixel(afterNativeDrag.y + edgeDragPoint[1]),
      pixel(afterNativeDrag.availLeft + afterNativeDrag.availWidth - afterNativeDrag.width + edgeDragPoint[0]),
      pixel(afterNativeDrag.availTop + afterNativeDrag.availHeight - afterNativeDrag.height + edgeDragPoint[1]),
    )
    await waitForWindowMove(cdp, afterNativeDrag)
    const afterEdgeDrag = await cdp.evaluate('return {x: window.screenX, y: window.screenY, width: window.innerWidth, height: window.innerHeight, availLeft: window.screen.availLeft || 0, availTop: window.screen.availTop || 0, availWidth: window.screen.availWidth, availHeight: window.screen.availHeight}')
    assert(afterEdgeDrag.x >= afterEdgeDrag.availLeft && afterEdgeDrag.y >= afterEdgeDrag.availTop && afterEdgeDrag.x + afterEdgeDrag.width <= afterEdgeDrag.availLeft + afterEdgeDrag.availWidth && afterEdgeDrag.y + afterEdgeDrag.height <= afterEdgeDrag.availTop + afterEdgeDrag.availHeight, `PiP bounds escaped the display after an edge drag: ${JSON.stringify(afterEdgeDrag)}`)
    await cdp.shot('pip-native-edge-bounds')

    await cdp.type('.pip-presence-ask input', '짧은 요청')
    await cdp.click('.pip-presence-ask button', 'PiP send')
    await cdp.waitFor("document.querySelector('.jarvis-shell')?.dataset.view === 'pip' && ['thinking','done'].includes(document.querySelector('.quick-pip')?.dataset.status)", 'request remains in PiP while running')
    await cdp.waitFor("document.querySelector('.quick-pip')?.dataset.status === 'done'", 'PiP done status')
    const doneIsNotInteractive = await cdp.evaluate(`
      const panel = document.querySelector('.pip-presence-resume');
      return {
        panel: Boolean(panel),
        role: panel?.getAttribute('role'),
        tag: panel?.tagName,
        pointerEvents: panel ? getComputedStyle(panel).pointerEvents : null,
      };
    `)
    assert(doneIsNotInteractive.panel && doneIsNotInteractive.tag !== 'BUTTON' && doneIsNotInteractive.role !== 'button' && doneIsNotInteractive.pointerEvents === 'none', `PiP result summary must not be an interaction target: ${JSON.stringify(doneIsNotInteractive)}`)
    await cdp.shot('pip-result')
    const resultText = await cdp.evaluate('return document.querySelector(".pip-presence-resume")?.innerText')
    assert(resultText?.includes('응답입니다.'), `PiP result summary missing: ${resultText}`)

    await cdp.type('.pip-presence-ask input', 'Task 승인 요청')
    await cdp.click('.pip-presence-ask button', 'submit approval request from PiP')
    await cdp.waitFor("document.querySelector('.quick-pip')?.dataset.status === 'awaiting-confirmation'", 'PiP permission state')
    const permission = await cdp.evaluate(`
      const panel = document.querySelector('.pip-presence > .jarvis-runtime-panel.is-permission');
      const approve = panel?.querySelector('.jarvis-approve-button');
      const reject = panel?.querySelector('.jarvis-reject-button');
      return { panel: Boolean(panel), approve: Boolean(approve), reject: Boolean(reject), view: document.querySelector('.jarvis-shell')?.dataset.view };
    `)
    assert(permission.panel && permission.approve && permission.reject && permission.view === 'pip', `PiP approval controls missing: ${JSON.stringify(permission)}`)
    const approvalLayout = await cdp.evaluate(`
      const orb = document.querySelector('.pip-presence-orb')?.getBoundingClientRect();
      const panel = document.querySelector('.pip-presence > .jarvis-runtime-panel.is-permission')?.getBoundingClientRect();
      const copy = Array.from(document.querySelectorAll('.pip-presence > .jarvis-runtime-panel.is-permission .jarvis-runtime-heading, .pip-presence > .jarvis-runtime-panel.is-permission .jarvis-permission-action, .pip-presence > .jarvis-runtime-panel.is-permission .jarvis-permission-title, .pip-presence > .jarvis-runtime-panel.is-permission .jarvis-permission-meta, .pip-presence > .jarvis-runtime-panel.is-permission .jarvis-permission-note'))
        .filter((element) => element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden')
        .map((element) => {
          const rect = element.getBoundingClientRect();
          return { text: element.innerText, top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left };
        });
      const overlaps = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
      return {
        orb: orb && { top: orb.top, right: orb.right, bottom: orb.bottom, left: orb.left },
        panel: panel && { top: panel.top, right: panel.right, bottom: panel.bottom, left: panel.left },
        overlappingCopy: orb ? copy.filter((item) => overlaps(orb, item)) : copy,
        panelOverlapsOrb: Boolean(orb && panel && overlaps(orb, panel)),
      };
    `)
    assert(approvalLayout.orb && approvalLayout.panel && !approvalLayout.panelOverlapsOrb && approvalLayout.overlappingCopy.length === 0, `PiP Orb overlaps approval content: ${JSON.stringify(approvalLayout)}`)
    await cdp.shot('pip-approval')
    await cdp.click('.pip-presence > .jarvis-runtime-panel.is-permission .jarvis-approve-button', 'approve from PiP')
    await cdp.waitFor("document.querySelector('.quick-pip')?.dataset.status === 'done'", 'approved Task completes in PiP')
    await cdp.shot('pip-approved-result')

    const coreBack = await cdp.point('.pip-presence-orb-trigger')
    assert(coreBack.hit, 'PiP Orb cannot be clicked after completion')
    await cdp.click('.pip-presence-orb-trigger', 'PiP Orb → Main')
    await cdp.waitFor("document.querySelector('.jarvis-shell')?.dataset.view === 'command-center'", 'PiP Orb opens Main')
    await cdp.shot('main-after-pip-roundtrip')

    // The user dragged PiP to a specific spot before opening Main. Returning to PiP must
    // land on that spot, not on a default or a drifted position.
    const draggedPip = { x: afterEdgeDrag.x, y: afterEdgeDrag.y, width: afterEdgeDrag.width, height: afterEdgeDrag.height }
    const readBounds = () => cdp.evaluate('return {x: window.screenX, y: window.screenY, width: window.innerWidth, height: window.innerHeight, availLeft: window.screen.availLeft || 0, availTop: window.screen.availTop || 0, availWidth: window.screen.availWidth, availHeight: window.screen.availHeight}')
    const pressEscape = async () => {
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
    }
    const assertNoStaleTransition = async (label) => {
      const stale = await cdp.evaluate(`
        const shell = document.querySelector('.jarvis-shell');
        const classes = String(shell?.className || '').split(/\\s+/).filter(Boolean);
        const leftover = classes.filter((name) => /^(opening|closing|pip-fade|is-|phase-)/.test(name));
        return {
          phase: shell?.dataset.phase,
          view: shell?.dataset.view,
          leftover,
          opacity: getComputedStyle(document.querySelector('.pip-presence') || shell).opacity,
          coreTriggers: document.querySelectorAll('.core-trigger').length,
          coreContainers: document.querySelectorAll('.core-container').length,
        };
      `)
      assert(stale.phase === 'idle', `${label}: transition phase did not settle to idle: ${JSON.stringify(stale)}`)
      assert(stale.leftover.length === 0, `${label}: stale transition classes remain: ${JSON.stringify(stale.leftover)}`)
      assert(stale.coreTriggers <= 1 && stale.coreContainers <= 1, `${label}: duplicated Core: ${JSON.stringify(stale)}`)
      assert(Number(stale.opacity) > 0.99, `${label}: surface opacity stuck: ${JSON.stringify(stale)}`)
      return stale
    }
    const assertRestored = (actual, label) => {
      assert(Math.abs(actual.x - draggedPip.x) <= 2 && Math.abs(actual.y - draggedPip.y) <= 2, `${label}: PiP did not return to the dragged position. expected=${JSON.stringify(draggedPip)} actual=${JSON.stringify(actual)}`)
      assert(actual.width === draggedPip.width && actual.height === draggedPip.height, `${label}: PiP size drifted: expected=${JSON.stringify(draggedPip)} actual=${JSON.stringify(actual)}`)
      assert(actual.x >= actual.availLeft && actual.y >= actual.availTop && actual.x + actual.width <= actual.availLeft + actual.availWidth && actual.y + actual.height <= actual.availTop + actual.availHeight, `${label}: restored PiP is off-screen: ${JSON.stringify(actual)}`)
    }

    // Escape is a secondary path. Overlays may legitimately consume the first press, so
    // press until PiP is reached and record how many it took.
    const readEscapeState = () => cdp.evaluate("const shell = document.querySelector('.jarvis-shell'); return { view: shell?.dataset.view, phase: shell?.dataset.phase, contextOpen: shell?.dataset.contextOpen, fileOpen: shell?.dataset.fileOpen }")
    const escapeStart = await readEscapeState()
    let escapePresses = 0
    const escapeTrail = []
    while (escapePresses < 3) {
      await pressEscape()
      escapePresses += 1
      // Wait for any closing animation to finish before sampling, so the record reflects
      // the settled view rather than a frame mid-transition. The phase passes through
      // closing-* and must return to idle (or pip) before the state is trustworthy.
      await sleep(150)
      await cdp.waitFor("!['closing-prep','closing-moving','closing-swap','opening-start','opening','pip-fade'].includes(document.querySelector('.jarvis-shell')?.dataset.phase)", 'Escape transition settles', 8000)
      await sleep(200)
      const state = await readEscapeState()
      escapeTrail.push(state)
      if (state.view === 'pip') break
      await sleep(250)
    }
    console.log(`escape start: ${JSON.stringify(escapeStart)} trail: ${JSON.stringify(escapeTrail)}`)
    assert(escapePresses <= 3, 'Escape never returned Main → PiP')
    await cdp.waitFor("document.querySelector('.jarvis-shell')?.dataset.view === 'pip'", 'Escape returns Main → PiP')
    await cdp.waitFor("document.querySelector('.jarvis-shell')?.dataset.phase === 'idle'", 'PiP settled after Escape')
    await sleep(200)
    const afterEscape = await readBounds()
    assertRestored(afterEscape, 'Escape return')
    console.log(`roundtrip escape: presses=${escapePresses} restored=${JSON.stringify({ x: afterEscape.x, y: afterEscape.y })}`)
    await assertNoStaleTransition('after Escape return')
    await cdp.shot('pip-restored-after-escape')

    // PiP controls must still be usable after the round trip, not just present.
    const restoredInput = await cdp.evaluate(`
      const input = document.querySelector('.pip-presence-ask input');
      if (!input) return null;
      const rect = input.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return { region: getComputedStyle(input).webkitAppRegion, hit: hit === input, width: rect.width, height: rect.height };
    `)
    assert(restoredInput?.region === 'no-drag' && restoredInput.hit, `PiP input unusable after round trip: ${JSON.stringify(restoredInput)}`)
    const restoredOrb = await cdp.point('.pip-presence-orb-trigger')
    assert(restoredOrb.hit, `PiP Orb unusable after round trip: ${JSON.stringify(restoredOrb)}`)
    await cdp.type('.pip-presence-ask input', '왕복 후 입력')
    await cdp.click('.pip-presence-ask button', 'PiP send after round trip')
    await cdp.waitFor("document.querySelector('.jarvis-shell')?.dataset.view === 'pip' && ['thinking','done'].includes(document.querySelector('.quick-pip')?.dataset.status)", 'request stays in PiP after round trip')
    await cdp.waitFor("document.querySelector('.quick-pip')?.dataset.status === 'done'", 'PiP completes after round trip')
    await cdp.shot('pip-roundtrip-result')

    // Repeat the round trip to expose drift, stuck state, or a duplicated Core.
    const roundTrips = []
    /*
      The view flips to command-center at the start of the opening so the Main Core can be
      measured, so "reached Main" is not the same as "settled". Settled means the phase is
      idle again, which is when the content entrance has also finished.
    */
    const waitSettled = (view) => cdp.waitFor(
      `(() => { const shell = document.querySelector('.jarvis-shell'); return shell?.dataset.view === ${JSON.stringify(view)} && shell?.dataset.phase === 'idle' && !shell.classList.contains('is-content-entering'); })()`,
      `${view} settled`,
      15000,
    )
    for (let index = 0; index < 2; index += 1) {
      await cdp.click('.pip-presence-orb-trigger', `PiP Orb → Main (round trip ${index + 1})`)
      await waitSettled('command-center')
      await assertNoStaleTransition(`Main round trip ${index + 1}`)
      const mainCore = await cdp.point('.core-trigger')
      assert(mainCore.hit && mainCore.width >= 100, `Main Core unusable (round trip ${index + 1}): ${JSON.stringify(mainCore)}`)
      await cdp.click('.core-trigger', `center Core → PiP (round trip ${index + 1})`)
      await waitSettled('pip')
      const bounds = await readBounds()
      assertRestored(bounds, `round trip ${index + 1}`)
      await assertNoStaleTransition(`PiP round trip ${index + 1}`)
      roundTrips.push({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height })
    }
    for (const bounds of roundTrips) {
      assert(bounds.x === roundTrips[0].x && bounds.y === roundTrips[0].y, `PiP position drifted across round trips: ${JSON.stringify(roundTrips)}`)
      assert(bounds.width === roundTrips[0].width && bounds.height === roundTrips[0].height, `PiP size drifted across round trips: ${JSON.stringify(roundTrips)}`)
    }
    console.log(`roundtrip stability: ${JSON.stringify(roundTrips)}`)
    await cdp.shot('pip-after-repeated-roundtrips')

    // ---------------------------------------------------------------------
    // PiP ↔ Main signature transition
    //
    // Verifies the motion hierarchy against the real renderer: the Core must be
    // travelling before any workspace content exists, the content entrance must run
    // only after the Core has settled, and the native swap must be a single jump to
    // the last dragged PiP bounds.
    // ---------------------------------------------------------------------
    const coreFrame = () => cdp.evaluate(`
      const shell = document.querySelector('.jarvis-shell');
      const core = document.querySelector('.core-container');
      const style = core ? getComputedStyle(core) : null;
      const surface = document.querySelector('.command-panel-runtime');
      return {
        phase: shell?.dataset.phase,
        view: shell?.dataset.view,
        transform: style?.transform,
        opacity: style?.opacity,
        hasContent: Boolean(surface && surface.getClientRects().length),
        contentOpacity: surface ? getComputedStyle(surface).opacity : null,
        contentAnimating: surface ? getComputedStyle(surface).animationName !== 'none' : null,
        entering: String(shell?.className || '').includes('is-content-entering'),
      };
    `)
    const shotAtPhase = async (phase, name) => {
      await cdp.waitFor(`document.querySelector('.jarvis-shell')?.dataset.phase === ${JSON.stringify(phase)}`, `phase ${phase}`, 4000)
      const frame = await coreFrame()
      await cdp.shot(name)
      return frame
    }
    /*
      opening-start only exists for ~2 frames, so polling cannot reliably catch it.
      Record the real phase sequence with a MutationObserver installed before the click,
      which is also the only honest way to prove the Core moves before content exists.
    */
    const recordPhases = () => cdp.evaluate(`
      const shell = document.querySelector('.jarvis-shell');
      window.__phases = [shell?.dataset.phase];
      window.__frames = [];
      window.__phaseObserver?.disconnect();
      window.__phaseObserver = new MutationObserver(() => {
        const phase = shell?.dataset.phase;
        if (window.__phases[window.__phases.length - 1] !== phase) window.__phases.push(phase);
      });
      window.__phaseObserver.observe(shell, { attributes: true, attributeFilter: ['data-phase'] });
      if (window.__raf) cancelAnimationFrame(window.__raf);
      const started = performance.now();
      const tick = () => {
        const surface = document.querySelector('.command-panel-runtime');
        const core = document.querySelector('.core-container');
        const rect = core?.getBoundingClientRect();
        // The reveal is a pseudo-element, so its animated centre is only observable
        // through the computed clip-path. Sampled here to prove the circle travels
        // with the Core instead of staying parked at the PiP position.
        const clip = shell ? getComputedStyle(shell, '::before').clipPath : 'none';
        const at = /circle\\([^)]*?at\\s+(-?[0-9.]+)px\\s+(-?[0-9.]+)px\\s*\\)/.exec(clip || '');
        const shellRect = shell?.getBoundingClientRect();
        // Read back the authored custom property, not the animated computed value: if
        // the centre moved because a JS loop rewrote this each frame, the inline value
        // would change every frame. It must stay put and let CSS interpolate.
        const authoredEnd = shell?.style.getPropertyValue('--reveal-end-x') || '';
        const authoredStart = shell?.style.getPropertyValue('--reveal-start-x') || '';
        window.__frames.push({
          t: Math.round(performance.now() - started),
          phase: shell?.dataset.phase,
          view: shell?.dataset.view,
          hasContent: Boolean(surface && surface.getClientRects().length),
          opacity: surface ? Number(getComputedStyle(surface).opacity) : null,
          coreX: rect ? Math.round(rect.left + window.screenX) : null,
          coreY: rect ? Math.round(rect.top + window.screenY) : null,
          coreW: rect ? Math.round(rect.width) : null,
          revealX: at && shellRect ? Math.round(shellRect.left + Number(at[1]) + window.screenX) : null,
          revealY: at && shellRect ? Math.round(shellRect.top + Number(at[2]) + window.screenY) : null,
          authoredEnd,
          authoredStart,
        });
        if (performance.now() - started < 3000) window.__raf = requestAnimationFrame(tick);
      };
      window.__raf = requestAnimationFrame(tick);
      return true;
    `)
    const readPhases = () => cdp.evaluate('return { phases: window.__phases, frames: window.__frames }')

    // PiP idle (frame evidence)
    await cdp.shot('transition-01-pip-idle')

    // --- Opening ---
    await recordPhases()
    await cdp.click('.pip-presence-orb-trigger', 'signature: PiP → Main')
    const openingMid = await shotAtPhase('opening', 'transition-03-opening-mid')
    assert(!openingMid.hasContent, `workspace content appears while the Core is still travelling: ${JSON.stringify(openingMid)}`)
    await cdp.waitFor("(() => { const shell = document.querySelector('.jarvis-shell'); return shell?.dataset.view === 'command-center' && shell?.dataset.phase === 'idle' && !shell.classList.contains('is-content-entering'); })()", 'signature: Main settled')
    const openingRun = await readPhases()
    console.log(`opening phase sequence: ${JSON.stringify(openingRun.phases)}`)
    assert(openingRun.phases[0] === 'idle' && openingRun.phases[1] === 'opening-start', `opening did not start from opening-start: ${JSON.stringify(openingRun.phases)}`)
    assert(openingRun.phases[2] === 'opening', `opening never reached the travel phase: ${JSON.stringify(openingRun.phases)}`)
    assert(openingRun.phases[openingRun.phases.length - 1] === 'idle', `opening never returned to idle: ${JSON.stringify(openingRun.phases)}`)
    // The Core must be moving before any workspace content is on screen.
    const contentBeforeCoreSettled = openingRun.frames.filter((entry) => entry.phase !== 'idle' && entry.hasContent)
    assert(contentBeforeCoreSettled.length === 0, `workspace content was visible during the Core transition: ${JSON.stringify(contentBeforeCoreSettled.slice(0, 3))}`)

    const mainSettled = await coreFrame()
    assert(mainSettled.hasContent, `Main settled without workspace content: ${JSON.stringify(mainSettled)}`)
    /*
      The entrance class is transient, so prove the entrance from the recorded opacity
      ramp rather than from a class that has already been removed: content must fade in
      from near-zero rather than appearing at full opacity on its first visible frame.
    */
    const opacityRamp = openingRun.frames
      .filter((entry) => entry.hasContent)
      .map((entry) => entry.opacity)
      .filter((value) => typeof value === 'number')
    const firstVisible = openingRun.frames.find((entry) => entry.hasContent)
    assert(firstVisible, 'workspace content never became visible during the opening')
    assert(firstVisible.opacity < 0.35, `content appeared at full opacity instead of entering: ${JSON.stringify(firstVisible)}`)
    const finalOpacity = opacityRamp[opacityRamp.length - 1]
    assert(finalOpacity > 0.95, `content entrance never completed: ${JSON.stringify(opacityRamp.slice(0, 8))}`)
    // The Core must have travelled rather than jumped when the view flipped.
    const openingFrames = openingRun.frames.filter((entry) => entry.coreX !== null)
    const corePositions = new Set(openingFrames.map((entry) => `${entry.coreX},${entry.coreY}`))
    assert(corePositions.size > 5, `Core did not travel across the opening: ${corePositions.size} distinct positions`)

    /*
      The reveal's centre must travel with the Core rather than sitting at the PiP
      position it started from, and the Core must stay the anchor throughout: a small
      one-directional lag is the intended inertia, a large or growing gap is not.
    */
    const centreOf = (entry) => (entry.coreX === null ? null : { x: entry.coreX + entry.coreW / 2, y: entry.coreY + entry.coreW / 2 });
    const revealFrames = openingRun.frames.filter((entry) => entry.revealX !== null && centreOf(entry));
    assert(revealFrames.length > 5, `reveal centre was not observable during the opening: ${revealFrames.length} frames`)
    const revealCentres = new Set(revealFrames.map((entry) => `${entry.revealX},${entry.revealY}`))
    assert(revealCentres.size > 5, `reveal centre never moved — it is pinned instead of travelling: ${revealCentres.size} distinct values ${JSON.stringify([...revealCentres].slice(0, 6))} authored start ${JSON.stringify([...new Set(revealFrames.map((e) => e.authoredStart))])} end ${JSON.stringify([...new Set(revealFrames.map((e) => e.authoredEnd))])}`)
    const startCentre = revealFrames[0]
    const endCentre = revealFrames[revealFrames.length - 1]
    const travelled = Math.hypot(endCentre.revealX - startCentre.revealX, endCentre.revealY - startCentre.revealY)
    assert(travelled > 100, `reveal centre barely moved across the opening: ${Math.round(travelled)}px`)
    const gaps = revealFrames.map((entry) => {
      const centre = centreOf(entry);
      return Math.hypot(centre.x - entry.revealX, centre.y - entry.revealY);
    });
    const peakGap = Math.max(...gaps);
    /*
      Bound the lag as a fraction of how far the Core actually travels, not in absolute
      pixels. The same animation covers ~430px when PiP sits near the middle and
      ~1500px when the user has dragged it to a far corner, so a fixed pixel limit would
      pass one and fail the other for the same behaviour.
    */
    const coreFirst = centreOf(revealFrames[0]);
    const coreLast = centreOf(revealFrames[revealFrames.length - 1]);
    const coreTravel = Math.hypot(coreLast.x - coreFirst.x, coreLast.y - coreFirst.y);
    assert(peakGap / coreTravel < 0.12, `reveal fell too far behind the Core (peak ${Math.round(peakGap)}px over ${Math.round(coreTravel)}px of travel) — the Core is no longer the anchor`)
    assert(gaps[gaps.length - 1] < 12, `reveal did not converge on the Main Core: ${Math.round(gaps[gaps.length - 1])}px apart at rest`)
    /*
      No per-frame JS tracking: the authored endpoint is written once per transition
      and never rewritten, so every distinct computed centre above came from CSS
      interpolation. A JS tracking loop would show many distinct inline values.
    */
    const authoredValues = new Set(revealFrames.map((entry) => entry.authoredEnd).filter(Boolean));
    assert(authoredValues.size <= 1, `reveal endpoint was rewritten per frame (${authoredValues.size} distinct inline values) — that is JS tracking, not CSS interpolation`)
    console.log(`opening Core positions: ${corePositions.size} distinct, content opacity ramp ${JSON.stringify(opacityRamp.slice(0, 6))} → ${finalOpacity}`)
    console.log(`opening reveal centre: ${revealCentres.size} distinct, travelled ${Math.round(travelled)}px, peak Core gap ${Math.round(peakGap)}px over ${Math.round(coreTravel)}px travel, authored endpoint writes ${authoredValues.size}`)
    await cdp.shot('transition-04-main-settled')
    const mainRest = await coreFrame()
    assert(!mainRest.entering, `content entrance class never cleared: ${JSON.stringify(mainRest)}`)

    // --- Closing ---
    await recordPhases()
    await cdp.click('.core-trigger', 'signature: Main → PiP')
    await shotAtPhase('closing-prep', 'transition-05-closing-start')
    await shotAtPhase('closing-moving', 'transition-06-closing-mid')
    await cdp.waitFor("document.querySelector('.jarvis-shell')?.dataset.view === 'pip' && document.querySelector('.jarvis-shell')?.dataset.phase === 'idle'", 'signature: PiP settled')
    await sleep(300)
    const closingRun = await readPhases()
    console.log(`closing phase sequence: ${JSON.stringify(closingRun.phases)}`)
    for (const expected of ['closing-prep', 'closing-moving', 'closing-swap', 'pip-fade']) {
      assert(closingRun.phases.includes(expected), `closing never reached ${expected}: ${JSON.stringify(closingRun.phases)}`)
    }
    /*
      Closing uses the same language as opening: the circle travels back to the PiP
      Core while shrinking, and it must stay anchored on the Core during closing-prep.
      The prep phase does not move the Core, so a reveal centre that drifts there is a
      geometry fault — the stylesheet's percentage fallback leaking into the animation.
    */
    const closeCentres = closingRun.frames.filter((entry) => entry.revealX !== null);
    assert(closeCentres.length > 5, `reveal centre was not observable during the closing: ${closeCentres.length} frames`);
    const closeDistinct = new Set(closeCentres.map((entry) => `${entry.revealX},${entry.revealY}`));
    assert(closeDistinct.size > 5, `reveal centre never moved while closing: ${closeDistinct.size} distinct values`);
    const closeStart = closeCentres[0];
    const closeEnd = closeCentres[closeCentres.length - 1];
    const closeTravelled = Math.hypot(closeEnd.revealX - closeStart.revealX, closeEnd.revealY - closeStart.revealY);
    assert(closeTravelled > 100, `reveal centre barely moved while closing: ${Math.round(closeTravelled)}px`);
    const closeGaps = closingRun.frames
      .filter((entry) => entry.revealX !== null && entry.coreX !== null)
      .map((entry) => {
        const centre = { x: entry.coreX + entry.coreW / 2, y: entry.coreY + entry.coreW / 2 };
        return Math.hypot(centre.x - entry.revealX, centre.y - entry.revealY);
      });
    const closeCoreFrames = closingRun.frames.filter((entry) => entry.revealX !== null && entry.coreX !== null);
    const closeFirst = { x: closeCoreFrames[0].coreX + closeCoreFrames[0].coreW / 2, y: closeCoreFrames[0].coreY + closeCoreFrames[0].coreW / 2 };
    const closeLastFrame = closeCoreFrames[closeCoreFrames.length - 1];
    const closeLast = { x: closeLastFrame.coreX + closeLastFrame.coreW / 2, y: closeLastFrame.coreY + closeLastFrame.coreW / 2 };
    const closeCoreTravel = Math.hypot(closeLast.x - closeFirst.x, closeLast.y - closeFirst.y);
    assert(Math.max(...closeGaps) / closeCoreTravel < 0.12, `reveal fell too far behind the Core while closing (peak ${Math.round(Math.max(...closeGaps))}px over ${Math.round(closeCoreTravel)}px of travel)`);
    const closeAuthored = new Set(closeCentres.map((entry) => entry.authoredEnd).filter(Boolean));
    assert(closeAuthored.size <= 1, `reveal endpoint was rewritten per frame while closing (${closeAuthored.size} distinct inline values)`);
    console.log(`closing reveal centre: ${closeDistinct.size} distinct, travelled ${Math.round(closeTravelled)}px, peak Core gap ${Math.round(Math.max(...closeGaps))}px over ${Math.round(closeCoreTravel)}px travel, authored endpoint writes ${closeAuthored.size}`);
    const pipSettled = await coreFrame()
    assert(pipSettled.phase === 'idle', `PiP did not settle to idle: ${JSON.stringify(pipSettled)}`)
    await cdp.shot('transition-07-pip-settled')

    // The native swap must land on the last dragged bounds, not a default.
    const afterSignature = await readBounds()
    assertRestored(afterSignature, 'signature transition return')
    await assertNoStaleTransition('after signature transition')

    // Reduced motion must keep the same outcome without the travel.
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    await cdp.click('.pip-presence-orb-trigger', 'reduced motion: PiP → Main')
    await cdp.waitFor("document.querySelector('.jarvis-shell')?.dataset.view === 'command-center' && document.querySelector('.jarvis-shell')?.dataset.phase === 'idle'", 'reduced motion: Main reached')
    const reducedMain = await coreFrame()
    assert(reducedMain.phase === 'idle' && reducedMain.hasContent, `reduced motion opening did not complete: ${JSON.stringify(reducedMain)}`)
    assert(!reducedMain.entering, `reduced motion still runs the content entrance: ${JSON.stringify(reducedMain)}`)
    await cdp.shot('transition-08-reduced-motion-main')
    await cdp.click('.core-trigger', 'reduced motion: Main → PiP')
    await cdp.waitFor("document.querySelector('.jarvis-shell')?.dataset.view === 'pip' && document.querySelector('.jarvis-shell')?.dataset.phase === 'idle'", 'reduced motion: PiP reached')
    const reducedPip = await readBounds()
    assertRestored(reducedPip, 'reduced motion return')
    await cdp.send('Emulation.setEmulatedMedia', { features: [] })

    console.log('WORKSPACE EXPLORER + PIP ACCEPTANCE PASS')
  } catch (error) {
    console.error(`WORKSPACE EXPLORER + PIP ACCEPTANCE FAILED: ${error.stack || error}`)
    process.exitCode = 1
  } finally {
    try { cdp?.ws.close() } catch { /* */ }
    for (const child of children) { try { child.kill() } catch { /* */ } }
    try { stub?.server.close() } catch { /* */ }
  }
}

main()
