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