import {
  useEffect,
  useMemo,
  useState,
} from 'react'

const STORAGE_KEY = 'jarvis_execution_session_v1'
const STORAGE_SCHEMA_VERSION = 1

export const TIMER_PRESETS_MINUTES = [
  5,
  15,
  25,
  50,
]

const DEFAULT_DURATION_MS =
  25 * 60 * 1000

const AUTO_EXTEND_RATIO = 0.25

const makeId = () =>
  `${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 9)}`

const createInitialState = () => ({
  objective:
    'Build JARVIS Quick Interaction',

  nextAction:
    'Continue JARVIS prototype',

  checklist: [
    {
      id: 'initial-1',
      text: 'Verify hover interaction',
      checked: false,
    },
    {
      id: 'initial-2',
      text: 'Integrate shared timer state',
      checked: false,
    },
    {
      id: 'initial-3',
      text: 'Keep Command Center transition intact',
      checked: false,
    },
  ],

  timer: {
    status: 'idle',
    originalDurationMs:
      DEFAULT_DURATION_MS,
    startedAt: null,
    targetAt: null,
    pausedAt: null,
    remainingMs:
      DEFAULT_DURATION_MS,
    extensionCount: 0,
    endedAt: null,
  },
})

const normalizeLoadedState = (
  loaded,
) => {
  const fallback =
    createInitialState()

  if (
    !loaded ||
    typeof loaded !== 'object'
  ) {
    return fallback
  }

  const checklist =
    Array.isArray(
      loaded.checklist,
    )
      ? loaded.checklist
          .filter(
            (item) =>
              item &&
              typeof item ===
                'object',
          )
          .map((item) => ({
            id:
              item.id || makeId(),
            text:
              typeof item.text ===
              'string'
                ? item.text
                : '',
            checked:
              Boolean(
                item.checked,
              ),
          }))
      : fallback.checklist

  const timer = {
    ...fallback.timer,
    ...(loaded.timer || {}),
  }

  return {
    objective:
      typeof loaded.objective ===
      'string'
        ? loaded.objective
        : fallback.objective,

    nextAction:
      typeof loaded.nextAction ===
      'string'
        ? loaded.nextAction
        : fallback.nextAction,

    checklist,

    timer,
  }
}

/*
  Persistent product state boundary.

  Dexie 같은 DB를 아직 도입할 필요는 없지만,
  저장 형식은 지금부터 UI/transient state와 분리한다.

  schemaVersion을 둬서 나중에 Project / Task / Memory 구조가
  추가되어도 기존 prototype 데이터를 안전하게 migrate할 수 있게 한다.
*/
const unwrapPersistedState = (
  parsed,
) => {
  if (
    !parsed ||
    typeof parsed !== 'object'
  ) {
    return null
  }

  /*
    새 snapshot envelope.
  */
  if (
    Object.prototype.hasOwnProperty.call(
      parsed,
      'schemaVersion',
    )
  ) {
    if (
      parsed.schemaVersion !==
        STORAGE_SCHEMA_VERSION ||
      !parsed.execution ||
      typeof parsed.execution !==
        'object'
    ) {
      return null
    }

    return parsed.execution
  }

  /*
    기존 jarvis_execution_session_v1의 raw object도 계속 읽는다.
    한 번 저장되면 새 envelope 형식으로 자연스럽게 올라간다.
  */
  return parsed
}

const createPersistedSnapshot = (
  state,
) => ({
  schemaVersion:
    STORAGE_SCHEMA_VERSION,
  execution: state,
})

const loadInitialState = () => {
  try {
    const raw =
      window.localStorage.getItem(
        STORAGE_KEY,
      )

    if (!raw) {
      return createInitialState()
    }

    const parsed =
      JSON.parse(raw)

    const persisted =
      unwrapPersistedState(parsed)

    if (!persisted) {
      return createInitialState()
    }

    return normalizeLoadedState(
      persisted,
    )
  } catch {
    return createInitialState()
  }
}

const saveState = (state) => {
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(
        createPersistedSnapshot(
          state,
        ),
      ),
    )
  } catch {
    // localStorage를 사용할 수 없는
    // 환경에서는 prototype 상태만 유지한다.
  }
}

