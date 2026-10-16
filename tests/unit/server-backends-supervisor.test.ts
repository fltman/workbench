// tests/unit/server-backends-supervisor.test.ts — app-backendernas livscykel (CONTRACT §9).
// Riktiga nodeprocesser i riktiga appmappar under $HOME, med sandlådan påslagen (standard),
// bakom en "workbench"-server som gör som server-http: await ensure(), sedan proxyn.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { after, afterEach, before, describe, test } from 'node:test';
import WebSocket from 'ws';
import { proxyHttp, proxyUpgrade } from '../../server/backends/proxy.ts';
import { DEFAULT_OPTIONS, createBackends, isLoopbackListener, parseLsof } from '../../server/backends/supervisor.ts';
import type { BackendOptions } from '../../server/backends/supervisor.ts';
import type { Backends, Config } from '../../server/types.ts';
import {
  fakeLogs, fakeRegistry, frontServer, installWs, isAlive, listeners, makeApp, makeHome, request, sleep, waitFor,
} from './server-backends-harness.test.ts';
import type { FakeLogs, FakeRegistry, TestHome } from './server-backends-harness.test.ts';

// Utanför produktionens spann (18300–18499), så att en workbench som körs samtidigt inte tar testets portar.
const OPTIONS: Partial<BackendOptions> = { portBase: 18600, portSpan: 40 };

const NORMAL = `
import fs from 'node:fs';
import http from 'node:http';
import { WebSocketServer } from 'ws';
console.log('STARTED ' + process.pid);
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/info') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      pid: process.pid, host: req.headers.host, xfh: req.headers['x-forwarded-host'],
      env: { PORT: process.env.PORT, HOST: process.env.HOST, DATA_DIR: process.env.DATA_DIR, APP_ID: process.env.APP_ID, NODE_ENV: process.env.NODE_ENV },
      envKeys: Object.keys(process.env).sort(), cwd: process.cwd(), argv1: process.argv[1], execArgv: process.execArgv,
      dataDirIsDir: fs.statSync(process.env.DATA_DIR).isDirectory(),
    }));
    return;
  }
  if (url.pathname === '/api/echo') { res.writeHead(200); req.on('data', (c) => res.write(c)); req.on('end', () => res.end()); return; }
  if (url.pathname === '/api/stream') { res.writeHead(200, { 'content-type': 'text/plain' }); res.write('första\\n'); setTimeout(() => res.end('andra\\n'), 150); return; }
  if (url.pathname === '/api/crash') { res.end('ok'); setTimeout(() => process.exit(3), 20); return; }
  res.statusCode = 404; res.end();
});
const wss = new WebSocketServer({ server, path: '/api/ws' });
wss.on('connection', (ws) => ws.on('message', (m) => ws.send('eko:' + m)));
server.listen(Number(process.env.PORT), process.env.HOST);
`;

const CRASH_AT_START = `
console.log('STARTED ' + process.pid);
console.error('Fel: trasig backend');
throw new Error('trasig backend');
`;

const NEVER_LISTENS = `
console.log('STARTED ' + process.pid);
setInterval(() => {}, 1000);
`;

// Ignorerar SIGTERM, och har ett barn som också gör det: bara SIGKILL till hela gruppen hjälper.
const STUBBORN = `
import http from 'node:http';
import { spawn } from 'node:child_process';
process.on('SIGTERM', () => console.log('ignorerar SIGTERM'));
const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], { stdio: 'ignore' });
console.log('STARTED ' + process.pid);
console.log('BARN ' + child.pid);
http.createServer((req, res) => res.end('ok')).listen(Number(process.env.PORT));
`;

const CHATTY = `
import http from 'node:http';
process.stdout.write('x'.repeat(20000) + '\\n');
process.stdout.write('rad ett\\nrad två\\r\\nhalv');
setTimeout(() => process.stdout.write(' rad\\n'), 30);
console.error('fel på stderr');
setTimeout(() => { for (let i = 0; i < 1000; i++) console.log('massa ' + i); }, 100);
http.createServer((req, res) => res.end('ok')).listen(Number(process.env.PORT));
`;

