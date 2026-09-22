import {
  useEffect,
  useReducer,
  useRef,
  useState,
} from 'react'

import CommandCenter from './CommandCenter'
import TreePrototype from './TreePrototype'
import QuickPip from './QuickPip'
import useExecutionSession from './useExecutionSession'
import useJarvisRuntime, {
  RUNTIME_STATUS,
} from './useJarvisRuntime'

import useVoiceOutput from './useVoiceOutput'

import './App.css'

const PIP_BREAKPOINT = 500

/*
  Native Electron transition timings.

  이 값들은 CSS transition과 맞물려 있으므로
  Anime.js Command Center choreography와 분리해서 유지한다.
*/
const OPENING_MS = 500

const CLOSING_PREP_MS = 240
const CLOSING_MOVE_MS = 420
const PIP_FADE_MS = 160

/*
  XState 같은 라이브러리를 아직 도입하지 않고,
  핵심 아이디어만 가져온 작은 explicit state machine.

  view = 사용자가 현재 어느 major surface에 있는가
  phase = 그 surface 사이를 이동하는 중이라면 어느 단계인가
*/
const VIEW = Object.freeze({
  PIP: 'pip',
  COMMAND_CENTER:
    'command-center',
})

const PHASE = Object.freeze({
  IDLE: 'idle',
  OPENING_START:
    'opening-start',
  OPENING: 'opening',
  CLOSING_PREP:
    'closing-prep',
  CLOSING_MOVING:
    'closing-moving',
  CLOSING_SWAP:
    'closing-swap',
  PIP_FADE: 'pip-fade',
})

const APP_EVENT = Object.freeze({
  OPEN_PREPARED:
    'open-prepared',
  OPEN_WINDOW_EXPANDED:
    'open-window-expanded',
  OPEN_COMPLETE:
    'open-complete',
  OPEN_ABORT:
    'open-abort',

  CLOSE_BEGIN:
    'close-begin',
  CLOSE_MOVE:
    'close-move',
  CLOSE_SWAP:
    'close-swap',
  CLOSE_WINDOW_COLLAPSED:
    'close-window-collapsed',
  CLOSE_FADE:
    'close-fade',
  CLOSE_COMPLETE:
    'close-complete',
  CLOSE_ABORT:
    'close-abort',
})

/*
  dnd-kit의 Sensor abstraction에서 아이디어만 가져온다.

  Mouse / Keyboard가 곧바로 transition 구현을 호출하지 않고
  먼저 "사용자가 무엇을 의도했는가"로 변환한다.

  미래에는 wheel / gesture / voice가 추가되어도
  같은 intent로 연결할 수 있다.
*/
const APP_INTENT = Object.freeze({
  OPEN_COMMAND_CENTER:
    'open-command-center',
  RETURN_TO_PIP:
    'return-to-pip',
})

/*
  PiP ↔ fullscreen window transition은 Electron/native view와 분리한다.
  Fullscreen 내부는 V4 Assistant가 기본 surface이고 Context만 선택적으로 열린다.
*/
const createInitialInteraction =
  () => ({
    view:
      window.innerWidth <=
      PIP_BREAKPOINT
        ? VIEW.PIP
        : VIEW.COMMAND_CENTER,

    phase: PHASE.IDLE,
  })

