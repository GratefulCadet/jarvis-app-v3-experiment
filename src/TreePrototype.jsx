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
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  Crosshair,
  Folder,
  FolderPlus,
  Home,
  Link2,
  Map as MapIcon,
  Maximize2,
  Network,
  Pencil,
  Pin,
  PinOff,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react'

import useJarvisTree, {
  TASK_NODE_TYPES,
} from './useJarvisTree'

import useJarvisPages from './useJarvisPages'

import useJarvisFiles from './useJarvisFiles'

import useWorkspaceRoots from './useWorkspaceRoots'

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

const createDraft = (node) => ({
  nodeId: node.id,
  label: node.label,
  description: node.description,
  type: node.type,
})

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
  onOpenExecution,
  runtime,
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

  const [
    searchText,
    setSearchText,
  ] = useState('')

  const [
    pinnedNodeIds,
    setPinnedNodeIds,
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

  const [askText, setAskText] =
    useState('')

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

  const flatNodeMap = useMemo(
    () =>
      new Map(
        flatNodes.map((entry) => [
          entry.node.id,
          entry,
        ]),
      ),
    [flatNodes],
  )

  const pinnedNodes =
    pinnedNodeIds
      .map((nodeId) =>
        flatNodeMap.get(nodeId),
      )
      .filter(Boolean)

  const isCurrentPinned =
    pinnedNodeIds.includes(
      node.id,
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
    editDraftState,
    setEditDraft,
  ] = useState(() =>
    createDraft(node),
  )

  const editDraft =
    editDraftState.nodeId ===
    node.id
      ? editDraftState
      : createDraft(node)

  const [
    addDraft,
    setAddDraft,
  ] = useState(
    createAddDraft,
  )

  const [addError, setAddError] = useState(null)

  const [addBusy, setAddBusy] = useState(false)

  /* RESOURCE LINK V1 (PART I) — files 뷰 파일 노드 → Project 명시적 링크.
     사용자가 Project·relation을 직접 고른다. 실패 시 오류만 보이고 트리는
     그대로 — 성공 시 useJarvisTree.linkProjectFile이 canonical snapshot을
     다시 읽어 Project Resources에 나타난다. */
  const [linkDraft, setLinkDraft] = useState({
    fileId: null,
    fileLabel: '',
    projectId: '',
    relation: 'reference',
  })

  const [linkError, setLinkError] = useState(null)

  const [linkBusy, setLinkBusy] = useState(false)

  /* PROJECT PRIMARY WORKSPACE V1 — Project → 논리 WorkspaceRoot 관계. */
  const [wsDraft, setWsDraft] = useState({ rootId: '' })
  const [wsError, setWsError] = useState(null)
  const [wsBusy, setWsBusy] = useState(false)

  /* WORKSPACE REGISTRATION — extracted to useWorkspaceRoots hook */
  const ws = useWorkspaceRoots({ taskTree, files })

  const handleConnectFolder = async () => {
    if (wsBusy) return
    if (node.type !== 'project') {
      setWsError('Project 노드에서만 연결할 수 있습니다.')
      return
    }
    setWsBusy(true)
    setWsError(null)
    try {
      const picked = await taskTree.pickFolder()
      if (!picked || !picked.ok) {
        setWsError(picked?.error || '폴더 선택에 실패했습니다')
        return
      }
      if (picked.cancelled) return
      const result = await taskTree.connectProjectWorkspace({
        projectId: node.id,
        devicePath: picked.path,
      })
      if (!result || !result.ok) {
        setWsError(result?.error || '프로젝트 연결에 실패했습니다')
        return
      }
      const refreshResult = await files.refresh()
      if (refreshResult && !refreshResult.ok) {
        setWsError('프로젝트 연결은 완료되었으나 파일 뷰 새로고침에 실패했습니다. 새로고침 버튼을 눌러주세요.')
      }
      setWsDraft({ rootId: '' })
      setActivePopover(null)
    } catch (exception) {
      setWsError(String(exception?.message || exception))
    } finally {
      setWsBusy(false)
    }
  }

  const handleAddFolder = ws.handleAddFolder
  const handleReconnectRoot = ws.handleReconnectRoot
  const handleRemoveRoot = ws.handleRemoveRoot

  const openLinkPopover = (fileId, fileLabel) => {
    setLinkDraft({
      fileId,
      fileLabel: fileLabel || '',
      projectId: '',
      relation: 'reference',
    })
    setLinkError(null)
    setActivePopover('link')
  }

  const [toggleError, setToggleError] = useState(null)

  const [toggleBusy, setToggleBusy] = useState(false)

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

  const updateEditDraft = (
    patch,
  ) => {
    setEditDraft(
      (draft) => ({
        ...(draft.nodeId ===
        node.id
          ? draft
          : createDraft(node)),
        ...patch,
      }),
    )
  }

  const saveCurrentNode = (
    event,
  ) => {
    event.preventDefault()

    taskTree.updateNode(
      node.id,
      editDraft,
    )

    setActivePopover(null)
  }

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
  const linkCurrentFile = async (event) => {
    event.preventDefault()

    if (linkBusy) return

    if (!linkDraft.fileId) {
      setLinkError('stable FileRef identity가 없어 링크할 수 없습니다.')
      return
    }

    const projectId = typeof linkDraft.projectId === 'string'
      ? linkDraft.projectId.trim()
      : ''
    if (!projectId) {
      setLinkError('프로젝트를 선택하세요.')
      return
    }

    setLinkBusy(true)
    setLinkError(null)

    try {
      const result = await taskTree.linkProjectFile({
        projectId,
        fileId: linkDraft.fileId,
        relation: linkDraft.relation,
      })

      if (!result || !result.ok) {
        setLinkError(result?.error || '링크 생성에 실패했습니다')
        return
      }

      setLinkDraft({ projectId: '', relation: 'reference' })
      setActivePopover(null)
    } catch (exception) {
      setLinkError(String(exception?.message || exception))
    } finally {
      setLinkBusy(false)
    }
  }

  /* PROJECT PRIMARY WORKSPACE V1 — Project 노드의 명시적 workspace 설정.
     canonical write 후 snapshot 재조회가 Workspace 노드를 갱신한다.
     Workspace 노드에서는 해제(clear)도 가능하다 — 메타데이터만 제거. */
  const saveWorkspace = async (event) => {
    event.preventDefault()

    if (wsBusy) return

    if (node.type !== 'project') {
      setWsError('Project 노드에서만 설정할 수 있습니다.')
      return
    }

    const rootId = typeof wsDraft.rootId === 'string' ? wsDraft.rootId.trim() : ''
    if (!rootId) {
      setWsError('workspace 루트를 선택하세요.')
      return
    }

    setWsBusy(true)
    setWsError(null)

    try {
      const result = await taskTree.setProjectWorkspace({
        projectId: node.id,
        rootId,
      })

      if (!result || !result.ok) {
        setWsError(result?.error || 'workspace 설정에 실패했습니다')
        return
      }

      setWsDraft({ rootId: '' })
      setActivePopover(null)
    } catch (exception) {
      setWsError(String(exception?.message || exception))
    } finally {
      setWsBusy(false)
    }
  }

  const clearWorkspace = async () => {
    if (wsBusy) return
    if (node.type !== 'project') return

    setWsBusy(true)
    setWsError(null)

    try {
      const result = await taskTree.clearProjectWorkspace({ projectId: node.id })
      if (!result || !result.ok) {
        setWsError(result?.error || 'workspace 해제에 실패했습니다')
        return
      }
      setWsDraft({ rootId: '' })
      setActivePopover(null)
    } catch (exception) {
      setWsError(String(exception?.message || exception))
    } finally {
      setWsBusy(false)
    }
  }

  const deleteCurrentNode = () => {
    const nextNodeId =
      taskTree.deleteNode(
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

  const toggleCurrentPin = () => {
    setPinnedNodeIds(
      (nodeIds) => {
        if (
          nodeIds.includes(
            node.id,
          )
        ) {
          return nodeIds.filter(
            (nodeId) =>
              nodeId !== node.id,
          )
        }

        return [
          node.id,
          ...nodeIds,
        ].slice(0, 6)
      },
    )
  }

  const executeCurrentNode = () => {
    onOpenExecution({
      node,
      path,
    })
  }

  /*
    Dock의 Ask JARVIS — execution이 아니어도 AI 입력을 받는다.
    Permission Gate가 걸리면 App이 자동으로 PiP 승인 화면으로 전환한다.
  */
  const askBusy =
    runtime?.status === 'thinking' ||
    runtime?.status === 'tool-running' ||
    runtime?.status ===
      'awaiting-confirmation'

  const handleAskSubmit = (
    event,
  ) => {
    event.preventDefault()

    if (!runtime) {
      return
    }

    const trimmed =
      askText.trim()

    if (!trimmed || askBusy) {
      return
    }

    runtime.submit(
      trimmed,
      runtime.projectId,
    )

    setAskText('')
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
      aria-label="JARVIS System Home"
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
          SYSTEM HOME
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
          SYSTEM MAP

          <button
            type="button"
            className="tree-prototype-overview-expand"
            onClick={() =>
              setDialog('map')
            }
            aria-label="Open expanded system map"
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
          {visibleRows.length ===
            0 && (
            <div className="tree-prototype-overview-empty">
              No matching nodes.
            </div>
          )}

          <TreeMapRows
            rows={visibleRows}
            currentNodeId={node.id}
            goToNode={goToNode}
            onToggleExpanded={
              toggleExpanded
            }
          />

          {knowledgePages.status ===
            'loading' && (
            <div className="tree-prototype-knowledge-status">
              Knowledge 불러오는 중…
            </div>
          )}

          {knowledgePages.status ===
            'error' && (
            <div className="tree-prototype-knowledge-status is-error">
              {knowledgePages.error ||
                'Knowledge를 불러오지 못했습니다'}
            </div>
          )}

          {knowledgePages.status ===
            'ready' && (
            <div className="tree-prototype-overview-knowledge">
              <div className="tree-prototype-knowledge-title">
                KNOWLEDGE
                {knowledgePages.scratch && (
                  <span className="tree-prototype-knowledge-scratch">
                    SCRATCH
                  </span>
                )}
              </div>

              {knowledgePages.pages.length ===
                0 ? (
                <div className="tree-prototype-knowledge-status">
                  페이지 없음
                </div>
              ) : (
                <TreeMapRows
                  rows={knowledgePages.pages.flatMap(
                    (page) =>
                      buildPageRows(
                        page,
                        0,
                      ),
                  )}
                  currentNodeId={null}
                  goToNode={
                    togglePageExpanded
                  }
                  onToggleExpanded={
                    togglePageExpanded
                  }
                />
              )}
            </div>
          )}

          {files.status === 'error' && (
            <div className="tree-prototype-overview-knowledge">
              <div className="tree-prototype-knowledge-title">
                FILES
              </div>
              <div className="tree-prototype-add-error" role="alert">
                파일 뷰 새로고침 실패: {files.error || '알 수 없는 오류'}
              </div>
              <button
                type="button"
                className="tree-prototype-settings-add"
                onClick={() => files.refresh()}
              >
                <RefreshCw size={11} strokeWidth={1.9} aria-hidden="true" />
                다시 시도
              </button>
            </div>
          )}

          {files.status === 'ready' &&
            files.roots.length === 0 && (
            <div className="tree-prototype-overview-knowledge">
              <div className="tree-prototype-knowledge-title">
                FILES
              </div>
              <div className="tree-prototype-overview-empty">
                연결된 폴더가 없습니다.
              </div>
              <button
                type="button"
                className="tree-prototype-settings-add"
                onClick={handleAddFolder}
              >
                <FolderPlus size={11} strokeWidth={1.9} aria-hidden="true" />
                Add Folder…
              </button>
            </div>
          )}

          {files.status === 'ready' &&
            files.roots.length > 0 && (
            <div className="tree-prototype-overview-knowledge">
              <div className="tree-prototype-knowledge-title">
                FILES
              </div>

              <TreeMapRows
                rows={files.sections.flatMap(
                  (section) =>
                    section.entries.map(
                      makeFileRow,
                    ),
                )}
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
                      <Link2
                        size={11}
                        strokeWidth={2}
                        aria-hidden="true"
                      />
                    </button>
                  ) : null
                }
              />
            </div>
          )}
        </div>
      </aside>

      <nav
        className="tree-prototype-dock"
        aria-label="JARVIS tree actions"
        ref={popoverRef}
      >
        <button
          type="button"
          aria-label="Go to system home"
          onClick={() =>
            goToNode(
              taskTree.root.id,
            )
          }
        >
          <Home
            size={21}
            aria-hidden="true"
          />
          <span>Home</span>
        </button>

        <button
          type="button"
          aria-label="Go to parent"
          disabled={!parent}
          onClick={() =>
            parent &&
            goToNode(
              parent.id,
            )
          }
        >
          <ArrowLeft
            size={21}
            aria-hidden="true"
          />
          <span>Back</span>
        </button>

        <button
          type="button"
          aria-label="Edit current node"
          className={
            activePopover === 'edit'
              ? 'is-active'
              : ''
          }
          onClick={(event) => {
            event.stopPropagation()

            setActivePopover(
              activePopover === 'edit'
                ? null
                : 'edit',
            )
          }}
        >
          <Pencil
            size={21}
            aria-hidden="true"
          />
          <span>Edit</span>
        </button>

        <button
          type="button"
          aria-label="Add child node"
          className={
            activePopover === 'add'
              ? 'is-active'
              : ''
          }
          onClick={(event) => {
            event.stopPropagation()

            setActivePopover(
              activePopover === 'add'
                ? null
                : 'add',
            )
          }}
        >
          <Plus
            size={21}
            aria-hidden="true"
          />
          <span>Add</span>
        </button>

        <button
          type="button"
          aria-label={
            isCurrentPinned
              ? 'Unpin current node'
              : 'Pin current node'
          }
          className={
            isCurrentPinned
              ? 'is-active'
              : ''
          }
          onClick={
            toggleCurrentPin
          }
        >
          {isCurrentPinned ? (
            <PinOff
              size={21}
              aria-hidden="true"
            />
          ) : (
            <Pin
              size={21}
              aria-hidden="true"
            />
          )}

          <span>
            {isCurrentPinned
              ? 'Unpin'
              : 'Pin'}
          </span>
        </button>

        <button
          type="button"
          aria-label="Link current file to project"
          className={
            activePopover === 'link'
              ? 'is-active'
              : ''
          }
          onClick={(event) => {
            event.stopPropagation()

            if (activePopover === 'link') {
              setActivePopover(null)
              return
            }

            // files 뷰의 파일 행에서 열린 초대 플로우 — fileId가 이미 채워져 있다.
            // 그 외 위치에서의 수동 실행은 초대 상태를 리셋한다(placeholder 표시).
            if (node.type === 'file' && node.fileId) {
              openLinkPopover(node.fileId, node.label)
            } else {
              setLinkDraft({
                fileId: null,
                fileLabel: '',
                projectId: '',
                relation: 'reference',
              })
              setLinkError('FILES 뷰에서 파일 행의 링크 버튼을 먼저 눌러주세요.')
              setActivePopover('link')
            }
          }}
        >
          <Link2
            size={21}
            aria-hidden="true"
          />
          <span>Link</span>
        </button>

        <button
          type="button"
          aria-label="Set primary workspace"
          className={
            activePopover === 'workspace'
              ? 'is-active'
              : ''
          }
          disabled={node.type !== 'project'}
          onClick={(event) => {
            event.stopPropagation()
            const currentWs =
              node.type === 'project'
                ? (node.children || []).find(
                    (child) => child.type === 'workspace_group',
                  )
                : null
            const currentRoot = currentWs?.children?.[0]?.rootId || ''
            setWsDraft({ rootId: currentRoot })
            setWsError(null)
            setActivePopover(
              activePopover === 'workspace'
                ? null
                : 'workspace',
            )
          }}
        >
          <MapIcon size={21} aria-hidden="true" />
          <span>WS</span>
        </button>

        <button
          type="button"
          aria-label="Workspace settings"
          className={ws.settingsOpen ? 'is-active' : ''}
          onClick={(event) => {
            event.stopPropagation()
            ws.setSettingsOpen((prev) => !prev)
          }}
        >
          <Settings size={21} aria-hidden="true" />
          <span>Settings</span>
        </button>

        <button
          type="button"
          aria-label="Search system map"
          className={
            activePopover ===
            'search'
              ? 'is-active'
              : ''
          }
          onClick={(event) => {
            event.stopPropagation()

            setActivePopover(
              activePopover ===
              'search'
                ? null
                : 'search',
            )
          }}
        >
          <Search
            size={21}
            aria-hidden="true"
          />
          <span>Search</span>
        </button>

        <button
          type="button"
          aria-label="Ask JARVIS"
          className={
            activePopover === 'ask'
              ? 'is-active'
              : ''
          }
          onClick={(event) => {
            event.stopPropagation()

            setActivePopover(
              activePopover === 'ask'
                ? null
                : 'ask',
            )
          }}
        >
          <Sparkles
            size={21}
            aria-hidden="true"
          />
          <span>Ask</span>
        </button>

        <button
          type="button"
          aria-label="Open execution"
          onClick={
            executeCurrentNode
          }
        >
          <Play
            size={21}
            fill="currentColor"
            aria-hidden="true"
          />
          <span>Run</span>
        </button>

        {pinnedNodes.map(
          (entry) => (
            <button
              type="button"
              key={entry.node.id}
              aria-label={`Open ${entry.node.label}`}
              className={
                path.some(
                  (pathNode) =>
                    pathNode.id ===
                    entry.node.id,
                )
                  ? 'is-active'
                  : ''
              }
              onClick={() =>
                goToNode(
                  entry.node.id,
                )
              }
            >
              <Crosshair
                size={21}
                aria-hidden="true"
              />
              <span>
                {
                  entry.node
                    .label
                }
              </span>
            </button>
          ),
        )}

        <AnimatePresence>
          {activePopover ===
            'search' && (
            <motion.div
              key="search-popover"
              className="tree-prototype-popover tree-prototype-dock-search"
              initial={{
                opacity: 0,
                y: 12,
                scale: 0.94,
              }}
              animate={{
                opacity: 1,
                y: 0,
                scale: 1,
              }}
              exit={{
                opacity: 0,
                y: 10,
                scale: 0.96,
              }}
              transition={{
                type: 'spring',
                bounce: 0.08,
                duration: 0.18,
              }}
              onPointerDown={(
                event,
              ) =>
                event.stopPropagation()
              }
            >
              <Search
                size={13}
                aria-hidden="true"
              />
              <input
                type="search"
                value={
                  searchText
                }
                placeholder="Search node"
                onChange={(
                  event,
                ) =>
                  setSearchText(
                    event.target
                      .value,
                  )
                }
                aria-label="Search tree nodes from dock"
                autoFocus
              />
            </motion.div>
          )}

          {activePopover ===
            'ask' && (
            <motion.form
              key="ask-popover"
              className="tree-prototype-popover tree-prototype-ask-form"
              initial={{
                opacity: 0,
                y: 12,
                scale: 0.94,
              }}
              animate={{
                opacity: 1,
                y: 0,
                scale: 1,
              }}
              exit={{
                opacity: 0,
                y: 10,
                scale: 0.96,
              }}
              transition={{
                type: 'spring',
                bounce: 0.08,
                duration: 0.18,
              }}
              onPointerDown={(
                event,
              ) =>
                event.stopPropagation()
              }
              onSubmit={handleAskSubmit}
            >
              <div className="tree-prototype-editor-title">
                <Sparkles
                  size={12}
                  strokeWidth={1.8}
                  aria-hidden="true"
                />
                ASK JARVIS
              </div>

              <input
                type="text"
                value={askText}
                placeholder="무엇이든 물어보세요…"
                onChange={(event) =>
                  setAskText(
                    event.target.value,
                  )
                }
                aria-label="Ask JARVIS from dock"
                disabled={askBusy}
                autoFocus
              />

              <div className="tree-prototype-ask-row">
                <button
                  type="submit"
                  disabled={
                    !askText.trim() ||
                    askBusy
                  }
                >
                  ASK
                </button>
              </div>

              {askBusy && (
                <div className="tree-prototype-ask-status">
                  {runtime?.status ===
                  'tool-running'
                    ? '승인된 작업 실행 중…'
                    : runtime?.status ===
                        'awaiting-confirmation'
                      ? '승인이 필요합니다 — PiP에서 확인하세요'
                      : 'Thinking…'}
                </div>
              )}

              {!askBusy &&
                runtime?.status ===
                  'done' &&
                runtime.text && (
                <div className="tree-prototype-ask-answer">
                  {runtime.text}
                </div>
              )}

              {!askBusy &&
                runtime?.status ===
                  'error' && (
                <div className="tree-prototype-ask-error">
                  {runtime.error ||
                    '오류가 발생했습니다'}
                </div>
              )}
            </motion.form>
          )}

          {activePopover ===
            'edit' && (
            <motion.form
              key="edit-popover"
              className="tree-prototype-popover tree-prototype-edit-form"
              initial={{
                opacity: 0,
                y: 12,
                scale: 0.94,
              }}
              animate={{
                opacity: 1,
                y: 0,
                scale: 1,
              }}
              exit={{
                opacity: 0,
                y: 10,
                scale: 0.96,
              }}
              transition={{
                type: 'spring',
                bounce: 0.08,
                duration: 0.03,
              }}
              onSubmit={
                saveCurrentNode
              }
            >
              <div className="tree-prototype-editor-title">
                <Pencil
                  size={12}
                  strokeWidth={1.8}
                  aria-hidden="true"
                />
                CURRENT NODE
              </div>

              <input
                type="text"
                value={
                  editDraft.label
                }
                onChange={(
                  event,
                ) =>
                  updateEditDraft({
                    label:
                      event.target
                        .value,
                  })
                }
                aria-label="Current node title"
              />

              <textarea
                value={
                  editDraft.description
                }
                onChange={(
                  event,
                ) =>
                  updateEditDraft({
                    description:
                      event.target
                        .value,
                  })
                }
                aria-label="Current node description"
              />

              <select
                value={
                  editDraft.type
                }
                onChange={(
                  event,
                ) =>
                  updateEditDraft({
                    type:
                      event.target
                        .value,
                  })
                }
                aria-label="Current node type"
              >
                {TASK_NODE_TYPES.map(
                  (type) => (
                    <option
                      key={type}
                      value={type}
                    >
                      {type}
                    </option>
                  ),
                )}
              </select>

              <div className="tree-prototype-editor-actions">
                <button type="submit">
                  SAVE
                </button>

                <button
                  type="button"
                  disabled={toggleBusy}
                  onClick={async () => {
                    if (toggleBusy) return
                    setToggleBusy(true)
                    setToggleError(null)
                    try {
                      const result = await taskTree.toggleComplete(node.id)
                      if (!result || !result.ok) {
                        setToggleError(result?.error || 'Task 상태 변경에 실패했습니다')
                      }
                    } catch (exception) {
                      setToggleError(String(exception?.message || exception))
                    } finally {
                      setToggleBusy(false)
                    }
                  }}
                >
                  {toggleBusy ? (
                    <Circle
                      size={12}
                      aria-hidden="true"
                    />
                  ) : node.complete ? (
                    <Check
                      size={12}
                      aria-hidden="true"
                    />
                  ) : (
                    <Circle
                      size={12}
                      aria-hidden="true"
                    />
                  )}

                  {toggleBusy ? '처리 중…' : node.complete ? 'DONE' : 'MARK'}
                </button>

                <button
                  type="button"
                  onClick={
                    requestDeleteCurrentNode
                  }
                  disabled={
                    node.id ===
                    taskTree.root.id
                  }
                >
                  <Trash2
                    size={12}
                    aria-hidden="true"
                  />
                  DELETE
                </button>
              </div>

              {toggleError && (
                <div className="tree-prototype-add-error" role="alert">
                  {toggleError}
                </div>
              )}
            </motion.form>
          )}

          {activePopover ===
            'add' && (
            <motion.form
              key="add-popover"
              className="tree-prototype-popover tree-prototype-add-form"
              initial={{
                opacity: 0,
                y: 12,
                scale: 0.94,
              }}
              animate={{
                opacity: 1,
                y: 0,
                scale: 1,
              }}
              exit={{
                opacity: 0,
                y: 10,
                scale: 0.96,
              }}
              transition={{
                type: 'spring',
                bounce: 0.08,
                duration: 0.03,
              }}
              onSubmit={addChild}
            >
              <div className="tree-prototype-editor-title">
                <Plus
                  size={12}
                  strokeWidth={1.8}
                  aria-hidden="true"
                />
                ADD CHILD
              </div>

              <input
                type="text"
                value={
                  addDraft.label
                }
                placeholder="New task or sub-goal"
                onChange={(
                  event,
                ) =>
                  setAddDraft(
                    (draft) => ({
                      ...draft,
                      label:
                        event.target
                          .value,
                    }),
                  )
                }
                aria-label="New child title"
              />

              <textarea
                value={
                  addDraft.description
                }
                placeholder="Why this node matters"
                onChange={(
                  event,
                ) =>
                  setAddDraft(
                    (draft) => ({
                      ...draft,
                      description:
                        event.target
                          .value,
                    }),
                  )
                }
                aria-label="New child description"
              />

              <div className="tree-prototype-add-row">
                <select
                  value={
                    addDraft.type
                  }
                  onChange={(
                    event,
                  ) =>
                    setAddDraft(
                      (draft) => ({
                        ...draft,
                        type:
                          event.target
                            .value,
                      }),
                    )
                  }
                  aria-label="New child type"
                >
                  {TASK_NODE_TYPES.map(
                    (type) => (
                      <option
                        key={
                          type
                        }
                        value={
                          type
                        }
                      >
                        {type}
                      </option>
                    ),
                  )}
                </select>

                <button type="submit" disabled={addBusy}>
                  {addBusy ? '저장 중…' : 'ADD'}
                </button>
              </div>

              {addError && (
                <div className="tree-prototype-add-error" role="alert">
                  {addError}
                </div>
              )}
            </motion.form>
          )}

          {/* RESOURCE LINK V1 — 파일 → Project 명시적 링크 (PART I).
              사용자가 Project·relation을 직접 고른다. canonical write는
              ProjectResources가 하고, 성공 시 snapshot 재조회로 UI 갱신. */}
          {activePopover === 'link' && (
            <motion.form
              key="link-popover"
              className="tree-prototype-popover tree-prototype-add-form"
              initial={{
                opacity: 0,
                y: 12,
                scale: 0.94,
              }}
              animate={{
                opacity: 1,
                y: 0,
                scale: 1,
              }}
              exit={{
                opacity: 0,
                y: 10,
                scale: 0.96,
              }}
              transition={{
                type: 'spring',
                bounce: 0.08,
                duration: 0.03,
              }}
              onSubmit={linkCurrentFile}
            >
              <div className="tree-prototype-editor-title">
                <Link2
                  size={12}
                  strokeWidth={1.8}
                  aria-hidden="true"
                />
                LINK TO PROJECT
              </div>

              <div className="tree-prototype-link-file">
                {linkDraft.fileId
                  ? linkDraft.fileLabel || linkDraft.fileId
                  : 'FILES 뷰에서 파일 행의 링크 버튼을 먼저 눌러주세요.'}
              </div>

              <select
                value={linkDraft.projectId}
                onChange={(event) =>
                  setLinkDraft(
                    (draft) => ({
                      ...draft,
                      projectId: event.target.value,
                    }),
                  )
                }
                aria-label="Target project"
              >
                <option value="">프로젝트 선택…</option>
                {(taskTree.root.children || [])
                  .filter((child) => child.type === 'project')
                  .map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.label}
                    </option>
                  ))}
              </select>

              <select
                value={linkDraft.relation}
                onChange={(event) =>
                  setLinkDraft(
                    (draft) => ({
                      ...draft,
                      relation: event.target.value,
                    }),
                  )
                }
                aria-label="Relation"
              >
                <option value="reference">reference — 참조</option>
                <option value="source">source — 출처</option>
                <option value="result">result — 결과물</option>
                <option value="resource">resource — 자원</option>
              </select>

              <div className="tree-prototype-editor-actions">
                <button
                  type="submit"
                  disabled={
                    linkBusy ||
                    !linkDraft.fileId ||
                    !linkDraft.projectId.trim()
                  }
                >
                  {linkBusy ? '연결 중…' : 'LINK'}
                </button>
              </div>

              {linkError && (
                <div className="tree-prototype-add-error" role="alert">
                  {linkError}
                </div>
              )}
            </motion.form>
          )}

          {/* PROJECT PRIMARY WORKSPACE V1 — Project → 논리 root 관계 설정.
              기존 루트 선택(SET/CLEAR) + one-gesture Connect Folder(피커→register/reuse+set).
              Connect는 files.roots에 없어도 동작한다 — Harness가 등록까지 겸한다. */}
          {activePopover === 'workspace' && (
            <motion.form
              key="workspace-popover"
              className="tree-prototype-popover tree-prototype-add-form"
              initial={{
                opacity: 0,
                y: 12,
                scale: 0.94,
              }}
              animate={{
                opacity: 1,
                y: 0,
                scale: 1,
              }}
              exit={{
                opacity: 0,
                y: 10,
                scale: 0.96,
              }}
              transition={{
                type: 'spring',
                bounce: 0.08,
                duration: 0.03,
              }}
              onSubmit={saveWorkspace}
            >
              <div className="tree-prototype-editor-title">
                <MapIcon
                  size={12}
                  strokeWidth={1.8}
                  aria-hidden="true"
                />
                PRIMARY WORKSPACE
              </div>

              {node.type === 'project' ? (
                <>
                  <button
                    type="button"
                    className="tree-prototype-connect-folder"
                    disabled={wsBusy}
                    onClick={handleConnectFolder}
                  >
                    <FolderPlus size={12} strokeWidth={1.9} aria-hidden="true" />
                    {wsBusy ? '처리 중…' : 'Connect Folder…'}
                  </button>

                  {files.roots.length > 0 && (
                    <>
                      <div className="tree-prototype-popover-divider" />
                      <select
                        value={wsDraft.rootId}
                        onChange={(event) =>
                          setWsDraft((draft) => ({
                            ...draft,
                            rootId: event.target.value,
                          }))
                        }
                        aria-label="Primary workspace root"
                      >
                        <option value="">기존 루트 선택…</option>
                        {files.roots.map((rootName) => (
                          <option key={rootName} value={rootName}>
                            {rootName}
                          </option>
                        ))}
                      </select>
                      <div className="tree-prototype-editor-actions">
                        <button type="submit" disabled={wsBusy || !wsDraft.rootId.trim()}>
                          {wsBusy ? '처리 중…' : 'SET'}
                        </button>
                        <button type="button" disabled={wsBusy} onClick={clearWorkspace}>
                          CLEAR
                        </button>
                      </div>
                    </>
                  )}

                  {files.roots.length === 0 && (
                    <div className="tree-prototype-connect-hint">
                      아직 등록된 Workspace가 없습니다. Connect Folder로 추가하세요.
                    </div>
                  )}

                  {!files.roots.length && (
                    <div className="tree-prototype-editor-actions">
                      <button type="button" disabled={wsBusy} onClick={clearWorkspace}>
                        CLEAR
                      </button>
                    </div>
                  )}
                </>
              ) : (
                <div className="tree-prototype-connect-hint">Project 노드에서만 설정할 수 있습니다.</div>
              )}

              {wsError && (
                <div className="tree-prototype-add-error" role="alert">
                  {wsError}
                </div>
              )}
            </motion.form>
          )}
        </AnimatePresence>
      </nav>

      <AnimatePresence>
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
                >
                  DELETE
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
