/*
  Task 1·4 증거 스크립트 — Electron main이 사용하는 BridgeManager를 그대로
  사용해 실제 Python Harness bridge + 실제 Qwen(local-jarvis-qwen3:8b)로
  전체 흐름을 검증한다 (GUI 없이 main-process 로직 증명).

  흐름:
    ping
    chat "할 일 보여줘"                → final (list_current_tasks)
    chat "task 추가해줘"               → awaiting_confirmation (create_task)
    reject                              → rejected (0변이 — 다시 조회해 확인)
    chat "task 추가해줘" (재시도)      → awaiting_confirmation
    confirm                             → final (정확히 1회 실행)
    chat "목록 다시 보여줘"            → final (count 1, read-back)

  실행: node scripts/bridge_smoke.cjs
  실패 시 exit 1.
*/
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const { BridgeManager } = require('../electron/bridge-manager.cjs')

const HARNESS_HOME =
  process.env.JARVIS_HARNESS_HOME ||
  path.join(os.homedir(), 'Desktop', 'FB_Soap_LocalLLM')

/*
  격리 scratch 초기화 — 0변이 증거를 애매하게 만들지 않는다.
  data/electron_scratch는 순수 테스트 상태이므로 시작 전에 비운다.
*/
const scratchDir = path.join(HARNESS_HOME, 'data', 'electron_scratch')
if (fs.existsSync(scratchDir)) {
  fs.rmSync(scratchDir, { recursive: true, force: true })
  console.log(`scratch 초기화: ${scratchDir}`)
}

const LIST_REQUEST =
  'jarvis-app 프로젝트의 현재 진행 중인 task 목록을 list_current_tasks 도구로 조회해서 알려줘.'

const CREATE_REQUEST =
  "jarvis-app 프로젝트에 'PiP 통합 확인' 제목의 task 하나를 create_task 도구로 추가해줘. 이유는 'electron 브리지 스모크'야. 반드시 create_task 도구를 호출해서 추가해줘."

function fail(message) {
  console.error(`[FAIL] ${message}`)
  process.exitCode = 1
  return false
}

async function main() {
  const manager = new BridgeManager({
    harnessHome: HARNESS_HOME,
    onStderr: (text) => console.error(`[bridge-stderr] ${text}`),
  })

  console.log(`harness home: ${HARNESS_HOME}`)

  const ping = await manager.ping()
  if (ping.status !== 'ok') {
    return fail(`ping 실패: ${JSON.stringify(ping)}`)
  }
  console.log('PING: ok')

  // 1) read: list_current_tasks
  const read1 = await manager.chat(LIST_REQUEST, 'jarvis-app')
  if (read1.status !== 'final') {
    return fail(`read#1: status=${read1.status} ${JSON.stringify(read1.error || '')}`)
  }
  const read1Tools = (read1.events || [])
    .filter((event) => event.kind === 'tool')
    .map((event) => event.name)
  if (!read1Tools.includes('list_current_tasks')) {
    return fail(`read#1: list_current_tasks 호출 없음 — events=${JSON.stringify(read1Tools)}`)
  }
  console.log(`READ#1: final (tools=${read1Tools.join(', ')}, trace=${read1.trace_id})`)
  console.log(`  QWEN: ${(read1.text || '').slice(0, 160)}`)

  // 2) write 제안 → permission gate
  const proposal = await manager.chat(CREATE_REQUEST, 'jarvis-app')
  if (proposal.status !== 'awaiting_confirmation') {
    return fail(`proposal: status=${proposal.status} ${JSON.stringify(proposal.error || '')}`)
  }
  const toolCall = proposal.tool_call
  console.log(`PROPOSAL: awaiting_confirmation (${toolCall.name}${JSON.stringify(toolCall.arguments)})`)

  // 3) reject → 0변이 확인
  const rejected = await manager.reject(toolCall)
  if (rejected.status !== 'rejected') {
    return fail(`reject: status=${rejected.status} ${JSON.stringify(rejected)}`)
  }
  const readAfterReject = await manager.chat(
    'jarvis-app 프로젝트의 현재 task 목록을 list_current_tasks 도구로 조회해서 알려줘.',
    'jarvis-app',
  )
  const countAfterReject =
    readAfterReject.events
      ?.filter((event) => event.kind === 'tool' && event.name === 'list_current_tasks')
      .map((event) => (event.data || {}).count)
      .pop()
  console.log(`REJECT: rejected — 0변이 확인 (list count=${countAfterReject})`)
  if (countAfterReject !== 0) {
    return fail(`reject 후 변이 발생 — count=${countAfterReject}`)
  }

  // 4) 다시 제안 → confirm → 정확히 1회 실행
  const proposal2 = await manager.chat(CREATE_REQUEST, 'jarvis-app')
  if (proposal2.status !== 'awaiting_confirmation') {
    return fail(`proposal#2: status=${proposal2.status}`)
  }
  const confirmed = await manager.confirm(proposal2.tool_call)
  if (confirmed.status !== 'final') {
    return fail(`confirm: status=${confirmed.status} ${JSON.stringify(confirmed.error || '')}`)
  }
  const confirmTools = (confirmed.events || [])
    .filter((event) => event.kind === 'tool')
    .map((event) => `${event.name}:${event.ok ? 'ok' : 'fail'}`)
  console.log(`CONFIRM: final (${confirmTools.join(', ')}, trace=${confirmed.trace_id})`)
  console.log(`  QWEN: ${(confirmed.text || '').slice(0, 160)}`)

  // 5) read-back
  const read2 = await manager.chat(LIST_REQUEST, 'jarvis-app')
  const count =
    read2.events
      ?.filter((event) => event.kind === 'tool' && event.name === 'list_current_tasks')
      .map((event) => (event.data || {}).count)
      .pop()
  console.log(`READ-BACK: final (count=${count}, trace=${read2.trace_id})`)
  if (count !== 1) {
    return fail(`read-back count=${count}, 기대 1`)
  }

  await manager.shutdown()
  console.log('SMOKE PASS — Electron BridgeManager ↔ Python bridge ↔ Qwen 전체 흐름 확인.')
  return true
}

main().then((ok) => {
  if (!ok) process.exit(1)
})