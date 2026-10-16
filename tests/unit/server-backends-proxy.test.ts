// tests/unit/server-backends-proxy.test.ts — proxyn mot appens backend (CONTRACT §9, §7.2, §15 "proxyns felvägar").
// Backenden här är en server i testprocessen; supervisor-testerna kör proxyn mot riktiga backends.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import net from 'node:net';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import { proxyHttp, proxyUpgrade } from '../../server/backends/proxy.ts';
import { ROOT, SCRATCH, frontServer, request, waitFor } from './server-backends-harness.test.ts';

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

/** En backend i testprocessen vars hanterare byts per test. */
let handler: Handler = (_req, res) => res.end();
let backend: http.Server;
let backendPort = 0;
let front: Awaited<ReturnType<typeof frontServer>>;
let wss: WebSocketServer;

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

before(async () => {
  backend = http.createServer((req, res) => handler(req, res));
  wss = new WebSocketServer({ noServer: true });
  backend.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});
    if (req.url === '/api/nej') {
      socket.end('HTTP/1.1 421 Misdirected Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      return;
    }
    if (req.url === '/api/huvud') {
      // Rå uppgradering: ekar Host, de byte som kom i samma paket (head) och allt som följer.
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: test\r\nX-Host: ${req.headers.host}\r\nX-Fwd: ${req.headers['x-forwarded-host']}\r\n\r\n`);
      socket.write(Buffer.concat([Buffer.from('HEAD['), head, Buffer.from(']')]));
      socket.pipe(socket);
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.send(JSON.stringify({ host: req.headers.host, xfh: req.headers['x-forwarded-host'], xfp: req.headers['x-forwarded-proto'], url: req.url }));
      ws.on('message', (m, isBinary) => ws.send(isBinary ? m : 'eko:' + String(m)));
      ws.on('close', (code) => closes.push(code));
    });
  });
  await new Promise<void>((r) => backend.listen(0, '127.0.0.1', r));
  backendPort = (backend.address() as AddressInfo).port;
  front = await frontServer(
    (req, res) => proxyHttp(req, res, req.headers['x-test-port'] ? Number(req.headers['x-test-port']) : backendPort),
    (req, socket, head) => proxyUpgrade(req, socket, head, req.headers['x-test-port'] ? Number(req.headers['x-test-port']) : backendPort),
  );
});

after(async () => {
  await front.close();
  wss.close();
  backend.closeAllConnections();
  await new Promise((r) => backend.close(r));
});

const closes: number[] = [];

describe('HTTP', { timeout: 60_000 }, () => {
  test('GET strömmas: första biten når webbläsaren innan backenden är klar', async () => {
    let finish: () => void = () => {};
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.write('första\n');
      finish = () => res.end('andra\n');
    };
    const body = await new Promise<string>((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port: front.port, path: '/api/strom', agent: false }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (d: string) => {
          text += d;
          if (text === 'första\n') finish(); // backenden avslutar först när första biten kommit fram
        });
        res.on('end', () => resolve(text));
      });
      req.on('error', reject);
    });
    assert.equal(body, 'första\nandra\n');
  });

  test('POST strömmas åt båda hållen och stora kroppar kommer fram oförändrade', async () => {
    handler = (req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      req.on('data', (c: Buffer) => res.write(c));
      req.on('end', () => res.end());
    };
    // Bit 2 skickas först när ekot av bit 1 kommit tillbaka.
    const echoed = await new Promise<string>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: front.port, method: 'POST', path: '/api/eko', agent: false }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (d: string) => {
          text += d;
          if (text === 'ett,') req.end('två');
        });
        res.on('end', () => resolve(text));
      });
      req.on('error', reject);
      req.flushHeaders();
      req.write('ett,');
    });
    assert.equal(echoed, 'ett,två');

    const big = crypto.randomBytes(5 * 1024 * 1024);
    for (const framing of ['content-length', 'chunked'] as const) {
      const sha = await new Promise<string>((resolve, reject) => {
        const headers: Record<string, string> = framing === 'content-length' ? { 'content-length': String(big.length) } : {};
        const req = http.request({ host: '127.0.0.1', port: front.port, method: 'PUT', path: '/api/stor', headers, agent: false }, (res) => {
          const h = crypto.createHash('sha256');
          res.on('data', (d: Buffer) => h.update(d));
          res.on('end', () => resolve(h.digest('hex')));
        });
        req.on('error', reject);
        for (let i = 0; i < big.length; i += 256 * 1024) req.write(big.subarray(i, i + 256 * 1024));
        req.end();
      });
      assert.equal(sha, crypto.createHash('sha256').update(big).digest('hex'), framing);
    }
  });

  test('metod, sökväg och huvuden följer med; Host skrivs om och X-Forwarded-* sätts', async () => {
    let seen: http.IncomingMessage | null = null;
    handler = (req, res) => {
      seen = req;
      res.end('ok');
    };
    const r = await request(front.port, {
      method: 'PATCH',
      path: '/api/x/%C3%A5?a=1&b=%20tv%C3%A5',
      headers: {
        host: 'aabc123.localhost:8220',
        'x-egen': 'värde',
        cookie: 'sid=1; tema=mörkt',
        'x-forwarded-host': 'förfalskad.example',
        'x-forwarded-proto': 'https',
        connection: 'keep-alive, x-hemlig',
        'x-hemlig': 'ska inte fram',
        'keep-alive': 'timeout=5',
        te: 'trailers',
        'content-type': 'application/json',
      },
      // Kroppen som Buffer: är första biten en sträng skriver Node huvudena som UTF-8 i stället för
      // latin1 (OutgoingMessage._send). Proxyn själv pipar alltid Buffer, så den påverkas inte.
      body: Buffer.from('{"a":1}'),
    });
    assert.equal(r.status, 200);
    assert.ok(seen);
    const req = seen as http.IncomingMessage;
    assert.equal(req.method, 'PATCH');
    assert.equal(req.url, '/api/x/%C3%A5?a=1&b=%20tv%C3%A5');
    assert.equal(req.headers.host, `127.0.0.1:${backendPort}`);
    assert.equal(req.headers['x-forwarded-host'], 'aabc123.localhost:8220');
    assert.equal(req.headers['x-forwarded-proto'], 'http');
    // Huvudvärden går som latin1 åt båda hållen; proxyn ska inte koda om dem.
    assert.equal(req.headers['x-egen'], 'värde');
    assert.equal(req.headers.cookie, 'sid=1; tema=mörkt');
    assert.equal(req.headers['content-type'], 'application/json');
    assert.equal(req.headers['content-length'], '7');
    for (const hop of ['x-hemlig', 'keep-alive', 'te']) assert.equal(req.headers[hop], undefined, hop);
    assert.equal(req.rawHeaders.filter((h) => h.toLowerCase() === 'host').length, 1);
  });

  test('status, statustext och flera Set-Cookie kommer tillbaka; HEAD och 204 fungerar', async () => {
    handler = (req, res) => {
      if (req.url === '/api/tom') {
        res.writeHead(204);
        res.end();
        return;
      }
      res.setHeader('set-cookie', ['a=1; Path=/', 'b=2; HttpOnly']);
      res.setHeader('x-svar', 'ja');
      res.setHeader('connection', 'close, x-intern');
      res.setHeader('x-intern', 'nej');
      res.writeHead(418, "I'm a teapot", { 'content-type': 'text/plain' });
      res.end(req.method === 'HEAD' ? undefined : 'kanna');
    };
    const res = await new Promise<http.IncomingMessage & { text: string }>((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: front.port, path: '/api/kanna', agent: false }, (r) => {
        let text = '';
        r.on('data', (d) => (text += d));
        r.on('end', () => resolve(Object.assign(r, { text })));
      }).on('error', reject);
    });
    assert.equal(res.statusCode, 418);
    assert.equal(res.statusMessage, "I'm a teapot");
    assert.deepEqual(res.headers['set-cookie'], ['a=1; Path=/', 'b=2; HttpOnly']);
    assert.equal(res.headers['x-svar'], 'ja');
    assert.equal(res.headers['x-intern'], undefined);
    assert.equal(res.text, 'kanna');
    const head = await request(front.port, { method: 'HEAD', path: '/api/kanna' });
    assert.equal(head.status, 418);
    assert.equal(head.body, '');
    const empty = await request(front.port, { path: '/api/tom' });
    assert.equal(empty.status, 204);
  });
});

describe('felvägar', { timeout: 60_000 }, () => {
  test('ingen backend på porten ger 502 {"error":"backend"}', async () => {
    const closed = await freePort();
    const r = await request(front.port, { path: '/api/x', headers: { 'x-test-port': String(closed) } });
    assert.equal(r.status, 502);
    assert.equal(r.body, '{"error":"backend"}');
    assert.match(String(r.headers['content-type']), /^application\/json/);
  });

  test('ett svar som inte är HTTP ger 502', async () => {
    const junk = net.createServer((s) => {
      s.on('error', () => {});
      s.end('det här är inte HTTP\r\n\r\n');
    });
    await new Promise<void>((r) => junk.listen(0, '127.0.0.1', r));
    try {
      const r = await request(front.port, { path: '/api/x', headers: { 'x-test-port': String((junk.address() as AddressInfo).port) } });
      assert.equal(r.status, 502);
      assert.equal(r.body, '{"error":"backend"}');
    } finally {
      junk.close();
    }
  });

  test('backenden dör mitt i svaret: webbläsarens svar avbryts, servern lever vidare', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write('halv');
      setTimeout(() => res.socket?.destroy(), 50);
    };
    const outcome = await new Promise<{ complete: boolean; text: string }>((resolve) => {
      http.get({ host: '127.0.0.1', port: front.port, path: '/api/halv', agent: false }, (r) => {
        let text = '';
        r.on('data', (d) => (text += d));
        r.on('error', () => {});
        r.on('close', () => resolve({ complete: r.complete, text }));
      }).on('error', () => resolve({ complete: false, text: '' }));
    });
    assert.equal(outcome.complete, false);
    handler = (_req, res) => res.end('ok');
    assert.equal((await request(front.port, { path: '/api/igen' })).body, 'ok');
  });

  test('webbläsaren går mitt i en ström: förbindelsen mot backenden rivs', async () => {
    let backendClosed = false;
    handler = (req, res) => {
      res.writeHead(200);
      const timer = setInterval(() => res.write('x'.repeat(1024)), 10);
      res.on('close', () => {
        clearInterval(timer);
        backendClosed = true;
      });
    };
    await new Promise<void>((resolve) => {
      const req = http.get({ host: '127.0.0.1', port: front.port, path: '/api/oandlig', agent: false }, (r) => {
        r.once('data', () => {
          req.destroy();
          resolve();
        });
      });
      req.on('error', () => {});
    });
    await waitFor(() => backendClosed, 2000, 'att backendens svar stängs');
  });

  test('webbläsaren går mitt i en uppladdning: backenden ser förfrågan avbrytas', async () => {
    let aborted = false;
    let started = false;
    handler = (req, res) => {
      req.on('data', () => (started = true));
      req.on('close', () => {
        if (!req.complete) aborted = true;
      });
      res.on('close', () => {
        if (!res.writableFinished) aborted = true;
      });
    };
    const req = http.request({ host: '127.0.0.1', port: front.port, method: 'POST', path: '/api/upp', agent: false });
    req.on('error', () => {});
    req.write('del ett');
    await waitFor(() => started, 2000, 'att uppladdningen börjat');
    req.destroy();
    await waitFor(() => aborted, 2000, 'att backenden ser avbrottet');
  });
});

describe('WebSocket', { timeout: 60_000 }, () => {
  test('eko genom proxyUpgrade, med omskriven Host; stängning går fram', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${front.port}/api/ws?rum=1`, { headers: { host: 'aabc123.localhost:8220' } });
    const messages: string[] = [];
    await new Promise<void>((resolve, reject) => {
      ws.on('message', (m) => {
        messages.push(String(m));
        if (messages.length === 1) ws.send('hej');
        if (messages.length === 2) ws.send(Buffer.from([1, 2, 3]));
        if (messages.length === 3) resolve();
      });
      ws.on('error', reject);
    });
    const hello = JSON.parse(messages[0]) as Record<string, string>;
    assert.deepEqual(hello, { host: `127.0.0.1:${backendPort}`, xfh: 'aabc123.localhost:8220', xfp: 'http', url: '/api/ws?rum=1' });
    assert.equal(messages[1], 'eko:hej');
    assert.equal(messages[2], '\u0001\u0002\u0003'); // binärramen kom tillbaka byte för byte
    ws.close(4001, 'klar');
    await waitFor(() => closes.includes(4001), 2000, 'att stängningen når backenden');
  });

  test('byten som kommer i samma paket som uppgraderingen (head) går fram, före resten', async () => {
    const got = await new Promise<string>((resolve, reject) => {
      const c = net.connect({ host: '127.0.0.1', port: front.port }, () => {
        c.write(
          Buffer.concat([
            Buffer.from('GET /api/huvud HTTP/1.1\r\nHost: aabc123.localhost:8220\r\nX-Forwarded-Host: förfalskad\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n'),
            Buffer.from('först åäö'),
          ]),
        );
        setTimeout(() => c.write(' sedan'), 100);
      });
      let data = '';
      c.setEncoding('utf8');
      c.on('data', (d: string) => {
        data += d;
        if (data.endsWith(' sedan')) {
          c.destroy();
          resolve(data);
        }
      });
      c.on('error', reject);
    });
    const [head, body] = got.split('\r\n\r\n');
    assert.match(head, /^HTTP\/1\.1 101 /);
    assert.match(head, new RegExp(`\r\nX-Host: 127\\.0\\.0\\.1:${backendPort}\r\n`));
    assert.match(head, /\r\nX-Fwd: aabc123\.localhost:8220(\r\n|$)/);
    assert.equal(body, 'HEAD[först åäö] sedan');
  });

  test('uppgradering mot en tom port ger 502, och en backend som nekar ger sin egen status', async () => {
    const closed = await freePort();
    const status = (headers: Record<string, string>, p = '/api/ws'): Promise<number> =>
      new Promise((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${front.port}${p}`, { headers });
        ws.on('unexpected-response', (_req, res) => {
          resolve(res.statusCode ?? 0);
          ws.terminate();
        });
        ws.on('error', () => resolve(-1));
      });
    assert.equal(await status({ 'x-test-port': String(closed) }), 502);
    assert.equal(await status({}, '/api/nej'), 421);
  });
});

/* ---------- kalibrering: utan felhanterare kraschar processen i samma scenarier ---------- */

const CRASH_SCRIPT = (proxyUrl: string) => `
import http from 'node:http';
import net from 'node:net';
import { proxyHttp, proxyUpgrade } from ${JSON.stringify(proxyUrl)};
const [variant, scenario] = process.argv.slice(2);

// Den naiva proxyn: samma sak utan felhanterare.
function naiveHttp(req, res, port) {
  const up = http.request({ host: '127.0.0.1', port, method: req.method, path: req.url, headers: req.headers });
  up.on('response', (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
  req.pipe(up);
}
function naiveUpgrade(req, socket, head, port) {
  const up = net.connect(port, '127.0.0.1', () => {
    up.write(req.method + ' ' + req.url + ' HTTP/1.1\\r\\nHost: 127.0.0.1\\r\\nConnection: Upgrade\\r\\nUpgrade: test\\r\\n\\r\\n');
    up.pipe(socket); socket.pipe(up);
  });
}
const H = variant === 'naive' ? naiveHttp : proxyHttp;
const U = variant === 'naive' ? naiveUpgrade : proxyUpgrade;
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));

// En backend som accepterar uppgraderingen och sedan skriver utan uppehåll.
const flood = net.createServer((s) => { s.on('error', () => {}); s.once('data', () => { s.write('HTTP/1.1 101 Switching Protocols\\r\\nConnection: Upgrade\\r\\nUpgrade: test\\r\\n\\r\\n'); const t = setInterval(() => s.write(Buffer.alloc(64 * 1024)), 1); s.on('close', () => clearInterval(t)); }); });
const floodPort = await listen(flood);
const probe = net.createServer(); const closedPort = await listen(probe); await new Promise((r) => probe.close(r));
const port = scenario === 'upgrade-reset' ? floodPort : closedPort;

const front = http.createServer((req, res) => H(req, res, port));
front.on('upgrade', (req, socket, head) => U(req, socket, head, port));
const frontPort = await listen(front);

let result = '';
if (scenario === 'http') {
  result = await new Promise((r) => http.get({ host: '127.0.0.1', port: frontPort, path: '/api/x' }, (res) => { res.resume(); r(String(res.statusCode)); }).on('error', (e) => r('klientfel ' + e.code)));
} else {
  result = await new Promise((resolve) => {
    const c = net.connect(frontPort, '127.0.0.1', () => c.write('GET /api/ws HTTP/1.1\\r\\nHost: x\\r\\nConnection: Upgrade\\r\\nUpgrade: test\\r\\n\\r\\n'));
    let got = '';
    c.on('data', (d) => { if (!got) { got = String(d).split('\\r\\n')[0]; if (scenario === 'upgrade-reset') c.resetAndDestroy(); } });
    c.on('error', () => {});
    c.on('close', () => resolve(got));
  });
}
await new Promise((r) => setTimeout(r, 400)); // låt eventuella sena fel slå till
console.log('OVERLEVDE ' + result);
front.closeAllConnections(); front.close(); flood.close();
process.exit(0);
`;

describe('kalibrering av "kraschar aldrig"', { timeout: 60_000 }, () => {
  const dir = path.join(SCRATCH, 'proxy-crash');
  before(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const proxyUrl = new URL('file://' + path.join(ROOT, 'server', 'backends', 'proxy.ts')).href;
    fs.writeFileSync(path.join(dir, 'crash.mjs'), CRASH_SCRIPT(proxyUrl));
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const run = (variant: string, scenario: string): Promise<{ code: number | null; out: string; err: string }> =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(dir, 'crash.mjs'), variant, scenario], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (err += d));
      const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
      child.on('exit', (code) => {
        clearTimeout(timer);
        resolve({ code, out, err });
      });
    });

  for (const [scenario, expected] of [
    ['http', 'OVERLEVDE 502'],
    ['upgrade', 'OVERLEVDE HTTP/1.1 502 Bad Gateway'],
    ['upgrade-reset', 'OVERLEVDE HTTP/1.1 101 Switching Protocols'],
  ] as const) {
    test(`${scenario}: en naiv proxy kraschar processen, proxy.ts gör det inte`, async () => {
      const naive = await run('naive', scenario);
      assert.notEqual(naive.code, 0, `den naiva proxyn kraschade inte: ${naive.out}`);
      assert.match(naive.err, /ECONNREFUSED|ECONNRESET|EPIPE/);
      const real = await run('real', scenario);
      assert.equal(real.code, 0, real.err);
      assert.equal(real.out.trim(), expected);
    });
  }
});
