// tests/unit/server-backends-supervisor.test.ts — app-backendernas livscykel (CONTRACT §9).
// Riktiga nodeprocesser i riktiga appmappar under $HOME, med sandlådan påslagen (standard),
// bakom en "workbench"-server som gör som server-http: await ensure(), sedan proxyn.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { after, afterEach, before, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import { proxyHttp, proxyUpgrade } from '../../server/backends/proxy.ts';
import { sbplString } from '../../server/backends/sandbox.ts';
import { DEFAULT_OPTIONS, backendIdleMs, createBackends, duration, isLoopbackListener, parseLsof } from '../../server/backends/supervisor.ts';
import type { BackendOptions, BackendsEx } from '../../server/backends/supervisor.ts';
import type { Backends, Config } from '../../server/types.ts';
import { testPortSpan } from '../ports.ts';
import {
  ROOT, fakeLogs, fakeRegistry, frontServer, installWs, isAlive, listeners, makeApp, makeHome, request, sleep, waitFor,
} from './server-backends-harness.test.ts';
import type { FakeLogs, FakeRegistry, TestHome } from './server-backends-harness.test.ts';
import { applyLeak, type Patch } from '../bridge-harness/leaks.ts';

// Ett eget spann utanför produktionens (18300–18499), så att varken en workbench som körs samtidigt eller en
// annan testkörning tar testets portar.
const BASE = await testPortSpan(40);
const OPTIONS: Partial<BackendOptions> = { portBase: BASE, portSpan: 40 };

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

