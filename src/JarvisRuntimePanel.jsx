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

export default function JarvisRuntimePanel({
  runtime,
  onApprove,
  onReject,
  onDismiss,
  children,
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
          {toolCall?.name || 'unknown tool'}
        </div>

        {args.title && (
          <div className="jarvis-permission-title">
            {args.title}
          </div>
        )}

        <div className="jarvis-permission-meta">
          {args.project_id && (
            <span>Project: {args.project_id}</span>
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
          >
            Approve
          </button>
          <button
            type="button"
            className="jarvis-reject-button"
            onClick={onReject}
          >
            Reject
          </button>
        </div>
      </div>
    )
  }

  if (status === RUNTIME_STATUS.DONE) {
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