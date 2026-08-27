import {
  useEffect,
} from 'react'

/*
  HOLD — dormant experiment.

  이 prototype은 현재 App.jsx에 연결하지 않는다.
  Activation이 기존 Next Action과 다른 제품 역할을 갖는지
  결정된 뒤에만 내용과 진입 방식을 다시 설계한다.
*/

const CURRENT_CONTEXT =
  'Activation Prototype 구현 중'

const NEXT_ACTION =
  '현재 prototype 실행해서 interaction 확인'

export default function ActivationPrototype({
  onExit,
}) {
  useEffect(() => {
    const handleKeyDown =
      (event) => {
        if (
          event.key !==
          'Escape'
        ) {
          return
        }

        event.preventDefault()
        onExit()
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
  }, [onExit])

  return (
    <aside
      className="activation-prototype"
      aria-label="JARVIS Resume"
    >
      <div className="activation-prototype-card">
        <div className="activation-prototype-block">
          <span className="activation-prototype-context">
            CURRENT CONTEXT
          </span>

          <strong className="activation-prototype-title">
            {CURRENT_CONTEXT}
          </strong>
        </div>

        <div className="activation-prototype-divider" />

        <div className="activation-prototype-block">
          <span className="activation-prototype-context">
            NEXT ACTION
          </span>

          <strong className="activation-prototype-next-action">
            {NEXT_ACTION}
          </strong>
        </div>

        <button
          type="button"
          className="activation-prototype-next"
          onClick={onExit}
        >
          작업으로 돌아가기
        </button>

        <button
          type="button"
          className="activation-prototype-exit"
          onClick={onExit}
        >
          여기까지
        </button>
      </div>
    </aside>
  )
}