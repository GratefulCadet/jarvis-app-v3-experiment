import {
  useCallback,
  useEffect,
  useReducer,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'

import CommandCenter from './CommandCenter'
import FreebuffNews from './FreebuffNews'
import TreePrototype from './TreePrototype'
import QuickPip from './QuickPip'
import useJarvisRuntime, {
  RUNTIME_STATUS,
} from './useJarvisRuntime'

import useVoiceOutput from './useVoiceOutput'

import { linkTaskFile } from './jarvisLinkApi'

import './App.css'
import './news.css'

const PIP_BREAKPOINT = 500

/*
  PiP ↔ Main signature transition timings.

  이 값들은 CSS transition과 맞물려 있으므로
  Anime.js Command Center choreography와 분리해서 유지한다.

  Motion hierarchy is Core > workspace > content:
  the Core establishes the direction first, the workspace reveal runs behind it,
  and content only enters once the Core has settled. OPENING_MS must therefore not be
  shorter than the Core transform in App.css, otherwise the view flips mid-flight and
  the Core appears to cut.
*/
const CORE_MOVE_MS = 750
const CONTENT_ENTER_MS = 320
const OPENING_MS = CORE_MOVE_MS

const CLOSING_PREP_MS = 240
const CLOSING_MOVE_MS = 420
const PIP_FADE_MS = 160

/*
  Reduced motion keeps the same state machine and the same outcome, but the travel and
  the circular reveal are removed. The JS waits shrink with them so the surface never
  lingers in a non-idle phase.
*/
const prefersReducedMotion = () =>
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches

const motionWait = (duration) =>
  wait(prefersReducedMotion() ? 0 : duration)

/*
  FLIP anchors.

  The Main Core is not laid out at the workArea centre — the V4 shell parks it near
  the top of the workspace — so an offset derived from the workArea centre under-travels
  and the Core teleports when the view flips. Measure the real Core on both sides
  instead: the PiP orb while the window is still small, and the Main Core after the
  native swap. The difference is the transform the CSS has to play.
*/
const CORE_ANCHOR_SELECTORS = {
  pip: '.pip-presence-orb',
  main: '.core-container',
}

function measureCoreAnchor(view) {
  const selector =
    view === VIEW.PIP
      ? CORE_ANCHOR_SELECTORS.pip
      : CORE_ANCHOR_SELECTORS.main
  const element =
    document.querySelector(selector)
  if (!element) {
    return null
  }
  const rect =
    element.getBoundingClientRect()
  if (!rect.width) {
    return null
  }
  return {
    x:
      rect.left +
      rect.width / 2 +
      window.screenX,
    y:
      rect.top +
      rect.height / 2 +
      window.screenY,
  }
}

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

  OPEN_SWAPPED:
    'open-swapped',
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

    /*
      The native window is already Main-sized here, so the Main layout exists and the
      Core can finally be measured. The view flips while the phase is still
      opening-start, which keeps the workspace content unmounted, so nothing appears
      before the Core has been inverted onto the PiP position.
    */
    case APP_EVENT.OPEN_SWAPPED:
      if (
        state.view === VIEW.PIP &&
        state.phase === PHASE.IDLE
      ) {
        return {
          view: VIEW.COMMAND_CENTER,
          phase: PHASE.OPENING_START,
        }
      }
      return state

    case APP_EVENT.OPEN_WINDOW_EXPANDED:
      if (
        state.phase ===
          PHASE.OPENING_START
      ) {
        return {
          ...state,
          phase:
            PHASE.OPENING,
        }
      }
      return state

    case APP_EVENT.OPEN_COMPLETE:
      if (
        state.phase ===
          PHASE.OPENING
      ) {
        return {
          ...state,
          phase:
            PHASE.IDLE,
        }
      }
      return state

    case APP_EVENT.OPEN_ABORT:
      if (
        state.phase ===
          PHASE.OPENING_START ||
        state.phase ===
          PHASE.OPENING
      ) {
        return {
          ...state,
          phase:
            PHASE.IDLE,
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
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      resolve()
    }

    window.requestAnimationFrame(finish)
    // Hidden/minimized Electron windows can pause animation frames. Keep
    // the native transition state machine moving without changing timing.
    window.setTimeout(finish, 32)
  })

