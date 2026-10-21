/* Audio Share — renderer
 * Everyone in a room connects directly to everyone else (a "mesh").
 * The person who starts the room owns the room code on the free PeerJS
 * connection service; newcomers ask them who else is there, then connect
 * to each person directly. Audio, video, chat and files never go through a server.
 */
'use strict';

const $ = (id) => document.getElementById(id);
const desktop = window.audioShareNative || null;   // provided by preload.js inside the app

// ---------------------------------------------------------------- constants
const ROOM_PREFIX = 'audioshare-v1-';
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const FILE_CHUNK = 15000;                 // stays under PeerJS's own chunking size
const FILE_MAX_BUFFER = 4 * 1024 * 1024;  // back-pressure threshold
const FILE_WARN_SIZE = 2 * 1024 * 1024 * 1024;
const LOOPBACK_ID = '__loopback__';

// ---------------------------------------------------------------- state
const S = {
  platform: 'unknown',
  peer: null,
  myId: null,
  myName: '',
  roomCode: '',
  isHost: false,
  hostId: '',
  joined: false,
  leaving: false,
  peers: new Map(),          // id -> peer record
  local: { cam: null, screen: null, daw: null, dawRaw: null, screenInfo: null },
  micOn: true,
  camOn: true,
  hasVideo: false,
  control: { grantedTo: null, controlling: null, pendingRequest: null },
  files: new Map(),          // incoming file id -> transfer
  settings: loadSettings(),
};

function loadSettings() {
  const d = { micId: '', camId: '', voiceCleanup: true, dawSource: '', dawMonitor: false, turnUrl: '', turnUser: '', turnPass: '' };
  try { return Object.assign(d, JSON.parse(localStorage.getItem('as-settings') || '{}')); } catch (_) { return d; }
}
function saveSettings() {
  try { localStorage.setItem('as-settings', JSON.stringify(S.settings)); } catch (_) {}
}

// ---------------------------------------------------------------- helpers
function toast(text, kind) {
  const el = document.createElement('div');
  el.className = 'toast' + (kind === 'error' ? ' error' : '');
  el.textContent = text;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), kind === 'error' ? 6000 : 3500);
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function randomId(n = 10) {
  const a = new Uint8Array(n); crypto.getRandomValues(a);
  return Array.from(a, b => (b % 36).toString(36)).join('');
}
function makeCode() {
  const a = new Uint8Array(6); crypto.getRandomValues(a);
  return Array.from(a, b => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}
function normalizeCode(s) { return (s || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }
function prettyCode(c) { return c.length === 6 ? c.slice(0, 3) + '-' + c.slice(3) : c; }
function initials(name) {
  const parts = (name || '?').trim().split(/\s+/).filter(Boolean);
  return ((parts[0] || '?')[0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
}
function fmtSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 ** 2) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 ** 3) return (n / 1024 ** 2).toFixed(1) + ' MB';
  return (n / 1024 ** 3).toFixed(2) + ' GB';
}
function nameOf(id) {
  if (id === S.myId) return S.myName;
  const p = S.peers.get(id);
  return (p && p.name) || 'A friend';
}
const isMac = () => S.platform === 'darwin';
const isWin = () => S.platform === 'win32';

function iceServers() {
  const list = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ];
  const t = S.settings;
  if (t.turnUrl) list.push({ urls: t.turnUrl.split(',').map(s => s.trim()).filter(Boolean), username: t.turnUser, credential: t.turnPass });
  return list;
}

// Opus settings for music: stereo, high bitrate, no voice-oriented tricks.
function musicSdp(sdp) {
  const m = sdp.match(/a=rtpmap:(\d+) opus\/48000\/2/i);
  if (!m) return sdp;
  const pt = m[1];
  const re = new RegExp('a=fmtp:' + pt + ' ([^\\r\\n]*)');
  const want = { stereo: '1', 'sprop-stereo': '1', maxaveragebitrate: '510000', maxplaybackrate: '48000', cbr: '0', useinbandfec: '1', usedtx: '0' };
  if (re.test(sdp)) {
    return sdp.replace(re, (_all, params) => {
      const map = {};
      params.split(';').forEach(kv => { const [k, v] = kv.split('='); if (k) map[k.trim()] = (v || '').trim(); });
      Object.assign(map, want);
      return 'a=fmtp:' + pt + ' ' + Object.entries(map).map(([k, v]) => k + '=' + v).join(';');
    });
  }
  return sdp.replace(m[0], m[0] + '\r\na=fmtp:' + pt + ' ' + Object.entries(want).map(([k, v]) => k + '=' + v).join(';'));
}

// ---------------------------------------------------------------- startup
(async function init() {
  if (desktop) { try { S.platform = await desktop.getPlatform(); } catch (_) {} }
  if (!window.Peer) {
    setLobbyStatus('Something is missing from this copy of the app (PeerJS). Please reinstall.', true);
  }
  try { $('nameInput').value = localStorage.getItem('as-name') || ''; } catch (_) {}
  $('createBtn').onclick = () => startRoom(null);
  $('joinBtn').onclick = () => startRoom($('codeInput').value);
  $('codeInput').addEventListener('keydown', e => { if (e.key === 'Enter') startRoom($('codeInput').value); });
  $('codeInput').addEventListener('input', e => {
    const c = normalizeCode(e.target.value).slice(0, 6);
    e.target.value = c.length > 3 ? c.slice(0, 3) + '-' + c.slice(3) : c;
  });
  wireRoomUi();
  if (desktop) desktop.onControlHotkeyStop(() => revokeControl(true));
  window.addEventListener('beforeunload', () => { try { broadcast({ t: 'bye' }); } catch (_) {} });
})();

function setLobbyStatus(text, isError) {
  const el = $('lobbyStatus');
  el.textContent = text || '';
  el.classList.toggle('error', !!isError);
}
function setLobbyBusy(busy) {
  $('createBtn').disabled = busy; $('joinBtn').disabled = busy;
}

// ---------------------------------------------------------------- local media
function micConstraints() {
  const clean = S.settings.voiceCleanup;
  const c = { echoCancellation: clean, noiseSuppression: clean, autoGainControl: clean };
  if (S.settings.micId) c.deviceId = { exact: S.settings.micId };
  return c;
}
function camConstraints() {
  const c = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } };
  if (S.settings.camId) c.deviceId = { exact: S.settings.camId };
  return c;
}

async function getCamStream() {
  if (desktop && isMac()) { try { await desktop.askMediaAccess(); } catch (_) {} }
  const attempts = [
    { audio: micConstraints(), video: camConstraints() },
    { audio: { ...micConstraints(), deviceId: undefined }, video: { width: { ideal: 1280 }, height: { ideal: 720 } } },
    { audio: micConstraints() },
    { audio: true },
  ];
  for (const a of attempts) {
    try { return await navigator.mediaDevices.getUserMedia(a); } catch (_) { /* try the next one */ }
  }
  return null;
}

// ---------------------------------------------------------------- rooms
async function startRoom(rawCode) {
  const name = $('nameInput').value.trim();
  if (!name) { setLobbyStatus('Type your name first.', true); $('nameInput').focus(); return; }
  if (!window.Peer) return;
  const joining = rawCode !== null;
  const code = joining ? normalizeCode(rawCode) : makeCode();
  if (joining && code.length !== 6) { setLobbyStatus('Room codes have 6 letters/numbers, like ABC-123.', true); return; }

  try { localStorage.setItem('as-name', name); } catch (_) {}
  S.myName = name;
  S.roomCode = code;
  S.isHost = !joining;
  S.hostId = ROOM_PREFIX + code;
  S.leaving = false;
  setLobbyBusy(true);
  setLobbyStatus('Getting your camera and mic ready…');

  if (!S.local.cam) S.local.cam = await getCamStream();
  if (!S.local.cam) toast('No camera or mic found — you can still chat and listen.', 'error');
  S.hasVideo = !!(S.local.cam && S.local.cam.getVideoTracks().length);
  S.camOn = S.hasVideo;
  S.micOn = !!(S.local.cam && S.local.cam.getAudioTracks().length);

  setLobbyStatus(joining ? 'Finding the room…' : 'Creating your room…');
  openPeer(joining ? undefined : S.hostId);
}

