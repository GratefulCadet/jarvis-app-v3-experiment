import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'

/*
  음성 모드용 TTS 훅 (STEP 4 — voice interaction mode).

  Web Speech API(speechSynthesis)를 쓰므로 Electron 렌더러에서 바로 동작하고
  Windows SAPI 음성(Heami 등)을 사용한다. 한국어 음성이 있으면 우선 선택하고
  없으면 ko-KR 언어 태그로 기본 음성에 맡긴다.

  사용처:
  - Command Center의 음성 모드 토글(enabled / toggle)
  - App.jsx가 Qwen 최종 응답(DONE)을 음성 모드일 때 speak() 호출
  - 마이크 녹음 시작 시 stop()으로 진행 중인 음성 출력을 끊어 에코 방지
*/

export default function useVoiceOutput() {
  const [enabled, setEnabled] = useState(false)
  const voicesRef = useRef([])

  useEffect(() => {
    if (
      typeof window === 'undefined' ||
      !('speechSynthesis' in window)
    ) {
      return undefined
    }

    const loadVoices = () => {
      voicesRef.current =
        window.speechSynthesis.getVoices()
    }

    loadVoices()
    window.speechSynthesis.addEventListener(
      'voiceschanged',
      loadVoices,
    )

    return () => {
      window.speechSynthesis.removeEventListener(
        'voiceschanged',
        loadVoices,
      )
      window.speechSynthesis.cancel()
    }
  }, [])

  const stop = useCallback(() => {
    if (
      typeof window === 'undefined' ||
      !('speechSynthesis' in window)
    ) {
      return
    }
    window.speechSynthesis.cancel()
  }, [])

  const speak = useCallback((text) => {
    const trimmed =
      typeof text === 'string'
        ? text.trim()
        : ''

    if (
      !trimmed ||
      typeof window === 'undefined' ||
      !('speechSynthesis' in window)
    ) {
      return
    }

    window.speechSynthesis.cancel()

    const utterance =
      new SpeechSynthesisUtterance(trimmed)

    const koreanVoice =
      voicesRef.current.find((voice) =>
        String(voice.lang || '')
          .toLowerCase()
          .startsWith('ko'),
      )

    if (koreanVoice) {
      utterance.voice = koreanVoice
      utterance.lang = koreanVoice.lang
    } else {
      utterance.lang = 'ko-KR'
    }

    utterance.rate = 1.0

    window.speechSynthesis.speak(utterance)
  }, [])

  const toggle = useCallback(() => {
    setEnabled((previous) => {
      if (previous) {
        stop()
      }
      return !previous
    })
  }, [stop])

  return {
    enabled,
    setEnabled,
    toggle,
    speak,
    stop,
  }
}