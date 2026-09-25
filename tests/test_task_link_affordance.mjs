// -*- coding: utf-8 -*-
/**
 * Milestone B — 생성 직후 "현재 파일 → 새 작업" 링크 affordance 판정.
 *
 * 이 판정이 틀리면 두 가지 중 하나가 깨진다:
 *   - 근거 없이 파일을 제안한다(사용자가 보지 않던 파일, 생성되지 않은 task)
 *   - 제안해야 할 때 아무것도 안 뜬다(복귀 시 자료가 이어지지 않는다)
 *
 * 판정 로직(createdTaskFromEvents / selectLinkAffordance)은 순수 함수이므로
 * useJarvisRuntime 소스에서 그대로 추출해 실행한다 — 로직을 복제하지 않는다.
 * 브리지·모델·GUI를 실행하지 않는 결정적(fixture) 테스트다.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SOURCE = path.resolve(HERE, '..', 'src', 'useJarvisRuntime.js')

const extractHelpers = () => {
  const source = readFileSync(SOURCE, 'utf-8')
  const start = source.indexOf('const TASK_MUTATING_TOOLS')
  const end = source.indexOf('const runtimeReducer')
  assert.ok(start !== -1, 'TASK_MUTATING_TOOLS를 찾지 못했습니다')
  assert.ok(end !== -1, 'runtimeReducer를 찾지 못했습니다')

  const snippet = source
    .slice(start, end)
    .replace(/export const /g, 'const ')
  return new Function(
    `${snippet}; return { createdTaskFromEvents, selectLinkAffordance };`,
  )()
}

const { createdTaskFromEvents, selectLinkAffordance } = extractHelpers()

const tool = (overrides) => ({
  kind: 'tool',
  name: 'create_task',
  arguments: { project_id: 'graduation-thesis', title: '표지 페이지 작성' },
  ok: true,
  requires_confirmation: false,
  data: { id: 't-new1', project_id: 'graduation-thesis', title: '표지 페이지 작성' },
  error: null,
  ...overrides,
})

const cases = []
const check = (label, actual, expected) => {
  cases.push({ label, actual, expected })
  assert.deepEqual(actual, expected, `${label}: ${JSON.stringify(actual)}`)
}

// 1) 실제로 실행된 create_task에서만 생성된 task를 얻는다.
check(
  'executed create_task yields created task',
  createdTaskFromEvents([tool({})]),
  { id: 't-new1', title: '표지 페이지 작성', projectId: 'graduation-thesis' },
)

// 2) 승인 대기에서 막힌 제안은 생성된 것이 아니다.
check(
  'blocked proposal is not a created task',
  createdTaskFromEvents([tool({ requires_confirmation: true })]),
  null,
)

// 3) 실패한 실행도 생성된 것이 아니다.
check('failed run is not a created task', createdTaskFromEvents([tool({ ok: false })]), null)

// 4) 읽기 도구만 쓴 턴에는 생성된 task가 없다.
check(
  'read only turn has no created task',
  createdTaskFromEvents([tool({ name: 'get_project_context', data: {} })]),
  null,
)

// 5) create_task인데 id가 없으면(결측) 만들지 않는다 — 지어내지 않는다.
check('missing id is not invented', createdTaskFromEvents([tool({ data: {} })]), null)

// 6) events가 비어 있어도 안전.
check('empty events', createdTaskFromEvents([]), null)

const stateWith = (overrides) => ({
  createdTask: { id: 't-new1', title: '표지 페이지 작성', projectId: 'graduation-thesis' },
  submittedActiveFile: { fileId: 'f-abc', rootId: 'workspace', path: 'notes.md', name: 'notes.md' },
  linkState: { status: 'idle', error: null },
  ...overrides,
})

// 7) 생성된 task + identity 있는 Active File → 제안이 뜬다.
check(
  'affordance offered when both sides exist',
  selectLinkAffordance(stateWith()),
  { taskId: 't-new1', taskTitle: '표지 페이지 작성', fileId: 'f-abc', fileName: 'notes.md' },
)

// 8) Active File이 없으면 아무것도 제안하지 않는다.
check('no active file → no offer', selectLinkAffordance(stateWith({ submittedActiveFile: null })), null)

// 9) 경로만 있고 FileRef identity가 없으면 제안하지 않는다(bridge도 거부한다).
check(
  'path without identity → no offer',
  selectLinkAffordance(stateWith({ submittedActiveFile: { rootId: 'workspace', path: 'notes.md', name: 'notes.md' } })),
  null,
)

// 10) 생성된 task가 없으면 제안하지 않는다(파일만 보고 있는 경우).
check('no created task → no offer', selectLinkAffordance(stateWith({ createdTask: null })), null)

// 11) 연결 중(busy)이어도 대상은 유지된다 — 버튼만 잠긴다.
check(
  'busy keeps target',
  selectLinkAffordance(stateWith({ linkState: { status: 'busy', error: null } })),
  { taskId: 't-new1', taskTitle: '표지 페이지 작성', fileId: 'f-abc', fileName: 'notes.md' },
)

// 12) 연결이 끝났으면 제안은 사라진다(중복 연결 방지).
check(
  'done hides offer',
  selectLinkAffordance(stateWith({ linkState: { status: 'done', error: null } })),
  null,
)

// 13) 실패했으면 다시 제안할 수 있어야 한다(오류 상태에서 사라지지 않는다).
check(
  'error keeps offer for retry',
  selectLinkAffordance(stateWith({ linkState: { status: 'error', error: '실패' } })),
  { taskId: 't-new1', taskTitle: '표지 페이지 작성', fileId: 'f-abc', fileName: 'notes.md' },
)

// 14) 이름이 없으면 경로로 표기한다(빈 문자열로 새지 않게).
check(
  'falls back to path for label',
  selectLinkAffordance(stateWith({
    submittedActiveFile: { fileId: 'f-abc', rootId: 'workspace', path: 'graduation/paper.txt', name: '' },
  })),
  { taskId: 't-new1', taskTitle: '표지 페이지 작성', fileId: 'f-abc', fileName: 'graduation/paper.txt' },
)

console.log(`PASS — ${cases.length}건`)
for (const c of cases) console.log(`  ok  ${c.label}`)
