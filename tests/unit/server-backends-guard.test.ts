// tests/unit/server-backends-guard.test.ts — guard.mjs (CONTRACT §9).
// Varje påstående körs också utan guard.mjs, som planterad läcka: utan vakten ska samma skript
// lyssna på alla gränssnitt, svara 200 till en främmande Host och överleva sin förälder.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { ROOT, SCRATCH, isAlive, sleep, waitFor } from './server-backends-harness.test.ts';

const GUARD = pathToFileURL(path.join(ROOT, 'server', 'backends', 'guard.mjs')).href;
const DIR = path.join(SCRATCH, 'guard');
const GUARDED_PORT = 18380;
const PLAIN_PORT = 18381;

function script(name: string, source: string): string {
  const file = path.join(DIR, name);
  fs.writeFileSync(file, source);
  return file;
}

/** Kör ett skript med eller utan vakten och returnerar stdout som JSON. */
function runJson(file: string, guarded: boolean, port = GUARDED_PORT): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    const args = [...(guarded ? [`--import=${GUARD}`] : []), file];
    const child = spawn(process.execPath, args, { cwd: DIR, env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('exit', (code) => {
      if (code !== 0) reject(new Error(`kod ${code}: ${err}`));
      else resolve(JSON.parse(out) as Record<string, string>);
    });
  });
}

/** Startar ett skript som skriver REDO när det lyssnar. */
async function startServer(file: string, guarded: boolean, port: number): Promise<ChildProcess> {
  const args = [...(guarded ? [`--import=${GUARD}`] : []), file];
  const child = spawn(process.execPath, args, { cwd: DIR, env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise<void>((resolve, reject) => {
    child.stdout!.on('data', (d: Buffer) => {
      if (String(d).includes('REDO')) resolve();
    });
    child.on('exit', (code) => reject(new Error(`servern avslutades med kod ${code}`)));
  });
  return child;
}

/** Skickar rå HTTP och returnerar statusraderna (för 100 Continue blir det två). */
function raw(port: number, text: string, body?: string): Promise<string[]> {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    let data = '';
    s.on('connect', () => {
      s.write(text);
      if (body !== undefined) setTimeout(() => s.write(body), 50);
    });
    s.on('data', (d) => (data += d));
    s.on('error', () => resolve(['FEL']));
    s.on('close', () => resolve(data.split('\r\n').filter((l) => l.startsWith('HTTP/'))));
    setTimeout(() => s.destroy(), 1500);
  });
}

const get = (host: string | null, version = '1.1'): string =>
  `GET /api/x HTTP/${version}\r\n${host === null ? '' : `Host: ${host}\r\n`}Connection: close\r\n\r\n`;

before(() => {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
});
after(() => fs.rmSync(DIR, { recursive: true, force: true }));

