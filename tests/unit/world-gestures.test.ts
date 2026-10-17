// world-gestures.test.ts — hjulroutern och tangenterna (CONTRACT §10.3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyKey, classifyWheel, matchKey, normDelta, smartAction, zoomFactor } from '../../web/src/world/gestures.ts';
import type { KeyLike, WheelLike } from '../../web/src/world/gestures.ts';

const wheel = (o: Partial<WheelLike>): WheelLike => ({ ctrlKey: false, metaKey: false, altKey: false, deltaX: 0, deltaY: 0, deltaMode: 0, wheelDeltaY: -120, ...o });
const key = (o: Partial<KeyLike>): KeyLike => ({ code: '', key: '', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, repeat: false, ...o });

test('deltaMode normaliseras: rader ×16, sidor ×400', () => {
  assert.equal(normDelta(3, 0), 3);
  assert.equal(normDelta(3, 1), 48);
  assert.equal(normDelta(1, 2), 400);
});

test('nyp: exp(−clamp(dy, −50, 50)/100)', () => {
  assert.equal(zoomFactor(0), 1);
  assert.equal(zoomFactor(10), Math.exp(-0.1));
  assert.equal(zoomFactor(500), Math.exp(-0.5));
  assert.equal(zoomFactor(-500), Math.exp(0.5));
  // Ett nyp ut och in lika långt tar ut varandra.
  assert.ok(Math.abs(zoomFactor(23) * zoomFactor(-23) - 1) < 1e-15);
});

test('över HUD:en: vanliga hjul lämnas orörda, modifierade hjul hanteras', () => {
  assert.deepEqual(classifyWheel(wheel({ deltaY: 40 }), true), { kind: 'ignore' });
  assert.equal(classifyWheel(wheel({ deltaY: 40, ctrlKey: true }), true).kind, 'zoom');
  assert.equal(classifyWheel(wheel({ deltaY: 40, metaKey: true }), true).kind, 'pan');
  assert.equal(classifyWheel(wheel({ deltaX: 40, altKey: true }), true).kind, 'rotate');
});

test('ctrl+wheel zoomar; ctrl med nollor och wheelDeltaY 0 är smart zoom; vilande fingrar är inte det', () => {
  const z = classifyWheel(wheel({ ctrlKey: true, deltaY: 2, deltaMode: 1 }), false);
  assert.deepEqual(z, { kind: 'zoom', factor: zoomFactor(32) });
  assert.deepEqual(classifyWheel(wheel({ ctrlKey: true, wheelDeltaY: 0 }), false), { kind: 'smart' });
  const resting = classifyWheel(wheel({ ctrlKey: true, wheelDeltaY: 120 }), false);
  assert.deepEqual(resting, { kind: 'zoom', factor: 1 });
});

test('smart zoom: fönstret under pekaren, samma igen tillbaka; på tom yta tillbaka, eller visa allt när det inte finns något att flyga tillbaka till', () => {
  assert.equal(smartAction('a1', null, false), 'fly-to');
  assert.equal(smartAction('a1', 'a2', true), 'fly-to');
  assert.equal(smartAction('a1', 'a1', true), 'back');
  assert.equal(smartAction(null, 'a1', true), 'back');
  assert.equal(smartAction(null, null, true), 'back');
  // Tom yta och tom tillbaka-stack: som ⌘0 (förut hände ingenting).
  assert.equal(smartAction(null, null, false), 'fit');
});

test('⌘+wheel och vanligt hjul panorerar (innehållet följer fingrarna); ⌥ är fönsteroperationer', () => {
  assert.deepEqual(classifyWheel(wheel({ deltaX: 10, deltaY: -5 }), false), { kind: 'pan', dx: -10, dy: 5 });
  assert.deepEqual(classifyWheel(wheel({ metaKey: true, deltaY: 2, deltaMode: 1 }), false), { kind: 'pan', dx: -0, dy: -32 });
  assert.deepEqual(classifyWheel(wheel({ altKey: true, deltaX: 12, deltaY: 3 }), false), { kind: 'rotate', dx: 12 });
  assert.deepEqual(classifyWheel(wheel({ altKey: true, deltaY: 12 }), false), { kind: 'none' });
  assert.deepEqual(classifyWheel(wheel({ altKey: true, ctrlKey: true, deltaY: 10 }), false), { kind: 'scale-window', factor: zoomFactor(10) });
});

test('tangenter: ⌘K, ⌘0, ⌃⌥←/→ och Esc på e.code; andra kombinationer är inte skalets', () => {
  assert.equal(classifyKey(key({ code: 'KeyK', key: 'k', metaKey: true })), 'toggle-hud');
  assert.equal(classifyKey(key({ code: 'Digit0', key: '0', metaKey: true })), 'fit');
  assert.equal(classifyKey(key({ code: 'ArrowLeft', ctrlKey: true, altKey: true })), 'prev-face');
  assert.equal(classifyKey(key({ code: 'ArrowRight', ctrlKey: true, altKey: true })), 'next-face');
  // Minimera har inget kortkommando: ⌃⌥↓ och ⌃⌥M tar webbläsaren eller systemet (§10.7).
  assert.equal(classifyKey(key({ code: 'ArrowDown', ctrlKey: true, altKey: true })), null);
  assert.equal(classifyKey(key({ code: 'KeyM', ctrlKey: true, altKey: true })), null);
  assert.equal(classifyKey(key({ code: 'Escape', key: 'Escape' })), 'escape');
  // Svenskt tangentbord: ⌘ och tangenten "0" har code Digit0 oavsett layout.
  assert.equal(classifyKey(key({ code: 'Digit0', key: '=', metaKey: true })), 'fit');
  assert.equal(classifyKey(key({ code: 'KeyK', key: 'k' })), null);
  assert.equal(classifyKey(key({ code: 'KeyK', key: 'k', ctrlKey: true })), null);
  assert.equal(classifyKey(key({ code: 'KeyJ', key: 'j', metaKey: true })), null);
  assert.equal(classifyKey(key({ code: 'ArrowLeft' })), null);
  assert.equal(classifyKey(key({ code: 'ArrowLeft', ctrlKey: true })), null);
});

test('upprepningar ignoreras för skalets tangenter men känns igen (så att de kan stoppas)', () => {
  for (const k of [
    key({ code: 'KeyK', metaKey: true, repeat: true }),
    key({ code: 'Digit0', metaKey: true, repeat: true }),
    key({ code: 'ArrowRight', ctrlKey: true, altKey: true, repeat: true }),
    key({ code: 'Escape', key: 'Escape', repeat: true }),
  ]) {
    assert.equal(classifyKey(k), null);
    assert.notEqual(matchKey(k), null);
  }
});
