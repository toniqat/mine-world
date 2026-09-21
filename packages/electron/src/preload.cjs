// Preload runs in the sandboxed renderer. Exposes only what the page may need.
const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  platform: process.platform,
  isElectron: true,
});