const nextPaint = async () => {
  await nextFrame()
  await nextFrame()
}

function CoreGraphic({
  onActivate,
  ariaLabel,
  describedBy,
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
          aria-describedby={describedBy}
          title={ariaLabel}
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

  const [newsOpen, setNewsOpen] = useState(false)

  /*
    Content choreography — the workspace content must not appear before the Core has
    established where the space is coming from. On settle we mark the surface briefly so
    CSS can run a single entrance pass; without it the Command Center simply appears at
    full opacity the instant the view flips.
  */
  const [contentEntering, setContentEntering] = useState(false)
  const contentEnterTimer = useRef(null)
  /* Screen position of the PiP Core, captured on every opening. */
  const pipAnchorRef = useRef(null)
  /*
    Publishes one end of the reveal's CSS interpolation. Both ends are plain numbers
    set once per transition, so the browser — not a JS loop — does the travelling.
  */
  const setRevealEnd = useCallback((anchor) => {
    const shell = shellRef.current
    if (!shell) return
    shell.style.setProperty('--reveal-end-x', `${anchor.x - window.screenX}px`)
    shell.style.setProperty('--reveal-end-y', `${anchor.y - window.screenY}px`)
  }, [])
  /* PiP anchor waiting to be inverted onto the measured Main Core. */
  const pendingFlipRef = useRef(null)
  const flipAppliedRef = useRef(false)
  const shellRef = useRef(null)

  /*
    FLIP inversion. Runs between the DOM update and the next paint, so the Core is
    already sitting on the PiP position the moment the Main surface becomes visible.
  */
  useLayoutEffect(() => {
    const pipAnchor = pendingFlipRef.current
    if (phase !== PHASE.OPENING_START || !pipAnchor) return
    const mainAnchor = measureCoreAnchor(VIEW.COMMAND_CENTER)
    if (!mainAnchor) {
      flipAppliedRef.current = false
      return
    }
    setPipOffset({
      x: pipAnchor.x - mainAnchor.x,
      y: pipAnchor.y - mainAnchor.y,
    })
    /*
      The reveal is a CSS interpolation between two points that are both known before
      the transition starts: the PiP Core the user is looking at, and the Main Core the
      layout actually produced. Handing both to CSS lets the browser move the circle's
      centre and grow its radius in one interpolated pass, with no per-frame JS.
    */
    const shell = shellRef.current
    if (shell) {
      shell.style.setProperty('--reveal-start-x', `${pipAnchor.x - window.screenX}px`)
      shell.style.setProperty('--reveal-start-y', `${pipAnchor.y - window.screenY}px`)
    }
    setRevealEnd(mainAnchor)
    flipAppliedRef.current = true
    pendingFlipRef.current = null
  }, [phase, view, setRevealEnd])

  const startContentEntrance = useCallback(() => {
    if (contentEnterTimer.current) {
      window.clearTimeout(contentEnterTimer.current)
    }
    if (prefersReducedMotion()) {
      setContentEntering(false)
      return
    }
    setContentEntering(true)
    contentEnterTimer.current = window.setTimeout(() => {
      setContentEntering(false)
    }, CONTENT_ENTER_MS)
  }, [])

  useEffect(() => () => {
    if (contentEnterTimer.current) window.clearTimeout(contentEnterTimer.current)
  }, [])

  /*
    Active File — 현재 열려 있는 파일 편집기 단일 소유 state. FileEditor
    프롭 그대로(fileId·rootId·path·label). 닫으면 null → "Active File 없음".
    Transient: reload 시 자연 소멸하며 별도 저장소를 만들지 않는다.
  */
  const [
    fileEditor,
    setFileEditor,
  ] = useState(null)

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

  /*
    Resume Briefing의 [시작] (M1 — 복귀 → 이어서 시작).

    다음 행동을 기존 실행 문맥(Focus)으로 넘기고, 그 task에 연결된 자료가
    있으면 Active File로 함께 연다 — Quick Actions를 바로 쓸 수 있는 상태.
    전부 transient UI 상태일 뿐 canonical 상태를 쓰지 않는다.
  */
  const handleStartTask = useCallback((nextAction) => {
    if (!nextAction || !nextAction.task_id) {
      return
    }

    setExecutionContext({
      node: {
        id: nextAction.task_id,
        label: nextAction.title || nextAction.task_id,
        type: 'task',
      },
      path: [],
    })

    const linked = (nextAction.resources || []).find(
      (entry) =>
        entry.file &&
        entry.file.status === 'ok' &&
        entry.file.path,
    )

    if (linked) {
      setFileEditor({
        fileId: linked.file.id,
        rootId: linked.file.root_id,
        path: linked.file.path,
        label: linked.file.name || linked.file.path,
      })
      setContextOpen(true)
    }
  }, [])

  /*
    M2 — Active File → focused Task 연결 (어시스턴트에서의 명시적 사용자 행동).
    canonical ResourceLink만 생성하고, 복귀 브리핑이 다음부터 그 자료를
    "그 작업의 관련 파일"로 실어 나른다. AI 자동 연결 없음(V4 §13-C).
  */
  const handleLinkFileToFocus = useCallback(async () => {
    const taskId = executionContext?.node?.id
    const file = fileEditor

    if (
      !file?.fileId ||
      typeof taskId !== 'string' ||
      !taskId.startsWith('t-')
    ) {
      return { ok: false, error: '연결할 작업과 파일이 필요합니다' }
    }

    return linkTaskFile({
      taskId,
      fileId: file.fileId,
      relation: 'reference',
    })
  }, [executionContext, fileEditor])

  const openCommandCenter =
    useCallback(async () => {
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
        FLIP, in the order that makes the geometry correct.

        1. While the window is still PiP-sized, remember where the PiP Core actually
           sits on screen. This is the origin the user is looking at.
        2. Perform the single native bounds change. Nothing animates natively.
        3. Only now can the Main Core's real layout position be measured, because the
           V4 shell does not park it at the workArea centre.
        4. Invert: hold the Core on the PiP position with no transition.
        5. Release: the CSS transform plays the offset back to zero, so the Core
           travels to where it genuinely belongs instead of teleporting on the view flip.
      */
      const geometry =
        await windowApi
          .prepareCommandCenter()

      if (!geometry) {
        return
      }

      const pipAnchor =
        measureCoreAnchor(
          VIEW.PIP,
        )

      if (!pipAnchor) {
        return
      }

      pipAnchorRef.current =
        pipAnchor

      let expanded
      try {
        expanded =
          await windowApi
            .expandCommandCenter()
      } catch (error) {
        console.warn('[jarvis] expandCommandCenter failed:', error?.message || error)
      }

      if (!expanded) {
        dispatch({
          type:
            APP_EVENT.OPEN_ABORT,
        })
        return
      }

      // Let the Main layout settle before its Core position can be trusted.
      await nextPaint()

      /*
        Flip the view first (still inside opening-start, so no content mounts), then let
        the layout effect below measure the real Main Core and invert onto the PiP
        position. A layout effect runs after the DOM is updated but before the browser
        paints, so the user never sees the un-inverted Main layout.
      */
      pendingFlipRef.current =
        pipAnchor

      dispatch({
        type:
          APP_EVENT.OPEN_SWAPPED,
      })

      await nextPaint()

      if (!flipAppliedRef.current) {
        dispatch({
          type:
            APP_EVENT.OPEN_ABORT,
        })
        return
      }

      dispatch({
        type:
          APP_EVENT.OPEN_WINDOW_EXPANDED,
      })

      await nextFrame()
      await motionWait(OPENING_MS)

      dispatch({
        type:
          APP_EVENT.OPEN_COMPLETE,
      })

      /*
        The inversion offset has served its purpose. Leaving it set meant the next
        transition measured the Main Core with the previous cycle's offset still
        applied, so it read back as the PiP position: the FLIP inversion silently
        became a no-op and the reveal was handed two identical endpoints, which pinned
        its centre on the PiP spot for the whole opening. Clearing it here makes every
        round trip measure the real Main layout, not just the first one.
      */
      setPipOffset({
        x: 0,
        y: 0,
      })

      startContentEntrance()
    }, [phase, view, startContentEntrance, setPipOffset])

  const returnToPip =
    useCallback(async () => {
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

      /*
        The Main Core is already at its resting place when closing starts and does not
        move during closing-prep, so the reveal's origin can be published before the
        prep begins. Waiting until after the prep left the circle collapsing toward the
        50%/50% fallback in the stylesheet and then sliding sideways to catch up.
      */
      const prepAnchor =
        measureCoreAnchor(
          VIEW.COMMAND_CENTER,
        )
      if (prepAnchor) {
        setRevealEnd(
          prepAnchor,
        )
      }

      await nextFrame()
      await motionWait(
        CLOSING_PREP_MS,
      )

      /*
        Aim at the PiP Core position that was measured when the user last saw it, not
        at a re-derived workArea centre, so the Core lands exactly where the PiP will
        appear after the native swap.
      */
      const mainAnchor =
        measureCoreAnchor(
          VIEW.COMMAND_CENTER,
        )
      const pipAnchor =
        pipAnchorRef.current

      if (mainAnchor && pipAnchor) {
        setPipOffset({
          x: pipAnchor.x - mainAnchor.x,
          y: pipAnchor.y - mainAnchor.y,
        })
        const shell = shellRef.current
        if (shell) {
          shell.style.setProperty('--reveal-start-x', `${pipAnchor.x - window.screenX}px`)
          shell.style.setProperty('--reveal-start-y', `${pipAnchor.y - window.screenY}px`)
        }
        await nextPaint()
      }

      dispatch({
        type:
          APP_EVENT.CLOSE_MOVE,
      })

      await nextFrame()
      await motionWait(
        CLOSING_MOVE_MS,
      )

      dispatch({
        type:
          APP_EVENT.CLOSE_SWAP,
      })

      await nextPaint()

      let collapsed
      try {
        collapsed =
          await windowApi
            .collapseToPip()
      } catch (error) {
        console.warn('[jarvis] collapseToPip failed:', error?.message || error)
      }

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
      await motionWait(PIP_FADE_MS)

      dispatch({
        type:
          APP_EVENT.CLOSE_COMPLETE,
      })

      // See the note at OPEN_COMPLETE: a surviving offset corrupts the next measurement.
      setPipOffset({
        x: 0,
        y: 0,
      })
    }, [phase, view, setRevealEnd, setPipOffset])

  /*
    Input source를 product intent로 한 번 변환한다.

    지금은:
    - Core click → OPEN / RETURN
    - Escape     → RETURN

    나중에 wheel / keyboard shortcut / gesture가 생겨도
    transition 구현을 복제하지 않고 같은 intent를 요청하면 된다.
  */
  const requestIntent = useCallback((
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
  }, [openCommandCenter, phase, returnToPip, view])

  const handleCoreClick = () => {
    requestIntent(
      isPip
        ? APP_INTENT.OPEN_COMMAND_CENTER
        : APP_INTENT.RETURN_TO_PIP,
    )
  }

  /*
    Permission remains on the current surface. The shared runtime state is
    rendered by both Assistant and PiP; PiP is not a mandatory approval mode.
  */
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

        if (newsOpen) {
          event.preventDefault()
          setNewsOpen(false)
          return
        }

        // If fileEditor or context drawer is open, dismiss that first before collapsing to PiP
        if (fileEditor) {
          // Handled by FileEditor's capturing keydown listener
          return
        }

        if (contextOpen) {
          event.preventDefault()
          setContextOpen(false)
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
  }, [view, phase, fileEditor, contextOpen, newsOpen, requestIntent])

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

  // Content entrance plays once, after the Core has settled on the Main side.
  const contentEnterClass =
    !isPip && contentEntering
      ? 'is-content-entering'
      : ''


  const showAssistantSurface =
    !isPip &&
    phase === PHASE.IDLE

  /* Main keeps a compact, labelled Core; PiP owns its single presence orb.
     The shared Core is retained during native window transitions. */
  const showCore = !isPip || phase !== PHASE.IDLE

  // V4: the assistant is the only primary fullscreen surface.
  // Context opens as an optional secondary drawer instead of a mode choice.
  const showCommandCenter =
    showAssistantSurface

  const showTreePrototype =
    showAssistantSurface &&
    !newsOpen &&
    (contextOpen || Boolean(fileEditor))

  /*
    UX Continuity — 첫 열림 곧 브리핑.
    Assistant가 처음 보이는 순간 브리지 read-only 경로로 마지막 브리핑을
    읽어 온다(모델 호출 없음). "계속하자"를 말해야 브리핑이 나오는
    구조를 없앤다. Assistant surface에 도달했을 때 한 번만 시도한다.
    (showAssistantSurface 선언 뒤에 둔다 — effect에서 이 변수를 읽는다.)
  */
  const {
    loadAutoBriefing,
    autoBriefingState,
  } = runtime

  useEffect(() => {
    if (!showAssistantSurface) return
    if (autoBriefingState !== 'idle') return
    loadAutoBriefing()
  }, [showAssistantSurface, autoBriefingState, loadAutoBriefing])

  return (
    <main
      ref={shellRef}
      className={[
        'jarvis-shell',
        'v4-assistant-shell',
        modeClass,
        phaseClass,
        quickPipClass,
        contentEnterClass,
      ]
        .filter(Boolean)
        .join(' ')}
      data-view={view}
      data-phase={phase}
      data-context-open={contextOpen ? 'true' : 'false'}
      data-file-open={fileEditor ? 'true' : 'false'}
      style={{
        '--pip-offset-x':
          `${pipOffset.x}px`,

        '--pip-offset-y':
          `${pipOffset.y}px`,
      }}
    >
      {showCommandCenter && newsOpen && (
        <FreebuffNews onBack={() => setNewsOpen(false)} />
      )}

      {showCommandCenter && !newsOpen && (
        <CommandCenter
          executionContext={executionContext}
          runtime={runtime}
          voiceOutput={voiceOutput}
          activeFile={fileEditor}
          onCloseActiveFile={() => setFileEditor(null)}
          onStartTask={handleStartTask}
          onLinkFileToFocus={handleLinkFileToFocus}
          activeProjectTitle={
            runtime.autoBriefing?.project?.title ||
            runtime.resumeBriefing?.project?.title ||
            null
          }
          contextOpen={contextOpen}
          onToggleContext={() => setContextOpen((open) => !open)}
          onOpenNews={() => setNewsOpen(true)}
        />
      )}

      {showTreePrototype && (
        <aside className="v4-context-drawer" aria-label="JARVIS context" style={!contextOpen ? { display: 'none' } : undefined}>
          <TreePrototype
            runtime={runtime}
            executionContext={executionContext}
            fileEditor={fileEditor}
            openFile={setFileEditor}
            closeFile={() => setFileEditor(null)}
            onFocusTask={(task) => {
              if (!task?.node?.id) return
              setExecutionContext({
                node: {
                  id: task.node.id,
                  label: task.node.label,
                  type: task.node.type || 'task',
                },
                path: task.path || [],
              })
              setContextOpen(true)
            }}
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
        {showCore && (
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
              describedBy={!isPip ? 'jarvis-core-hint' : undefined}
            />


          </section>
        )}

        {!isPip && (
          <span className="jarvis-core-hint" id="jarvis-core-hint">
            Core 클릭 · PiP로 접기 · Esc
          </span>
        )}

        {/* PiP is a compact presence surface over the shared runtime. */}
        <QuickPip
          executionContext={executionContext}
          runtime={runtime}
          pipMode={isPip}
          onOpen={openCommandCenter}
        />
      </div>
    </main>
  )
}

export default App
