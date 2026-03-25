const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  showSaveDialog: (options) => ipcRenderer.invoke('dialog:save', options),
  showNotification: (title, body) => ipcRenderer.invoke('notification:show', title, body),
  isElectron: true,
});
