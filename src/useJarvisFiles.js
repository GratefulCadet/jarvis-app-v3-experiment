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
  const [rootDetails, setRootDetails] = useState([])

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

  useEffect(() => {
    if (status !== 'ready' || !window.jarvisDiscovery?.listWorkspaceRoots) return
    let cancelled = false
    ;(async () => {
      try {
        const response = await window.jarvisDiscovery.listWorkspaceRoots()
        if (!cancelled && response?.status === 'ok') {
          setRootDetails(response.roots || [])
        }
      } catch {
        // Files remain usable when friendly root labels are unavailable.
      }
    })()
    return () => { cancelled = true }
  }, [status, roots, sections])

  const rootInfo = useCallback((rootId) => {
    const detail = rootDetails.find((root) => root.id === rootId)
    const section = sections.find((item) => item.root === rootId)
    return {
      id: rootId,
      label: detail?.display_name || rootId || '',
      absolutePath: detail?.device_path || section?.absolute_path || '',
      available: detail?.available !== false,
    }
  }, [rootDetails, sections])

  const fileLocation = useCallback((rootId, relativePath) => {
    const root = rootInfo(rootId)
    const normalized = String(relativePath || '').replace(/\\/g, '/')
    const parts = normalized.split('/').filter(Boolean)
    const folders = parts.slice(0, -1)
    const absoluteRoot = root.absolutePath.replace(/[\\/]+$/, '')
    const separator = absoluteRoot.includes('\\') ? '\\' : '/'
    return {
      ...root,
      relativePath: normalized,
      folders,
      folderPath: folders.join('/'),
      breadcrumb: [root.label, ...folders, parts.at(-1)].filter(Boolean),
      absolutePath: absoluteRoot
        ? `${absoluteRoot}${parts.length ? `${separator}${parts.join(separator)}` : ''}`
        : '',
      absoluteFolderPath: absoluteRoot
        ? `${absoluteRoot}${folders.length ? `${separator}${folders.join(separator)}` : ''}`
        : '',
    }
  }, [rootInfo])

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

  /* FILE ACCESS 확장 — 승인된 루트 안에 새 텍스트 파일을 만든다(덮어쓰기 없음).
     성공 시 스냅샷을 다시 읽어 FILES 목록에 즉시 반영한다. */
  const createFile = useCallback(async (rootId, path, content = '') => {
    if (!window.jarvisDiscovery?.fileCreate) {
      return { status: 'error', error: '파일 생성 API 없음 — Electron을 재시작하세요.' }
    }
    const response = await window.jarvisDiscovery.fileCreate(rootId, path, content)
    if (response?.status === 'ok') {
      await fetchSnapshot()
      return { ok: true, file: response }
    }
    return { ok: false, error: response?.error || '파일 생성에 실패했습니다' }
  }, [fetchSnapshot])

  /* FILE ACCESS 확장 — 절대 경로 텍스트 읽기(디스크 전체). 편집기는 아니고
     읽기 전용 뷰어 용도 — 승인 루트 밖 파일도 읽을 수 있다. */
  const readDiskFile = useCallback(async (path, maxChars) => {
    if (!window.jarvisDiscovery?.diskRead) {
      return { status: 'error', error: '디스크 읽기 API 없음 — Electron을 재시작하세요.' }
    }
    return window.jarvisDiscovery.diskRead(path, maxChars)
  }, [])

  return {
    status,
    error,
    roots,
    sections,
    rootDetails,
    rootInfo,
    fileLocation,
    refresh,
    readFile,
    writeFile,
    createFile,
    readDiskFile,
  }
}
