import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react'

/*
  실제 JARVIS state → SYSTEM MAP read adapter (데이터 모델 수렴).

  원천: Harness bridge의 read-only `tree_snapshot` (single source of truth =
  JARVIS memory projects.md + tasks.md). 이 훅은 별도 저장소가 아니라
  그 스냅샷을 TreePrototype node shape으로 매핑하는 read adapter다.

  - root.children  = Projects   (type: 'project', id = project slug)
  - project.children = Tasks    (type: 'task',   id = t-xxx)
  - task.complete  = done 여부   (status: done | open)

  Write 수렴: Add Task + Complete/Reopen canonical TaskStore 경로로 연결.
  Edit/Delete는 아직 renderer-local (후속 마일스톤 대상).

  현재 실제 JARVIS 데이터에는 Goal / Next Action 계층이 없다 — Project → Task만
  존재하므로, 트리는 root("JARVIS") → Project → Task 구조를 쓴다.
*/

export const TASK_NODE_TYPES = Object.freeze([
  'goal',
  'project',
  'task',
  'step',
])

const PLACEHOLDER_ROOT = Object.freeze({
  id: 'jarvis-loading',
  label: 'JARVIS',
  eyebrow: 'SYSTEM HOME',
  description: '불러오는 중…',
  type: 'root',
  complete: false,
  children: [],
})

const makeTaskNode = (task) => ({
  id: task.id,
  label: task.title || task.id,
  eyebrow: 'TASK',
  description: task.reason || '',
  type: 'task',
  complete: task.status === 'done',
  children: [],
})

/*
  RESOURCE LINK V1 — Project Resources (semantic projection).

  tree_snapshot의 resource_group → project_resource 하위를 그대로 매핑한다.
  각 파일 노드는 bridge에서 채운 file 필드에 stable FileRef identity(f-*)를
  실는다 — FILES 물리 뷰와 같은 canonical entity의 다른 뷰(§2)다. 렌더러가
  링크를 만들거나 복제하지 않는다 — persisted ResourceLink만 보인다.
*/
const makeResourceFileNode = (fileNode) => ({
  id: fileNode.id,
  label: fileNode.title || fileNode.id,
  eyebrow: 'FILE',
  description:
    fileNode.file?.relative_path || fileNode.file?.id || '',
  type: 'project_resource',
  complete: false,
  fileId: fileNode.file?.id || null,
  filePath: fileNode.file?.relative_path || null,
  fileStatus: fileNode.file?.status || 'ok',
  linkId: fileNode.link_id || null,
  children: [],
})

const makeResourceGroupNode = (group) => ({
  id: group.id,
  label: group.title || group.id,
  eyebrow: 'RESOURCES',
  description: '',
  type: 'resource_group',
  complete: false,
  children: (group.children || []).map(makeResourceFileNode),
})

/*
  PROJECT PRIMARY WORKSPACE V1 — Project 아래 semantic Workspace 노드.

  WorkspaceRoot를 논리 root_id로 참조하는 projection일 뿐 중복 Project가
  아니다(§4). available:false여도 노드는 유지한다 — 관계는 남아 있고 이
  디바이스에서만 물리 경로가 없다는 뜻이다(PART D).
*/
const makeWorkspaceNode = (wsNode) => ({
  id: wsNode.id,
  label: wsNode.title || wsNode.root_id || wsNode.id,
  eyebrow: 'WORKSPACE',
  description:
    wsNode.available
      ? 'primary workspace — 사용 가능'
      : `primary workspace — 이 디바이스에서 사용 불가${wsNode.reason ? ` (${wsNode.reason})` : ''}`,
  type: 'project_workspace',
  complete: false,
  rootId: wsNode.root_id || null,
  available: Boolean(wsNode.available),
  children: [],
})

const makeWorkspaceGroupNode = (group) => ({
  id: group.id,
  label: group.title || group.id,
  eyebrow: 'WORKSPACE',
  description: '',
  type: 'workspace_group',
  complete: false,
  children: (group.children || []).map(makeWorkspaceNode),
})

