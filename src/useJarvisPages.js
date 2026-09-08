import {
  useEffect,
  useState,
} from 'react'

/*
  Knowledge Markdown pages → SYSTEM MAP read adapter (Knowledge slice).

  원천: Harness bridge의 read-only `pages_snapshot` (PageStore가 단일 원천인
  <memory_dir>/pages의 재귀 스캔). 이 훅은 별도 저장소가 아니라 스냅샷을
  TreePrototype node shape으로 매핑하는 read adapter다 (useJarvisTree와 동일
  패턴 — §3 데이터 소유 원칙: representation만, canonical 아님).

  노드 shape (bridge):
    { id, type: 'page', title, path, parent_id, children, detached? }

  반환:
    pages     — 루트 페이지 노드 배열 (TreeMapRows가 바로 쓸 수 있는 shape)
    status    — 'loading' | 'ready' | 'error'
    error     — 오류 메시지 (status가 'error'일 때)
    scratch   — pages_dir이 격리 scratch인지 (응답 플래그 그대로)
*/

const toNode = (page) => ({
  id: page.id,
  label: page.title || page.id,
  eyebrow: page.detached ? 'PAGE (detached)' : 'PAGE',
  description: page.path || '',
  type: 'page',
  complete: false,
  children: (page.children || []).map(toNode),
})

export default function useJarvisPages() {
  const [pages, setPages] = useState([])
  const [status, setStatus] = useState(() =>
    typeof window !== 'undefined' &&
    window.jarvisPages
      ? 'loading'
      : 'error',
  )
  const [error, setError] = useState(() =>
    typeof window !== 'undefined' &&
    window.jarvisPages
      ? null
      : 'jarvisPages API 없음 — Electron에서 실행 중인지 확인하세요.',
  )
  const [scratch, setScratch] = useState(null)

  useEffect(() => {
    const api = window.jarvisPages
    if (!api) return undefined

    let cancelled = false

    ;(async () => {
      try {
        const response = await api.getSnapshot()
        if (cancelled) return
        if (
          response?.status === 'ok' &&
          Array.isArray(response.pages)
        ) {
          setPages(response.pages.map(toNode))
          setScratch(Boolean(response.scratch))
          setStatus('ready')
        } else {
          setStatus('error')
          setError(
            (response && response.error) ||
              '페이지 스냅샷을 불러오지 못했습니다.',
          )
        }
      } catch (exception) {
        if (!cancelled) {
          setStatus('error')
          setError(
            String(
              (exception &&
                exception.message) ||
                exception,
            ),
          )
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [])

  return {
    pages,
    status,
    error,
    scratch,
  }
}
