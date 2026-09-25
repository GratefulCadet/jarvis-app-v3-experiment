// -*- coding: utf-8 -*-
/**
 * Qwen이 만든 task 변경을 트리가 따라가는지 검증.
 *
 * useJarvisRuntime의 eventsMutatedTasks가 "실제로 task를 바꾼 실행"만 골라내는지
 * 확인한다. 이 판정이 틀리면 트리가 새로고침을 잘못 하거나(또는 전혀 안 하고)
 * 사용자가 트리가 낡았다고 느끼는 지점이 된다.
 *
 * 판단 기준:
 *   - ok === true인 실행만 센다 (실제로 실행된 것)
 *   - requires_confirmation이면 세지 않는다 (승인 전 차단된 제안)
 *   - 읽기 도구는 세지 않는다
 *
 * 결정적(fixture event). 브리지·모델·GUI를 실행하지 않는다.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SOURCE = path.resolve(HERE, '..', 'src', 'useJarvisRuntime.js')

/*
  useJarvisRuntime는 React 훅을 import하므로 그대로는 불러올 수 없다.
  판정 로직(eventsMutatedTasks)은 순수 함수이므로 소스에서 그대로 추출해
  같은 코드를 같은 의미로 실행한다 — 로직을 복제하지 않는다.
*/
const extractHelper = () => {
  const source = readFileSync(SOURCE, 'utf-8')
  const start = source.indexOf('const TASK_MUTATING_TOOLS')
  const end = source.indexOf('const runtimeReducer')
  assert.ok(start !== -1, 'TASK_MUTATING_TOOLS를 찾지 못했습니다')
  assert.ok(end !== -1, 'runtimeReducer를 찾지 못했습니다')

  const snippet = source
    .slice(start, end)
    // 이 구간의 순수 판정 함수들이 export 된다 — new Function 안에서는
    // export 문법이 없으므로 전부 벗겨 낸다(함수 추가 시 함께 갱신).
    .replace(/export const /g, 'const ')
  return new Function(`${snippet}; return eventsMutatedTasks;`)()
}

const eventsMutatedTasks = extractHelper()

const tool = (overrides) => ({
  kind: 'tool',
  name: 'create_task',
  arguments: {},
  ok: true,
  requires_confirmation: false,
  data: {},
  error: null,
  ...overrides,
})

const cases = []
const check = (label, actual, expected) => {
  cases.push({ label, actual, expected })
}

// 실제로 실행된 write tool → 변화가 있었다.
check('executed create_task counts', eventsMutatedTasks([tool({})]), true)

// 승인 대기에서 차단된 제안 → 아무것도 실행되지 않았다.
check(
  'blocked proposal does not count',
  eventsMutatedTasks([tool({ ok: false, requires_confirmation: true })]),
  false,
)

// 도구가 실패했다 → 상태가 바뀌지 않았다.
check('failed tool does not count', eventsMutatedTasks([tool({ ok: false })]), false)

// 읽기 도구는 task를 바꾸지 않는다.
check(
  'read tool does not count',
  eventsMutatedTasks([tool({ name: 'resume_briefing' })]),
  false,
)
check(
  'list_current_tasks does not count',
  eventsMutatedTasks([tool({ name: 'list_current_tasks' })]),
  false,
)

// ok가 누락된(구버전/예상 밖 형식) 이벤트는 보수적으로 세지 않는다.
check('missing ok does not count', eventsMutatedTasks([tool({ ok: undefined })]), false)

// 빈 이벤트 / 이벤트 없음.
check('empty events', eventsMutatedTasks([]), false)
check('undefined events', eventsMutatedTasks(undefined), false)
check('null entries are tolerated', eventsMutatedTasks([null, tool({})]), true)

// 이벤트에 kind가 없으면 tool이 아니다.
check('non-tool event ignored', eventsMutatedTasks([{ name: 'create_task', ok: true }]), false)

let failed = 0
for (const { label, actual, expected } of cases) {
  const ok = actual === expected
  if (!ok) failed += 1
  console.log(`${ok ? '✅' : '❌'} ${label}${ok ? '' : ` — expected ${expected}, got ${actual}`}`)
}

console.log(`\n>>> ${failed === 0 ? 'TASK STATE REFRESH CHECK PASS' : 'TASK STATE REFRESH CHECK FAIL'}`)
process.exit(failed === 0 ? 0 : 1)
