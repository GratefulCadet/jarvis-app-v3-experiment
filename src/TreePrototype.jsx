import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

import {
  AnimatePresence,
  motion,
} from 'motion/react'

import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderPlus,
  Map as MapIcon,
  Maximize2,
  Network,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Trash2,
  X,
} from 'lucide-react'

import useJarvisTree, {
  TASK_NODE_TYPES,
} from './useJarvisTree'

import useJarvisPages from './useJarvisPages'

import useJarvisFiles from './useJarvisFiles'

import useWorkspaceRoots from './useWorkspaceRoots'
import ContextSections from './ContextSections'
import FileEditor from './FileEditor'

const SPACE_DOTS = [
  { x: '18%', y: '20%', z: -120, scale: 0.62 },
  { x: '77%', y: '18%', z: -40, scale: 0.84 },
  { x: '62%', y: '32%', z: 90, scale: 0.52 },
  { x: '28%', y: '64%', z: 40, scale: 0.74 },
  { x: '84%', y: '70%', z: -90, scale: 0.58 },
  { x: '12%', y: '76%', z: 80, scale: 0.48 },
  { x: '48%', y: '15%', z: 120, scale: 0.44 },
  { x: '51%', y: '84%', z: -30, scale: 0.68 },
]

const PINNED_SHORTCUTS_KEY =
  'jarvis_tree_pinned_shortcuts_v1'

const EXPANDED_TREE_KEY =
  'jarvis_tree_expanded_v1'

const TONE_PRESETS = [
  [126, 219, 255],
  [166, 229, 196],
  [255, 210, 132],
  [227, 182, 255],
]

const CAROUSEL_WHEEL_LOCK_MS = 140
const CAROUSEL_MOVE_SECONDS = 0.22

const getTone = (nodeId) => {
  const seed = String(nodeId || '')
    .split('')
    .reduce(
      (sum, character) =>
        sum + character.charCodeAt(0),
      0,
    )

  return TONE_PRESETS[
    seed % TONE_PRESETS.length
  ]
}

const readPinnedShortcuts = () => {
  if (typeof window === 'undefined') {
    return []
  }

  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(
        PINNED_SHORTCUTS_KEY,
      ) || '[]',
    )

    return Array.isArray(parsed)
      ? parsed.filter(
          (nodeId) =>
            typeof nodeId === 'string',
        )
      : []
  } catch (error) {
    console.warn(
      'Failed to load JARVIS pinned shortcuts.',
      error,
    )

    return []
  }
}

const readExpandedTreeIds = () => {
  if (typeof window === 'undefined') {
    return new Set()
  }

  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(
        EXPANDED_TREE_KEY,
      ) || '[]',
    )

    return new Set(
      Array.isArray(parsed)
        ? parsed.filter(
            (nodeId) =>
              typeof nodeId === 'string',
          )
        : [],
    )
  } catch (error) {
    console.warn(
      'Failed to load JARVIS tree expansion.',
      error,
    )

    return new Set()
  }
}

/*
  FILES 섹션 행 — bridge files_snapshot의 평탄 entry를 TreeMapRows shape으로.
  blocked(민감 차단) 항목은 이름만 노출(내용 없음)하고 접두어로 표시한다.

  노드 id는 stable FileRef identity(`file:<f-...>`)를 우선 쓴다(§11) — 파일이
  rename/move돼도 reconciliation이 성공하면 같은 노드 identity가 유지되고
  React 키도 안정적이다. identity 없는 entry(스캔 전/미등록)는 경로 fallback.
*/
const makeFileRow = (entry) => ({
  node: {
    id: entry.id ? `file:${entry.id}` : `file:${entry.path}`,
    label: entry.type === 'blocked' ? `${entry.name} (차단됨)` : entry.name,
    // RESOURCE LINK V1 — stable FileRef identity만 링크 가능. 경로 fallback
    // entry(스캔 전/미등록)는 fileId가 없어 링크 UI가 뜨지 않는다.
    fileId: entry.id || null,
    children: [],
  },
  depth: entry.depth,
  expanded: false,
  hasChildren: false,
  parentIds: [],
})

const createAddDraft = () => ({
  label: '',
  description: '',
  type: 'task',
})

const getCompletionPercent = (
  stats,
) => {
  if (!stats.total) {
    return 0
  }

  return Math.round(
    (stats.completed / stats.total) *
      100,
  )
}

const flattenTree = (
  node,
  depth = 0,
  parentIds = [],
) => [
  {
    node,
    depth,
    parentIds,
  },
  ...node.children.flatMap(
    (child) =>
      flattenTree(
        child,
        depth + 1,
        [
          ...parentIds,
          node.id,
        ],
      ),
  ),
]

