// -*- coding: utf-8 -*-
/**
 * VoiceManager(main 프로세스에서 IPC가 감싸는 실제 클래스) 검증.
 *
 * electron/voice-manager.cjs를 직접 구동해 다음을 확인한다:
 *   statusInfo(running=false) → transcribeFile(fixture) [lazy start + voice_ready
 *   핸드셰이크 + correlation] → statusInfo(ready=true) → shutdown.
 *
 * 결정적(fixture WAV). 마이크를 열지 않는다.
 */
const path = require('node:path')
const fs = require('node:fs')

const { VoiceManager } = require(path.resolve(__dirname, '..', 'electron', 'voice-manager.cjs'))

const REPO_ROOT = path.resolve(__dirname, '..')
const WORKER_SCRIPT = path.join(REPO_ROOT, 'electron', 'voice-worker', 'stt_worker.py')
const FIXTURE = path.join(REPO_ROOT, 'data', 'voice_stt_fixtures', 'ko_hello_jarvis.wav')
// Python for the voice worker: env override → PYTHON → PATH (portable; no committed machine path)
const LEGACY_PYTHON = process.env.JARVIS_VOICE_PYTHON || process.env.PYTHON || 'python'

async function main() {
  console.log('=== VoiceManager 클래스 검증 ===')
  for (const [k, v] of [
    ['worker script', WORKER_SCRIPT],
    ['fixture', FIXTURE],
    ['python', LEGACY_PYTHON],
  ]) {
    console.log(`${k} : ${v}  exists=${fs.existsSync(v)}`)
  }

  const stderrLines = []
  const manager = new VoiceManager({
    python: LEGACY_PYTHON,
    workerScript: WORKER_SCRIPT,
    requestTimeoutMs: 120000,
    readyTimeoutMs: 120000,
    onStderr: (t) => stderrLines.push(t),
  })

  // 1) 시작 전 상태
  console.log('\n[1] 시작 전 status: running=', manager.statusInfo().running)
  if (manager.statusInfo().running) throw new Error('시작 전인데 running=true')

  // 2) transcribe_file — lazy start + ready handshake
  console.log('\n[2] transcribeFile 전송 (lazy start)...')
  const started = Date.now()
  const res = await manager.transcribeFile(FIXTURE)
  const elapsed = Date.now() - started
  console.log(`   status=${res.status} elapsed_ms=${elapsed}`)
  console.log('   ok=', res.ok, 'error=', res.error || '-')
  console.log('   text=', JSON.stringify(res.text))
  console.log('   language=', res.language, 'transcribe_s=', res.transcribe_seconds)
  if (res.status !== 'ok' || !res.ok) throw new Error('전사 실패: ' + (res.error || res.status))

  // 3) ready 상태
  console.log('\n[3] 전사 후 status: running=', manager.statusInfo().running, 'ready=', manager.statusInfo().ready)
  const info = manager.statusInfo()
  console.log('   model=', info.model, 'device=', info.device, 'load_s=', info.model_load_seconds)
  if (!info.running || !info.ready) throw new Error('worker가 ready 상태가 아님')
  if (!(info.mic_input_devices || []).length) throw new Error('마이크 장치가 하나도 없음')

  // 4) 두 번째 요청 — worker 생존 + 핸드셰이크 재사용
  console.log('\n[4] 두 번째 transcribeFile (worker 생존 확인)...')
  const res2 = await manager.transcribeFile(FIXTURE)
  console.log('   ok=', res2.ok, 'text=', JSON.stringify(res2.text))
  if (!res2.ok) throw new Error('두 번째 전사 실패')

  // 5) shutdown
  console.log('\n[5] shutdown...')
  await manager.shutdown()
  console.log('   running(종료 후)=', manager.statusInfo().running)

  if (stderrLines.length) {
    console.log('\n[stderr]')
    for (const l of stderrLines) console.log('  ', l)
  }

  console.log('\n=== RESULT ===')
  console.log('PASS: VoiceManager lazy start → voice_ready → correlated transcribe_file 2회 → shutdown')
  console.log('      IPC(voice:record-*, voice:transcribe-file)가 감싸는 경로가 동작함')
}

main().catch((err) => {
  console.error('FAIL:', err.message)
  process.exit(2)
})
