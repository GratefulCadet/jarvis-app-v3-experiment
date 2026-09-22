import { FolderPlus, Link2, RefreshCw } from 'lucide-react'

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
  makeFileRow,
  openLinkPopover,
}) {
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
          <div className="tree-prototype-overview-empty">연결된 폴더가 없습니다.</div>
          <button type="button" className="tree-prototype-settings-add" onClick={handleAddFolder}>
            <FolderPlus size={11} strokeWidth={1.9} aria-hidden="true" />
            Add Folder…
          </button>
        </div>
      )}

      {files.status === 'ready' && files.roots.length > 0 && (
        <div className="tree-prototype-overview-knowledge">
          <div className="tree-prototype-knowledge-title">WORKSPACE / FILES</div>
          <TreeMapRows
            rows={files.sections.flatMap((section) => section.entries.map(makeFileRow))}
            currentNodeId={null}
            goToNode={() => {}}
            onToggleExpanded={() => {}}
            renderRowAction={(rowNode) =>
              rowNode.fileId && rowNode.id.startsWith('file:f-') ? (
                <button
                  key={`${rowNode.id}-link`}
                  type="button"
                  className="tree-prototype-map-row-action"
                  aria-label={`Link ${rowNode.label} to project`}
                  title="Link to Project"
                  onClick={(event) => {
                    event.stopPropagation()
                    openLinkPopover(rowNode.fileId, rowNode.label)
                  }}
                >
                  <Link2 size={11} strokeWidth={2} aria-hidden="true" />
                </button>
              ) : null
            }
          />
        </div>
      )}
    </>
  )
}
