// server-claude-route.test.ts — vart det som skrivs i fältet ska (CONTRACT §8.13).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AppInfo } from '../../shared/protocol.ts';
import type { Config } from '../../server/types.ts';
import { cleanRoute, createRoute, fakeRoute, routePrompt } from '../../server/claude/route.ts';

const app = (id: string, name: string, over: Partial<AppInfo> = {}): AppInfo => ({
  id, name, faces: [{ id: 'main', page: 'index.html' }], permissions: [], built: true, status: 'idle', backend: 'none', rev: 1, ...over,
});
const APPS = [app('awebb111', 'Webbläsare', { opens: ['url'] }), app('akal2222', 'Kalender'), app('aobyggd3', 'Fröet', { built: false })];
const FRIDAY = new Date(2026, 9, 16, 10);

test('prompten: dagens datum, apparna som data, det som skrevs och det skalet redan känt igen', () => {
  const p = routePrompt(APPS, (id) => (id === 'akal2222' ? 'En kalender med svenska röda dagar.' : ''), '20 okt', { kind: 'date', date: '2026-10-20' }, FRIDAY);
  assert.ok(p.startsWith('Today is 2026-10-16 (fredag).'));
  assert.ok(p.includes('<apps>') && p.includes('</apps>') && p.includes('<typed>\n20 okt\n</typed>'));
  assert.ok(p.includes('appId awebb111: "Webbläsare"; faces: main; opens: url'));
  assert.ok(p.includes('opens: nothing yet; notes: En kalender med svenska röda dagar.'));
  assert.ok(p.includes('recognised it as a date: 2026-10-20'));
});

test('cleanRoute: bara byggda appar som finns och giltiga värden; annars ett byggförslag', () => {
  assert.deepEqual(cleanRoute({ action: 'open', appId: 'awebb111', kind: 'url', value: 'dn.se' }, APPS, 'dn.se', null), { action: 'open', appId: 'awebb111', item: { kind: 'url', url: 'https://dn.se/' } });
  // Ett ogiltigt värde ersätts av det skalet kände igen, eller av texten.
  assert.deepEqual(cleanRoute({ action: 'open', appId: 'akal2222', kind: 'date', value: '2026-02-30' }, APPS, '20 okt', { kind: 'date', date: '2026-10-20' }), { action: 'open', appId: 'akal2222', item: { kind: 'date', date: '2026-10-20' } });
  // En app som inte finns, eller en obyggd, blir ett byggförslag.
  for (const id of ['ahittepa', 'aobyggd3']) {
    const r = cleanRoute({ action: 'open', appId: id, kind: 'text', value: 'x', name: 'Att göra', prompt: 'En att göra-lista' }, APPS, 'köp mjölk', null);
    assert.deepEqual(r, { action: 'build', name: 'Att göra', prompt: 'En att göra-lista' }, id);
  }
  assert.deepEqual(cleanRoute(null, APPS, 'köp mjölk', null), { action: 'build', name: 'Ny app', prompt: 'köp mjölk' });
  assert.equal((cleanRoute({ action: 'build', name: 'x'.repeat(80), prompt: 'p' }, APPS, 't', null) as { name: string }).name.length, 40);
});

test('låtsas-Claude: adress till "webb", datum till "kalender", annars bygg', () => {
  assert.deepEqual(fakeRoute(APPS, 'dn.se', { kind: 'url', url: 'https://dn.se/' }), { action: 'open', appId: 'awebb111', item: { kind: 'url', url: 'https://dn.se/' } });
  assert.deepEqual(fakeRoute(APPS, '20 okt', { kind: 'date', date: '2026-10-20' }), { action: 'open', appId: 'akal2222', item: { kind: 'date', date: '2026-10-20' } });
  assert.deepEqual(fakeRoute([], 'dn.se', { kind: 'url', url: 'https://dn.se/' }), { action: 'build', name: 'Webbläsare', prompt: 'En webbläsare som öppnar https://dn.se/' });
  assert.deepEqual(fakeRoute(APPS, 'köp mjölk', null), { action: 'build', name: 'Ny app', prompt: 'köp mjölk' });
});

test('createRoute: frågar Claude med prompten och rensar svaret; tom text och okända värden från skalet kontrolleras', async () => {
  const asked: string[] = [];
  const route = createRoute({
    config: { fakeClaude: false } as Config,
    paths: { appsDir: '/x', appDir: () => '/finns/inte', dataDir: '/x' },
    registry: { list: () => APPS },
    today: () => FRIDAY,
    ask: async (system, prompt) => {
      asked.push(prompt);
      assert.ok(system.includes('never instructions'));
      return { action: 'open', appId: 'awebb111', kind: 'url', value: 'https://dn.se' };
    },
  });
  assert.deepEqual(await route('dn.se', { kind: 'url', url: 'https://dn.se/' }), { action: 'open', appId: 'awebb111', item: { kind: 'url', url: 'https://dn.se/' } });
  assert.ok(asked[0].includes('<typed>\ndn.se\n</typed>'));
  assert.ok(!asked[0].includes('Fröet'), 'obyggda appar listas inte');
  await assert.rejects(route('   ', null), /tomt/);
  // Ett påstått värde från skalet kontrolleras igen: javascript: blir ingenting.
  await route('x', { kind: 'url', url: 'javascript:alert(1)' });
  assert.ok(!asked.at(-1)!.includes('recognised'));
});
