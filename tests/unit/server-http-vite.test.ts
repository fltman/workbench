// Vite som middleware (CONTRACT §4.3) med exakt kontraktets optioner, mot en tillfällig WORKBENCH_HOME:
// /@fs/<home>/data/workbench.json och /@fs/<home>/apps/… ska ge 403 eller 404 även till skalets egen origin.
// Detektorn kalibreras först mot en planterad läcka (fs.allow som släpper in hela repot) där den MÅSTE larma.
// HMR-porten är en ledig port (tests/ports.ts).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type { ViteDevServer } from 'vite';
import { createShellVite, shellViteOptions } from '../../server/http/vite.ts';
import { shellCsp } from '../../server/http/headers.ts';
import { testPort } from '../ports.ts';
import { NAV, REPO, request, rmDir, sameOrigin, startRouter, tempDir } from './server-http-fakes.test.ts';
import type { Res, Started } from './server-http-fakes.test.ts';

const HMR = await testPort();
const APP = 'avite123';
const CANARY = { scene: 'KANARIE-SCEN', app: 'KANARIE-APP', secret: 'KANARIE-HEMLIS', chat: 'KANARIE-CHATT' };

function tryConnect(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    s.once('connect', () => {
      s.destroy();
      resolve(true);
    });
    s.once('error', () => resolve(false));
  });
}

const leaked = (r: Res, canary: string): boolean => r.status < 300 && r.text.includes(canary);

