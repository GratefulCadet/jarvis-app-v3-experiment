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
  Check,
  FileText,
  Link2,
  Mic,
  PanelLeft,
  Sparkles,
  Volume2,
  VolumeX,
  X,
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

/*
  Resume Briefing (M1 — 복귀 → 이어서 시작).

  resume_briefing read tool의 결정적 조립 결과를 그대로 그린다 — 프로젝트,
  task 현황, 관련 파일, 마지막 활동, 다음 행동 제안. [시작]은 다음 행동을
  기존 실행 문맥(Focus)으로 넘길 뿐이고, 어떤 상태도 여기서 변경하지 않는다.
*/
function ResumeBriefingPanel({ briefing, onStartTask, onDismiss }) {
  if (!briefing || briefing.status !== 'ok') {
    return null
  }

  const {
    project,
    tasks,
    resources,
    last_activity: lastActivity,
    next_action: nextAction,
    notes,
  } = briefing

  const recent = (lastActivity || [])[0]
  // M2 — 다음 행동 task에 연결된 파일이 먼저 뜨도록 정렬 (관련 자료 정확도)
  const nextFiles = (nextAction?.resources || [])
    .map((entry) => entry.file?.name || entry.file?.path)
    .filter(Boolean)
  const nextFileIds = new Set(
    (nextAction?.resources || [])
      .map((entry) => entry.file?.id)
      .filter(Boolean),
  )
  const otherFiles = (resources || [])
    .filter((entry) => !nextFileIds.has(entry.file?.id))
    .map((entry) => entry.file?.name || entry.file?.path)
    .filter(Boolean)
  const fileNames = [...nextFiles, ...otherFiles]

  return (
    <section
      className="jarvis-resume-briefing"
      aria-label="Resume briefing"
    >
      <div className="jarvis-resume-heading">
        <span className="jarvis-resume-title">RESUME</span>
        <strong>{project?.title || project?.id}</strong>
        {onDismiss && (
          <button
            type="button"
            className="jarvis-resume-dismiss"
            onClick={onDismiss}
            title="Close resume briefing"
            aria-label="Close resume briefing"
          >
            <X size={11} strokeWidth={2} aria-hidden="true" />
          </button>
        )}
      </div>

      <div className="jarvis-resume-rows">
        <div className="jarvis-resume-row">
          <span>Tasks</span>
          <span>
            {tasks?.open_count ?? 0} open · {tasks?.completed_count ?? 0} done
          </span>
        </div>
        {recent?.summary && (
          <div className="jarvis-resume-row">
            <span>Last</span>
            <span className="jarvis-resume-clamp">{recent.summary}</span>
          </div>
        )}
        {fileNames.length > 0 && (
          <div className="jarvis-resume-row">
            <span>Files</span>
            <span className="jarvis-resume-clamp">
              {fileNames.slice(0, 3).join(' · ')}
            </span>
          </div>
        )}
      </div>

      <div className="jarvis-resume-next">
        <div className="jarvis-resume-next-text">
          <span className="jarvis-resume-next-label">NEXT</span>
          {nextAction ? (
            <>
              <strong>{nextAction.title}</strong>
              {nextAction.reason && (
                <span className="jarvis-resume-clamp">
                  {nextAction.reason}
                </span>
              )}
              {nextFiles.length > 0 && (
                <span className="jarvis-resume-clamp jarvis-resume-next-files">
                  자료: {nextFiles.join(' · ')}
                </span>
              )}
            </>
          ) : (
            <span>바로 이어서 할 일이 없습니다.</span>
          )}
        </div>
        {nextAction && onStartTask && (
          <button
            type="button"
            className="jarvis-resume-start"
            onClick={() => onStartTask(nextAction)}
            title="이 작업을 현재 초점으로 시작"
          >
            시작
          </button>
        )}
      </div>

      {(notes || []).length > 0 && (
        <div className="jarvis-resume-notes">
          {notes.join(' · ')}
        </div>
      )}
    </section>
  )
}

