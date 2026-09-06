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