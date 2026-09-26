import { ChevronRight, Folder, FolderPlus, RefreshCw } from 'lucide-react'

/*
  UX 피드백(4번) — FILES 섹션을 파일 탐색기처럼.

  files_snapshot의 평탄 목록(depth 포함)을 그대로 그리되, dir 행은 클릭으로
  펼치고/접고, 그 자식은 부모가 펼쳐진 경우에만 depth 들여쓰기로 보인다.
  파일 행의 identity(file:<f-*>)·링크·열기 규약은 이전과 동일하다.
*/
export default function ContextSections({
  currentProject,
  currentWorkspace,
  currentTasks,
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
}) {
  /*
    FILES 트리 렌더 — 한 루트 섹션씩. dir 행 클릭 = onToggleDir(path).
    자식 노출 규칙: 나보다 깊은 연속 구간이며, 사이에 더 얕은(조상) 항목이
    끼어들지 않는 한도에서 부모가 펼쳐 있을 때만 그린다.
  */
  const renderFileSection = (section) => {
    const entries = section.entries || []
    const nodes = []
    entries.forEach((entry, index) => {
      // 이 항목을 그릴지 — 가장 가까운 조상 dir이 모두 펼쳐져 있어야 한다.
      let visible = true
      for (let k = index - 1; k >= 0; k -= 1) {
        if ((entries[k].depth || 0) < (entry.depth || 0)) {
          const ancestorPath = entries[k].path
          if (!expandedDirs || !expandedDirs.has(`dir:${ancestorPath}`)) {
            visible = false
          }
          break
        }
      }
      if (!visible) return

      if (entry.type === 'dir') {
        const expanded = Boolean(expandedDirs && expandedDirs.has(`dir:${entry.path}`))
        nodes.push(
          <button
            key={`dir:${entry.path}`}
            type="button"
            className="tree-prototype-map-row is-dir"
            style={{ '--map-depth': entry.depth || 0 }}
            onClick={() => onToggleDir(entry.path)}
            aria-expanded={expanded}
          >
            <span className="tree-prototype-map-chevron" aria-hidden="true">
              <ChevronRight
                size={11}
                strokeWidth={2}
                style={{ transform: expanded ? 'rotate(90deg)' : 'none', transition: 'transform 120ms ease' }}
              />
            </span>
            <span className="tree-prototype-map-label">
              <Folder size={11} strokeWidth={1.8} aria-hidden="true" />
              <span>{entry.name}</span>
            </span>
          </button>,
        )
        return
      }

      // file / blocked
      const fileId = entry.id || null
      const rowId = fileId ? `file:${fileId}` : `file:${entry.path}`
      nodes.push(
        <div
          key={rowId}
          className="tree-prototype-map-row"
          style={{ '--map-depth': entry.depth || 0 }}
        >
          <span className="tree-prototype-map-chevron" aria-hidden="true" />
          <button
            type="button"
            className="tree-prototype-map-label"
            onClick={() => {
              if (entry.type !== 'file') return
              openFile({
                fileId: entry.id,
                rootId: entry.root_id || (files.roots && files.roots[0]),
                path: entry.path,
                label: entry.name,
                text: entry.text,
              })
            }}
          >
            <span>{entry.type === 'blocked' ? `${entry.name} (차단됨)` : entry.name}</span>
          </button>
          {/* 파일→프로젝트/태스크 링크는 Assistant의 '이 작업에 연결'이 담당한다(중복 제거). */}
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
        <div className="tree-prototype-overview-empty">
          No matching projects or tasks.
        </div>
      )}
      <TreeMapRows
        rows={visibleRows}
        currentNodeId={currentNodeId}
        goToNode={goToNode}
        onToggleExpanded={toggleExpanded}
        renderRowAction={workRowAction}
      />
      {unlinkError && (
        <div className="tree-prototype-add-error" role="alert">
          {unlinkError}
        </div>
      )}

      {knowledgePages.status === 'loading' && (
        <div className="tree-prototype-knowledge-status">
          Knowledge 불러오는 중…
        </div>
      )}
      {knowledgePages.status === 'error' && (
        <div className="tree-prototype-knowledge-status is-error">
          {knowledgePages.error || 'Knowledge를 불러오지 못했습니다'}
        </div>
      )}
      {knowledgePages.status === 'ready' && (
        <div className="tree-prototype-overview-knowledge">
          <div className="tree-prototype-knowledge-title">
            KNOWLEDGE / PAGES
            {knowledgePages.scratch && (
              <span className="tree-prototype-knowledge-scratch">SCRATCH</span>
            )}
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
          <div className="tree-prototype-add-error" role="alert">
            파일 뷰 새로고침 실패: {files.error || '알 수 없는 오류'}
          </div>
          <button type="button" className="tree-prototype-settings-add" onClick={() => files.refresh()}>
            <RefreshCw size={11} strokeWidth={1.9} aria-hidden="true" />
            다시 시도
          </button>
        </div>
      )}

      {files.status === 'ready' && files.roots.length === 0 && (
        <div className="tree-prototype-overview-knowledge">
          <div className="tree-prototype-knowledge-title">WORKSPACE / FILES</div>
          {/* UX 피드백(4번) — 작업 공간 선택이 곧 시작이다. */}
          <div className="tree-prototype-overview-empty">
            작업 공간을 먼저 선택하세요 —
            선택한 폴더 안의 파일을 JARVIS가 읽고 정리합니다.
          </div>
          <button type="button" className="tree-prototype-settings-add" onClick={handleAddFolder}>
            <FolderPlus size={11} strokeWidth={1.9} aria-hidden="true" />
            폴더 선택…
          </button>
        </div>
      )}

      {files.status === 'ready' && files.roots.length > 0 && (
        <div className="tree-prototype-overview-knowledge">
          <div className="tree-prototype-knowledge-title">WORKSPACE / FILES</div>
          {files.sections.map((section) => (
            <div key={section.root || 'root'} className="tree-prototype-files-section">
              {files.sections.length > 1 && (
                <div className="tree-prototype-files-root-name">{section.root}</div>
              )}
              {renderFileSection(section)}
            </div>
          ))}
        </div>
      )}
    </>
  )
}
