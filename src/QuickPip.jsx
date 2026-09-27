import { useState } from 'react'

import { RUNTIME_STATUS } from './useJarvisRuntime'
import JarvisRuntimePanel from './JarvisRuntimePanel'

const PRESENCE_LABELS = {
  [RUNTIME_STATUS.IDLE]: '눌러서 대화 열기',
  [RUNTIME_STATUS.THINKING]: '생각하는 중…',
  [RUNTIME_STATUS.TOOL_RUNNING]: '작업하는 중…',
  [RUNTIME_STATUS.AWAITING_CONFIRMATION]: '승인 필요',
  [RUNTIME_STATUS.DONE]: '응답 도착',
  [RUNTIME_STATUS.ERROR]: '오류 확인 필요',
}

function PresenceOrb({ status, onOpen }) {
  return (
    <div className={`pip-presence-orb is-${status}`}>
      <div className="pip-presence-orb-core" aria-hidden="true" />
      <div className="pip-presence-orb-ring pip-presence-orb-ring-a" aria-hidden="true" />
      <div className="pip-presence-orb-ring pip-presence-orb-ring-b" aria-hidden="true" />
      <button
        type="button"
        className="pip-presence-orb-trigger"
        onClick={onOpen}
        aria-label="Open JARVIS Assistant"
        title="Core를 눌러 Main으로 돌아가기"
      />
    </div>
  )
}

function PipAsk({ runtime }) {
  const [text, setText] = useState('')
  const busy =
    runtime.status === RUNTIME_STATUS.THINKING ||
    runtime.status === RUNTIME_STATUS.TOOL_RUNNING ||
    runtime.status === RUNTIME_STATUS.AWAITING_CONFIRMATION

  const submit = (event) => {
    event.preventDefault()
    const trimmed = text.trim()
    if (!trimmed || (busy && runtime.pendingSubmit)) return
    runtime.submitOrQueue(trimmed, runtime.projectId)
    setText('')
  }

  return (
    <form className="pip-presence-ask" onSubmit={submit}>
      <input
        type="text"
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder="JARVIS에게 요청…"
        aria-label="Ask JARVIS from PiP"
      />
      <button
        type="submit"
        disabled={!text.trim() || (busy && runtime.pendingSubmit)}
        aria-label="Send from PiP"
      >
        →
      </button>
    </form>
  )
}

export default function QuickPip({ executionContext, runtime, pipMode = false, onOpen }) {
  if (!pipMode) return null

  const status = runtime.status
  const focusLabel = executionContext?.node?.label
  const label = PRESENCE_LABELS[status] || 'JARVIS'
  const needsRuntimePanel = status !== RUNTIME_STATUS.IDLE && status !== RUNTIME_STATUS.THINKING && status !== RUNTIME_STATUS.TOOL_RUNNING

  return (
    <aside className="quick-pip pip-presence" aria-label="JARVIS presence" data-status={status}>
      <PresenceOrb status={status} onOpen={onOpen} />
      <div className="pip-presence-copy" aria-live="polite">
        <span className="pip-presence-name">JARVIS</span>
        <span className="pip-presence-status">{label}</span>
        {focusLabel && (
          <span className="pip-presence-focus">
            <span className="pip-presence-focus-label">FOCUS</span>
            <span>{focusLabel}</span>
          </span>
        )}
      </div>

      {needsRuntimePanel && (
        <JarvisRuntimePanel
          runtime={runtime}
          onApprove={runtime.approve}
          onApproveAndLink={runtime.approveAndLinkFile}
          onReject={runtime.reject}
          onDismiss={runtime.dismiss}
          variant="quiet"
          pipMode
        />
      )}
      {status !== RUNTIME_STATUS.AWAITING_CONFIRMATION && <PipAsk runtime={runtime} />}

      {status === RUNTIME_STATUS.IDLE && (
        <span className="pip-presence-main-hint" aria-hidden="true">Orb를 눌러 Main 열기</span>
      )}
      {(status === RUNTIME_STATUS.THINKING || status === RUNTIME_STATUS.TOOL_RUNNING) && (
        <span className="pip-presence-main-hint" aria-live="polite">{label}</span>
      )}
    </aside>
  )
}
