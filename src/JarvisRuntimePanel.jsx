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

export default function JarvisRuntimePanel({
  runtime,
  onApprove,
  onApproveAndLink,
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
      if (variant === 'quiet') {
        return (
          <div className="jarvis-runtime-panel is-done is-quiet pip-presence-resume" role="status" aria-live="polite">
            <div className="jarvis-runtime-heading"><span className="jarvis-runtime-status-text">Done</span></div>
            <div className="jarvis-runtime-quiet-note">{text ? `${text.length > 90 ? `${text.slice(0, 90)}…` : text}` : '요청을 처리했습니다.'}</div>
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