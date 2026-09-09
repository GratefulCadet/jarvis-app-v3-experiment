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

  Write 수렴 (이 마일스톤): Add Task만 canonical TaskStore 경로로 연결.
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

const makeProjectNode = (project) => ({
  id: project.id,
  label: project.title || project.id,
  eyebrow: 'PROJECT',
  description: project.title ? project.id : '',
  type: 'project',
  complete: false,
  children: (project.children || []).map(makeTaskNode),
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

  const api = useMemo(
    () => ({
      find(nodeId) {
        return findNodeAndPath(root, nodeId)
      },

      stats(node = root) {
        return collectStats(node)
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

      toggleComplete(nodeId) {
        setRoot((current) =>
          updateNodeById(current, nodeId, (node) => ({
            ...node,
            complete: !node.complete,
          })),
        )
      },

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
      refresh,
    }),
    [root, createTask, refresh],
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
