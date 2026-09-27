/*
  Measures the real rendered PiP ↔ Main signature transition.

  Everything is sampled inside the renderer on requestAnimationFrame, because a
  200ms poll from the test process cannot see a 750ms transform and would invent
  timings that do not exist.

  For each direction it reports:
    - Core screen rect per frame (FLIP origin accuracy + travel)
    - the ::before clip-path radius and centre (background reveal progress)
    - when workspace content first becomes visible
    - the phase sequence actually entered

  Usage: node tests/measure_signature_motion.cjs
*/
const { spawn, spawnSync } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const net = require('node:net')
const http = require('node:http')

const APP_ROOT = path.join(__dirname, '..')
const HARNESS_HOME = process.env.JARVIS_HARNESS_HOME || path.join(os.homedir(), 'Desktop', 'FB_Soap_LocalLLM')
const ARTIFACT_DIR = path.join(__dirname, 'artifacts', 'signature-motion')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

async function waitForHttp(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ok = await new Promise((resolve) => {
      const request = http.get(url, (response) => { response.resume(); resolve(response.statusCode === 200) })
      request.on('error', () => resolve(false))
      request.setTimeout(2000, () => { request.destroy(); resolve(false) })
    })
    if (ok) return true
    await sleep(300)
  }
  return false
}

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.sequence = 0
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
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'evaluate failed')
    return result.result?.value
  }
  async waitFor(expression, message, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (await this.evaluate(`return Boolean(${expression})`)) return
      await sleep(120)
    }
    throw new Error(`timeout: ${message}`)
  }
  async click(selector) {
    const point = await this.evaluate(`
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    `)
    if (!point) throw new Error(`not found: ${selector}`)
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1, buttons: 1 })
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1, buttons: 0 })
  }
  async shot(name) {
    fs.mkdirSync(ARTIFACT_DIR, { recursive: true })
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' })
    const file = path.join(ARTIFACT_DIR, `${name}.png`)
    fs.writeFileSync(file, Buffer.from(data, 'base64'))
    return file
  }
}

/* Runs entirely in the renderer: one rAF sample per frame. */
const SAMPLER = `
  window.__startSampling = (durationMs) => new Promise((resolve) => {
    const shell = document.querySelector('.jarvis-shell');
    const samples = [];
    const phases = [];
    const start = performance.now();
    const tick = () => {
      const now = performance.now();
      window.__unparsedClip = null;
      const core = document.querySelector('.core-container');
      const coreRect = core ? core.getBoundingClientRect() : null;
      const before = shell ? getComputedStyle(shell, '::before') : null;
      const clip = before ? before.clipPath : 'none';
      const radius = (() => {
        const match = /circle\\(([0-9.]+)(px|vmax|%)/.exec(clip || '');
        return match ? Number(match[1]) : null;
      })();
      // The circle's centre is the point of this measurement: the reveal has to
      // travel with the Core, not stay parked where PiP used to be.
      const centre = (() => {
        // Serialised as circle(<radius> at <x> <y>); the keyword sits inside the parens.
        const match = /circle\\([^)]*?at\\s+(-?[0-9.]+)px\\s+(-?[0-9.]+)px\\s*\\)/.exec(clip || '');
        if (!match) {
          // Keep an unparsed value so a serialisation change is visible
          // instead of silently producing a column of dashes.
          if (clip && clip !== 'none' && !window.__unparsedClip) window.__unparsedClip = clip;
          return null;
        }
        const shellRect = shell ? shell.getBoundingClientRect() : null;
        if (!shellRect) return null;
        return {
          // Local (shell-relative) then normalised to screen so it can be
          // differenced against the Core's screen rect directly.
          localX: Number(match[1]),
          localY: Number(match[2]),
          x: Math.round(shellRect.left + Number(match[1]) + window.screenX),
          y: Math.round(shellRect.top + Number(match[2]) + window.screenY),
        };
      })();
      const surface = document.querySelector('.command-panel-runtime');
      const surfaceVisible = Boolean(surface && surface.getClientRects().length);
      const phase = shell?.dataset.phase;
      if (phases[phases.length - 1] !== phase) phases.push(phase);
      /*
        Coverage is the question that decides the duration: the reveal is only
        perceptually finished once the circle reaches the farthest corner of the
        viewport measured from wherever its centre currently is. Past that point the
        radius keeps growing invisibly and only a sub-pixel centre drift remains, so
        any duration beyond it is dead tail.
      */
      const coverage = (() => {
        if (radius === null || !centre || !shell) return null;
        const rect = shell.getBoundingClientRect();
        const corners = [[0, 0], [rect.width, 0], [0, rect.height], [rect.width, rect.height]];
        const needed = Math.max(...corners.map(([x, y]) => Math.hypot(x - centre.localX, y - centre.localY)));
        return { needed: Math.round(needed), complete: radius >= needed };
      })();
      samples.push({
        t: Math.round(now - start),
        phase,
        view: shell?.dataset.view,
        // Screen coordinates, so the FLIP origin can be compared across the swap.
        coreX: coreRect ? Math.round(coreRect.left + window.screenX) : null,
        coreY: coreRect ? Math.round(coreRect.top + window.screenY) : null,
        coreW: coreRect ? Math.round(coreRect.width) : null,
        coreOpacity: core ? Number(getComputedStyle(core).opacity) : null,
        transform: core ? getComputedStyle(core).transform : null,
        revealRadius: radius,
        coverageNeeded: coverage ? coverage.needed : null,
        coverageComplete: coverage ? coverage.complete : null,
        revealX: centre ? centre.x : null,
        revealY: centre ? centre.y : null,
        revealLocalX: centre ? centre.localX : null,
        revealLocalY: centre ? centre.localY : null,
        contentVisible: surfaceVisible,
        contentOpacity: surface ? Number(getComputedStyle(surface).opacity) : null,
      });
      if (now - start < durationMs) requestAnimationFrame(tick);
      else resolve({ samples, phases, unparsedClip: window.__unparsedClip });
    };
    requestAnimationFrame(tick);
  });
  return true;
`