// Startar ett barnbarn med en bar spawn(process.execPath, …), utan --import, och svarar med var dess listen(0, '0.0.0.0') band.
// helper: ett barnbarn med en egen HTTP-server, och vad den svarar med Host på sin egen port och med en främmande Host.
const GRANDCHILD = `
import http from 'node:http';
import { spawn } from 'node:child_process';
const probe = () => new Promise((resolve) => {
  const child = spawn(process.execPath, ['-e', 'const s = require("net").createServer(); s.listen(0, "0.0.0.0", () => { console.log(s.address().address); s.close(); })'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  child.on('exit', () => resolve(out.trim()));
});
const helper = () => new Promise((resolve) => {
  const child = spawn(process.execPath, ['-e', 'const s = require("http").createServer((q, r) => r.end("barn")); s.listen(0, () => console.log(s.address().port))'], { stdio: ['ignore', 'pipe', 'inherit'] });
  child.stdout.once('data', async (d) => {
    const port = Number(String(d).trim());
    const status = (host) => new Promise((ok) => http.get({ host: '127.0.0.1', port, headers: { host }, agent: false }, (r) => { r.resume(); ok(r.statusCode); }).on('error', (e) => ok(e.code)));
    const result = { own: await status('127.0.0.1:' + port), foreign: await status('evil.example:' + port) };
    child.kill();
    resolve(result);
  });
});
http.createServer(async (req, res) => res.end(JSON.stringify({ grandchild: await probe(), nodeOptions: process.env.NODE_OPTIONS ?? null, helper: await helper() }))).listen(Number(process.env.PORT));
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

function supervisor(options: Partial<BackendOptions> = {}, config: Config = t.config): BackendsEx {
  const b = createBackends({ config, paths: t.paths, registry, logs }, { ...OPTIONS, ...options });
  open.push(b);
  return b;
}

/**
 * Som server-http: hold() tills svaret eller socketen stängs, await ensure(), 503 utan backend, annars proxyn.
 * hold: false är det planterade felet för tomgångsstoppet (inga pågående förfrågningar räknas).
 */
async function workbench(b: BackendsEx, appId: string, { hold = true } = {}): Promise<Awaited<ReturnType<typeof frontServer>>> {
  return frontServer(
    (req, res) => {
      if (hold) res.on('close', b.hold(appId));
      void b.ensure(appId).then((port) => {
        if (port === null) {
          res.writeHead(503, { 'content-type': 'application/json' });
          res.end('{"error":"backend"}');
        } else proxyHttp(req, res, port);
      });
    },
    (req, socket, head) => {
      if (hold) socket.on('close', b.hold(appId));
      void b.ensure(appId).then((port) => {
        if (port === null) socket.destroy();
        else proxyUpgrade(req, socket, head, port);
      });
    },
  );
}

/** En kopia av supervisor.ts med ett planterat fel (exakta textbyten), för kalibreringar. */
const plantedFiles: string[] = [];
async function plantedSupervisor(patches: readonly Patch[]): Promise<typeof createBackends> {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const dir = path.join(root, '.scratch', 'supervisor-plants');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `supervisor-${process.pid}-${plantedFiles.length}.ts`);
  const orig = path.join(root, 'server/backends/supervisor.ts');
  // Varje relativ import pekar på originalets moduler, så att kopian tål en ny import i supervisor.ts.
  const src = applyLeak(fs.readFileSync(orig, 'utf8'), patches)
    .replace(/(from\s+)'(\.{1,2}\/[^']+)'/g, (_, from: string, rel: string) => `${from}'${pathToFileURL(path.resolve(path.dirname(orig), rel)).href}'`);
  fs.writeFileSync(file, src);
  plantedFiles.push(file);
  return ((await import(pathToFileURL(file).href)) as { createBackends: typeof createBackends }).createBackends;
}
after(() => {
  for (const f of plantedFiles) fs.rmSync(f, { force: true });
});

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
}, { timeout: 30_000 });

after(async () => {
  await Promise.all(open.map((b) => b.stopAll()));
  fs.rmSync(path.dirname(t.paths.appsDir), { recursive: true, force: true });
}, { timeout: 30_000 });

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
      assert.ok(port !== null && port >= BASE && port < BASE + 40, String(port));
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
      // Workbenchens repo är skrivspärrat (npm run dev kör det osandlådat), också när appen ligger i det, som här.
      const repo = `(subpath ${sbplString(fs.realpathSync.native(ROOT))})`;
      assert.ok(fs.readFileSync(profile, 'utf8').split('\n').some((l) => l.startsWith('(deny file-write* ') && l.includes(repo)), repo);
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

  test('ett barnbarn från en bar spawn(node) laddar också vakten (NODE_OPTIONS), som släpper in barnets egen port men inte en främmande Host, även med mellanslag i repots sökväg', async () => {
    // Ett repo vars sökväg har mellanslag: en rå sökväg i NODE_OPTIONS delas där, och då startar inte ens backenden.
    const root = path.join(path.dirname(t.paths.appsDir), 'rot med mellanslag');
    fs.mkdirSync(path.join(root, 'server', 'backends'), { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'server', 'backends', 'guard.mjs'), path.join(root, 'server', 'backends', 'guard.mjs'));
    makeApp(t, registry, 'abarnbarn1', { 'server.mjs': GRANDCHILD });
    const b = supervisor({}, { ...t.config, root });
    const front = await workbench(b, 'abarnbarn1');
    try {
      const r = JSON.parse((await request(front.port, { path: '/api/x' })).body) as {
        grandchild: string; nodeOptions: string | null; helper: { own: number | string; foreign: number | string };
      };
      assert.equal(r.grandchild, '127.0.0.1', JSON.stringify(r));
      assert.ok(r.nodeOptions?.includes('/rot%20med%20mellanslag/server/backends/guard.mjs'), String(r.nodeOptions));
      // Vakten ärver backendens PORT, men en hjälpserver i ett barn svarar ändå på sin egen port (och 421 på en främmande Host).
      assert.deepEqual(r.helper, { own: 200, foreign: 421 }, JSON.stringify(r));
    } finally {
      await front.close();
      await b.stopAll();
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
    await waitFor(() => notes('akrasch1').some((l) => l.includes('Den startar igen när')), 15_000, 'att backenden ges upp');
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
    assert.ok(notes('akrasch1').includes('Backenden kraschade 4 gånger på 60 s. Den startar igen när Claude ändrar appen eller när du ångrar.'));
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
    await waitFor(() => notes('atyst1').some((l) => l.includes('Den startar igen när')), 5000, 'att den ges upp');
    assert.equal(b.state('atyst1'), 'crashed');
    assert.ok(pidsOf('atyst1').every((p) => !isAlive(p)));
    await b.stopAll();
  });

  test('ger supervisorn upp anropas onCrashed med orsaken och backendens sista rader, en gång per uppgivande (§9)', async () => {
    const crashed: { appId: string; text: string }[] = [];
    makeApp(t, registry, 'agivup1', { 'server.mjs': CRASH_AT_START });
    const b = supervisor({ restartDelaysMs: [30, 30], onCrashed: (appId: string, text: string) => void crashed.push({ appId, text }) });
    assert.equal(await b.ensure('agivup1'), null);
    // Kalibrering: medan supervisorn startar om (kraschat men inte uppgivet) anropas den inte.
    assert.equal(crashed.length, 0, 'den första kraschen är ingen uppgivning');
    await waitFor(() => crashed.length > 0, 15_000, 'onCrashed efter uppgivandet');
    await sleep(200);
    assert.equal(crashed.length, 1);
    const [head, ...tail] = crashed[0].text.split('\n');
    assert.deepEqual({ appId: crashed[0].appId, head }, { appId: 'agivup1', head: 'Backenden kraschade 3 gånger på 60 s. Den startar igen när Claude ändrar appen eller när du ångrar.' });
    assert.ok(tail.length >= 1 && tail.length <= 3, tail.join(' | '));
    assert.ok(tail.includes('Error: trasig backend'), `backendens felrad: ${tail.join(' | ')}`);
    // Sökvägar i appens mapp står relativt den (som etiketterna, §8.3), inte som file:///Users/…/apps/<id>/server.mjs.
    const appReal = fs.realpathSync.native(t.paths.appDir('agivup1'));
    assert.ok(tail.every((l) => !l.includes(appReal)), `en absolut sökväg: ${tail.join(' | ')}`);
    assert.ok(tail.some((l) => /^server\.mjs:\d+$/.test(l)), `källraden: ${tail.join(' | ')}`);
    assert.ok(tail.every((l) => !/^\s*at /.test(l) && !/^\^+$/.test(l) && !/^Node\.js v/.test(l) && l.length <= 200), 'inga stackrader, markeringar eller versionsrader');
    // En start som inte går ger upp direkt (giveUp): orsaken, utan backendrader eftersom ingen process startade.
    makeApp(t, registry, 'agivup2', {}, { backend: { entry: 'saknas.mjs' } });
    assert.equal(await b.ensure('agivup2'), null);
    assert.deepEqual(crashed.at(-1), { appId: 'agivup2', text: 'Backenden kan inte startas: backend.entry finns inte: "saknas.mjs".' });
    assert.equal(await b.ensure('agivup2'), null);
    assert.equal(crashed.filter((c) => c.appId === 'agivup2').length, 1, 'en uppgiven backend anropar inte igen förrän restart()');
    await b.stopAll();
  });

  test('en uppgiven backend startar igen när koden ändrats sedan det senaste försöket, vid nästa ensure() (kalibrerat: utan ändring startar ensure() ingen)', async () => {
    const crashed: string[] = [];
    const dir = makeApp(t, registry, 'arattad1', { 'server.mjs': CRASH_AT_START });
    const b = supervisor({ restartDelaysMs: [30], onCrashed: (_appId: string, text: string) => void crashed.push(text) });
    assert.equal(await b.ensure('arattad1'), null);
    await waitFor(() => crashed.length > 0, 10_000, 'uppgivandet');
    // Kalibrering: med samma kod startar ensure() ingen ny process.
    assert.equal(await b.ensure('arattad1'), null);
    assert.equal(pidsOf('arattad1').length, 2);
    // En rättning för hand (eller av Claude mitt i en tur), och sedan appens nästa förfrågan eller call_backend.
    fs.writeFileSync(path.join(dir, 'server.mjs'), "import http from 'node:http';\nconsole.log('STARTED ' + process.pid);\nhttp.createServer((q, s) => s.end('rättad')).listen(Number(process.env.PORT));\n");
    const port = await b.ensure('arattad1');
    assert.ok(port, notes('arattad1').join(' | '));
    assert.equal(b.state('arattad1'), 'running');
    assert.equal(pidsOf('arattad1').length, 3);
    assert.ok(notes('arattad1').includes('Backendens kod har ändrats sedan den gavs upp: startar igen.'), notes('arattad1').join(' | '));
    assert.equal(crashed.length, 1, 'ingen ny not när den startar');
    // Det användaren läser i HUD:en (§8.1) säger vad som startar den igen. Förut: "förrän appen laddas om", och ingen
    // omladdning gjorde det (QA 17 oktober).
    assert.equal(crashed[0].split('\n')[0], 'Backenden kraschade 2 gånger på 60 s. Den startar igen när Claude ändrar appen eller när du ångrar.');
    await b.stopAll();
  });

  test('en backend som lyssnar utanför loopback stoppas, och onCrashed får orsaken en gång (§9)', async () => {
    const crashed: { appId: string; text: string }[] = [];
    // Ett låtsat lsof som rapporterar en lyssnare på alla gränssnitt (de riktiga läckorna provas i server-backends-escape).
    const lsof = path.join(t.home, 'lsof-alla-granssnitt.sh');
    fs.writeFileSync(lsof, "#!/bin/sh\necho p1\necho 'n*:4242'\n", { mode: 0o755 });
    makeApp(t, registry, 'aexpo1', { 'server.mjs': "import http from 'node:http';\nconsole.log('STARTED ' + process.pid);\nhttp.createServer((req, res) => res.end('ok')).listen(Number(process.env.PORT));\n" });
    const b = supervisor({ lsof, onCrashed: (appId: string, text: string) => void crashed.push({ appId, text }) });
    assert.equal(await b.ensure('aexpo1'), null);
    assert.equal(b.state('aexpo1'), 'crashed');
    await waitFor(() => crashed.length > 0, 5000, 'onCrashed efter stoppet');
    await sleep(200);
    assert.equal(crashed.length, 1);
    assert.deepEqual(
      { appId: crashed[0].appId, head: crashed[0].text.split('\n')[0] },
      { appId: 'aexpo1', head: 'Backenden lyssnade på *:4242, inte bara på 127.0.0.1, och stoppades.' },
    );
    // Uppgiven: ensure() startar den inte igen, och onCrashed anropas inte igen förrän restart().
    assert.equal(await b.ensure('aexpo1'), null);
    await sleep(200);
    assert.equal(crashed.length, 1);
    await b.stopAll();
  });

  test('en lyssnare utanför loopback som öppnas under drift fångas av lsof igen, och onCrashed får samma orsak en gång (§9)', async () => {
    const crashed: { appId: string; text: string }[] = [];
    // Det riktiga lsof efter redo, sedan en låtsad lyssnare på alla gränssnitt, som ett barn som öppnar en senare.
    const mark = path.join(t.home, 'lsof-senare.mark');
    const lsof = path.join(t.home, 'lsof-senare.sh');
    fs.writeFileSync(lsof, `#!/bin/sh\nif [ -e '${mark}' ]; then echo p1; echo 'n*:4242'; exit 0; fi\n: > '${mark}'\nexec ${DEFAULT_OPTIONS.lsof} "$@"\n`, { mode: 0o755 });
    makeApp(t, registry, 'aexpo2', { 'server.mjs': "import http from 'node:http';\nconsole.log('STARTED ' + process.pid);\nhttp.createServer((req, res) => res.end('ok')).listen(Number(process.env.PORT));\n" });
    const b = supervisor({ lsof, listenCheckMs: 200, onCrashed: (appId: string, text: string) => void crashed.push({ appId, text }) });
    // Kalibrering: kontrollen efter redo släpper igenom backenden, och onCrashed har inte anropats.
    assert.ok(await b.ensure('aexpo2'), 'backenden kör efter den första kontrollen');
    assert.equal(crashed.length, 0);
    await waitFor(() => b.state('aexpo2') === 'crashed', 5000, 'stoppet efter kontrollen under drift');
    await waitFor(() => crashed.length > 0, 5000, 'onCrashed efter kontrollen under drift');
    await sleep(300);
    assert.equal(crashed.length, 1);
    assert.deepEqual(
      { appId: crashed[0].appId, head: crashed[0].text.split('\n')[0] },
      { appId: 'aexpo2', head: 'Backenden lyssnade på *:4242, inte bara på 127.0.0.1, och stoppades.' },
    );
    assert.ok(pidsOf('aexpo2').every((p) => !isAlive(p)));
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

  // Felsignalen (§7.2): bara en krasch räknas. Ett hanterat fel som loggas med console.error ser likadant ut på stderr
  // som kraschens felrad, så en backend som loggar ett misslyckat anrop per förfrågan skulle annars vara bärnstensfärgad.
  const HANDLED = `
import http from 'node:http';
console.error(new Error('connect ECONNREFUSED 127.0.0.1:993'));
console.error('Error handling enabled');
console.log('Error: på stdout');
setInterval(() => console.error(new TypeError('fetch failed')), 100);
http.createServer((req, res) => res.end('ok')).listen(Number(process.env.PORT));
`;
  /** Planterat fel: varje stderr-rad lämnas till registret (som före granskningen), inte bara kraschens. */
  const PER_LINE: readonly Patch[] = [["      if (proc && troubleLine('stderr', line)) proc.lastError = line;\n", "      if (proc) registry.noteLog(e.id, 'stderr', line);\n"]];

  test('felsignalen: hanterade fel på stderr lämnas inte till registret, inte heller när backenden stoppas; kalibrerat', async () => {
    const run = async (make: typeof createBackends, appId: string) => {
      makeApp(t, registry, appId, { 'server.mjs': HANDLED });
      const b = make({ config: t.config, paths: t.paths, registry, logs }, OPTIONS);
      open.push(b);
      assert.ok(await b.ensure(appId));
      await waitFor(() => logs.of(appId, 'backend').filter((l) => l === 'TypeError: fetch failed').length >= 3, 4000, 'raderna');
      await b.stop(appId);
      await sleep(200); // 'close' kommer efter 'exit'
      return registry.noted.filter((n) => n.appId === appId).map((n) => [n.source, n.line]);
    };
    assert.deepEqual(await run(createBackends, 'astd1'), [], 'en backend som loggar ett fel och lever vidare har inte kraschat');
    const planted = await run(await plantedSupervisor(PER_LINE), 'astd2');
    assert.ok(planted.some(([, l]) => l === 'Error: connect ECONNREFUSED 127.0.0.1:993'), `testet ska fälla det planterade felet (${JSON.stringify(planted)})`);
  });

  test('felsignalen: en backend som kraschar lämnar sin sista felrad till registret, en gång per krasch', async () => {
    const CRASH_LATER = `
import http from 'node:http';
console.error(new Error('hanterat före kraschen'));
http.createServer((req, res) => res.end('ok')).listen(Number(process.env.PORT), () => {
  setTimeout(() => { throw new TypeError('trasig efter start'); }, 300);
});
`;
    makeApp(t, registry, 'acrash1', { 'server.mjs': CRASH_LATER });
    const b = supervisor({ restartDelaysMs: [60_000] });
    assert.ok(await b.ensure('acrash1'));
    await waitFor(() => registry.noted.some((n) => n.appId === 'acrash1'), 5000, 'kraschens felrad');
    await sleep(300);
    await b.stop('acrash1');
    assert.deepEqual(
      registry.noted.filter((n) => n.appId === 'acrash1').map((n) => [n.source, n.line]),
      [['stderr', 'TypeError: trasig efter start']],
      'kraschens rad, inte det hanterade felet före den eller platsraderna',
    );
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
    await new Promise<void>((resolve, reject) => {
      blocker.once('error', reject);
      blocker.listen(BASE, '127.0.0.1', resolve);
    });
    const plain = 'import http from "node:http"; http.createServer((q, s) => s.end("ok")).listen(Number(process.env.PORT));';
    makeApp(t, registry, 'aport1', { 'server.mjs': plain });
    makeApp(t, registry, 'aport2', { 'server.mjs': plain });
    const b = supervisor({}, { ...t.config, hmrPort: BASE + 2 });
    try {
      const ports = await Promise.all([b.ensure('aport1'), b.ensure('aport2')]);
      assert.deepEqual([...ports].sort(), [BASE + 1, BASE + 3]);
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

/* ---------------------------- tomgång och färskhet ---------------------------- */

const IDLE = `
import http from 'node:http';
import { WebSocketServer } from 'ws';
console.log('STARTED ' + process.pid);
const server = http.createServer((req, res) => {
  if (req.url === '/api/pid') { res.end(String(process.pid)); return; }
  if (req.url === '/api/slow') { setTimeout(() => res.end(String(process.pid)), 900); return; }
  if (req.url === '/api/sse') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: ' + process.pid + '\\n\\n'); return; }
  res.statusCode = 404; res.end();
});
new WebSocketServer({ server, path: '/api/ws' }).on('connection', (ws) => ws.on('message', (m) => ws.send(process.pid + ':' + m)));
server.listen(Number(process.env.PORT), process.env.HOST);
`;

describe('tomgång (idleMs)', { timeout: 60_000 }, () => {
  const IDLE_MS = 300;

  /** En öppen SSE-ström genom fronten; close() avbryter den. */
  function sse(port: number): Promise<{ first: string; close: () => void }> {
    return new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/api/sse', agent: false }, (res) => {
        res.once('data', (d: Buffer) => resolve({ first: String(d), close: () => req.destroy() }));
      });
      req.on('error', reject);
    });
  }

  function wsOpen(port: number): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws`);
      ws.once('open', () => resolve(ws));
      ws.once('error', reject);
    });
  }

  test('stoppas efter idleMs utan förfrågningar, och nästa förfrågan startar den igen', async () => {
    installWs(makeApp(t, registry, 'avila1', { 'server.mjs': IDLE }));
    const b = supervisor({ idleMs: IDLE_MS });
    const front = await workbench(b, 'avila1');
    try {
      const pid1 = Number((await request(front.port, { path: '/api/pid' })).body);
      assert.equal(b.state('avila1'), 'running');
      await waitFor(() => b.state('avila1') === 'stopped', 3000, 'tomgångsstoppet');
      await waitFor(() => !isAlive(pid1), 3000, 'att processen är borta');
      assert.ok(notes('avila1').includes('Backenden stoppades efter 0,3 s utan förfrågningar; nästa förfrågan startar den igen.'), notes('avila1').join(' | '));
      const pid2 = Number((await request(front.port, { path: '/api/pid' })).body);
      assert.ok(pid2 > 0 && pid2 !== pid1, `${pid1} → ${pid2}`);
      assert.equal(b.state('avila1'), 'running');
      assert.deepEqual(registry.statesOf('avila1'), ['starting', 'running', 'stopped', 'starting', 'running']);
    } finally {
      await front.close();
      await b.stopAll();
    }
  });

  test('inte mitt i en förfrågan, kalibrerat mot en workbench som inte räknar dem', async () => {
    installWs(makeApp(t, registry, 'avila2', { 'server.mjs': IDLE }));
    const b = supervisor({ idleMs: IDLE_MS });
    // Planterat fel: utan räkningen stoppas backenden under den långsamma förfrågan (900 ms mot 300 ms).
    const planted = await workbench(b, 'avila2', { hold: false });
    try {
      const r = await request(planted.port, { path: '/api/slow' });
      assert.equal(r.status, 502, `planterat: ${r.status} ${r.body}`);
    } finally {
      await planted.close();
    }
    await waitFor(() => b.state('avila2') === 'stopped', 3000, 'stoppet i kalibreringen');
    const front = await workbench(b, 'avila2');
    try {
      const pid = Number((await request(front.port, { path: '/api/pid' })).body);
      const slow = await request(front.port, { path: '/api/slow' });
      assert.equal(slow.status, 200);
      assert.equal(Number(slow.body), pid, 'samma process svarade');
      assert.equal(b.state('avila2'), 'running');
      await waitFor(() => b.state('avila2') === 'stopped', 3000, 'stoppet efter förfrågan');
    } finally {
      await front.close();
      await b.stopAll();
    }
  });

  test('inte medan en WebSocket eller en SSE-ström är öppen, kalibrerat mot en workbench som inte räknar dem', async () => {
    installWs(makeApp(t, registry, 'avila3', { 'server.mjs': IDLE }));
    const b = supervisor({ idleMs: IDLE_MS });
    // Uppgraderade socketar stänger inte med servern: varje klient avslutas, så att ett fel aldrig hänger testet.
    const clients: { terminate(): void }[] = [];
    // Planterat fel: utan räkningen stoppas backenden, och WebSocketen stängs med den.
    const planted = await workbench(b, 'avila3', { hold: false });
    try {
      const ws = await wsOpen(planted.port);
      clients.push(ws);
      const closed = await new Promise<boolean>((resolve) => {
        ws.once('close', () => resolve(true));
        setTimeout(() => resolve(false), 3000);
      });
      assert.ok(closed, 'planterat: WebSocketen stängdes aldrig');
    } finally {
      for (const c of clients.splice(0)) c.terminate();
      await planted.close();
    }
    await waitFor(() => b.state('avila3') === 'stopped', 3000, 'stoppet i kalibreringen');
    const front = await workbench(b, 'avila3');
    try {
      const ws = await wsOpen(front.port);
      clients.push(ws);
      await sleep(IDLE_MS * 3);
      assert.equal(b.state('avila3'), 'running', 'WebSocketen håller backenden vid liv');
      ws.send('hej');
      const reply = await new Promise<string>((resolve) => ws.once('message', (m) => resolve(String(m))));
      assert.match(reply, /^\d+:hej$/);
      const stream = await sse(front.port);
      clients.push({ terminate: stream.close });
      assert.match(stream.first, /^data: \d+/);
      ws.close();
      await sleep(IDLE_MS * 3);
      assert.equal(b.state('avila3'), 'running', 'SSE-strömmen håller backenden vid liv');
      stream.close();
      await waitFor(() => b.state('avila3') === 'stopped', 3000, 'stoppet när allt stängts');
    } finally {
      for (const c of clients.splice(0)) c.terminate();
      await front.close();
      await b.stopAll();
    }
  });

  test('tomgångsstoppet är ingen krasch: ingen onCrashed och ingen felsignal, fast backenden loggat ett fel på stderr (kalibrerat mot ett planterat stopp utan orsak)', async () => {
    const LOGS_ERROR = `
import http from 'node:http';
console.log('STARTED ' + process.pid);
console.error(new Error('hanterat fel'));
http.createServer((req, res) => res.end(String(process.pid))).listen(Number(process.env.PORT), process.env.HOST);
`;
    // Planterat fel: tomgångsstoppet signalerar processen direkt, utan stoppets orsak, som en krasch.
    const NO_REASON: readonly Patch[] = [['      void stopEntry(e);\n    }, opt.idleMs);', "      signalGroup(proc, 'SIGTERM');\n    }, opt.idleMs);"]];
    const run = async (make: typeof createBackends, appId: string) => {
      makeApp(t, registry, appId, { 'server.mjs': LOGS_ERROR });
      const crashed: string[] = [];
      const b = make({ config: t.config, paths: t.paths, registry, logs }, { ...OPTIONS, idleMs: IDLE_MS, restartDelaysMs: [30], onCrashed: (_a: string, text: string) => void crashed.push(text) });
      open.push(b);
      assert.ok(await b.ensure(appId));
      await waitFor(() => logs.of(appId, 'backend').includes('Error: hanterat fel'), 3000, 'felraden på stderr');
      return { b, crashed, noted: () => registry.noted.filter((n) => n.appId === appId).map((n) => n.line) };
    };
    const planted = await run(await plantedSupervisor(NO_REASON), 'avila6');
    await waitFor(() => planted.crashed.length > 0, 8000, 'att det planterade felet syns som en uppgiven krasch');
    assert.ok(planted.noted().includes('Error: hanterat fel'), `testet ska fälla det planterade felet: ${JSON.stringify(planted.noted())}`);
    const real = await run(createBackends, 'avila5');
    await waitFor(() => real.b.state('avila5') === 'stopped', 3000, 'tomgångsstoppet');
    // Lika länge som det planterade felet behövde för två stopp och uppgivandet (stopp, omstart 30 ms, stopp, högst 1 s väntan).
    await sleep(IDLE_MS * 4 + 1200);
    assert.deepEqual(real.crashed, []);
    assert.deepEqual(real.noted(), []);
    assert.equal(real.b.state('avila5'), 'stopped');
    assert.ok(!registry.statesOf('avila5').includes('crashed'), registry.statesOf('avila5').join(','));
  });

  test('idleMs 0 stoppar aldrig; standard 10 min, som WORKBENCH_BACKEND_IDLE_MS kan ändra', async () => {
    assert.equal(DEFAULT_OPTIONS.idleMs, 600_000);
    const cases: [string | undefined, number][] = [[undefined, 600_000], ['', 600_000], ['0', 0], ['1500', 1500], ['abc', 600_000], ['-1', 600_000], ['2.7', 2], ['3000000000', 2_147_483_647]];
    for (const [v, want] of cases) assert.equal(backendIdleMs(v), want, String(v));
    // Loggraden vid tomgångsstoppet: minuter från en minut, annars sekunder.
    for (const [ms, text] of [[600_000, '10 min'], [90_000, '1,5 min'], [60_000, '1 min'], [300, '0,3 s'], [59_000, '59 s']] as const) {
      assert.equal(duration(ms), text, String(ms));
    }
    installWs(makeApp(t, registry, 'avila4', { 'server.mjs': IDLE }));
    const b = supervisor({ idleMs: 0 });
    assert.ok(await b.ensure('avila4'));
    await sleep(IDLE_MS * 3);
    assert.equal(b.state('avila4'), 'running');
    await b.stopAll();
  });
});

describe('ensure() medan backenden stoppas', { timeout: 60_000 }, () => {
  // Avslutas först en sekund efter SIGTERM (före SIGKILL efter 2 s), så att en förfrågan hinner komma medan stoppet pågår.
  const SLOW_EXIT = `
import http from 'node:http';
console.log('STARTED ' + process.pid);
process.on('SIGTERM', () => setTimeout(() => process.exit(0), 1000));
http.createServer((q, s) => s.end(String(process.pid))).listen(Number(process.env.PORT));
`;

  test('under ett uttryckligt stop() (deleteApp tar sedan bort appen) startas ingen ny process', async () => {
    makeApp(t, registry, 'astopp1', { 'server.mjs': SLOW_EXIT });
    const b = supervisor();
    assert.ok(await b.ensure('astopp1'));
    const [pid1] = pidsOf('astopp1');
    const stopping = b.stop('astopp1');
    await sleep(50);
    assert.ok(isAlive(pid1), 'stoppet pågår');
    const during = b.ensure('astopp1');
    await stopping;
    assert.equal(await during, null);
    await sleep(1000);
    assert.deepEqual(pidsOf('astopp1'), [pid1], 'ingen ny process efter stoppet');
    assert.ok(!isAlive(pid1));
    assert.equal(b.state('astopp1'), 'stopped');
    // När stoppet är klart startar nästa förfrågan backenden som vanligt.
    assert.ok(await b.ensure('astopp1'));
    assert.equal(pidsOf('astopp1').length, 2);
  });

  test('under tomgångsstoppet startas en ny process direkt efter stoppet', async () => {
    makeApp(t, registry, 'astopp2', { 'server.mjs': SLOW_EXIT });
    const b = supervisor({ idleMs: 300 });
    assert.ok(await b.ensure('astopp2'));
    const [pid1] = pidsOf('astopp2');
    await waitFor(() => notes('astopp2').some((l) => l.startsWith('Backenden stoppades efter')), 3000, 'tomgångsstoppet');
    assert.ok(isAlive(pid1), 'stoppet pågår');
    const port = await b.ensure('astopp2');
    const pids = pidsOf('astopp2');
    assert.ok(port !== null, notes('astopp2').join(' | '));
    assert.equal(pids.length, 2, 'en ny process, inte den som stoppas');
    assert.ok(!isAlive(pid1));
    assert.ok(isAlive(pids[1]));
  });
});

describe('färskhet: ensure() efter en ändring i backendens kod', { timeout: 60_000 }, () => {
  const version = (v: string): string =>
    `import http from 'node:http'; console.log('STARTED ' + process.pid); http.createServer((q, s) => s.end('${v} ' + process.pid)).listen(Number(process.env.PORT));\n`;

  test('en ändrad ingångsfil, package.json eller entry i manifestet ger en ny process genom omstartsvägen', async () => {
    const dir = makeApp(t, registry, 'afarsk1', { 'server.mjs': version('v1'), 'annan.mjs': version('annan') });
    const b = supervisor();
    const front = await workbench(b, 'afarsk1');
    const body = async (): Promise<string> => (await request(front.port, { path: '/api/x' })).body;
    try {
      assert.match(await body(), /^v1 \d+$/);
      assert.match(await body(), /^v1 \d+$/);
      assert.equal(pidsOf('afarsk1').length, 1, 'oförändrad kod: samma process');
      fs.writeFileSync(path.join(dir, 'server.mjs'), version('v2'));
      assert.match(await body(), /^v2 \d+$/);
      assert.equal(pidsOf('afarsk1').length, 2);
      fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"afarsk1"}\n');
      assert.match(await body(), /^v2 \d+$/);
      assert.equal(pidsOf('afarsk1').length, 3, 'package.json räknas');
      registry.manifests.set('afarsk1', { name: 'afarsk1', backend: { entry: 'annan.mjs' } });
      assert.match(await body(), /^annan \d+$/);
      assert.equal(pidsOf('afarsk1').length, 4);
      // Omstartsvägen, inte kraschvägen: ingen crashed, ingen schemalagd omstart, och en rad som säger varför.
      assert.ok(!registry.statesOf('afarsk1').includes('crashed'), registry.statesOf('afarsk1').join(','));
      assert.ok(!notes('afarsk1').some((l) => l.startsWith('Startar om backenden om')));
      assert.equal(notes('afarsk1').filter((l) => l === 'Backendens kod har ändrats sedan start: startar om.').length, 3);
      assert.equal(pidsOf('afarsk1').filter(isAlive).length, 1);
    } finally {
      await front.close();
      await b.stopAll();
    }
  });
});

/* ---------------------------- paketuppslaget och andra Node-versioner ---------------------------- */

// WB_TEST_NODE=/sökväg/till/node provar samma backends under ännu en Node: under Node 24 dog varje sandlådad backend
// av ERR_INVALID_PACKAGE_CONFIG på workbenchens package.json, och Node 26 är oprovad.
const NODES = [process.execPath, ...(process.env.WB_TEST_NODE ? [process.env.WB_TEST_NODE] : [])];

describe('paketuppslaget: backends utan egen package.json, i CommonJS och ESM', { timeout: 60_000 }, () => {
  const CJS = `const http = require('node:http'); const h = require('./lib/hjalp.js'); console.log('STARTED ' + process.pid); http.createServer((q, s) => s.end('cjs ' + h() + ' ' + process.version)).listen(Number(process.env.PORT));\n`;
  const ESM = `import http from 'node:http'; import { WebSocketServer } from 'ws'; import { h } from './lib/hjalp.js'; console.log('STARTED ' + process.pid); http.createServer((q, s) => s.end('esm ' + h() + ' ' + typeof WebSocketServer + ' ' + process.version)).listen(Number(process.env.PORT));\n`;
  for (const node of NODES) {
    const version = execFileSync(node, ['--version'], { encoding: 'utf8' }).trim();
    test(`${version}: apps/package.json stoppar uppslaget före workbenchens, och apparnas moduler tolkas som utan fil`, async () => {
      const tag = version.replace(/\W/g, '');
      const cjsId = `apkt${tag}c`;
      const esmId = `apkt${tag}e`;
      makeApp(t, registry, cjsId, { 'server.js': CJS, 'lib/hjalp.js': "module.exports = () => 'hjälp';\n" }, { name: cjsId, backend: { entry: 'server.js' } });
      installWs(makeApp(t, registry, esmId, { 'server.mjs': ESM, 'lib/hjalp.js': "export const h = () => 'hjälp';\n" }));
      const b = supervisor({ nodePath: node });
      const cjsFront = await workbench(b, cjsId);
      const esmFront = await workbench(b, esmId);
      const why = (id: string): string => [...notes(id), ...logs.of(id, 'backend')].join(' | ');
      try {
        assert.equal((await request(cjsFront.port, { path: '/api/x' })).body, `cjs hjälp ${version}`, why(cjsId));
        assert.equal((await request(esmFront.port, { path: '/api/x' })).body, `esm hjälp function ${version}`, why(esmId));
        assert.equal(JSON.parse(fs.readFileSync(path.join(t.paths.appsDir, 'package.json'), 'utf8')).type, undefined);
        // Profilen som supervisorn skrev läser gränsfilen; det syns oavsett Node-version (Node 25 tål att den saknas).
        const profile = fs.readFileSync(path.join(t.paths.appDataDir(cjsId), 'backend.sb'), 'utf8');
        assert.ok(profile.includes(`(literal ${sbplString(path.join(fs.realpathSync.native(t.paths.appsDir), 'package.json'))})`), profile);
        // Gränsfilen saknar "type", och varningen om det når inte loggen (kalibrerad i server-backends-sandbox.test.ts).
        assert.ok(!logs.of(esmId, 'backend').some((l) => l.includes('MODULE_TYPELESS_PACKAGE_JSON')), why(esmId));
      } finally {
        await cjsFront.close();
        await esmFront.close();
        await b.stopAll();
      }
    });
  }
});