function openPeer(id) {
  const opts = { debug: 1, config: { iceServers: iceServers() } };
  const peer = id ? new Peer(id, opts) : new Peer(randomId(14), opts);
  S.peer = peer;

  peer.on('open', (myId) => {
    S.myId = myId;
    if (S.isHost) {
      enterRoom();
    } else {
      const conn = peer.connect(S.hostId, { reliable: true, serialization: 'binary', metadata: { name: S.myName } });
      setupConn(conn, true);
      // If the room doesn't answer in time, say so.
      setTimeout(() => {
        if (!S.joined && S.peer === peer && !S.leaving) {
          setLobbyStatus('Could not reach that room. Check the code and that your friend is still in it.', true);
          teardown();
        }
      }, 15000);
    }
  });

  peer.on('connection', (conn) => setupConn(conn, false));
  peer.on('call', onIncomingCall);

  peer.on('disconnected', () => {
    if (S.leaving || S.peer !== peer) return;
    setNet('Reconnecting…', true);
    setTimeout(() => { if (!peer.destroyed && peer.disconnected) peer.reconnect(); }, 1500);
  });

  peer.on('error', (err) => {
    const type = err && err.type;
    console.warn('[peer error]', type, err);
    if (type === 'unavailable-id' && S.isHost && !S.joined) {
      // Extremely unlikely code clash — pick another code.
      teardown(true);
      S.roomCode = makeCode(); S.hostId = ROOM_PREFIX + S.roomCode;
      openPeer(S.hostId);
      return;
    }
    if (type === 'peer-unavailable') {
      if (!S.joined) {
        setLobbyStatus('No room with that code. Check it and try again.', true);
        teardown();
      }
      return;  // a single friend vanished; their tile goes away on its own
    }
    if (type === 'network' || type === 'server-error' || type === 'socket-error' || type === 'socket-closed') {
      if (!S.joined) { setLobbyStatus('Can’t reach the connection service. Check your internet and try again.', true); teardown(); }
      else setNet('Reconnecting…', true);
      return;
    }
    if (type === 'browser-incompatible') { setLobbyStatus('This computer can’t run calls.', true); teardown(); return; }
    if (!S.joined) { setLobbyStatus('Something went wrong (' + (type || 'unknown') + '). Try again.', true); teardown(); }
  });

  peer.on('open', () => setNet('Connected', false));
}

function setNet(text, warn) {
  const el = $('netStatus');
  el.textContent = text;
  el.classList.toggle('pill-ok', !warn);
  el.classList.toggle('pill-warn', !!warn);
}

function enterRoom() {
  if (S.joined) return;
  S.joined = true;
  if (desktop) desktop.setInCall(true);
  setLobbyBusy(false);
  setLobbyStatus('');
  $('lobby').classList.add('hidden');
  $('room').classList.remove('hidden');
  $('roomCodeText').textContent = prettyCode(S.roomCode);
  ensureLocalTile();
  updateButtons();
  updatePeopleCount();
  addSystemMessage(S.isHost
    ? 'Room created. Send your friends the code ' + prettyCode(S.roomCode) + '.'
    : 'You joined the room.');
}

function teardown(keepMedia) {
  const peer = S.peer;
  S.peer = null;
  if (peer) { try { peer.destroy(); } catch (_) {} }
  setLobbyBusy(false);
  if (!keepMedia && !S.joined) stopLocalStreams();
}

function stopLocalStreams() {
  for (const k of ['cam', 'screen', 'daw', 'dawRaw']) {
    const s = S.local[k];
    if (s) s.getTracks().forEach(t => t.stop());
    S.local[k] = null;
  }
  stopDawMonitor();
  stopDawMeter();
}

async function leaveRoom() {
  S.leaving = true;
  try { broadcast({ t: 'bye' }); } catch (_) {}
  if (S.control.grantedTo) await revokeControl(false);
  S.control.controlling = null;
  await sleep(150);
  for (const p of [...S.peers.values()]) removePeer(p.id, true);
  stopLocalStreams();
  if (S.peer) { try { S.peer.destroy(); } catch (_) {} }
  S.peer = null; S.joined = false; S.isHost = false; S.myId = null;
  if (desktop) desktop.setInCall(false);
  S.local.screenInfo = null;
  $('featured').innerHTML = ''; $('gallery').innerHTML = ''; $('chatList').innerHTML = '';
  $('room').classList.add('hidden');
  $('lobby').classList.remove('hidden');
  $('controlBanner').classList.add('hidden');
  setLobbyStatus('');
}

// ---------------------------------------------------------------- peers & data
function getPeer(id) {
  let p = S.peers.get(id);
  if (!p) {
    p = { id, name: '', conn: null, out: {}, in: {}, streams: {}, mic: true, cam: true, screenInfo: null, tiles: {}, dawAudio: null, dawVolume: 1 };
    S.peers.set(id, p);
  }
  return p;
}

function setupConn(conn, outgoing) {
  conn._outgoing = outgoing;
  const onOpen = () => attachConn(conn);
  if (conn.open) onOpen(); else conn.on('open', onOpen);
  conn.on('data', (msg) => {
    const p = S.peers.get(conn.peer);
    if (!p || p.conn !== conn) return;
    try { handleData(p, msg); } catch (err) { console.error('[data]', err); }
  });
  conn.on('close', () => {
    const p = S.peers.get(conn.peer);
    if (p && p.conn === conn) removePeer(conn.peer);
  });
  conn.on('error', (e) => console.warn('[conn error]', e));
}

function attachConn(conn) {
  const id = conn.peer;
  const p = getPeer(id);
  if (p.conn && p.conn !== conn && p.conn.open) {
    // Both sides opened a connection at once: keep the one started by the "smaller" id.
    const initiator = (c) => (c._outgoing ? S.myId : id);
    const keepNew = initiator(conn) < initiator(p.conn);
    if (!keepNew) { try { conn.close(); } catch (_) {} return; }
    const old = p.conn; p.conn = conn; try { old.close(); } catch (_) {}
  } else {
    p.conn = conn;
  }
  if (conn.metadata && conn.metadata.name && !p.name) p.name = conn.metadata.name;

  // Room owner tells the newcomer who else is here (done after their 'hello').
  if (!S.isHost && id === S.hostId) enterRoom();

  send(p, { t: 'hello', name: S.myName, mic: S.micOn, cam: S.camOn && S.hasVideo });
  if (S.local.screenInfo) send(p, { t: 'screen-info', ...S.local.screenInfo });
  ensurePeerTile(p);
  updatePeopleCount();

  // Send them whatever we're currently sharing.
  for (const kind of ['cam', 'screen', 'daw']) if (S.local[kind]) callPeer(p, kind);
}

function send(p, msg) {
  if (p && p.conn && p.conn.open) {
    try { p.conn.send(msg); return true; } catch (err) { console.warn('[send]', err); }
  }
  return false;
}
function broadcast(msg) { for (const p of S.peers.values()) send(p, msg); }

