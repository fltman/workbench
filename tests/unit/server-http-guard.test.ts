// Vakten (CONTRACT §4.1): Host, Origin, Sec-Fetch-*, Service-Worker. Varje "fälls"-test är först
// kalibrerat mot en planterad läcka (leakyGuard) där samma detektor MÅSTE larma.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { guard } from '../../server/http/guard.ts';
import type { GuardDecision, GuardRequest } from '../../server/http/guard.ts';
import { NAV, leakyGuard, request, rmDir, sameOrigin, startRouter, tempDir } from './server-http-fakes.test.ts';
import type { Res, Started } from './server-http-fakes.test.ts';

const P = 8240;
const APP = 'aabc123';
const OTHER = 'aother9';
const exists = (id: string) => id === APP || id === OTHER;

function g(headers: Record<string, string>, opts: { method?: string; url?: string; upgrade?: boolean } = {}): GuardDecision {
  const req: GuardRequest = { method: opts.method ?? 'GET', url: opts.url ?? '/', headers };
  return guard(req, { port: P, appExists: exists, upgrade: opts.upgrade ?? false });
}

const status = (d: GuardDecision): number | string => (d.ok ? d.kind : d.status);

describe('vakten: Host', () => {
  test('localhost:<port> är skalet, även med versaler', () => {
    assert.equal(status(g({ host: `localhost:${P}` })), 'shell');
    assert.equal(status(g({ host: `LocalHost:${P}` })), 'shell');
  });
  test('saknad Host, fel port, främmande namn och DNS-rebinding ger 421', () => {
    assert.equal(status(g({})), 421);
    assert.equal(status(g({ host: 'localhost' })), 421);
    assert.equal(status(g({ host: 'localhost:9999' })), 421);
    assert.equal(status(g({ host: `evil.example:${P}` })), 421);
    assert.equal(status(g({ host: `localhost.evil.example:${P}` })), 421);
    assert.equal(status(g({ host: `0.0.0.0:${P}` })), 421);
    assert.equal(status(g({ host: `192.168.1.10:${P}` })), 421);
  });
  test('127.0.0.1 och [::1]: GET/HEAD får 308 till localhost med sökvägen, annat 421', () => {
    const d = g({ host: `127.0.0.1:${P}` }, { url: '/a/b?c=1' });
    assert.deepEqual(d, { ok: false, status: 308, reason: 'till localhost', location: `http://localhost:${P}/a/b?c=1` });
    assert.equal(status(g({ host: `[::1]:${P}` }, { method: 'HEAD' })), 308);
    assert.equal(status(g({ host: `127.0.0.1:${P}` }, { method: 'POST' })), 421);
    assert.equal(status(g({ host: `[::1]:${P}` }, { method: 'DELETE' })), 421);
    // Konstiga sökvägar följer inte med i Location.
    const odd = g({ host: `127.0.0.1:${P}` }, { url: '//evil.example/x' });
    assert.equal(!odd.ok && odd.location, `http://localhost:${P}/`);
  });
  test('<id>.localhost: bara giltiga id för appar som finns', () => {
    assert.deepEqual(g({ host: `${APP}.localhost:${P}` }), { ok: true, kind: 'app', appId: APP });
    assert.equal(status(g({ host: `${APP.toUpperCase()}.localhost:${P}` })), 'app');
    assert.equal(status(g({ host: `anotthere.localhost:${P}` })), 421);
    assert.equal(status(g({ host: `ab.localhost:${P}` })), 421);
    assert.equal(status(g({ host: `x.${APP}.localhost:${P}` })), 421);
    assert.equal(status(g({ host: `1abc123.localhost:${P}` })), 421);
    assert.equal(status(g({ host: `${APP}.localhost:9999` })), 421);
  });
});

