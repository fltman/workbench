// world-seed.test.ts — fröytans konstruktionslinjer (CONTRACT §14).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { columnX, seedGroups, seedGuides, toolsInLastTurn } from '../../web/src/world/seed.ts';

/** Alla tal i en SVG-sökväg som (x, y)-par, och bågarnas ändpunkter. */
function coords(d: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const m of d.matchAll(/([MLHVAZ])([^MLHVAZ]*)/g)) {
    const n = m[2].trim() ? m[2].trim().split(/[\s,]+/).map(Number) : [];
    if (m[1] === 'M' || m[1] === 'L') out.push([n[0], n[1]]);
    if (m[1] === 'A') out.push([n[5], n[6]]);
  }
  return out;
}

test('grupperna kommer i ordningen rubrikrad, rader, en kolumn, och allt ligger inom arket', () => {
  for (const [W, H] of [[640, 420], [960, 600], [300, 200], [2400, 1600], [240, 160]]) {
    const groups = seedGroups(W, H);
    assert.ok(groups.length >= 3, `${W}×${H}: ${groups.length} grupper`);
    for (const g of groups) {
      assert.ok(g.paths.length > 0);
      for (const d of g.paths) {
        for (const [x, y] of coords(d)) {
          assert.ok(Number.isFinite(x) && Number.isFinite(y), d);
          assert.ok(x >= -0.5 && x <= W + 0.5 && y >= -0.5 && y <= H + 0.5, `${W}×${H}: (${x}, ${y}) utanför i ${d}`);
        }
      }
    }
    // Rubrikraden: en vågrät linje tvärs över arket.
    assert.ok(groups[0].paths.some((d) => /^M0 [\d.]+L\d+ [\d.]+$/.test(d) && d.includes(`L${W} `)), 'rubrikradens linje');
    // Kolumnen i en bred app: en lodrät linje vid columnX.
    const col = columnX(W);
    if (col !== null) assert.ok(groups[2].paths.some((d) => d.startsWith(`M${col} `)), 'kolumnens linje');
  }
});

test('stödlinjerna: fyra marginallinjer dragna förbi hörnen', () => {
  const g = seedGuides(640, 420);
  assert.equal(g.length, 4);
  assert.deepEqual(g[0], 'M0 24L640 24');
  assert.deepEqual(g[3], 'M616 0L616 420');
});

test('tool-händelser räknas från den senaste turens start', () => {
  assert.equal(toolsInLastTurn([]), 0);
  const ev = [
    { k: 'turn', phase: 'start' },
    { k: 'tool' },
    { k: 'tool-done' },
    { k: 'tool' },
    { k: 'turn', phase: 'end' },
    { k: 'user' },
    { k: 'turn', phase: 'start' },
    { k: 'tool' },
  ];
  assert.equal(toolsInLastTurn(ev), 1);
  assert.equal(toolsInLastTurn(ev.slice(0, 5)), 2);
});
