// hud-tether.test.ts — linjen mellan appens fönster och dess HUD (CONTRACT §13, §14): kant mot kant, aldrig över appen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TETHER_MIN, tetherBetween, type Segment } from '../../web/src/hud/tether.ts';

type R = { x: number; y: number; w: number; h: number };

/** Punkter längs en rundad rektangels kant (oberoende av koden). */
function perimeter(r: R, rad: number, n = 600): Array<{ x: number; y: number }> {
  const pts: Array<{ x: number; y: number }> = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    pts.push({ x: r.x + rad + t * (r.w - 2 * rad), y: r.y }, { x: r.x + rad + t * (r.w - 2 * rad), y: r.y + r.h });
    pts.push({ x: r.x, y: r.y + rad + t * (r.h - 2 * rad) }, { x: r.x + r.w, y: r.y + rad + t * (r.h - 2 * rad) });
    const a = (t * Math.PI) / 2;
    for (const [cx, cy, sx, sy] of [
      [r.x + rad, r.y + rad, -1, -1], [r.x + r.w - rad, r.y + rad, 1, -1], [r.x + rad, r.y + r.h - rad, -1, 1], [r.x + r.w - rad, r.y + r.h - rad, 1, 1],
    ]) pts.push({ x: cx + sx * rad * Math.cos(a), y: cy + sy * rad * Math.sin(a) });
  }
  return pts;
}
const minDist = (a: R, ra: number, b: R, rb: number): number => {
  const pa = perimeter(a, ra, 300);
  const pb = perimeter(b, rb, 300);
  let m = Infinity;
  for (const p of pa) for (const q of pb) m = Math.min(m, Math.hypot(p.x - q.x, p.y - q.y));
  return m;
};
const len = (s: Segment): number => Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
/** Går linjen in i den rundade rektangeln (mer än 0,5 px innanför kanten)? Hörnen räknas rundade, som de ritas. */
const enters = (s: Segment, r: R, rad: number): boolean => {
  for (let k = 0.02; k < 0.98; k += 0.02) {
    const x = s.x1 + (s.x2 - s.x1) * k;
    const y = s.y1 + (s.y2 - s.y1) * k;
    // Avståndet till den inre rektangeln (krympt med radien) mindre än radien: innanför den rundade kanten.
    const ix = Math.max(r.x + rad, Math.min(r.x + r.w - rad, x));
    const iy = Math.max(r.y + rad, Math.min(r.y + r.h - rad, y));
    if (Math.hypot(x - ix, y - iy) < rad - 0.5) return true;
  }
  return false;
};

test('HUD till höger, i linje med överkanten: en kort vågrät linje över mellanrummet, nära överkanten', () => {
  const win = { x: 100, y: 100, w: 400, h: 300 };
  const hud = { x: 514, y: 100, w: 360, h: 200 };
  assert.deepEqual(tetherBetween(win, 16, hud, 22), { x1: 500, y1: 158, x2: 514, y2: 158 });
});

test('HUD under fönstret: lodrät över mellanrummet, aldrig diagonalt över appen (kalibrerat: linjen från pricken gick in i fönstret)', () => {
  const win = { x: 100, y: 100, w: 720, h: 300 };
  const hud = { x: 100, y: 428, w: 360, h: 200 };
  const s = tetherBetween(win, 16, hud, 22)!;
  assert.deepEqual(s, { x1: 158, y1: 400, x2: 158, y2: 428 });
  assert.equal(enters(s, win, 16), false);
  // Kalibrering: den gamla linjen, från pricken i fönstrets övre högra hörn till panelens närmaste punkt, korsar appen.
  const old = { x1: 812, y1: 108, x2: 452, y2: 432 };
  assert.equal(enters(old, win, 16), true, 'kalibrering: detektorn ser en linje som går över appen');
});

test('på 300 lägen: linjen är det kortaste avståndet mellan kanterna och går aldrig in i fönstret eller panelen', () => {
  let seed = 11;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const win = { x: 400, y: 300, w: 420, h: 280 };
  let drawn = 0;
  for (let i = 0; i < 300; i++) {
    const hud = { x: rnd() * 1300 - 100, y: rnd() * 900 - 100, w: 360, h: 120 + rnd() * 200 };
    const s = tetherBetween(win, 16, hud, 22);
    const m = minDist(win, 16, hud, 22);
    const overlap = hud.x < win.x + win.w && hud.x + hud.w > win.x && hud.y < win.y + win.h && hud.y + hud.h > win.y;
    if (overlap || m < TETHER_MIN + 0.5) {
      if (overlap) assert.equal(s, null, `överlapp ger ingen linje (${i})`);
      continue;
    }
    assert.ok(s, `en linje (${i})`);
    drawn++;
    assert.ok(Math.abs(len(s) - m) < 1, `kortast (${i}): ${len(s).toFixed(2)} mot ${m.toFixed(2)}`);
    assert.equal(enters(s, win, 16), false, `går in i fönstret (${i})`);
    assert.equal(enters(s, hud, 22), false, `går in i panelen (${i})`);
  }
  assert.ok(drawn > 150, `för få lägen med linje: ${drawn}`);
});

test('ingen linje när de överlappar, nuddar eller ligger närmare än TETHER_MIN; trasiga tal ger ingen', () => {
  const win = { x: 100, y: 100, w: 400, h: 300 };
  assert.equal(tetherBetween(win, 16, { x: 300, y: 200, w: 360, h: 200 }, 22), null);
  assert.equal(tetherBetween(win, 16, { x: 500 + TETHER_MIN - 1, y: 100, w: 360, h: 200 }, 22), null);
  assert.ok(tetherBetween(win, 16, { x: 500 + TETHER_MIN + 1, y: 100, w: 360, h: 200 }, 22));
  assert.equal(tetherBetween({ ...win, x: Number.NaN }, 16, { x: 600, y: 100, w: 360, h: 200 }, 22), null);
});