function analyse(label, run) {
  const { samples, phases, unparsedClip } = run
  const first = samples[0]
  const last = samples[samples.length - 1]
  const contentFirst = samples.find((sample) => sample.contentVisible)
  const revealFirst = samples.find((sample) => (sample.revealRadius ?? 0) > 0)
  const revealLastMoving = [...samples].reverse().find((sample) => sample.t < (last?.t ?? 0) - 120 && (sample.revealRadius ?? 0) > 0)
  const distinctReveal = new Set(samples.map((sample) => sample.revealRadius)).size
  console.log(`\n=== ${label} ===`)
  console.log(`  duration sampled : ${last.t}ms over ${samples.length} frames`)
  console.log(`  phases           : ${JSON.stringify(phases)}`)
  console.log(`  core first frame : (${first.coreX}, ${first.coreY}) ${first.coreW}px`)
  console.log(`  core last frame  : (${last.coreX}, ${last.coreY}) ${last.coreW}px`)
  console.log(`  reveal radii     : ${distinctReveal} distinct values, max ${Math.max(...samples.map((s) => s.revealRadius ?? 0))}`)
  console.log(`  content visible  : ${contentFirst ? `first at ${contentFirst.t}ms` : 'never'}`)
  console.log(`  content opacity  : ${contentFirst ? `${contentFirst.contentOpacity} at first visible frame` : 'n/a'}`)
  // The frame-by-frame track is the real motion evidence.
  const withCentre = samples.filter((s) => s.revealX !== null)
  const distinctCentre = new Set(withCentre.map((s) => `${s.revealX},${s.revealY}`)).size
  // Compare centres, not edges: the Core rect and the reveal centre are different
  // kinds of number and differencing the left edge against a centre is meaningless.
  const centreOf = (s) => (s.coreX === null ? null : { x: s.coreX + s.coreW / 2, y: s.coreY + s.coreW / 2 })
  const gapOf = (s) => {
    const centre = centreOf(s)
    if (!centre || s.revealX === null) return null
    return Math.round(Math.hypot(centre.x - s.revealX, centre.y - s.revealY))
  }
  const gaps = samples.map((s) => ({ t: s.t, gap: gapOf(s) })).filter((g) => g.gap !== null)
  const maxGap = gaps.length ? Math.max(...gaps.map((g) => g.gap)) : null
  const firstGap = gaps[0]?.gap ?? null
  const lastGap = gaps[gaps.length - 1]?.gap ?? null
  console.log(`  reveal centres  : ${distinctCentre} distinct values, ${withCentre[0]?.revealX},${withCentre[0]?.revealY} -> ${withCentre[withCentre.length - 1]?.revealX},${withCentre[withCentre.length - 1]?.revealY}`)
  console.log(`  core~reveal gap : ${firstGap}px at start, peak ${maxGap}px, ${lastGap}px at reveal end`)
  if (unparsedClip) console.log(`  unparsed clip   : ${unparsedClip}`)

  // Only the motion window is interesting; the settled tail is one repeated row.
  const lastMoving = [...samples].reverse().find((s) => s.revealX !== null || (s.phase && s.phase !== 'idle'))
  const cutoff = Math.max(
    samples.findIndex((s) => s.phase === 'idle' && s.revealX === null && (samples[samples.length - 1].contentOpacity ?? 0) > 0.99),
    lastMoving ? lastMoving.t + 200 : 0,
  )
  /*
    Calibration summary. The duration is only justified if it sits close to the moment
    the screen is actually covered, while still finishing at or after the Core settles
    so the Core stays the thing that leads.
  */
  const centreNow = centreOf;
  const withCore = samples.filter((s) => s.revealX !== null && s.coreX !== null);
  if (withCore.length > 2) {
    const finalCore = centreNow(withCore[withCore.length - 1]);
    const coreSettledAt = (() => {
      for (const s of withCore) {
        const c = centreNow(s);
        if (c && Math.hypot(c.x - finalCore.x, c.y - finalCore.y) <= 3) return s.t;
      }
      return null;
    })();
    /*
      The reveal's end is when the circle stops moving, not when the sampler stops.
      The settled Main state keeps a full-size circle for the rest of the session, so
      reading the last sampled frame would report the whole sampling window as a
      "duration" and hide exactly the tail this is meant to measure. Walk backwards
      from the final value to the last frame that still differed from it.
    */
    const last = withCore[withCore.length - 1];
    let revealDoneAt = last.t;
    for (let index = withCore.length - 1; index >= 0; index -= 1) {
      const s = withCore[index];
      const moved = Math.hypot(s.revealX - last.revealX, s.revealY - last.revealY) > 1
        || Math.abs((s.revealRadius ?? 0) - (last.revealRadius ?? 0)) > 2;
      if (moved) { revealDoneAt = withCore[index + 1]?.t ?? s.t; break; }
      revealDoneAt = s.t;
    }
    const coverageAt = samples.find((s) => s.coverageComplete === true)?.t ?? null;
    const contentStartAt = samples.find((s) => s.contentVisible)?.t ?? null;
    console.log('  calibration');
    console.log(`    Core visually settles : ${coreSettledAt}ms`);
    console.log(`    reveal stops moving   : ${revealDoneAt}ms`);
    console.log(`    screen fully covered  : ${coverageAt}ms`);
    console.log(`    content starts        : ${contentStartAt}ms`);
    const lead = coreSettledAt !== null ? revealDoneAt - coreSettledAt : null;
    console.log(`    reveal vs Core        : ${lead === null ? 'n/a' : lead > 0 ? `workspace trails the Core by ${lead}ms` : `reveal finishes ${Math.abs(lead)}ms BEFORE the Core settles`}`);
  }

  console.log('  track  t | phase | core ctr | reveal ctr | dist | r | covered | content')
  for (let index = 0; index < samples.length; index += 2) {
    const s = samples[index]
    if (s.t > cutoff && s.contentOpacity === 1) break
    const centre = centreOf(s)
    console.log(`    ${String(s.t).padStart(4)} | ${String(s.phase).padEnd(16)} | ${String(centre ? `${Math.round(centre.x)},${Math.round(centre.y)}` : '-').padEnd(11)} | ${String(s.revealX === null ? '-' : `${s.revealX},${s.revealY}`).padEnd(11)} | ${String(gapOf(s) ?? '-').padStart(4)} | ${String(s.revealRadius ?? '-').padStart(4)} | ${s.coverageComplete === null ? '-' : s.coverageComplete ? 'yes' : `no(${s.coverageNeeded})`} | ${s.contentVisible ? s.contentOpacity : '-'}`)
  }
  return { samples, phases, contentFirst, revealFirst, revealLastMoving, maxGap, distinctCentre, firstGap, lastGap, gaps }
}

