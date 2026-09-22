import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
} from 'react'

/*
  JARVIS runtime 상태 머신 (Task 2).

  PiP와 Command Center가 같은 runtime state를 구독한다 — ad-hoc boolean이
  컴포넌트에 퍼지지 않게 하나의 reducer로만 상태를 바꾼다.

  상태:
    idle                 — 대기. 이전 응답/타임라인은 남겨둔다
    thinking             — Qwen tool-call 루프 진행 중 (chat)
    tool-running         — 승인된 write가 실행되는 중 (confirm)
    awaiting-confirmation— Permission Gate. 제안된 tool_call 보존. 변이 0
    done                 — 최종 응답 표시
    error                — 실패 표시 (브리지/Ollama/timeout/검증/루프 한도)

  timeline (Task 5): USER → QWEN tool → TOOL OK → PERMISSION → APPROVED
  → TOOL OK → FINAL RESPONSE + trace path. Qwen이 Tool Result와 모순된 답을
  해도 trace/events가 실제 실행을 증거로 남긴다.
*/

export const RUNTIME_STATUS = Object.freeze({
  IDLE: 'idle',
  THINKING: 'thinking',
  TOOL_RUNNING: 'tool-running',
  AWAITING_CONFIRMATION: 'awaiting-confirmation',
  DONE: 'done',
  ERROR: 'error',
})

const DEFAULT_PROJECT = 'jarvis-app'

const RUNTIME_EVENT = Object.freeze({
  SUBMIT: 'submit',
  CHAT_RESOLVED: 'chat-resolved',
  PERMISSION_REQUIRED: 'permission-required',
  APPROVE: 'approve',
  APPROVE_RESOLVED: 'approve-resolved',
  REJECT: 'reject',
  REJECT_RESOLVED: 'reject-resolved',
  ERROR: 'error',
  DISMISS: 'dismiss',
})

const createInitialRuntime = () => ({
  status: RUNTIME_STATUS.IDLE,
  text: '',
  error: null,
  toolCall: null,
  projectId: DEFAULT_PROJECT,
  traceId: null,
  tracePath: null,
  scratch: true,
  timeline: [],
})

const pushTimeline = (state, entry) => ({
  ...state,
  timeline: [...state.timeline, { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, ...entry }],
})

/*
  bridge 응답의 events(trace에서 추출한 실제 tool 실행)를 timeline으로 변환.
  events가 없으면 응답 본문만으로 최소 기록을 남긴다.
*/
const eventsToTimeline = (events = []) => {
  const entries = []
  for (const event of events) {
    if (event.kind !== 'tool') continue
    const argsText = event.arguments
      ? `(${JSON.stringify(event.arguments)})`
      : ''
    if (event.requires_confirmation) {
      entries.push({
        kind: 'permission',
        label: 'PERMISSION REQUIRED',
        detail: `${event.name}${argsText}`,
      })
      continue
    }
    entries.push({
      kind: event.ok ? 'tool-ok' : 'tool-error',
      label: event.ok ? 'TOOL OK' : 'TOOL ERROR',
      detail: `${event.name}${argsText}`,
    })
  }
  return entries
}

