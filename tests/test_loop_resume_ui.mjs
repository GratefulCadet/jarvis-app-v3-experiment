// -*- coding: utf-8 -*-
/**
 * 한도 중단 이어가기(Resume) 상태 전이 검증.
 *
 * 이 기능의 위험은 "버튼이 보이는데 눌러도 아무 일이 안 된다"다. 이어갈 수 있는
 * 지점이 Harness에 남아 있는지를 renderer가 스스로 판단하면 오류 문자열에 의존하게
 * 되고, Harness가 판단했다면 그 값을 그대로 전달하기만 하면 된다. 여기서는
 * renderer가 (1) Harness 판정을 그대로 신뢰하고, (2) 지점이 사라지면 버튼도 사라지며,
 * (3) 정상 완주 뒤에 죽은 버튼을 남기지 않는지 확인한다.
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
  useJarvisRuntime는 React 훅을 export하므로 그대로는 불러올 수 없다.
  상태 전이 규칙(runtimeReducer)과 초기 상태는 순수 코드이므로 소스에서 그대로
  추출해 같은 코드를 같은 의미로 실행한다 — 로직을 복제하지 않는다.
  훅 본문(export default function useJarvisRuntime) 직전에서 자른다.
*/
const extractRuntime = () => {
  const source = readFileSync(SOURCE, 'utf-8')
  const end = source.indexOf('export default function useJarvisRuntime')
  assert.ok(end !== -1, 'useJarvisRuntime 본문을 찾지 못했습니다')
  const snippet = source
    .slice(0, end)
    // 여러 줄짜리 import 블록까지 통째로 뺀다 — 한 줄씩만 걸면
    // 닫는 중괄호와 "from 'react'"가 남는다.
    .replace(/^import[\s\S]*?from\s+['"][^'"]+['"]\s*$/gm, '')
    .replace(/^import\s+['"][^'"]+['"]\s*$/gm, '')
    // new Function 안에는 import/export 문법이 없다.
    .replace(/^export (const|function) /gm, '$1 ')
  return new Function(
    `${snippet}; return { runtimeReducer, createInitialRuntime, RUNTIME_STATUS, RUNTIME_EVENT };`,
  )()
}

const { runtimeReducer, createInitialRuntime, RUNTIME_STATUS, RUNTIME_EVENT } = extractRuntime()

const cases = []
const check = (label, actual, expected) => cases.push({ label, actual, expected })

const initial = createInitialRuntime()

// 시작 상태에는 이어가기 버튼이 없어야 한다.
check('initial resumable', initial.resumable, false)
check('initial resumesRemaining', initial.resumesRemaining, 0)
check('initial resuming', initial.resuming, false)

// Harness가 이어가기가 가능하다고 명시한 오류 → 버튼이 뜬다.
const resumableError = runtimeReducer(initial, {
  type: RUNTIME_EVENT.ERROR,
  error: 'tool 루프 한도(4회)에 도달해 중단합니다.',
  resumable: true,
  resumesRemaining: 3,
})
check('limit error opens resume', resumableError.resumable, true)
check('limit error status', resumableError.status, RUNTIME_STATUS.ERROR)
check('limit error keeps remaining', resumableError.resumesRemaining, 3)
check('limit error is not resuming', resumableError.resuming, false)

// 명시하지 않은 오류 → 버튼이 뜨지 않는다. renderer가 오류 문자열을 매칭해
// "한도"가 들어 있다는 이유로 버튼을 뜨우면 안 된다.
const plainError = runtimeReducer(initial, {
  type: RUNTIME_EVENT.ERROR,
  error: '브리지에 연결할 수 없습니다',
})
check('plain error has no resume', plainError.resumable, false)
check('plain error remaining is zero', plainError.resumesRemaining, 0)

// 명시적으로 거절된 경우도 버튼이 없어야 한다.
const notResumable = runtimeReducer(initial, {
  type: RUNTIME_EVENT.ERROR,
  error: '이어가기를 3번 사용했습니다.',
  resumable: false,
  resumesRemaining: 0,
})
check('refused resume has no button', notResumable.resumable, false)