async function main() {
  const children = []
  let cdp = null
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-motion-'))
  try {
    const stateDir = path.join(scratch, 'state')
    const workspaceDir = path.join(scratch, 'workspace')
    const vitePort = await freePort()
    const cdpPort = await freePort()

    const fixture = spawnSync('python', ['-m', 'scripts.gui_e2e_fixture', '--state-dir', stateDir, '--workspace-dir', workspaceDir], {
      cwd: HARNESS_HOME, encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    })
    if (fixture.status !== 0) throw new Error(`fixture failed: ${fixture.stderr || fixture.stdout}`)

    const run = (command, args, env) => {
      const child = spawn(command, args, { cwd: APP_ROOT, env: { ...process.env, ...env }, stdio: 'ignore', windowsHide: true })
      children.push(child)
    }
    run(process.execPath, [path.join(APP_ROOT, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'], {})
    const viteUrl = `http://127.0.0.1:${vitePort}/`
    if (!await waitForHttp(viteUrl)) throw new Error('vite did not start')

    run(require('electron'), ['.', `--remote-debugging-port=${cdpPort}`], {
      JARVIS_STATE_DIR: stateDir,
      JARVIS_DEV_URL: viteUrl,
      JARVIS_HARNESS_HOME: HARNESS_HOME,
    })
    cdp = await Cdp.attach(cdpPort)

    await cdp.waitFor("Boolean(document.querySelector('.jarvis-shell'))", 'shell mounted')
    await cdp.evaluate(SAMPLER)
    await sleep(1500)

    // Go to PiP first so the measurement covers the real PiP → Main path.
    await cdp.evaluate(`
      const core = document.querySelector('.core-trigger');
      if (core && document.querySelector('.jarvis-shell')?.dataset.view === 'command-center') core.click();
      return true;
    `)
    await cdp.waitFor("document.querySelector('.jarvis-shell')?.dataset.view === 'pip'", 'PiP view')
    await sleep(900)
    await cdp.shot('motion-00-pip-idle')

    const pipOrigin = await cdp.evaluate(`
      const core = document.querySelector('.pip-presence-orb') || document.querySelector('.core-container');
      const r = core.getBoundingClientRect();
      return { x: Math.round(r.left + window.screenX), y: Math.round(r.top + window.screenY), w: Math.round(r.width), h: Math.round(r.height) };
    `)
    console.log(`PiP idle Core screen origin: ${JSON.stringify(pipOrigin)}`)

    const openingPromise = cdp.evaluate('return window.__startSampling(2600)')
    await cdp.click('.pip-presence-orb-trigger')
    const opening = analyse('OPENING  PiP → Main', await openingPromise)
    await cdp.shot('motion-01-opening-final')

    await sleep(700)
    await cdp.shot('motion-02-main-settled')

    const closingPromise = cdp.evaluate('return window.__startSampling(2000)')
    await cdp.click('.core-trigger')
    const closing = analyse('CLOSING  Main → PiP', await closingPromise)
    await cdp.shot('motion-03-closing-final')

    await sleep(700)
    await cdp.shot('motion-04-pip-settled')

    // FLIP accuracy: the first opening frame should sit on the PiP Core position.
    // Compare centres, because the PiP orb and the Main Core are different elements
    // with different box sizes.
    const firstOpening = opening.samples.find((sample) => sample.coreX !== null)
    const pipCenter = { x: pipOrigin.x + pipOrigin.w / 2, y: pipOrigin.y + pipOrigin.h / 2 }
    const openCenter = { x: firstOpening.coreX + firstOpening.coreW / 2, y: firstOpening.coreY + firstOpening.coreW / 2 }
    const dx = Math.round(openCenter.x - pipCenter.x)
    const dy = Math.round(openCenter.y - pipCenter.y)
    console.log(`\n=== FLIP origin accuracy (centres) ===`)
    console.log(`  PiP orb centre      : (${Math.round(pipCenter.x)}, ${Math.round(pipCenter.y)}) w=${pipOrigin.w}`)
    console.log(`  first opening frame : (${Math.round(openCenter.x)}, ${Math.round(openCenter.y)}) w=${firstOpening.coreW} @${firstOpening.t}ms phase=${firstOpening.phase}`)
    console.log(`  delta               : dx=${dx} dy=${dy}`)

    // The Core must actually travel rather than teleport on the view flip.
    const travel = opening.samples.filter((s) => s.coreX !== null)
    const movedPx = Math.hypot(
      travel[travel.length - 1].coreX - travel[0].coreX,
      travel[travel.length - 1].coreY - travel[0].coreY,
    )
    const positions = new Set(travel.map((s) => `${s.coreX},${s.coreY}`))
    console.log(`  Core travel         : ${Math.round(movedPx)}px over ${positions.size} distinct positions`)
    const settled = travel[travel.length - 1]
    const coreAfterFlip = opening.samples.filter((s) => s.phase === 'idle' && s.coreX !== null)[0]
    console.log(`  view-flip jump      : ${coreAfterFlip ? `${Math.round(Math.hypot(settled.coreX - coreAfterFlip.coreX, settled.coreY - coreAfterFlip.coreY))}px` : 'n/a'}`)

    fs.writeFileSync(
      path.join(ARTIFACT_DIR, 'motion-samples.json'),
      JSON.stringify({ pipOrigin, opening, closing }, null, 2),
    )
    console.log(`\nsamples written to ${path.join(ARTIFACT_DIR, 'motion-samples.json')}`)
  } catch (error) {
    console.error(`MEASURE FAILED: ${error.stack || error}`)
    process.exitCode = 1
  } finally {
    try { cdp?.ws.close() } catch { /* */ }
    for (const child of children) { try { child.kill() } catch { /* */ } }
  }
}

main()