/*
  VS Code 탐색기 스타일의 접이식 트리 행.
  chevron(있으면) = 펼치기/접기, label = 해당 노드로 이동.
*/
function TreeMapRows({
  rows,
  currentNodeId,
  goToNode,
  onToggleExpanded,
  renderRowAction,

}) {
  return rows.map(
    ({
      node,
      depth,
      expanded,
      hasChildren,
      parentIds,
    }) => {
      const isActive =
        node.id === currentNodeId

      const isDescendant =
        Array.isArray(parentIds) &&
        parentIds.includes(
          currentNodeId,
        )

      return (
        <div
          key={node.id}
          className="tree-prototype-map-row"
          style={{
            '--map-depth': depth,
          }}
        >
          <button
            type="button"
            className="tree-prototype-map-chevron"
            disabled={!hasChildren}
            aria-expanded={
              hasChildren
                ? expanded
                : undefined
            }
            aria-label={
              hasChildren
                ? expanded
                  ? `Collapse ${node.label}`
                  : `Expand ${node.label}`
                : undefined
            }
            onClick={(event) => {
              event.stopPropagation()
              onToggleExpanded(
                node.id,
              )
            }}
          >
            {hasChildren ? (
              expanded ? (
                <ChevronDown
                  size={12}
                  strokeWidth={2}
                  aria-hidden="true"
                />
              ) : (
                <ChevronRight
                  size={12}
                  strokeWidth={2}
                  aria-hidden="true"
                />
              )
            ) : (
              <span
                className="tree-prototype-map-leaf"
                aria-hidden="true"
              />
            )}
          </button>

          <button
            type="button"
            className={[
              'tree-prototype-map-label',
              isActive ? 'is-active' : '',
              isDescendant
                ? 'is-descendant'
                : '',
            ]
              .filter(Boolean)
              .join(' ')}
            onClick={() =>
              goToNode(node.id)
            }
          >
            {node.label}
          </button>

          {renderRowAction && renderRowAction(node)}
        </div>
      )
    },
  )
}