describe('vakten: skalet', () => {
  const H = { host: `localhost:${P}` };
  const own = `http://localhost:${P}`;
  test('främmande eller null Origin ger 403', () => {
    assert.equal(status(g({ ...H, origin: 'http://evil.example' })), 403);
    assert.equal(status(g({ ...H, origin: 'null' })), 403);
    assert.equal(status(g({ ...H, origin: `http://${APP}.localhost:${P}` })), 403);
    assert.equal(status(g({ ...H, origin: `http://localhost:9999` })), 403);
    assert.equal(status(g({ ...H, origin: own })), 'shell');
  });
  test('Sec-Fetch-Site utom same-origin/none ger 403, utom navigering till dokument', () => {
    assert.equal(status(g({ ...H, ...sameOrigin() })), 'shell');
    assert.equal(status(g({ ...H, ...NAV })), 'shell');
    assert.equal(status(g({ ...H, 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'script' })), 403);
    assert.equal(status(g({ ...H, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' })), 403);
    assert.equal(status(g({ ...H, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' })), 'shell');
    // Skalet i en iframe är aldrig tillåtet.
    assert.equal(status(g({ ...H, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe' })), 403);
    // En navigering med främmande Origin (formulär-POST) fälls av Origin-regeln.
    assert.equal(status(g({ ...H, origin: 'http://evil.example', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' }, { method: 'POST' })), 403);
  });
  test('metoder utom GET/HEAD kräver skalets Origin', () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
      assert.equal(status(g({ ...H }, { method })), 403, method);
      assert.equal(status(g({ ...H, origin: own }, { method })), 'shell', method);
    }
    assert.equal(status(g({ ...H }, { method: 'HEAD' })), 'shell');
  });
  test('uppgraderingen kräver skalets Origin', () => {
    assert.equal(status(g({ ...H }, { upgrade: true })), 403);
    assert.equal(status(g({ ...H, origin: `http://${APP}.localhost:${P}` }, { upgrade: true })), 403);
    assert.equal(status(g({ ...H, origin: own }, { upgrade: true })), 'shell');
  });
});

describe('vakten: appen', () => {
  const H = { host: `${APP}.localhost:${P}` };
  const own = `http://${APP}.localhost:${P}`;
  test('Origin måste vara appens egen', () => {
    assert.equal(status(g({ ...H, origin: own }, { method: 'POST' })), 'app');
    assert.equal(status(g({ ...H, origin: `http://localhost:${P}` })), 403);
    assert.equal(status(g({ ...H, origin: `http://${OTHER}.localhost:${P}` })), 403);
    assert.equal(status(g({ ...H, origin: 'null' })), 403);
  });
  test('Sec-Fetch-Site: bara same-origin/none, och navigeringar till dokument eller iframe', () => {
    assert.equal(status(g({ ...H, ...sameOrigin() })), 'app');
    assert.equal(status(g({ ...H, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe' })), 'app');
    assert.equal(status(g({ ...H, 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' })), 'app');
    assert.equal(status(g({ ...H, 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image' })), 403);
    assert.equal(status(g({ ...H, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' })), 403);
    assert.equal(status(g({ ...H, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'frame' })), 403);
  });
  test('/api/* och /__wb/* får inte ramas in av en annan webbplats (SEC-4); som dokument går de igenom', () => {
    const frame = { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe' };
    const doc = { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
    // Kalibrering: samma inramning av en vanlig sida släpps igenom, så det är sökvägen som fäller.
    assert.equal(status(g({ ...H, ...frame }, { url: '/index.html' })), 'app');
    for (const url of ['/api/tid', '/api', '/api/x?y=1', '/__wb/store/x']) {
      assert.equal(status(g({ ...H, ...frame }, { url })), 403, url);
      assert.equal(status(g({ ...H, 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe' }, { url })), 403, `same-site ${url}`);
      assert.equal(status(g({ ...H, ...doc }, { url })), 'app', `dokument ${url}`);
      assert.equal(status(g({ ...H, ...sameOrigin(), 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe' }, { url })), 'app', `egen ram ${url}`);
    }
  });
  test('Service-Worker: script ger 403', () => {
    assert.equal(status(g({ ...H, 'service-worker': 'script', 'sec-fetch-site': 'same-origin', 'sec-fetch-dest': 'serviceworker' })), 403);
  });
  test('uppgraderingar (WebSocket mot /api) går med appens egen Origin', () => {
    assert.equal(status(g({ ...H, origin: own }, { upgrade: true })), 'app');
    assert.equal(status(g({ ...H, origin: 'http://evil.example' }, { upgrade: true })), 403);
  });
});

/* ------------------------- planterad läcka genom den riktiga routern ------------------------- */

describe('vakten sitter först i routern (kalibrerad mot en planterad läcka)', () => {
  const CANARY_APP = 'acanary1';
  let real: Started;
  let leaky: Started;
  let home: string;

  before(async () => {
    home = tempDir('guard');
    real = await startRouter({ home: path.join(home, 'real') });
    leaky = await startRouter({ home: path.join(home, 'leaky'), guardFn: leakyGuard });
    for (const s of [real, leaky]) {
      s.registry.add(CANARY_APP, { name: 'Kanariefågel', index: '<p>kanariefågel</p>' });
      s.registry.add(OTHER, { name: 'Annan', index: '<p>annan</p>' });
      const data = path.join(s.paths.appDir(CANARY_APP), 'data');
      fs.mkdirSync(data, { recursive: true });
      fs.writeFileSync(path.join(data, 'store.json'), JSON.stringify({ hemlig: 'KANARIE-STORE' }));
      fs.writeFileSync(path.join(s.paths.appDir(CANARY_APP), 'sw.js'), '// KANARIE-SW');
    }
  }, { timeout: 30_000 });
  after(async () => {
    await real?.close();
    await leaky?.close();
    rmDir(home);
  }, { timeout: 30_000 });

  /** Detektorn: förfrågan släpptes igenom och gav data. */
  const leaked = (r: Res, canary: string): boolean => r.status < 300 && r.text.includes(canary);
  const rejected = (r: Res): boolean => r.status === 403 || r.status === 421;

  async function both(make: (s: Started) => Parameters<typeof request>[1], canary: string): Promise<void> {
    const planted = await request(leaky.port, make(leaky));
    assert.equal(leaked(planted, canary), true, `detektorn larmar inte på den planterade läckan (status ${planted.status})`);
    const r = await request(real.port, make(real));
    assert.equal(leaked(r, canary), false, `läcka: status ${r.status}`);
    assert.equal(rejected(r), true, `väntade 403/421, fick ${r.status}`);
  }

  test('DNS-rebinding: Host evil.example når aldrig /api/snapshot', async () => {
    await both((s) => ({ path: '/api/snapshot', host: `evil.example:${s.port}` }), 'Kanariefågel');
  });

  test('främmande Origin på skalet når aldrig /api/snapshot', async () => {
    await both(
      (s) => ({ path: '/api/snapshot', headers: { origin: 'http://evil.example', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' } }),
      'Kanariefågel',
    );
  });

  test('en app läser aldrig en annan apps store', async () => {
    await both(
      (s) => ({
        path: '/__wb/store',
        host: `${CANARY_APP}.localhost:${s.port}`,
        headers: { origin: `http://${OTHER}.localhost:${s.port}`, 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' },
      }),
      'KANARIE-STORE',
    );
  });

  test('ett service worker-skript hämtas aldrig', async () => {
    await both(
      (s) => ({
        path: '/sw.js',
        host: `${CANARY_APP}.localhost:${s.port}`,
        headers: { 'service-worker': 'script', 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'same-origin', 'sec-fetch-dest': 'serviceworker' },
      }),
      'KANARIE-SW',
    );
  });

  test('DELETE utan Origin (lokal process utan webbläsare) tar aldrig bort en app', async () => {
    const planted = await request(leaky.port, { method: 'DELETE', path: `/api/apps/${OTHER}` });
    assert.equal(planted.status, 200, 'detektorn larmar inte på den planterade läckan');
    assert.ok(leaky.calls.includes(`registry.remove ${OTHER}`));
    const r = await request(real.port, { method: 'DELETE', path: `/api/apps/${OTHER}` });
    assert.equal(r.status, 403);
    assert.ok(!real.calls.some((c) => c.startsWith('registry.remove')), 'remove anropades trots 403');
    assert.ok(real.registry.get(OTHER));
  });

  test('127.0.0.1 som värd: 308 till localhost, aldrig innehåll', async () => {
    const r = await request(real.port, { path: '/api/snapshot?x=1', host: `127.0.0.1:${real.port}`, headers: NAV });
    assert.equal(r.status, 308);
    assert.equal(r.headers.location, `http://localhost:${real.port}/api/snapshot?x=1`);
    assert.equal(r.text, '');
  });

  test('ett fel i vakten fäller förfrågan (aldrig vidare)', async () => {
    const boom = await startRouter({
      home: path.join(home, 'boom'),
      guardFn: () => {
        throw new Error('vakten kraschade');
      },
    });
    try {
      const orig = console.error;
      console.error = () => {};
      const r = await request(boom.port, { path: '/api/snapshot' }).finally(() => {
        console.error = orig;
      });
      assert.equal(r.status, 500);
      assert.equal(r.text, '');
    } finally {
      await boom.close();
    }
  });
});
