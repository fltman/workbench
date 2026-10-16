// world-camera.test.ts — kamerans matematik (CONTRACT §10.2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  boundsOf, fitRect, lerpCamera, ortho, panBy, sanitizeCamera, screenToWorld, worldToScreen, xform, zoomAround, ZOOM_MAX, ZOOM_MIN,
} from '../../web/src/world/camera.ts';
import type { Camera } from '../../shared/protocol.ts';

const VW = 1440;
const VH = 900;
const near = (a: number, b: number, eps = 1e-9, msg = ''): void => assert.ok(Math.abs(a - b) <= eps, `${msg} ${a} ≠ ${b} (±${eps})`);

test('xform följer §10.2: tx = vw/2 − cx·s, ty = vh/2 − cy·s, skärm = värld·s + t', () => {
  const cam: Camera = { cx: 120, cy: -40, zoom: 1.5 };
  const t = xform(cam, VW, VH);
  assert.equal(t.s, 1.5);
  near(t.tx, VW / 2 - 120 * 1.5);
  near(t.ty, VH / 2 + 40 * 1.5);
  const p = worldToScreen(cam, VW, VH, 10, 20);
  near(p.x, 10 * t.s + t.tx);
  near(p.y, 20 * t.s + t.ty);
  // Mitten av vyn är kamerans världspunkt.
  const c = worldToScreen(cam, VW, VH, cam.cx, cam.cy);
  near(c.x, VW / 2);
  near(c.y, VH / 2);
});

test('skärm → värld → skärm är identitet', () => {
  for (const cam of [{ cx: 0, cy: 0, zoom: 1 }, { cx: -3000, cy: 812.5, zoom: 0.07 }, { cx: 55.5, cy: 1e4, zoom: 7.3 }]) {
    for (const [sx, sy] of [[0, 0], [VW, VH], [333.25, 812.75]]) {
      const w = screenToWorld(cam, VW, VH, sx, sy);
      const s = worldToScreen(cam, VW, VH, w.x, w.y);
      near(s.x, sx, 1e-7);
      near(s.y, sy, 1e-7);
    }
  }
});

test('zoom kring en punkt: världspunkten under markören står still', () => {
  let cam: Camera = { cx: 200, cy: 100, zoom: 1 };
  const sx = 1012.5;
  const sy = 233.25;
  const before = screenToWorld(cam, VW, VH, sx, sy);
  for (const f of [1.13, 0.5, 2.7, 0.91]) {
    cam = zoomAround(cam, VW, VH, sx, sy, f);
    const w = screenToWorld(cam, VW, VH, sx, sy);
    near(w.x, before.x, 1e-9);
    near(w.y, before.y, 1e-9);
  }
  near(cam.zoom, 1.13 * 0.5 * 2.7 * 0.91, 1e-12);
});

test('zoomgränserna 0,05–8 kläms, och punkten står ändå still', () => {
  const cam: Camera = { cx: 0, cy: 0, zoom: 1 };
  const hi = zoomAround(cam, VW, VH, 100, 100, 1000);
  assert.equal(hi.zoom, ZOOM_MAX);
  assert.equal(ZOOM_MAX, 8);
  const lo = zoomAround(cam, VW, VH, 100, 100, 1e-6);
  assert.equal(lo.zoom, ZOOM_MIN);
  assert.equal(ZOOM_MIN, 0.05);
  const w0 = screenToWorld(cam, VW, VH, 100, 100);
  for (const c of [hi, lo]) {
    const w = screenToWorld(c, VW, VH, 100, 100);
    near(w.x, w0.x, 1e-9);
    near(w.y, w0.y, 1e-9);
  }
});

test('panorering flyttar innehållet lika många skärm-px, oavsett zoom', () => {
  const cam: Camera = { cx: 10, cy: 20, zoom: 2.5 };
  const p0 = worldToScreen(cam, VW, VH, 0, 0);
  const moved = panBy(cam, 37, -12);
  const p1 = worldToScreen(moved, VW, VH, 0, 0);
  near(p1.x - p0.x, 37, 1e-9);
  near(p1.y - p0.y, -12, 1e-9);
  assert.equal(moved.zoom, 2.5);
});

