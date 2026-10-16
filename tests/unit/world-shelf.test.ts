// world-shelf.test.ts — raden med minimerade appar och flykten dit (CONTRACT §10.7).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FLIGHT_BLUR, SHELF_GAP, SHELF_MARGIN, TILE_H, TILE_W_MAX, flight, shelfSlots, tileSize } from '../../web/src/world/shelf.ts';

const near = (a: number, b: number, eps = 1e-9, msg = ''): void => assert.ok(Math.abs(a - b) <= eps, `${msg} ${a} ≠ ${b} (±${eps})`);

test('miniatyren har fönstrets form: TILE_H hög, breda fönster högst TILE_W_MAX breda', () => {
  const normal = tileSize(640, 480);
  near(normal.h, TILE_H);
  near(normal.w, TILE_H * (640 / 480));
  const wide = tileSize(2400, 300);
  near(wide.w, TILE_W_MAX);
  near(wide.w / wide.h, 2400 / 300, 1e-9, 'formen');
  assert.ok(wide.h < TILE_H);
  const tall = tileSize(300, 900);
  near(tall.h, TILE_H);
  near(tall.w, TILE_H / 3);
  assert.deepEqual(tileSize(0, 0), { w: TILE_H, h: TILE_H }, 'trasig storlek ger en kvadrat');
});

test('raden: från vänster i ordning, nederkanterna i linje SHELF_MARGIN från vyns nederkant', () => {
  const sizes = [tileSize(640, 480), tileSize(2400, 300), tileSize(300, 900)];
  const s = shelfSlots(sizes, 1440, 900);
  near(s[0].x, SHELF_MARGIN);
  for (let i = 0; i < s.length; i++) {
    near(s[i].y + s[i].h, 900 - SHELF_MARGIN, 1e-9, `nederkant ${i}`);
    near(s[i].w, sizes[i].w);
    if (i) near(s[i].x, s[i - 1].x + s[i - 1].w + SHELF_GAP, 1e-9, `mellanrum ${i}`);
  }
  assert.deepEqual(shelfSlots([], 1440, 900), []);
});

test('trångt: rutorna skjuts ihop lika mycket och alla syns inom vyn (kalibrerat: utan ihopskjutning hamnar de utanför)', () => {
  const sizes = Array.from({ length: 12 }, () => tileSize(640, 480));
  const vw = 900;
  const naive = SHELF_MARGIN + sizes.reduce((s, z) => s + z.w + SHELF_GAP, 0) - SHELF_GAP;
  assert.ok(naive > vw, 'kalibrering: utan ihopskjutning går raden utanför vyn');
  const s = shelfSlots(sizes, vw, 700);
  const last = s.at(-1)!;
  assert.ok(last.x + last.w <= vw - SHELF_MARGIN + 1e-6, `sista rutan utanför vyn: ${last.x + last.w}`);
  const steps = s.slice(1).map((b, i) => b.x - s[i].x);
  for (const st of steps) near(st, steps[0], 1e-9, 'lika steg');
  assert.ok(steps[0] >= 24, 'aldrig tätare än 24 px');
});

test('flykten: börjar på fönstret, slutar i rutan med ett varv runt två axlar, lutning och oskärpa bara mitt i; storleken ändras före vridningen', () => {
  const a = { x: 300, y: 120, w: 640, h: 480 };
  const b = { x: 18, y: 798, w: 112, h: 84 };
  const f0 = flight(a, b, 0, 1);
  near(f0.cx, a.x + a.w / 2);
  near(f0.cy, a.y + a.h / 2);
  near(f0.w, a.w, 1e-6);
  near(f0.yaw, 0);
  const f1 = flight(a, b, 1, 1);
  near(f1.cx, b.x + b.w / 2);
  near(f1.cy, b.y + b.h / 2);
  near(f1.w, b.w, 1e-6);
  near(f1.yaw, -360);
  near(f1.pitch, 360, 1e-9, 'ett varv runt den vågräta axeln också');
  for (const f of [f0, f1]) {
    near(f.roll, 0, 1e-9, 'ingen lutning i ändarna');
    near(f.blur, 0, 1e-9, 'skarp i ändarna');
  }
  const m = flight(a, b, 0.5, 1);
  near(m.blur, FLIGHT_BLUR, 1e-9, 'oskärpan störst mitt i flykten');
  assert.ok(Math.abs(m.roll) > 10 && Math.abs(m.pitch) > 0 && Math.abs(m.yaw) > 0, `vriden i alla tre led mitt i flykten: ${JSON.stringify(m)}`);
  const back = flight(b, a, 1, -1);
  near(back.yaw, 360);
  near(back.pitch, -360);
  // Halvvägs i vridningen är miniatyren redan mindre än en tredjedel av fönstret, så baksidan syns knappt.
  let half = 0;
  for (let p = 0; p <= 1; p += 0.01) if (Math.abs(flight(a, b, p, 1).yaw) >= 90) { half = p; break; }
  assert.ok(flight(a, b, half, 1).w < a.w / 3, `för stor när den vänt sig 90°: ${flight(a, b, half, 1).w}`);
  // Krymper hela vägen, och höjden faller snabbare än sidled går (bågen ned).
  let prev = Infinity;
  for (let p = 0; p <= 1.0001; p += 0.05) {
    const f = flight(a, b, p, 1);
    assert.ok(f.w <= prev + 1e-9);
    prev = f.w;
  }
  const q = flight(a, b, 0.3, 1);
  assert.ok((q.cy - f0.cy) / (f1.cy - f0.cy) > (q.cx - f0.cx) / (f1.cx - f0.cx), 'glider ned i en båge');
});
