// world-layout.test.ts — storlek från en ritad fyrkant (§10.4, §5), prickens plats, kantmarkörer och fönsteroperationer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DRAW_INSET, LIMITS, MIN_DRAW_H, MIN_DRAW_W, clampToView, dotPointLocal, edgeMarker, requestFromDrawn, resizeFrom, scaleAround, scaleFrom, screenRectOfWin, topmostAt,
} from '../../web/src/world/layout.ts';
import { worldToScreen } from '../../web/src/world/camera.ts';
import type { Camera } from '../../shared/protocol.ts';

const VW = 1440;
const VH = 900;
const near = (a: number, b: number, eps = 1e-9, msg = ''): void => assert.ok(Math.abs(a - b) <= eps, `${msg} ${a} ≠ ${b} (±${eps})`);

test('för liten fyrkant (under 120×80 skärm-px) blir ingen app', () => {
  const cam: Camera = { cx: 0, cy: 0, zoom: 1 };
  assert.equal(MIN_DRAW_W, 120);
  assert.equal(MIN_DRAW_H, 80);
  assert.equal(requestFromDrawn({ x: 10, y: 10, w: 119.9, h: 300 }, cam, VW, VH), null);
  assert.equal(requestFromDrawn({ x: 10, y: 10, w: 300, h: 79 }, cam, VW, VH), null);
  assert.notEqual(requestFromDrawn({ x: 10, y: 10, w: 120, h: 80 }, cam, VW, VH), null);
});

test('det man ritar är det man får: layout = ritad storlek i skärm-px (heltal), världsrektangeln = den ritade', () => {
  for (const zoom of [1, 0.5, 2, 0.13, 7.5]) {
    const cam: Camera = { cx: 37, cy: -12, zoom };
    const r = { x: 300.4, y: 120.7, w: 640.6, h: 419.3 };
    const req = requestFromDrawn(r, cam, VW, VH);
    assert.ok(req);
    assert.ok(Number.isInteger(req.w) && Number.isInteger(req.h), 'heltal');
    assert.equal(req.w, 641);
    assert.equal(req.h, 419);
    // Världsbredden är exakt den ritade (§10.4: scale = världsbredd / w). Med en enda skala och heltal blir
    // höjden rätt inom en halv layout-px plus breddens avrundning: högst ungefär en skärm-px.
    const tl = worldToScreen(cam, VW, VH, req.x, req.y);
    near(tl.x, r.x, 1e-6, 'x');
    near(tl.y, r.y, 1e-6, 'y');
    near(req.w * req.scale * zoom, r.w, 1e-6, 'bredd');
    assert.ok(Math.abs(req.h * req.scale * zoom - r.h) <= 0.5 * req.scale * zoom + r.h * (0.5 / req.w) + 1e-9, 'höjd');
    assert.ok(Math.abs(req.h * req.scale * zoom - r.h) < 1, 'höjd inom en skärm-px');
    near(req.scale, r.w / zoom / 641, 1e-12);
  }
});

test('layout utanför 240–2400 × 160–1600: skalan justeras så att världsrektangeln blir den ritade', () => {
  const cam: Camera = { cx: 0, cy: 0, zoom: 1 };
  const small = requestFromDrawn({ x: 0, y: 0, w: 130, h: 90 }, cam, VW, VH);
  assert.ok(small);
  assert.ok(small.w >= LIMITS.wMin && small.h >= LIMITS.hMin, `${small.w}×${small.h}`);
  near(small.w * small.scale, 130, 1e-9);
  assert.ok(Math.abs(small.h * small.scale - 90) < small.scale, 'höjden följer med');
  assert.ok(Number.isInteger(small.w) && Number.isInteger(small.h));
  // Mycket stor fyrkant vid zoom 1 (till exempel på en stor skärm): layouten kläms, skalan växer.
  const big = requestFromDrawn({ x: 0, y: 0, w: 3000, h: 1800 }, cam, 4000, 2400);
  assert.ok(big);
  assert.ok(big.w <= LIMITS.wMax && big.h <= LIMITS.hMax, `${big.w}×${big.h}`);
  near(big.w * big.scale, 3000, 1e-9);
  assert.ok(big.scale > 1);
  // Skalan håller sig inom 0,05–20 även vid extrem zoom.
  const far = requestFromDrawn({ x: 0, y: 0, w: 600, h: 400 }, { cx: 0, cy: 0, zoom: 0.05 }, VW, VH);
  assert.ok(far && far.scale <= LIMITS.scaleMax && far.scale >= LIMITS.scaleMin);
});

test('pricken sitter på 45°-punkten av det övre högra hörnets båge', () => {
  const p = dotPointLocal(640, 16);
  near(p.x, 640 - 16 * (1 - Math.SQRT1_2), 1e-12);
  near(p.y, 16 * (1 - Math.SQRT1_2), 1e-12);
});

test('skärmrektangeln för ett fönster', () => {
  const cam: Camera = { cx: 100, cy: 50, zoom: 2 };
  const r = screenRectOfWin({ x: 10, y: 20, w: 300, h: 200, scale: 1.5 }, cam, VW, VH);
  const tl = worldToScreen(cam, VW, VH, 10, 20);
  near(r.x, tl.x);
  near(r.y, tl.y);
  near(r.w, 300 * 1.5 * 2);
  near(r.h, 200 * 1.5 * 2);
});

