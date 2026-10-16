// hud-tether.test.ts — linjen mellan appens prick och dess HUD (CONTRACT §14).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TETHER_FROM_DOT, TETHER_MIN, tetherSegment, type Segment } from '../../web/src/hud/tether.ts';

const R = 22;

/** Närmaste punkt på den rundade rektangelns kant, prövad punkt för punkt längs kanten (oberoende av koden). */
function bruteNearest(d: { x: number; y: number }, r: { x: number; y: number; w: number; h: number }, rad: number) {
  const pts: { x: number; y: number }[] = [];
  const N = 2000;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    pts.push({ x: r.x + rad + t * (r.w - 2 * rad), y: r.y }, { x: r.x + rad + t * (r.w - 2 * rad), y: r.y + r.h });
    pts.push({ x: r.x, y: r.y + rad + t * (r.h - 2 * rad) }, { x: r.x + r.w, y: r.y + rad + t * (r.h - 2 * rad) });
    const a = (t * Math.PI) / 2;
    for (const [cx, cy, sx, sy] of [
      [r.x + rad, r.y + rad, -1, -1],
      [r.x + r.w - rad, r.y + rad, 1, -1],
      [r.x + rad, r.y + r.h - rad, -1, 1],
      [r.x + r.w - rad, r.y + r.h - rad, 1, 1],
    ]) pts.push({ x: cx + sx * rad * Math.cos(a), y: cy + sy * rad * Math.sin(a) });
  }
  let best = pts[0];
  let bd = Infinity;
  for (const p of pts) {
    const dd = Math.hypot(p.x - d.x, p.y - d.y);
    if (dd < bd) {
      bd = dd;
      best = p;
    }
  }
  return { p: best, dist: bd };
}

/** Linjens slutpunkt är kantens närmaste punkt, och början ligger TETHER_FROM_DOT från pricken mot den. */
function assertSegment(s: Segment | null, d: { x: number; y: number }, r: { x: number; y: number; w: number; h: number }, msg: string) {
  assert.ok(s, `${msg}: en linje`);
  const b = bruteNearest(d, r, R);
  assert.ok(Math.hypot(s.x2 - b.p.x, s.y2 - b.p.y) < 0.6, `${msg}: slutar på kantens närmaste punkt (${s.x2.toFixed(1)},${s.y2.toFixed(1)} mot ${b.p.x.toFixed(1)},${b.p.y.toFixed(1)})`);
  assert.ok(Math.abs(Math.hypot(s.x1 - d.x, s.y1 - d.y) - TETHER_FROM_DOT) < 1e-6, `${msg}: börjar utanför pricken`);
  const len = Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
  assert.ok(Math.abs(len - (b.dist - TETHER_FROM_DOT)) < 0.6, `${msg}: linjen går rakt mot kanten`);
}

test('HUD till vänster om fönstret: linjen går från pricken i övre högra hörnet till panelens högra kant', () => {
  const dot = { x: 1100, y: 540 };
  const hud = { x: 502, y: 536, w: 360, h: 300 };
  const s = tetherSegment(dot, hud, R);
  assertSegment(s, dot, hud, 'vänster');
  assert.ok(s!.x2 > 855 && s!.x2 <= 862, 'på högra kanten');
});

test('HUD under fönstret och HUD till höger: närmaste punkten, också på ett rundat hörn', () => {
  const dot = { x: 700, y: 120 };
  assertSegment(tetherSegment(dot, { x: 300, y: 450, w: 360, h: 200 }, R), dot, { x: 300, y: 450, w: 360, h: 200 }, 'under, hörnet');
  assertSegment(tetherSegment(dot, { x: 340, y: 450, w: 360, h: 200 }, R), dot, { x: 340, y: 450, w: 360, h: 200 }, 'under, överkanten');
  const near = { x: 1000, y: 103 };
  assertSegment(tetherSegment(near, { x: 1018, y: 100, w: 360, h: 200 }, R), near, { x: 1018, y: 100, w: 360, h: 200 }, 'höger');
});

test('prövat mot kanten punkt för punkt på 200 lägen runt panelen (kalibrerat: en rak rektangel utan radie missar hörnen)', () => {
  const hud = { x: 500, y: 300, w: 360, h: 260 };
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  let cornerMiss = 0;
  for (let i = 0; i < 200; i++) {
    const d = { x: 200 + rnd() * 1000, y: 50 + rnd() * 800 };
    const s = tetherSegment(d, hud, R);
    const b = bruteNearest(d, hud, R);
    const inside = d.x > hud.x && d.x < hud.x + hud.w && d.y > hud.y && d.y < hud.y + hud.h;
    if (inside || b.dist < TETHER_FROM_DOT + TETHER_MIN) {
      // I panelen, eller så nära kanten att ingen linje behövs (gränsen prövas inte på bråkdelen av en pixel).
      if (b.dist < TETHER_FROM_DOT + TETHER_MIN - 0.6 || inside) assert.equal(s, null, `ingen linje vid ${d.x.toFixed(0)},${d.y.toFixed(0)}`);
      continue;
    }
    assertSegment(s, d, hud, `läge ${i}`);
    // Planterat fel: slutpunkten klämd till den raka rektangeln. Den hamnar utanför den rundade kanten i hörnen.
    const px = Math.max(hud.x, Math.min(hud.x + hud.w, d.x));
    const py = Math.max(hud.y, Math.min(hud.y + hud.h, d.y));
    if (Math.hypot(px - b.p.x, py - b.p.y) >= 0.6) cornerMiss++;
  }
  assert.ok(cornerMiss > 10, `den planterade raka rektangeln ska missa i hörnen (${cornerMiss})`);
});

test('ingen linje när pricken saknas, ligger i panelen eller precis vid den; utanför vyn går linjen ut ur bild', () => {
  const hud = { x: 500, y: 300, w: 360, h: 260 };
  assert.equal(tetherSegment(null, hud, R), null);
  assert.equal(tetherSegment({ x: NaN, y: 400 }, hud, R), null);
  const off = { x: 1900, y: 120 };
  assertSegment(tetherSegment(off, hud, R), off, hud, 'pricken utanför vyn');
  assert.equal(tetherSegment({ x: 700, y: 400 }, hud, R), null);
  assert.equal(tetherSegment({ x: 700, y: 300 - (TETHER_FROM_DOT + TETHER_MIN) + 1 }, hud, R), null);
  assert.ok(tetherSegment({ x: 700, y: 300 - (TETHER_FROM_DOT + TETHER_MIN) - 1 }, hud, R));
});