const makeProjectNode = (project) => ({
  id: project.id,
  label: project.title || project.id,
  eyebrow: 'PROJECT',
  description: project.title ? project.id : '',
  type: 'project',
  complete: false,
  children: (project.children || []).map((child) => {
    if (child.type === 'resource_group') return makeResourceGroupNode(child)
    if (child.type === 'workspace_group') return makeWorkspaceGroupNode(child)
    return makeTaskNode(child)
  }),
})

const buildRoot = (tree) => ({
  id: 'jarvis-root',
  label: 'JARVIS',
  eyebrow: 'SYSTEM HOME',
  description:
    '실제 JARVIS 상태 — Projects → Tasks',
  type: 'root',
  complete: false,
  children: (tree || []).map(makeProjectNode),
})

const findNodeAndPath = (
  node,
  targetId,
  path = [],
) => {
  const nextPath = [...path, node]

  if (node.id === targetId) {
    return { node, path: nextPath }
  }

  for (const child of node.children ?? []) {
    const result = findNodeAndPath(
      child,
      targetId,
      nextPath,
    )
    if (result) return result
  }

  return null
}

const collectStats = (node) => {
  const childStats = node.children.map(collectStats)
  const total =
    1 +
    childStats.reduce(
      (sum, stats) => sum + stats.total,
      0,
    )
  const completed =
    (node.complete ? 1 : 0) +
    childStats.reduce(
      (sum, stats) => sum + stats.completed,
      0,
    )
  const leafCount =
    node.children.length === 0
      ? 1
      : childStats.reduce(
          (sum, stats) => sum + stats.leafCount,
          0,
        )
  return { total, completed, leafCount }
}

const updateNodeById = (node, targetId, updater) => {
  if (node.id === targetId) return updater(node)
  return {
    ...node,
    children: node.children.map((child) =>
      updateNodeById(child, targetId, updater),
    ),
  }
}

const removeNodeById = (node, targetId) => ({
  ...node,
  children: node.children
    .filter((child) => child.id !== targetId)
    .map((child) => removeNodeById(child, targetId)),
})

const makeId = () =>
  `local-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 9)}`