function handleData(p, msg) {
  if (!msg || typeof msg !== 'object') return;
  switch (msg.t) {
    case 'hello': {
      const isNew = !p.name;
      p.name = String(msg.name || 'A friend').slice(0, 30);
      p.mic = msg.mic !== false; p.cam = !!msg.cam;
      updatePeerTile(p);
      if (S.isHost) {
        const members = [...S.peers.values()]
          .filter(x => x.id !== p.id && x.conn && x.conn.open)
          .map(x => ({ id: x.id, name: x.name }));
        send(p, { t: 'welcome', members });
        for (const x of S.peers.values()) if (x.id !== p.id) send(x, { t: 'member-joined', id: p.id, name: p.name });
      }
      if (isNew) addSystemMessage(p.name + ' joined.');
      break;
    }
    case 'welcome':
      if (p.id !== S.hostId) break;
      for (const m of msg.members || []) connectTo(m.id, m.name);
      break;
    case 'member-joined':
      if (p.id !== S.hostId || !msg.id || msg.id === S.myId) break;
      // Normally the newcomer connects to us. If that hasn't happened shortly, we reach out.
      setTimeout(() => {
        const x = S.peers.get(msg.id);
        if ((!x || !x.conn || !x.conn.open) && S.joined) connectTo(msg.id, msg.name);
      }, 4000);
      break;
    case 'state':
      p.mic = msg.mic !== false; p.cam = !!msg.cam;
      updatePeerTile(p);
      break;
    case 'chat':
      addChatMessage(p.name, String(msg.text || '').slice(0, 5000), false);
      break;
    case 'file-start': onFileStart(p, msg); break;
    case 'file-chunk': onFileChunk(p, msg); break;
    case 'file-end': onFileEnd(p, msg); break;
    case 'file-cancel': onFileCancel(p, msg); break;
    case 'stream-stop':
      if (p.in[msg.kind]) { try { p.in[msg.kind].close(); } catch (_) {} delete p.in[msg.kind]; }
      detachRemote(p, msg.kind);
      if (msg.kind === 'screen') { p.screenInfo = null; if (S.control.controlling === p.id) stopControlling(false); }
      break;
    case 'screen-info':
      p.screenInfo = { type: msg.type, controllable: !!msg.controllable };
      updateScreenTools(p);
      break;
    case 'ctl-request': onControlRequest(p); break;
    case 'ctl-grant': startControlling(p); break;
    case 'ctl-deny':
      p._ctlPending = false; updateScreenTools(p);
      toast(msg.reason === 'busy' ? p.name + ' is already letting someone else control.' :
            msg.reason === 'setup' ? p.name + ' needs to finish a one-time setup first.' :
            p.name + ' said no to control.');
      break;
    case 'ctl-revoke':
      if (S.control.controlling === p.id) { stopControlling(false); toast(p.name + ' took back control.'); }
      if (S.control.grantedTo === p.id) revokeControl(false);
      break;
    case 'ctl':
      if (S.control.grantedTo === p.id && desktop) desktop.controlEvent(msg.ev);
      break;
    case 'bye':
      removePeer(p.id);
      break;
  }
}

function connectTo(id, name) {
  if (!S.peer || !id || id === S.myId) return;
  const existing = S.peers.get(id);
  if (existing && existing.conn && existing.conn.open) return;
  const p = getPeer(id);
  if (name && !p.name) p.name = name;
  const conn = S.peer.connect(id, { reliable: true, serialization: 'binary', metadata: { name: S.myName } });
  setupConn(conn, true);
}

function removePeer(id, silent) {
  const p = S.peers.get(id);
  if (!p) return;
  S.peers.delete(id);
  if (S.control.grantedTo === id) revokeControl(false);
  if (S.control.controlling === id) stopControlling(false);
  for (const c of [...Object.values(p.out), ...Object.values(p.in)]) { try { c.close(); } catch (_) {} }
  try { if (p.conn) p.conn.close(); } catch (_) {}
  for (const kind of ['cam', 'screen', 'daw']) detachRemote(p, kind);
  for (const t of Object.values(p.tiles)) t.remove();
  for (const [fid, f] of S.files) if (f.from === id) { failIncoming(fid, 'Stopped — ' + (p.name || 'sender') + ' left.'); }
  stopSpeakingMonitor(id);
  if (!silent && p.name && S.joined) addSystemMessage(p.name + ' left.');
  if (!silent && id === S.hostId && S.joined) addSystemMessage('The person who started the room left. You can keep talking, but new people can’t join with this code.');
  updatePeopleCount();
  layoutStage();
}

function updatePeopleCount() {
  const n = 1 + [...S.peers.values()].filter(p => p.conn && p.conn.open).length;
  $('peopleCount').textContent = n + (n === 1 ? ' person' : ' people');
}

// ---------------------------------------------------------------- media calls
function callPeer(p, kind) {
  const stream = S.local[kind];
  if (!stream || !S.peer) return;
  if (p.out[kind]) { try { p.out[kind].close(); } catch (_) {} }
  const opts = { metadata: { kind } };
  if (kind === 'daw') opts.sdpTransform = musicSdp;
  let call;
  try { call = S.peer.call(p.id, stream, opts); } catch (err) { console.warn('[call]', err); return; }
  if (!call) return;
  p.out[kind] = call;
  call.on('error', e => console.warn('[call error]', kind, e));
  if (kind === 'daw') tuneMusicSender(call);
  if (kind === 'screen') tuneScreenSender(call);
}

