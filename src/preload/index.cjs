const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mkEventDesktop', {
  isElectron: true,
  platform: process.platform,
  secureSettings: {
    isAvailable: () => ipcRenderer.sendSync('secure-settings:available'),
    load: () => ipcRenderer.sendSync('secure-settings:load'),
    save: (json) => ipcRenderer.send('secure-settings:save', json),
  },
});
