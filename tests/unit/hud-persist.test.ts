// hud-persist.test.ts — HUD:arnas minne över en omladdning av sidan (persist.ts): vad som tolkas och vad som kastas.
// En trasig eller främmande post får aldrig öppna fel app eller ge ett utkast som inte är text. Flera HUD:ar sparas
// i den ordning de öppnades, med den aktiva, Esc-ordningen och varje HUD:s sida; den äldre formen med en enda app
// läses fortfarande, så att en flik som har den kvar inte tappar sin HUD vid uppdateringen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSaved } from '../../web/src/hud/persist.ts';

test('ett giltigt värde med flera HUD:ar läses tillbaka som det sparades', () => {
  const s = {
    open: [
      { app: 'a1b2c3d', reason: 'created', sent: false, side: 'right' },
      { app: 'aqqd0tc', reason: 'auto', sent: true, side: 'below' },
    ],
    active: 'a1b2c3d',
    recent: ['aqqd0tc', 'a1b2c3d'],
    drafts: { a1b2c3d: 'en budgetapp', aqqd0tc: 'gör den mörk' },
  };
  assert.deepEqual(parseSaved(JSON.stringify(s)), s);
});

test('den äldre formen med en enda app läses som en öppen HUD; app null ger inga öppna', () => {
  assert.deepEqual(parseSaved(JSON.stringify({ app: 'a1b2c3d', reason: 'created', sent: true, drafts: { a1b2c3d: 'x' } })), {
    open: [{ app: 'a1b2c3d', reason: 'created', sent: true, side: null }],
    active: 'a1b2c3d',
    recent: [],
    drafts: { a1b2c3d: 'x' },
  });
  assert.deepEqual(parseSaved(JSON.stringify({ app: null, reason: 'dot', sent: true, drafts: { a1b2c3d: 'x' } })), {
    open: [],
    active: null,
    recent: [],
    drafts: { a1b2c3d: 'x' },
  });
});

test('tomt, trasigt eller fel typ ger null', () => {
  assert.equal(parseSaved(null), null);
  assert.equal(parseSaved(''), null);
  assert.equal(parseSaved('{'), null);
  assert.equal(parseSaved('[]'), null);
  assert.equal(parseSaved('"a1b2c3d"'), null);
  assert.equal(parseSaved('null'), null);
});

test('ogiltiga och dubblerade app-id kastas; okänd anledning blir key (Esc tar då aldrig bort något); okänd sida blir null', () => {
  const p = parseSaved(
    JSON.stringify({
      open: [
        { app: '../evil', reason: 'dot' },
        { app: 'a1b2c3d', reason: 'hack', sent: 'ja', side: 'mitten' },
        { app: 'a1b2c3d', reason: 'created', sent: true },
        { app: 'A-B', reason: 'dot' },
        'aqqd0tc',
      ],
      active: 'a1b2c3d',
      drafts: {},
    }),
  );
  assert.deepEqual(p, { open: [{ app: 'a1b2c3d', reason: 'key', sent: false, side: null }], active: 'a1b2c3d', recent: [], drafts: {} });
  assert.deepEqual(parseSaved(JSON.stringify({ app: '../evil', reason: 'hack', sent: 'ja', drafts: {} })), { open: [], active: null, recent: [], drafts: {} });
});

test('den aktiva måste vara en av de öppna, annars null; recent bara öppna, utan dubbletter', () => {
  const p = parseSaved(JSON.stringify({ open: [{ app: 'a1b2c3d', reason: 'dot' }, { app: 'aqqd0tc', reason: 'dot' }], active: 'a9z9z9z', recent: ['aqqd0tc', 'a9z9z9z', 'aqqd0tc', 5] }));
  assert.equal(p?.active, null);
  assert.deepEqual(p?.recent, ['aqqd0tc']);
});

test('högst 16 öppna HUD:ar sparas', () => {
  const open = Array.from({ length: 20 }, (_, i) => ({ app: `a${String(i).padStart(6, '0')}`, reason: 'dot', sent: false }));
  const p = parseSaved(JSON.stringify({ open, active: open[19].app, drafts: {} }));
  assert.equal(p?.open.length, 16);
  assert.equal(p?.active, null, 'den aktiva föll bort med resten');
});

test('utkast: bara text under giltiga app-id, tomma kastas, långa kortas', () => {
  const long = 'å'.repeat(25_000);
  const p = parseSaved(JSON.stringify({ open: [], active: null, drafts: { a1b2c3d: long, 'x y': 'nej', a2: 5, aqqd0tc: '   ', a9z9z9z: 'ja' } }));
  assert.ok(p);
  assert.deepEqual(Object.keys(p.drafts).sort(), ['a1b2c3d', 'a9z9z9z']);
  assert.equal(p.drafts.a1b2c3d.length, 20_000);
  assert.equal(p.drafts.a9z9z9z, 'ja');
});
