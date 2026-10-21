const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('audioShareNative', {
  getPlatform: () => ipcRenderer.invoke('get-platform'),
  askMediaAccess: () => ipcRenderer.invoke('ask-media-access'),
  getSources: () => ipcRenderer.invoke('get-sources'),
  prepareShare: (share) => ipcRenderer.invoke('prepare-share', share),
  screenAccessStatus: () => ipcRenderer.invoke('screen-access-status'),
  controlCheck: () => ipcRenderer.invoke('control-check'),
  controlStart: (displayId) => ipcRenderer.invoke('control-start', displayId),
  controlStop: () => ipcRenderer.invoke('control-stop'),
  controlEvent: (ev) => ipcRenderer.send('control-event', ev),
  onControlHotkeyStop: (fn) => ipcRenderer.on('control-hotkey-stop', () => fn()),
  openPrivacySettings: (which) => ipcRenderer.invoke('open-privacy-settings', which),
  openExternal: (url) => ipcRenderer.invoke('open-external', url)
});
