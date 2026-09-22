import {
  useCallback,
  useEffect,
  useState,
} from 'react'

/*
  FILES 섹션 read adapter (PART E).

  원천: Harness bridge의 read-only `files_snapshot` (single source = 실제
  파일시스템, 승인된 루트만). 이 훅은 별도 저장소가 아니라 그 스냅샷을
  SYSTEM MAP 행으로 매핑하는 read adapter다 — localStorage canonical state
  금지(§3). 승인된 루트가 없으면 roots:[] — 섹션을 조용히 숨긴다.

  sections[].entries는 평탄 목록: {type: dir|file|blocked, name, path, depth}.
  blocked는 민감 항목(내용 노출 없이 이름만). 행 매핑(makeFileRow)은
  TreePrototype에서 한다 — 훅은 순수 데이터만 제공.
*/

export default function useJarvisFiles() {
  const [status, setStatus] = useState(() =>
    typeof window !== 'undefined' &&
    window.jarvisDiscovery?.filesSnapshot
      ? 'loading'
      : 'error',
  )
  const [error, setError] = useState(() =>
    typeof window !== 'undefined' &&
    window.jarvisDiscovery?.filesSnapshot
      ? null
      : 'jarvisDiscovery API 없음 — Electron을 재시작하세요.',
  )
  const [roots, setRoots] = useState([])
  const [sections, setSections] = useState([])

  const fetchSnapshot = useCallback(async () => {
    const api = window.jarvisDiscovery
    if (!api?.filesSnapshot) {
      setStatus('error')
      setError('jarvisDiscovery API 없음 — Electron을 재시작하세요.')
      return { ok: false, error: 'jarvisDiscovery API 없음' }
    }
    try {
      const response = await api.filesSnapshot()
      if (response?.status === 'ok' && Array.isArray(response.sections)) {
        setRoots(response.roots || [])
        setSections(response.sections)
        setStatus('ready')
        setError(null)
        return { ok: true }
      }
      setStatus('error')
      setError(
        (response && response.error) ||
          '파일 스냅샷을 불러오지 못했습니다.',
      )
      return { ok: false, error: response?.error || 'files_snapshot 실패' }
    } catch (exception) {
      const message = String(
        (exception && exception.message) || exception,
      )
      setStatus('error')
      setError(message)
      return { ok: false, error: message }
    }
  }, [])

  useEffect(() => {
    const api = window.jarvisDiscovery
    if (!api?.filesSnapshot) return undefined

    let cancelled = false

    ;(async () => {
      await fetchSnapshot()
      if (cancelled) return
    })()

    return () => {
      cancelled = true
    }
  }, [fetchSnapshot])

  const refresh = useCallback(async () => {
    return fetchSnapshot()
  }, [fetchSnapshot])

  const readFile = useCallback(async (root, path) => {
    if (!window.jarvisDiscovery?.readFile) {
      return { status: 'error', error: '파일 읽기 API 없음 — Electron을 재시작하세요.' }
    }
    return window.jarvisDiscovery.readFile(root, path)
  }, [])

  const writeFile = useCallback(async (rootId, fileId, path, content, revision) => {
    if (!window.jarvisDiscovery?.writeFile) {
      return { status: 'error', error: '파일 저장 API 없음 — Electron을 재시작하세요.' }
    }
    return window.jarvisDiscovery.writeFile(rootId, fileId, path, content, revision)
  }, [])

  return {
    status,
    error,
    roots,
    sections,
    refresh,
    readFile,
    writeFile,
  }
}