async function onSenderReady(call, fn) {
  for (let i = 0; i < 60; i++) {
    const pc = call.peerConnection;
    if (pc && (pc.connectionState === 'connected' || pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed')) {
      try { await fn(pc); } catch (err) { console.warn('[sender tune]', err); }
      return;
    }
    if (!call.open && i > 40) return;
    await sleep(500);
  }
}
function tuneMusicSender(call) {
  onSenderReady(call, async (pc) => {
    for (const s of pc.getSenders()) {
      if (!s.track || s.track.kind !== 'audio') continue;
      const params = s.getParameters();
      if (!params.encodings || !params.encodings.length) params.encodings = [{}];
      params.encodings[0].maxBitrate = 510000;
      params.encodings[0].priority = 'high';
      params.encodings[0].networkPriority = 'high';
      await s.setParameters(params);
    }
  });
}
function tuneScreenSender(call) {
  onSenderReady(call, async (pc) => {
    for (const s of pc.getSenders()) {
      if (!s.track || s.track.kind !== 'video') continue;
      const params = s.getParameters();
      if (!params.encodings || !params.encodings.length) params.encodings = [{}];
      params.encodings[0].maxBitrate = 4000000;
      params.degradationPreference = 'maintain-resolution';
      await s.setParameters(params);
    }
  });
}

function onIncomingCall(call) {
  const kind = (call.metadata && call.metadata.kind) || 'cam';
  if (!['cam', 'screen', 'daw'].includes(kind)) { try { call.close(); } catch (_) {} return; }
  const p = getPeer(call.peer);
  if (p.in[kind] && p.in[kind] !== call) { try { p.in[kind].close(); } catch (_) {} }
  p.in[kind] = call;
  call.answer(undefined, kind === 'daw' ? { sdpTransform: musicSdp } : {});
  call.on('stream', (stream) => { if (p.in[kind] === call) attachRemote(p, kind, stream); });
  call.on('close', () => { if (p.in[kind] === call) { delete p.in[kind]; detachRemote(p, kind); } });
  call.on('error', e => console.warn('[incoming call error]', kind, e));
  // Drop calls from someone who never actually joins the room.
  setTimeout(() => { if (S.peers.get(p.id) === p && !(p.conn && p.conn.open)) removePeer(p.id, true); }, 15000);
}

function stopSharing(kind) {
  const s = S.local[kind];
  if (!s) return;
  for (const p of S.peers.values()) {
    if (p.out[kind]) { try { p.out[kind].close(); } catch (_) {} delete p.out[kind]; }
    send(p, { t: 'stream-stop', kind });
  }
  s.getTracks().forEach(t => t.stop());
  S.local[kind] = null;
}

// ---------------------------------------------------------------- tiles
function makeTile({ key, local, screen }) {
  const tile = document.createElement('div');
  tile.className = 'tile' + (local ? ' local' : '') + (screen ? ' screen-tile' : '');
  tile.dataset.key = key;
  const video = document.createElement('video');
  video.autoplay = true; video.playsInline = true;
  if (local || screen) video.muted = true;
  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.appendChild(document.createElement('b'));
  const label = document.createElement('div');
  label.className = 'label';
  const tools = document.createElement('div');
  tools.className = 'tile-tools';
  tile.append(video, avatar, label, tools);
  return tile;
}

function ensureLocalTile() {
  let t = document.querySelector('.tile[data-key="me:cam"]');
  if (!t) {
    t = makeTile({ key: 'me:cam', local: true });
    $('gallery').prepend(t);
  }
  const v = t.querySelector('video');
  if (S.local.cam && v.srcObject !== S.local.cam) v.srcObject = S.local.cam;
  t.querySelector('.avatar b').textContent = initials(S.myName);
  t.querySelector('.avatar').classList.toggle('hidden', S.camOn && S.hasVideo);
  renderLabel(t, {
    name: S.myName + ' (you)', mic: S.micOn,
    daw: S.local.daw ? 'Sharing DAW audio' : null,
  });
  if (S.local.cam && S.local.cam.getAudioTracks().length) startSpeakingMonitor('me', S.local.cam, t);
  layoutStage();
}

function ensurePeerTile(p) {
  if (!p.tiles.cam) {
    p.tiles.cam = makeTile({ key: p.id + ':cam' });
    $('gallery').appendChild(p.tiles.cam);
  }
  updatePeerTile(p);
}

function updatePeerTile(p) {
  const t = p.tiles.cam;
  if (!t) return;
  t.querySelector('.avatar b').textContent = initials(p.name);
  const hasLiveVideo = p.streams.cam && p.streams.cam.getVideoTracks().length > 0;
  t.querySelector('.avatar').classList.toggle('hidden', !!(hasLiveVideo && p.cam));
  renderLabel(t, { name: p.name || 'Connecting…', mic: p.mic, dawPeer: p.streams.daw ? p : null });
  if (p.tiles.screen) p.tiles.screen.querySelector('.label .tag').textContent = (p.name || 'Friend') + '’s screen';
}

function renderLabel(tile, { name, mic, daw, dawPeer }) {
  const label = tile.querySelector('.label');
  label.textContent = '';
  const n = document.createElement('span');
  n.className = 'tag'; n.textContent = name;
  label.appendChild(n);
  if (mic === false) {
    const m = document.createElement('span');
    m.className = 'tag muted-mic'; m.textContent = 'Muted';
    label.appendChild(m);
  }
  if (daw) {
    const d = document.createElement('span');
    d.className = 'tag daw'; d.textContent = '♪ ' + daw;
    label.appendChild(d);
  }
  if (dawPeer) {
    const d = document.createElement('span');
    d.className = 'tag daw';
    d.textContent = '♪ DAW';
    const r = document.createElement('input');
    r.type = 'range'; r.min = '0'; r.max = '1'; r.step = '0.01'; r.value = String(dawPeer.dawVolume);
    r.title = 'Volume of ' + (dawPeer.name || 'their') + '’s music';
    r.oninput = () => { dawPeer.dawVolume = Number(r.value); if (dawPeer.dawAudio) dawPeer.dawAudio.volume = dawPeer.dawVolume; };
    d.appendChild(r);
    label.appendChild(d);
  }
}

function attachRemote(p, kind, stream) {
  p.streams[kind] = stream;
  if (kind === 'cam') {
    ensurePeerTile(p);
    const v = p.tiles.cam.querySelector('video');
    if (v.srcObject !== stream) { v.srcObject = stream; v.play().catch(() => {}); }
    stream.getVideoTracks().forEach(t => { t.onunmute = () => updatePeerTile(p); });
    updatePeerTile(p);
    if (stream.getAudioTracks().length) startSpeakingMonitor(p.id, stream, p.tiles.cam);
  } else if (kind === 'screen') {
    if (!p.tiles.screen) {
      p.tiles.screen = makeTile({ key: p.id + ':screen', screen: true });
      p.tiles.screen.querySelector('.avatar').classList.add('hidden');
      renderLabel(p.tiles.screen, { name: (p.name || 'Friend') + '’s screen' });
    }
    const v = p.tiles.screen.querySelector('video');
    if (v.srcObject !== stream) { v.srcObject = stream; v.play().catch(() => {}); }
    updateScreenTools(p);
    layoutStage();
  } else if (kind === 'daw') {
    if (!p.dawAudio) {
      p.dawAudio = new Audio();
      p.dawAudio.autoplay = true;
    }
    p.dawAudio.srcObject = stream;
    p.dawAudio.volume = p.dawVolume;
    p.dawAudio.play().catch(() => {});
    updatePeerTile(p);
    addSystemMessage((p.name || 'A friend') + ' is sharing their DAW audio.');
  }
}

function detachRemote(p, kind) {
  delete p.streams[kind];
  if (kind === 'cam' && p.tiles.cam) {
    p.tiles.cam.querySelector('video').srcObject = null;
    stopSpeakingMonitor(p.id);
    updatePeerTile(p);
  } else if (kind === 'screen' && p.tiles.screen) {
    p.tiles.screen.remove();
    delete p.tiles.screen;
    layoutStage();
  } else if (kind === 'daw' && p.dawAudio) {
    p.dawAudio.pause(); p.dawAudio.srcObject = null; p.dawAudio = null;
    updatePeerTile(p);
  }
}

function layoutStage() {
  const featured = $('featured');
  const gallery = $('gallery');
  const screens = [];
  const myScreen = document.querySelector('.tile[data-key="me:screen"]');
  for (const p of S.peers.values()) if (p.tiles.screen) screens.push(p.tiles.screen);
  if (myScreen) screens.push(myScreen);   // friends' screens get the big spot first

  const main = screens[0] || null;
  for (const t of screens.slice(1)) if (t.parentElement !== gallery) gallery.appendChild(t);
  if (main && main.parentElement !== featured) { featured.textContent = ''; featured.appendChild(main); }
  if (!main) featured.textContent = '';
  [...featured.children].forEach(c => { if (c !== main) gallery.appendChild(c); });
  $('stage').classList.toggle('presenting', !!main);
}

// Speaking indicator: a gentle green outline on whoever is talking.
let audioCtx = null;
const speakMonitors = new Map();
function startSpeakingMonitor(key, stream, tile) {
  stopSpeakingMonitor(key);
  try {
    audioCtx = audioCtx || new AudioContext();
    const src = audioCtx.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
    const an = audioCtx.createAnalyser();
    an.fftSize = 512;
    src.connect(an);
    const buf = new Float32Array(an.fftSize);
    const timer = setInterval(() => {
      an.getFloatTimeDomainData(buf);
      let sum = 0; for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      const rms = Math.sqrt(sum / buf.length);
      const muted = key === 'me' ? !S.micOn : (S.peers.get(key) && S.peers.get(key).mic === false);
      tile.classList.toggle('speaking', rms > 0.02 && !muted);
    }, 200);
    speakMonitors.set(key, { src, timer, tile });
  } catch (_) { /* not essential */ }
}
function stopSpeakingMonitor(key) {
  const m = speakMonitors.get(key);
  if (!m) return;
  clearInterval(m.timer);
  try { m.src.disconnect(); } catch (_) {}
  m.tile.classList.remove('speaking');
  speakMonitors.delete(key);
}

// ---------------------------------------------------------------- room controls
function wireRoomUi() {
  $('micBtn').onclick = toggleMic;
  $('camBtn').onclick = toggleCam;
  $('dawBtn').onclick = openDawModal;
  $('screenBtn').onclick = () => (S.local.screen ? stopScreenShare() : openScreenPicker());
  $('settingsBtn').onclick = openSettings;
  $('leaveBtn').onclick = async () => {
    if (await confirmBox('Leave the room?', 'You can rejoin with the same code while others are still in it.', 'Leave')) leaveRoom();
  };
  $('copyCodeBtn').onclick = async () => {
    try { await navigator.clipboard.writeText(prettyCode(S.roomCode)); toast('Room code copied.'); }
    catch (_) { toast('Copy failed — the code is ' + prettyCode(S.roomCode)); }
  };
  $('toggleChatBtn').onclick = () => $('chatPanel').classList.toggle('hidden');
  $('controlBannerStop').onclick = () => revokeControl(true);

  document.querySelectorAll('[data-close]').forEach(b => { b.onclick = () => closeModal(b.dataset.close); });
  document.querySelectorAll('.modal').forEach(m => m.addEventListener('mousedown', e => { if (e.target === m && m.id !== 'confirmModal') closeModal(m.id); }));
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !S.control.controlling) {
      const open = [...document.querySelectorAll('.modal:not(.hidden)')].pop();
      if (open && open.id !== 'confirmModal') closeModal(open.id);
    }
  });

  // Chat
  $('chatForm').onsubmit = (e) => {
    e.preventDefault();
    const text = $('chatInput').value.trim();
    if (!text) return;
    broadcast({ t: 'chat', text });
    addChatMessage(S.myName, text, true);
    $('chatInput').value = '';
  };
  $('attachBtn').onclick = () => $('fileInput').click();
  $('fileInput').onchange = () => { sendFiles([...$('fileInput').files]); $('fileInput').value = ''; };
  const panel = $('chatPanel');
  let dragDepth = 0;
  panel.addEventListener('dragenter', e => { if (e.dataTransfer.types.includes('Files')) { dragDepth++; $('dropHint').classList.remove('hidden'); } });
  panel.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('dropHint').classList.add('hidden'); });
  panel.addEventListener('dragover', e => e.preventDefault());
  panel.addEventListener('drop', e => {
    e.preventDefault(); dragDepth = 0; $('dropHint').classList.add('hidden');
    sendFiles([...e.dataTransfer.files]);
  });
  // Don't let files dropped elsewhere make the window navigate away.
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => e.preventDefault());

  // DAW modal
  $('dawStartBtn').onclick = startDawShare;
  $('dawStopBtn').onclick = () => { stopDawShare(); };
  $('dawMonitor').onchange = () => {
    S.settings.dawMonitor = $('dawMonitor').checked; saveSettings();
    if (S.local.dawRaw) S.settings.dawMonitor ? startDawMonitor() : stopDawMonitor();
  };
  $('dawSource').onchange = () => {
    const isLoop = $('dawSource').value === LOOPBACK_ID;
    $('dawMonitor').disabled = isLoop;
    if (isLoop) $('dawMonitor').checked = false;
  };

  // Settings
  $('settingsSaveBtn').onclick = saveSettingsFromUi;
}

