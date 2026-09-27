import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

const EDITABLE_EXTENSIONS = new Set([
  'md', 'txt', 'py', 'js', 'jsx', 'ts', 'tsx', 'json', 'yaml', 'yml', 'html', 'css',
])

const extensionOf = (name) => name.split('.').pop()?.toLowerCase() || ''

export default function FileEditor({ file, readFile, writeFile, onClose, workspaceRoot, fileLocation, refreshToken }) {
  const [content, setContent] = useState('')
  const [revision, setRevision] = useState(null)
  const [state, setState] = useState('loading')
  const [message, setMessage] = useState('')

  const rootId = file?.rootId
  const path = file?.path
  const editable = file?.text !== false && EDITABLE_EXTENSIONS.has(extensionOf(file?.label || ''))

  const load = useCallback(async () => {
    setState('loading')
    setMessage('')
    const result = await readFile(rootId, path)
    if (result?.status !== 'ok') {
      setState('error')
      setMessage(result?.error || '파일을 읽을 수 없습니다.')
      return
    }
    setContent(result.content || '')
    setRevision(result.revision || null)
    setState('clean')
  }, [path, readFile, rootId])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (file && editable) void load()
      else if (file) setState('unsupported')
    }, 0)
    // The selected FileRef is the identity boundary for this editor.
    return () => window.clearTimeout(timer)
  }, [editable, file, load])

  /*
    AI Edit V1 — 외부 승인 적용 후 편집기 새로고침.

    JARVIS가 승인된 편집을 디스크에 반영하면 이 편집기는 자신이 들고 있던
    이전 revision을 계속 갖고 있다. 저장하려 하면 충돌로 거절당하고, 사용자는
    "내용이 사라졌다"고 오해한다. 그래서 단조 증가 신호(refreshToken)가 올라오면
    새 revision과 내용을 다시 읽는다.

    두 가지가 중요하다:
    1) state를 dependency에 넣지 않는다. load()가 state를 바꾸므로 effect가
       다시 돌며 load()를 부르고… 무한 반복이 되고 편집기가 비어 보인다.
       현재 state는 ref로 읽는다(읽기만, 구독 안 함).
    2) 사용자가 편집 중이면(dirty) 건드리지 않는다 — 자동 갱신이 작성 중인
       내용을 지우는 것이 conflict보다 나은 답은 아니다.
  */
  const stateRef = useRef(state)
  useEffect(() => {
    stateRef.current = state
  }, [state])

  useEffect(() => {
    if (!refreshToken || !file || !editable) return undefined
    if (stateRef.current === 'dirty' || stateRef.current === 'saving') return undefined

    const timer = window.setTimeout(() => {
      void load()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [editable, file, load, refreshToken])

  const dirty = state === 'dirty' || state === 'saving'
  const save = useCallback(async () => {
    if (!file || !revision || state === 'saving') return
    setState('saving')
    setMessage('')
    const result = await writeFile(file.rootId, file.fileId, file.path, content, revision)
    if (result?.status !== 'ok') {
      setState(result?.error?.includes('외부에서 변경') ? 'conflict' : 'error')
      setMessage(result?.error || '파일을 저장할 수 없습니다.')
      return
    }
    setRevision(result.revision || revision)
    setState('saved')
    setMessage('Saved')
  }, [content, file, revision, state, writeFile])

  const handleClose = useCallback(() => {
    if (state === 'dirty') {
      const confirmClose = window.confirm('저장되지 않은 변경사항이 있습니다. 닫으시겠습니까?')
      if (!confirmClose) return
    }
    onClose?.()
  }, [onClose, state])

  useEffect(() => {
    if (!file) return undefined

    const handleKeyDown = (event) => {
      if ((event.ctrlKey || event.metaKey) && (event.key === 's' || event.key === 'S')) {
        event.preventDefault()
        if (dirty && state !== 'saving' && state !== 'loading') {
          void save()
        }
      } else if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        handleClose()
      }
    }

    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [dirty, file, handleClose, save, state])

  if (!file) return null

  return createPortal(
    <section className="workspace-file-editor" aria-label={`Edit ${file.label}`}>
      <header className="workspace-file-editor-header">
        <div>
          <strong>{file.label}</strong>
          <div className="workspace-file-editor-breadcrumb" aria-label="File location breadcrumb">
            {(fileLocation?.breadcrumb || [workspaceRoot?.label, ...String(file.path || '').split('/')].filter(Boolean))
              .map((part, index) => <span key={`${part}-${index}`}>{index > 0 ? '› ' : ''}{part}</span>)}
          </div>
          <span className="workspace-file-editor-path" title={fileLocation?.absolutePath || file.path}>
            {fileLocation?.absolutePath || file.path}
          </span>
        </div>
        <button type="button" onClick={handleClose} aria-label="Close file editor">×</button>
      </header>
      {!editable || state === 'unsupported' ? (
        <div className="workspace-file-editor-message">이 파일 형식은 편집할 수 없습니다. 읽기 전용입니다.</div>
      ) : (
        <>
          <textarea
            value={content}
            onChange={(event) => {
              setContent(event.target.value)
              setState('dirty')
              setMessage('')
            }}
            disabled={state === 'loading' || state === 'saving'}
            spellCheck="false"
            aria-label={`Contents of ${file.label}`}
          />
          <footer className="workspace-file-editor-footer">
            <span className={`workspace-file-editor-state is-${state}`}>
              {state === 'dirty' ? 'Edited' : state === 'saving' ? 'Saving…' : state === 'conflict' ? 'Conflict' : message || 'Clean'}
            </span>
            <div>
              {(state === 'conflict' || state === 'error') && <button type="button" onClick={load}>Reload</button>}
              <button type="button" onClick={save} disabled={!dirty || state === 'saving' || state === 'loading'}>Save</button>
            </div>
          </footer>
          {message && (state === 'conflict' || state === 'error') && <div className="workspace-file-editor-error" role="alert">{message}</div>}
        </>
      )}
    </section>,
    document.body,
  )
}
