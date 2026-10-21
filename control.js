// Remote control: turns mouse/keyboard events sent by a friend into real
// mouse movements and key presses on this computer, using nut.js.
// Only ever active while the user has explicitly allowed control.
const { screen } = require('electron');

let nut = null;
let loadError = null;
try {
  nut = require('@nut-tree-fork/nut-js');
  nut.mouse.config.autoDelayMs = 0;
  nut.mouse.config.mouseSpeed = 100000;
  nut.keyboard.config.autoDelayMs = 0;
} catch (err) {
  loadError = err;
  console.error('[control] nut.js failed to load:', err && err.message);
}

// Browser KeyboardEvent.code -> candidate nut.js Key names (first one that exists wins).
const CODE_MAP = {
  Enter: ['Enter', 'Return'], NumpadEnter: ['Enter', 'Return'],
  Escape: ['Escape', 'Esc'], Tab: ['Tab'], Space: ['Space'],
  Backspace: ['Backspace'], Delete: ['Delete'], Insert: ['Insert'],
  Home: ['Home'], End: ['End'], PageUp: ['PageUp'], PageDown: ['PageDown'],
  ArrowUp: ['Up'], ArrowDown: ['Down'], ArrowLeft: ['Left'], ArrowRight: ['Right'],
  ShiftLeft: ['LeftShift'], ShiftRight: ['RightShift'],
  ControlLeft: ['LeftControl'], ControlRight: ['RightControl'],
  AltLeft: ['LeftAlt'], AltRight: ['RightAlt'],
  MetaLeft: ['LeftCmd', 'LeftSuper', 'LeftWin', 'LeftMeta'],
  MetaRight: ['RightCmd', 'RightSuper', 'RightWin', 'RightMeta'],
  CapsLock: ['CapsLock'],
  Minus: ['Minus'], Equal: ['Equal'], BracketLeft: ['LeftBracket'], BracketRight: ['RightBracket'],
  Backslash: ['Backslash'], Semicolon: ['Semicolon'], Quote: ['Quote'], Comma: ['Comma'],
  Period: ['Period'], Slash: ['Slash'], Backquote: ['Grave'],
  NumpadAdd: ['Add'], NumpadSubtract: ['Subtract'], NumpadMultiply: ['Multiply'],
  NumpadDivide: ['Divide'], NumpadDecimal: ['Decimal']
};
for (let i = 0; i < 26; i++) {
  const ch = String.fromCharCode(65 + i);
  CODE_MAP['Key' + ch] = [ch];
}
for (let i = 0; i <= 9; i++) {
  CODE_MAP['Digit' + i] = ['Num' + i];
  CODE_MAP['Numpad' + i] = ['NumPad' + i, 'Num' + i];
}
for (let i = 1; i <= 12; i++) CODE_MAP['F' + i] = ['F' + i];

function resolveKey(code) {
  if (!nut) return undefined;
  const names = CODE_MAP[code];
  if (!names) return undefined;
  for (const n of names) {
    if (nut.Key[n] !== undefined) return nut.Key[n];
  }
  return undefined;
}

let target = null;          // { bounds } of the display being controlled
const pressedKeys = new Set();
const pressedButtons = new Set();
let queue = Promise.resolve();

function available() {
  return { ok: !!nut, error: loadError ? String(loadError.message || loadError) : null };
}

function start(displayId) {
  const displays = screen.getAllDisplays();
  const d = displays.find(x => String(x.id) === String(displayId)) || screen.getPrimaryDisplay();
  target = { bounds: d.bounds };
  return true;
}

async function releaseAll() {
  if (!nut) return;
  for (const k of pressedKeys) { try { await nut.keyboard.releaseKey(k); } catch (_) {} }
  for (const b of pressedButtons) { try { await nut.mouse.releaseButton(b); } catch (_) {} }
  pressedKeys.clear();
  pressedButtons.clear();
}

function stop() {
  target = null;
  queue = queue.then(releaseAll).catch(() => {});
}

function toScreenPoint(nx, ny) {
  const b = target.bounds;
  const x = Math.min(Math.max(nx, 0), 0.9999);
  const y = Math.min(Math.max(ny, 0), 0.9999);
  let p = { x: Math.round(b.x + x * b.width), y: Math.round(b.y + y * b.height) };
  // On Windows nut.js works in physical pixels; Electron gives logical (DIP) values.
  if (process.platform === 'win32') p = screen.dipToScreenPoint(p);
  return new nut.Point(p.x, p.y);
}

function buttonFor(n) {
  if (n === 2) return nut.Button.RIGHT;
  if (n === 1) return nut.Button.MIDDLE;
  return nut.Button.LEFT;
}

async function perform(ev) {
  if (!nut || !target || !ev) return;
  switch (ev.e) {
    case 'move':
      await nut.mouse.setPosition(toScreenPoint(ev.x, ev.y));
      break;
    case 'down': {
      if (typeof ev.x === 'number') await nut.mouse.setPosition(toScreenPoint(ev.x, ev.y));
      const b = buttonFor(ev.b);
      pressedButtons.add(b);
      await nut.mouse.pressButton(b);
      break;
    }
    case 'up': {
      if (typeof ev.x === 'number') await nut.mouse.setPosition(toScreenPoint(ev.x, ev.y));
      const b = buttonFor(ev.b);
      pressedButtons.delete(b);
      await nut.mouse.releaseButton(b);
      break;
    }
    case 'wheel': {
      const steps = (v) => Math.min(20, Math.max(1, Math.round(Math.abs(v) / 40)));
      if (ev.dy > 0) await nut.mouse.scrollDown(steps(ev.dy));
      else if (ev.dy < 0) await nut.mouse.scrollUp(steps(ev.dy));
      if (ev.dx > 0) await nut.mouse.scrollRight(steps(ev.dx));
      else if (ev.dx < 0) await nut.mouse.scrollLeft(steps(ev.dx));
      break;
    }
    case 'keydown': {
      const k = resolveKey(ev.code);
      if (k === undefined) return;
      pressedKeys.add(k);
      await nut.keyboard.pressKey(k);
      break;
    }
    case 'keyup': {
      const k = resolveKey(ev.code);
      if (k === undefined) return;
      pressedKeys.delete(k);
      await nut.keyboard.releaseKey(k);
      break;
    }
    case 'release-all':
      await releaseAll();
      break;
  }
}

function handle(ev) {
  // Run events strictly in order, never letting one failure stop the rest.
  queue = queue.then(() => perform(ev)).catch(err => console.error('[control]', err && err.message));
}

module.exports = { available, start, stop, handle };