function updateButtons() {
  const mic = $('micBtn'), cam = $('camBtn'), daw = $('dawBtn'), scr = $('screenBtn');
  const hasMic = !!(S.local.cam && S.local.cam.getAudioTracks().length);
  mic.classList.toggle('on', S.micOn); mic.classList.toggle('off', !S.micOn);
  mic.querySelector('span').textContent = !hasMic ? 'No mic' : (S.micOn ? 'Mute' : 'Unmute');
  cam.classList.toggle('off', !S.camOn);
  cam.querySelector('span').textContent = !S.hasVideo ? 'No camera' : (S.camOn ? 'Stop video' : 'Start video');
  daw.classList.toggle('live', !!S.local.daw);
  daw.querySelector('span').textContent = S.local.daw ? 'DAW is live' : 'Share DAW audio';
  scr.classList.toggle('live', !!S.local.screen);
  scr.querySelector('span').textContent = S.local.screen ? 'Stop sharing' : 'Share screen';
}

function toggleMic() {
  const tracks = S.local.cam ? S.local.cam.getAudioTracks() : [];
  if (!tracks.length) { toast('No microphone found. Check Settings.', 'error'); return; }
  S.micOn = !S.micOn;
  tracks.forEach(t => (t.enabled = S.micOn));
  broadcast({ t: 'state', mic: S.micOn, cam: S.camOn && S.hasVideo });
  updateButtons(); ensureLocalTile();
}

function toggleCam() {
  const tracks = S.local.cam ? S.local.cam.getVideoTracks() : [];
  if (!tracks.length) { toast('No camera found. Check Settings.', 'error'); return; }
  S.camOn = !S.camOn;
  tracks.forEach(t => (t.enabled = S.camOn));
  broadcast({ t: 'state', mic: S.micOn, cam: S.camOn });
  updateButtons(); ensureLocalTile();
}

// ---------------------------------------------------------------- modals
function openModal(id) { $(id).classList.remove('hidden'); }
function closeModal(id) {
  $(id).classList.add('hidden');
  if (id === 'dawModal' && !S.local.daw) stopDawMeter();
}

let confirmResolve = null;
function confirmBox(title, body, yesText, opts = {}) {
  $('confirmTitle').textContent = title;
  $('confirmBody').textContent = body;
  $('confirmYes').textContent = yesText || 'OK';
  $('confirmNo').textContent = opts.noText || 'Cancel';
  $('confirmNo').classList.toggle('hidden', !!opts.noCancel);
  const extra = $('confirmExtra');
  extra.classList.toggle('hidden', !opts.extraText);
  extra.textContent = opts.extraText || '';
  extra.onclick = opts.extraAction || null;
  openModal('confirmModal');
  if (confirmResolve) confirmResolve(false);
  return new Promise(resolve => {
    confirmResolve = resolve;
    const done = (v) => { confirmResolve = null; $('confirmModal').classList.add('hidden'); resolve(v); };
    $('confirmYes').onclick = () => done(true);
    $('confirmNo').onclick = () => done(false);
  });
}

// ---------------------------------------------------------------- settings
async function fillDeviceSelect(select, kind, currentId, extra) {
  let devices = [];
  try { devices = await navigator.mediaDevices.enumerateDevices(); } catch (_) {}
  select.textContent = '';
  const add = (value, text) => { const o = document.createElement('option'); o.value = value; o.textContent = text; select.appendChild(o); };
  if (extra) extra.forEach(([v, t]) => add(v, t));
  const list = devices.filter(d => d.kind === kind && d.deviceId !== 'communications');
  list.forEach((d, i) => add(d.deviceId === 'default' ? '' : d.deviceId, d.label || (kind === 'videoinput' ? 'Camera ' : 'Input ') + (i + 1)));
  if (!list.length && !extra) add('', 'None found');
  // De-duplicate the empty "default" entry if there's more than one.
  const seen = new Set();
  [...select.options].forEach(o => { if (seen.has(o.value)) o.remove(); else seen.add(o.value); });
  select.value = currentId || '';
  if (select.selectedIndex < 0 && select.options.length) select.selectedIndex = 0;
}

async function openSettings() {
  await fillDeviceSelect($('micSelect'), 'audioinput', S.settings.micId);
  await fillDeviceSelect($('camSelect'), 'videoinput', S.settings.camId);
  $('voiceCleanup').checked = S.settings.voiceCleanup;
  $('turnUrl').value = S.settings.turnUrl;
  $('turnUser').value = S.settings.turnUser;
  $('turnPass').value = S.settings.turnPass;
  openModal('settingsModal');
}

async function saveSettingsFromUi() {
  const before = { ...S.settings };
  S.settings.micId = $('micSelect').value;
  S.settings.camId = $('camSelect').value;
  S.settings.voiceCleanup = $('voiceCleanup').checked;
  S.settings.turnUrl = $('turnUrl').value.trim();
  S.settings.turnUser = $('turnUser').value.trim();
  S.settings.turnPass = $('turnPass').value;
  saveSettings();
  closeModal('settingsModal');
  if (before.turnUrl !== S.settings.turnUrl || before.turnUser !== S.settings.turnUser || before.turnPass !== S.settings.turnPass) {
    toast('Relay settings saved. They apply the next time you join a room.');
  }
  if (before.micId !== S.settings.micId || before.camId !== S.settings.camId || before.voiceCleanup !== S.settings.voiceCleanup) {
    await switchDevices();
  }
}

async function switchDevices() {
  const fresh = await getCamStream();
  if (!fresh) { toast('Couldn’t open that camera or mic.', 'error'); return; }
  const old = S.local.cam;
  fresh.getAudioTracks().forEach(t => (t.enabled = S.micOn));
  S.hasVideo = fresh.getVideoTracks().length > 0;
  if (!S.hasVideo) S.camOn = false;
  fresh.getVideoTracks().forEach(t => (t.enabled = S.camOn));
  S.local.cam = fresh;
  for (const p of S.peers.values()) {
    const call = p.out.cam;
    const pc = call && call.peerConnection;
    let swapped = false;
    if (pc) {
      for (const kind of ['audio', 'video']) {
        const track = fresh.getTracks().find(t => t.kind === kind) || null;
        const tr = pc.getTransceivers().find(x => x.sender && ((x.sender.track && x.sender.track.kind === kind) || (x.receiver && x.receiver.track && x.receiver.track.kind === kind)));
        if (tr) { try { await tr.sender.replaceTrack(track); swapped = true; } catch (_) { swapped = false; } }
      }
    }
    if (!swapped) callPeer(p, 'cam');
  }
  if (old) old.getTracks().forEach(t => t.stop());
  broadcast({ t: 'state', mic: S.micOn, cam: S.camOn && S.hasVideo });
  updateButtons(); ensureLocalTile();
  toast('Devices updated.');
}

