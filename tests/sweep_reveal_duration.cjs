/*
  Reveal duration calibration.

  Patches the single opening-reveal duration token in App.css, runs the same rAF
  measurement used elsewhere, and restores the file from an in-memory copy before
  anything else happens — including on failure, so the stylesheet is never left
  patched between runs.

  Usage: node tests/sweep_reveal_duration.cjs 500 650 800
*/
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const APP_ROOT = path.join(__dirname, '..')
const CSS_PATH = path.join(APP_ROOT, 'src', 'App.css')
const BASELINE = Number(process.env.BASELINE_MS || 950)
const LINE_INDEX = 1125

const original = fs.readFileSync(CSS_PATH, 'utf8')
const lines = original.split('\n')

if (!new RegExp(`^\\s*${BASELINE}ms`).test(lines[LINE_INDEX])) {
  console.error(`ABORT: line ${LINE_INDEX + 1} is not the ${BASELINE}ms reveal token: ${JSON.stringify(lines[LINE_INDEX])}`)
  process.exit(1)
}

const candidates = process.argv.slice(2).map(Number)
if (candidates.some((value) => !Number.isFinite(value) || value <= 0)) {
  console.error('ABORT: candidates must be positive numbers')
  process.exit(1)
}

const restore = () => {
  fs.writeFileSync(CSS_PATH, original)
  const check = fs.readFileSync(CSS_PATH, 'utf8').split('\n')[LINE_INDEX]
  console.log(`restored: ${JSON.stringify(check)}`)
}

process.on('exit', restore)
process.on('SIGINT', () => { restore(); process.exit(130) })

for (const ms of candidates) {
  const patched = lines.slice()
  patched[LINE_INDEX] = patched[LINE_INDEX].replace(`${BASELINE}ms`, `${ms}ms`)
  fs.writeFileSync(CSS_PATH, patched.join('\n'))
  console.log(`\n########## REVEAL ${ms}ms ##########`)
  const run = spawnSync(process.execPath, [path.join(__dirname, 'measure_signature_motion.cjs')], {
    cwd: APP_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  })
  const output = `${run.stdout || ''}${run.stderr || ''}`
  const block = output.slice(output.indexOf('=== OPENING'), output.indexOf('=== CLOSING'))
  const keys = ['Core visually settles', 'reveal stops moving', 'screen fully covered', 'content starts', 'reveal vs Core', 'core~reveal gap']
  const blockLines = block.split('\n')
  for (const key of keys) {
    const line = blockLines.find((entry) => entry.includes(key))
    console.log(line ? `  ${line.trim()}` : `  ${key}: (not reported)`)
  }
  if (!blockLines.some((entry) => entry.includes('Core visually settles'))) {
    console.log(`  run status ${run.status}; output tail:`)
    for (const entry of output.split('\n').slice(-6)) console.log(`    ${entry}`)
  }
  restore()
}