/*
  허용된 transition만 표현한다.

  예를 들어 PiP에서 opening 중인 동시에 closing이 되는
  모순된 상태를 이벤트 하나로 만들 수 없게 한다.
  현재 규모에서는 XState를 설치하지 않고 이 정도로 충분하다.
*/
const interactionReducer = (
  state,
  event,
) => {
  switch (event.type) {
    case APP_EVENT.OPEN_PREPARED:
      if (
        state.view === VIEW.PIP &&
        state.phase === PHASE.IDLE
      ) {
        return {
          ...state,
          phase:
            PHASE.OPENING_START,
        }
      }
      return state

    case APP_EVENT.OPEN_WINDOW_EXPANDED:
      if (
        state.view === VIEW.PIP &&
        state.phase ===
          PHASE.OPENING_START
      ) {
        return {
          ...state,
          phase: PHASE.OPENING,
        }
      }
      return state

    case APP_EVENT.OPEN_COMPLETE:
      if (
        state.view === VIEW.PIP &&
        state.phase ===
          PHASE.OPENING
      ) {
        return {
          view:
            VIEW.COMMAND_CENTER,
          phase: PHASE.IDLE,
        }
      }
      return state

    case APP_EVENT.OPEN_ABORT:
      if (
        state.view === VIEW.PIP &&
        (state.phase ===
          PHASE.OPENING_START ||
          state.phase ===
            PHASE.OPENING)
      ) {
        return {
          ...state,
          phase: PHASE.IDLE,
        }
      }
      return state

    case APP_EVENT.CLOSE_BEGIN:
      if (
        state.view ===
          VIEW.COMMAND_CENTER &&
        state.phase === PHASE.IDLE
      ) {
        return {
          ...state,
          phase:
            PHASE.CLOSING_PREP,
        }
      }
      return state

    case APP_EVENT.CLOSE_MOVE:
      if (
        state.view ===
          VIEW.COMMAND_CENTER &&
        state.phase ===
          PHASE.CLOSING_PREP
      ) {
        return {
          ...state,
          phase:
            PHASE.CLOSING_MOVING,
        }
      }
      return state

    case APP_EVENT.CLOSE_SWAP:
      if (
        state.view ===
          VIEW.COMMAND_CENTER &&
        state.phase ===
          PHASE.CLOSING_MOVING
      ) {
        return {
          ...state,
          phase:
            PHASE.CLOSING_SWAP,
        }
      }
      return state

    case APP_EVENT.CLOSE_WINDOW_COLLAPSED:
      if (
        state.view ===
          VIEW.COMMAND_CENTER &&
        state.phase ===
          PHASE.CLOSING_SWAP
      ) {
        return {
          view: VIEW.PIP,
          phase:
            PHASE.CLOSING_SWAP,
        }
      }
      return state

    case APP_EVENT.CLOSE_FADE:
      if (
        state.view === VIEW.PIP &&
        state.phase ===
          PHASE.CLOSING_SWAP
      ) {
        return {
          ...state,
          phase: PHASE.PIP_FADE,
        }
      }
      return state

    case APP_EVENT.CLOSE_COMPLETE:
      if (
        state.view === VIEW.PIP &&
        state.phase ===
          PHASE.PIP_FADE
      ) {
        return {
          ...state,
          phase: PHASE.IDLE,
        }
      }
      return state

    case APP_EVENT.CLOSE_ABORT:
      if (
        state.view ===
          VIEW.COMMAND_CENTER &&
        state.phase !== PHASE.IDLE
      ) {
        return {
          ...state,
          phase: PHASE.IDLE,
        }
      }
      return state

    default:
      return state
  }
}

const wait = (duration) =>
  new Promise((resolve) => {
    window.setTimeout(
      resolve,
      duration,
    )
  })

const nextFrame = () =>
  new Promise((resolve) => {
    window.requestAnimationFrame(
      () => resolve(),
    )
  })

const nextPaint = async () => {
  await nextFrame()
  await nextFrame()
}

function CoreGraphic({
  onActivate,
  ariaLabel,
}) {
  return (
    <div className="core-outer-ring">
      <div
        className="core-orbit-layer"
        aria-hidden="true"
      >
        <div className="core-orbit core-orbit-a" />
        <div className="core-orbit core-orbit-c" />

        <div className="core-orbit core-orbit-b" />
        <div className="core-orbit core-orbit-d" />
      </div>

      <div className="core-middle-ring">
        <button
          type="button"
          className="core-trigger"
          onClick={onActivate}
          aria-label={ariaLabel}
        >
          <div className="core-energy" />
        </button>
      </div>
    </div>
  )
}

