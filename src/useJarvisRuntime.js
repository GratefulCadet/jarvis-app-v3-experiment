import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
} from 'react'
import { linkTaskFile } from './jarvisLinkApi'

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
  DISMISS_BRIEFING: 'dismiss-briefing',
  LINK_ACTIVE_FILE: 'link-active-file',
  LINK_ACTIVE_FILE_RESOLVED: 'link-active-file-resolved',
  DISMISS_LINK: 'dismiss-link',
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
  /*
    Resume Briefing (M1 — 복귀 → 이어서 시작).
    bridge events의 resume_briefing tool data를 그대로 보관한다 — 파생·일시적
    표시 상태이며 영속 엔티티가 아니다(V4 §6). 새 브리핑이 오거나 사용자가
    닫을 때까지 유지된다.
  */
  resumeBriefing: null,
  /*
    Task 상태 변경 신호 — Qwen이 tool loop으로 task를 실제로 변경했을 때만 올라간다.

    Tree에서 직접 하는 변경(create/update/delete)은 useJarvisTree가 이미
    canonical snapshot으로 재조회한다. 모델이 만든 변경은 그 경로를 타지 않아
    트리가 수동 refresh까지 낡아 있었다. 이 카운터가 올라가면 트리가 스스로
    재조회한다. boolean이 아니라 단조 카운터인 이유는 같은 값으로 반복 렌더링되어
    effect가 다시 돌지 않기 때문이다.
  */
  taskStateRevision: 0,
  /*
    Milestone B — "생성 직후 관련 자료까지 이어지는 복귀".

    모델이 방금 만든 task(생성된 id는 events 안에만 있다)와, 그 요청에
    함께 실렸던 Active File(identity locator)만 기억한다. 둘 다 파생·일시적
    표시 신호이며 영속 엔티티가 아니다(V4 §6) — canonical ResourceLink는
    사용자가 명시적으로 승인한 뒤에만 생성된다.

    왜 둘이 따로 필요했나: M2의 "Active File → focused Task" 링크는 트리에서
    사용자가 task 노드를 직접 선택해야 나타난다. 모델이 만든 새 task는 선택된
    상태가 아니므로 그 순간 아무 연결 단서도 뜨지 않았다. 이 상태는 그 순간
    필요한 정보 두 개(무엇이 생겼는지, 무엇을 보고 있었는지)만 실어 둔다.
  */
  submittedActiveFile: null,
  createdTask: null,
  linkState: {
    status: 'idle',
    error: null,
    taskId: null,
    taskTitle: null,
    fileName: null,
  },
})

const pushTimeline = (state, entry) => ({
  ...state,
  timeline: [...state.timeline, { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, ...entry }],
})

/*
  모델 tool loop으로 task 상태를 바꾸는 도구.

  registry에서 write 분류인 것은 create_task 하나뿐이며, 나머지 task 변경은
  Tree가 deterministic bridge message로 직접 보낸다(그쪽은 이미 refresh된다).
  도구가 추가되면 여기에 한 줄만 더하면 되고, 트리는 그때부터 따라간다.
*/
const TASK_MUTATING_TOOLS = new Set(['create_task'])

/*
  이 응답이 task 상태를 실제로 바꿨는지 판정.

  ok가 true인 실행만 센다 — awaiting_confirmation으로 막힌 call은
  requires_confirmation이고 handler가 실행되지 않았으므로 상태가 바뀌지 않았다.
  그걸 세면 사용자가 승인도 하지 않은 작업을 트리가 되돌아가며 갱신한다.
*/
export const eventsMutatedTasks = (events = []) => {
  for (const event of events) {
    if (!event || event.kind !== 'tool') continue
    if (!TASK_MUTATING_TOOLS.has(event.name)) continue
    if (event.requires_confirmation) continue
    if (event.ok !== true) continue
    return true
  }
  return false
}