describe('listen tvingas till 127.0.0.1', { timeout: 60_000 }, () => {
  const LISTEN_SCRIPT = `
import http from 'node:http';
import net from 'node:net';
const results = {};
const addr = (label, make, fn) => new Promise((resolve) => {
  const s = make();
  s.on('error', (e) => { results[label] = 'ERROR ' + e.code; resolve(); });
  fn(s, () => { const a = s.address(); results[label] = typeof a === 'string' ? 'PIPE' : a.address; s.close(); resolve(); });
});
const tcp = () => net.createServer();
await addr('listen(0)', tcp, (s, cb) => s.listen(0, cb));
await addr('listen(0, "0.0.0.0")', tcp, (s, cb) => s.listen(0, '0.0.0.0', cb));
await addr('listen(0, "::")', tcp, (s, cb) => s.listen(0, '::', cb));
await addr('listen(0, "localhost")', tcp, (s, cb) => s.listen(0, 'localhost', cb));
await addr('listen(0, 511, cb)', tcp, (s, cb) => s.listen(0, 511, cb));
await addr('listen(0, "::", 511, cb)', tcp, (s, cb) => s.listen(0, '::', 511, cb));
await addr('listen("0", cb)', tcp, (s, cb) => s.listen('0', cb));
await addr('listen(cb)', tcp, (s, cb) => s.listen(cb));
await addr('listen(null, cb)', tcp, (s, cb) => s.listen(null, cb));
await addr('listen({ port: 0 })', tcp, (s, cb) => s.listen({ port: 0 }, cb));
await addr('listen({ port: 0, host: "::", ipv6Only: true })', tcp, (s, cb) => s.listen({ port: 0, host: '::', ipv6Only: true }, cb));
await addr('http: listen(0)', () => http.createServer(), (s, cb) => s.listen(0, cb));
await addr('unix-socket', tcp, (s, cb) => s.listen('g.sock', cb));
console.log(JSON.stringify(results));
`;

  test('alla former av listen() binder loopback med vakten, men inte utan den', async () => {
    const file = script('listen.mjs', LISTEN_SCRIPT);
    const guarded = await runJson(file, true);
    for (const [form, address] of Object.entries(guarded)) {
      assert.equal(address, form === 'unix-socket' ? 'PIPE' : '127.0.0.1', form);
    }
    assert.equal(Object.keys(guarded).length, 13);
    // Planterad läcka: utan vakten lyssnar samma anrop på alla gränssnitt.
    const plain = await runJson(file, false);
    for (const form of ['listen(0)', 'listen(0, "0.0.0.0")', 'listen(0, "::")', 'listen(cb)', 'http: listen(0)']) {
      assert.ok(['::', '0.0.0.0'].includes(plain[form]), `${form}: ${plain[form]}`);
    }
  });
});

describe('Host-kontrollen ger 421', { timeout: 60_000 }, () => {
  const HTTP_SCRIPT = `
import http from 'node:http';
const server = http.createServer((req, res) => res.end('ok'));
server.on('upgrade', (req, socket) => { socket.on('error', () => {}); socket.end('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: test\\r\\nConnection: Upgrade\\r\\n\\r\\n'); });
server.on('checkContinue', (req, res) => { res.writeContinue(); req.resume(); req.on('end', () => res.end('ok')); });
server.on('connect', (req, socket) => { socket.on('error', () => {}); socket.end('HTTP/1.1 200 Connection Established\\r\\n\\r\\n'); });
server.listen(Number(process.env.PORT), () => console.log('REDO ' + server.address().address));
`;
  let guarded: ChildProcess;
  let plain: ChildProcess;
  before(async () => {
    const file = script('http.mjs', HTTP_SCRIPT);
    guarded = await startServer(file, true, GUARDED_PORT);
    plain = await startServer(file, false, PLAIN_PORT);
  });
  after(() => {
    guarded.kill('SIGKILL');
    plain.kill('SIGKILL');
  });

  test('förfrågningar: bara 127.0.0.1:<PORT> och localhost:<PORT> släpps in', async () => {
    const p = GUARDED_PORT;
    const cases: [string | null, string][] = [
      [`127.0.0.1:${p}`, '200'],
      [`localhost:${p}`, '200'],
      [`LOCALHOST:${p}`, '200'],
      ['evil.example', '421'],
      [`evil.example:${p}`, '421'],
      ['127.0.0.1:9999', '421'],
      [`[::1]:${p}`, '421'],
      ['127.0.0.1', '421'],
      [`localhost.:${p}`, '421'],
      [`aabc123.localhost:${p}`, '421'],
    ];
    for (const [host, status] of cases) {
      const lines = await raw(p, get(host));
      assert.match(lines[0] ?? '', new RegExp(`^HTTP/1\\.1 ${status} `), `Host ${host}`);
    }
    const noHost = await raw(p, get(null, '1.0'));
    assert.match(noHost[0] ?? '', /^HTTP\/1\.1 421 /, 'utan Host');
  });

  test('uppgraderingar, CONNECT och Expect: 100-continue kontrolleras också', async () => {
    const p = GUARDED_PORT;
    const upgrade = (host: string) => `GET /api/ws HTTP/1.1\r\nHost: ${host}\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n`;
    const expect = (host: string) =>
      `POST /api/x HTTP/1.1\r\nHost: ${host}\r\nContent-Length: 2\r\nExpect: 100-continue\r\nConnection: close\r\n\r\n`;
    const connect = (host: string) => `CONNECT ${host} HTTP/1.1\r\nHost: ${host}\r\n\r\n`;
    assert.match((await raw(p, upgrade('evil.example')))[0], /^HTTP\/1\.1 421 /);
    assert.match((await raw(p, upgrade(`127.0.0.1:${p}`)))[0], /^HTTP\/1\.1 101 /);
    assert.match((await raw(p, expect('evil.example'), 'hi'))[0], /^HTTP\/1\.1 421 /);
    assert.deepEqual((await raw(p, expect(`localhost:${p}`), 'hi')).map((l) => l.slice(0, 12)), ['HTTP/1.1 100', 'HTTP/1.1 200']);
    assert.match((await raw(p, connect('evil.example:443')))[0], /^HTTP\/1\.1 421 /);
    assert.match((await raw(p, connect(`127.0.0.1:${p}`)))[0], /^HTTP\/1\.1 200 /);
  });

  test('kalibrering: utan vakten släpps samma främmande Host in', async () => {
    const p = PLAIN_PORT;
    assert.match((await raw(p, get('evil.example')))[0], /^HTTP\/1\.1 200 /);
    assert.match((await raw(p, `GET / HTTP/1.1\r\nHost: evil.example\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n`))[0], /^HTTP\/1\.1 101 /);
    assert.match((await raw(p, `CONNECT evil.example:443 HTTP/1.1\r\nHost: evil.example:443\r\n\r\n`))[0], /^HTTP\/1\.1 200 /);
  });

  test('https.Server har också vakten (ärver inte från http.Server)', async () => {
    const file = script(
      'protos.mjs',
      `import http from 'node:http'; import https from 'node:https';
console.log(JSON.stringify({ http: String(Object.hasOwn(http.Server.prototype, 'emit')), https: String(Object.hasOwn(https.Server.prototype, 'emit')) }));`,
    );
    assert.deepEqual(await runJson(file, true), { http: 'true', https: 'true' });
    assert.deepEqual(await runJson(file, false), { http: 'false', https: 'false' });
  });
});

