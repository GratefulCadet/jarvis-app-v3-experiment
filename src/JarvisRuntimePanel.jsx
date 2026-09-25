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
          onClick={runtime.dismissLinkAffordance}
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
          onClick={runtime.linkActiveFile}
          disabled={busy}
        >
          {busy ? 'Linking…' : 'Link file'}
        </button>
        <button
          type="button"
          className="jarvis-link-skip"
          onClick={runtime.dismissLinkAffordance}
          disabled={busy}
        >
          Not now
        </button>
      </div>
    </div>
  )
}

export default function JarvisRuntimePanel({
  runtime,
  onApprove,
  onReject,
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
  } = runtime

  if (status === RUNTIME_STATUS.IDLE) {
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

        <div className="jarvis-permission-actions">
          <button
            type="button"
            className="jarvis-approve-button"
            onClick={onApprove}
            disabled={status !== RUNTIME_STATUS.AWAITING_CONFIRMATION}
          >
            Approve
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
    if (
      variant === 'quiet' &&
      (hideDone || !pipMode)
    ) {
      return children
    }

    if (variant === 'quiet') {
      return (
        <div className="jarvis-runtime-panel is-done is-quiet" aria-live="polite">
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
            응답 완료 — 자세한 답변은 Command Center에서 확인하세요.
          </div>

          <LinkAffordance runtime={runtime} compact />
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