const getRemainingMs = (
  timer,
  now,
) => {
  if (
    timer.status === 'active' &&
    timer.targetAt !== null
  ) {
    return Math.max(
      0,
      timer.targetAt - now,
    )
  }

  return Math.max(
    0,
    timer.remainingMs ??
      timer.originalDurationMs,
  )
}

const resolveExpiredTimerState = (
  current,
  currentTime,
) => {
  if (
    current.timer.status !==
      'active' ||
    current.timer.targetAt ===
      null ||
    current.timer.targetAt >
      currentTime
  ) {
    return current
  }

  const currentAllChecked =
    current.checklist.length > 0 &&
    current.checklist.every(
      (item) => item.checked,
    )

  if (currentAllChecked) {
    return {
      ...current,
      timer: {
        ...current.timer,
        status: 'done',
        targetAt: null,
        remainingMs: 0,
        endedAt: currentTime,
      },
    }
  }

  const extensionMs =
    Math.max(
      60_000,
      Math.round(
        current.timer
          .originalDurationMs *
          AUTO_EXTEND_RATIO,
      ),
    )

  return {
    ...current,
    timer: {
      ...current.timer,
      status: 'active',
      startedAt: currentTime,
      targetAt:
        currentTime + extensionMs,
      remainingMs: null,
      extensionCount:
        current.timer
          .extensionCount + 1,
    },
  }
}

export const formatTimer = (
  milliseconds,
) => {
  const totalSeconds =
    Math.ceil(
      Math.max(
        0,
        milliseconds,
      ) / 1000,
    )

  const hours =
    Math.floor(
      totalSeconds / 3600,
    )

  const minutes =
    Math.floor(
      (totalSeconds % 3600) /
        60,
    )

  const seconds =
    totalSeconds % 60

  return `${String(hours)
    .padStart(2, '0')}:${String(
    minutes,
  ).padStart(2, '0')}:${String(
    seconds,
  ).padStart(2, '0')}`
}

