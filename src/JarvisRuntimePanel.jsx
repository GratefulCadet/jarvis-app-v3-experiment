import {
  useEffect,
  useState,
} from 'react'

import {
  RUNTIME_STATUS,
} from './useJarvisRuntime'

/*
  공유 runtime surface (Task 3).

  PiP와 Command Center가 같은 JARVIS 상태를 같은 방식으로 그린다.
  검은/흰 기본 디자인 유지, 한 번에 하나의 주요 정보만 보여준다.

  상태별:
    idle          → props.children (기존 PiP 콘텐츠)
    thinking      → Thinking…
    tool-running  → 실행 중…
    awaiting-confirmation → 제안된 action + 중요 인자 + "아직 변경된 사항 없음"
                            + [Approve] [Reject]
    done          → Qwen 최종 응답 + trace
    error         → 실패 사유 + dismiss
*/

const SCRATCH_BADGE = 'SCRATCH'

const actionLabel = (toolName) => {
  const labels = {
    create_task: 'Create task',
    update_task: 'Update task',
    delete_task: 'Delete task',
    create_file: 'Create file',
  }

  return labels[toolName] || 'Requested action'
}

/*
  Milestone B — "생성 직후 관련 자료까지 이어지는 복귀".

  모델이 방금 만든 task와, 그 요청에 함께 실렸던 Active File이 있을 때만
  연결 제안을 보인다. 세 요소가 모두 있을 때만 affordance가 존재한다:
    1) 실제로 생성된 task (id는 events에서만 얻을 수 있다)
    2) 요청 당시 보고 있던 파일
    3) 그 파일의 stable FileRef identity (경로만으로는 링크 불가)
  하나라도 없으면 아무것도 뜨지 않는다 — 추측 제안 금지.

  링크는 사용자가 [연결]을 누를 때에만 만들어진다. 자동 연결 없음(V4 §13-C).
  [나중에]는 상태만 버린다(영속 변화 없음).
*/
function LinkAffordance({ runtime, compact = false }) {
  const affordance = runtime.linkAffordance
  const linkState = runtime.linkState || { status: 'idle' }

  if (!affordance && linkState.status !== 'done') {
    return null
  }

  if (linkState.status === 'done') {
    return (
      <div className="jarvis-link-affordance is-done" role="status">
        <span className="jarvis-link-affordance-text">
          {linkState.fileName
            ? `${linkState.fileName}을(를) ${linkState.taskTitle || '새 작업'}에 연결했습니다.`
            : '작업에 자료를 연결했습니다.'}
        </span>
        <button
          type="button"
          className="jarvis-link-skip"
          onClick={(event) => {
            event.stopPropagation()
            runtime.dismissLinkAffordance()
          }}
        >
          Dismiss
        </button>
      </div>
    )
  }

  const busy = linkState.status === 'busy'

  return (
    <div className="jarvis-link-affordance" role="group" aria-label="Link active file">
      <div className="jarvis-link-affordance-text">
        {linkState.status === 'error'
          ? `연결하지 못했습니다: ${linkState.error || '알 수 없는 오류'}`
          : compact
            ? `${affordance.fileName} → ${affordance.taskTitle}`
            : `지금 보고 있는 파일(${affordance.fileName})을 새로 만든 작업(${affordance.taskTitle})에 연결할까요?`}
      </div>
      <div className="jarvis-link-affordance-actions">
        <button
          type="button"
          className="jarvis-link-button"
          onClick={(event) => {
            // PiP done 카드가 복귀 버튼이므로 링크 클릭이 복귀로 이어지지 않게 막는다.
            event.stopPropagation()
            runtime.linkActiveFile()
          }}
          disabled={busy}
        >
          {busy ? 'Linking…' : 'Link file'}
        </button>
        <button
          type="button"
          className="jarvis-link-skip"
          onClick={(event) => {
            event.stopPropagation()
            runtime.dismissLinkAffordance()
          }}
          disabled={busy}
        >
          Not now
        </button>
      </div>
    </div>
  )
}

