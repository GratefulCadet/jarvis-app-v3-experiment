import { useCallback, useEffect, useState } from 'react'

const EDITABLE_EXTENSIONS = new Set([
  'md', 'txt', 'py', 'js', 'jsx', 'ts', 'tsx', 'json', 'yaml', 'yml', 'html', 'css',
])

const extensionOf = (name) => name.split('.').pop()?.toLowerCase() || ''

export default function FileEditor({ file, readFile, writeFile, onClose }) {
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

  return (
    <section className="workspace-file-editor" aria-label={`Edit ${file.label}`}>
      <header className="workspace-file-editor-header">
        <div>
          <strong>{file.label}</strong>
          <span>{file.path}</span>
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
    </section>
  )
}
