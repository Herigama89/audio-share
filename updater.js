// In-app updates from the private GitHub repo's Releases.
// Windows: downloads the new installer and installs it silently, then reopens the app.
// Mac: downloads the new .dmg to Downloads and opens it (drag to Applications to replace).
const { app, dialog, net, shell, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const OWNER = 'Herigama89';
const REPO = 'audio-share';

let token = '';
try {
  token = JSON.parse(fs.readFileSync(path.join(__dirname, 'update-token.json'), 'utf8')).token || '';
} catch (_) { /* updates not configured in this copy */ }

let busy = false;
let isInCall = () => false;

function parseVersion(v) {
  return String(v || '').replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
}
function isNewer(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  }
  return false;
}

function apiHeaders(accept) {
  return {
    Authorization: 'Bearer ' + token,
    Accept: accept || 'application/vnd.github+json',
    'User-Agent': 'Audio-Share-Updater',
    'X-GitHub-Api-Version': '2022-11-28'
  };
}

function pickAsset(assets) {
  if (process.platform === 'win32') return assets.find(a => /\.exe$/i.test(a.name));
  if (process.platform === 'darwin') {
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    return assets.find(a => /\.dmg$/i.test(a.name) && a.name.includes(arch)) || assets.find(a => /\.dmg$/i.test(a.name));
  }
  return null;
}

function mainWindow() {
  return BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null;
}

async function download(asset, dest, win) {
  const res = await net.fetch(asset.url, { headers: apiHeaders('application/octet-stream') });
  if (!res.ok) throw new Error('download failed (' + res.status + ')');
  const total = Number(res.headers.get('content-length')) || asset.size || 0;
  const tmp = dest + '.part';
  const out = fs.createWriteStream(tmp);
  const reader = res.body.getReader();
  let got = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      got += value.length;
      if (!out.write(Buffer.from(value))) await new Promise(r => out.once('drain', r));
      if (win && total) win.setProgressBar(got / total);
    }
  } finally {
    await new Promise(r => out.end(r));
    if (win) win.setProgressBar(-1);
  }
  fs.renameSync(tmp, dest);
}

async function check({ silent }) {
  if (busy) return;
  const win = mainWindow();
  const info = (message, detail) => !silent && dialog.showMessageBox(win, { type: 'info', message, detail: detail || '', buttons: ['OK'] });
  if (!token) { info('Updates aren’t set up in this copy of Audio Share.'); return; }
  busy = true;
  try {
    const res = await net.fetch(`https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`, { headers: apiHeaders() });
    if (res.status === 404) { info('You have the latest version.', 'Version ' + app.getVersion()); return; }
    if (!res.ok) throw new Error('GitHub answered ' + res.status);
    const rel = await res.json();
    const latest = (rel.tag_name || '').replace(/^v/, '');
    if (!isNewer(latest, app.getVersion())) { info('You have the latest version.', 'Version ' + app.getVersion()); return; }
    const asset = pickAsset(rel.assets || []);
    if (!asset) { info('A new version (' + latest + ') exists, but there’s no download for this computer yet.'); return; }

    const ask = await dialog.showMessageBox(win, {
      type: 'info',
      message: 'Audio Share ' + latest + ' is available',
      detail: 'You have version ' + app.getVersion() + '. Download it now? (' + Math.round(asset.size / 1048576) + ' MB)',
      buttons: ['Download', 'Later'], defaultId: 0, cancelId: 1
    });
    if (ask.response !== 0) return;

    const folder = process.platform === 'darwin' ? app.getPath('downloads') : app.getPath('temp');
    const dest = path.join(folder, asset.name);
    await download(asset, dest, win);

    if (process.platform === 'win32') {
      const callNote = isInCall() ? ' This will leave your current call.' : '';
      const go = await dialog.showMessageBox(win, {
        type: 'info', message: 'Update downloaded',
        detail: 'Audio Share will close, update, and open again by itself.' + callNote,
        buttons: ['Update now', 'Later'], defaultId: 0, cancelId: 1
      });
      if (go.response !== 0) return;
      const child = spawn(dest, ['/S', '--force-run'], { detached: true, stdio: 'ignore' });
      child.unref();
      setTimeout(() => app.quit(), 300);
    } else if (process.platform === 'darwin') {
      await dialog.showMessageBox(win, {
        type: 'info', message: 'Update downloaded',
        detail: 'The new version is opening now. Quit Audio Share, then drag Audio Share into the Applications folder and choose Replace.',
        buttons: ['OK']
      });
      shell.openPath(dest);
    }
  } catch (err) {
    if (!silent) dialog.showMessageBox(win, { type: 'warning', message: 'Couldn’t check for updates.', detail: String(err && err.message || err), buttons: ['OK'] });
    else console.warn('[updater]', err && err.message);
  } finally {
    busy = false;
  }
}

module.exports = {
  check,
  setCallChecker(fn) { isInCall = fn; },
  configured: () => !!token
};