// 이어가기 중 → 버튼이 잠기고 THINKING. 두 번째 클릭이 들어가지 않아야 한다.
const resuming = runtimeReducer(resumableError, { type: RUNTIME_EVENT.RESUME })
check('resume clears error', resuming.error, null)
check('resume is thinking', resuming.status, RUNTIME_STATUS.THINKING)
check('resume marks in-flight', resuming.resuming, true)

// 이어가기가 성공 → DONE, 지점은 사라진다(죽은 버튼 방지).
const done = runtimeReducer(resuming, {
  type: RUNTIME_EVENT.RESUME_RESOLVED,
  text: '요약 완료했습니다.',
  resumable: false,
  resumesRemaining: 0,
})
check('resolved is done', done.status, RUNTIME_STATUS.DONE)
check('resolved clears resume', done.resumable, false)
check('resolved shows text', done.text, '요약 완료했습니다.')

// 이어가기가 다시 한도에 걸림 → 새 지점이 있으므로 버튼이 유지된다.
const againLimited = runtimeReducer(resuming, {
  type: RUNTIME_EVENT.RESUME_RESOLVED,
  text: '',
  error: 'tool 루프 한도(4회)에 도달해 중단합니다.',
  resumable: true,
  resumesRemaining: 2,
})
check('second limit keeps resume', againLimited.resumable, true)
check('second limit decrements', againLimited.resumesRemaining, 2)

// 이어간 턴이 만든 편집 제안도 diff 카드로 떠야 한다.
// 빠뜨리면 "제안을 만들었습니다"만 보고 승인할 방법이 사라진다 — 제안이
// 디스크에 있어도 화면에 없으니 사실상 갇힌다.
const proposalFromResume = runtimeReducer(resuming, {
  type: RUNTIME_EVENT.RESUME_RESOLVED,
  text: '제안을 만들었습니다. 확인해 주세요.',
  proposal: {
    proposal_id: 'e-resumed01',
    path: 'experiment-notes.md',
    status: 'proposed',
  },
})
check('resumed proposal is kept', (proposalFromResume.editProposal || {}).proposal_id, 'e-resumed01')
check('resumed proposal is proposed', proposalFromResume.editStatus, 'proposed')
check('resumed proposal clears edit error', proposalFromResume.editError, null)

// 이어간 턴에 제안이 없으면 이전 카드 상태를 임의로 바꾸지 않는다.
const noProposal = runtimeReducer(proposalFromResume, {
  type: RUNTIME_EVENT.RESUME_RESOLVED,
  text: '끝냈습니다.',
})
check('resume without proposal keeps none', noProposal.editProposal, proposalFromResume.editProposal)

// 새 요청은 이전에 남은 이어가기 상태를 물려받지 않는다.
const resubmitted = runtimeReducer(resumableError, {
  type: RUNTIME_EVENT.SUBMIT,
  text: '새 작업',
})
check('new submit drops resume', resubmitted.resumable, false)
check('new submit drops remaining', resubmitted.resumesRemaining, 0)

// dismiss로 치워도 지점은 남아 있으면 안 된다.
const dismissed = runtimeReducer(resumableError, { type: RUNTIME_EVENT.DISMISS })
check('dismiss drops resume', dismissed.resumable, false)
check('dismiss returns to idle', dismissed.status, RUNTIME_STATUS.IDLE)

let failed = 0
for (const { label, actual, expected } of cases) {
  try {
    assert.deepEqual(actual, expected)
    console.log(`  PASS  ${label}`)
  } catch {
    failed += 1
    console.log(`  FAIL  ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}
console.log('')
if (failed) {
  console.log(`LOOP RESUME UI FAILED — ${failed}/${cases.length}`)
  process.exit(1)
}
console.log(`LOOP RESUME UI VERIFIED — ${cases.length}/${cases.length}`)
