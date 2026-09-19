// -*- coding: utf-8 -*-
/**
 * 마이크 record 왕복 검증 (device-dependent, transcribe=false).
 *
 * Electron이 실제로 사용할 JSONL 경로로 다음을 왕복시킨다:
 *   voice_ready → record_start → recording_started
 *              → (클라이언트가 2초 유지)
 *              → record_stop(transcribe=false) → recording_result
 *              → shutdown
 *
 * 실제 USB 마이크를 ~2초 연다. transcribe=false이므로 STT를 돌리지 않고
 * 녹음 메트릭(시간/RMS/피크)만 확인한다 — 방음/주변음과 무관하게 결정적.
 * 조용한 방이면 silent:true, 소음이 있으면 silent:false로 나올 수 있다.
 * 둘 다 정상이며, 성공 기준은 기록이 실제로 캡처되었는가다.
 */
const { spawn } = require('node:child_process')
const readline = require('node:readline')
const path = require('node:path')
const fs = require('node:fs')

const REPO_ROOT = path.resolve(__dirname, '..')
const WORKER_SCRIPT = path.join(REPO_ROOT, 'electron', 'voice-worker', 'stt_worker.py')
// Python for the voice worker: env override → PYTHON → PATH (portable; no committed machine path)
const LEGACY_PYTHON = process.env.JARVIS_VOICE_PYTHON || process.env.PYTHON || 'python'

function send(proc, msg) {
  proc.stdin.write(JSON.stringify(msg) + '\n')
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
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
        reject(new Error(`${label || 'waitFor'} timeout (${timeoutMs}ms) — 수집: ${buffer.map((m) => `${m.type}:${m.id ?? '-'}:${m.status ?? ''}`).join(', ')}`))
      }
    }, 50)
  })
}

async function main() {
  console.log('=== 마이크 record 왕복 검증 (device-dependent, transcribe=false) ===')
  console.log('worker script :', WORKER_SCRIPT, ' exists=', fs.existsSync(WORKER_SCRIPT))
  console.log('python        :', LEGACY_PYTHON, ' exists=', fs.existsSync(LEGACY_PYTHON))

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
  proc.on('error', (err) => stderrChunks.push('spawn error: ' + err.message))

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

  // 1) voice_ready
  console.log('\n[1] voice_ready 대기...')
  const ready = await waitFor(collected, (m) => m.type === 'voice_ready' && m.status === 'ready', { timeoutMs: 90000, label: 'voice_ready' })
  console.log('   수신: model=', ready.model, ' sounddevice=', ready.sounddevice_available, ' mic장치=', (ready.mic_input_devices || []).length)

  // 2) record_start
  const startId = 800
  console.log('\n[2] record_start 전송 (id=', startId, ')...')
  send(proc, { type: 'record_start', id: startId })
  const started = await waitFor(collected, (m) => m.id === startId && m.type === 'recording_started', { label: 'recording_started' })
  console.log('   수신: ok=', started.ok, 'error=', started.error || '-')
  if (started.ok) {
    console.log('   device=', started.device && started.device.name, 'samplerate=', started.samplerate)
  } else {
    console.log('   마이크 시작 실패 — 이후 단계 생략')
    send(proc, { type: 'shutdown' })
    process.exit(2)
  }

  // 3) 2초 유지 (실제로는 사용자가 말하는 동안)
  console.log('\n[3] 2초 녹음 유지...')
  await sleep(2000)

  // 4) record_stop (transcribe=false — 메트릭만)
  const stopId = 801
  console.log('\n[4] record_stop 전송 (id=', stopId, ', transcribe=false)...')
  send(proc, { type: 'record_stop', id: stopId, transcribe: false })
  const result = await waitFor(collected, (m) => m.id === stopId && m.type === 'recording_result', { timeoutMs: 20000, label: 'recording_result' })
  console.log('   수신: ok=', result.ok, 'error=', result.error || '-')
  console.log('   silent=', result.silent, 'note=', result.note || '-')
  console.log('   record:', JSON.stringify(result.record))

  const rec = result.record || {}
  const durationOk = rec.duration_s >= 1.0
  console.log('\n[검증] duration_s=', rec.duration_s, '(>=1.0 필요:', durationOk, ')')
  if (!result.ok) {
    console.log('   FAIL: record_stop이 실패 — 마이크 캡처 실패')
  } else if (!durationOk) {
    console.log('   FAIL: 캡처된 오디오가 너무 짧음')
  } else {
    console.log('   [OK] 실제 마이크 오디오가 캡처되었고 왕복이 정상')
  }

  // 5) shutdown
  send(proc, { type: 'shutdown' })
  await waitFor(collected, (m) => m.type === 'voice_ready' && m.status === 'exiting', { timeoutMs: 10000, label: 'exiting' })
  await sleep(300)
  console.log('\n[5] worker exit code=', exitInfo && exitInfo.code)

  if (stderrChunks.length) {
    console.log('\n[stderr]')
    for (const c of stderrChunks) console.log('  ', c)
  }

  const pass = result.ok && durationOk && exitInfo && exitInfo.code === 0
  console.log('\n=== RESULT ===')
  if (pass) {
    console.log('PASS: record_start → 2초 유지 → record_stop 왕복이 실마이크로 동작')
    console.log('      (silent=', result.silent, '— 조용하면 true, 주변음이 있으면 false. 둘 다 정상)')
  } else {
    console.log('FAIL: 마이크 record 왕복 실패')
  }
  process.exit(pass ? 0 : 2)
}

main().catch((err) => {
  console.error('FAIL:', err.message)
  process.exit(2)
})