let t: TestHome;
let registry: FakeRegistry;
let logs: FakeLogs;
const open: Backends[] = [];

function supervisor(options: Partial<BackendOptions> = {}, config: Config = t.config): Backends {
  const b = createBackends({ config, paths: t.paths, registry, logs }, { ...OPTIONS, ...options });
  open.push(b);
  return b;
}

/** Som server-http: await ensure(), 503 utan backend, annars proxyn. */
async function workbench(b: Backends, appId: string): Promise<Awaited<ReturnType<typeof frontServer>>> {
  return frontServer(
    (req, res) => {
      void b.ensure(appId).then((port) => {
        if (port === null) {
          res.writeHead(503, { 'content-type': 'application/json' });
          res.end('{"error":"backend"}');
        } else proxyHttp(req, res, port);
      });
    },
    (req, socket, head) => {
      void b.ensure(appId).then((port) => {
        if (port === null) socket.destroy();
        else proxyUpgrade(req, socket, head, port);
      });
    },
  );
}

const pidsOf = (appId: string, prefix = 'STARTED '): number[] =>
  logs.of(appId, 'backend').filter((l) => l.startsWith(prefix)).map((l) => Number(l.slice(prefix.length)));
const notes = (appId: string): string[] => logs.of(appId, 'workbench');

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

before(() => {
  t = makeHome('supervisor-home');
  registry = fakeRegistry();
  logs = fakeLogs();
});

// Varje test lämnar inga processer efter sig, inte heller när det fallerar.
afterEach(async () => {
  await Promise.all(open.splice(0).map((b) => b.stopAll()));
});

after(async () => {
  await Promise.all(open.map((b) => b.stopAll()));
  fs.rmSync(path.dirname(t.paths.appsDir), { recursive: true, force: true });
});

