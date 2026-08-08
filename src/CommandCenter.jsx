import {
  useState,
} from 'react'

import {
  TIMER_PRESETS_MINUTES,
} from './useExecutionSession'

import SevenSegmentTime from './SevenSegmentTime'

export default function CommandCenter({
  execution,
}) {
  const [newItem, setNewItem] =
    useState('')

  const {
    objective,
    nextAction,
    checklist,
    timer,
    timerText,
    progress,
    actionComplete,
    currentItemId,
    statusLabel,
    actions,
  } = execution

  const selectedMinutes =
    Math.round(
      timer.originalDurationMs /
        60_000,
    )

  const durationHours =
  Math.floor(
    selectedMinutes / 60,
  )

const durationMinutesPart =
  selectedMinutes % 60

  const addItem = (event) => {
    event.preventDefault()

    const trimmed =
      newItem.trim()

    if (!trimmed) {
      return
    }

    actions.addChecklistItem(
      trimmed,
    )

    setNewItem('')
  }

  const timerLocked =
    timer.status !== 'idle'

  return (
    <section
      className="command-center-interface"
      aria-label="JARVIS Command Center"
    >
      <div className="command-center-orbit-guide command-center-orbit-guide-a" />
      <div className="command-center-orbit-guide command-center-orbit-guide-b" />

      <article className="command-panel command-panel-objective">
        <div className="command-panel-eyebrow">
          CURRENT OBJECTIVE
        </div>

        <div className="command-objective-text">
          {objective}
        </div>

        <div className="command-panel-meta">
          EXECUTION LAYER
        </div>
      </article>

      <article className="command-panel command-panel-next-action">
        <div className="command-panel-heading-row">
          <div className="command-panel-eyebrow">
            NEXT ACTION
          </div>

          {actionComplete && (
            <div className="command-complete-badge">
              COMPLETE
            </div>
          )}
        </div>

        <input
          type="text"
          className={[
            'command-next-action-input',
            actionComplete
              ? 'is-complete'
              : '',
          ]
            .filter(Boolean)
            .join(' ')}
          value={nextAction}
          placeholder="Continue JARVIS prototype"
          onChange={(event) =>
            actions.setNextAction(
              event.target.value,
            )
          }
        />

        <div className="command-panel-meta">
          {actionComplete
            ? 'All current steps are cleared. Timer continues until time up.'
            : 'The first unchecked step is the current executable action.'}
        </div>
      </article>

      <article className="command-panel command-panel-timer">
        <div className="command-panel-heading-row">
          <div className="command-panel-eyebrow">
            TIMER
          </div>

          <div className="command-status-badge">
            {statusLabel}
          </div>
        </div>

        <div className="command-timer-value">
          <SevenSegmentTime
            value={timerText}
            className="command-seven-segment-time"
          />
        </div>
        
        {timer.status ===
  'idle' && (
  <div className="command-duration-custom">
    <label className="command-duration-field">
      <input
        type="number"
        min="0"
        max="99"
        step="1"
        className="command-duration-input"
        value={durationHours}
        aria-label="Timer hours"
        onFocus={(event) =>
          event.target.select()
        }
        onChange={(event) => {
          const hours =
            Math.min(
              99,
              Math.max(
                0,
                Number.parseInt(
                  event.target.value ||
                    '0',
                  10,
                ) || 0,
              ),
            )

          actions.setDurationMinutes(
            hours * 60 +
              durationMinutesPart,
          )
        }}
      />

      <span className="command-duration-unit">
        H
      </span>
    </label>

    <label className="command-duration-field">
      <input
        type="number"
        min="0"
        max="59"
        step="1"
        className="command-duration-input"
        value={durationMinutesPart}
        aria-label="Timer minutes"
        onFocus={(event) =>
          event.target.select()
        }
        onChange={(event) => {
          const minutes =
            Math.min(
              59,
              Math.max(
                0,
                Number.parseInt(
                  event.target.value ||
                    '0',
                  10,
                ) || 0,
              ),
            )

          actions.setDurationMinutes(
            durationHours * 60 +
              minutes,
          )
        }}
      />

      <span className="command-duration-unit">
        M
      </span>
    </label>
  </div>
)}

        {timer.extensionCount > 0 && (
          <div className="command-auto-extend">
            AUTO EXTEND ×
            {timer.extensionCount}
          </div>
        )}

        <div className="command-duration-presets">
          {TIMER_PRESETS_MINUTES.map(
            (minutes) => (
              <button
                type="button"
                key={minutes}
                className={[
                  'command-duration-button',
                  selectedMinutes ===
                  minutes
                    ? 'is-selected'
                    : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                disabled={timerLocked}
                onClick={() =>
                  actions.setDurationMinutes(
                    minutes,
                  )
                }
              >
                {minutes}M
              </button>
            ),
          )}
        </div>

        <div className="command-timer-actions">
          {timer.status ===
            'idle' && (
            <button
              type="button"
              className="command-action-button primary"
              onClick={actions.start}
            >
              START
            </button>
          )}

          {timer.status ===
            'active' && (
            <>
              <button
                type="button"
                className="command-action-button primary"
                onClick={actions.pause}
              >
                PAUSE
              </button>

              <button
                type="button"
                className="command-action-button subtle"
                onClick={actions.end}
              >
                END
              </button>
            </>
          )}

          {timer.status ===
            'paused' && (
            <>
              <button
                type="button"
                className="command-action-button primary"
                onClick={actions.resume}
              >
                RESUME
              </button>

              <button
                type="button"
                className="command-action-button subtle"
                onClick={actions.end}
              >
                END
              </button>
            </>
          )}

          {(timer.status ===
            'done' ||
            timer.status ===
              'ended') && (
            <button
              type="button"
              className="command-action-button primary"
              onClick={
                actions.prepareNewRun
              }
            >
              NEW RUN
            </button>
          )}
        </div>
      </article>

      <article className="command-panel command-panel-checklist">
        <div className="command-panel-heading-row">
          <div className="command-panel-eyebrow">
            CHECKLIST
          </div>

          <div className="command-progress-label">
            {Math.round(
              progress * 100,
            )}%
          </div>
        </div>

        <div className="command-progress-track">
          <div
            className="command-progress-fill"
            style={{
              width: `${progress * 100}%`,
            }}
          />
        </div>

        <div className="command-checklist-items">
          {checklist.length ===
            0 && (
            <div className="command-empty-checklist">
              Add the first executable step.
            </div>
          )}

          {checklist.map(
            (item) => {
              const isCurrent =
                item.id ===
                currentItemId

              return (
                <div
                  key={item.id}
                  className={[
                    'command-check-item',
                    item.checked
                      ? 'is-done'
                      : '',
                    isCurrent
                      ? 'is-current'
                      : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                >
                  <button
                    type="button"
                    className="command-check-toggle"
                    onClick={() =>
                      actions.toggleChecklistItem(
                        item.id,
                      )
                    }
                    disabled={
                      timer.status ===
                        'done' ||
                      timer.status ===
                        'ended'
                    }
                    aria-label={`Toggle ${item.text}`}
                  >
                    {item.checked
                      ? '✓'
                      : isCurrent
                        ? '›'
                        : '○'}
                  </button>

                  <div className="command-check-content">
                    {isCurrent && (
                      <span className="command-current-label">
                        NOW
                      </span>
                    )}

                    <span className="command-check-text">
                      {item.text}
                    </span>
                  </div>

                  <button
                    type="button"
                    className="command-check-delete"
                    onClick={() =>
                      actions.deleteChecklistItem(
                        item.id,
                      )
                    }
                    disabled={
                      timer.status ===
                        'done' ||
                      timer.status ===
                        'ended'
                    }
                    aria-label={`Delete ${item.text}`}
                  >
                    ×
                  </button>
                </div>
              )
            },
          )}
        </div>

        {timer.status !== 'done' &&
          timer.status !==
            'ended' && (
          <form
            className="command-add-step"
            onSubmit={addItem}
          >
            <input
              type="text"
              value={newItem}
              onChange={(event) =>
                setNewItem(
                  event.target.value,
                )
              }
              placeholder={
                actionComplete &&
                timer.status ===
                  'active'
                  ? 'Add next step while timer continues'
                  : 'Add checklist step'
              }
            />

            <button
              type="submit"
              disabled={!newItem.trim()}
            >
              +
            </button>
          </form>
        )}
      </article>

      <div className="command-external-module command-external-weather">
        <span>WEATHER</span>
        <strong>OFFLINE</strong>
      </div>

      <div className="command-external-module command-external-calendar">
        <span>CALENDAR</span>
        <strong>OFFLINE</strong>
      </div>

      <div className="command-external-module command-external-news">
        <span>NEWS</span>
        <strong>OFFLINE</strong>
      </div>
    </section>
  )
}
