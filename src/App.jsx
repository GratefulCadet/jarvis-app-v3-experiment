import { useEffect, useState } from 'react'
import './App.css'

const PIP_BREAKPOINT = 500

function CoreGraphic({ onActivate, ariaLabel }) {
  return (
    <div className="core-outer-ring">
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
  const [isPip, setIsPip] = useState(
    () => window.innerWidth <= PIP_BREAKPOINT,
  )

  useEffect(() => {
    const handleResize = () => {
      setIsPip(window.innerWidth <= PIP_BREAKPOINT)
    }

    window.addEventListener('resize', handleResize)

    return () => {
      window.removeEventListener('resize', handleResize)
    }
  }, [])

  const openCommandCenter = () => {
    if (!window.jarvisWindow) {
      console.error(
        'JARVIS window API를 찾을 수 없습니다. Electron을 재실행하세요.',
      )
      return
    }

    window.jarvisWindow.openCommandCenter()
  }

  const returnToPip = () => {
    if (!window.jarvisWindow) {
      console.error(
        'JARVIS window API를 찾을 수 없습니다. Electron을 재실행하세요.',
      )
      return
    }

    window.jarvisWindow.returnToPip()
  }

  const handleCoreClick = () => {
    if (isPip) {
      openCommandCenter()
      return
    }

    returnToPip()
  }

  return (
    <main
      className={`jarvis-shell ${
        isPip ? 'pip-mode' : 'command-center-mode'
      }`}
    >
      <section
        className="core-container"
        aria-label="JARVIS Core"
      >
        <CoreGraphic
          onActivate={handleCoreClick}
          ariaLabel={
            isPip
              ? 'Open JARVIS Command Center'
              : 'Return JARVIS to PiP'
          }
        />

        {!isPip && <p className="core-label">JARVIS</p>}
      </section>
    </main>
  )
}

export default App