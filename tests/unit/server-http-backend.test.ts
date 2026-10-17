// tests/unit/server-http-backend.test.ts — routerns väg till appens backend (CONTRACT §9, tomgångsstoppet):
// varje proxad förfrågan och uppgraderad socket håller backenden vid liv (backends.hold) tills den stängs,
// också när backenden inte kom upp (503). Fejkad backend och proxy, riktiga HTTP-anslutningar.
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { after, before, describe, test } from 'node:test';
import { request, rmDir, startRouter, tempDir } from './server-http-fakes.test.ts';
import type { Started } from './server-http-fakes.test.ts';

const APP = 'ahold123';

async function waitFor(cond: () => boolean, label: string, timeoutMs = 3000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > until) throw new Error(`väntade förgäves på ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('pågående förfrågningar mot backenden räknas tills de stängs (hold)', () => {
  let s: Started;
  let home: string;
  let finish: (() => void) | null = null;
  const holds = (): number => s.calls.filter((c) => c === `hold ${APP}`).length;
  const releases = (): number => s.calls.filter((c) => c === `release ${APP}`).length;

  before(async () => {
    home = tempDir('backend-hold');
    s = await startRouter({
      home,
      proxy: {
        // Ett svar som pågår tills testet avslutar det, som en lång förfrågan eller en SSE-ström.
        proxyHttp: (_req, res) => {
          s.calls.push('proxyHttp');
          res.writeHead(200);
          res.write('början ');
          finish = () => res.end('slut');
        },
        // Som proxy.ts: läser från socketen och stänger den när klienten gått (där via backenden).
        proxyUpgrade: (_req, socket) => {
          s.calls.push('proxyUpgrade');
          socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: test\r\nConnection: Upgrade\r\n\r\n');
          socket.on('end', () => socket.destroy());
          socket.resume();
        },
      },
    });
    s.registry.add(APP, { backend: true });
    s.backends.nextPort = 1;
    Object.assign(s.backends, {
      hold(id: string) {
        s.calls.push(`hold ${id}`);
        return () => s.calls.push(`release ${id}`);
      },
    });
  }, { timeout: 30_000 });

  after(async () => {
    await s.close();
    rmDir(home);
  }, { timeout: 30_000 });

  test('HTTP: hold före ensure, release först när svaret stängts', async () => {
    s.calls.length = 0;
    const body = new Promise<string>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: s.port, path: '/api/x', headers: { host: `${APP}.localhost:${s.port}` }, agent: false }, (res) => {
        let text = '';
        res.on('data', (d: Buffer) => (text += d));
        res.on('end', () => resolve(text));
      });
      req.on('error', reject);
      req.end();
    });
    await waitFor(() => s.calls.includes('proxyHttp'), 'proxyn');
    assert.deepEqual(s.calls, [`hold ${APP}`, `backends.ensure ${APP}`, 'proxyHttp'], 'medan svaret pågår: inget release');
    finish?.();
    assert.equal(await body, 'början slut');
    await waitFor(() => releases() === 1, 'release');
    assert.equal(holds(), 1);
  });

  test('503 när backenden inte kom upp släpper också', async () => {
    s.calls.length = 0;
    s.backends.nextPort = null;
    try {
      const r = await request(s.port, { path: '/api/x', host: `${APP}.localhost:${s.port}` });
      assert.equal(r.status, 503);
      await waitFor(() => releases() === 1, 'release');
      assert.equal(holds(), 1);
    } finally {
      s.backends.nextPort = 1;
    }
  });

  test('uppgradering: hold tills socketen stängs', async () => {
    s.calls.length = 0;
    const sock = net.connect({ host: '127.0.0.1', port: s.port });
    sock.on('error', () => {});
    try {
      await new Promise<void>((resolve) => sock.once('connect', () => resolve()));
      sock.write(`GET /api/ws HTTP/1.1\r\nHost: ${APP}.localhost:${s.port}\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n`);
      await waitFor(() => s.calls.includes('proxyUpgrade'), 'proxyUpgrade');
      await new Promise((r) => setTimeout(r, 150));
      assert.equal(holds(), 1);
      assert.equal(releases(), 0, 'socketen är öppen');
    } finally {
      sock.destroy();
    }
    await waitFor(() => releases() === 1, 'release');
  });

  test('statiska filer och /__wb/* räknas inte', async () => {
    s.calls.length = 0;
    await request(s.port, { path: '/index.html', host: `${APP}.localhost:${s.port}` });
    await request(s.port, { path: '/__wb/store/x', host: `${APP}.localhost:${s.port}` });
    assert.equal(holds(), 0);
  });
});