/*
  AI Edit V1 — 편집 제안 diff 카드.

  V1의 목표는 완벽한 code-review UI가 아니라 "무엇이 없어지고 무엇이 생기는가"를
  명확히 보이주는 것이다. 그래서 hunk 헤더와 +/- 줄만 접히지 않은 상태로 보여주고
  (added/removed 수로 "N lines changed"를 대체하지 않고 함께 알린다), [Apply changes]
  전까지는 디스크가 그대로임을 문장으로 못 박는다.

  상태별:
    proposed  → diff + [Apply changes] [Cancel]
    applying  → 적용 중 (버튼 비활성)
    applied   → 반영됨 + [Undo]
    conflict  → revision 불일치. 재적용 금지. [Recalculate] [Cancel]
    cancelled → 취소됨 (디스크 불변)
*/
function EditDiffCard({ runtime }) {
  const proposal = runtime.editProposal
  const status = runtime.editStatus
  if (!proposal) return null

  const diff = Array.isArray(proposal.diff) ? proposal.diff : []
  const stats = proposal.stats || { added: 0, removed: 0, changed: 0 }
  const busy = status === 'applying' || status === 'recalculating'

  if (status === 'cancelled') {
    return (
      <div className="jarvis-edit-card is-cancelled" role="status">
        <div className="jarvis-edit-head">Edit cancelled</div>
        <p className="jarvis-edit-note">
          {proposal.name || proposal.relative_path}은(는) 수정되지 않았습니다.
        </p>
      </div>
    )
  }

  return (
    <div className="jarvis-edit-card" role="group" aria-label="Proposed edit">
      <div className="jarvis-edit-head">
        <div className="jarvis-edit-title">{proposal.name || proposal.relative_path}</div>
        <div className="jarvis-edit-stats" aria-label="Change size">
          <span className="jarvis-edit-stat is-removed">−{stats.removed}</span>
          <span className="jarvis-edit-stat is-added">+{stats.added}</span>
          <span className="jarvis-edit-stat is-total">
            {stats.changed} line{stats.changed === 1 ? '' : 's'} changed
          </span>
        </div>
      </div>

      {proposal.absolute_path && (
        <code className="jarvis-edit-path" title={proposal.absolute_path}>
          {proposal.absolute_path}
        </code>
      )}
      {proposal.summary && (
        <p className="jarvis-edit-summary">{proposal.summary}</p>
      )}

      {status === 'conflict' ? (
        <div className="jarvis-edit-conflict" role="alert">
          <strong>This file changed after the edit was proposed.</strong>
          <span>{runtime.editError}</span>
        </div>
      ) : (
        <pre className="jarvis-edit-diff" aria-label="Proposed changes">
          {diff.map((line, index) => {
            const kind = line.startsWith('+++') || line.startsWith('---')
              ? 'meta'
              : line.startsWith('+')
                ? 'add'
                : line.startsWith('-')
                  ? 'remove'
                  : line.startsWith('@@')
                    ? 'hunk'
                    : 'context'
            return (
              <span key={index} className={`jarvis-diff-line is-${kind}`}>
                {line || ' '}
              </span>
            )
          })}
        </pre>
      )}

      {status !== 'applied' && (
        <p className="jarvis-edit-note">
          Nothing has changed on disk yet.
        </p>
      )}
      {status === 'applied' && (
        <p className="jarvis-edit-note is-applied">
          Saved. {proposal.name || proposal.relative_path} was updated.
        </p>
      )}
      {status === 'undone' && (
        <p className="jarvis-edit-note is-applied">
          Reverted. {proposal.name || proposal.relative_path} is back to its previous content.
        </p>
      )}

      <div className="jarvis-edit-actions">
        {status === 'recalculating' ? (
          <button type="button" className="jarvis-reject-button" disabled>
            Recalculating…
          </button>
        ) : status === 'undone' ? (
          <button
            type="button"
            className="jarvis-reject-button"
            onClick={runtime.dismissEdit}
          >
            Close
          </button>
        ) : status === 'applied' ? (
          <button
            type="button"
            className="jarvis-approve-button"
            onClick={runtime.undoEdit}
            disabled={busy}
          >
            {busy ? 'Undoing…' : 'Undo'}
          </button>
        ) : (
          <>
            <button
              type="button"
              className="jarvis-approve-button"
              onClick={status === 'conflict' ? runtime.recalculateEdit : runtime.applyEdit}
              disabled={busy}
            >
              {status === 'conflict'
                ? 'Recalculate'
                : status === 'recalculating'
                  ? 'Recalculating…'
                  : busy
                    ? 'Applying…'
                    : 'Apply changes'}
            </button>
            <button
              type="button"
              className="jarvis-reject-button"
              onClick={runtime.cancelEdit}
              disabled={busy}
            >
              Cancel
            </button>
          </>
        )}
      </div>
    </div>
  )
}

