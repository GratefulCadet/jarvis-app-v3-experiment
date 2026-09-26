import {
  useState,
} from 'react'

import { RUNTIME_STATUS } from './useJarvisRuntime'
import JarvisRuntimePanel from './JarvisRuntimePanel'

const PRESENCE_LABELS = {
  [RUNTIME_STATUS.IDLE]: '눌러서 대화 열기',
  [RUNTIME_STATUS.THINKING]: '생각하는 중…',
  [RUNTIME_STATUS.TOOL_RUNNING]: '작업하는 중…',
  [RUNTIME_STATUS.AWAITING_CONFIRMATION]: '승인 필요',
  [RUNTIME_STATUS.DONE]: '응답 도착',
  [RUNTIME_STATUS.ERROR]: '확인이 필요합니다',
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

/*
  UX 피드백(2·3번) — PiP가 곧 assistant다.

  PiP에서도 질문이 가능해야 "core로 전환해야 계속 일할 수 있는" 느낌이
  사라진다. orb(확장) 아래에 mini composer를 띄워 짧은 요청은 PiP에서
  끝내고, 긴 답/파일 작업만 Main으로 확장한다. 요청을 보내면 자동으로
  Assistant로 확장한다 — 답을 볼 곳이 필요하기 때문이다.
*/
function PipAsk({ runtime, onOpen }) {
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
    onOpen()
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

      <PipAsk runtime={runtime} onOpen={onOpen} />

      {status === RUNTIME_STATUS.DONE && (
        <button type="button" className="pip-result-button" onClick={onOpen}>
          <span>{runtime.text || '요청을 처리했습니다.'}</span>
          <strong>응답 보기 →</strong>
        </button>
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