test('OrthographicCamera: left = −tx/s, right = (vw − tx)/s, top = ty/s, bottom = −(vh − ty)/s (y uppåt)', () => {
  const cam: Camera = { cx: 512, cy: -300, zoom: 0.4 };
  const { s, tx, ty } = xform(cam, VW, VH);
  const o = ortho(cam, VW, VH);
  near(o.left, -tx / s);
  near(o.right, (VW - tx) / s);
  near(o.top, ty / s);
  near(o.bottom, -(VH - ty) / s);
  // Skärmens hörn är världens hörn (y speglat för three.js).
  const tl = screenToWorld(cam, VW, VH, 0, 0);
  const br = screenToWorld(cam, VW, VH, VW, VH);
  near(o.left, tl.x, 1e-9);
  near(o.top, -tl.y, 1e-9);
  near(o.right, br.x, 1e-9);
  near(o.bottom, -br.y, 1e-9);
});

test('flygning: ändpunkterna exakta, zoom i log-skala', () => {
  const a: Camera = { cx: 0, cy: 0, zoom: 0.25 };
  const b: Camera = { cx: 800, cy: -400, zoom: 4 };
  assert.deepEqual(lerpCamera(a, b, 0), a);
  const end = lerpCamera(a, b, 1);
  near(end.cx, 800, 1e-9);
  near(end.cy, -400, 1e-9);
  near(end.zoom, 4, 1e-12);
  near(lerpCamera(a, b, 0.5).zoom, 1, 1e-12); // geometriskt medelvärde
});

test('flygning mellan två kameror som skiljer sig med en zoom kring en punkt följer exakt det nypet', () => {
  const a: Camera = { cx: -120, cy: 310, zoom: 0.6 };
  const px = 1100;
  const py = 180;
  const b = zoomAround(a, VW, VH, px, py, 5);
  const w = screenToWorld(a, VW, VH, px, py);
  for (const e of [0.1, 0.33, 0.5, 0.77, 0.99]) {
    const c = lerpCamera(a, b, e);
    const p = worldToScreen(c, VW, VH, w.x, w.y);
    near(p.x, px, 1e-6, `e=${e}`);
    near(p.y, py, 1e-6, `e=${e}`);
  }
});

test('flygning utan zoomändring rör mitten linjärt', () => {
  const a: Camera = { cx: 0, cy: 0, zoom: 1 };
  const b: Camera = { cx: 100, cy: 50, zoom: 1 };
  const c = lerpCamera(a, b, 0.25);
  near(c.cx, 25);
  near(c.cy, 12.5);
});

test('fitRect: rektangeln ryms med marginal och centreras; reserv till höger flyttar den åt vänster', () => {
  const r = { x: 100, y: 50, w: 1200, h: 600 };
  const cam = fitRect(r, VW, VH, 48);
  const tl = worldToScreen(cam, VW, VH, r.x, r.y);
  const br = worldToScreen(cam, VW, VH, r.x + r.w, r.y + r.h);
  assert.ok(tl.x >= 48 - 1e-9 && tl.y >= 48 - 1e-9 && br.x <= VW - 48 + 1e-9 && br.y <= VH - 48 + 1e-9);
  near((tl.x + br.x) / 2, VW / 2, 1e-9);
  // Med 388 px reserverade för HUD:en hamnar rektangeln mitt i den fria delen.
  const camR = fitRect(r, VW, VH, 48, 8, 388);
  const tlR = worldToScreen(camR, VW, VH, r.x, r.y);
  const brR = worldToScreen(camR, VW, VH, r.x + r.w, r.y + r.h);
  assert.ok(brR.x <= VW - 48 - 388 + 1e-6, `högerkant ${brR.x}`);
  near((tlR.x + brR.x) / 2, (VW - 388) / 2, 1e-6);
  // maxZoom begränsar ("visa allt" förstorar aldrig över 1).
  assert.equal(fitRect({ x: 0, y: 0, w: 10, h: 10 }, VW, VH, 72, 1).zoom, 1);
});

test('boundsOf och sanitizeCamera', () => {
  assert.equal(boundsOf([]), null);
  assert.deepEqual(boundsOf([{ x: 0, y: 0, w: 10, h: 10 }, { x: -5, y: 20, w: 5, h: 5 }]), { x: -5, y: 0, w: 15, h: 25 });
  assert.deepEqual(sanitizeCamera(undefined), { cx: 0, cy: 0, zoom: 1 });
  assert.deepEqual(sanitizeCamera({ cx: 1, cy: 2, zoom: 99 }), { cx: 1, cy: 2, zoom: 8 });
  assert.deepEqual(sanitizeCamera({ cx: Number.NaN, cy: 2, zoom: 1 }), { cx: 0, cy: 0, zoom: 1 });
});
