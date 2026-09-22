import { RUNTIME_STATUS } from './useJarvisRuntime'
import JarvisRuntimePanel from './JarvisRuntimePanel'

const PRESENCE_LABELS = {
  [RUNTIME_STATUS.IDLE]: 'JARVIS',
  [RUNTIME_STATUS.THINKING]: 'Thinking…',
  [RUNTIME_STATUS.TOOL_RUNNING]: 'Working…',
  [RUNTIME_STATUS.AWAITING_CONFIRMATION]: 'Approval required',
  [RUNTIME_STATUS.DONE]: 'Done',
  [RUNTIME_STATUS.ERROR]: 'Needs attention',
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
      />
    </div>
  )
}

export default function QuickPip({
  executionContext,
  runtime,
  pipMode = false,
  onOpen,
}) {
  if (!pipMode) {
    return null
  }

  const status = runtime.status
  const focusLabel = executionContext?.node?.label
  const label = PRESENCE_LABELS[status] || 'JARVIS'

  if (status === RUNTIME_STATUS.AWAITING_CONFIRMATION) {
    return (
      <aside className="quick-pip pip-presence" aria-label="JARVIS presence">
        <JarvisRuntimePanel
          runtime={runtime}
          onApprove={runtime.approve}
          onReject={runtime.reject}
          onDismiss={runtime.dismiss}
          variant="quiet"
          pipMode
        />
        <button
          type="button"
          className="pip-presence-open"
          onClick={onOpen}
        >
          Open Assistant
        </button>
      </aside>
    )
  }

  return (
    <aside
      className="quick-pip pip-presence"
      aria-label="JARVIS presence"
      data-status={status}
    >
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

      {status === RUNTIME_STATUS.DONE && (
        <JarvisRuntimePanel
          runtime={runtime}
          onApprove={runtime.approve}
          onReject={runtime.reject}
          onDismiss={runtime.dismiss}
          variant="quiet"
          pipMode
          hideDone={false}
        />
      )}

      {status === RUNTIME_STATUS.ERROR && (
        <button
          type="button"
          className="pip-presence-attention"
          onClick={onOpen}
        >
          Open Assistant
        </button>
      )}
    </aside>
  )
}
