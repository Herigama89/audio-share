const {
  app, BrowserWindow, ipcMain, session, desktopCapturer,
  systemPreferences, shell, globalShortcut, Menu, dialog
} = require('electron');
const path = require('path');
const control = require('./control');
const updater = require('./updater');
let inCall = false;
updater.setCallChecker(() => inCall);

app.setName('Audio Share');

let win = null;
const sourceCache = new Map();   // desktopCapturer source id -> source
let pendingShare = null;         // what the next getDisplayMedia() call should capture
let controlActive = false;

if (process.env.AUDIOSHARE_SELFTEST) {
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
}

function createWindow() {
  const w = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: 'Audio Share',
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false
    }
  });

  if (!win) win = w;
  w.loadFile(path.join(__dirname, 'src', 'index.html'));

  // Links (e.g. in chat) open in the normal web browser, never inside the app.
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  w.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) {
      e.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });

  w.on('closed', () => {
    if (win === w) { win = null; stopControl(); }
  });
  return w;
}

function setupSession() {
  const ses = session.defaultSession;
  const allowed = new Set(['media', 'display-capture', 'fullscreen', 'clipboard-sanitized-write', 'notifications']);
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(allowed.has(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));

  // Decides what navigator.mediaDevices.getDisplayMedia() captures.
  ses.setDisplayMediaRequestHandler(async (_request, callback) => {
    const share = pendingShare;
    pendingShare = null;
    try {
      if (share && share.mode === 'screen') {
        const src = sourceCache.get(share.sourceId);
        if (src) return callback({ video: src });
      } else if (share && share.mode === 'loopback' && process.platform === 'win32') {
        const sources = await desktopCapturer.getSources({ types: ['screen'] });
        if (sources[0]) return callback({ video: sources[0], audio: 'loopback' });
      }
    } catch (err) {
      console.error('[display-media]', err);
    }
    callback({});
  });
}

function startControl(displayId) {
  control.start(displayId);
  controlActive = true;
  try {
    globalShortcut.register('CommandOrControl+Shift+X', () => {
      if (win) win.webContents.send('control-hotkey-stop');
      stopControl();
    });
  } catch (_) { /* shortcut may be taken by another app */ }
}

function stopControl() {
  if (!controlActive) return;
  controlActive = false;
  control.stop();
  try { globalShortcut.unregister('CommandOrControl+Shift+X'); } catch (_) {}
}

function registerIpc() {
  ipcMain.handle('get-platform', () => process.platform);
  ipcMain.on('call-state', (_e, v) => { inCall = !!v; });

  ipcMain.handle('ask-media-access', async () => {
    if (process.platform !== 'darwin') return { camera: true, microphone: true };
    const out = {};
    for (const kind of ['microphone', 'camera']) {
      try { out[kind] = await systemPreferences.askForMediaAccess(kind); } catch (_) { out[kind] = false; }
    }
    return out;
  });

  ipcMain.handle('get-sources', async () => {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 320, height: 180 },
      fetchWindowIcons: false
    });
    sourceCache.clear();
    return sources
      .filter(s => !(s.name || '').startsWith('Audio Share'))
      .map(s => {
        sourceCache.set(s.id, s);
        return {
          id: s.id,
          name: s.name,
          type: s.id.startsWith('screen') ? 'screen' : 'window',
          displayId: s.display_id || '',
          thumbnail: s.thumbnail && !s.thumbnail.isEmpty() ? s.thumbnail.toDataURL() : ''
        };
      });
  });

  ipcMain.handle('prepare-share', (_e, share) => {
    pendingShare = share;
    return true;
  });

  ipcMain.handle('screen-access-status', () => {
    if (process.platform !== 'darwin') return 'granted';
    try { return systemPreferences.getMediaAccessStatus('screen'); } catch (_) { return 'unknown'; }
  });

  ipcMain.handle('control-check', () => {
    const lib = control.available();
    if (!lib.ok) return { ok: false, reason: 'missing-lib', detail: lib.error };
    if (process.platform === 'darwin') {
      // Passing true shows the macOS prompt that points to Accessibility settings.
      const trusted = systemPreferences.isTrustedAccessibilityClient(true);
      if (!trusted) return { ok: false, reason: 'mac-accessibility' };
    }
    return { ok: true };
  });

  ipcMain.handle('control-start', (_e, displayId) => { startControl(displayId); return true; });
  ipcMain.handle('control-stop', () => { stopControl(); return true; });
  ipcMain.on('control-event', (_e, ev) => { if (controlActive) control.handle(ev); });

  ipcMain.handle('open-privacy-settings', (_e, which) => {
    if (process.platform === 'darwin') {
      const pane = which === 'screen' ? 'Privacy_ScreenCapture' : 'Privacy_Accessibility';
      shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${pane}`);
    }
    return true;
  });

  ipcMain.handle('open-external', (_e, url) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return true;
  });
}

function buildMenu() {
  // A minimal menu keeps copy/paste and other standard shortcuts working.
  const checkItem = { label: 'Check for Updates…', click: () => updater.check({ silent: false }) };
  const aboutItem = {
    label: 'About Audio Share',
    click: () => dialog.showMessageBox(win, { type: 'info', message: 'Audio Share', detail: 'Version ' + app.getVersion(), buttons: ['OK'] })
  };
  const template = [
    ...(process.platform === 'darwin' ? [{
      label: app.name,
      submenu: [aboutItem, checkItem, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }]
    }] : []),
    {
      label: 'File',
      submenu: [checkItem, ...(process.platform === 'darwin' ? [] : [aboutItem]), { type: 'separator' }, process.platform === 'darwin' ? { role: 'close' } : { role: 'quit', label: 'Exit' }]
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [{ role: 'togglefullscreen' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'toggleDevTools' }]
    },
    { role: 'windowMenu' }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  setupSession();
  registerIpc();
  buildMenu();
  const first = createWindow();
  if (process.env.AUDIOSHARE_SELFTEST) require('./selftest')(first, createWindow);
  else if (app.isPackaged) setTimeout(() => updater.check({ silent: true }), 8000);
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('will-quit', () => {
  stopControl();
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => app.quit());