test('kantmarkörer: null när fönstret syns, annars vid kanten i fönstrets riktning', () => {
  assert.equal(edgeMarker({ x: 100, y: 100, w: 200, h: 100 }, VW, VH), null);
  assert.equal(edgeMarker({ x: -150, y: 100, w: 200, h: 100 }, VW, VH), null, 'delvis synligt');
  const right = edgeMarker({ x: 2000, y: 400, w: 200, h: 100 }, VW, VH);
  assert.ok(right);
  near(right.x, VW - 14, 1e-9);
  assert.ok(right.y > 400 && right.y < 500);
  const up = edgeMarker({ x: 670, y: -900, w: 100, h: 100 }, VW, VH);
  assert.ok(up);
  near(up.y, 14, 1e-9);
  near(up.x, VW / 2, 1e-6);
});

test('topmostAt väljer högst z', () => {
  const a = { id: 'a', z: 1, rect: { x: 0, y: 0, w: 100, h: 100 } };
  const b = { id: 'b', z: 5, rect: { x: 50, y: 50, w: 100, h: 100 } };
  assert.equal(topmostAt([a, b], 75, 75)?.id, 'b');
  assert.equal(topmostAt([a, b], 10, 10)?.id, 'a');
  assert.equal(topmostAt([a, b], 500, 500), null);
});

test('ändra storlek: heltal, gränser, vänster/övre kant flyttar hörnet', () => {
  const start = { x: 100, y: 100, w: 640, h: 420, scale: 2 };
  const e = resizeFrom(start, 'e', 101, 0);
  assert.deepEqual(e, { x: 100, y: 100, w: 691, h: 420 }); // 101 världsenheter / skala 2 = 50,5 → 51 (avrundat)
  const nw = resizeFrom(start, 'nw', 40, 20);
  assert.equal(nw.w, 620);
  assert.equal(nw.h, 410);
  near(nw.x + nw.w * 2, 100 + 640 * 2, 1e-9, 'högerkanten står still');
  near(nw.y + nw.h * 2, 100 + 420 * 2, 1e-9, 'nederkanten står still');
  const tiny = resizeFrom(start, 'se', -5000, -5000);
  assert.equal(tiny.w, LIMITS.wMin);
  assert.equal(tiny.h, LIMITS.hMin);
});

test('⇧+hörn skalar utan omflödning; motsatta hörnet står still', () => {
  const start = { x: 0, y: 0, w: 600, h: 400, scale: 1 };
  const se = scaleFrom(start, 'se', 300, 10);
  near(se.scale, 1.5, 1e-12);
  assert.deepEqual([se.x, se.y], [0, 0]);
  const nw = scaleFrom(start, 'nw', 300, 0);
  near(nw.scale, 0.5, 1e-12);
  near(nw.x + 600 * nw.scale, 600, 1e-9);
  near(nw.y + 400 * nw.scale, 400, 1e-9);
});

test('⌥+nyp skalar fönstret kring markören', () => {
  const win = { x: 100, y: 100, scale: 1 };
  const p = { x: 400, y: 250 };
  const r = scaleAround(win, p.x, p.y, 1.5);
  near(r.scale, 1.5);
  // Punkten i fönstrets egna koordinater är densamma före och efter.
  near((p.x - win.x) / win.scale, (p.x - r.x) / r.scale, 1e-9);
  near((p.y - win.y) / win.scale, (p.y - r.y) / r.scale, 1e-9);
  assert.equal(scaleAround(win, 0, 0, 1e9).scale, LIMITS.scaleMax);
});

test('FE-10: en fyrkant som dras förbi vyns kant kläms till vyn minus DRAW_INSET (prick och grepp syns)', () => {
  assert.equal(DRAW_INSET, 24);
  // Granskningens fall: drag (60,60) → (1520,980) i en vy på 1440×900.
  const r = clampToView({ x: 60, y: 60, w: 1460, h: 920 }, VW, VH);
  assert.deepEqual(r, { x: 60, y: 60, w: VW - DRAW_INSET - 60, h: VH - DRAW_INSET - 60 });
  // Kalibrering: utan klämning hamnar högerkanten (pricken) och nederkanten (greppet) utanför vyn.
  const raw = { x: 60, y: 60, w: 1460, h: 920 };
  assert.ok(raw.x + raw.w > VW && raw.y + raw.h > VH);
  // En fyrkant helt inne i vyn ändras inte.
  assert.deepEqual(clampToView({ x: 300.5, y: 120.25, w: 640, h: 420 }, VW, VH), { x: 300.5, y: 120.25, w: 640, h: 420 });
  // Uppåt-vänster förbi kanten.
  assert.deepEqual(clampToView({ x: -50, y: -10, w: 400, h: 300 }, VW, VH), { x: DRAW_INSET, y: DRAW_INSET, w: 350 - DRAW_INSET, h: 290 - DRAW_INSET });
  // Helt utanför: tom, och blir ingen app.
  const out = clampToView({ x: VW + 10, y: 10, w: 300, h: 300 }, VW, VH);
  assert.equal(out.w, 0);
  assert.equal(requestFromDrawn(out, { cx: 0, cy: 0, zoom: 1 }, VW, VH), null);
});
