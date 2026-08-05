const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('jarvisWindow', {
  openCommandCenter: () => {
    ipcRenderer.send('window:open-command-center')
  },

  returnToPip: () => {
    ipcRenderer.send('window:return-to-pip')
  },
})