// ---------------------------------------------------------------- screen sharing
async function openScreenPicker() {
  const help = $('screenHelp');
  help.classList.add('hidden'); help.textContent = '';
  if (desktop && isMac()) {
    const status = await desktop.screenAccessStatus();
    if (status === 'denied' || status === 'restricted') {
      showMacScreenHelp(help);
    }
  }
  const sources = desktop ? await desktop.getSources() : [];
  const screens = sources.filter(s => s.type === 'screen');
  const windows = sources.filter(s => s.type === 'window');
  renderSources($('screenList'), screens, 'No screens found.');
  renderSources($('windowList'), windows, 'No windows found.');
  if (isMac() && sources.length && sources.every(s => !s.thumbnail)) showMacScreenHelp(help);
  openModal('screenModal');
}

function showMacScreenHelp(help) {
  help.textContent = '';
  const p = document.createElement('div');
  p.textContent = 'Your Mac needs to allow Audio Share to record the screen: System Settings → Privacy & Security → Screen & System Audio Recording → turn on Audio Share. Then quit and reopen Audio Share.';
  const b = document.createElement('button');
  b.className = 'btn btn-secondary btn-small'; b.textContent = 'Open Screen Recording settings';
  b.onclick = () => desktop.openPrivacySettings('screen');
  help.append(p, b);
  help.classList.remove('hidden');
}

function renderSources(container, list, emptyText) {
  container.textContent = '';
  if (!list.length) {
    const e = document.createElement('p'); e.className = 'muted'; e.textContent = emptyText;
    container.appendChild(e); return;
  }
  for (const s of list) {
    const b = document.createElement('button');
    b.className = 'source';
    if (s.thumbnail) { const img = document.createElement('img'); img.src = s.thumbnail; img.alt = ''; b.appendChild(img); }
    else { const d = document.createElement('div'); d.className = 'noimg'; b.appendChild(d); }
    const n = document.createElement('span'); n.textContent = s.name; b.appendChild(n);
    b.onclick = () => { closeModal('screenModal'); startScreenShare(s); };
    container.appendChild(b);
  }
}

async function startScreenShare(source) {
  try {
    await desktop.prepareShare({ mode: 'screen', sourceId: source.id });
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30, max: 30 }, width: { max: 1920 }, height: { max: 1080 } },
      audio: false,
    });
    const track = stream.getVideoTracks()[0];
    if (!track) throw new Error('no video');
    try { track.contentHint = 'detail'; } catch (_) {}
    track.onended = () => stopScreenShare();
    if (S.local.screen) stopSharing('screen');
    S.local.screen = stream;
    S.local.screenInfo = { type: source.type, controllable: source.type === 'screen' && !!desktop, displayId: source.displayId };

    let t = document.querySelector('.tile[data-key="me:screen"]');
    if (!t) {
      t = makeTile({ key: 'me:screen', local: true, screen: true });
      t.querySelector('.avatar').classList.add('hidden');
      renderLabel(t, { name: 'Your screen (friends see this)' });
    }
    t.querySelector('video').srcObject = stream;
    if (!t.parentElement) $('gallery').appendChild(t);
    layoutStage();

    for (const p of S.peers.values()) {
      send(p, { t: 'screen-info', type: S.local.screenInfo.type, controllable: S.local.screenInfo.controllable });
      callPeer(p, 'screen');
    }
    updateButtons();
  } catch (err) {
    console.warn('[screen share]', err);
    if (isMac()) {
      toast('Screen sharing was blocked. Allow Audio Share in System Settings → Privacy & Security → Screen & System Audio Recording, then reopen the app.', 'error');
    } else {
      toast('Couldn’t start screen sharing.', 'error');
    }
  }
}

function stopScreenShare() {
  if (!S.local.screen) return;
  if (S.control.grantedTo) revokeControl(true);
  stopSharing('screen');
  S.local.screenInfo = null;
  const t = document.querySelector('.tile[data-key="me:screen"]');
  if (t) t.remove();
  layoutStage();
  updateButtons();
}

// ---------------------------------------------------------------- remote control: the person being controlled
async function onControlRequest(p) {
  const info = S.local.screenInfo;
  if (!info || !info.controllable) { send(p, { t: 'ctl-deny' }); return; }
  if (S.control.grantedTo && S.control.grantedTo !== p.id) { send(p, { t: 'ctl-deny', reason: 'busy' }); return; }
  if (S.control.pendingRequest) { send(p, { t: 'ctl-deny', reason: 'busy' }); return; }
  S.control.pendingRequest = p.id;
  const ok = await confirmBox(
    p.name + ' wants to control your screen',
    'They’ll be able to move your mouse and type on your computer. You can take control back any time with the Stop button or ' +
      (isMac() ? 'Cmd' : 'Ctrl') + '+Shift+X.',
    'Allow', { noText: 'Don’t allow' });
  S.control.pendingRequest = null;
  if (!S.peers.has(p.id)) return;
  if (!ok || !S.local.screenInfo) { send(p, { t: 'ctl-deny' }); return; }

  const check = await desktop.controlCheck();
  if (!check.ok) {
    send(p, { t: 'ctl-deny', reason: 'setup' });
    if (check.reason === 'mac-accessibility') {
      await confirmBox('One-time Mac setup',
        'To let friends control your screen, your Mac needs to trust Audio Share: System Settings → Privacy & Security → Accessibility → turn on Audio Share. Then ask your friend to request control again. (You may need to quit and reopen Audio Share.)',
        'OK', { noCancel: true, extraText: 'Open Accessibility settings', extraAction: () => desktop.openPrivacySettings('accessibility') });
    } else {
      toast('Remote control isn’t available on this computer (' + (check.detail || 'missing component') + ').', 'error');
    }
    return;
  }
  await desktop.controlStart(S.local.screenInfo.displayId);
  S.control.grantedTo = p.id;
  send(p, { t: 'ctl-grant' });
  $('controlBannerText').textContent = p.name + ' is controlling your screen';
  document.querySelector('.hotkey-hint').textContent = 'or press ' + (isMac() ? 'Cmd' : 'Ctrl') + '+Shift+X';
  $('controlBanner').classList.remove('hidden');
  addSystemMessage(p.name + ' is now controlling your screen.');
}

async function revokeControl(notify) {
  const id = S.control.grantedTo;
  if (!id) return;
  S.control.grantedTo = null;
  if (desktop) { try { await desktop.controlStop(); } catch (_) {} }
  $('controlBanner').classList.add('hidden');
  const p = S.peers.get(id);
  if (p && notify !== false) send(p, { t: 'ctl-revoke' });
  if (p) addSystemMessage('You took back control from ' + p.name + '.');
}

// ---------------------------------------------------------------- remote control: the person controlling
function updateScreenTools(p) {
  const tile = p.tiles.screen;
  if (!tile) return;
  const tools = tile.querySelector('.tile-tools');
  tools.textContent = '';
  const full = document.createElement('button');
  full.className = 'btn btn-small'; full.textContent = 'Full screen';
  full.onclick = () => { if (document.fullscreenElement) document.exitFullscreen(); else tile.requestFullscreen().catch(() => {}); };
  tools.appendChild(full);
  if (!p.screenInfo || !p.screenInfo.controllable) return;
  const b = document.createElement('button');
  if (S.control.controlling === p.id) {
    b.className = 'btn btn-danger btn-small'; b.textContent = 'Stop controlling';
    b.onclick = () => stopControlling(true);
  } else if (p._ctlPending) {
    b.className = 'btn btn-small'; b.textContent = 'Waiting for OK…'; b.disabled = true;
  } else {
    b.className = 'btn btn-primary btn-small'; b.textContent = 'Request control';
    b.onclick = () => {
      if (S.control.controlling) { toast('Stop controlling the other screen first.'); return; }
      p._ctlPending = true; updateScreenTools(p);
      send(p, { t: 'ctl-request' });
      setTimeout(() => { if (p._ctlPending) { p._ctlPending = false; updateScreenTools(p); } }, 60000);
    };
  }
  tools.appendChild(b);
}