const runtimeReducer = (state, event) => {
  switch (event.type) {
    case RUNTIME_EVENT.SUBMIT: {
      if (
        state.status === RUNTIME_STATUS.THINKING ||
        state.status === RUNTIME_STATUS.TOOL_RUNNING ||
        state.status === RUNTIME_STATUS.AWAITING_CONFIRMATION
      ) {
        return state
      }
      let next = {
        ...state,
        status: RUNTIME_STATUS.THINKING,
        text: '',
        error: null,
        toolCall: null,
        traceId: null,
        tracePath: null,
      }
      if (event.text) {
        const sourceLabel = event.source === 'voice' ? 'VOICE' : 'USER'
        next = pushTimeline(next, { kind: 'user', label: sourceLabel, detail: event.text })
      }
      return next
    }

    case RUNTIME_EVENT.PERMISSION_REQUIRED:
      return pushTimeline(
        {
          ...state,
          status: RUNTIME_STATUS.AWAITING_CONFIRMATION,
          toolCall: event.toolCall,
          traceId: event.traceId || null,
          tracePath: event.tracePath || null,
          scratch: Boolean(event.scratch),
        },
        { kind: 'permission', label: 'PERMISSION REQUIRED', detail: permissionDetail(event.toolCall) },
      )

    case RUNTIME_EVENT.CHAT_RESOLVED: {
      const base = {
        ...state,
        status: RUNTIME_STATUS.DONE,
        text: event.text || '',
        error: null,
        traceId: event.traceId || null,
        tracePath: event.tracePath || null,
        scratch: Boolean(event.scratch),
      }
      const toolEntries = eventsToTimeline(event.events)
      let next = base
      for (const entry of toolEntries) next = pushTimeline(next, entry)
      return pushTimeline(next, { kind: 'qwen', label: 'QWEN FINAL', detail: event.text || '' })
    }

    case RUNTIME_EVENT.APPROVE:
      return {
        ...state,
        status: RUNTIME_STATUS.TOOL_RUNNING,
        text: '',
        error: null,
      }

    case RUNTIME_EVENT.APPROVE_RESOLVED: {
      const base = {
        ...state,
        status: RUNTIME_STATUS.DONE,
        text: event.text || '',
        error: null,
        traceId: event.traceId || null,
        tracePath: event.tracePath || null,
        scratch: Boolean(event.scratch),
      }
      const approved = pushTimeline(
        base,
        { kind: 'approved', label: 'APPROVED', detail: permissionDetail(state.toolCall) },
      )
      const toolEntries = eventsToTimeline(event.events)
      let next = approved
      for (const entry of toolEntries) next = pushTimeline(next, entry)
      return pushTimeline(next, { kind: 'qwen', label: 'QWEN FINAL', detail: event.text || '' })
    }

    case RUNTIME_EVENT.REJECT:
      return pushTimeline(
        { ...state, status: RUNTIME_STATUS.DONE, text: '', error: null },
        { kind: 'rejected', label: 'REJECTED', detail: permissionDetail(state.toolCall) },
      )

    case RUNTIME_EVENT.REJECT_RESOLVED:
      return {
        ...state,
        status: RUNTIME_STATUS.DONE,
        text: event.text || '거절했습니다. 아무것도 변경되지 않았습니다.',
        error: null,
      }

    case RUNTIME_EVENT.ERROR:
      return pushTimeline(
        { ...state, status: RUNTIME_STATUS.ERROR, error: event.error, toolCall: null },
        { kind: 'error', label: 'ERROR', detail: event.error },
      )

    case RUNTIME_EVENT.DISMISS:
      return {
        ...state,
        status: RUNTIME_STATUS.IDLE,
        text: '',
        error: null,
        toolCall: null,
      }

    default:
      return state
  }
}

const permissionDetail = (toolCall) => {
  if (!toolCall) return ''
  const args = toolCall.arguments || {}
  const summary = [args.project_id, args.title]
    .filter(Boolean)
    .join(' · ')
  return `${toolCall.name}${summary ? `(${summary})` : ''}`
}

function getRuntimeApi() {
  if (!window.jarvisRuntime) {
    return null
  }
  return window.jarvisRuntime
}

