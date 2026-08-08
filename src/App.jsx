import {
  useEffect,
  useState,
} from 'react'

import CommandCenter from './CommandCenter'
import QuickPip from './QuickPip'
import useExecutionSession from './useExecutionSession'

import './App.css'

const PIP_BREAKPOINT = 500

const OPENING_MS = 500

const CLOSING_PREP_MS = 240
const CLOSING_MOVE_MS = 420
const PIP_FADE_MS = 160

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
  /*
    Window 크기로 상태를 계속 추론하지 않는다.

    최초 실행 상태만 확인하고,
    그 이후에는 React state가
    JARVIS 상태의 기준이 된다.
  */
  const [isPip, setIsPip] =
    useState(
      () =>
        window.innerWidth <=
        PIP_BREAKPOINT,
    )

  /*
    idle
    opening-start
    opening
    closing-prep
    closing-moving
    closing-swap
    pip-fade
  */
  const [phase, setPhase] =
    useState('idle')

  const [
    pipOffset,
    setPipOffset,
  ] = useState({
    x: 0,
    y: 0,
  })

  /*
    Quick PiP와 Command Center가
    동일한 Timer / Checklist / Next Action
    상태를 공유한다.
  */
  const execution =
    useExecutionSession()

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
        !isPip ||
        phase !== 'idle'
      ) {
        return
      }

      const windowApi =
        getWindowApi()

      if (!windowApi) {
        return
      }

      /*
        1.
        아직 280×280 PiP인 상태에서
        기존 PiP 위치와 workArea 사이의
        상대 좌표를 계산한다.
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

      /*
        2.
        PiP 시작 상태를 먼저
        React/CSS에 준비한다.
      */
      setPhase(
        'opening-start',
      )

      await nextPaint()

      /*
        3.
        Native Window를
        workArea 전체로 딱 한 번 변경.
      */
      const expanded =
        await windowApi
          .expandCommandCenter()

      if (!expanded) {
        setPhase('idle')
        return
      }

      await nextPaint()

      /*
        4.
        여기서부터 보이는 움직임은
        전부 CSS GPU transform.
      */
      setPhase('opening')

      await nextFrame()
      await wait(OPENING_MS)

      /*
        5.
        Command Center 상태 확정.
      */
      setIsPip(false)
      setPhase('idle')
    }

  const returnToPip =
    async () => {
      if (
        isPip ||
        phase !== 'idle'
      ) {
        return
      }

      const windowApi =
        getWindowApi()

      if (!windowApi) {
        return
      }

      /*
        1.
        전체 배경 → 중앙 원 응축.
      */
      setPhase(
        'closing-prep',
      )

      await nextFrame()
      await wait(
        CLOSING_PREP_MS,
      )

      /*
        2.
        Core + 원을
        실제 PiP 위치까지
        CSS로 이동/축소.
      */
      setPhase(
        'closing-moving',
      )

      await nextFrame()
      await wait(
        CLOSING_MOVE_MS,
      )

      /*
        3.
        Native bounds 교체 직전
        화면을 완전히 고정한다.
      */
      setPhase(
        'closing-swap',
      )

      await nextPaint()

      /*
        4.
        Core는 이미 PiP 위치에 있다.

        이제 Native Window만
        280×280으로 한 번 변경.
      */
      const collapsed =
        await windowApi
          .collapseToPip()

      if (!collapsed) {
        setPhase('idle')
        return
      }

      await nextPaint()

      /*
        5.
        실제 React 상태도 PiP로 변경.
      */
      setIsPip(true)

      await nextPaint()

      /*
        6.
        PiP 주변의 배경만 fade-out.
      */
      setPhase('pip-fade')

      await nextFrame()
      await wait(PIP_FADE_MS)

      setPhase('idle')
    }

  /*
    현재 interaction:

    PiP Core click
    → Command Center

    Command Center Core click
    → PiP
  */
  const handleCoreClick = () => {
    if (phase !== 'idle') {
      return
    }

    if (isPip) {
      openCommandCenter()
      return
    }

    returnToPip()
  }

  /*
    Command Center에서 ESC
    → PiP 복귀.
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
          isPip ||
          phase !== 'idle'
        ) {
          return
        }

        event.preventDefault()

        returnToPip()
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
  }, [isPip, phase])

  const phaseClass =
    phase === 'idle'
      ? ''
      : phase

  const modeClass =
    isPip
      ? 'pip-mode'
      : 'command-center-mode'

  const quickPipClass =
    isPip &&
    phase === 'idle'
      ? 'quick-pip-enabled'
      : ''

  const showLabel =
    !isPip &&
    phase === 'idle'

  const showCommandCenter =
    !isPip &&
    phase === 'idle'

  return (
    <main
      className={[
        'jarvis-shell',
        modeClass,
        phaseClass,
        quickPipClass,
      ]
        .filter(Boolean)
        .join(' ')}
      style={{
        '--pip-offset-x':
          `${pipOffset.x}px`,

        '--pip-offset-y':
          `${pipOffset.y}px`,
      }}
    >
      {showCommandCenter && (
        <CommandCenter
          execution={execution}
        />
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

        <QuickPip
          execution={execution}
        />
      </div>
    </main>
  )
}

export default App