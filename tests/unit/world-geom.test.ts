// world-geom.test.ts — strecket snäpper till den exakta rundade rektangeln (CONTRACT §14, Materialisering steg 1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoundedRect, distanceToEdge, morphPath, morphTargets, resample, sweep, bbox, LOOP_SWEEP } from '../../web/src/world/geom.ts';
import type { Pt } from '../../web/src/world/geom.ts';

const rr = new RoundedRect(100, 50, 640, 420, 16);
const near = (a: number, b: number, eps = 1e-9, msg = ''): void => assert.ok(Math.abs(a - b) <= eps, `${msg} ${a} ≠ ${b} (±${eps})`);

/** En handritad slinga (superellips med darr), medurs från övre vänstra hörnet, som i prototyperna. */
function loop(x: number, y: number, w: number, h: number, n = 150, ccw = false): Pt[] {
  const cx = x + w / 2;
  const cy = y + h / 2;
  const out: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const a = -Math.PI * 0.78 + (ccw ? -1 : 1) * t * 2 * Math.PI * 1.04;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const X = Math.sign(c) * Math.abs(c) ** (2 / 5.2);
    const Y = Math.sign(s) * Math.abs(s) ** (2 / 5.2);
    const wob = 1 - 0.014 * (1 + Math.sin(a * 2.3 + 1.1)) - 0.018 * t;
    out.push({ x: cx + (X * w) / 2 * wob, y: cy + (Y * h) / 2 * wob });
  }
  return out;
}

function diagonal(x0: number, y0: number, x1: number, y1: number, n = 60): Pt[] {
  return Array.from({ length: n + 1 }, (_, i) => {
    const t = i / n;
    const b = Math.sin(t * Math.PI) * 0.04;
    return { x: x0 + (x1 - x0) * t + (x1 - x0) * b, y: y0 + (y1 - y0) * t - (y1 - y0) * b };
  });
}

test('omkretsen: längd, startpunkt, hörnbågarnas ändar och sammanhang', () => {
  const ew = 640 - 32;
  const eh = 420 - 32;
  const q = (Math.PI / 2) * 16;
  near(rr.P, 2 * ew + 2 * eh + 4 * q, 1e-9);
  const p0 = rr.at(0);
  near(p0.x, 116);
  near(p0.y, 50);
  const a0 = rr.at(ew);
  near(a0.x, 740 - 16);
  near(a0.y, 50);
  const a1 = rr.at(ew + q);
  near(a1.x, 740, 1e-9);
  near(a1.y, 66, 1e-9);
  // 45°-punkten på övre högra bågen (där pricken sitter).
  const mid = rr.at(ew + q / 2);
  near(mid.x, 740 - 16 * (1 - Math.SQRT1_2), 1e-9);
  near(mid.y, 50 + 16 * (1 - Math.SQRT1_2), 1e-9);
  // Tätt samplad omkrets: inga hopp.
  let prev = rr.at(0);
  for (let u = 0.5; u <= rr.P; u += 0.5) {
    const p = rr.at(u);
    assert.ok(Math.hypot(p.x - prev.x, p.y - prev.y) <= 0.5 + 1e-9, `hopp vid u=${u}`);
    prev = p;
  }
});

test('nearest(at(u)) = u runt hela omkretsen, och alla punkter ligger på kanten', () => {
  for (let u = 0; u < rr.P; u += rr.P / 997) {
    const p = rr.at(u);
    near(distanceToEdge(rr, p), 0, 1e-9, `u=${u}`);
    near(rr.nearest(p), u, 1e-6, `u=${u}`);
  }
});

test('radiell projektion: strålen från mitten genom punkten', () => {
  // Rakt åt höger från mitten träffar högerkanten mitt på.
  const u = rr.radial({ x: rr.cx + 10, y: rr.cy });
  const p = rr.at(u);
  near(p.x, 740, 1e-9);
  near(p.y, rr.cy, 1e-9);
  // Mot övre högra hörnet: punkten ligger på bågen och på strålen.
  const dir = { x: 1, y: -(420 / 640) };
  const q = rr.at(rr.radial({ x: rr.cx + dir.x * 50, y: rr.cy + dir.y * 50 }));
  near(distanceToEdge(rr, q), 0, 1e-9);
  const cross = (q.x - rr.cx) * dir.y - (q.y - rr.cy) * dir.x;
  near(cross, 0, 1e-6, 'på strålen');
});

test('en slinga känns igen på svepet, en diagonal gör det inte', () => {
  const c = { x: rr.cx, y: rr.cy };
  assert.ok(Math.abs(sweep(loop(100, 50, 640, 420), c)) > LOOP_SWEEP);
  assert.ok(Math.abs(sweep(diagonal(100, 50, 740, 470), c)) < LOOP_SWEEP);
});

/** Största avvikelse mellan polygonen och den exakta rundade rektangeln (mittpunkten på varje segment). */
function maxChordError(pts: Pt[]): number {
  let m = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    m = Math.max(m, distanceToEdge(rr, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }));
  }
  return m;
}