function App() {
  const [interaction, dispatch] =
    useReducer(
      interactionReducer,
      undefined,
      createInitialInteraction,
    )

  const {
    view,
    phase,
  } = interaction

  const isPip =
    view === VIEW.PIP

  const [
    pipOffset,
    setPipOffset,
  ] = useState({
    x: 0,
    y: 0,
  })

  const [
    executionContext,
    setExecutionContext,
  ] = useState(null)

  const [
    contextOpen,
    setContextOpen,
  ] = useState(false)

  /*
    The legacy execution session remains isolated to the PiP compatibility
    surface. Assistant runtime state is owned only by useJarvisRuntime.
  */
  const execution =
    useExecutionSession()

  /*
    JARVIS runtime (Task 2) — PiP와 Command Center가 같은 상태를 구독한다.
    Freebuff는 runtime 밖에 있다: Qwen + Harness + Permission Gate 전부
    Electron이 spawn한 Python bridge가 담당한다.
  */
  const runtime =
    useJarvisRuntime()

  /*
    Voice interaction mode (STEP 4).
    App이 훅을 소유하고 DONE 시 speak를 담당하므로,
    승인(PiP) 후 완료되거나 Command Center에서 완료되거나
    어느 surface에서든 음성 모드라면 응답을 소리로 들려준다.
  */
  const voiceOutput =
    useVoiceOutput()

  const voiceEnabled =
    voiceOutput.enabled

  const speakVoice =
    voiceOutput.speak

  const lastSpokenRef =
    useRef(null)

  useEffect(() => {
    if (
      runtime.status ===
      RUNTIME_STATUS.THINKING
    ) {
      lastSpokenRef.current = null
      return
    }

    if (
      !voiceEnabled ||
      runtime.status !==
        RUNTIME_STATUS.DONE
    ) {
      return
    }

    const text = runtime.text

    if (
      !text ||
      lastSpokenRef.current === text
    ) {
      return
    }

    lastSpokenRef.current = text
    speakVoice(text)
  }, [
    runtime.status,
    runtime.text,
    voiceEnabled,
    speakVoice,
  ])

  const getWindowApi = () => {
    if (!window.jarvisWindow) {
      console.error(
        'JARVIS window API를 찾을 수 없습니다. Electron을 재실행하세요.',
      )

      return null
    }

    return window.jarvisWindow
  }

  const openCommandCenter =
    async () => {
      if (
        view !== VIEW.PIP ||
        phase !== PHASE.IDLE
      ) {
        return
      }

      const windowApi =
        getWindowApi()

      if (!windowApi) {
        return
      }

      /*
        FLIP 관점의 기존 transition을 그대로 보존한다.

        First  : 현재 PiP의 화면상 위치를 측정
        Last   : workArea 전체에서 Core가 중앙에 놓일 최종 layout
        Invert : --pip-offset-x/y로 "아직 PiP 위치에 있는 것처럼" 역보정
        Play   : CSS transform이 offset → 0으로 움직이며 공간을 펼침

        즉 별도 Motion 라이브러리를 넣지 않아도
        현재 signature transition은 이미 FLIP과 유사한 구조다.
      */
      const geometry =
        await windowApi
          .prepareCommandCenter()

      if (!geometry) {
        return
      }

      setPipOffset({
        x: geometry.offsetX,
        y: geometry.offsetY,
      })

      dispatch({
        type:
          APP_EVENT.OPEN_PREPARED,
      })

      await nextPaint()

      const expanded =
        await windowApi
          .expandCommandCenter()

      if (!expanded) {
        dispatch({
          type:
            APP_EVENT.OPEN_ABORT,
        })
        return
      }

      await nextPaint()

      dispatch({
        type:
          APP_EVENT.OPEN_WINDOW_EXPANDED,
      })

      await nextFrame()
      await wait(OPENING_MS)

      dispatch({
        type:
          APP_EVENT.OPEN_COMPLETE,
      })
    }

  const returnToPip =
    async () => {
      if (
        view !==
          VIEW.COMMAND_CENTER ||
        phase !== PHASE.IDLE
      ) {
        return
      }

      const windowApi =
        getWindowApi()

      if (!windowApi) {
        return
      }

      dispatch({
        type:
          APP_EVENT.CLOSE_BEGIN,
      })

      await nextFrame()
      await wait(
        CLOSING_PREP_MS,
      )

      dispatch({
        type:
          APP_EVENT.CLOSE_MOVE,
      })

      await nextFrame()
      await wait(
        CLOSING_MOVE_MS,
      )

      dispatch({
        type:
          APP_EVENT.CLOSE_SWAP,
      })

      await nextPaint()

      const collapsed =
        await windowApi
          .collapseToPip()

      if (!collapsed) {
        dispatch({
          type:
            APP_EVENT.CLOSE_ABORT,
        })
        return
      }

      await nextPaint()

      dispatch({
        type:
          APP_EVENT.CLOSE_WINDOW_COLLAPSED,
      })

      await nextPaint()

      dispatch({
        type:
          APP_EVENT.CLOSE_FADE,
      })

      await nextFrame()
      await wait(PIP_FADE_MS)

      dispatch({
        type:
          APP_EVENT.CLOSE_COMPLETE,
      })
    }

  /*
    Input source를 product intent로 한 번 변환한다.

    지금은:
    - Core click → OPEN / RETURN
    - Escape     → RETURN

    나중에 wheel / keyboard shortcut / gesture가 생겨도
    transition 구현을 복제하지 않고 같은 intent를 요청하면 된다.
  */
  const requestIntent = (
    intent,
  ) => {
    if (phase !== PHASE.IDLE) {
      return
    }

    if (
      intent ===
        APP_INTENT.OPEN_COMMAND_CENTER &&
      view === VIEW.PIP
    ) {
      openCommandCenter()
      return
    }

    if (
      intent ===
        APP_INTENT.RETURN_TO_PIP &&
      view ===
        VIEW.COMMAND_CENTER
    ) {
      returnToPip()
    }
  }

  const handleCoreClick = () => {
    requestIntent(
      isPip
        ? APP_INTENT.OPEN_COMMAND_CENTER
        : APP_INTENT.RETURN_TO_PIP,
    )
  }

  /*
    Permission Gate가 걸리면 Command Center에서 작업 중이어도
    PiP로 돌아와 승인/거절을 보여준다 (Task 3: PiP = 승인 surface).
  */
  const viewRef = useRef(view)
  const phaseRef = useRef(phase)

  useEffect(() => {
    viewRef.current = view
    phaseRef.current = phase
  }, [view, phase])

  useEffect(() => {
    if (
      runtime.status !==
        RUNTIME_STATUS.AWAITING_CONFIRMATION
    ) {
      return
    }

    if (
      viewRef.current ===
        VIEW.COMMAND_CENTER &&
      phaseRef.current === PHASE.IDLE
    ) {
      requestIntent(
        APP_INTENT.RETURN_TO_PIP,
      )
    }
  }, [runtime.status])

  useEffect(() => {
    const handleKeyDown =
      (event) => {
        if (
          event.key !==
          'Escape'
        ) {
          return
        }

        if (
          view !==
            VIEW.COMMAND_CENTER ||
          phase !== PHASE.IDLE
        ) {
          return
        }

        event.preventDefault()

        requestIntent(
          APP_INTENT.RETURN_TO_PIP,
        )
      }

    window.addEventListener(
      'keydown',
      handleKeyDown,
    )

    return () => {
      window.removeEventListener(
        'keydown',
        handleKeyDown,
      )
    }
  }, [view, phase])

  const phaseClass =
    phase === PHASE.IDLE
      ? ''
      : phase

  const modeClass =
    isPip
      ? 'pip-mode'
      : 'command-center-mode'

  const quickPipClass =
    isPip &&
    phase === PHASE.IDLE
      ? 'quick-pip-enabled'
      : ''

  const showLabel = false

  const showAssistantSurface =
    !isPip &&
    phase === PHASE.IDLE

  // V4: the assistant is the only primary fullscreen surface.
  // Context opens as an optional secondary drawer instead of a mode choice.
  const showCommandCenter =
    showAssistantSurface

  const showTreePrototype =
    showAssistantSurface &&
    contextOpen

  return (
    <main
      className={[
        'jarvis-shell',
        'v4-assistant-shell',
        modeClass,
        phaseClass,
        quickPipClass,
      ]
        .filter(Boolean)
        .join(' ')}
      data-view={view}
      data-phase={phase}
      data-context-open={contextOpen ? 'true' : 'false'}
      style={{
        '--pip-offset-x':
          `${pipOffset.x}px`,

        '--pip-offset-y':
          `${pipOffset.y}px`,
      }}
    >
      {showCommandCenter && (
        <CommandCenter
          executionContext={executionContext}
          runtime={runtime}
          voiceOutput={voiceOutput}
          contextOpen={contextOpen}
          onToggleContext={() => setContextOpen((open) => !open)}
        />
      )}

      {showTreePrototype && (
        <aside className="v4-context-drawer" aria-label="JARVIS context">
          <TreePrototype
            runtime={runtime}
            executionContext={executionContext}
            onOpenExecution={(context) => {
              if (context) {
                setExecutionContext(context)
              }
              setContextOpen(false)
            }}
          />
        </aside>
      )}

      <div className="pip-interaction-zone">
        <section
          className="core-container"
          aria-label="JARVIS Core"
        >
          <CoreGraphic
            onActivate={
              handleCoreClick
            }
            ariaLabel={
              isPip
                ? 'Open JARVIS Command Center'
                : 'Return JARVIS to PiP'
            }
          />

          {showLabel && (
            <p className="core-label">
              JARVIS
            </p>
          )}
        </section>

        {/*
          Activation Prototype는 의도적으로 연결하지 않는다.

          기존 Next Action과 다른 제품 역할이 명확해진 뒤에만
          별도 activation flow를 다시 검토한다.
          현재 Quick PiP / Timer / Current Step 동작을 우선 보존한다.
        */}
        <QuickPip
          execution={execution}
          runtime={runtime}
          pipMode={isPip}
        />
      </div>
    </main>
  )
}

export default App