/*
  응답 events에서 "이번 턴에 실제로 만들어진 task"를 꺼낸다.

  task_id는 create_task 인자에 없다 — 모델은 생성된 id를 모르고 TaskStore가
  발급한다. 그래서 id는 실행 결과 data에만 존재한다(requires_confirmation이
  아니고 ok여야 실제로 만들어진 것이다). project_id는 인자에 있으므로 둘을
  함께 읽으면 검증에 쓰인 프로젝트까지 알 수 있다.
*/
export const createdTaskFromEvents = (events = []) => {
  for (const event of events) {
    if (!event || event.kind !== 'tool') continue
    if (event.name !== 'create_task') continue
    if (event.requires_confirmation) continue
    if (event.ok !== true) continue
    const data = event.data || {}
    if (!data.id) continue
    return {
      id: data.id,
      title: data.title || '',
      projectId: data.project_id || (event.arguments || {}).project_id || '',
    }
  }
  return null
}

/*
  링크 affordance를 만들 수 있는지 판단한다.

  조건은 둘뿐이다 — (1) 방금 생성된 task가 있고 (2) 그 요청에 실렸던 Active
  File에 stable FileRef identity(file_id)가 있다. 하나라도 없으면 아무것도
  제안하지 않는다. 경로만 있고 identity가 없는 파일은 bridge도 링크를
  거부하므로 애초에 후보가 아니다. 자동 연결은 없다 — 이 함수는 "보여줄
  근거가 있는가"만 판정하고, 링크 생성은 사용자의 명시적 클릭에서만 일어난다.
*/
export const selectLinkAffordance = (state) => {
  const created = state && state.createdTask
  const active = state && state.submittedActiveFile
  if (!created || !created.id) return null
  if (!active || !active.fileId) return null
  const linkState = (state && state.linkState) || { status: 'idle' }
  if (linkState.status === 'done') return null
  return {
    taskId: created.id,
    taskTitle: created.title,
    fileId: active.fileId,
    fileName: active.name || active.path || '',
  }
}

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
        // 새 요청이 시작되면 이전 턴의 링크 후보는 무효다.
        submittedActiveFile: (event.activeFile && event.activeFile.fileId)
          ? {
              fileId: event.activeFile.fileId,
              rootId: event.activeFile.rootId || '',
              path: event.activeFile.path || '',
              name: event.activeFile.label || event.activeFile.name || '',
            }
          : null,
        createdTask: null,
        linkState: {
          status: 'idle',
          error: null,
          taskId: null,
          taskTitle: null,
          fileName: null,
        },
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
          resumeBriefing:
            extractResumeBriefing(event.events) || state.resumeBriefing,
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
        resumeBriefing:
          extractResumeBriefing(event.events) || state.resumeBriefing,
        taskStateRevision: eventsMutatedTasks(event.events)
          ? state.taskStateRevision + 1
          : state.taskStateRevision,
        // Milestone B — 실제로 생성된 task가 있으면 id를 기억한다(파생 신호).
        createdTask: createdTaskFromEvents(event.events),
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
        resumeBriefing:
          extractResumeBriefing(event.events) || state.resumeBriefing,
        // 승인이 실제 실행으로 이어진 경우 — 여기서 task가 처음으로 바뀐다.
        taskStateRevision: eventsMutatedTasks(event.events)
          ? state.taskStateRevision + 1
          : state.taskStateRevision,
        // Milestone B — 승인이 실제 생성으로 이어졌을 때의 생성된 task id.
        createdTask: createdTaskFromEvents(event.events),
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
        createdTask: null,
        linkState: {
          status: 'idle',
          error: null,
          taskId: null,
          taskTitle: null,
          fileName: null,
        },
      }

    case RUNTIME_EVENT.LINK_ACTIVE_FILE:
      return {
        ...state,
        linkState: {
          ...state.linkState,
          status: 'busy',
          error: null,
        },
      }

    case RUNTIME_EVENT.LINK_ACTIVE_FILE_RESOLVED:
      if (!event.ok) {
        return {
          ...state,
          linkState: {
            ...state.linkState,
            status: 'error',
            error: event.error || '링크에 실패했습니다',
          },
        }
      }
      return {
        ...state,
        // 링크가 canonical state에 생겼으므로 트리는 다시 읽어야 한다.
        // 같은 단조 카운터를 재사용해 새로고침 경로를 하나만 둔다.
        taskStateRevision: state.taskStateRevision + 1,
        linkState: {
          status: 'done',
          error: null,
          taskId: event.taskId,
          taskTitle: event.taskTitle,
          fileName: event.fileName,
        },
      }

    case RUNTIME_EVENT.DISMISS_LINK:
      return {
        ...state,
        createdTask: null,
        linkState: {
          status: 'idle',
          error: null,
          taskId: null,
          taskTitle: null,
          fileName: null,
        },
      }

    case RUNTIME_EVENT.DISMISS_BRIEFING:
      return {
        ...state,
        resumeBriefing: null,
      }

    default:
      return state
  }
}

