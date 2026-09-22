import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'

import {
  createScope,
  createTimeline,
} from 'animejs'

import {
  Mic,
  PanelLeft,
  Volume2,
  VolumeX,
} from 'lucide-react'

import ActivityTimeline from './ActivityTimeline'
import FocusIndicator from './FocusIndicator'
import JarvisRuntimePanel from './JarvisRuntimePanel'

import {
  useVoiceCapture,
  VOICE_STATE,
} from './useVoiceCapture'

const ASSISTANT_MOTION = {
  orbitGuideDurationMs: 760,
}

export default function CommandCenter({
  executionContext,
  runtime,
  voiceOutput,
  contextOpen = false,
  onToggleContext,
}) {
  const rootRef = useRef(null)
  const promptInputRef = useRef(null)
  const filledVoiceSeq = useRef(0)
  const [prompt, setPrompt] = useState('')
  const voice = useVoiceCapture()

  useEffect(() => {
    if (
      !voice.transcript ||
      voice.resultSeq === filledVoiceSeq.current
    ) {
      return
    }

    filledVoiceSeq.current = voice.resultSeq

    setPrompt((current) => {
      const existing = current.trim()
      const addition = voice.transcript.trim()

      if (!existing) {
        return addition
      }

      if (!addition) {
        return current
      }

      return `${existing} ${addition}`
    })
    promptInputRef.current?.focus()
  }, [voice.transcript, voice.resultSeq])

  useLayoutEffect(() => {
    const scope = createScope({
      root: rootRef,
      mediaQueries: {
        reducedMotion: '(prefers-reduced-motion: reduce)',
      },
    }).add((self) => {
      if (self.matches.reducedMotion) {
        return
      }

      const entrance = createTimeline({
        autoplay: false,
        defaults: {
          duration: ASSISTANT_MOTION.orbitGuideDurationMs,
          ease: 'out(3)',
        },
      })

      entrance
        .add('.command-center-orbit-guide', {
          opacity: [0, 1],
          duration: ASSISTANT_MOTION.orbitGuideDurationMs,
        })
        .init()
        .play()
    })

    return () => scope.revert()
  }, [])

  const handleJarvisSubmit = (event) => {
    event.preventDefault()

    const trimmed = prompt.trim()

    if (!trimmed) {
      return
    }

    runtime.submit(trimmed, runtime.projectId)
    setPrompt('')
  }

  const runtimeBusy =
    runtime.status === 'thinking' ||
    runtime.status === 'tool-running' ||
    runtime.status === 'awaiting-confirmation'

  return (
    <section
      ref={rootRef}
      className="command-center-interface antialiased"
      aria-label="JARVIS Command Center"
    >
      <div className="command-center-orbit-guide command-center-orbit-guide-a" />
      <div className="command-center-orbit-guide command-center-orbit-guide-b" />

      <div
        className="command-center-axis command-center-axis-horizontal"
        aria-hidden="true"
      />
      <div
        className="command-center-axis command-center-axis-vertical"
        aria-hidden="true"
      />

      <div className="command-workspace">
        <article
          className="command-panel command-panel-runtime"
          aria-label="JARVIS runtime"
        >
          <div className="command-panel-heading-row">
            <div className="command-panel-eyebrow">JARVIS</div>

            <button
              type="button"
              className={[
                'jarvis-context-button',
                contextOpen ? 'is-active' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              onClick={onToggleContext}
              aria-pressed={contextOpen}
              aria-label="Toggle JARVIS context"
              title="Show or hide Projects, Tasks, Files, and Pages"
            >
              <PanelLeft size={14} strokeWidth={1.8} aria-hidden="true" />
              <span>Context</span>
            </button>

            {runtime.scratch && (
              <div className="jarvis-scratch-badge">SCRATCH</div>
            )}
          </div>

          <FocusIndicator executionContext={executionContext} />

          <form
            className="jarvis-command-form"
            onSubmit={handleJarvisSubmit}
          >
            <button
              type="button"
              className={[
                'jarvis-mic-button',
                voice.state === VOICE_STATE.LISTENING
                  ? 'is-listening'
                  : '',
                voice.state === VOICE_STATE.STARTING
                  ? 'is-starting'
                  : '',
                voice.state === VOICE_STATE.TRANSCRIBING
                  ? 'is-busy'
                  : '',
              ]
                .filter(Boolean)
                .join(' ')}
              onPointerDown={(event) => {
                event.preventDefault()
                voiceOutput.stop()
                voice.start()
              }}
              disabled={
                voice.state === VOICE_STATE.TRANSCRIBING ||
                runtimeBusy
              }
              title="마이크로 말하기 — 누르고 있는 동안 녹음, 떼면 전사"
              aria-label="마이크로 말하기 (누르고 있는 동안 녹음)"
            >
              <Mic size={14} strokeWidth={2} aria-hidden="true" />
            </button>

            <input
              ref={promptInputRef}
              className="jarvis-command-input"
              type="text"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="Ask JARVIS…"
              disabled={
                runtime.status === 'thinking' ||
                runtime.status === 'tool-running'
              }
              aria-label="JARVIS command input"
            />

            <button
              type="submit"
              className="jarvis-command-send"
              disabled={
                !prompt.trim() ||
                runtime.status === 'thinking' ||
                runtime.status === 'tool-running'
              }
            >
              Send
            </button>

            <button
              type="button"
              className={[
                'jarvis-voice-mode-button',
                voiceOutput.enabled ? 'is-active' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              onClick={voiceOutput.toggle}
              disabled={voice.state !== VOICE_STATE.IDLE || runtimeBusy}
              title={
                voiceOutput.enabled
                  ? '음성 모드 끄기 — 응답을 소리로 듣지 않음'
                  : '음성 모드 켜기 — Qwen 응답을 소리로 듣기'
              }
              aria-label="음성 모드 (응답을 소리로 듣기)"
              aria-pressed={voiceOutput.enabled}
            >
              {voiceOutput.enabled ? (
                <Volume2 size={16} strokeWidth={2} aria-hidden="true" />
              ) : (
                <VolumeX size={16} strokeWidth={2} aria-hidden="true" />
              )}
            </button>
          </form>

          {(voice.state !== VOICE_STATE.IDLE ||
            voice.transcript ||
            voice.error ||
            voice.statusLine ||
            voiceOutput.enabled) && (
            <div
              className={[
                'jarvis-voice-status',
                voice.error ? 'is-error' : '',
                voice.state === VOICE_STATE.LISTENING
                  ? 'is-listening'
                  : '',
                voice.state === VOICE_STATE.TRANSCRIBING
                  ? 'is-busy'
                  : '',
              ]
                .filter(Boolean)
                .join(' ')}
            >
              {voice.error ? (
                <>
                  <span className="jarvis-voice-status-label">VOICE ERROR</span>
                  <span>{voice.error}</span>
                </>
              ) : voice.transcript ? (
                <>
                  <span className="jarvis-voice-status-label">들음</span>
                  <span className="jarvis-voice-transcript">
                    “{voice.transcript}”
                  </span>
                  {voice.deviceName && (
                    <span className="jarvis-voice-device">
                      {voice.deviceName}
                    </span>
                  )}
                </>
              ) : (
                <>
                  {(voice.state === VOICE_STATE.LISTENING ||
                    voice.state === VOICE_STATE.STARTING) && (
                    <span className="jarvis-voice-pulse" />
                  )}
                  <span>
                    {voice.statusLine ||
                      (voice.state === VOICE_STATE.LISTENING
                        ? '듣는 중…'
                        : voice.state === VOICE_STATE.STARTING
                          ? '음성 준비 중…'
                          : voice.state === VOICE_STATE.TRANSCRIBING
                            ? '전사 중…'
                            : voiceOutput.enabled
                              ? '음성 모드 — 응답도 소리로 들립니다'
                              : '')}
                  </span>
                </>
              )}
            </div>
          )}

          <JarvisRuntimePanel
            runtime={runtime}
            onApprove={runtime.approve}
            onReject={runtime.reject}
            onDismiss={runtime.dismiss}
          >
            <div className="jarvis-runtime-placeholder">
              {runtime.text || '할 일을 물어보거나, 새 task를 추가해보세요.'}
            </div>
          </JarvisRuntimePanel>

          <ActivityTimeline
            timeline={runtime.timeline}
            traceId={runtime.traceId}
            tracePath={runtime.tracePath}
          />
        </article>
      </div>
    </section>
  )
}