export default function JarvisRuntimePanel({
  runtime,
  onApprove,
  onApproveAndLink,
  onReject,
  onResume,
  onDismiss,
  children,
  variant = 'full',
  pipMode = false,
  hideDone = false,
}) {
  const {
    status,
    text,
    error,
    toolCall,
    tracePath,
    scratch,
    resumable,
    resumesRemaining,
    resuming,
  } = runtime

  /*
    UX 통합 — '이 파일도 연결' 토글은 승인 대기 화면에서만 의미가 있다.
    다른 상태로 전환되면(승인 실행, 거절, dismiss) 렌더 중 리셋 패턴으로
    기본값(끔)에 되돌린다 — 다음 승인 화면은 항상 안전한 기본에서 시작한다.
  */
  const [linkWithApproval, setLinkWithApproval] = useState(false)
  const [workspaceRoots, setWorkspaceRoots] = useState([])
  const [prevStatus, setPrevStatus] = useState(status)

  useEffect(() => {
    if (status !== RUNTIME_STATUS.AWAITING_CONFIRMATION) return
    let cancelled = false
    ;(async () => {
      try {
        const response = await window.jarvisDiscovery?.listWorkspaceRoots?.()
        if (!cancelled && response?.status === 'ok') setWorkspaceRoots(response.roots || [])
      } catch {
        if (!cancelled) setWorkspaceRoots([])
      }
    })()
    return () => { cancelled = true }
  }, [status])
  if (prevStatus !== status) {
    setPrevStatus(status)
    if (status !== RUNTIME_STATUS.AWAITING_CONFIRMATION) {
      setLinkWithApproval(false)
    }
  }

  if (status === RUNTIME_STATUS.IDLE) {
    // AI Edit V1 — 이미 적용/되돌린 뒤 대화가 idle로 돌아와도 Undo affordance는
    // 사라지면 안 된다. 사용자가 제안 결과(취소/충돌 포함)를 계속 볼 수 있어야 한다.
    if (runtime.editStatus && runtime.editStatus !== 'cancelled') {
      return (
        <div className="jarvis-runtime-panel is-done" aria-live="polite">
          <EditDiffCard runtime={runtime} />
        </div>
      )
    }
    return children
  }

  if (
    status === RUNTIME_STATUS.THINKING ||
    status === RUNTIME_STATUS.TOOL_RUNNING
  ) {
    return (
      <div className="jarvis-runtime-panel is-activity" aria-live="polite">
        <div className="jarvis-runtime-heading">
          <span className="jarvis-runtime-dot" aria-hidden="true" />
          <span className="jarvis-runtime-status-text">
            {status === RUNTIME_STATUS.THINKING
              ? 'Thinking…'
              : 'Running approved action…'}
          </span>
          {scratch && (
            <span className="jarvis-scratch-badge">
              {SCRATCH_BADGE}
            </span>
          )}
        </div>
      </div>
    )
  }

  if (status === RUNTIME_STATUS.AWAITING_CONFIRMATION) {
    const args = toolCall?.arguments || {}
    /*
      UX 통합 — 승인 한 번으로 생성+연결.
      지금 요청이 create_task 제안이고 요청 당시 열어 본 파일(FileRef)이 있을
      때만 체크박스를 보인다. 승인이 실제 생성으로 이어지면 approve가 끝난
      직후 같은 canonical 경로로 파일이 연결되어 "승인 → 연결 카드 → Link
      file"의 별도 단계가 사라진다. (스크린 시점엔 task가 아직 없으므로
      linkAffordance가 아니라 submittedActiveFile을 본다.)
    */
    const canOfferLink =
      typeof onApproveAndLink === 'function' &&
      toolCall?.name === 'create_task' &&
      Boolean(runtime.submittedActiveFile?.fileId)
    const offerFileName =
      runtime.submittedActiveFile?.name ||      runtime.submittedActiveFile?.path ||
      ''
    const approvedRoot = workspaceRoots.find((root) => root.id === args.root) ||
      (workspaceRoots.length === 1 ? workspaceRoots[0] : null)
    const rootLabel = approvedRoot?.display_name || args.root || runtime.submittedActiveFile?.rootId || ''
    const destinationRelative = String(args.path || '').replace(/\\/g, '/')
    const destinationParts = destinationRelative.split('/').filter(Boolean)
    const destinationDirectory = destinationParts.slice(0, -1).join('/')
    const destinationLabel = [rootLabel, destinationDirectory].filter(Boolean).join(' / ')
    const absoluteDestination = approvedRoot?.device_path
      ? `${approvedRoot.device_path.replace(/[\\/]+$/, '')}${destinationRelative ? `${approvedRoot.device_path.includes('\\') ? '\\' : '/'}${destinationRelative.split('/').join(approvedRoot.device_path.includes('\\') ? '\\' : '/')}` : ''}`
      : ''
    return (
      <div className="jarvis-runtime-panel is-permission" role="alertdialog" aria-live="assertive">
        <div className="jarvis-runtime-heading">
          <span className="jarvis-runtime-status-text">
            Permission required
          </span>
          {scratch && (
            <span className="jarvis-scratch-badge">
              {SCRATCH_BADGE}
            </span>
          )}
        </div>

        <div className="jarvis-permission-action">
          {actionLabel(toolCall?.name)}
        </div>

        {args.title && (
          <div className="jarvis-permission-title">
            {args.title}
          </div>
        )}
        {toolCall?.name === 'create_file' && (
          <div className="jarvis-permission-file-destination" aria-label="File creation destination">
            <strong>{destinationParts.at(-1) || args.path}</strong>
            <span>위치 · {destinationLabel || destinationRelative}</span>
            {absoluteDestination && <code title={absoluteDestination}>{absoluteDestination}</code>}
          </div>
        )}

        <div className="jarvis-permission-meta">
          {args.project_id && (
            <span>Project context: selected project</span>
          )}
          {args.reason && (
            <span>Reason: {args.reason}</span>
          )}
        </div>

        <div className="jarvis-permission-note">
          Nothing has changed yet.
        </div>

        {canOfferLink && (
          <label className="jarvis-permission-link-option">
            <input
              type="checkbox"
              checked={linkWithApproval}
              onChange={(event) => setLinkWithApproval(event.target.checked)}
            />
            <span>
              이 파일도 연결: {offerFileName}
            </span>
          </label>
        )}

        <div className="jarvis-permission-actions">
          <button
            type="button"
            className="jarvis-approve-button"
            onClick={linkWithApproval && canOfferLink ? onApproveAndLink : onApprove}
            disabled={status !== RUNTIME_STATUS.AWAITING_CONFIRMATION}
          >
            {linkWithApproval && canOfferLink ? '승인하고 연결' : 'Approve'}
          </button>
          <button
            type="button"
            className="jarvis-reject-button"
            onClick={onReject}
            disabled={status !== RUNTIME_STATUS.AWAITING_CONFIRMATION}
          >
            Reject
          </button>
        </div>
      </div>
    )
  }

  if (status === RUNTIME_STATUS.DONE) {
    /*
      quiet variant (빠른 플로팅 패널 / PiP):
      - Command Center를 보고 있는 동안에는 긴 Qwen 답변을 패널에 중복 표시하지
        않는다 (Command Center 자체 패널이 전체 답변을 보여준다).
      - 실제 PiP 상태에서는 답변 전체 대신 짧은 완료 알림만 보여준다.
    */
    if (variant === 'quiet') {
      if (hideDone || !pipMode) {
        return children
      }
      /*
        AI Edit V1 — PiP에서도 편집 제안을 보여준다.

        이 파일의 설계 원칙은 "PiP와 Command Center가 같은 runtime state를 같은
        방식으로 그린다"다. quiet 분기가 이 카드를 빠뜨리면 승인 직후 surface가
        PiP로 넘어가는 순간 Undo affordance가 사라진다 — 되돌리기가 필요한 바로
        그 순간에 제공자가 사라지는 것은 milestone이 가장 먼저 막으려던 UX다.
        카드는 다른 surface와 같은 상태 머신에서 나오므로 중복 상태가 아니다.
      */
      if (variant === 'quiet') {
        return (
          <div className="jarvis-runtime-panel is-done is-quiet pip-presence-resume" role="status" aria-live="polite">
            <div className="jarvis-runtime-heading"><span className="jarvis-runtime-status-text">Done</span></div>
            <div className="jarvis-runtime-quiet-note">{text ? `${text.length > 90 ? `${text.slice(0, 90)}…` : text}` : '요청을 처리했습니다.'}</div>
            {/* AI Edit V1 — PiP에서도 편집 제안을 보여준다(아래 주석 참고). */}
            <EditDiffCard runtime={runtime} />
            <div className="jarvis-runtime-quiet-hint">Core/Orb를 눌러 Main에서 전체 응답 보기</div>
          </div>
        )
      }

      /*
        PiP done — 읽기 전용 알림이 아니라 곧바로 복귀하는 카드다.
        이 quiet 패널이 PiP 중앙을 덮는 바람에 DONE 상태에서 orb 클릭이
        전부 패널로 흡수되어 복귀 경로가 사라지는 dead-end가 실측됐었다
        (UX audit 2026-09: pip-presence-orb-trigger / core-trigger hitSelf=false).
        새 요소를 더하지 않는다 — 패널 자체가 복귀 행동이 된다.
      */
      return (
        <div className="jarvis-runtime-panel is-done is-quiet pip-presence-resume" role="status" aria-live="polite">
          <div className="jarvis-runtime-heading">
            <span className="jarvis-runtime-status-text">
              Done
            </span>
            {scratch && (
              <span className="jarvis-scratch-badge">
                {SCRATCH_BADGE}
              </span>
            )}
          </div>

          <div className="jarvis-runtime-quiet-note">
            {text
              ? `${text.length > 90 ? `${text.slice(0, 90)}…` : text}`
              : '클릭하면 Main에서 전체 응답을 확인합니다.'}
          </div>

          <div className="jarvis-runtime-quiet-hint">
            Core/Orb를 눌러 Main에서 전체 응답 보기
          </div>

        </div>
      )
    }

    return (
      <div className="jarvis-runtime-panel is-done" aria-live="polite">
        <div className="jarvis-runtime-heading">
          <span className="jarvis-runtime-status-text">
            Done
          </span>
          {scratch && (
            <span className="jarvis-scratch-badge">
              {SCRATCH_BADGE}
            </span>
          )}
        </div>

        <div className="jarvis-runtime-text">
          {text || '완료했습니다.'}
        </div>

        {/* AI Edit V1 — 모델 답변 아래에 diff 카드. 승인 게이트가 여기다. */}
        <EditDiffCard runtime={runtime} />

        <LinkAffordance runtime={runtime} />

        {tracePath && (
          <div className="jarvis-runtime-trace">
            {tracePath}
          </div>
        )}

        <div className="jarvis-runtime-footer">
          <button
            type="button"
            className="jarvis-mini-dismiss"
            onClick={onDismiss}
          >
            Dismiss
          </button>
        </div>
      </div>
    )
  }

  // PiP errors stay informational; Main contains the full recovery details.
  if (variant === 'quiet' && pipMode) {
    const shortError = error ? `${String(error).slice(0, 96)}${String(error).length > 96 ? '…' : ''}` : '자세한 내용은 Main에서 확인하세요.'
    return (
      <div className="jarvis-runtime-panel is-error is-quiet pip-presence-error" role="status" aria-live="polite">
        <div className="jarvis-runtime-heading"><span className="jarvis-runtime-status-text">오류</span></div>
        <div className="jarvis-runtime-quiet-note">{shortError}</div>
        <div className="jarvis-runtime-quiet-hint">Core/Orb를 눌러 Main에서 확인하세요</div>
      </div>
    )
  }

  // ERROR
  return (
    <div className="jarvis-runtime-panel is-error" role="alert" aria-live="assertive">
      <div className="jarvis-runtime-heading">
        <span className="jarvis-runtime-status-text">
          Error
        </span>
      </div>

      <div className="jarvis-runtime-text">
        {error || '알 수 없는 오류'}
      </div>

      {resumable && (
        <div className="jarvis-runtime-resume-hint">
          이어가면 문장을 다시 쓰지 않고 중단된 지점부터 계속합니다.
          {resumesRemaining > 0 && ` (남은 ${resumesRemaining}회)`}
        </div>
      )}

      <div className="jarvis-runtime-footer">
        {resumable && (
          <button
            type="button"
            className="jarvis-mini-resume"
            onClick={onResume}
            disabled={resuming}
          >
            {resuming ? '이어가는 중…' : '이어가기'}
          </button>
        )}
        <button
          type="button"
          className="jarvis-mini-dismiss"
          onClick={onDismiss}
        >
          Dismiss
        </button>
      </div>
    </div>
  )
}