// try_app (K8): spärren "en körning per app" måste släppas också när körningen dör innan webbläsaren
// öppnat en kontext (trasig app.json, Chrome som inte startar), annars vägras appen try_app tills omstart.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apiKey, createShots, dragProblem, isLocalHost } from '../../server/claude/shots.ts';
import type { AppRegistry, SceneStore } from '../../server/types.ts';

test('try_app: ett fel före kontexten släpper spärren', async () => {
  let broken = true;
  const registry = {
    get: () => ({ id: 'aapp001' }),
    manifest: () => {
      if (broken) throw new Error('app.json kunde inte läsas');
      return { name: 'x', faces: [{ id: 'main', page: 'index.html' }], permissions: [] };
    },
  } as unknown as AppRegistry;
  const scene = { window: () => undefined } as unknown as SceneStore;
  const shots = createShots({ config: { port: 8289 } as never, registry, scene, logs: { append: () => {} } as never });
  try {
    await assert.rejects(shots.tryRun('aapp001', { steps: [{ shot: true }] }), /app\.json/);
    broken = false;
    // En sida som inte finns avvisas före webbläsaren, så inget Chrome behövs här.
    await assert.rejects(shots.tryRun('aapp001', { face: 'finns-inte', steps: [{ shot: true }] }), /No face "finns-inte"/);
  } finally {
    await shots.close();
  }
});

test('try_app drag: punkterna prövas mot fönstrets storlek (0 ≤ x ≤ w, 0 ≤ y ≤ h)', () => {
  assert.equal(dragProblem([[0, 0], [480, 320]], 480, 320), null);
  assert.match(dragProblem([[10, 10], [481, 10]], 480, 320) ?? '', /drag point 2 \(481,10\) is outside the window \(0–480 × 0–320\)/);
  assert.match(dragProblem([[10, 321], [1, 1]], 480, 320) ?? '', /drag point 1 .* outside/);
  // Utan känd storlek prövas bara antal och tal.
  assert.equal(dragProblem([[10, 10], [5000, 10]]), null);
});

test('try_app api: nycklarna normaliseras som webbläsaren skriver adressen och stannar under /api', () => {
  assert.equal(apiKey('/api/items?folder=inbox'), '/api/items?folder=inbox');
  assert.equal(apiKey('/api/q?s=å'), '/api/q?s=%C3%A5');
  assert.equal(apiKey('/api/a b'), '/api/a%20b');
  assert.equal(apiKey('/api/./x'), '/api/x');
  assert.equal(apiKey('/api'), '/api');
  for (const k of ['/api/../x', '/api/%2e%2e/x', '/api\\..\\x', '/apix', '/x', '/api#a', 5, null]) assert.equal(apiKey(k), null, String(k));
});

// "Lokala värdar avbryts alltid" (§8.7): url.hostname i alla stavningar som Chrome ansluter till den här datorn
// med. En provkörning nådde annars en lyssnare på 127.0.0.1 via http://localhost.:<port>/,
// http://[::ffff:127.0.0.1]:<port>/ och http://[::]:<port>/ (samma värden som Chrome ger url.hostname).
test('isLocalHost: alla stavningar av den här datorn, men inget annat', () => {
  for (const h of ['localhost', 'a.localhost', 'LOCALHOST', '127.0.0.1', '127.1.2.3', '[::1]', '0.0.0.0', 'localhost.', 'aprobe2.localhost.', '[::]', '[::ffff:7f00:1]', '[::ffff:0:0]']) {
    assert.equal(isLocalHost(h), true, h);
  }
  for (const h of ['example.com', 'localhost.example.com', 'mylocalhost', '128.0.0.1', '[2001:db8::1]']) assert.equal(isLocalHost(h), false, h);
});
