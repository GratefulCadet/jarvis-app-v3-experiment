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