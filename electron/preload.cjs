const {
  contextBridge,
  ipcRenderer,
} = require('electron')

contextBridge.exposeInMainWorld(
  'jarvisWindow',
  {
    prepareCommandCenter: () => {
      return ipcRenderer.invoke(
        'window:prepare-command-center',
      )
    },

    expandCommandCenter: () => {
      return ipcRenderer.invoke(
        'window:expand-command-center',
      )
    },

    collapseToPip: () => {
      return ipcRenderer.invoke(
        'window:collapse-to-pip',
      )
    },
  },
)

/*
  JARVIS runtime (Task 1) — renderer는 이 API로만 Python Harness에 접근한다.
  exact-call confirm을 위해 toolCall은 브리지가 준 값 그대로 돌려보낸다.
*/
contextBridge.exposeInMainWorld(
  'jarvisRuntime',
  {
    ping: () => {
      return ipcRenderer.invoke('jarvis:ping')
    },

    chat: (text, projectId) => {
      return ipcRenderer.invoke(
        'jarvis:chat',
        {
          text,
          projectId,
        },
      )
    },

    confirm: (toolCall) => {
      return ipcRenderer.invoke(
        'jarvis:confirm',
        {
          toolCall,
        },
      )
    },

    reject: (toolCall) => {
      return ipcRenderer.invoke(
        'jarvis:reject',
        {
          toolCall,
        },
      )
    },

    bridgeStatus: () => {
      return ipcRenderer.invoke('jarvis:bridge-status')
    },
  },
)

/*
  JARVIS tree (read-only) — 실제 JARVIS state의 구조화 스냅샷.
  Harness가 단일 원천(projects.md + tasks.md)에서 만든다.
*/
contextBridge.exposeInMainWorld(
  'jarvisTree',
  {
    getSnapshot: () => {
      return ipcRenderer.invoke('jarvis:tree-snapshot')
    },

    createTask: (projectId, title, reason) => {
      return ipcRenderer.invoke('jarvis:create-task', {
        projectId,
        title,
        reason,
      })
    },

    updateTask: (projectId, taskId, done) => {
      return ipcRenderer.invoke('jarvis:update-task', {
        projectId,
        taskId,
        done,
      })
    },
  },
)

/*
  JARVIS knowledge pages (read-only) — Markdown 페이지의 재귀 계층.
  PageStore(<memory_dir>/pages)가 단일 원천; bridge pages_snapshot.
*/
contextBridge.exposeInMainWorld(
  'jarvisPages',
  {
    getSnapshot: () => {
      return ipcRenderer.invoke('jarvis:pages-snapshot')
    },
  },
)

/*
  Context Discovery (read-only) — 프로젝트 나열/검색 + 도메인 통합 검색.
  Discovery adapter가 canonical 원천(Task/Project/Page/File store)만 읽는다.
*/
contextBridge.exposeInMainWorld(
  'jarvisDiscovery',
  {
    listProjects: () => {
      return ipcRenderer.invoke('jarvis:discover-projects')
    },

    searchContext: (query, limit) => {
      return ipcRenderer.invoke('jarvis:search-context', {
        query,
        limit,
      })
    },

    filesSnapshot: (root, path, depth) => {
      return ipcRenderer.invoke('jarvis:files-snapshot', {
        root,
        path,
        depth,
      })
    },

    /* RESOURCE LINK V1 — Project↔FileRef semantic links.
       linkProjectFile: direct user action → deterministic canonical write.
       file_id는 FileRef identity(f-*)만 — 경로는 bridge가 하드 거부한다. */
    linkProjectFile: (projectId, fileId, relation) => {
      return ipcRenderer.invoke('jarvis:link-project-file', {
        projectId,
        fileId,
        relation,
      })
    },

    listProjectResources: (projectId) => {
      return ipcRenderer.invoke('jarvis:list-project-resources', {
        projectId,
      })
    },

    unlinkProjectFile: (linkId) => {
      return ipcRenderer.invoke('jarvis:unlink-project-file', {
        linkId,
      })
    },
  },
)

/*
  TTS — ElevenLabs (main holds xi-api-key, renderer sends only final text).
  speak: final Qwen text only — never traces/tool JSON. Failure falls back
  to local Web Speech in renderer (useVoiceOutput).
*/
contextBridge.exposeInMainWorld(
  'jarvisTts',
  {
    speak: (text, options) => {
      return ipcRenderer.invoke('tts:speak', {
        text,
        voiceId: options?.voiceId,
        modelId: options?.modelId,
      })
    },

    stop: () => {
      return ipcRenderer.invoke('tts:stop')
    },

    status: () => {
      return ipcRenderer.invoke('tts:status')
    },
  },
)

/*
  Voice (STEP 2) — 마이크 press/hold → STT 전용 API.
  Qwen으로 보내지 않는다: 여기서 끝나는 것은 transcript 표시다.
*/
contextBridge.exposeInMainWorld(
  'jarvisVoice',
  {
    ping: () => {
      return ipcRenderer.invoke('voice:ping')
    },

    status: () => {
      return ipcRenderer.invoke('voice:status')
    },

    recordStart: (deviceIndex) => {
      return ipcRenderer.invoke(
        'voice:record-start',
        {
          deviceIndex,
        },
      )
    },

    recordStop: () => {
      return ipcRenderer.invoke('voice:record-stop')
    },

    recordCancel: () => {
      return ipcRenderer.invoke('voice:record-cancel')
    },

    transcribeFile: (filePath) => {
      return ipcRenderer.invoke(
        'voice:transcribe-file',
        {
          path: filePath,
        },
      )
    },
  },
)