import { useEffect, useRef, useState } from 'react'
import { ChevronRight, Copy, FilePlus, Folder, FolderPlus, RefreshCw } from 'lucide-react'

/*
  FILES view: a bounded projection of approved Workspace roots with physical
  path context. FileRef remains an identity detail, not the navigation model.
*/

/*
  Path awareness — narrow drawers cannot show a full Windows path without
  stacking it into an unreadable column. Keep the drive and the deepest
  folders (so folder context and the filename always survive) and collapse
  only the middle. The full path stays one interaction away and remains
  selectable, so nothing becomes unreachable.
*/
const PATH_TAIL_SEGMENTS = 2

function compactPath(value, keepSegments = PATH_TAIL_SEGMENTS) {
  const text = String(value || '').trim()
  if (!text) return ''
  const segments = text.split(/[\\/]+/).filter(Boolean)
  if (segments.length <= keepSegments + 1) return text
  const lead = text.startsWith('/') ? '/' : ''
  const rest = /^[a-zA-Z]:$/.test(segments[0]) ? segments.slice(1) : segments
  const drive = segments.length === rest.length ? '' : `${segments[0]}\\`
  return `${lead}${drive}…\\${rest.slice(-keepSegments).join('\\')}`
}

async function writeClipboard(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // Fallback for contexts where the async clipboard API is unavailable.
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const copied = document.execCommand('copy')
    area.remove()
    return copied
  }
}

function ExplorerPath({ value, className = '', label = '경로' }) {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const timer = useRef(null)

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
  }, [])

  const full = String(value || '').trim()
  if (!full) {
    return <div className={`workspace-explorer-path ${className} is-empty`}>실제 경로를 확인할 수 없습니다</div>
  }

  const copy = async () => {
    const ok = await writeClipboard(full)
    setCopied(ok)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(false), 1600)
  }

  return (
    <div className={`workspace-explorer-path ${className}`} data-path-full={full}>
      <button
        type="button"
        className="workspace-explorer-path-toggle"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-label={`${label} 전체 경로 보기`}
      >
        <code className="workspace-explorer-path-compact">{compactPath(full)}</code>
        <span className="workspace-explorer-path-hint">{open ? '접기' : '전체 경로'}</span>
      </button>
      {open && (
        <div className="workspace-explorer-path-detail">
          <code className="workspace-explorer-path-full">{full}</code>
          <button type="button" className="workspace-explorer-path-copy" onClick={() => void copy()}>
            <Copy size={11} aria-hidden="true" /> {copied ? '복사됨' : '경로 복사'}
          </button>
        </div>
      )}
    </div>
  )
}

