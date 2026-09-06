import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'

/*
  마이크 press/hold 캡처 훅 (STEP 2).

  범위: REAL MIC → STT → TRANSCRIPT 표시까지. Qwen으로 보내지 않는다.

  상태:
    starting      — 첫 press: worker 시작 + voice_ready 대기 (Whisper 로드 1회)
    listening     — record_start 완료, 지금 말하는 중
    transcribing  — 손을 뗐고, record_stop → 전사가 진행 중
    idle          — 대기 (transcript/안내는 잔류)
    error         — 실패 (API 없음/마이크 없음/전사 실패 등)

  신뢰성 설계:
  - 세션 effect가 state가 바뀌는 즉시 전역 pointerup/pointercancel/blur를
    등록한다. 버튼 밖·창 밖에서 손을 떼도, 아주 빠른 탭이어도 세션을 놓치지
    않는다. 최대 홀드 20s 후 자동 stop, blur는 record_cancel(폐기).
  - voice_ready 전에 손을 떼면(release-pending) recordStart가 resolve된 뒤
    곧바로 record_stop으로 마무리한다.
  - activeRef로 중복 start/stop를 차단한다. stop/cancel은 의존성이 안정적이라
    effect가 최신 클로저를 항상 갖는다.
*/

const VOICE_STATE = Object.freeze({
  IDLE: 'idle',
  STARTING: 'starting',
  LISTENING: 'listening',
  TRANSCRIBING: 'transcribing',
  ERROR: 'error',
})

const MAX_HOLD_MS = 20000

function getVoiceApi() {
  return window.jarvisVoice || null
}

export function useVoiceCapture() {
  const [state, setState] = useState(VOICE_STATE.IDLE)
  const [transcript, setTranscript] = useState('')
  const [statusLine, setStatusLine] = useState('')
  const [error, setError] = useState(null)
  const [deviceName, setDeviceName] = useState('')
  const [resultSeq, setResultSeq] = useState(0) // 발화당 1회 증가 — 자동 제출용
  const stateRef = useRef(state)
  const activeRef = useRef(false)
  const discardRef = useRef(false)

  useEffect(() => {
    stateRef.current = state
  }, [state])

  const resetToIdle = useCallback(() => {
    activeRef.current = false
    setTranscript('')
    setStatusLine('')
    setError(null)
    setState(VOICE_STATE.IDLE)
  }, [])

  const finalizeResult = useCallback((res) => {
    if (res && res.status === 'ok') {
      if (res.silent || !(res.text || '').trim()) {
        setTranscript('')
        setStatusLine('아무 소리도 들리지 않았습니다.')
      } else {
        setTranscript(res.text || '')
        setResultSeq((v) => v + 1)
        setStatusLine('')
        const dev = res.record && res.record.device
        if (dev && dev.name) setDeviceName(dev.name)
      }
      setError(null)
    } else {
      setError((res && res.error) || '음성 처리에 실패했습니다')
      setState(VOICE_STATE.ERROR)
      return
    }
    activeRef.current = false
    setState(VOICE_STATE.IDLE)
  }, [])

  /* pointerup — 정상 종료 */
  const stop = useCallback(async () => {
    const api = getVoiceApi()
    if (!activeRef.current) return
    activeRef.current = false

    if (stateRef.current === VOICE_STATE.STARTING) {
      // release-pending — start()의 continuation이 record_stop으로 마무리한다
      return
    }

    setState(VOICE_STATE.TRANSCRIBING)
    setStatusLine('전사 중…')
    const res = await api.recordStop()
    finalizeResult(res)
  }, [finalizeResult])

  /* 취소 (pointercancel/blur) — 녹음 폐기, 0 처리 */
  const cancel = useCallback(async () => {
    const api = getVoiceApi()
    if (!activeRef.current) return
    activeRef.current = false
    if (stateRef.current === VOICE_STATE.STARTING) {
      discardRef.current = true // start() continuation이 record_cancel 처리
      return
    }
    if (api) await api.recordCancel()
    resetToIdle()
  }, [resetToIdle])

  /* pointerdown */
  const start = useCallback(async () => {
    const api = getVoiceApi()
    if (!api) {
      setError('jarvisVoice API가 없습니다 — Electron에서 실행 중인지 확인하세요.')
      setState(VOICE_STATE.ERROR)
      return
    }
    if (activeRef.current) return
    activeRef.current = true
    discardRef.current = false
    setError(null)
    setTranscript('')
    setStatusLine('')
    setState(VOICE_STATE.STARTING)

    const res = await api.recordStart()

    if (!activeRef.current) {
      // 시작을 기다리는 동안 손을 뗐거나 취소됨
      if (discardRef.current) {
        await api.recordCancel()
        resetToIdle()
        return
      }
      // release-pending: record가 실제로 시작됐으므로 stop으로 마무리
      setState(VOICE_STATE.TRANSCRIBING)
      setStatusLine('전사 중…')
      const stopped = await api.recordStop()
      finalizeResult(stopped)
      return
    }

    if (!res || res.status !== 'ok') {
      activeRef.current = false
      setError((res && res.error) || '마이크 녹음을 시작하지 못했습니다')
      setState(VOICE_STATE.ERROR)
      return
    }

    if (res.device && res.device.name) setDeviceName(res.device.name)
    setState(VOICE_STATE.LISTENING)
    setStatusLine('듣는 중…')
  }, [resetToIdle, finalizeResult])

  /*
    세션 effect — capture가 시작되는 즉시(states starting/listening/transcribing)
    전역 종료·취소 핸들러와 최대 홀드 타이머를 건다. state가 바뀔 때마다
    재등록되지만 stop/cancel은 안정적이라 핸들러는 항상 최신 세션을 본다.
    idle/error가 되면(activeRef false) 아무것도 하지 않는다.
  */
  useEffect(() => {
    if (!activeRef.current) return undefined

    const onUp = () => {
      if (activeRef.current) stop()
    }
    const onCancelEvt = () => {
      if (activeRef.current) cancel()
    }
    const onBlurEvt = () => {
      if (activeRef.current) cancel()
    }
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancelEvt)
    window.addEventListener('blur', onBlurEvt)
    const holdTimer = setTimeout(() => {
      if (activeRef.current) stop()
    }, MAX_HOLD_MS)

    return () => {
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancelEvt)
      window.removeEventListener('blur', onBlurEvt)
      clearTimeout(holdTimer)
    }
  }, [state, stop, cancel])

  return {
    state,
    transcript,
    statusLine,
    error,
    deviceName,
    resultSeq,
    start,
    stop,
    cancel,
  }
}

export { VOICE_STATE }
