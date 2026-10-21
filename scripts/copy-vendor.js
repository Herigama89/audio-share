// Copies the PeerJS browser bundle into src/vendor so the app page can load it
// without reaching into node_modules at runtime.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const candidates = [
  'node_modules/peerjs/dist/peerjs.min.js',
  'node_modules/peerjs/dist/peerjs.js'
];
const outDir = path.join(root, 'src', 'vendor');
fs.mkdirSync(outDir, { recursive: true });

const found = candidates.map(p => path.join(root, p)).find(p => fs.existsSync(p));
if (!found) {
  console.error('[copy-vendor] Could not find the PeerJS browser bundle. Run "npm install" again.');
  process.exit(1);
}
fs.copyFileSync(found, path.join(outDir, 'peerjs.min.js'));
console.log('[copy-vendor] Copied', path.relative(root, found), '-> src/vendor/peerjs.min.js');
