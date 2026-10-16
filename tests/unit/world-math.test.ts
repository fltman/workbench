// world-math.test.ts — kurvor, fjädrar och tokens (de rörelser världen driver per bildruta ska vara samma
// fjädrar som tokens.css beskriver).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cubicBezier, easeOutCubic, easeSnap, parseLinearEasing, parseMs, smoothstep } from '../../web/src/world/math.ts';
import { parseHex, parseNum } from '../../web/src/world/tokens.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TOKENS = fs.readFileSync(path.join(ROOT, 'web/src/styles/tokens.css'), 'utf8');
const token = (name: string): string => {
  const m = new RegExp(`${name}:\\s*([^;]+);`).exec(TOKENS);
  assert.ok(m, `saknar ${name}`);
  return m[1].trim();
};
const near = (a: number, b: number, eps = 1e-9, msg = ''): void => assert.ok(Math.abs(a - b) <= eps, `${msg} ${a} ≠ ${b} (±${eps})`);

/** Oberoende lösning av en cubic-bezier med Newtons metod (för att kontrollera lösaren i math.ts). */
function newtonBezier(x1: number, y1: number, x2: number, y2: number, x: number): number {
  let t = x;
  for (let i = 0; i < 60; i++) {
    const X = 3 * (1 - t) ** 2 * t * x1 + 3 * (1 - t) * t * t * x2 + t ** 3;
    const dX = 3 * (1 - t) ** 2 * x1 + 6 * (1 - t) * t * (x2 - x1) + 3 * t * t * (1 - x2);
    t -= (X - x) / dX;
  }
  return 3 * (1 - t) ** 2 * t * y1 + 3 * (1 - t) * t * t * y2 + t ** 3;
}

test('cubic-bezier: ändpunkter, monoton, samma värden som en oberoende Newton-lösning av --wb-ease-snap', () => {
  const f = cubicBezier(0.25, 0.1, 0.25, 1);
  assert.equal(f(0), 0);
  assert.equal(f(1), 1);
  let prev = 0;
  for (let t = 0; t <= 1; t += 0.01) {
    const v = easeSnap(t);
    assert.ok(v >= prev - 1e-9);
    prev = v;
  }
  assert.equal(token('--wb-ease-snap'), 'cubic-bezier(0.77, 0, 0.175, 1)');
  for (const x of [0.1, 0.25, 0.5, 0.75, 0.9]) near(easeSnap(x), newtonBezier(0.77, 0, 0.175, 1, x), 1e-6, `x=${x}`);
  near(easeOutCubic(0.5), 0.875);
  assert.equal(smoothstep(0, 1, 0.5), 0.5);
});

test('fjädrarna ur tokens.css tolkas: rätt ändpunkter och den utlovade överslängen', () => {
  const soft = parseLinearEasing(token('--wb-spring-soft'));
  const pop = parseLinearEasing(token('--wb-spring-pop'));
  const calm = parseLinearEasing(token('--wb-spring-calm'));
  assert.ok(soft && pop && calm);
  for (const f of [soft, pop, calm]) {
    assert.equal(f(0), 0);
    assert.equal(f(1), 1);
  }
  const peak = (f: (t: number) => number): number => {
    let m = 0;
    for (let t = 0; t <= 1; t += 0.001) m = Math.max(m, f(t));
    return m;
  };
  // tokens.css: soft 4,8 % översläng, pop 15 %, calm ingen.
  near(peak(soft), 1.048, 0.002, 'soft');
  near(peak(pop), 1.15, 0.002, 'pop');
  assert.ok(peak(calm) <= 1, 'calm slår inte över');
  assert.equal(parseMs(token('--wb-spring-soft-ms'), 0), 773);
  assert.equal(parseMs(token('--wb-dot-breath'), 0), 3200);
  assert.equal(parseLinearEasing('ease-out'), null);
  assert.equal(parseMs('fel', 42), 42);
});

test('tokens: färger och tal', () => {
  const c = parseHex(token('--wb-canvas-center'), [0, 0, 0]);
  near(c[0], 0xb0 / 255);
  near(c[2], 0xb8 / 255);
  assert.deepEqual(parseHex('rgba(1,2,3,.5)', [9, 9, 9]), [9, 9, 9]);
  assert.equal(parseNum(token('--wb-grid-spacing'), 0), 24);
  assert.equal(parseNum(token('--wb-grid-darken'), 0), 0.085);
  assert.equal(parseNum(token('--wb-win-radius'), 0), 16);
});