/*
  events에서 resume_briefing read tool의 data를 추출한다.
  브리지는 trace tool_results의 data를 그대로 실어 나르므로 별도 채널이
  필요 없다 — 결정적 조립 결과가 왜곡 없이 UI에 도착한다.
*/
const extractResumeBriefing = (events = []) => {
  let briefing = null
  for (const event of events) {
    if (
      event.kind === 'tool' &&
      event.name === 'resume_briefing' &&
      event.ok &&
      event.data &&
      event.data.status === 'ok'
    ) {
      briefing = event.data
    }
  }
  return briefing
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
      // Milestone B — 이 요청과 함께 보고 있던 파일을 기억해 둔다.
      activeFile: (options && options.activeFile) || null,
    })
    /*
      Active File — 열려 있는 파일의 identity locator만 전송한다(내용 없음).
      JARVIS는 기존 read 경로로 저장된 현재 파일시스템 내용을 스스로 읽는다.
    */
    const activeFile = options && options.activeFile
    const response = await api.chat(trimmed, projectId || DEFAULT_PROJECT, activeFile)

    if (!response || response.status === 'error') {
      dispatch({ type: RUNTIME_EVENT.ERROR, error: (response && response.error) || '브리지 응답이 없습니다' })
      return
    }
    if (response.status === 'awaiting_confirmation') {
      dispatch({
        type: RUNTIME_EVENT.PERMISSION_REQUIRED,
        toolCall: response.tool_call,
        events: response.events,
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
        events: response.events,
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

  const dismissBriefing = useCallback(() => {
    dispatch({ type: RUNTIME_EVENT.DISMISS_BRIEFING })
  }, [])

  /*
    Milestone B — 사용자의 명시적 클릭에서만 canonical ResourceLink를 만든다.

    jarvisLinkApi.linkTaskFile은 트리 팝오버와 App의 M2 링크가 이미 쓰는
    유일한 정규화 경로다(동일한 검증·동일한 resource_links.json 단일 writer).
    새 write path를 만들지 않고 그 경로를 재사용한다. 자동 실행은 없다 —
    이 콜백은 버튼 onClick에서만 불린다.
  */
  const linkActiveFile = useCallback(async () => {
    const current = stateRef.current
    const affordance = selectLinkAffordance(current)
    if (!affordance) return { ok: false, error: '연결할 작업/파일이 없습니다' }
    if (current.linkState.status === 'busy') {
      return { ok: false, error: '이미 연결하는 중입니다' }
    }

    dispatch({ type: RUNTIME_EVENT.LINK_ACTIVE_FILE })
    const result = await linkTaskFile({
      taskId: affordance.taskId,
      fileId: affordance.fileId,
      relation: 'reference',
    })
    dispatch({
      type: RUNTIME_EVENT.LINK_ACTIVE_FILE_RESOLVED,
      ok: Boolean(result && result.ok),
      error: result && result.error,
      taskId: affordance.taskId,
      taskTitle: affordance.taskTitle,
      fileName: affordance.fileName,
    })
    return result
  }, [])

  const dismissLinkAffordance = useCallback(() => {
    dispatch({ type: RUNTIME_EVENT.DISMISS_LINK })
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
    resumeBriefing: state.resumeBriefing,
    taskStateRevision: state.taskStateRevision,
    // Milestone B — 파생 표시 신호(영속 엔티티 아님).
    linkAffordance: selectLinkAffordance(state),
    linkState: state.linkState,
    submit,
    approve,
    reject,
    dismiss,
    dismissBriefing,
    linkActiveFile,
    dismissLinkAffordance,
  }
}