function startControlling(p) {
  p._ctlPending = false;
  if (!p.tiles.screen) { send(p, { t: 'ctl-revoke' }); return; }
  S.control.controlling = p.id;
  const tile = p.tiles.screen;
  tile.classList.add('controlling');
  const video = tile.querySelector('video');
  const overlay = document.createElement('div');
  overlay.className = 'control-overlay';
  overlay.tabIndex = 0;
  tile.appendChild(overlay);
  updateScreenTools(p);
  toast('You’re controlling ' + p.name + '’s screen. Click on it to start; your keys go to their computer while it’s selected.');

  const sendEv = (ev) => send(p, { t: 'ctl', ev });
  const norm = (e) => {
    const r = video.getBoundingClientRect();
    const vw = video.videoWidth || 16, vh = video.videoHeight || 9;
    const scale = Math.min(r.width / vw, r.height / vh);
    const w = vw * scale, h = vh * scale;
    const left = r.left + (r.width - w) / 2, top = r.top + (r.height - h) / 2;
    return { x: (e.clientX - left) / w, y: (e.clientY - top) / h, inside: e.clientX >= left && e.clientX <= left + w && e.clientY >= top && e.clientY <= top + h };
  };
  let lastMove = null, raf = 0;
  const flushMove = () => { raf = 0; if (lastMove) { sendEv({ e: 'move', x: lastMove.x, y: lastMove.y }); lastMove = null; } };
  const onMove = (e) => {
    const n = norm(e); if (!n.inside) return;
    lastMove = n; if (!raf) raf = requestAnimationFrame(flushMove);
  };
  const onDown = (e) => {
    overlay.focus();
    const n = norm(e); if (!n.inside) return;
    e.preventDefault();
    sendEv({ e: 'down', b: e.button, x: n.x, y: n.y });
  };
  const onUp = (e) => {
    const n = norm(e);
    e.preventDefault();
    sendEv({ e: 'up', b: e.button, x: n.inside ? n.x : undefined, y: n.inside ? n.y : undefined });
  };
  const onWheel = (e) => { e.preventDefault(); sendEv({ e: 'wheel', dx: e.deltaX, dy: e.deltaY }); };
  const onKey = (e) => {
    e.preventDefault(); e.stopPropagation();
    if (e.repeat && e.type === 'keyup') return;
    sendEv({ e: e.type === 'keydown' ? 'keydown' : 'keyup', code: e.code });
  };
  const onBlur = () => sendEv({ e: 'release-all' });
  const noMenu = (e) => e.preventDefault();

  overlay.addEventListener('mousemove', onMove);
  overlay.addEventListener('mousedown', onDown);
  overlay.addEventListener('mouseup', onUp);
  overlay.addEventListener('wheel', onWheel, { passive: false });
  overlay.addEventListener('keydown', onKey);
  overlay.addEventListener('keyup', onKey);
  overlay.addEventListener('blur', onBlur);
  overlay.addEventListener('contextmenu', noMenu);
  overlay.focus();

  S.control.cleanup = () => {
    if (raf) cancelAnimationFrame(raf);
    try { sendEv({ e: 'release-all' }); } catch (_) {}
    overlay.remove();
    tile.classList.remove('controlling');
  };
}

function stopControlling(notify) {
  const id = S.control.controlling;
  if (!id) return;
  S.control.controlling = null;
  if (S.control.cleanup) { S.control.cleanup(); S.control.cleanup = null; }
  const p = S.peers.get(id);
  if (p) { if (notify) send(p, { t: 'ctl-revoke' }); updateScreenTools(p); }
}

// ---------------------------------------------------------------- DAW audio
async function openDawModal() {
  const extra = isWin() ? [[LOOPBACK_ID, 'Whole computer sound (everything you hear)']] : null;
  await fillDeviceSelect($('dawSource'), 'audioinput', S.settings.dawSource, extra);
  // Put a likely virtual cable first if nothing was chosen before.
  if (!S.settings.dawSource) {
    const guess = [...$('dawSource').options].find(o => /blackhole|vb-?audio|cable output|voicemeeter|loopback|soundflower/i.test(o.textContent));
    if (guess) $('dawSource').value = guess.value;
  }
  $('dawMonitor').checked = !!S.settings.dawMonitor;
  $('dawSource').onchange();
  renderDawHelp();
  syncDawModalButtons();
  openModal('dawModal');
}

function syncDawModalButtons() {
  const live = !!S.local.daw;
  $('dawStartBtn').textContent = live ? 'Switch source' : 'Start sharing';
  $('dawStopBtn').classList.toggle('hidden', !live);
}

function renderDawHelp() {
  const body = $('dawHelpBody');
  body.textContent = '';
  const steps = isMac() ? [
    'Install the free “BlackHole 2ch” virtual audio cable (existential.audio/blackhole).',
    'In your DAW’s audio settings, set the output device to “BlackHole 2ch”.',
    'Here, pick “BlackHole 2ch” as the audio source and turn on “Let me hear it too”.',
    'Press Start sharing. Wear headphones so your mic doesn’t pick up the music.',
  ] : [
    'Easiest: pick “Whole computer sound”. Friends hear everything your computer plays — including their own voices coming back to them, so ask them to mute you when they talk, or use the cable below.',
    'Best quality: install the free “VB-CABLE” (vb-audio.com/Cable). In your DAW, set the output to “CABLE Input”.',
    'Here, pick “CABLE Output” as the audio source and turn on “Let me hear it too”.',
    'Press Start sharing. Wear headphones so your mic doesn’t pick up the music.',
  ];
  const ol = document.createElement('ol');
  steps.forEach(s => { const li = document.createElement('li'); li.textContent = s; ol.appendChild(li); });
  const note = document.createElement('p');
  note.className = 'muted';
  note.textContent = 'Using an audio interface? You can also pick its input directly — for example a loopback channel some interfaces offer.';
  body.append(ol, note);
}

async function startDawShare() {
  const choice = $('dawSource').value;
  let stream = null;
  try {
    if (choice === LOOPBACK_ID) {
      await desktop.prepareShare({ mode: 'loopback' });
      const s = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      s.getVideoTracks().forEach(t => t.stop());
      if (!s.getAudioTracks().length) throw new Error('no computer sound');
      stream = new MediaStream(s.getAudioTracks());
    } else {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: choice ? { exact: choice } : undefined,
          echoCancellation: false, noiseSuppression: false, autoGainControl: false,
          channelCount: { ideal: 2 }, sampleRate: { ideal: 48000 }, sampleSize: { ideal: 24 },
          latency: { ideal: 0.01 },
        },
      });
    }
  } catch (err) {
    console.warn('[daw]', err);
    toast('Couldn’t open that audio source.', 'error');
    return;
  }
  const track = stream.getAudioTracks()[0];
  try { track.contentHint = 'music'; } catch (_) {}

  // Switching sources while live: stop the old one first.
  if (S.local.daw) stopDawShare(true);

  S.settings.dawSource = choice; saveSettings();
  S.local.dawRaw = stream;
  S.local.daw = stream;
  track.onended = () => { if (S.local.daw === stream) { stopDawShare(); toast('DAW audio stopped — the audio source went away.', 'error'); } };

  const ch = track.getSettings().channelCount;
  $('dawChannels').textContent = ch ? (ch >= 2 ? 'Stereo' : 'Mono') + ' · 48 kHz · up to 510 kbps' : '';
  startDawMeter(stream);
  if (S.settings.dawMonitor && choice !== LOOPBACK_ID) startDawMonitor();

  for (const p of S.peers.values()) callPeer(p, 'daw');
  updateButtons(); ensureLocalTile(); syncDawModalButtons();
  toast('Your DAW audio is live.');
}

function stopDawShare(switching) {
  if (!S.local.daw) return;
  stopSharing('daw');
  S.local.dawRaw = null;
  stopDawMonitor();
  if (!switching) {
    stopDawMeter();
    $('dawChannels').textContent = '';
    updateButtons(); ensureLocalTile(); syncDawModalButtons();
  }
}

let dawMonitorEl = null;
function startDawMonitor() {
  stopDawMonitor();
  if (!S.local.dawRaw) return;
  dawMonitorEl = new Audio();
  dawMonitorEl.srcObject = S.local.dawRaw;
  dawMonitorEl.play().catch(() => {});
}
function stopDawMonitor() {
  if (dawMonitorEl) { dawMonitorEl.pause(); dawMonitorEl.srcObject = null; dawMonitorEl = null; }
}