export default function useJarvisTree() {
  const [root, setRoot] = useState(PLACEHOLDER_ROOT)
  const [status, setStatus] = useState(() =>
    typeof window !== 'undefined' &&
    window.jarvisTree
      ? 'loading'
      : 'error',
  )
  const [error, setError] = useState(() =>
    typeof window !== 'undefined' &&
    window.jarvisTree
      ? null
      : 'jarvisTree API 없음 — Electron에서 실행 중인지 확인하세요.',
  )

  const fetchSnapshot = useCallback(async () => {
    const api = window.jarvisTree
    if (!api?.getSnapshot) {
      setStatus('error')
      setError('jarvisTree API 없음 — Electron에서 실행 중인지 확인하세요.')
      return { ok: false, error: 'jarvisTree API 없음' }
    }
    try {
      const response = await api.getSnapshot()
      if (
        response?.status === 'ok' &&
        Array.isArray(response.tree)
      ) {
        setRoot(buildRoot(response.tree))
        setStatus('ready')
        setError(null)
        return { ok: true, tree: response.tree }
      }
      setStatus('error')
      setError(
        (response && response.error) ||
          '트리 스냅샷을 불러오지 못했습니다.',
      )
      return { ok: false, error: response?.error || '트리 스냅샷 실패' }
    } catch (exception) {
      const message = String(
        (exception &&
          exception.message) ||
          exception,
      )
      setStatus('error')
      setError(message)
      return { ok: false, error: message }
    }
  }, [])

  useEffect(() => {
    const api = window.jarvisTree
    if (!api) return undefined

    let cancelled = false

    ;(async () => {
      // 초기 로드 — fetchSnapshot이 상태까지 갱신한다
      const snapshot = await fetchSnapshot()
      if (cancelled) return
      // fetchSnapshot already set state; nothing else
      void snapshot
    })()

    return () => {
      cancelled = true
    }
  }, [fetchSnapshot])

  const refresh = useCallback(async () => {
    return fetchSnapshot()
  }, [fetchSnapshot])

  const createTask = useCallback(async ({ projectId, title, reason }) => {
    const api = window.jarvisTree
    if (!api?.createTask) {
      return { ok: false, error: 'jarvisTree.createTask API 없음 — Electron을 재시작하세요.' }
    }
    const p = typeof projectId === 'string' ? projectId.trim() : ''
    const t = typeof title === 'string' ? title.trim() : ''
    if (!p) return { ok: false, error: 'project_id가 비어 있습니다' }
    if (!t) return { ok: false, error: 'title이 비어 있습니다' }
    const response = await api.createTask(p, t, typeof reason === 'string' ? reason.trim() : reason)
    if (!response || response.status !== 'ok' || !response.task) {
      return { ok: false, error: response?.error || 'Task 생성에 실패했습니다' }
    }
    // 성공 — canonical state에서 fresh snapshot으로 UI 갱신 (수동 패치 금지)
    await fetchSnapshot()
    return { ok: true, task: response.task }
  }, [fetchSnapshot])

  const setTaskDone = useCallback(async ({ projectId, taskId, done }) => {
    const api = window.jarvisTree
    if (!api?.updateTask) {
      return { ok: false, error: 'jarvisTree.updateTask API 없음 — Electron을 재시작하세요.' }
    }
    const p = typeof projectId === 'string' ? projectId.trim() : ''
    const tid = typeof taskId === 'string' ? taskId.trim() : ''
    if (!p) return { ok: false, error: 'project_id가 비어 있습니다' }
    if (!tid) return { ok: false, error: 'task_id가 비어 있습니다' }
    if (typeof done !== 'boolean') return { ok: false, error: 'done은 boolean이어야 합니다' }
    const response = await api.updateTask(p, tid, done)
    if (!response || response.status !== 'ok' || !response.task) {
      return { ok: false, error: response?.error || 'Task 상태 변경에 실패했습니다' }
    }
    // 성공 — canonical state에서 fresh snapshot으로 UI 갱신 (수동 패치 금지)
    await fetchSnapshot()
    return { ok: true, task: response.task }
  }, [fetchSnapshot])

  const toggleComplete = useCallback(async (nodeId) => {
    const found = findNodeAndPath(root, nodeId)
    if (!found) return { ok: false, error: '노드를 찾을 수 없습니다' }
    const { node, path } = found
    if (node.type !== 'task') {
      // non-task toggles remain renderer-local
      setRoot((current) =>
        updateNodeById(current, nodeId, (n) => ({
          ...n,
          complete: !n.complete,
        })),
      )
      return { ok: true, local: true }
    }
    // Resolve owning project
    let projectId = null
    for (let i = path.length - 1; i >= 0; i -= 1) {
      if (path[i].type === 'project') { projectId = path[i].id; break }
    }
    if (!projectId) return { ok: false, error: '프로젝트를 찾을 수 없습니다' }
    return setTaskDone({ projectId, taskId: node.id, done: !node.complete })
  }, [root, setTaskDone])

  const api = useMemo(
    () => ({
      find(nodeId) {
        return findNodeAndPath(root, nodeId)
      },

      stats(node = root) {
        return collectStats(node)
      },

      /* RESOURCE LINK V1 (PART I) — files 뷰의 파일 노드에서 호출하는
         deterministic canonical write. UI 선택값(project/file/relation)만
         전달하고, 성공 시 canonical snapshot을 다시 읽어 UI를 갱신한다. */
      async linkProjectFile({ projectId, fileId, relation }) {
        const api = window.jarvisDiscovery
        if (!api?.linkProjectFile) {
          return { ok: false, error: 'jarvisDiscovery.linkProjectFile API 없음 — Electron을 재시작하세요.' }
        }
        const p = typeof projectId === 'string' ? projectId.trim() : ''
        const f = typeof fileId === 'string' ? fileId.trim() : ''
        if (!p) return { ok: false, error: 'project_id가 비어 있습니다' }
        if (!f) return { ok: false, error: 'file_id(FileRef identity)가 비어 있습니다' }
        const response = await api.linkProjectFile(
          p,
          f,
          typeof relation === 'string' && relation.trim() ? relation.trim() : 'reference',
        )
        if (!response || response.status !== 'ok') {
          return { ok: false, error: response?.error || '링크 생성에 실패했습니다' }
        }
        // 성공 — canonical state에서 fresh snapshot으로 UI 갱신 (수동 패치 금지)
        await fetchSnapshot()
        return { ok: true, created: response.created, link: response.link }
      },

      /* PROJECT PRIMARY WORKSPACE V1 — Project → 논리 WorkspaceRoot 관계 설정.
         explicit user action → deterministic write. 성공 시 canonical
         snapshot 재조회로 Workspace 노드를 갱신한다. */
      async setProjectWorkspace({ projectId, rootId }) {
        const api = window.jarvisDiscovery
        if (!api?.setProjectWorkspace) {
          return { ok: false, error: 'jarvisDiscovery.setProjectWorkspace API 없음 — Electron을 재시작하세요.' }
        }
        const p = typeof projectId === 'string' ? projectId.trim() : ''
        const r = typeof rootId === 'string' ? rootId.trim() : ''
        if (!p) return { ok: false, error: 'project_id가 비어 있습니다' }
        if (!r) return { ok: false, error: 'root_id가 비어 있습니다' }
        const response = await api.setProjectWorkspace(p, r)
        if (!response || response.status !== 'ok') {
          return { ok: false, error: response?.error || 'workspace 설정에 실패했습니다' }
        }
        await fetchSnapshot()
        return { ok: true, workspace: response.workspace, updated: response.updated }
      },

      async clearProjectWorkspace({ projectId }) {
        const api = window.jarvisDiscovery
        if (!api?.clearProjectWorkspace) {
          return { ok: false, error: 'jarvisDiscovery.clearProjectWorkspace API 없음 — Electron을 재시작하세요.' }
        }
        const p = typeof projectId === 'string' ? projectId.trim() : ''
        if (!p) return { ok: false, error: 'project_id가 비어 있습니다' }
        const response = await api.clearProjectWorkspace(p)
        if (!response || response.status !== 'ok') {
          return { ok: false, error: response?.error || 'workspace 해제에 실패했습니다' }
        }
        await fetchSnapshot()
        return { ok: true, removed: response.removed }
      },

      // Renderer-local generic add (non-task types — Edit/Delete와 함께 후속 마일스톤에서 제거 예정)
      // Task 타입의 Add는 canonical createTask를 사용해야 한다 — TreePrototype에서 분기한다.
      addChild(parentId, payload) {
        const label =
          typeof payload?.label === 'string'
            ? payload.label.trim()
            : ''

        if (!label) return null

        const type =
          TASK_NODE_TYPES.includes(payload.type)
            ? payload.type
            : 'task'

        const nextNode = {
          id: makeId(),
          label,
          eyebrow: type.toUpperCase(),
          description:
            typeof payload.description === 'string'
              ? payload.description.trim()
              : '',
          type,
          complete: false,
          children: [],
        }

        setRoot((current) =>
          updateNodeById(current, parentId, (node) => ({
            ...node,
            children: [...node.children, nextNode],
          })),
        )

        return nextNode.id
      },

      updateNode(nodeId, payload) {
        setRoot((current) =>
          updateNodeById(current, nodeId, (node) => ({
            ...node,
            label:
              typeof payload.label === 'string' &&
              payload.label.trim()
                ? payload.label.trim()
                : node.label,
            description:
              typeof payload.description === 'string'
                ? payload.description
                : node.description,
            type: TASK_NODE_TYPES.includes(
              payload.type,
            )
              ? payload.type
              : node.type,
            eyebrow: TASK_NODE_TYPES.includes(
              payload.type,
            )
              ? payload.type.toUpperCase()
              : node.eyebrow,
          })),
        )
      },

      // legacy renderer-only toggle retained as `toggleCompleteLocal` for non-task types if needed
      toggleCompleteLocal(nodeId) {
        setRoot((current) =>
          updateNodeById(current, nodeId, (n) => ({
            ...n,
            complete: !n.complete,
          })),
        )
      },

      toggleComplete, // canonical task toggle (setTaskDone + refresh)

      deleteNode(nodeId) {
        if (nodeId === root.id) return root.id
        const current = findNodeAndPath(root, nodeId)
        const parentId =
          current?.path.at(-2)?.id || root.id
        setRoot((latest) =>
          removeNodeById(latest, nodeId),
        )
        return parentId
      },

      createTask,
      setTaskDone,
      refresh,
    }),
    [root, createTask, setTaskDone, refresh, toggleComplete, fetchSnapshot],
  )

  return {
    root,
    status,
    error,
    rootStats: collectStats(root),
    refresh,
    createTask,
    ...api,
  }
}