test('slinga: varje målpunkt på kanten, hela omkretsen täcks, exakta hörn (polygonen följer bågarna)', () => {
  const stroke = loop(100, 50, 640, 420);
  const { src, dst, loop: isLoop } = morphTargets(stroke, rr);
  assert.ok(isLoop);
  assert.equal(src.length, dst.length);
  for (const p of dst) near(distanceToEdge(rr, p), 0, 1e-9);
  // Hela omkretsen täcks: parametrarna saknar luckor större än några px.
  const us = dst.map((p) => rr.nearest(p)).sort((a, b) => a - b);
  let gap = us[0] + rr.P - us[us.length - 1];
  for (let i = 1; i < us.length; i++) gap = Math.max(gap, us[i] - us[i - 1]);
  assert.ok(gap < 8, `lucka ${gap.toFixed(2)} px`);
  // Exakta hörn: polygonens segment lämnar aldrig den rundade rektangeln mer än en bråkdel av en pixel.
  const err = maxChordError(dst);
  assert.ok(err < 0.06, `avvikelse ${err.toFixed(4)} px`);
});

test('kalibrering av hörnmåttet: utan insatta hörnpunkter skär polygonen hörnen', () => {
  // Planterat fel: samma slinga men målpunkterna tas utan hörninsättning (bara radiell projektion).
  const stroke = resample(loop(100, 50, 640, 420), 40);
  const naive = stroke.map((p) => rr.at(rr.radial(p)));
  assert.ok(maxChordError(naive) > 1, `det naiva måttet borde fällas, fick ${maxChordError(naive)}`);
});

test('slinga ritad moturs följer sin egen riktning', () => {
  const { dst } = morphTargets(loop(100, 50, 640, 420, 150, true), rr);
  // Parametern minskar i huvudsak (moturs).
  let dec = 0;
  let inc = 0;
  for (let i = 1; i < dst.length; i++) {
    let d = rr.nearest(dst[i]) - rr.nearest(dst[i - 1]);
    if (d > rr.P / 2) d -= rr.P;
    if (d < -rr.P / 2) d += rr.P;
    if (d < 0) dec++;
    else if (d > 0) inc++;
  }
  assert.ok(dec > inc * 5, `moturs: ${dec} ned, ${inc} upp`);
});

test('rakt drag: vecklas ut medurs längs hela omkretsen från kantpunkten närmast starten', () => {
  const stroke = diagonal(105, 55, 735, 465);
  const { dst, loop: isLoop } = morphTargets(stroke, rr);
  assert.ok(!isLoop);
  for (const p of dst) near(distanceToEdge(rr, p), 0, 1e-9);
  const u0 = rr.nearest(stroke[0]);
  near(rr.nearest(dst[0]), u0, 1e-6);
  // Medurs: parametern växer hela vägen och når ett helt varv.
  let total = 0;
  for (let i = 1; i < dst.length; i++) {
    let d = rr.nearest(dst[i]) - rr.nearest(dst[i - 1]);
    if (d < -rr.P / 2) d += rr.P;
    assert.ok(d >= -1e-6, `baklänges vid ${i}`);
    total += d;
  }
  near(total, rr.P, 1e-3);
  assert.ok(maxChordError(dst) < 0.06);
});

test('mellanlägena: k = 0 är strecket, k = 1 är rektangeln', () => {
  const stroke = loop(100, 50, 640, 420, 80);
  const { src, dst } = morphTargets(stroke, rr);
  const parse = (d: string): Pt[] => [...d.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)].map((m) => ({ x: Number(m[1]), y: Number(m[2]) }));
  const at0 = parse(morphPath(src, dst, 0));
  const at1 = parse(morphPath(src, dst, 1));
  at0.forEach((p, i) => {
    near(p.x, src[i].x, 0.006);
    near(p.y, src[i].y, 0.006);
  });
  at1.forEach((p) => near(distanceToEdge(rr, p), 0, 0.01));
});

test('rundad rektangel med radie 0 och liten radie fungerar', () => {
  const sq = new RoundedRect(0, 0, 200, 100, 0);
  near(sq.P, 600, 1e-9);
  const { dst } = morphTargets(loop(0, 0, 200, 100), sq);
  for (const p of dst) near(distanceToEdge(sq, p), 0, 1e-9);
  const big = new RoundedRect(0, 0, 40, 20, 50); // radien kläms till halva höjden
  near(big.r, 10, 1e-12);
});

test('bbox och resample', () => {
  assert.deepEqual(bbox([{ x: 3, y: 4 }, { x: -1, y: 10 }]), { x: -1, y: 4, w: 4, h: 6 });
  const r = resample([{ x: 0, y: 0 }, { x: 10, y: 0 }], 11);
  assert.equal(r.length, 11);
  r.forEach((p, i) => near(p.x, i, 1e-9));
});