let dawMeter = null;
function startDawMeter(stream) {
  stopDawMeter();
  try {
    const ctx = new AudioContext();
    const src = ctx.createMediaStreamSource(stream);
    const split = ctx.createChannelSplitter(2);
    const aL = ctx.createAnalyser(), aR = ctx.createAnalyser();
    aL.fftSize = aR.fftSize = 1024;
    src.connect(split); split.connect(aL, 0); split.connect(aR, 1);
    const buf = new Float32Array(1024);
    const level = (an) => { an.getFloatTimeDomainData(buf); let pk = 0; for (const v of buf) pk = Math.max(pk, Math.abs(v)); return pk; };
    const db = (v) => Math.max(0, Math.min(100, ((20 * Math.log10(v + 1e-6)) + 60) / 60 * 100));
    let raf = 0;
    const tick = () => {
      $('dawMeterL').style.width = db(level(aL)) + '%';
      $('dawMeterR').style.width = db(level(aR)) + '%';
      raf = requestAnimationFrame(tick);
    };
    tick();
    dawMeter = { ctx, stop: () => cancelAnimationFrame(raf) };
  } catch (_) { /* meter is optional */ }
}
function stopDawMeter() {
  if (!dawMeter) return;
  dawMeter.stop(); dawMeter.ctx.close().catch(() => {});
  dawMeter = null;
  $('dawMeterL').style.width = '0'; $('dawMeterR').style.width = '0';
}

// ---------------------------------------------------------------- chat
function scrollChat() { const l = $('chatList'); l.scrollTop = l.scrollHeight; }

function appendLinkified(el, text) {
  const re = /(https?:\/\/[^\s<]+)/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) el.appendChild(document.createTextNode(text.slice(last, m.index)));
    const a = document.createElement('a');
    a.href = m[1]; a.textContent = m[1]; a.target = '_blank'; a.rel = 'noopener';
    el.appendChild(a);
    last = m.index + m[1].length;
  }
  if (last < text.length) el.appendChild(document.createTextNode(text.slice(last)));
}

function msgShell(name, mine) {
  const wrap = document.createElement('div');
  wrap.className = 'msg' + (mine ? ' mine' : '');
  const who = document.createElement('div');
  who.className = 'who';
  const b = document.createElement('b'); b.textContent = mine ? 'You' : name;
  const time = document.createElement('span');
  time.textContent = ' · ' + new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  who.append(b, time);
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  wrap.append(who, bubble);
  return { wrap, bubble };
}

function addChatMessage(name, text, mine) {
  const { wrap, bubble } = msgShell(name, mine);
  appendLinkified(bubble, text);
  $('chatList').appendChild(wrap);
  scrollChat();
  if (!mine && $('chatPanel').classList.contains('hidden')) toast(name + ': ' + text.slice(0, 80));
}

function addSystemMessage(text) {
  const wrap = document.createElement('div');
  wrap.className = 'msg system';
  const bubble = document.createElement('div');
  bubble.className = 'bubble'; bubble.textContent = text;
  wrap.appendChild(bubble);
  $('chatList').appendChild(wrap);
  scrollChat();
}

function fileCard(bubble, name, size, statusText) {
  const card = document.createElement('div'); card.className = 'file-card';
  const n = document.createElement('div'); n.className = 'fname'; n.textContent = '📎 ' + name;
  const meta = document.createElement('div'); meta.className = 'fmeta'; meta.textContent = fmtSize(size) + ' · ' + statusText;
  const prog = document.createElement('div'); prog.className = 'progress';
  const bar = document.createElement('div'); prog.appendChild(bar);
  card.append(n, meta, prog);
  bubble.appendChild(card);
  return { card, meta, bar, prog };
}

// ---------------------------------------------------------------- files: sending
async function sendFiles(files) {
  if (!files.length) return;
  const targets = [...S.peers.values()].filter(p => p.conn && p.conn.open);
  if (!targets.length) { toast('Nobody else is in the room yet.', 'error'); return; }
  for (const file of files) {
    if (file.size > FILE_WARN_SIZE &&
        !(await confirmBox('Big file', file.name + ' is ' + fmtSize(file.size) + '. Very large files can be slow and use lots of memory on your friends’ computers. Send anyway?', 'Send'))) continue;
    const fid = randomId(12);
    const { wrap, bubble } = msgShell(S.myName, true);
    const ui = fileCard(bubble, file.name, file.size, 'sending…');
    $('chatList').appendChild(wrap); scrollChat();

    const progress = new Map(targets.map(p => [p.id, 0]));
    const update = () => {
      const avg = [...progress.values()].reduce((a, b) => a + b, 0) / progress.size;
      ui.bar.style.width = (avg * 100).toFixed(1) + '%';
    };
    Promise.all(targets.map(p => sendFileTo(p, file, fid, (frac) => { progress.set(p.id, frac); update(); })))
      .then(results => {
        const ok = results.filter(Boolean).length;
        ui.meta.textContent = fmtSize(file.size) + ' · ' + (ok === results.length ? 'sent' : 'sent to ' + ok + ' of ' + results.length);
        ui.prog.remove();
      });
  }
}

async function sendFileTo(p, file, fid, onProgress) {
  const conn = p.conn;
  if (!send(p, { t: 'file-start', fid, name: file.name, size: file.size, mime: file.type || '' })) return false;
  let offset = 0;
  try {
    while (offset < file.size) {
      if (!conn.open || p.conn !== conn) return false;
      const dc = conn.dataChannel;
      while ((dc ? dc.bufferedAmount : 0) + (conn.bufferSize || 0) * FILE_CHUNK > FILE_MAX_BUFFER) {
        await sleep(15);
        if (!conn.open) return false;
      }
      const data = await file.slice(offset, offset + FILE_CHUNK).arrayBuffer();
      conn.send({ t: 'file-chunk', fid, data });
      offset += data.byteLength;
      onProgress(offset / file.size);
    }
    send(p, { t: 'file-end', fid });
    return true;
  } catch (err) {
    console.warn('[file send]', err);
    send(p, { t: 'file-cancel', fid });
    return false;
  }
}

// ---------------------------------------------------------------- files: receiving
function onFileStart(p, msg) {
  const { wrap, bubble } = msgShell(p.name, false);
  const size = Number(msg.size) || 0;
  const ui = fileCard(bubble, String(msg.name || 'file'), size, 'receiving…');
  $('chatList').appendChild(wrap); scrollChat();
  S.files.set(msg.fid, { from: p.id, name: String(msg.name || 'file').slice(0, 200), size, mime: String(msg.mime || ''), chunks: [], received: 0, ui, bubble });
}
function onFileChunk(p, msg) {
  const f = S.files.get(msg.fid);
  if (!f || f.from !== p.id) return;
  const data = msg.data instanceof ArrayBuffer ? msg.data : (msg.data && msg.data.buffer ? msg.data : null);
  if (!data) return;
  f.chunks.push(data);
  f.received += data.byteLength;
  if (f.size) f.ui.bar.style.width = Math.min(100, (f.received / f.size) * 100).toFixed(1) + '%';
}
function onFileEnd(p, msg) {
  const f = S.files.get(msg.fid);
  if (!f || f.from !== p.id) return;
  S.files.delete(msg.fid);
  const blob = new Blob(f.chunks, { type: f.mime || 'application/octet-stream' });
  f.chunks = null;
  const url = URL.createObjectURL(blob);
  f.ui.prog.remove();
  f.ui.meta.textContent = fmtSize(blob.size) + ' · received';
  if (/^image\//.test(f.mime) && blob.size < 30 * 1024 * 1024) {
    const img = document.createElement('img'); img.src = url; img.alt = f.name;
    f.ui.card.insertBefore(img, f.ui.meta);
  }
  if (/^audio\//.test(f.mime)) {
    const au = document.createElement('audio'); au.controls = true; au.src = url; au.style.width = '100%';
    f.ui.card.appendChild(au);
  }
  const a = document.createElement('a');
  a.href = url; a.download = f.name; a.className = 'btn btn-secondary btn-small'; a.textContent = 'Save…';
  a.style.textDecoration = 'none'; a.style.alignSelf = 'flex-start';
  f.ui.card.appendChild(a);
  scrollChat();
}
function onFileCancel(p, msg) {
  const f = S.files.get(msg.fid);
  if (f && f.from === p.id) failIncoming(msg.fid, 'Sending was cancelled.');
}
function failIncoming(fid, text) {
  const f = S.files.get(fid);
  if (!f) return;
  S.files.delete(fid);
  f.chunks = null;
  f.ui.prog.remove();
  f.ui.meta.textContent = text;
}
