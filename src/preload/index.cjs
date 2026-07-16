const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mkEventDesktop', {
  isElectron: true,
  platform: process.platform,
  secureSettings: {
    isAvailable: () => ipcRenderer.sendSync('secure-settings:available'),
    load: () => ipcRenderer.sendSync('secure-settings:load'),
    // Sync so callers get a success ack — migration must not purge the
    // plaintext copy unless the encrypted write actually landed.
    save: (json) => ipcRenderer.sendSync('secure-settings:save', json),
  },
  windowControls: {
    minimize: () => ipcRenderer.send('window:minimize'),
    maximizeToggle: () => ipcRenderer.send('window:maximize-toggle'),
    close: () => ipcRenderer.send('window:close'),
    onMaximizedChange: (callback) => {
      const listener = (_event, isMaximized) => callback(isMaximized);
      ipcRenderer.on('window:maximized', listener);
      return () => ipcRenderer.removeListener('window:maximized', listener);
    },
  },
});
