// -*- coding: utf-8 -*-
/**
 * node-side STT worker transport 검증 (race-free).
 *
 * 이전 실패 원인: "응답이 이미 다른 listener로 소비된 뒤에야 waiter를 붙이는"
 * 경쟁 조건이었다 — 전송 계층 문제가 아니었다 (probe에서 boot/voice_ready/
 * transcript가 파이프를 통해 정상 도착함을 확인).
 *
 * 이 테스트는 단일 rl.on('line') 수집기 하나가 모든 메시지를 공유 버퍼에
 * 넣고, waiter는 그 버퍼를 폴링한다. 메시지가 이미 도착했어도 절대 놓치지
 * 않는다. Electron main이 실제로 사용하는 spawn + JSONL stdin/stdout 경로를
 * 그대로 검증한다.
 */
const { spawn } = require('node:child_process')
const readline = require('node:readline')
const path = require('node:path')
const fs = require('node:fs')

const REPO_ROOT = path.resolve(__dirname, '..')
const WORKER_SCRIPT = path.join(REPO_ROOT, 'electron', 'voice-worker', 'stt_worker.py')
// Python for the voice worker: env override → PYTHON → PATH (portable; no committed machine path)
const LEGACY_PYTHON = process.env.JARVIS_VOICE_PYTHON || process.env.PYTHON || 'python'
const FIXTURES = [
  path.join(REPO_ROOT, 'data', 'voice_stt_fixtures', 'ko_hello_jarvis.wav'),
  path.join(REPO_ROOT, 'data', 'voice_stt_fixtures', 'ko_write_task.wav'),
]

function send(proc, msg) {
  proc.stdin.write(JSON.stringify(msg) + '\n')
}

function waitFor(buffer, predicate, { timeoutMs = 30000, label = '' } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const timer = setInterval(() => {
      const hit = buffer.find(predicate)
      if (hit) {
        clearInterval(timer)
        resolve(hit)
        return
      }
      if (Date.now() - started > timeoutMs) {
        clearInterval(timer)
        reject(new Error(`${label || 'waitFor'} timeout (${timeoutMs}ms) — 수집된 메시지: ${buffer.map((m) => `${m.type}:${m.id ?? '-'}:${m.status ?? ''}`).join(', ')}`))
      }
    }, 50)
  })
}

async function main() {
  console.log('=== node-side STT worker transport 검증 (race-free) ===')
  console.log('worker script :', WORKER_SCRIPT, ' exists=', fs.existsSync(WORKER_SCRIPT))
  console.log('python        :', LEGACY_PYTHON, ' exists=', fs.existsSync(LEGACY_PYTHON))
  for (const f of FIXTURES) console.log('fixture       :', path.basename(f), ' exists=', fs.existsSync(f))

  const proc = spawn(LEGACY_PYTHON, [WORKER_SCRIPT], {
    cwd: REPO_ROOT,
    env: { ...process.env },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })

  const collected = []
  const stderrChunks = []
  let exitInfo = null

  proc.stderr.on('data', (c) => {
    const t = c.toString().trim()
    if (t) stderrChunks.push(t)
  })
  proc.on('exit', (code, signal) => {
    exitInfo = { code, signal }
  })
  proc.on('error', (err) => {
    stderrChunks.push('spawn error: ' + err.message)
  })

  const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity })
  rl.on('line', (raw) => {
    const trimmed = raw.trim()
    if (!trimmed) return
    try {
      collected.push(JSON.parse(trimmed))
    } catch {
      console.warn('   주의: stdout에 프로토콜이 아닌 줄:', trimmed.slice(0, 200))
    }
  })

  // 1) voice_ready — worker 시작 + 모델 로드 완료 확인
  console.log('\n[1] voice_ready 대기...')
  const ready = await waitFor(collected, (m) => m.type === 'voice_ready' && m.status === 'ready', { timeoutMs: 90000, label: 'voice_ready' })
  console.log('   수신: model=', ready.model, 'device=', ready.device, 'compute_type=', ready.compute_type)
  console.log('   model_load_seconds=', ready.model_load_seconds, 'language_default=', ready.language_default)
  console.log('   sounddevice_available=', ready.sounddevice_available, 'devices_total=', ready.devices_total)
  console.log('   mic 입력 장치 수=', (ready.mic_input_devices || []).length,
    ready.mic_input_devices && ready.mic_input_devices.length ? `(예: ${ready.mic_input_devices[0].name})` : '')

  // 2) 두 개의 전사 요청 (연속 왕복, correlation id 검증)
  const firstReqId = 700
  console.log('\n[2] transcribe_file 왕복 1/2 (id=', firstReqId, ')...')
  send(proc, { type: 'transcribe_file', id: firstReqId, path: FIXTURES[0] })
  const first = await waitFor(collected, (m) => m.id === firstReqId && m.type === 'transcript', { label: 'transcript#1' })
  console.log('   수신: ok=', first.ok, 'text=', JSON.stringify(first.text), 'transcribe_s=', first.transcribe_seconds)

  const secondReqId = 701
  console.log('\n[3] transcribe_file 왕복 2/2 (id=', secondReqId, ') — worker 생존 확인...')
  send(proc, { type: 'transcribe_file', id: secondReqId, path: FIXTURES[1] })
  const second = await waitFor(collected, (m) => m.id === secondReqId && m.type === 'transcript', { label: 'transcript#2' })
  console.log('   수신: ok=', second.ok, 'text=', JSON.stringify(second.text), 'transcribe_s=', second.transcribe_seconds)

  // 같은 모델이 재사용됐는지 (두 왕복 모두 프로세스 생존 + 같은 model_loaded_at)
  const loadedOnce = first.ok && second.ok && first.model_loaded_at === second.model_loaded_at
  console.log('\n[4] 모델 단일 로드 재사용: model_loaded_at 일치 =', loadedOnce,
    `(${first.model_loaded_at} vs ${second.model_loaded_at})`)
  if (!loadedOnce) throw new Error('두 전사가 서로 다른 model_loaded_at — 모델 재사용 실패')

  // 3) shutdown → 정상 종료
  console.log('\n[5] shutdown 전송...')
  send(proc, { type: 'shutdown' })
  const exiting = await waitFor(collected, (m) => m.type === 'voice_ready' && m.status === 'exiting', { timeoutMs: 10000, label: 'voice_ready(exiting)' })
  console.log('   voice_ready(exiting) 수신')
  await new Promise((r) => setTimeout(r, 500))
  console.log('   exit code=', exitInfo && exitInfo.code, 'signal=', exitInfo && exitInfo.signal)
  if (!exitInfo || exitInfo.code !== 0) throw new Error('worker가 0으로 종료하지 않음')

  if (stderrChunks.length) {
    console.log('\n[stderr]')
    for (const c of stderrChunks) console.log('  ', c)
  }

  // 프로토콜 무결성: 수집된 모든 줄이 유효 JSON이고 type을 가져야 함
  const bad = collected.filter((m) => !m || !m.type)
  if (bad.length) throw new Error('프로토콜이 아닌 메시지 존재')

  console.log('\n=== RESULT ===')
  console.log('PASS: voice_ready → transcribe_file 왕복 2회(correlation 정상, JSONL 타임아웃 없음)')
  console.log('      → worker 생존 + 모델 재사용 → shutdown 정상 종료(exit 0)')
  console.log('Electron이 이와 동일한 spawn+readline 경로로 stt_worker.py를 구동할 수 있다.')
}

main().catch((err) => {
  console.error('FAIL:', err.message)
  process.exit(2)
})
