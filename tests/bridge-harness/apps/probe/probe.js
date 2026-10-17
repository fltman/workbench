// probe.js — appens egna lyssnare, registrerade EFTER wb.js. De visar vad appen faktiskt får se.
'use strict';
const seen = (window.__seen = { wheel: [], keys: [], keysDoc: [], keysField: [], messages: [], faceChanges: [], ready: null });
const desc = (e) => ({ code: e.code, key: e.key, meta: e.metaKey, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey });

for (const id of ['list', 'chat']) {
  const el = document.getElementById(id);
  for (let i = 0; el && i < 30; i++) el.append(Object.assign(document.createElement('div'), { textContent: `Rad ${i + 1}` }));
}

addEventListener(
  'wheel',
  (e) => seen.wheel.push({ target: e.target.id || e.target.tagName, ctrl: e.ctrlKey, meta: e.metaKey, alt: e.altKey, dx: e.deltaX, dy: e.deltaY, wdy: e.wheelDeltaY, cancelable: e.cancelable, prevented: e.defaultPrevented, trusted: e.isTrusted }),
  { passive: true },
);
addEventListener('keydown', (e) => seen.keys.push(desc(e)), true);
document.addEventListener('keydown', (e) => seen.keysDoc.push(desc(e)));
const field = document.getElementById('field');
field?.addEventListener('keydown', (e) => {
  seen.keysField.push(desc(e));
  if (e.key === 'Escape' && window.__preventEscField) e.preventDefault();
});
// Appens egen lyssnare på window i bubbelfasen, registrerad efter wb.js: det svåra fallet för Esc.
addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && window.__preventEscWindow) e.preventDefault();
});
addEventListener('message', (e) => seen.messages.push({ origin: e.origin, data: e.data }));
wb.face.onChange((id) => seen.faceChanges.push(id));
wb.ready.then(() => {
  seen.ready = { at: performance.now(), face: wb.face.current };
});