export default function useExecutionSession() {
  const [state, setState] =
    useState(loadInitialState)

  /*
    now는 display refresh를 위한 transient clock이다.
    persistent product state가 아니므로 저장하지 않는다.
  */
  const [now, setNow] =
    useState(() => Date.now())

  useEffect(() => {
    saveState(state)
  }, [state])

  useEffect(() => {
    if (
      state.timer.status !==
      'active'
    ) {
      return undefined
    }

    const refresh = () => {
      const currentTime =
        Date.now()

      setNow(currentTime)

      setState((current) =>
        resolveExpiredTimerState(
          current,
          currentTime,
        ),
      )
    }

    const intervalId =
      window.setInterval(
        refresh,
        250,
      )

    return () => {
      window.clearInterval(
        intervalId,
      )
    }
  }, [state.timer.status])

  const allChecked =
    state.checklist.length > 0 &&
    state.checklist.every(
      (item) => item.checked,
    )

  const remainingMs =
    getRemainingMs(
      state.timer,
      now,
    )

  const progress =
    state.checklist.length === 0
      ? 0
      : state.checklist.filter(
          (item) =>
            item.checked,
        ).length /
        state.checklist.length

  const currentItem =
    state.checklist.find(
      (item) =>
        !item.checked,
    ) || null

  const currentItemId =
    currentItem?.id || null

  const statusLabel =
    {
      idle: 'READY',
      active: 'RUNNING',
      paused: 'PAUSED',
      done: 'DONE',
      ended: 'ENDED',
    }[state.timer.status] ||
    'READY'

  const actions = useMemo(
    () => ({
      setNextAction(nextAction) {
        setState(
          (current) => ({
            ...current,
            nextAction,
          }),
        )
      },

      setDurationMinutes(minutes) {
        const durationMs =
          Number(minutes) *
          60_000

        if (
          !Number.isFinite(
            durationMs,
          ) ||
          durationMs <= 0
        ) {
          return
        }

        setState((current) => {
          if (
            current.timer.status !==
            'idle'
          ) {
            return current
          }

          return {
            ...current,
            timer: {
              ...current.timer,
              originalDurationMs:
                durationMs,
              remainingMs:
                durationMs,
            },
          }
        })
      },

      start() {
        const currentTime =
          Date.now()

        setNow(currentTime)

        setState((current) => {
          if (
            current.timer.status !==
            'idle'
          ) {
            return current
          }

          const durationMs =
            current.timer
              .originalDurationMs

          return {
            ...current,
            timer: {
              ...current.timer,
              status: 'active',
              startedAt:
                currentTime,
              targetAt:
                currentTime +
                durationMs,
              pausedAt: null,
              remainingMs: null,
              extensionCount: 0,
              endedAt: null,
            },
          }
        })
      },

      pause() {
        const currentTime =
          Date.now()

        setNow(currentTime)

        setState((current) => {
          if (
            current.timer.status !==
              'active' ||
            current.timer.targetAt ===
              null
          ) {
            return current
          }

          const nextRemainingMs =
            Math.max(
              0,
              current.timer
                .targetAt -
                currentTime,
            )

          return {
            ...current,
            timer: {
              ...current.timer,
              status: 'paused',
              pausedAt:
                currentTime,
              targetAt: null,
              remainingMs:
                nextRemainingMs,
            },
          }
        })
      },

      resume() {
        const currentTime =
          Date.now()

        setNow(currentTime)

        setState((current) => {
          if (
            current.timer.status !==
            'paused'
          ) {
            return current
          }

          const resumeRemaining =
            Math.max(
              0,
              current.timer
                .remainingMs ?? 0,
            )

          if (
            resumeRemaining <= 0
          ) {
            return current
          }

          return {
            ...current,
            timer: {
              ...current.timer,
              status: 'active',
              startedAt:
                currentTime,
              targetAt:
                currentTime +
                resumeRemaining,
              pausedAt: null,
              remainingMs: null,
            },
          }
        })
      },

      end() {
        const currentTime =
          Date.now()

        setNow(currentTime)

        setState((current) => {
          if (
            current.timer.status ===
              'done' ||
            current.timer.status ===
              'ended'
          ) {
            return current
          }

          const nextRemainingMs =
            getRemainingMs(
              current.timer,
              currentTime,
            )

          return {
            ...current,
            timer: {
              ...current.timer,
              status: 'ended',
              targetAt: null,
              remainingMs:
                nextRemainingMs,
              endedAt:
                currentTime,
            },
          }
        })
      },

      prepareNewRun() {
        setNow(Date.now())

        setState((current) => ({
          ...current,
          checklist:
            current.checklist.map(
              (item) => ({
                ...item,
                checked: false,
              }),
            ),
          timer: {
            ...current.timer,
            status: 'idle',
            startedAt: null,
            targetAt: null,
            pausedAt: null,
            remainingMs:
              current.timer
                .originalDurationMs,
            extensionCount: 0,
            endedAt: null,
          },
        }))
      },

      toggleChecklistItem(id) {
        setState((current) => {
          if (
            current.timer.status ===
              'done' ||
            current.timer.status ===
              'ended'
          ) {
            return current
          }

          return {
            ...current,
            checklist:
              current.checklist.map(
                (item) =>
                  item.id === id
                    ? {
                        ...item,
                        checked:
                          !item.checked,
                      }
                    : item,
              ),
          }
        })
      },

      addChecklistItem(text) {
        const trimmed =
          text.trim()

        if (!trimmed) {
          return
        }

        setState((current) => {
          if (
            current.timer.status ===
              'done' ||
            current.timer.status ===
              'ended'
          ) {
            return current
          }

          return {
            ...current,
            checklist: [
              ...current.checklist,
              {
                id: makeId(),
                text: trimmed,
                checked: false,
              },
            ],
          }
        })
      },

      deleteChecklistItem(id) {
        setState((current) => {
          if (
            current.timer.status ===
              'done' ||
            current.timer.status ===
              'ended'
          ) {
            return current
          }

          return {
            ...current,
            checklist:
              current.checklist.filter(
                (item) =>
                  item.id !== id,
              ),
          }
        })
      },
    }),
    [],
  )

  return {
    objective:
      state.objective,
    nextAction:
      state.nextAction,
    checklist:
      state.checklist,
    timer:
      state.timer,
    remainingMs,
    timerText:
      formatTimer(
        remainingMs,
      ),
    progress,
    allChecked,
    actionComplete:
      allChecked,
    currentItem,
    currentItemId,
    statusLabel,
    actions,
  }
}