export default function useJarvisRuntime() {
  const [state, dispatch] = useReducer(runtimeReducer, undefined, createInitialRuntime)
  const stateRef = useRef(state)
  const approvalInFlightRef = useRef(false)

  useEffect(() => {
    stateRef.current = state
  }, [state])

  const submit = useCallback(async (text, projectId, options) => {
    const api = getRuntimeApi()
    if (!api) {
      dispatch({ type: RUNTIME_EVENT.ERROR, error: 'jarvisRuntime API를 찾을 수 없습니다. Electron에서 실행 중인지 확인하세요.' })
      return
    }
    const trimmed = typeof text === 'string' ? text.trim() : ''
    if (!trimmed) return
    dispatch({
      type: RUNTIME_EVENT.SUBMIT,
      text: trimmed,
      source: options && options.source === 'voice' ? 'voice' : 'text',
    })
    const response = await api.chat(trimmed, projectId || DEFAULT_PROJECT)

    if (!response || response.status === 'error') {
      dispatch({ type: RUNTIME_EVENT.ERROR, error: (response && response.error) || '브리지 응답이 없습니다' })
      return
    }
    if (response.status === 'awaiting_confirmation') {
      dispatch({
        type: RUNTIME_EVENT.PERMISSION_REQUIRED,
        toolCall: response.tool_call,
        traceId: response.trace_id,
        tracePath: response.trace_path,
        scratch: response.scratch,
      })
      return
    }
    if (response.status === 'final') {
      dispatch({
        type: RUNTIME_EVENT.CHAT_RESOLVED,
        text: response.text,
        events: response.events,
        traceId: response.trace_id,
        tracePath: response.trace_path,
        scratch: response.scratch,
      })
      return
    }
    dispatch({ type: RUNTIME_EVENT.ERROR, error: `예상하지 못한 브리지 응답: ${response.status}` })
  }, [])

  const approve = useCallback(async () => {
    const api = getRuntimeApi()
    const current = stateRef.current
    const toolCall = current.toolCall
    if (
      !api ||
      !toolCall ||
      current.status !== RUNTIME_STATUS.AWAITING_CONFIRMATION ||
      approvalInFlightRef.current
    ) return

    approvalInFlightRef.current = true
    dispatch({ type: RUNTIME_EVENT.APPROVE })
    const response = await api.confirm(toolCall)

    if (!response || response.status === 'error') {
      approvalInFlightRef.current = false
      dispatch({ type: RUNTIME_EVENT.ERROR, error: (response && response.error) || 'confirm 실패' })
      return
    }
    if (response.status === 'awaiting_confirmation') {
      approvalInFlightRef.current = false
      // 승인 후 모델이 새 write를 제안 → 재차단 (설계 동작)
      dispatch({
        type: RUNTIME_EVENT.PERMISSION_REQUIRED,
        toolCall: response.tool_call,
        traceId: response.trace_id,
        tracePath: response.trace_path,
        scratch: response.scratch,
      })
      return
    }
    if (response.status === 'final') {
      approvalInFlightRef.current = false
      dispatch({
        type: RUNTIME_EVENT.APPROVE_RESOLVED,
        text: response.text,
        events: response.events,
        traceId: response.trace_id,
        tracePath: response.trace_path,
        scratch: response.scratch,
      })
      return
    }
    dispatch({ type: RUNTIME_EVENT.ERROR, error: `예상하지 못한 confirm 응답: ${response.status}` })
  }, [])

  const reject = useCallback(async () => {
    const api = getRuntimeApi()
    const current = stateRef.current
    const toolCall = current.toolCall
    if (
      !api ||
      !toolCall ||
      current.status !== RUNTIME_STATUS.AWAITING_CONFIRMATION ||
      approvalInFlightRef.current
    ) return

    approvalInFlightRef.current = true
    dispatch({ type: RUNTIME_EVENT.REJECT })
    const response = await api.reject(toolCall)
    if (!response || response.status === 'error') {
      approvalInFlightRef.current = false
      dispatch({ type: RUNTIME_EVENT.ERROR, error: (response && response.error) || 'reject 실패' })
      return
    }
    approvalInFlightRef.current = false
    dispatch({ type: RUNTIME_EVENT.REJECT_RESOLVED, text: response.text })
  }, [])

  const dismiss = useCallback(() => {
    approvalInFlightRef.current = false
    dispatch({ type: RUNTIME_EVENT.DISMISS })
  }, [])

  // web(브라우저) 실행 시 경고 — Electron 없이도 dev:web에서 상태 확인 가능
  useEffect(() => {
    if (!window.jarvisRuntime) {
      console.warn('[jarvis-runtime] window.jarvisRuntime 없음 — Electron preload 미로드 (dev:web?).')
    }
  }, [])

  return {
    status: state.status,
    text: state.text,
    error: state.error,
    toolCall: state.toolCall,
    projectId: state.projectId,
    traceId: state.traceId,
    tracePath: state.tracePath,
    scratch: state.scratch,
    timeline: state.timeline,
    submit,
    approve,
    reject,
    dismiss,
  }
}