export default function ContextSections({
  currentProject,
  currentWorkspace,
  currentTasks,
  allTasks = [],
  focusLabel,
  visibleRows,
  currentNodeId,
  TreeMapRows,
  goToNode,
  toggleExpanded,
  workRowAction,
  unlinkError,
  knowledgePages,
  buildPageRows,
  togglePageExpanded,
  files,
  handleAddFolder,
  expandedDirs,
  onToggleDir,
  openFile,
  activeFile,
  executionContext,
  onFocusTask,
}) {
  const [newFileDraft, setNewFileDraft] = useState(null)
  const [newFileError, setNewFileError] = useState(null)
  const [newFileBusy, setNewFileBusy] = useState(false)
  const [selectedFolders, setSelectedFolders] = useState({})

  const projectId = currentProject?.id || executionContext?.projectId || null
  const linkedTasksByFile = new Map()
  for (const task of allTasks.length ? allTasks : currentTasks || []) {
    const visit = (items = []) => {
      for (const item of items) {
        const resourceFileId = item.fileId || item.file?.id
        if (resourceFileId) {
          linkedTasksByFile.set(resourceFileId, [
            ...(linkedTasksByFile.get(resourceFileId) || []),
            { id: task.id, title: task.label },
          ])
        }
        visit(item.children || [])
      }
    }
    visit(task.children || [])
  }

  const activeLocation = activeFile?.path && files.fileLocation
    ? files.fileLocation(activeFile.rootId, activeFile.path)
    : null
  const activeRootFolder = activeLocation?.folderPath || ''

  const submitNewFile = async (sectionRoot) => {
    if (!newFileDraft || !newFileDraft.name.trim() || newFileBusy) return
    setNewFileBusy(true)
    setNewFileError(null)
    if (newFileDraft.destinationFolder === null) {
      setNewFileBusy(false)
      setNewFileError('파일을 만들 위치를 먼저 선택하세요')
      return
    }
    const folder = newFileDraft.destinationFolder || ''
    const relativePath = [folder, newFileDraft.name.trim()].filter(Boolean).join('/')
    const result = await files.createFile(sectionRoot, relativePath, '')
    setNewFileBusy(false)
    if (!result.ok) {
      setNewFileError(result.error || '파일 생성에 실패했습니다')
      return
    }
    setNewFileDraft(null)
    const created = result.file
    if (created?.path && openFile) {
      openFile({
        fileId: created.file_id,
        rootId: created.root || sectionRoot,
        path: created.path,
        label: created.name,
      })
    }
  }

  const renderFileSection = (section) => {
    const entries = section.entries || []
    const nodes = []
    entries.forEach((entry, index) => {
      let visible = true
      for (let k = index - 1; k >= 0; k -= 1) {
        if ((entries[k].depth || 0) < (entry.depth || 0)) {
          if (!expandedDirs?.has(`dir:${entries[k].path}`)) visible = false
          break
        }
      }
      if (!visible) return

      if (entry.type === 'dir') {
        const expanded = Boolean(expandedDirs?.has(`dir:${entry.path}`))
        const selected = selectedFolders[section.root] === entry.path
        nodes.push(
          <div
            key={`dir:${section.root}:${entry.path}`}
            className={`tree-prototype-map-row is-dir workspace-explorer-folder${selected ? ' is-selected' : ''}`}
            data-folder-path={entry.path}
            style={{ '--map-depth': entry.depth || 0 }}
          >
            <button
              type="button"
              className="tree-prototype-map-chevron"
              onClick={() => onToggleDir(entry.path)}
              aria-expanded={expanded}
              aria-label={`${expanded ? 'Collapse' : 'Expand'} ${entry.name}`}
            >
              <ChevronRight
                size={11}
                strokeWidth={2}
                style={{ transform: expanded ? 'rotate(90deg)' : 'none', transition: 'transform 120ms ease' }}
              />
            </button>
            <button
              type="button"
              className="tree-prototype-map-label"
              onClick={() => {
                setSelectedFolders((previous) => ({ ...previous, [section.root]: entry.path }))
                if (!expanded && entries.some((candidate) => (candidate.depth || 0) > (entry.depth || 0) && candidate.path.startsWith(`${entry.path}/`))) {
                  onToggleDir(entry.path)
                }
              }}
              aria-pressed={selected}
              title={`Use ${entry.name} as the current folder`}
            >
              <Folder size={11} strokeWidth={1.8} aria-hidden="true" />
              <span>{entry.name}</span>
            </button>
          </div>,
        )
        return
      }

      const fileId = entry.id || null
      const rowId = fileId ? `file:${fileId}` : `file:${entry.path}`
      const linkedTasks = fileId ? linkedTasksByFile.get(fileId) || [] : []
      nodes.push(
        <div
          key={rowId}
          className="tree-prototype-map-row workspace-explorer-file"
          data-file-path={entry.path}
          style={{ '--map-depth': entry.depth || 0 }}
        >
          <span className="tree-prototype-map-chevron" aria-hidden="true" />
          <button
            type="button"
            className={`tree-prototype-map-label${fileId && activeFile?.fileId === fileId ? ' is-active' : ''}`}
            onClick={() => {
              if (entry.type !== 'file') return
              openFile({
                fileId: entry.id,
                rootId: entry.root_id || section.root,
                path: entry.path,
                label: entry.name,
                text: entry.text,
              })
            }}
            title={entry.type === 'file' ? entry.path : undefined}
          >
            <span>{entry.type === 'blocked' ? `${entry.name} (차단됨)` : entry.name}</span>
            {linkedTasks.length > 0 && (
              <span className="workspace-explorer-linked-marker" aria-label={`Linked to ${linkedTasks.map((task) => task.title).join(', ')}`}>↳</span>
            )}
          </button>
        </div>,
      )
    })
    return nodes
  }

  return (
    <>
      <section className="v4-context-current" aria-label="Current working context">
        <div className="v4-context-section-title">CURRENT</div>
        {focusLabel && (
          <div className="v4-context-current-row">
            <span>Focus</span>
            <strong>{focusLabel}</strong>
          </div>
        )}
        <div className="v4-context-current-row">
          <span>Project</span>
          <strong>{currentProject?.label || '선택된 프로젝트 없음'}</strong>
        </div>
        <div className="v4-context-current-row">
          <span>Workspace</span>
          <strong>{currentWorkspace?.label || '연결된 Workspace 없음'}</strong>
        </div>
        {currentProject && (
          <div className="v4-context-current-row">
            <span>Tasks</span>
            <strong>{currentTasks.length}</strong>
          </div>
        )}
      </section>

      <div className="v4-context-section-title v4-context-work-title">WORK</div>
      {visibleRows.length === 0 && (
        <div className="tree-prototype-overview-empty">No matching projects or tasks.</div>
      )}
      <TreeMapRows rows={visibleRows} currentNodeId={currentNodeId} goToNode={goToNode} onToggleExpanded={toggleExpanded} renderRowAction={workRowAction} />
      {unlinkError && <div className="tree-prototype-add-error" role="alert">{unlinkError}</div>}

      {knowledgePages.status === 'loading' && <div className="tree-prototype-knowledge-status">Knowledge 불러오는 중…</div>}
      {knowledgePages.status === 'error' && (
        <div className="tree-prototype-knowledge-status is-error">
          {knowledgePages.error || 'Knowledge를 불러오지 못했습니다'}
        </div>
      )}
      {knowledgePages.status === 'ready' && (
        <div className="tree-prototype-overview-knowledge">
          <div className="tree-prototype-knowledge-title">
            KNOWLEDGE / PAGES
            {knowledgePages.scratch && <span className="tree-prototype-knowledge-scratch">SCRATCH</span>}
          </div>
          {knowledgePages.pages.length === 0 ? (
            <div className="tree-prototype-knowledge-status">페이지 없음</div>
          ) : (
            <TreeMapRows
              rows={knowledgePages.pages.flatMap((page) => buildPageRows(page, 0))}
              currentNodeId={null}
              goToNode={togglePageExpanded}
              onToggleExpanded={togglePageExpanded}
            />
          )}
        </div>
      )}

      {files.status === 'error' && (
        <div className="tree-prototype-overview-knowledge">
          <div className="tree-prototype-knowledge-title">WORKSPACE / FILES</div>
          <div className="tree-prototype-add-error" role="alert">파일 뷰 새로고침 실패: {files.error || '알 수 없는 오류'}</div>
          <button type="button" className="tree-prototype-settings-add" onClick={() => files.refresh()}>
            <RefreshCw size={11} strokeWidth={1.9} aria-hidden="true" /> 다시 시도
          </button>
        </div>
      )}

      {files.status === 'ready' && files.roots.length === 0 && (
        <div className="tree-prototype-overview-knowledge">
          <div className="tree-prototype-knowledge-title">WORKSPACE / FILES</div>
          <div className="tree-prototype-overview-empty">
            작업 공간을 먼저 선택하세요 — 선택한 폴더 안의 파일을 JARVIS가 읽고 정리합니다.
          </div>
          <button type="button" className="tree-prototype-settings-add" onClick={handleAddFolder}>
            <FolderPlus size={11} strokeWidth={1.9} aria-hidden="true" /> 폴더 선택…
          </button>
        </div>
      )}

      {files.status === 'ready' && files.roots.length > 0 && (
        <div className="tree-prototype-overview-knowledge workspace-explorer">
          <div className="tree-prototype-knowledge-title">WORKSPACE EXPLORER</div>
          {files.sections.map((section) => {
            const rootInfo = files.rootInfo?.(section.root) || { label: section.root, absolutePath: '' }
            const hasExplicitFolderSelection = Object.prototype.hasOwnProperty.call(selectedFolders, section.root)
            const selectedFolder = hasExplicitFolderSelection
              ? selectedFolders[section.root]
              : activeFile?.rootId === section.root
                ? activeRootFolder
                : ''
            const selectedFolderLabel = [rootInfo.label, ...selectedFolder.split('/').filter(Boolean)].join(' / ')
            const selectedFolderAbsolute = selectedFolder
              ? files.fileLocation?.(section.root, `${selectedFolder}/.jarvis-folder-placeholder`)?.absoluteFolderPath
              : rootInfo.absolutePath
            const activeFolder = activeFile?.rootId === section.root ? activeRootFolder : null
            const destinationConflict = Boolean(newFileDraft?.root === section.root && newFileDraft.destinationConflict)
            const destinationFolder = newFileDraft?.root === section.root
              ? newFileDraft.destinationFolder
              : selectedFolder
            const destinationFolderLabel = destinationFolder === null
              ? '위치를 선택하세요'
              : [rootInfo.label, ...(destinationFolder || '').split('/').filter(Boolean)].join(' / ')
            const destinationFolderAbsolute = destinationFolder === null
              ? ''
              : destinationFolder
                ? files.fileLocation?.(section.root, `${destinationFolder}/.jarvis-folder-placeholder`)?.absoluteFolderPath
                : rootInfo.absolutePath
            const activeFolderLabel = activeFolder === null
              ? ''
              : [rootInfo.label, ...activeFolder.split('/').filter(Boolean)].join(' / ')
            const activeFolderAbsolute = activeFolder === null
              ? ''
              : activeFolder
                ? files.fileLocation?.(section.root, `${activeFolder}/.jarvis-folder-placeholder`)?.absoluteFolderPath
                : rootInfo.absolutePath
            return (
              <div key={section.root || 'root'} className="tree-prototype-files-section" data-workspace-root={section.root}>
                <header className="workspace-explorer-root">
                  <div className="workspace-explorer-root-heading">
                    <Folder size={14} aria-hidden="true" />
                    <strong>{rootInfo.label}</strong>
                    <button
                      type="button"
                      className="workspace-explorer-create"
                      onClick={() => {
                        const initialFolder = selectedFolder
                        const conflictingActiveFolder = activeFile?.rootId === section.root && activeRootFolder !== initialFolder
                        setNewFileError(null)
                        setNewFileDraft({
                          root: section.root,
                          name: '',
                          destinationFolder: conflictingActiveFolder ? null : initialFolder,
                          destinationConflict: conflictingActiveFolder,
                        })
                      }}
                      aria-label="Create new file"
                    >
                      <FilePlus size={13} aria-hidden="true" /> 새 파일
                    </button>
                  </div>
                  <ExplorerPath
                    value={rootInfo.absolutePath}
                    className="workspace-explorer-root-path"
                    label="Workspace 루트"
                  />
                  <div className="workspace-explorer-current-folder">
                    <span>현재 폴더</span>
                    <button
                      type="button"
                      className="workspace-explorer-folder-home"
                      onClick={() => setSelectedFolders((previous) => ({ ...previous, [section.root]: '' }))}
                      aria-pressed={!selectedFolder}
                      title="Use the Workspace root as the current folder"
                    >
                      <strong>{selectedFolderLabel}</strong>
                    </button>
                    <div className="workspace-explorer-breadcrumb" aria-label="Selected folder breadcrumb">
                      {[rootInfo.label, ...selectedFolder.split('/').filter(Boolean)].map((part, index) => (
                        <span key={`${part}-${index}`}>{index > 0 ? '› ' : ''}{part}</span>
                      ))}
                    </div>
                    {selectedFolderAbsolute && (
                      <ExplorerPath
                        value={selectedFolderAbsolute}
                        className="workspace-explorer-folder-path"
                        label="현재 폴더"
                      />
                    )}
                  </div>
                </header>
                {section.error && <div className="tree-prototype-add-error" role="alert">{section.error}</div>}
                {section.stats?.truncated && <div className="workspace-explorer-bounded-note">일부 항목만 표시 · 하위 폴더를 펼쳐 확인하세요</div>}
                {renderFileSection(section)}

                {newFileDraft?.root === section.root && (
                  <form
                    className="tree-prototype-new-file workspace-explorer-create-form"
                    onSubmit={(event) => {
                      event.preventDefault()
                      void submitNewFile(section.root)
                    }}
                  >
                    {destinationConflict && newFileDraft.destinationFolder === null && (
                      <fieldset className="workspace-explorer-destination-choices">
                        <legend>두 위치가 다릅니다. 생성할 폴더를 선택하세요.</legend>
                        <label>
                          <input
                            type="radio"
                            name={`create-destination-${section.root}`}
                            value={selectedFolder}
                            checked={newFileDraft.destinationFolder === selectedFolder}
                            onChange={() => setNewFileDraft((draft) => ({ ...draft, destinationFolder: selectedFolder }))}
                          />
                          <span>Explorer 선택 · {selectedFolderLabel}</span>
                          <code>{selectedFolderAbsolute || selectedFolderLabel}</code>
                        </label>
                        <label>
                          <input
                            type="radio"
                            name={`create-destination-${section.root}`}
                            value={activeFolder}
                            checked={newFileDraft.destinationFolder === activeFolder}
                            onChange={() => setNewFileDraft((draft) => ({ ...draft, destinationFolder: activeFolder }))}
                          />
                          <span>열린 파일 폴더 · {activeFolderLabel}</span>
                          <code>{activeFolderAbsolute || activeFolderLabel}</code>
                        </label>
                      </fieldset>
                    )}
                    <label className="workspace-explorer-destination">
                      <span>위치 · {destinationFolderLabel}</span>
                      {destinationFolderAbsolute && <code>{destinationFolderAbsolute}</code>}
                    </label>
                    <input
                      type="text"
                      autoFocus
                      value={newFileDraft.name}
                      onChange={(event) => setNewFileDraft((draft) => ({ ...draft, name: event.target.value }))}
                      placeholder="새 파일 이름 (예: notes.md)"
                      aria-label="New file name"
                    />
                    {newFileDraft.name.trim() && newFileDraft.destinationFolder !== null && (
                      <code className="workspace-explorer-create-preview">
                        생성될 파일 · {`${String(destinationFolderAbsolute || '').replace(/[\\/]+$/, '')}${destinationFolderAbsolute?.includes('\\') ? '\\' : '/'}${newFileDraft.name.trim()}`}
                      </code>
                    )}
                    <button type="submit" disabled={newFileBusy || newFileDraft.destinationFolder === null || !newFileDraft.name.trim()}>
                      {newFileBusy ? '만드는 중…' : '만들기'}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setNewFileDraft(null)
                        setNewFileError(null)
                      }}
                    >
                      취소
                    </button>
                    {newFileError && <div className="tree-prototype-add-error" role="alert">{newFileError}</div>}
                  </form>
                )}

                {activeFile?.rootId === section.root && activeLocation && (
                  <div className="workspace-explorer-active" aria-label="Active file location">
                    <span className="workspace-explorer-active-label">ACTIVE FILE</span>
                    <strong>{activeFile.label || activeFile.path}</strong>
                    <div className="workspace-explorer-breadcrumb" aria-label="File breadcrumb">
                      {activeLocation.breadcrumb.map((part, index) => (
                        <span key={`${part}-${index}`}>{index > 0 ? '› ' : ''}{part}</span>
                      ))}
                    </div>
                    <ExplorerPath
                      value={activeLocation.absolutePath || activeFile.path}
                      className="workspace-explorer-full-path"
                      label="활성 파일"
                    />
                    {(() => {
                      const matches = linkedTasksByFile.get(activeFile.fileId) || []
                      return matches.length ? (
                        <div className="workspace-explorer-task-links">
                          <span>연결된 Task</span>
                          {matches.map((task) => (
                            <button
                              type="button"
                              key={task.id}
                              className="workspace-explorer-task-link"
                              onClick={() => {
                                if (onFocusTask) onFocusTask(task.id)
                                else goToNode(task.id)
                              }}
                            >
                              ↳ {task.title}
                            </button>
                          ))}
                        </div>
                      ) : (
                        <div className="workspace-explorer-task-links is-unlinked">아직 연결된 Task가 없습니다</div>
                      )
                    })()}
                    {projectId && <div className="workspace-explorer-task-context">Project · {currentProject?.label}</div>}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </>
  )
}