describe('normal drift', { timeout: 60_000 }, () => {
  test('ensure startar backenden; GET, POST, ström och WebSocket går genom proxyn', async () => {
    const saved = { key: process.env.OPENAI_API_KEY, cc: process.env.CLAUDE_CODE_TEST, tz: process.env.TZ };
    // Planterade hemligheter i serverns miljö, och en vitlistad variabel som kontroll.
    process.env.OPENAI_API_KEY = 'sk-planterad';
    process.env.CLAUDE_CODE_TEST = 'planterad';
    process.env.TZ = 'Europe/Stockholm';
    const dir = makeApp(t, registry, 'anormal1', { 'server.mjs': NORMAL });
    installWs(dir);
    const b = supervisor();
    const front = await workbench(b, 'anormal1');
    try {
      const port = await b.ensure('anormal1');
      assert.ok(port !== null && port >= 18600 && port < 18640, String(port));
      assert.equal(b.state('anormal1'), 'running');
      assert.equal(b.port('anormal1'), port);
      assert.deepEqual(registry.statesOf('anormal1'), ['starting', 'running']);

      const info = JSON.parse((await request(front.port, { path: '/api/info', headers: { host: 'anormal1.localhost:8243' } })).body);
      const appReal = fs.realpathSync.native(dir);
      assert.equal(info.host, `127.0.0.1:${port}`);
      assert.equal(info.xfh, 'anormal1.localhost:8243');
      assert.deepEqual(info.env, { PORT: String(port), HOST: '127.0.0.1', DATA_DIR: path.join(appReal, 'data'), APP_ID: 'anormal1', NODE_ENV: 'development' });
      assert.equal(info.dataDirIsDir, true);
      assert.equal(info.cwd, appReal);
      assert.equal(info.argv1, path.join(appReal, 'server.mjs'));
      assert.ok(info.execArgv.some((a: string) => a.startsWith('--import=file://') && a.endsWith('/server/backends/guard.mjs')));
      assert.ok(!info.envKeys.includes('OPENAI_API_KEY') && !info.envKeys.includes('CLAUDE_CODE_TEST'), info.envKeys.join(','));
      assert.ok(info.envKeys.includes('TZ'), 'kontrollen: en vitlistad variabel syns');

      const big = 'å'.repeat(300_000);
      assert.equal((await request(front.port, { method: 'POST', path: '/api/echo', body: Buffer.from(big) })).body, big);
      assert.equal((await request(front.port, { path: '/api/stream' })).body, 'första\nandra\n');

      const ws = new WebSocket(`ws://127.0.0.1:${front.port}/api/ws`);
      const reply = await new Promise<string>((resolve, reject) => {
        ws.on('open', () => ws.send('hej'));
        ws.on('message', (m) => resolve(String(m)));
        ws.on('error', reject);
      });
      ws.close();
      assert.equal(reply, 'eko:hej');

      const profile = path.join(t.paths.appDataDir('anormal1'), 'backend.sb');
      assert.equal(fs.statSync(profile).mode & 0o777, 0o600);
      assert.equal(pidsOf('anormal1').length, 1);
    } finally {
      await front.close();
      await b.stopAll();
      for (const [k, v] of [['OPENAI_API_KEY', saved.key], ['CLAUDE_CODE_TEST', saved.cc], ['TZ', saved.tz]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  test('tre samtidiga ensure() startar en enda process', async () => {
    makeApp(t, registry, 'asamtid1', { 'server.mjs': NORMAL.replace("import { WebSocketServer } from 'ws';", 'const WebSocketServer = class { on() {} };') });
    const b = supervisor();
    const ports = await Promise.all([b.ensure('asamtid1'), b.ensure('asamtid1'), b.ensure('asamtid1')]);
    assert.ok(ports[0] !== null);
    assert.deepEqual(ports, [ports[0], ports[0], ports[0]]);
    assert.equal(pidsOf('asamtid1').length, 1);
    assert.deepEqual(registry.statesOf('asamtid1'), ['starting', 'running']);
    assert.equal(await b.ensure('asamtid1'), ports[0]);
    assert.equal(pidsOf('asamtid1').length, 1);
    await b.stopAll();
  });

  test('restart() byter process och behåller porten; två samtidiga restart() blir en', async () => {
    makeApp(t, registry, 'aomstart1', { 'server.mjs': NORMAL.replace("import { WebSocketServer } from 'ws';", 'const WebSocketServer = class { on() {} };') });
    const b = supervisor();
    const port = await b.ensure('aomstart1');
    const [first] = pidsOf('aomstart1');
    const again = await b.restart('aomstart1');
    assert.equal(again, port);
    const [, second] = pidsOf('aomstart1');
    assert.ok(second && second !== first);
    assert.ok(!isAlive(first));
    const both = await Promise.all([b.restart('aomstart1'), b.restart('aomstart1')]);
    assert.deepEqual(both, [port, port]);
    assert.equal(pidsOf('aomstart1').length, 3);
    assert.equal(pidsOf('aomstart1').filter(isAlive).length, 1);
    await b.stopAll();
  });
});

describe('krascher', { timeout: 60_000 }, () => {
  test('krasch vid start: omstart efter 1, 2 och 4 s, sedan crashed tills restart()', async () => {
    makeApp(t, registry, 'akrasch1', { 'server.mjs': CRASH_AT_START });
    const b = supervisor();
    assert.equal(await b.ensure('akrasch1'), null);
    await waitFor(() => notes('akrasch1').some((l) => l.includes('startas inte om')), 15_000, 'att backenden ges upp');
    const log = registry.backendLog.filter((x) => x.appId === 'akrasch1');
    assert.deepEqual(
      log.map((x) => x.state),
      ['starting', 'crashed', 'starting', 'crashed', 'starting', 'crashed', 'starting', 'crashed'],
    );
    const gaps = [1, 3, 5].map((i) => log[i + 1].at - log[i].at);
    for (const [gap, want] of gaps.map((g, i) => [g, [1000, 2000, 4000][i]])) {
      assert.ok(gap >= want - 20 && gap < want + 600, `väntan ${gap} ms, väntat ${want} ms`);
    }
    assert.equal(b.state('akrasch1'), 'crashed');
    assert.equal(await b.ensure('akrasch1'), null);
    await sleep(1500);
    assert.equal(pidsOf('akrasch1').length, 4, 'ingen femte start');
    assert.deepEqual(notes('akrasch1').filter((l) => l.startsWith('Startar om')), [
      'Startar om backenden om 1 s.',
      'Startar om backenden om 2 s.',
      'Startar om backenden om 4 s.',
    ]);
    assert.ok(notes('akrasch1').includes('Backenden avslutades med kod 1.'));
    assert.ok(notes('akrasch1').includes('Backenden har kraschat 4 gånger på 60 s och startas inte om förrän appen laddas om.'));
    // stderr radvis till loggen, även stackspåret
    const out = logs.of('akrasch1', 'backend');
    assert.ok(out.includes('Fel: trasig backend'));
    assert.ok(out.some((l) => l.includes('Error: trasig backend')));
    assert.ok(out.some((l) => /^\s+at /.test(l)));
    // restart() ger en ny omgång
    assert.equal(await b.restart('akrasch1'), null);
    assert.equal(pidsOf('akrasch1').length, 5);
    await waitFor(() => notes('akrasch1').filter((l) => l === 'Startar om backenden om 1 s.').length === 2, 3000, 'en ny omgång');
    await b.stop('akrasch1');
    assert.equal(b.state('akrasch1'), 'stopped');
    await sleep(1300);
    assert.equal(pidsOf('akrasch1').length, 5, 'stop() avbröt den schemalagda omstarten');
  });

  test('krasch under drift: omstart efter 1 s, och ensure() väntar in den', async () => {
    makeApp(t, registry, 'adrift1', { 'server.mjs': NORMAL.replace("import { WebSocketServer } from 'ws';", 'const WebSocketServer = class { on() {} };') });
    const b = supervisor();
    const front = await workbench(b, 'adrift1');
    try {
      const before = JSON.parse((await request(front.port, { path: '/api/info' })).body).pid as number;
      await request(front.port, { path: '/api/crash' });
      await waitFor(() => b.state('adrift1') === 'crashed', 3000, 'crashed');
      const crashedAt = Date.now();
      const after = JSON.parse((await request(front.port, { path: '/api/info' })).body).pid as number;
      const waited = Date.now() - crashedAt;
      assert.notEqual(after, before);
      assert.ok(waited >= 800 && waited < 2500, `${waited} ms`);
      assert.ok(notes('adrift1').includes('Backenden avslutades med kod 3.'));
      assert.equal(b.state('adrift1'), 'running');
    } finally {
      await front.close();
      await b.stopAll();
    }
  });

  test('svarar inte inom tidsgränsen: dödas och blir crashed (standard 8 s)', async () => {
    assert.equal(DEFAULT_OPTIONS.readyTimeoutMs, 8000);
    assert.deepEqual(DEFAULT_OPTIONS.restartDelaysMs, [1000, 2000, 4000]);
    assert.equal(DEFAULT_OPTIONS.restartWindowMs, 60_000);
    assert.equal(DEFAULT_OPTIONS.killGraceMs, 2000);
    assert.equal(DEFAULT_OPTIONS.portBase, 18300);
    makeApp(t, registry, 'atyst1', { 'server.mjs': NEVER_LISTENS });
    const b = supervisor({ readyTimeoutMs: 800, restartDelaysMs: [300] });
    const started = Date.now();
    assert.equal(await b.ensure('atyst1'), null);
    const took = Date.now() - started;
    assert.ok(took >= 750 && took < 3500, `${took} ms`);
    const [pid] = pidsOf('atyst1');
    assert.ok(!isAlive(pid), 'processen som inte svarade lever');
    assert.ok(notes('atyst1').some((l) => /^Backenden svarade inte på port \d+ inom 0,8 s\.$/.test(l)), notes('atyst1').join(' | '));
    await waitFor(() => notes('atyst1').some((l) => l.includes('startas inte om')), 5000, 'att den ges upp');
    assert.equal(b.state('atyst1'), 'crashed');
    assert.ok(pidsOf('atyst1').every((p) => !isAlive(p)));
    await b.stopAll();
  });
});

describe('stopp', { timeout: 60_000 }, () => {
  test('stop(): SIGTERM, SIGKILL efter 2 s, och hela processgruppen', async () => {
    makeApp(t, registry, 'aenvis1', { 'server.mjs': STUBBORN });
    const b = supervisor();
    const port = await b.ensure('aenvis1');
    assert.ok(port);
    const [pid] = pidsOf('aenvis1');
    const [child] = pidsOf('aenvis1', 'BARN ');
    assert.ok(isAlive(pid) && isAlive(child));
    const started = Date.now();
    await b.stop('aenvis1');
    const took = Date.now() - started;
    assert.ok(took >= 1900 && took < 3500, `${took} ms`);
    assert.ok(logs.of('aenvis1', 'backend').includes('ignorerar SIGTERM'));
    assert.ok(!isAlive(pid), 'backenden lever');
    await waitFor(() => !isAlive(child), 1000, 'att barnet dör');
    assert.ok(await portFree(port));
    assert.equal(b.state('aenvis1'), 'stopped');
    assert.equal(registry.statesOf('aenvis1').at(-1), 'stopped');
  });

  test('kalibrering: dödas bara ledaren blir barnet kvar (det testet ovan ska upptäcka)', async () => {
    const file = path.join(t.paths.appDir('aenvis1'), 'server.mjs');
    const leader = spawn(process.execPath, [file], { cwd: path.dirname(file), env: { ...process.env, PORT: '0' }, stdio: ['ignore', 'pipe', 'ignore'], detached: true });
    const child = await new Promise<number>((resolve) => {
      let out = '';
      leader.stdout.on('data', (d) => {
        out += d;
        const m = /BARN (\d+)/.exec(out);
        if (m) resolve(Number(m[1]));
      });
    });
    leader.kill('SIGKILL');
    await waitFor(() => !isAlive(leader.pid!), 2000);
    await sleep(300);
    assert.ok(isAlive(child), 'barnet borde ha överlevt när bara ledaren dödades');
    process.kill(child, 'SIGKILL');
    await waitFor(() => !isAlive(child), 2000);
  });

  test('stopAll() lämnar inga processer och stänger för nya starter', async () => {
    const plain = NORMAL.replace("import { WebSocketServer } from 'ws';", 'const WebSocketServer = class { on() {} };');
    makeApp(t, registry, 'aalla1', { 'server.mjs': plain });
    makeApp(t, registry, 'aalla2', { 'server.mjs': plain });
    makeApp(t, registry, 'aalla3', { 'server.mjs': STUBBORN });
    const b = supervisor();
    const ports = await Promise.all(['aalla1', 'aalla2', 'aalla3'].map((id) => b.ensure(id)));
    assert.equal(new Set(ports).size, 3);
    const pids = [...pidsOf('aalla1'), ...pidsOf('aalla2'), ...pidsOf('aalla3'), ...pidsOf('aalla3', 'BARN ')];
    assert.equal(pids.length, 4);
    await b.stopAll();
    await waitFor(() => pids.every((p) => !isAlive(p)), 2000, 'att alla processer är borta');
    for (const p of ports) assert.deepEqual(await listeners({ port: p! }), []);
    for (const id of ['aalla1', 'aalla2', 'aalla3']) assert.equal(b.state(id), 'stopped');
    assert.equal(await b.ensure('aalla1'), null);
    assert.equal(await b.restart('aalla1'), null);
    assert.equal(pidsOf('aalla1').length, 1);
  });
});

describe('manifest, sökvägar och data/', { timeout: 60_000 }, () => {
  test('appar utan backend: none, och en borttagen backend stoppas', async () => {
    makeApp(t, registry, 'aingen1', { 'index.html': '<p>hej</p>' }, { name: 'Ingen' });
    const b = supervisor();
    assert.equal(b.state('aingen1'), 'none');
    assert.equal(await b.ensure('aingen1'), null);
    assert.equal(await b.restart('aingen1'), null);
    assert.equal(b.port('aingen1'), null);
    assert.deepEqual(registry.statesOf('aingen1'), []);

    makeApp(t, registry, 'abort1', { 'server.mjs': NORMAL.replace("import { WebSocketServer } from 'ws';", 'const WebSocketServer = class { on() {} };') });
    assert.equal(b.state('abort1'), 'stopped');
    assert.ok(await b.ensure('abort1'));
    const [pid] = pidsOf('abort1');
    registry.manifests.set('abort1', { name: 'Utan backend nu' });
    assert.equal(await b.ensure('abort1'), null);
    assert.ok(!isAlive(pid));
    assert.equal(b.state('abort1'), 'none');
    assert.equal(registry.statesOf('abort1').at(-1), 'none');

    // restart() är också villkorslös (§7.4, §8.6, reload_app): utan backend i manifestet stoppar den processen.
    const withBackend = { name: 'Med backend', backend: { entry: 'server.mjs' } };
    registry.manifests.set('abort1', withBackend);
    assert.ok(await b.restart('abort1'));
    const t0 = Date.now();
    while (pidsOf('abort1').length < 2 && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 20));
    const pid2 = pidsOf('abort1').at(-1) as number;
    assert.notEqual(pid2, pid);
    assert.ok(isAlive(pid2));
    registry.manifests.set('abort1', { name: 'Utan backend igen' });
    assert.equal(await b.restart('abort1'), null);
    assert.ok(!isAlive(pid2), 'restart utan backend ska stoppa den gamla processen');
    assert.equal(b.state('abort1'), 'none');
    assert.equal(b.port('abort1'), null);
    await b.stopAll();
  });

  test('backend.entry vägras utanför appen, i dolda mappar, data/ och node_modules/', async () => {
    const outside = path.join(t.home, 'utanfor.mjs');
    fs.writeFileSync(outside, 'console.log("STARTED " + process.pid);');
    const b = supervisor();
    const cases: [string, string, Record<string, string>][] = [
      ['avag1', '../../utanfor.mjs', {}],
      ['avag2', '-e', { '-e': 'x' }],
      ['avag3', outside, {}],
      ['avag4', 'data/x.mjs', { 'data/x.mjs': 'x' }],
      ['avag5', '.dold/x.mjs', { '.dold/x.mjs': 'x' }],
      ['avag6', 'node_modules/x.mjs', { 'node_modules/x.mjs': 'x' }],
      ['avag7', 'Data/x.mjs', { 'data/x.mjs': 'x' }],
      ['avag8', 'saknas.mjs', {}],
      ['avag9', '', {}],
      ['avaga', 'katalog', { 'katalog/x.mjs': 'x' }],
      ['avagb', 'lank.mjs', {}],
    ];
    for (const [id, entry, files] of cases) {
      const dir = makeApp(t, registry, id, files, { backend: { entry } });
      if (id === 'avagb') fs.symlinkSync(outside, path.join(dir, 'lank.mjs'));
      assert.equal(await b.ensure(id), null, entry);
      assert.equal(b.state(id), 'crashed', entry);
      assert.ok(notes(id).some((l) => l.startsWith('Backenden kan inte startas: ')), `${entry}: ${notes(id).join(' | ')}`);
      assert.ok(!registry.statesOf(id).includes('starting'), entry);
      assert.equal(await b.ensure(id), null);
      assert.equal(notes(id).length, 1, 'ingen ny loggrad förrän restart()');
    }
    assert.equal(logs.lines.filter((l) => l.line.startsWith('STARTED')).filter((l) => l.appId.startsWith('avag')).length, 0);
    await b.stopAll();
  });

  test('data/ som symbolisk länk eller fil vägras; saknad data/ skapas', async () => {
    const target = path.join(t.home, 'annanstans');
    fs.mkdirSync(target, { recursive: true });
    const b = supervisor();
    const linked = makeApp(t, registry, 'adata1', { 'server.mjs': NEVER_LISTENS });
    fs.symlinkSync(target, path.join(linked, 'data'));
    assert.equal(await b.ensure('adata1'), null);
    assert.ok(notes('adata1').some((l) => l.includes('data/ är en symbolisk länk')), notes('adata1').join(' | '));
    assert.deepEqual(fs.readdirSync(target), []);
    makeApp(t, registry, 'adata2', { 'server.mjs': NEVER_LISTENS, data: 'en fil' });
    assert.equal(await b.ensure('adata2'), null);
    assert.ok(notes('adata2').some((l) => l.includes('ingen katalog')));
    const fresh = makeApp(t, registry, 'adata3', { 'server.mjs': 'import http from "node:http"; http.createServer((q, s) => s.end()).listen(Number(process.env.PORT));' });
    assert.ok(!fs.existsSync(path.join(fresh, 'data')));
    assert.ok(await b.ensure('adata3'));
    const st = fs.lstatSync(path.join(fresh, 'data'));
    assert.ok(st.isDirectory() && !st.isSymbolicLink());
    await b.stopAll();
  });
});

describe('sandlådan av eller saknas', { timeout: 60_000 }, () => {
  test('sandbox-exec saknas: osandlådat, med varning från workbench', async () => {
    makeApp(t, registry, 'autan1', { 'server.mjs': 'import http from "node:http"; http.createServer((q, s) => s.end("ok")).listen(Number(process.env.PORT));' });
    const b = supervisor({ sandboxExec: '/saknas/sandbox-exec' });
    assert.ok(await b.ensure('autan1'));
    assert.ok(notes('autan1').includes('/saknas/sandbox-exec saknas: backenden körs utan sandlåda.'));
    assert.ok(!fs.existsSync(path.join(t.paths.appDataDir('autan1'), 'backend.sb')));
    await b.stopAll();
  });

  test('WORKBENCH_SANDBOX=0: osandlådat, med varning från workbench', async () => {
    makeApp(t, registry, 'autan2', { 'server.mjs': 'import http from "node:http"; http.createServer((q, s) => s.end("ok")).listen(Number(process.env.PORT));' });
    const b = supervisor({}, { ...t.config, sandbox: false });
    assert.ok(await b.ensure('autan2'));
    assert.ok(notes('autan2').includes('Sandlådan är avstängd (WORKBENCH_SANDBOX=0): backenden körs utan sandlåda.'));
    await b.stopAll();
  });
});

describe('loggar och portar', { timeout: 60_000 }, () => {
  test('stdout och stderr radvis, CR bort, långa rader delas, och ett tak per sekund', async () => {
    makeApp(t, registry, 'aprat1', { 'server.mjs': CHATTY });
    const b = supervisor({ logLinesPerSecond: 50 });
    assert.ok(await b.ensure('aprat1'));
    await waitFor(() => notes('aprat1').some((l) => l.includes('hoppades över')), 4000, 'sammanfattningen');
    const out = logs.of('aprat1', 'backend');
    for (const line of ['rad ett', 'rad två', 'halv rad', 'fel på stderr']) assert.ok(out.includes(line), line);
    assert.ok(!out.some((l) => l.includes('\r')));
    const xs = out.filter((l) => /^x+$/.test(l)).map((l) => l.length);
    assert.deepEqual(xs, [8000, 8000, 4000]);
    const count = () => {
      const massa = logs.of('aprat1', 'backend').filter((l) => l.startsWith('massa ')).length;
      const dropped = notes('aprat1')
        .filter((l) => l.includes('hoppades över'))
        .map((l) => Number(/^(\d+) rader från backenden hoppades över \(högst 50 per sekund\)\.$/.exec(l)?.[1]))
        .reduce((a, b) => a + b, 0);
      return { massa, dropped };
    };
    // Med mottryck (ROB-5) läses resten först nästa sekund: varje rad blir till sist loggad eller räknad.
    await waitFor(() => count().massa + count().dropped === 1000, 6000, 'alla rader loggade eller räknade').catch((err) => {
      throw new Error(`${(err as Error).message}: ${JSON.stringify(count())} ${JSON.stringify(notes('aprat1'))}`);
    });
    const { massa, dropped } = count();
    assert.ok(massa < 1000 && dropped > 0, `${massa} + ${dropped}`);
    assert.equal(massa + dropped, 1000);
    await b.stopAll();
  });

  test('en backend som översvämmar stdout bromsas av röret (ROB-5), kalibrerat mot läsning utan paus', async () => {
    const FLOOD = `
import http from 'node:http';
const big = ('y'.repeat(200) + '\\n').repeat(500);
function pump() { while (process.stdout.write(big)) {} process.stdout.once('drain', pump); }
http.createServer((q, s) => s.end('ok')).listen(Number(process.env.PORT), pump);
`;
    /** Rader som servern läste (loggade + hoppade över) under ungefär två sekunders flod. */
    async function readDuringFlood(id: string, backpressure: boolean): Promise<number> {
      makeApp(t, registry, id, { 'server.mjs': FLOOD });
      const b = supervisor({ backpressure });
      assert.ok(await b.ensure(id));
      await sleep(2200);
      await b.stopAll();
      await sleep(1200); // sista sammanfattningen
      const logged = logs.of(id, 'backend').length;
      const dropped = notes(id)
        .map((l) => Number(/^(\d+) rader från backenden hoppades över/.exec(l)?.[1] ?? 0))
        .reduce((a, x) => a + x, 0);
      return logged + dropped;
    }
    const without = await readDuringFlood('aflod01', false);
    const withBp = await readDuringFlood('aflod02', true);
    // Kalibrering: utan paus läser servern hundratusentals rader bara för att släppa dem.
    assert.ok(without > 100_000, `utan paus: ${without}`);
    assert.ok(withBp < 20_000, `med paus: ${withBp} (utan: ${without})`);
    assert.ok(logs.of('aflod02', 'backend').length > 0, 'loggen får fortfarande rader');
  });

  test('upptagna portar och workbenchens egna portar hoppas över', async () => {
    const blocker = net.createServer();
    await new Promise<void>((r) => blocker.listen(18600, '127.0.0.1', r));
    const plain = 'import http from "node:http"; http.createServer((q, s) => s.end("ok")).listen(Number(process.env.PORT));';
    makeApp(t, registry, 'aport1', { 'server.mjs': plain });
    makeApp(t, registry, 'aport2', { 'server.mjs': plain });
    const b = supervisor({}, { ...t.config, hmrPort: 18602 });
    try {
      const ports = await Promise.all([b.ensure('aport1'), b.ensure('aport2')]);
      assert.deepEqual([...ports].sort(), [18601, 18603]);
    } finally {
      await b.stopAll();
      blocker.close();
    }
  });

  test('lsof-tolkningen: bara loopback räknas som loopback', () => {
    assert.deepEqual(parseLsof('p12\nf20\nn127.0.0.1:18300\np13\nf3\nn*:5000\n'), [
      { pid: 12, name: '127.0.0.1:18300' },
      { pid: 13, name: '*:5000' },
    ]);
    for (const ok of ['127.0.0.1:1', '[::1]:2', '127.5.6.7:3']) assert.ok(isLoopbackListener(ok), ok);
    for (const bad of ['*:1', '0.0.0.0:2', '[::]:3', '192.168.1.4:4', '[fe80::1%lo0]:5', '10.0.0.1:6']) assert.ok(!isLoopbackListener(bad), bad);
  });
});