export default function TreePrototype({
  executionContext,
  runtime,
  fileEditor,
  openFile: setFileEditor,
  closeFile,
}) {
  const taskTree =
    useJarvisTree()

  const knowledgePages =
    useJarvisPages()

  const files =
    useJarvisFiles()

  /*
    Knowledge pages 펼침 상태 — 기본은 모두 펼침, Set에 있으면 접힘.
  */
  const [
    collapsedPageIds,
    setCollapsedPageIds,
  ] = useState(() => new Set())

  const popoverRef =
    useRef(null)

  const lastCarouselWheelAtRef =
    useRef(0)

  const [
    currentNodeId,
    setCurrentNodeId,
  ] = useState(
    taskTree.root.id,
  )

  const [
    activePopover,
    setActivePopover,
  ] = useState(null)

  const [
    dialog,
    setDialog,
  ] = useState(null)

  /*
    Active File — 열린 파일 편집기 state는 App이 소유한다(V4 Active File
    컨텍스트). TreePrototype은 열기/닫기 콜백만 받는다.
  */

  const [
    searchText,
    setSearchText,
  ] = useState('')

  const [
    pinnedNodeIds,
  ] = useState(
    readPinnedShortcuts,
  )

  const [
    expandedNodeIds,
    setExpandedNodeIds,
  ] = useState(() => {
    const initial =
      readExpandedTreeIds()

    // 첫 실행 기본값: 루트 + 최상위 브랜치만 펼친 상태
    if (initial.size === 0) {
      initial.add(taskTree.root.id)
      for (const child of
        taskTree.root.children) {
        initial.add(child.id)
      }
    }

    return initial
  })

  const [
    previewNodeId,
    setPreviewNodeId,
  ] = useState(null)

  const [
    focusIndex,
    setFocusIndex,
  ] = useState(0)

  const current = useMemo(
    () =>
      taskTree.find(
        currentNodeId,
      ) ?? {
        node: taskTree.root,
        path: [
          taskTree.root,
        ],
      },
    [
      currentNodeId,
      taskTree,
    ],
  )

  const {
    node,
    path,
  } = current

  const parent =
    path.length > 1
      ? path[path.length - 2]
      : null

  const children =
    node.children ?? []

  const focusedIndex =
    children.length
      ? (focusIndex %
          children.length +
          children.length) %
        children.length
      : 0

  const depth =
    path.length - 1

  const previewNode =
    children.find(
      (child) =>
        child.id === previewNodeId,
    ) ||
    children[focusedIndex]

  const goToNode = (
    nodeId,
  ) => {
    setCurrentNodeId(nodeId)
    setFocusIndex(0)
    setPreviewNodeId(null)
    setActivePopover(null)

    // 이동하는 경로는 자동으로 펼친다 (탐색기 reveal 느낌).
    const destination =
      taskTree.find(nodeId)

    if (destination) {
      setExpandedNodeIds(
        (previous) => {
          const next = new Set(
            previous,
          )

          let changed = false

          for (const pathNode of
            destination.path) {
            if (
              !next.has(pathNode.id)
            ) {
              next.add(pathNode.id)
              changed = true
            }
          }

          return changed
            ? next
            : previous
        },
      )
    }
  }

  const moveFocus = (
    direction,
  ) => {
    if (children.length <= 1) {
      return
    }

    setFocusIndex(
      (currentIndex) =>
        currentIndex + direction,
    )
  }

  const flatNodes = useMemo(
    () =>
      flattenTree(
        taskTree.root,
      ),
    [taskTree.root],
  )

  useEffect(() => {
    try {
      window.localStorage.setItem(
        PINNED_SHORTCUTS_KEY,
        JSON.stringify(
          pinnedNodeIds,
        ),
      )
    } catch (error) {
      console.warn(
        'Failed to save JARVIS pinned shortcuts.',
        error,
      )
    }
  }, [pinnedNodeIds])

  /*
    접힘/펼침 상태 저장 (VS Code 탐색기처럼 유지).
  */
  useEffect(() => {
    try {
      window.localStorage.setItem(
        EXPANDED_TREE_KEY,
        JSON.stringify(
          [...expandedNodeIds],
        ),
      )
    } catch (error) {
      console.warn(
        'Failed to save JARVIS tree expansion.',
        error,
      )
    }
  }, [expandedNodeIds])

  /*
    Qwen이 만든 task 변경을 트리가 따라간다.

    Tree에서 직접 하는 변경은 useJarvisTree가 이미 재조회하지만, 모델이 tool
    loop으로 만든(create_task) 변경은 그 경로를 타지 않아 사용자가 수동 refresh
    전까지 트리가 낡아 있었다. runtime.taskStateRevision이 올라올 때만 —
    실제 실행된 write tool이 있을 때만 올라간다 — canonical snapshot으로 다시 읽는다.
  */
  const taskStateRevision =
    runtime?.taskStateRevision || 0

  /*
    taskTree 객체는 렌더마다 새로 만들어지므로 의존성에 넣으면 매 렌더마다
    다시 돌고, 다시 조회한 결과로 다시 렌더되는 순간 무한 반복이 된다.
    refresh는 useCallback으로 고정된 참조이므로 이것만 넣는다.
  */
  const refreshTaskTree =
    taskTree.refresh

  useEffect(() => {
    if (taskStateRevision === 0) return
    refreshTaskTree()
  }, [taskStateRevision, refreshTaskTree])

  const visibleMapNodes =
    flatNodes.filter((entry) => {
      const query =
        searchText
          .trim()
          .toLowerCase()

      if (!query) {
        return true
      }

      return (
        entry.node.label
          .toLowerCase()
          .includes(query) ||
        entry.node.description
          .toLowerCase()
          .includes(query)
      )
    })

  /*
    Knowledge 페이지 행 — 기본 모두 펼침, Set에 있으면 접힘.
    읽기 전용 milestone이라 label 클릭도 펼침/접힘 토글이다 (페이지 탐색은 다음 단계).
  */
  const buildPageRows = (
    pageNode,
    depth,
  ) => {
    const hasChildren =
      (pageNode.children?.length ??
        0) > 0

    const expanded =
      hasChildren &&
      !collapsedPageIds.has(
        pageNode.id,
      )

    const rows = [
      {
        node: pageNode,
        depth,
        expanded,
        hasChildren,
        parentIds: [],
      },
    ]

    if (expanded) {
      for (const child of
        pageNode.children) {
        rows.push(
          ...buildPageRows(
            child,
            depth + 1,
          ),
        )
      }
    }

    return rows
  }

  const togglePageExpanded = (
    pageId,
  ) => {
    setCollapsedPageIds(
      (previous) => {
        const next = new Set(
          previous,
        )

        if (next.has(pageId)) {
          next.delete(pageId)
        } else {
          next.add(pageId)
        }

        return next
      },
    )
  }

  /*
    접이식 트리 행 계산.
    - 검색 중이면 검색 결과 전체를 depth 들여쓰기로 보여준다(접힘 무시).
    - 평소에는 펼쳐진 노드의 자식만 재귀로 내려간다.
  */
  const buildTreeRows = (
    node,
    depth,
    ancestors = [],
  ) => {
    const hasChildren =
      (node.children?.length ?? 0) >
      0

    const expanded =
      expandedNodeIds.has(node.id)

    const rows = [
      {
        node,
        depth,
        expanded,
        hasChildren,
        parentIds: ancestors,
      },
    ]

    if (expanded) {
      for (const child of
        node.children ?? []) {
        rows.push(
          ...buildTreeRows(
            child,
            depth + 1,
            [...ancestors, node.id],
          ),
        )
      }
    }

    return rows
  }

  const searchActive =
    searchText.trim()

  const treeRows =
    buildTreeRows(
      taskTree.root,
      0,
    )

  const visibleRows =
    searchActive
      ? visibleMapNodes.map(
          (entry) => ({
            ...entry,
            hasChildren:
              (entry.node
                .children?.length ??
                0) > 0,
            expanded:
              expandedNodeIds.has(
                entry.node.id,
              ),
          }),
        )
      : treeRows

  const toggleExpanded = (
    nodeId,
  ) => {
    setExpandedNodeIds(
      (previous) => {
        const next = new Set(
          previous,
        )

        if (next.has(nodeId)) {
          next.delete(nodeId)
        } else {
          next.add(nodeId)
        }

        return next
      },
    )
  }

  const [
    addDraft,
    setAddDraft,
  ] = useState(
    createAddDraft,
  )

  const [addError, setAddError] = useState(null)

  const [addBusy, setAddBusy] = useState(false)

  const [unlinkBusy, setUnlinkBusy] = useState(false)
  const [unlinkError, setUnlinkError] = useState(null)

  /* WORKSPACE REGISTRATION — extracted to useWorkspaceRoots hook */
  const ws = useWorkspaceRoots({ taskTree, files })

  const handleAddFolder = ws.handleAddFolder
  const handleReconnectRoot = ws.handleReconnectRoot
  const handleRemoveRoot = ws.handleRemoveRoot

  const [deleteBusy, setDeleteBusy] = useState(false)
  const [deleteError, setDeleteError] = useState(null)

  useEffect(() => {
    if (!activePopover) {
      return undefined
    }

    const handlePointerDown =
      (event) => {
        if (
          popoverRef.current
            ?.contains(event.target)
        ) {
          return
        }

        setActivePopover(null)
      }

    window.addEventListener(
      'pointerdown',
      handlePointerDown,
    )

    return () => {
      window.removeEventListener(
        'pointerdown',
        handlePointerDown,
      )
    }
  }, [activePopover])

  const addChild = async (event) => {
    event.preventDefault()

    if (addBusy) return

    const label =
      typeof addDraft.label === 'string'
        ? addDraft.label.trim()
        : ''

    if (!label) return

    const normalizedType = TASK_NODE_TYPES.includes(addDraft.type)
      ? addDraft.type
      : 'task'

    const reason =
      typeof addDraft.description === 'string'
        ? addDraft.description.trim()
        : ''

    // Non-task types remain renderer-local (후속 마일스톤에서 제거 예정)
    if (normalizedType !== 'task') {
      const nextNodeId = taskTree.addChild(node.id, addDraft)

      if (!nextNodeId) return

      setAddDraft(createAddDraft())
      setAddError(null)
      goToNode(nextNodeId)
      return
    }

    // Canonical Task path — explicit user action → deterministic TaskStore write
    // Permission Gate 불필요: Qwen이 제안한 write가 아니라 사용자가 직접 누른 Add Task
    const projectId = (() => {
      if (node.type === 'project') return node.id
      for (let i = path.length - 1; i >= 0; i -= 1) {
        if (path[i].type === 'project') return path[i].id
      }
      return null
    })()

    if (!projectId) {
      setAddError('프로젝트를 선택한 뒤 Task를 추가하세요.')
      return
    }

    setAddBusy(true)
    setAddError(null)

    try {
      const result = await taskTree.createTask({
        projectId,
        title: label,
        reason,
      })

      if (!result || !result.ok) {
        setAddError(result?.error || 'Task 생성에 실패했습니다')
        return
      }

      setAddDraft(createAddDraft())
      setActivePopover(null)

      setExpandedNodeIds((previous) => {
        const next = new Set(previous)
        next.add(projectId)
        next.add(taskTree.root.id)
        return next
      })

      goToNode(result.task.id)
    } catch (exception) {
      setAddError(String(exception?.message || exception))
    } finally {
      setAddBusy(false)
    }
  }

  /* RESOURCE LINK V1 — files 뷰 파일 행의 명시적 Link to Project.
     fileId는 stable FileRef identity(f-*)만 — identity 없는 entry(미등록
     스캔)는 링크 버튼 자체가 없다(bridge도 경로를 거부한다). */
  const unlinkCurrentTaskResource = async (linkId) => {
    if (unlinkBusy || !linkId) return
    setUnlinkBusy(true)
    setUnlinkError(null)
    try {
      const result = await taskTree.unlinkTaskFile({ linkId })
      if (!result?.ok) {
        setUnlinkError(result?.error || 'Task 리소스 연결 해제에 실패했습니다')
        return
      }
    } catch (exception) {
      setUnlinkError(String(exception?.message || exception))
    } finally {
      setUnlinkBusy(false)
    }
  }

  const deleteCurrentNode = async () => {
    // Canonical Task Delete — destructive write through TaskStore via bridge.
    // No renderer-local removal before canonical success (fabrication 금지).
    if (node.type === 'task' && node.id && node.id.startsWith('t-')) {
      if (deleteBusy) return
      setDeleteBusy(true)
      setDeleteError(null)
      try {
        const result = await taskTree.deleteTask({ taskId: node.id })
        if (!result?.ok) {
          setDeleteError(result?.error || 'Task 삭제에 실패했습니다')
          return
        }
        setDialog(null)
        // PART G — deleted task가 현재 선택이었으면 parent Project로 이동
        goToNode(result.parentId || taskTree.root.id)
      } catch (exception) {
        setDeleteError(String(exception?.message || exception))
      } finally {
        setDeleteBusy(false)
      }
      return
    }

    // Non-task nodes remain renderer-local
    const nextNodeId = taskTree.deleteNode(
      node.id,
    )

    goToNode(nextNodeId)
    setDialog(null)
  }

  const requestDeleteCurrentNode =
    () => {
      if (
        node.id ===
        taskTree.root.id
      ) {
        return
      }

      setDialog('delete')
      setActivePopover(null)
    }

  const handleCarouselWheel = (
    event,
  ) => {
    if (children.length <= 1) {
      return
    }

    const delta =
      Math.abs(event.deltaX) >
      Math.abs(event.deltaY)
        ? event.deltaX
        : event.deltaY

    if (Math.abs(delta) < 8) {
      return
    }

    const now =
      window.performance.now()

    if (
      now -
        lastCarouselWheelAtRef.current <
      CAROUSEL_WHEEL_LOCK_MS
    ) {
      return
    }

    event.preventDefault()

    lastCarouselWheelAtRef.current =
      now

    moveFocus(
      delta > 0 ? 1 : -1,
    )
  }

  const updateSpotlight = (
    event,
  ) => {
    const rect =
      event.currentTarget
        .getBoundingClientRect()

    event.currentTarget
      .style.setProperty(
        '--tree-spotlight-x',
        `${event.clientX - rect.left}px`,
      )

    event.currentTarget
      .style.setProperty(
        '--tree-spotlight-y',
        `${event.clientY - rect.top}px`,
      )

    event.currentTarget
      .style.setProperty(
        '--tree-spotlight-opacity',
        '1',
      )
  }

  const hideSpotlight = (
    event,
  ) => {
    event.currentTarget
      .style.setProperty(
        '--tree-spotlight-opacity',
        '0',
      )
  }

  const focusNode =
    previewNode || node

  const currentProject =
    [...path].reverse().find((pathNode) => pathNode.type === 'project') || null
  const focusLabel = executionContext?.node?.label
  const currentWorkspace =
    currentProject?.children?.find((child) => child.type === 'workspace_group')?.children?.[0] || null
  const currentTasks =
    currentProject?.children?.filter((child) => child.type === 'task') || []

  const [
    toneRed,
    toneGreen,
    toneBlue,
  ] = getTone(focusNode.id)

  const carouselItems =
    children.map(
      (child, childIndex) => {
        let slot =
          childIndex - focusedIndex

        if (
          children.length > 2 &&
          slot > children.length / 2
        ) {
          slot -= children.length
        }

        if (
          children.length > 2 &&
          slot <
            -children.length / 2
        ) {
          slot += children.length
        }

        return {
          slot,
          child,
          childIndex,
        }
      },
    )

  return (
    <section
      className="tree-prototype-interface"
      aria-label="JARVIS Context"
      data-depth={depth}
      data-preview-active={
        previewNode ? 'true' : 'false'
      }
      onPointerMove={updateSpotlight}
      onPointerLeave={hideSpotlight}
      style={{
        '--tree-tone-r':
          toneRed,
        '--tree-tone-g':
          toneGreen,
        '--tree-tone-b':
          toneBlue,
      }}
    >
      {taskTree.status === 'loading' && (
        <div className="tree-prototype-status">
          불러오는 중…
        </div>
      )}

      {taskTree.status === 'error' && (
        <div className="tree-prototype-status is-error">
          {taskTree.error ||
            '트리를 불러오지 못했습니다'}
        </div>
      )}

      <div
        className="tree-prototype-cursor-spotlight"
        aria-hidden="true"
      />

      <div
        className="tree-prototype-field"
        aria-hidden="true"
      />

      <div
        className="tree-prototype-space"
        aria-hidden="true"
      >
        {SPACE_DOTS.map(
          (dot, index) => (
            <span
              key={`${dot.x}-${dot.y}`}
              style={{
                '--space-x': dot.x,
                '--space-y': dot.y,
                '--space-z':
                  `${dot.z}px`,
                '--space-scale':
                  dot.scale,
                '--space-delay':
                  `${index * 0.37}s`,
              }}
            />
          ),
        )}
      </div>

      <div
        className="tree-prototype-depth-field"
        aria-hidden="true"
      >
        {path.map(
          (pathNode, index) => (
            <span
              key={pathNode.id}
              className="tree-prototype-depth-ring"
              style={{
                '--depth-index':
                  index,
              }}
            />
          ),
        )}
      </div>

      <header className="tree-prototype-context">
        <div className="tree-prototype-kicker">
          <Network
            size={13}
            strokeWidth={1.7}
            aria-hidden="true"
          />
          CONTEXT
        </div>

        <div className="tree-prototype-breadcrumb">
          {path.map(
            (pathNode, index) => (
              <span
                key={pathNode.id}
                className="tree-prototype-breadcrumb-part"
              >
                {index > 0 && (
                  <ChevronRight
                    size={11}
                    aria-hidden="true"
                  />
                )}

                <button
                  type="button"
                  onClick={() =>
                    goToNode(
                      pathNode.id,
                    )
                  }
                >
                  {pathNode.label}
                </button>
              </span>
            ),
          )}
        </div>
      </header>

      {parent && (
        <motion.button
          type="button"
          className="tree-prototype-parent"
          whileTap={{
            scale: 0.97,
          }}
          onClick={() =>
            goToNode(
              parent.id,
            )
          }
        >
          <ArrowLeft
            size={14}
            aria-hidden="true"
          />
          {parent.label}
        </motion.button>
      )}

      <motion.div
        key={node.id}
        className="tree-prototype-current"
        initial={false}
        animate={{
          opacity: 1,
          y: 0,
          scale: 1,
        }}
        transition={{
          duration: 0.03,
          ease: [
            0.22,
            1,
            0.36,
            1,
          ],
        }}
      >
        <div
          className="tree-prototype-core-anchor"
          aria-hidden="true"
        >
          <span />
          <span />
          <span />
        </div>

        <span className="tree-prototype-current-silent-label">
          {node.label}
        </span>
      </motion.div>

      <div
        key={`${node.id}-children`}
        className={[
          'tree-prototype-children',
          'tree-prototype-carousel',
          children.length === 0
            ? 'is-empty'
            : '',
        ]
          .filter(Boolean)
          .join(' ')}
        onWheel={
          handleCarouselWheel
        }
      >
        <div
          className="tree-carousel-progressive-blur tree-carousel-progressive-blur-left"
          aria-hidden="true"
        />

        <div
          className="tree-carousel-progressive-blur tree-carousel-progressive-blur-right"
          aria-hidden="true"
        />

        {children.length > 1 && (
          <>
          <div
  className="tree-carousel-ghost-layer"
  aria-hidden="true"
>
  {[
    {
      id: 'left',
      x: -400,
      y: -120,
      z: -360,
      scale: 0.82,
      opacity: 0.04,
      rotateY: 12,
    },
    {
      id: 'center',
      x: 0,
      y: -175,
      z: -320,
      scale: 0.78,
      opacity: 0.06,
      rotateY: 0,
    },
    {
      id: 'right',
      x: 400,
      y: -120,
      z: -360,
      scale: 0.82,
      opacity: 0.04,
      rotateY: -12,
    },
  ].map((ghost) => (
    <motion.div
      key={ghost.id}
      className="tree-carousel-ghost-card"
      initial={false}
      animate={{
        x: ghost.x,
        y: ghost.y,
        z: ghost.z,
        scale: ghost.scale,
        opacity: ghost.opacity,
        rotateX: 0,
        rotateY: ghost.rotateY,
        rotateZ: 0,
      }}
      transition={{
        duration:
          CAROUSEL_MOVE_SECONDS,
        ease: [
          0.22,
          1,
          0.36,
          1,
        ],
      }}
    />
  ))}
</div>
            <button
              type="button"
              className="tree-carousel-arrow tree-carousel-arrow-left"
              onClick={() =>
                moveFocus(-1)
              }
              aria-label="Previous node"
            >
              &lt;
            </button>

            <button
              type="button"
              className="tree-carousel-arrow tree-carousel-arrow-right"
              onClick={() =>
                moveFocus(1)
              }
              aria-label="Next node"
            >
              &gt;
            </button>
          </>
        )}

        {carouselItems.map(
          ({
            child,
            childIndex,
            slot,
          }) => {
            const childStats =
              taskTree.stats(child)

            const distance =
              Math.abs(slot)

            /*
              Shallow 3D elliptical carousel.

              - focused card: Core 바로 아래 전면
              - side cards: Core 양옆/뒤로 살짝 올라감
              - far cards: 뒤쪽을 돌아가는 희미한 잔상
              - idle 상태에서는 정지
              - focus가 바뀔 때만 기존 0.22s lateral motion으로 이동
            */
            const isFocusedNode =
              slot === 0

            const isSideNode =
              distance === 1

            const isGhostNode =
              distance > 1

            const direction =
              Math.sign(slot)

            const carouselX =
              isFocusedNode
                ? 0
                : direction *
                  (isSideNode
                    ? 360
                    : 650 +
                      Math.max(
                        0,
                        distance - 2,
                      ) *
                        150)

            const carouselY =
              isFocusedNode
                ? 130
                : isSideNode
                  ? 100
                  : 30

            const carouselZ =
              isFocusedNode
                ? 55
                : isSideNode
                  ? -95
                  : -250 -
                    Math.max(
                      0,
                      distance - 2,
                    ) *
                      90

            const carouselScale =
              isFocusedNode
                ? 1
                : isSideNode
                  ? 0.90
                  : 0.76

            const carouselOpacity =
              isFocusedNode
                ? 1
                : isSideNode
                  ? 0.64
                  : Math.max(
                      0.08,
                      0.18 -
                        Math.max(
                          0,
                          distance - 2,
                        ) *
                          0.05,
                    )

            const carouselRotateY =
              isFocusedNode
                ? 0
                : -direction *
                  (isSideNode
                    ? 12
                    : 28)

            const carouselRotateX =
              isFocusedNode
                ? 0
                : isSideNode
                  ? 2
                  : 7

            const carouselFilter =
              isFocusedNode
                ? 'blur(0px) brightness(1)'
                : isSideNode
                  ? 'blur(0px) brightness(0.94)'
                  : 'blur(1.4px) brightness(0.68)'

            return (
              <motion.button
                type="button"
                key={child.id}
                className={[
                  'tree-prototype-node',
                  child.complete
                    ? 'is-complete'
                    : '',
                  isFocusedNode
                    ? 'is-focused-carousel'
                    : '',
                  isSideNode
                    ? 'is-side-carousel'
                    : '',
                  isGhostNode
                    ? 'is-far-carousel'
                    : '',
                  `tree-prototype-node-${
                    childIndex % 4
                  }`,
                ]
                  .filter(Boolean)
                  .join(' ')}
                initial={false}
                style={{
                  zIndex:
                    10 - distance,
                  pointerEvents:
                    isGhostNode
                      ? 'none'
                      : 'auto',
                }}
                animate={{
                  opacity:
                    carouselOpacity,
                  x: carouselX,
                  y: carouselY,
                  z: carouselZ,
                  rotateX:
                    carouselRotateX,
                  rotateY:
                    carouselRotateY,
                  rotateZ: 0,
                  scale:
                    carouselScale,
                  filter:
                    carouselFilter,
                }}
                transition={{
                  duration:
                    CAROUSEL_MOVE_SECONDS,
                  ease: [
                    0.22,
                    1,
                    0.36,
                    1,
                  ],
                }}
                whileHover={{
                  scale:
                    carouselScale *
                    1.025,
                  z:
                    carouselZ + 18,
                  opacity: 1,
                  filter:
                    'blur(0px) brightness(1.04)',
                }}
                whileTap={{
                  scale: 0.985,
                }}
                onClick={() => {
                  if (
                    isFocusedNode
                  ) {
                    goToNode(
                      child.id,
                    )
                    return
                  }

                  setFocusIndex(
                    (currentIndex) =>
                      currentIndex +
                      slot,
                  )
                }}
                onPointerEnter={() =>
                  setPreviewNodeId(
                    child.id,
                  )
                }
                onPointerLeave={() =>
                  setPreviewNodeId(
                    null,
                  )
                }
              >
                <span
                  className="tree-prototype-node-energy"
                  aria-hidden="true"
                />

                <span className="tree-prototype-node-eyebrow">
                  {child.eyebrow}
                </span>

                <strong>
                  {child.label}
                </strong>

                <span className="tree-prototype-node-description">
                  {child.description ||
                    'No description yet.'}
                </span>

                <span className="tree-prototype-node-meta">
                  <span>
                    {getCompletionPercent(
                      childStats,
                    )}
                    %
                  </span>
                  <span>
                    {
                      child.children
                        .length
                    }{' '}
                    paths
                  </span>
                </span>

                <span className="tree-prototype-node-enter">
                  {child.children
                    ?.length
                    ? `${child.children.length} PATHS`
                    : 'OPEN'}
                  <ChevronRight
                    size={13}
                    aria-hidden="true"
                  />
                </span>
              </motion.button>
            )
          },
        )}

        {children.length === 0 && (
          <div className="tree-prototype-leaf">
            <span>
              EXECUTION READY
            </span>
            <strong>
              Use the dock to add a child or open this node for execution.
            </strong>
          </div>
        )}
      </div>

      <aside className="tree-prototype-overview">
        <div className="tree-prototype-overview-title">
          <MapIcon
            size={12}
            strokeWidth={1.7}
            aria-hidden="true"
          />
          WORK

          <span className="tree-prototype-header-actions">
            <button
              type="button"
              className="tree-prototype-header-btn"
              onClick={() => setActivePopover('add')}
              aria-label="Add task under current selection"
              title="작업 추가 (선택한 프로젝트 아래)"
            >
              <Plus size={12} strokeWidth={2} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="tree-prototype-header-btn"
              onClick={() => ws.setSettingsOpen(true)}
              aria-label="Workspace settings"
              title="작업 공간(폴더) 연결 관리"
            >
              <Settings size={12} strokeWidth={2} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="tree-prototype-header-btn"
              onClick={requestDeleteCurrentNode}
              disabled={node.id === taskTree.root.id}
              aria-label="Delete current node"
              title="선택한 노드 삭제"
            >
              <Trash2 size={12} strokeWidth={2} aria-hidden="true" />
            </button>
          </span>

          <button
            type="button"
            className="tree-prototype-overview-expand"
            onClick={() =>
              setDialog('map')
            }
            aria-label="Open advanced system map"
            title="Advanced inspect"
          >
            <Maximize2
              size={11}
              aria-hidden="true"
            />
          </button>
        </div>

        <div className="tree-prototype-overview-search">
          <Search
            size={11}
            aria-hidden="true"
          />
          <input
            type="search"
            value={searchText}
            placeholder="Find node"
            onChange={(event) =>
              setSearchText(
                event.target.value,
              )
            }
            aria-label="Search tree nodes"
          />
        </div>

        <div className="tree-prototype-overview-list">
          <ContextSections
            currentProject={currentProject}
            currentWorkspace={currentWorkspace}
            currentTasks={currentTasks}
            focusLabel={focusLabel}
            visibleRows={visibleRows}
            currentNodeId={node.id}
            TreeMapRows={TreeMapRows}
            goToNode={goToNode}
            toggleExpanded={toggleExpanded}
            workRowAction={(rowNode) =>
              rowNode.type === 'task_resource' ? (
                <button
                  type="button"
                  className="tree-prototype-map-row-action"
                  aria-label={`Unlink ${rowNode.label}`}
                  title="Unlink resource"
                  disabled={unlinkBusy}
                  onClick={(event) => {
                    event.stopPropagation()
                    void unlinkCurrentTaskResource(rowNode.linkId)
                  }}
                >
                  <X size={11} strokeWidth={2} aria-hidden="true" />
                </button>
              ) : null
            }
            unlinkError={unlinkError}
            knowledgePages={knowledgePages}
            buildPageRows={buildPageRows}
            togglePageExpanded={togglePageExpanded}
            files={files}
            handleAddFolder={handleAddFolder}
            makeFileRow={makeFileRow}
            openFile={setFileEditor}
          />
        </div>
      </aside>

      {fileEditor && (
        <FileEditor
          file={fileEditor}
          readFile={files.readFile}
          writeFile={files.writeFile}
          onClose={closeFile}
        />
      )}


      <AnimatePresence>
        {/*
          UX 정리 — dock 제거 후 Add Task popover. drawer 헤더의 + 버튼이 연다.
          위치는 CSS(.v4-context-drawer .tree-prototype-popover)가 잡는다.
        */}
        {activePopover === 'add' && (
          <motion.form
            key="add-popover"
            className="tree-prototype-popover tree-prototype-add-form"
            initial={{ opacity: 0, y: 12, scale: 0.94 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.96 }}
            transition={{ type: 'spring', bounce: 0.08, duration: 0.18 }}
            onPointerDown={(event) => event.stopPropagation()}
            onSubmit={addChild}
          >
            <div className="tree-prototype-editor-title">
              <Plus size={12} strokeWidth={1.8} aria-hidden="true" />
              NEW TASK
            </div>

            <input
              type="text"
              value={addDraft.label}
              onChange={(event) => setAddDraft((current) => ({ ...current, label: event.target.value }))}
              placeholder="작업 제목"
              aria-label="New task title"
              autoFocus
            />

            <textarea
              value={addDraft.description}
              onChange={(event) => setAddDraft((current) => ({ ...current, description: event.target.value }))}
              placeholder="설명 (선택)"
              aria-label="New task description"
            />

            <div className="tree-prototype-editor-actions">
              <button type="submit" disabled={addBusy || !String(addDraft.label || '').trim()}>
                {addBusy ? '추가 중…' : 'ADD'}
              </button>
              <button type="button" onClick={() => setActivePopover(null)}>
                CANCEL
              </button>
              {addError && (
                <div className="tree-prototype-add-error" role="alert">
                  {addError}
                </div>
              )}
            </div>
          </motion.form>
        )}

        {dialog === 'delete' && (
          <motion.div
            className="tree-prototype-dialog-backdrop"
            initial={{
              opacity: 0,
            }}
            animate={{
              opacity: 1,
            }}
            exit={{
              opacity: 0,
            }}
          >
            <motion.div
              className="tree-prototype-dialog"
              initial={{
                opacity: 0,
                y: 18,
                scale: 0.96,
              }}
              animate={{
                opacity: 1,
                y: 0,
                scale: 1,
              }}
              exit={{
                opacity: 0,
                y: 10,
                scale: 0.97,
              }}
            >
              <div className="tree-prototype-dialog-title">
                Delete node
              </div>

              <p>
                {node.label} and its child paths will be removed.
              </p>

              {deleteError && (
                <div className="tree-prototype-add-error" role="alert">
                  {deleteError}
                </div>
              )}

              <div className="tree-prototype-dialog-actions">
                <button
                  type="button"
                  onClick={() =>
                    setDialog(null)
                  }
                >
                  CANCEL
                </button>

                <button
                  type="button"
                  className="is-danger"
                  onClick={
                    deleteCurrentNode
                  }
                  disabled={
                    deleteBusy
                  }
                >
                  {deleteBusy ? '처리 중…' : 'DELETE'}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}

        {dialog === 'map' && (
          <motion.div
            className="tree-prototype-dialog-backdrop"
            initial={{
              opacity: 0,
            }}
            animate={{
              opacity: 1,
            }}
            exit={{
              opacity: 0,
            }}
          >
            <motion.div
              className="tree-prototype-dialog tree-prototype-map-dialog"
              initial={{
                opacity: 0,
                y: 18,
                scale: 0.96,
              }}
              animate={{
                opacity: 1,
                y: 0,
                scale: 1,
              }}
              exit={{
                opacity: 0,
                y: 10,
                scale: 0.97,
              }}
            >
              <div className="tree-prototype-map-dialog-header">
                <div className="tree-prototype-dialog-title">
                  System map
                </div>

                <button
                  type="button"
                  onClick={() =>
                    setDialog(null)
                  }
                  aria-label="Close expanded system map"
                >
                  <X
                    size={14}
                    aria-hidden="true"
                  />
                </button>
              </div>

              <div className="tree-prototype-map-dialog-list">
                {visibleRows.length ===
                  0 && (
                  <div className="tree-prototype-overview-empty">
                    No matching nodes.
                  </div>
                )}

                <TreeMapRows
                  rows={visibleRows}
                  currentNodeId={node.id}
                  goToNode={(nodeId) => {
                    goToNode(nodeId)
                    setDialog(null)
                  }}
                  onToggleExpanded={
                    toggleExpanded
                  }
                />
              </div>
            </motion.div>
          </motion.div>
        )}

        {ws.settingsOpen && (
          <motion.div
            className="tree-prototype-dialog-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => ws.setSettingsOpen(false)}
          >
            <motion.div
              className="tree-prototype-dialog tree-prototype-settings-dialog"
              initial={{ opacity: 0, y: 18, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 10, scale: 0.97 }}
              onClick={(event) => event.stopPropagation()}
            >
              <div className="tree-prototype-map-dialog-header">
                <div className="tree-prototype-dialog-title">
                  <Settings size={13} strokeWidth={1.9} aria-hidden="true" /> Workspaces
                </div>
                <button type="button" onClick={() => ws.setSettingsOpen(false)} aria-label="Close settings">
                  <X size={14} aria-hidden="true" />
                </button>
              </div>

              <button
                type="button"
                className="tree-prototype-settings-add"
                disabled={ws.wsRootsBusy}
                onClick={handleAddFolder}
              >
                <FolderPlus size={12} strokeWidth={1.9} aria-hidden="true" />
                {ws.wsRootsBusy ? '처리 중…' : 'Add Folder…'}
              </button>

              {ws.wsRootsError && (
                <div className="tree-prototype-add-error" role="alert">
                  {ws.wsRootsError}
                </div>
              )}

              {ws.wsRoots.length === 0 && !ws.wsRootsError && (
                <div className="tree-prototype-overview-empty">등록된 Workspace가 없습니다. Add Folder로 추가하세요.</div>
              )}

              <div className="tree-prototype-settings-list">
                {ws.wsRoots.map((root) => (
                  <div key={root.id} className={['tree-prototype-settings-row', root.available === false ? 'is-unavailable' : ''].filter(Boolean).join(' ')}>
                    <div className="tree-prototype-settings-row-main">
                      <div className="tree-prototype-settings-root-id">
                        <Folder size={11} strokeWidth={1.8} aria-hidden="true" />
                        {root.id}
                        {root.available === false && <span className="tree-prototype-settings-badge">Unavailable on this device</span>}
                      </div>
                      {ws.editingRootId === root.id ? (
                        <div className="tree-prototype-settings-edit">
                          <input
                            type="text"
                            value={ws.editingName}
                            onChange={(event) => ws.setEditingName(event.target.value)}
                            placeholder="display name"
                            aria-label={`display name for ${root.id}`}
                            autoFocus
                          />
                          <button type="button" disabled={ws.wsRootsBusy || !ws.editingName.trim()} onClick={() => ws.handleRenameRoot(root.id)}>Save</button>
                          <button type="button" onClick={() => { ws.setEditingRootId(null); ws.setEditingName('') }}>Cancel</button>
                        </div>
                      ) : (
                        <div className="tree-prototype-settings-display">{root.display_name}</div>
                      )}
                      <div className="tree-prototype-settings-path" title={root.device_path}>
                        {root.device_path}
                      </div>
                    </div>
                    <div className="tree-prototype-settings-actions">
                      {ws.editingRootId !== root.id && (
                        <button
                          type="button"
                          disabled={ws.wsRootsBusy}
                          onClick={() => { ws.setEditingRootId(root.id); ws.setEditingName(root.display_name || '') }}
                        >
                          Rename
                        </button>
                      )}
                      <button type="button" disabled={ws.wsRootsBusy} onClick={() => handleReconnectRoot(root.id)} title="Locate Folder for this root_id">
                        <RefreshCw size={11} strokeWidth={1.9} aria-hidden="true" /> Locate
                      </button>
                      <button type="button" className="is-danger" disabled={ws.wsRootsBusy} onClick={() => handleRemoveRoot(root.id)} title="Remove registration (never deletes folder)">
                        Remove
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  )
}
