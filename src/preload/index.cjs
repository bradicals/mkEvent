const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('mkEventDesktop', {
  isElectron: true,
  platform: process.platform,
});