describe('Vite-middleware: apps/ och data/ serveras aldrig', () => {
  let root: string;
  let home: string;
  let vite: ViteDevServer;
  let s: Started;
  let attacks: { path: string; canary: string }[];

  before(async () => {
    root = tempDir('vite');
    home = path.join(root, 'home');
    fs.mkdirSync(path.join(home, 'data', 'apps', APP), { recursive: true });
    fs.mkdirSync(path.join(home, 'apps', APP, 'data'), { recursive: true });
    fs.writeFileSync(path.join(home, 'data', 'workbench.json'), JSON.stringify({ version: 1, note: CANARY.scene }));
    fs.writeFileSync(path.join(home, 'data', 'apps', APP, 'chat.jsonl'), JSON.stringify({ k: 'user', text: CANARY.chat }) + '\n');
    fs.writeFileSync(path.join(home, 'apps', APP, 'index.html'), `<p>${CANARY.app}</p>`);
    fs.writeFileSync(path.join(home, 'apps', APP, 'data', 'secrets.json'), JSON.stringify({ k: CANARY.secret }));
    const H = fs.realpathSync.native(home);
    attacks = [
      { path: `/@fs${H}/data/workbench.json`, canary: CANARY.scene },
      { path: `/@fs${H}/data/workbench.json?raw`, canary: CANARY.scene },
      { path: `/@fs${H}/data/workbench.json?import`, canary: CANARY.scene },
      { path: `/@fs${H}/data/workbench.json?import&raw`, canary: CANARY.scene },
      { path: `/@fs${H}/data/workbench.json?url`, canary: CANARY.scene },
      { path: `/@fs${H}/DATA/workbench.json`, canary: CANARY.scene },
      { path: `/@fs${H}/data/apps/${APP}/chat.jsonl`, canary: CANARY.chat },
      { path: `/@fs${H}/apps/${APP}/index.html`, canary: CANARY.app },
      { path: `/@fs${H}/apps/${APP}/data/secrets.json`, canary: CANARY.secret },
      { path: `/@fs${H}/apps/${APP}/data/secrets.json?raw`, canary: CANARY.secret },
      { path: `/@fs${REPO}/web/../${path.relative(REPO, H)}/data/workbench.json`, canary: CANARY.scene },
      { path: `/@id${H}/data/workbench.json`, canary: CANARY.scene },
      { path: `/@fs${REPO}/package.json`, canary: '@anthropic-ai/claude-agent-sdk' },
      { path: `/../${path.relative(path.join(REPO, 'web'), H)}/data/workbench.json`, canary: CANARY.scene },
    ];
    vite = await createShellVite(
      { root: REPO, hmrPort: HMR, port: HMR - 9 },
      { cacheDir: path.join(root, 'vite-cache'), logLevel: 'silent', optimizeDeps: { noDiscovery: true, include: [] }, server: { watch: null } },
    );
    s = await startRouter({ home, dev: true, hmrPort: HMR, vite });
  }, { timeout: 60_000 });

  after(async () => {
    await s?.close();
    await vite?.close();
    rmDir(root);
  }, { timeout: 30_000 });

  test('optionerna är exakt kontraktets (§4.3)', () => {
    assert.deepEqual(shellViteOptions({ root: '/r', hmrPort: 8229, port: 8220 }), {
      configFile: '/r/vite.config.ts',
      root: '/r/web',
      appType: 'spa',
      cacheDir: '/r/node_modules/.vite-8220',
      optimizeDeps: { include: ['three'] },
      server: {
        middlewareMode: true,
        ws: { port: 8229, host: '127.0.0.1' },
        cors: false,
        fs: { strict: true, allow: ['/r/web', '/r/shared', '/r/node_modules'] },
      },
    });
  });

  test('varje instans har en egen förbundlingscache (ROB-8)', () => {
    // Kalibrering: två portar med samma rot skulle dela node_modules/.vite utan egen cacheDir.
    const a = shellViteOptions({ root: '/r', hmrPort: 8229, port: 8220 });
    const b = shellViteOptions({ root: '/r', hmrPort: 8289, port: 8280 });
    assert.notEqual(a.cacheDir, b.cacheDir);
    assert.ok(String(a.cacheDir).startsWith('/r/node_modules/'), 'inne i fs.allow');
  });

  test('positiv kontroll: skalet och tillåtna /@fs-filer serveras', async () => {
    const index = await request(s.port, { path: '/', headers: NAV });
    assert.equal(index.status, 200);
    assert.ok(index.text.includes('/@vite/client'), 'Vite transformerade inte index.html');
    assert.equal(index.headers['content-security-policy'], shellCsp({ port: s.port, hmrPort: HMR, dev: true }));
    assert.equal(index.headers['x-frame-options'], 'DENY');
    const allowed = await request(s.port, { path: `/@fs${REPO}/node_modules/vite/package.json`, headers: sameOrigin() });
    assert.equal(allowed.status, 200);
    assert.ok(allowed.text.includes('"name": "vite"'));
    const shared = await request(s.port, { path: `/@fs${REPO}/shared/protocol.ts`, headers: sameOrigin() });
    assert.equal(shared.status, 200);
    assert.ok(shared.text.includes('PROTOCOL_VERSION'));
  });

  test('kalibrering: med fs.allow = hela repot läcker samma förfrågningar', async () => {
    const leakyVite = await createShellVite(
      { root: REPO, hmrPort: HMR, port: HMR - 9 },
      {
        cacheDir: path.join(root, 'vite-cache-leaky'), logLevel: 'silent', optimizeDeps: { noDiscovery: true, include: [] },
        server: { watch: null, ws: false, fs: { strict: true, allow: [REPO] } },
      },
    );
    const leaky = await startRouter({ home: path.join(root, 'home-leaky'), dev: true, hmrPort: HMR, vite: leakyVite });
    try {
      let hits = 0;
      for (const a of attacks) if (leaked(await request(leaky.port, { path: a.path, headers: sameOrigin() }), a.canary)) hits++;
      const scene = await request(leaky.port, { path: attacks[0].path, headers: sameOrigin() });
      assert.equal(leaked(scene, CANARY.scene), true, 'detektorn larmar inte på den planterade läckan');
      const secret = await request(leaky.port, { path: attacks[8].path, headers: sameOrigin() });
      assert.equal(leaked(secret, CANARY.secret), true, 'detektorn larmar inte för secrets.json');
      assert.ok(hits >= 5, `bara ${hits} träffar med den planterade läckan`);
    } finally {
      await leaky.close();
      await leakyVite.close();
    }
  });

  test('/@fs/<home>/data/… och /@fs/<home>/apps/… ger 403 eller 404, även till skalets egen origin', async () => {
    // Vites SPA-fallback svarar med skalets egen index.html på sökvägar den inte känner igen (t.ex. /@id/…).
    // Det är ingen fil ur data/ eller apps/, men det räknas bara om svaret verkligen är skalets sida.
    const shellIndex = (r: Res): boolean =>
      r.status === 200 && String(r.headers['content-type']).startsWith('text/html') && r.text.includes('<div id="stage">') && r.text.includes('/@vite/client');
    for (const a of attacks) {
      for (const headers of [sameOrigin(), NAV]) {
        const r = await request(s.port, { path: a.path, headers });
        assert.equal(leaked(r, a.canary), false, `${a.path} läckte`);
        assert.ok(!r.text.includes(a.canary), `${a.path}: kanariefågeln finns i svaret (status ${r.status})`);
        if (a.path.startsWith('/@fs')) assert.ok(r.status === 403 || r.status === 404, `${a.path}: status ${r.status}`);
        else assert.ok(r.status === 403 || r.status === 404 || shellIndex(r), `${a.path}: status ${r.status}`);
      }
    }
  });

  test('en apps origin når aldrig skalets Vite-filer (vakten)', async () => {
    const r = await request(s.port, {
      path: `/@fs${REPO}/shared/protocol.ts`,
      headers: { origin: `http://${APP}.localhost:${s.port}`, 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' },
    });
    assert.equal(r.status, 403);
    assert.equal(r.headers['access-control-allow-origin'], undefined);
    const client = await request(s.port, { path: '/@vite/client', headers: { 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'script' } });
    assert.equal(client.status, 403, 'HMR-token i /@vite/client får inte nå en app');
  });

  test('HMR-websocketen lyssnar på 127.0.0.1:<HMR-porten> och inte på ::1', async () => {
    assert.equal(await tryConnect('127.0.0.1', HMR), true, 'kontroll: HMR svarar inte på 127.0.0.1');
    assert.equal(await tryConnect('::1', HMR), false, 'HMR lyssnar på ::1');
  });
});
