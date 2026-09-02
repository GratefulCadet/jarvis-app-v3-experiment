import {
  useEffect,
  useMemo,
  useState,
} from 'react'

import {
  TREE_PROTOTYPE_ROOT,
} from './treePrototypeData'

const STORAGE_KEY =
  'jarvis_task_tree_v1'

const STORAGE_SCHEMA_VERSION = 1

export const TASK_NODE_TYPES =
  Object.freeze([
    'goal',
    'project',
    'task',
    'step',
  ])

const makeId = () =>
  `tree-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 9)}`

const inferNodeType = (
  eyebrow,
) => {
  const normalized =
    String(eyebrow || '')
      .toLowerCase()

  if (
    normalized.includes(
      'project',
    )
  ) {
    return 'project'
  }

  if (
    normalized.includes('task')
  ) {
    return 'task'
  }

  if (
    normalized.includes(
      'subtask',
    ) ||
    normalized.includes(
      'execution',
    )
  ) {
    return 'step'
  }

  return 'goal'
}

const normalizeNode = (
  node,
  fallback,
) => {
  const source =
    node &&
    typeof node === 'object'
      ? node
      : fallback

  const fallbackNode =
    fallback &&
    typeof fallback === 'object'
      ? fallback
      : TREE_PROTOTYPE_ROOT

  const children =
    Array.isArray(source.children)
      ? source.children
      : []

  return {
    id:
      typeof source.id === 'string' &&
      source.id
        ? source.id
        : fallbackNode.id ||
          makeId(),

    label:
      typeof source.label ===
        'string' && source.label
        ? source.label
        : fallbackNode.label ||
          'Untitled',

    eyebrow:
      typeof source.eyebrow ===
      'string'
        ? source.eyebrow
        : fallbackNode.eyebrow ||
          'TASK',

    description:
      typeof source.description ===
      'string'
        ? source.description
        : fallbackNode.description ||
          '',

    type:
      TASK_NODE_TYPES.includes(
        source.type,
      )
        ? source.type
        : inferNodeType(
            source.eyebrow ||
              fallbackNode.eyebrow,
          ),

    complete:
      Boolean(source.complete),

    children:
      children.map((child) =>
        normalizeNode(child),
      ),
  }
}

const createDefaultTree = () =>
  normalizeNode(
    TREE_PROTOTYPE_ROOT,
  )

const loadTree = () => {
  if (
    typeof window ===
    'undefined'
  ) {
    return createDefaultTree()
  }

  try {
    const raw =
      window.localStorage.getItem(
        STORAGE_KEY,
      )

    if (!raw) {
      return createDefaultTree()
    }

    const parsed =
      JSON.parse(raw)

    if (
      parsed?.schemaVersion !==
        STORAGE_SCHEMA_VERSION ||
      !parsed.root
    ) {
      return createDefaultTree()
    }

    return normalizeNode(
      parsed.root,
      TREE_PROTOTYPE_ROOT,
    )
  } catch (error) {
    console.warn(
      'Failed to load JARVIS task tree.',
      error,
    )

    return createDefaultTree()
  }
}

const findNodeAndPath = (
  node,
  targetId,
  path = [],
) => {
  const nextPath = [
    ...path,
    node,
  ]

  if (node.id === targetId) {
    return {
      node,
      path: nextPath,
    }
  }

  for (const child of
    node.children ?? []) {
    const result =
      findNodeAndPath(
        child,
        targetId,
        nextPath,
      )

    if (result) {
      return result
    }
  }

  return null
}

const updateNodeById = (
  node,
  targetId,
  updater,
) => {
  if (node.id === targetId) {
    return updater(node)
  }

  return {
    ...node,
    children:
      node.children.map((child) =>
        updateNodeById(
          child,
          targetId,
          updater,
        ),
      ),
  }
}

const removeNodeById = (
  node,
  targetId,
) => ({
  ...node,
  children:
    node.children
      .filter(
        (child) =>
          child.id !== targetId,
      )
      .map((child) =>
        removeNodeById(
          child,
          targetId,
        ),
      ),
})

const collectStats = (node) => {
  const childStats =
    node.children.map(
      collectStats,
    )

  const total =
    1 +
    childStats.reduce(
      (sum, stats) =>
        sum + stats.total,
      0,
    )

  const completed =
    (node.complete ? 1 : 0) +
    childStats.reduce(
      (sum, stats) =>
        sum + stats.completed,
      0,
    )

  const leafCount =
    node.children.length === 0
      ? 1
      : childStats.reduce(
          (sum, stats) =>
            sum + stats.leafCount,
          0,
        )

  return {
    total,
    completed,
    leafCount,
  }
}

const buildNodePayload = (
  payload,
) => {
  const label =
    payload.label.trim()

  const type =
    TASK_NODE_TYPES.includes(
      payload.type,
    )
      ? payload.type
      : 'task'

  return {
    id: makeId(),
    label,
    eyebrow:
      type.toUpperCase(),
    description:
      payload.description.trim(),
    type,
    complete: false,
    children: [],
  }
}

export default function useTaskTree() {
  const [root, setRoot] =
    useState(loadTree)

  useEffect(() => {
    try {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          schemaVersion:
            STORAGE_SCHEMA_VERSION,
          root,
        }),
      )
    } catch (error) {
      console.warn(
        'Failed to save JARVIS task tree.',
        error,
      )
    }
  }, [root])

  const api = useMemo(
    () => ({
      find(nodeId) {
        return findNodeAndPath(
          root,
          nodeId,
        )
      },

      stats(node = root) {
        return collectStats(node)
      },

      addChild(
        parentId,
        payload,
      ) {
        const label =
          payload.label.trim()

        if (!label) {
          return null
        }

        const nextNode =
          buildNodePayload({
            ...payload,
            label,
          })

        setRoot((current) =>
          updateNodeById(
            current,
            parentId,
            (node) => ({
              ...node,
              children: [
                ...node.children,
                nextNode,
              ],
            }),
          ),
        )

        return nextNode.id
      },

      updateNode(
        nodeId,
        payload,
      ) {
        setRoot((current) =>
          updateNodeById(
            current,
            nodeId,
            (node) => ({
              ...node,
              label:
                payload.label.trim() ||
                node.label,
              description:
                payload.description,
              type:
                TASK_NODE_TYPES.includes(
                  payload.type,
                )
                  ? payload.type
                  : node.type,
              eyebrow:
                TASK_NODE_TYPES.includes(
                  payload.type,
                )
                  ? payload.type
                      .toUpperCase()
                  : node.eyebrow,
            }),
          ),
        )
      },

      toggleComplete(nodeId) {
        setRoot((current) =>
          updateNodeById(
            current,
            nodeId,
            (node) => ({
              ...node,
              complete:
                !node.complete,
            }),
          ),
        )
      },

      deleteNode(nodeId) {
        if (nodeId === root.id) {
          return root.id
        }

        const current =
          findNodeAndPath(
            root,
            nodeId,
          )

        const parentId =
          current?.path.at(-2)?.id ||
          root.id

        setRoot((latest) =>
          removeNodeById(
            latest,
            nodeId,
          ),
        )

        return parentId
      },
    }),
    [root],
  )

  return {
    root,
    rootStats:
      collectStats(root),
    ...api,
  }
}
