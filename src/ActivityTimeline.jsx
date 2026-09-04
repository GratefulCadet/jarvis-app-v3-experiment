import {
  useState,
} from 'react'

/*
  Activity / Tool timeline (Task 5).

  Command Center의 접이식 패널. USER → QWEN tool → TOOL OK → PERMISSION
  REQUIRED → APPROVED → TOOL OK → FINAL RESPONSE를 실제 trace에서 뽑은
  events로 그린다. trace path/id가 보이므로 Qwen이 Tool Result와 모순된 답을
  해도 실제 실행 증거를 바로 확인할 수 있다.
*/

const KIND_CLASS = {
  user: 'is-user',
  'tool-ok': 'is-tool-ok',
  'tool-error': 'is-tool-error',
  permission: 'is-permission',
  approved: 'is-approved',
  rejected: 'is-rejected',
  qwen: 'is-qwen',
  error: 'is-error',
}

export default function ActivityTimeline({
  timeline,
  traceId,
  tracePath,
}) {
  const [open, setOpen] = useState(true)

  return (
    <section className="jarvis-activity-timeline">
      <button
        type="button"
        className="jarvis-timeline-toggle"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <span>
          Activity
        </span>
        <span className="jarvis-timeline-count">
          {timeline.length}
        </span>
        <span className="jarvis-timeline-chevron">
          {open ? '▾' : '▸'}
        </span>
      </button>

      {(traceId || tracePath) && (
        <div className="jarvis-timeline-trace">
          {traceId && (
            <span>trace: {traceId}</span>
          )}
          {tracePath && (
            <span className="jarvis-timeline-trace-path">
              {tracePath}
            </span>
          )}
        </div>
      )}

      {open && (
        <ol className="jarvis-timeline-list">
          {timeline.length === 0 && (
            <li className="jarvis-timeline-empty">
              No activity yet — ask JARVIS above.
            </li>
          )}

          {timeline.map((entry) => (
            <li
              key={entry.id}
              className={[
                'jarvis-timeline-item',
                KIND_CLASS[entry.kind] || '',
              ].filter(Boolean).join(' ')}
            >
              <span className="jarvis-timeline-label">
                {entry.label}
              </span>
              <span className="jarvis-timeline-detail">
                {entry.detail}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}