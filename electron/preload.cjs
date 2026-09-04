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