describe('backenden avslutas när workbenchen försvinner', { timeout: 60_000 }, () => {
  // En mellanprocess (workbenchen) startar backenden och dödas sedan med SIGKILL, utan stopAll.
  const PARENT = `
import { spawn } from 'node:child_process';
const [mode, guard, delay] = process.argv.slice(2);
const child = spawn(process.execPath, [...(mode === 'guarded' ? ['--import=' + guard] : []), '-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true });
child.unref();
setTimeout(() => console.log(child.pid), Number(delay));
setInterval(() => {}, 1000);
`;
  /** Startar en backend via en mellanprocess och dödar mellanprocessen efter delayMs. */
  const orphan = async (guarded: boolean, delayMs: number): Promise<number> => {
    const file = script('parent.mjs', PARENT);
    const parent = spawn(process.execPath, [file, guarded ? 'guarded' : 'plain', GUARD, String(delayMs)], { stdio: ['ignore', 'pipe', 'inherit'] });
    const pid = await new Promise<number>((resolve) => parent.stdout.once('data', (d: Buffer) => resolve(Number(String(d).trim()))));
    parent.kill('SIGKILL');
    return pid;
  };
  const leftovers: number[] = [];
  after(() => {
    for (const pid of leftovers) if (isAlive(pid)) process.kill(pid, 'SIGKILL');
  });

  for (const [label, delayMs] of [['efter att vakten laddats', 600], ['innan vakten hunnit laddas', 0]] as const) {
    test(`föräldern dör ${label}: med vakten avslutas backenden, utan vakten blir den kvar`, async () => {
      const guardedPid = await orphan(true, delayMs);
      leftovers.push(guardedPid);
      await waitFor(() => !isAlive(guardedPid), 4000, 'att den föräldralösa backenden avslutas');
      // Planterad läcka: utan vakten blir processen kvar (och dödas av testet).
      const plainPid = await orphan(false, delayMs);
      leftovers.push(plainPid);
      await sleep(2500);
      assert.ok(isAlive(plainPid), 'kalibreringen fungerar inte: processen dog ändå');
      process.kill(plainPid, 'SIGKILL');
      await waitFor(() => !isAlive(plainPid), 2000);
    });
  }
});
