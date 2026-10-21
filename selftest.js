// Automated smoke test (used only by the GitHub build, never in the installed app).
// Two windows: Alice starts a room, Bob joins with the code, they exchange a chat
// message and a file. Prints SELFTEST lines and exits.
const { app } = require('electron');

const log = (...a) => console.log('SELFTEST', ...a);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function watchConsole(w, who) {
  w.webContents.on('console-message', (...args) => {
    // Electron changed this event's signature over time; handle both.
    const e = args[0];
    const level = e && e.level !== undefined ? e.level : args[1];
    const message = e && e.message !== undefined ? e.message : args[2];
    log(`console[${who}][${level}]`, String(message).slice(0, 300));
  });
  w.webContents.on('preload-error', (_e, p, err) => log(`preload-error[${who}]`, p, err && err.message));
  w.webContents.on('did-fail-load', (_e, code, desc, url) => log(`did-fail-load[${who}]`, code, desc, url));
}

const js = (w, code) => w.webContents.executeJavaScript(code, true);

async function waitFor(w, expr, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if (await js(w, expr)) return true; } catch (_) {}
    await sleep(300);
  }
  return false;
}

module.exports = async function selftest(first, createWindow) {
  let failed = false;
  const check = (name, ok, extra) => { log(ok ? 'PASS' : 'FAIL', name, extra || ''); if (!ok) failed = true; };
  const timer = setTimeout(() => { log('FAIL', 'overall timeout'); app.exit(1); }, 120000);
  try {
    const a = first;
    watchConsole(a, 'alice');
    await new Promise(r => a.webContents.once('did-finish-load', r));
    await sleep(500);
    check('app script loaded', await js(a, 'typeof startRoom === "function"'));
    check('PeerJS loaded', await js(a, 'typeof window.Peer === "function"'), await js(a, 'typeof window.Peer + " / " + typeof window.peerjs'));
    log('lobby status at start:', await js(a, 'document.getElementById("lobbyStatus").textContent'));

    await js(a, 'document.getElementById("nameInput").value = "Alice"; document.getElementById("createBtn").click();');
    const entered = await waitFor(a, '!document.getElementById("room").classList.contains("hidden")', 30000);
    check('Alice created a room', entered, 'status: ' + await js(a, 'document.getElementById("lobbyStatus").textContent'));
    if (!entered) throw new Error('could not create room');
    const code = await js(a, 'document.getElementById("roomCodeText").textContent');
    log('room code', code);

    const b = createWindow();
    watchConsole(b, 'bob');
    await new Promise(r => b.webContents.once('did-finish-load', r));
    await sleep(500);
    await js(b, `document.getElementById("nameInput").value = "Bob"; document.getElementById("codeInput").value = ${JSON.stringify(code)}; document.getElementById("joinBtn").click();`);
    const joined = await waitFor(b, '!document.getElementById("room").classList.contains("hidden")', 30000);
    check('Bob joined the room', joined, 'status: ' + await js(b, 'document.getElementById("lobbyStatus").textContent'));

    const both = await waitFor(a, 'document.getElementById("peopleCount").textContent.startsWith("2")', 20000);
    check('Alice sees 2 people', both);

    await js(b, 'document.getElementById("chatInput").value = "hello from bob"; document.getElementById("chatForm").requestSubmit();');
    check('chat delivered', await waitFor(a, 'document.getElementById("chatList").textContent.includes("hello from bob")', 10000));

    const camVideo = await waitFor(a, '(() => { const t = [...S.peers.values()][0]; return !!(t && t.streams.cam); })()', 20000);
    check('Bob’s camera/mic stream reached Alice', camVideo);

    await js(b, 'sendFiles([new File([new Uint8Array(100000).fill(7)], "test.bin")])');
    check('file delivered', await waitFor(a, 'document.getElementById("chatList").textContent.includes("received")', 20000));
  } catch (err) {
    log('FAIL', 'exception', err && err.message);
    failed = true;
  }
  clearTimeout(timer);
  log(failed ? 'RESULT FAIL' : 'RESULT PASS');
  setTimeout(() => app.exit(failed ? 1 : 0), 500);
};
