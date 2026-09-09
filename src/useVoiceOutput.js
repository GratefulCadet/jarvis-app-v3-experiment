import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'

/*
  음성 모드용 TTS 훅 (STEP 4 + ElevenLabs optional).

  Provider abstraction:
  - local     : Web Speech API (speechSynthesis, Windows SAPI Heami, ko-KR)
  - elevenlabs: Electron main → https://api.elevenlabs.io (xi-api-key in main only)
  - auto      : elevenlabs if available, else local (default)

  Security: renderer sends ONLY final user-facing text string via
  window.jarvisTts.speak({text}). No traces/tool JSON/internal state.

  Fallback: ElevenLabs failure → local Web Speech automatically.
  Echo protection: stop() cancels both speechSynthesis and ElevenLabs audio/request.
*/

const TTS_PROVIDER_KEY = 'jarvis_tts_provider_v1'
const TTS_PROVIDERS = ['auto', 'local', 'elevenlabs']

function readStoredProvider() {
  if (typeof window === 'undefined') return 'auto'
  try {
    const raw = window.localStorage.getItem(TTS_PROVIDER_KEY)
    if (TTS_PROVIDERS.includes(raw)) return raw
  } catch {
    // localStorage unavailable — default to auto
  }
  return 'auto'
}

export default function useVoiceOutput() {
  const [enabled, setEnabled] = useState(false)
  const [provider, setProvider] = useState(readStoredProvider)
  const [ttsAvailable, setTtsAvailable] = useState(false)
  const [ttsVoiceId, setTtsVoiceId] = useState(null)
  const [lastLatencyMs, setLastLatencyMs] = useState(null)
  const voicesRef = useRef([])
  const audioRef = useRef(null)

  useEffect(() => {
    try {
      window.localStorage.setItem(TTS_PROVIDER_KEY, provider)
    } catch {
      // ignore storage failure
    }
  }, [provider])

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

  // Probe ElevenLabs availability once (main holds key)
  useEffect(() => {
    let cancelled = false
    const api = window.jarvisTts
    if (!api || typeof api.status !== 'function') {
      return undefined
    }
    api
      .status()
      .then((res) => {
        if (cancelled) return
        if (res && typeof res.available === 'boolean') {
          setTtsAvailable(Boolean(res.available))
          if (res.voiceId) setTtsVoiceId(res.voiceId)
          if (res.lastLatencyMs) setLastLatencyMs(res.lastLatencyMs)
        }
      })
      .catch(() => {
        void 0
      })
    return () => {
      cancelled = true
    }
  }, [])

  const stopAudio = useCallback(() => {
    if (audioRef.current) {
      try {
        audioRef.current.pause()
        audioRef.current.src = ''
      } catch {
        // ignore audio teardown failure
      }
      audioRef.current = null
    }
  }, [])

  const stop = useCallback(() => {
    stopAudio()
    // Abort in-flight ElevenLabs fetch in main
    if (
      typeof window !== 'undefined' &&
      window.jarvisTts &&
      typeof window.jarvisTts.stop === 'function'
    ) {
      window.jarvisTts.stop().catch(() => {
        void 0
      })
    }
    if (
      typeof window === 'undefined' ||
      !('speechSynthesis' in window)
    ) {
      return
    }
    window.speechSynthesis.cancel()
  }, [stopAudio])

  const speakLocal = useCallback((trimmed) => {
    if (
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

  const speakViaElevenLabs = useCallback(
    async (trimmed) => {
      const api = window.jarvisTts
      if (!api || typeof api.speak !== 'function') return null
      const res = await api.speak(trimmed)
      if (!res || res.status !== 'ok' || !res.audioBase64) {
        return null
      }
      if (typeof res.latencyMs === 'number') {
        setLastLatencyMs(res.latencyMs)
      }
      // Play returned mp3 base64 — buffered POST, stable; streaming variant
      // can replace this with MediaSource chunks without changing contract.
      try {
        const mime = res.mime || 'audio/mpeg'
        const binary = atob(res.audioBase64)
        const bytes = new Uint8Array(binary.length)
        for (let i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i)
        }
        const blob = new Blob([bytes], { type: mime })
        const url = URL.createObjectURL(blob)
        const audio = new Audio(url)
        audioRef.current = audio
        audio.onended = () => {
          URL.revokeObjectURL(url)
          if (audioRef.current === audio) audioRef.current = null
        }
        audio.onerror = () => {
          URL.revokeObjectURL(url)
          if (audioRef.current === audio) audioRef.current = null
        }
        await audio.play()
        return true
      } catch {
        return null
      }
    },
    [],
  )

  const speak = useCallback(
    (text) => {
      const trimmed =
        typeof text === 'string'
          ? text.trim()
          : ''

      if (!trimmed) {
        return
      }

      // Preserve echo protection: cancel any ongoing TTS before new utterance
      stopAudio()
      if (
        typeof window !== 'undefined' &&
        window.speechSynthesis
      ) {
        window.speechSynthesis.cancel()
      }

      const shouldTryElevenLabs =
        provider !== 'local' &&
        typeof window !== 'undefined' &&
        window.jarvisTts &&
        typeof window.jarvisTts.speak === 'function'

      if (!shouldTryElevenLabs) {
        speakLocal(trimmed)
        return
      }

      // Try ElevenLabs, fallback to local on any failure — do not block UI
      speakViaElevenLabs(trimmed)
        .then((ok) => {
          if (!ok) speakLocal(trimmed)
        })
        .catch(() => {
          speakLocal(trimmed)
        })
    },
    [provider, speakLocal, speakViaElevenLabs, stopAudio],
  )

  const toggle = useCallback(() => {
    setEnabled((previous) => {
      if (previous) {
        stop()
      }
      return !previous
    })
  }, [stop])

  const setTtsProvider = useCallback((next) => {
    if (TTS_PROVIDERS.includes(next)) setProvider(next)
  }, [])

  return {
    enabled,
    setEnabled,
    toggle,
    speak,
    stop,
    // provider abstraction (preserves local fallback)
    provider,
    setProvider: setTtsProvider,
    ttsAvailable,
    ttsVoiceId,
    lastLatencyMs,
  }
}