export default function CommandCenter({
  executionContext,
  runtime,
  voiceOutput,
  activeFile,
  onCloseActiveFile,
  onStartTask,
  onLinkFileToFocus,
  contextOpen = false,
  onToggleContext,
}) {
  const rootRef = useRef(null)
  const promptInputRef = useRef(null)
  const filledVoiceSeq = useRef(0)
  const [prompt, setPrompt] = useState('')
  const voice = useVoiceCapture()

  /*
    M2 — Active File → focused Task 연결.
    사용자가 버튼을 누를 때만 canonical ResourceLink가 생성된다 — AI 자동
    연결 없음(V4 §13-C). 상태는 (task, file) 짝 단위로 초기화된다.
  */
  const [fileLinkState, setFileLinkState] = useState({
    key: '',
    status: 'idle',
    error: '',
  })

  const focusNode = executionContext?.node
  const focusTaskId =
    typeof focusNode?.id === 'string' &&
    focusNode.id.startsWith('t-')
      ? focusNode.id
      : null
  const fileLinkKey =
    focusTaskId && activeFile?.fileId
      ? `${focusTaskId}|${activeFile.fileId}`
      : ''
  const linkStatus =
    fileLinkState.key === fileLinkKey ? fileLinkState.status : 'idle'

  const handleLinkFile = async () => {
    if (!fileLinkKey || !onLinkFileToFocus) return
    if (linkStatus === 'linking' || linkStatus === 'linked') return
    setFileLinkState({ key: fileLinkKey, status: 'linking', error: '' })
    const result = await onLinkFileToFocus()
    if (result?.ok) {
      setFileLinkState({ key: fileLinkKey, status: 'linked', error: '' })
    } else {
      setFileLinkState({
        key: fileLinkKey,
        status: 'error',
        error: result?.error || '연결에 실패했습니다',
      })
    }
  }

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

    runtime.submit(trimmed, runtime.projectId, {
      activeFile: activeFile
        ? {
            fileId: activeFile.fileId,
            rootId: activeFile.rootId,
            path: activeFile.path,
            label: activeFile.label,
          }
        : null,
    })
    setPrompt('')
  }

  const runtimeBusy =
    runtime.status === 'thinking' ||
    runtime.status === 'tool-running' ||
    runtime.status === 'awaiting-confirmation'

  const handleQuickAction = (quickPromptText) => {
    if (runtimeBusy) return
    runtime.submit(quickPromptText, runtime.projectId, {
      activeFile: activeFile
        ? {
            fileId: activeFile.fileId,
            rootId: activeFile.rootId,
            path: activeFile.path,
            label: activeFile.label,
          }
        : null,
    })
  }

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

          {/*
            Active File 칩 & Context Quick Actions (Cursor/Raycast benchmarked)
            열려 있는 파일이 있을 때 사람이 읽는 경로와 함께 원클릭 빠른 액션 제공
          */}
          {activeFile?.path && (
            <div className="jarvis-active-file-container">
              <div
                className="jarvis-active-file-chip"
                title={activeFile.path}
              >
                <FileText
                  size={12}
                  strokeWidth={1.8}
                  aria-hidden="true"
                />
                <span>{activeFile.label || activeFile.path}</span>
                {onCloseActiveFile && (
                  <button
                    type="button"
                    className="jarvis-active-file-close"
                    onClick={(e) => {
                      e.stopPropagation()
                      onCloseActiveFile()
                    }}
                    title="Remove active file context"
                    aria-label="Remove active file context"
                  >
                    <X size={10} strokeWidth={2} aria-hidden="true" />
                  </button>
                )}
              </div>

              <div className="jarvis-quick-actions" aria-label="Quick actions for active file">
                <button
                  type="button"
                  className="jarvis-quick-action-btn"
                  onClick={() => handleQuickAction(`이 파일(${activeFile.label || activeFile.path})의 내용을 핵심 위주로 요약해줘.`)}
                  disabled={runtimeBusy}
                  title="파일 내용 요약 요청"
                >
                  <Sparkles size={11} strokeWidth={1.8} aria-hidden="true" />
                  <span>요약</span>
                </button>
                <button
                  type="button"
                  className="jarvis-quick-action-btn"
                  onClick={() => handleQuickAction(`이 파일(${activeFile.label || activeFile.path})의 구조와 주요 로직을 설명해줘.`)}
                  disabled={runtimeBusy}
                  title="코드/문서 구조 설명 요청"
                >
                  <span>구조 설명</span>
                </button>
                <button
                  type="button"
                  className="jarvis-quick-action-btn"
                  onClick={() => handleQuickAction(`이 파일(${activeFile.label || activeFile.path})에서 개선할 점이나 잠재적 버그를 검토해줘.`)}
                  disabled={runtimeBusy}
                  title="코드 리뷰 및 개선점 검토"
                >
                  <span>개선점 검토</span>
                </button>
              </div>

              {/*
                M2 — 이 파일을 현재 초점 작업에 연결 (명시적 사용자 행동만).
                task가 초점일 때만 나타나고, 연결되면 복귀 브리핑에 그 자료로 실린다.
              */}
              {focusTaskId && activeFile?.fileId && onLinkFileToFocus && (
                <div className="jarvis-focus-link">
                  <button
                    type="button"
                    className={[
                      'jarvis-link-file-btn',
                      linkStatus === 'linked' ? 'is-linked' : '',
                      linkStatus === 'error' ? 'is-error' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    onClick={handleLinkFile}
                    disabled={linkStatus === 'linking' || linkStatus === 'linked'}
                    title={`이 파일을 "${focusNode?.label || focusTaskId}" 작업에 연결`}
                  >
                    {linkStatus === 'linked' ? (
                      <Check size={11} strokeWidth={2} aria-hidden="true" />
                    ) : (
                      <Link2 size={11} strokeWidth={2} aria-hidden="true" />
                    )}
                    <span>
                      {linkStatus === 'linked'
                        ? '연결됨'
                        : linkStatus === 'linking'
                          ? '연결 중…'
                          : '이 작업에 연결'}
                    </span>
                  </button>
                  {linkStatus === 'error' && (
                    <span className="jarvis-link-file-error" role="alert">
                      {fileLinkState.error}
                    </span>
                  )}
                </div>
              )}
            </div>
          )}

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
              disabled={runtimeBusy}
              aria-label="JARVIS command input"
            />

            <button
              type="submit"
              className="jarvis-command-send"
              disabled={
                !prompt.trim() ||
                runtimeBusy
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

          <ResumeBriefingPanel
            briefing={runtime.resumeBriefing}
            onStartTask={onStartTask}
            onDismiss={runtime.dismissBriefing}
          />

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
