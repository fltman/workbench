// tests/unit/server-backends-escape.test.ts — kalibrerade flykttester för app-backends (CONTRACT §4.5, §9, §15).
//
// En riktig backend i en riktig appmapp under $HOME försöker (a) skriva utanför data/, (b) läsa
// utanför appen, (c) ansluta till workbenchens port (kanariet, en ledig port som står för den), (d) ansluta till
// unix-socketar och (e) lyssna på 0.0.0.0. Samma backend körs först utan sandlåda (planterad läcka:
// allt ska lyckas, annars kan testet inte se en flykt) och sedan med sandlåda (allt ska nekas med
// EPERM). Positiva kontroller (data/, TMPDIR, egen port, namnuppslagning) ska fungera i båda.
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import dns from 'node:dns';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { proxyHttp } from '../../server/backends/proxy.ts';
import { buildProfile, closedRoots, nodeReadDir } from '../../server/backends/sandbox.ts';
import { DEFAULT_OPTIONS, createBackends } from '../../server/backends/supervisor.ts';
import type { BackendOptions } from '../../server/backends/supervisor.ts';
import type { Config } from '../../server/types.ts';
import { testPortSpan } from '../ports.ts';
import {
  CANARY_PORT, ROOT, fakeLogs, fakeRegistry, frontServer, isAlive, listeners, makeApp, makeHome, request, sleep, waitFor,
} from './server-backends-harness.test.ts';
import type { FakeLogs, FakeRegistry, TestHome } from './server-backends-harness.test.ts';

const OPTIONS: Partial<BackendOptions> = { portBase: await testPortSpan(40), portSpan: 40 };
const HAS_SANDBOX = fs.existsSync('/usr/bin/sandbox-exec');

/**
 * En kort tillfällig katalog under den riktiga hemkatalogen (stängd i profilen, som Dockers och gpg-agents
 * socketar) för en unix-socket: en socketsökväg får vara högst 104 byte (sun_path), hur djupt repot än ligger.
 */
function homeSockDir(): string {
  return fs.mkdtempSync(path.join(fs.realpathSync.native(os.userInfo().homedir), 'Library', 'Caches', 'wb-sock-'));
}

/** Lyssnar på en unix-socket som bara stänger varje anslutning. */
async function sockServer(sockPath: string): Promise<net.Server> {
  const s = net.createServer((sock) => {
    sock.on('error', () => {});
    sock.end();
  });
  await new Promise<void>((resolve, reject) => {
    s.once('error', reject);
    s.listen(sockPath, resolve);
  });
  return s;
}

const PROBE_SERVER = String.raw`
import dns from 'node:dns';
import { fork } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const cfg = JSON.parse(fs.readFileSync('probe.json', 'utf8'));
const own = Number(process.env.PORT);
console.log('PID ' + process.pid);

const fsProbe = (f) => { try { f(); return 'ALLOWED'; } catch (e) { return 'BLOCKED ' + (e.code ?? e.message); } };
const connect = (opts) => new Promise((resolve) => {
  const s = net.connect(opts);
  const t = setTimeout(() => { s.destroy(); resolve('TIMEOUT'); }, 2000);
  s.on('connect', () => { clearTimeout(t); s.destroy(); resolve('ALLOWED'); });
  s.on('error', (e) => { clearTimeout(t); resolve('BLOCKED ' + e.code); });
});
const listenAddress = (...args) => new Promise((resolve) => {
  const s = net.createServer();
  s.on('error', (e) => resolve('ERROR ' + e.code));
  s.listen(...args, () => { const a = s.address(); resolve(a.address); s.close(); });
});

async function probe() {
  const r = {};
  r['a: skriva ../escape.txt'] = fsProbe(() => fs.writeFileSync('../escape.txt', 'x'));
  r['a: skriva i appens egen kod'] = fsProbe(() => fs.writeFileSync('server.mjs', '// skriven av backenden'));
  r['ok: skriva i data/'] = fsProbe(() => fs.writeFileSync(path.join(process.env.DATA_DIR, 'probe.txt'), 'x'));
  r['ok: skriva i TMPDIR'] = fsProbe(() => { const f = path.join(os.tmpdir(), 'wbprobe-' + process.pid); fs.writeFileSync(f, 'x'); fs.unlinkSync(f); });
  r['ok: TMPDIR är appens egen i data/'] = os.tmpdir().startsWith(process.env.DATA_DIR + '/') ? 'ALLOWED' : 'BLOCKED ' + os.tmpdir();
  r['b: läsa en annan apps fil i den delade TMPDIR'] = fsProbe(() => fs.readFileSync(cfg.sharedTmpFile));
  r['a: skriva i den delade TMPDIR'] = fsProbe(() => { const f = path.join(cfg.sharedTmp, 'wbprobe-' + process.pid); fs.writeFileSync(f, 'x'); fs.unlinkSync(f); });
  // Utanför de stängda rötterna: Node och Homebrew (npm run dev kör samma Node osandlådat), /Users/Shared.
  for (const [label, dir] of cfg.writeDirs) r['a: skriva i ' + label] = fsProbe(() => { const d = path.join(dir, '.wbprobe-' + process.pid); fs.mkdirSync(d); fs.rmdirSync(d); });
  // En hård länk i data/ skulle göra filen skrivbar via data/.
  for (const [label, file] of cfg.linkTargets) r['a: hård länk i data/ till ' + label] = fsProbe(() => { const l = path.join(process.env.DATA_DIR, 'lank-' + process.pid); fs.linkSync(file, l); fs.unlinkSync(l); });
  r['b: läsa en fil i /private/tmp'] = fsProbe(() => fs.readFileSync(cfg.privateTmpFile));
  // Användarens kataloger bredvid TMPDIR under /private/var/folders/<a>/<b>: andra programs cacher (C) och DARWIN_USER_DIR (0).
  if (cfg.userCacheFile) r['b: läsa en fil i DARWIN_USER_CACHE_DIR'] = fsProbe(() => fs.readFileSync(cfg.userCacheFile));
  if (cfg.userDir) r['b: lista DARWIN_USER_DIR'] = fsProbe(() => fs.readdirSync(cfg.userDir));
  r['b: läsa kanariefil utanför appen'] = fsProbe(() => fs.readFileSync(cfg.canary));
  r['b: läsa kanariefil med annat skiftläge'] = fsProbe(() => fs.readFileSync(cfg.canaryUpper));
  r['b: läsa via symbolisk länk i appen'] = fsProbe(() => fs.readFileSync('leak.txt'));
  r['b: läsa annan apps data'] = fsProbe(() => fs.readFileSync(cfg.otherSecret));
  r['b: läsa workbenchens data/apps/<id>'] = fsProbe(() => fs.readFileSync(cfg.workbenchData));
  r['b: lista hemkatalogen'] = fsProbe(() => fs.readdirSync(cfg.home));
  if (cfg.knownHosts) r['b: läsa ~/.ssh/known_hosts'] = fsProbe(() => fs.readFileSync(cfg.knownHosts).length);
  r['ok: läsa appens egna filer'] = fsProbe(() => fs.readFileSync('probe.json'));
  for (const host of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '0.0.0.0', 'localhost']) {
    r['c: ansluta ' + host + ':' + cfg.canaryPort] = await connect({ host, port: cfg.canaryPort });
  }
  if (cfg.otherPort) r['c: ansluta en annan apps backend'] = await connect({ host: '127.0.0.1', port: cfg.otherPort });
  r['ok: ansluta egen port'] = await connect({ host: '127.0.0.1', port: own });
  r['d: unix-socket i /private/tmp/cc-socks…'] = await connect({ path: cfg.ccSock });
  r['d: unix-socket via /tmp/cc-socks…'] = await connect({ path: cfg.ccSock.replace(/^\/private\/tmp\//, '/tmp/') });
  r['d: unix-socket under hemkatalogen'] = await connect({ path: cfg.homeSock });
  if (cfg.dnsName) r['ok: namnuppslagning'] = await new Promise((res) => dns.lookup(cfg.dnsName, (e) => res(e ? 'BLOCKED ' + e.code : 'ALLOWED')));
  r['ok: fork med IPC'] = await new Promise((res) => {
    fs.writeFileSync(path.join(process.env.DATA_DIR, 'barn.mjs'), "process.on('message', (m) => { process.send(m); process.exit(0); });");
    const c = fork(path.join(process.env.DATA_DIR, 'barn.mjs'));
    const t = setTimeout(() => { c.kill(); res('TIMEOUT'); }, 5000);
    c.on('message', (m) => { clearTimeout(t); res(m === 'hej' ? 'ALLOWED' : 'BLOCKED ' + m); });
    c.on('error', (e) => { clearTimeout(t); res('BLOCKED ' + e.code); });
    c.send('hej');
  });
  r['e: listen(PORT, "0.0.0.0")'] = server.address().address;
  r['e: listen(0, "0.0.0.0")'] = await listenAddress(0, '0.0.0.0');
  r['e: listen({ port: 0, host: "::" })'] = await listenAddress({ port: 0, host: '::' });
  r['e: listen(0)'] = await listenAddress(0);
  return r;
}

const server = http.createServer(async (req, res) => {
  if (req.url !== '/api/probe') { res.statusCode = 404; res.end(); return; }
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(await probe()));
});
server.listen(own, '0.0.0.0'); // (e): guard.mjs ska tvinga 127.0.0.1
`;

/** getconf DARWIN_USER_DIR och DARWIN_USER_CACHE_DIR (0 och C bredvid TMPDIR), som realpath; null om de inte finns. */
function darwinDir(name: string): string | null {
  try {
    return fs.realpathSync.native(execFileSync('/usr/bin/getconf', [name], { encoding: 'utf8' }).trim().replace(/\/+$/, ''));
  } catch {
    return null;
  }
}

const OTHER_SERVER = `
import http from 'node:http';
http.createServer((req, res) => res.end('annan app')).listen(Number(process.env.PORT));
`;

interface Env {
  t: TestHome;
  registry: FakeRegistry;
  logs: FakeLogs;
  ccDir: string;
  /** Katalogen med socketen under hemkatalogen (homeSockDir). */
  sockDir: string;
  dnsWorks: boolean;
  knownHosts: string | null;
  /** En fil som "en annan app" lämnat i den delade TMPDIR:en (SEC-3). */
  sharedTmpFile: string;
  /** En fil i /Users/Shared, eller null om katalogen inte är skrivbar. */
  sharedFile: string | null;
  /** En fil som "ett annat program" lämnat i DARWIN_USER_CACHE_DIR, eller null. */
  userCacheFile: string | null;
}

let env: Env;

/**
 * Kataloger utanför de stängda rötterna som en backend aldrig får skriva i (§9), bland dem som testanvändaren själv kan
 * skriva i: annars kan den planterade läckan inte visa något. Node-prefixet också via datavolymens sökväg, eftersom
 * /opt är en firmlink dit.
 */
function writableDirs(): [string, string][] {
  const prefix = path.dirname(path.dirname(fs.realpathSync.native(process.execPath)));
  const dirs: [string, string][] = [
    ['Node-prefixet', prefix],
    ['Node-prefixet via /System/Volumes/Data', '/System/Volumes/Data' + prefix],
    ['/opt/homebrew', '/opt/homebrew'],
    ['/usr/local', '/usr/local'],
    ['/Users/Shared', '/Users/Shared'],
    // Skrivbara för admin-gruppen: ett typsnitt i /Library/Fonts laddas av alla program (granskningen 17 oktober).
    ['/Library/Fonts', '/Library/Fonts'],
    ['/Library/Caches', '/Library/Caches'],
    ['/cores', '/cores'],
  ];
  const cache = darwinDir('DARWIN_USER_CACHE_DIR');
  if (cache) dirs.push(['DARWIN_USER_CACHE_DIR', cache]);
  return dirs.filter(([, d]) => {
    try {
      fs.accessSync(d, fs.constants.W_OK);
      return fs.statSync(d).isDirectory();
    } catch {
      return false;
    }
  });
}

/**
 * Filer att länka till från appens data/: i en stängd rot, i /Users/Shared och Node själv, de som ligger på samma volym
 * och ägs av testanvändaren (bara en sådan fil blir skrivbar genom länken).
 */
function linkTargets(appDir: string): [string, string][] {
  const dev = fs.statSync(appDir).dev;
  const files: [string, string | null][] = [
    ['kanariefilen', path.join(env.t.home, 'canary.txt')],
    ['en fil i /Users/Shared', env.sharedFile],
    ['en fil i Node-prefixet', fs.realpathSync.native(process.execPath)],
  ];
  return files.filter((f): f is [string, string] => {
    if (f[1] === null) return false;
    const st = fs.statSync(f[1]);
    return st.dev === dev && st.uid === process.getuid?.();
  });
}

function writeProbeConfig(appDir: string, extra: Record<string, unknown>): void {
  const home = env.t.home;
  fs.writeFileSync(
    path.join(appDir, 'probe.json'),
    JSON.stringify({
      canary: path.join(home, 'canary.txt'),
      canaryUpper: path.join(home, 'CANARY.TXT'),
      otherSecret: path.join(env.t.paths.appDir('aother1'), 'data', 'secret.txt'),
      workbenchData: path.join(env.t.paths.appDataDir('aprobe1'), 'chat.jsonl'),
      home: fs.realpathSync.native(os.userInfo().homedir),
      knownHosts: env.knownHosts,
      canaryPort: CANARY_PORT,
      ccSock: path.join(env.ccDir, 'x.sock'),
      homeSock: path.join(env.sockDir, 'agent.sock'),
      dnsName: env.dnsWorks ? 'example.com' : null,
      sharedTmp: fs.realpathSync.native(os.tmpdir()),
      sharedTmpFile: env.sharedTmpFile,
      privateTmpFile: path.join(env.ccDir, 'annan-app.txt'),
      userCacheFile: env.userCacheFile,
      userDir: darwinDir('DARWIN_USER_DIR'),
      writeDirs: writableDirs(),
      linkTargets: linkTargets(appDir),
      ...extra,
    }),
  );
}

async function runProbe(config: Config, extra: Record<string, unknown> = {}): Promise<{ results: Record<string, string>; pid: number; port: number }> {
  const backends = createBackends({ config, paths: env.t.paths, registry: env.registry, logs: env.logs }, OPTIONS);
  try {
    const otherPort = await backends.ensure('aother1');
    assert.ok(otherPort, 'den andra appens backend startade inte');
    writeProbeConfig(env.t.paths.appDir('aprobe1'), { otherPort, ...extra });
    const port = await backends.ensure('aprobe1');
    assert.ok(port, `probe-backenden startade inte: ${env.logs.tail('aprobe1').join(' | ')}`);
    const front = await frontServer((req, res) => proxyHttp(req, res, port));
    try {
      const r = await request(front.port, { path: '/api/probe', headers: { host: `aprobe1.localhost:${CANARY_PORT}` } });
      assert.equal(r.status, 200, r.body);
      const pid = Number(env.logs.of('aprobe1', 'backend').filter((l) => l.startsWith('PID ')).at(-1)?.slice(4));
      // Oberoende kontroll av (e): allt i processgruppen lyssnar på loopback.
      const rows = await listeners({ pgid: pid });
      assert.ok(rows.length > 0 && rows.every((row) => row.name.startsWith('127.0.0.1:')), JSON.stringify(rows));
      return { results: JSON.parse(r.body) as Record<string, string>, pid, port };
    } finally {
      await front.close();
    }
  } finally {
    await backends.stopAll();
  }
}

const isEscape = (key: string): boolean => /^[abcd]: /.test(key);

/** Sparar resultatmatrisen som bevis (.scratch är ignorerad av git). */
function evidence(name: string, data: unknown): void {
  const dir = path.join(ROOT, '.scratch', 'server-backends', 'evidence');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), JSON.stringify(data, null, 2) + '\n');
}

describe('flykttester för app-backends', { skip: !HAS_SANDBOX, timeout: 60_000 }, () => {
  // Det before() hunnit öppna och skapa, så att after() städar även när before() fallerar halvvägs.
  const servers: net.Server[] = [];
  const leftovers: string[] = [];

  before(async () => {
    const t = makeHome('escape-home');
    leftovers.push(t.home);
    const registry = fakeRegistry();
    const logs = fakeLogs();
    fs.writeFileSync(path.join(t.home, 'canary.txt'), 'KANARIE-' + crypto.randomBytes(8).toString('hex'));
    makeApp(t, registry, 'aother1', { 'server.mjs': OTHER_SERVER, 'data/secret.txt': 'annan apps hemlighet' });
    const probeDir = makeApp(t, registry, 'aprobe1', { 'server.mjs': PROBE_SERVER });
    fs.symlinkSync(path.join(t.home, 'canary.txt'), path.join(probeDir, 'leak.txt'));
    fs.writeFileSync(path.join(t.paths.appDataDir('aprobe1'), 'chat.jsonl'), '{"k":"note"}\n');

    // Kanariet: workbenchens port på både 127.0.0.1 och ::1, som servern lyssnar (§3).
    for (const host of ['127.0.0.1', '::1']) {
      const s = net.createServer((sock) => {
        sock.on('error', () => {});
        sock.end('kanariet');
      });
      await new Promise<void>((resolve, reject) => {
        s.once('error', reject);
        s.listen({ port: CANARY_PORT, host, ipv6Only: host === '::1' }, resolve);
      });
      servers.push(s);
    }
    // En unix-socket där Claude Code har sina inkorgar, och en under hemkatalogen (som Docker och gpg-agent).
    const ccDir = `/private/tmp/cc-socks-wbtest-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
    fs.mkdirSync(ccDir, { mode: 0o700 });
    leftovers.push(ccDir);
    const sockDir = homeSockDir();
    leftovers.push(sockDir);
    for (const sockPath of [path.join(ccDir, 'x.sock'), path.join(sockDir, 'agent.sock')]) servers.push(await sockServer(sockPath));
    const dnsWorks = await new Promise<boolean>((resolve) => dns.lookup('example.com', (e) => resolve(!e)));
    const kh = path.join(os.userInfo().homedir, '.ssh', 'known_hosts');
    // Det en annan app (eller ett annat program) lämnar i delade tillfälliga kataloger (SEC-3).
    const sharedTmpFile = path.join(fs.realpathSync.native(os.tmpdir()), `wbtest-annan-app-${process.pid}-${crypto.randomBytes(3).toString('hex')}.txt`);
    leftovers.push(sharedTmpFile);
    fs.writeFileSync(sharedTmpFile, 'FRAN-X');
    fs.writeFileSync(path.join(ccDir, 'annan-app.txt'), 'FRAN-X');
    let sharedFile: string | null = path.join('/Users/Shared', `wbtest-${process.pid}-${crypto.randomBytes(3).toString('hex')}.txt`);
    try {
      fs.writeFileSync(sharedFile, 'FRAN-X');
      leftovers.push(sharedFile);
    } catch {
      sharedFile = null;
    }
    const cacheDir = darwinDir('DARWIN_USER_CACHE_DIR');
    let userCacheFile: string | null = cacheDir && path.join(cacheDir, `wbtest-annat-program-${process.pid}-${crypto.randomBytes(3).toString('hex')}.txt`);
    try {
      if (userCacheFile) fs.writeFileSync(userCacheFile, 'FRAN-X');
      if (userCacheFile) leftovers.push(userCacheFile);
    } catch {
      userCacheFile = null;
    }
    env = { t, registry, logs, ccDir, sockDir, dnsWorks, knownHosts: fs.existsSync(kh) ? kh : null, sharedTmpFile, sharedFile, userCacheFile };
  }, { timeout: 30_000 });

  after(async () => {
    await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
    for (const p of leftovers) fs.rmSync(p, { recursive: true, force: true });
  }, { timeout: 30_000 });

  test('utan sandlåda lyckas varje flykt (planterad läcka), och (e) tvingas ändå till loopback', async () => {
    const { results } = await runProbe({ ...env.t.config, sandbox: false });
    evidence('escape-sandbox-off.json', results);
    const escapes = Object.entries(results).filter(([k]) => isEscape(k));
    assert.ok(escapes.length >= 15, `för få flyktförsök: ${escapes.length}`);
    for (const [label] of writableDirs()) assert.ok(`a: skriva i ${label}` in results, label);
    for (const [label] of linkTargets(env.t.paths.appDir('aprobe1'))) assert.ok(`a: hård länk i data/ till ${label}` in results, label);
    for (const [key, value] of Object.entries(results)) {
      if (key.startsWith('e: ')) assert.equal(value, '127.0.0.1', key);
      else assert.equal(value, 'ALLOWED', key);
    }
    assert.ok(fs.existsSync(path.join(env.t.paths.appsDir, 'escape.txt')), 'läckan syntes inte på disk');
    assert.ok(env.logs.of('aprobe1', 'workbench').some((l) => l.includes('körs utan sandlåda')));
    // Återställ det läckan ändrade.
    fs.rmSync(path.join(env.t.paths.appsDir, 'escape.txt'));
    fs.writeFileSync(path.join(env.t.paths.appDir('aprobe1'), 'server.mjs'), PROBE_SERVER);
  });

  test('med sandlåda nekas varje flykt med EPERM, medan data/, TMPDIR, egen port och DNS fungerar', async () => {
    const before = fs.readFileSync(path.join(env.t.paths.appDir('aprobe1'), 'server.mjs'), 'utf8');
    const { results } = await runProbe(env.t.config);
    evidence('escape-sandbox-on.json', results);
    for (const [key, value] of Object.entries(results)) {
      if (key.startsWith('e: ')) assert.equal(value, '127.0.0.1', key);
      else if (key.startsWith('ok: ')) assert.equal(value, 'ALLOWED', key);
      else assert.equal(value, 'BLOCKED EPERM', key);
    }
    assert.ok(!fs.existsSync(path.join(env.t.paths.appsDir, 'escape.txt')));
    assert.equal(fs.readFileSync(path.join(env.t.paths.appDir('aprobe1'), 'server.mjs'), 'utf8'), before);
    assert.ok(fs.existsSync(path.join(env.t.paths.appDir('aprobe1'), 'data', 'probe.txt')));
    // Utan nät saknas nyckeln (namnuppslagningen kan då inte provas åt något håll).
    assert.equal('ok: namnuppslagning' in results, env.dnsWorks);
  });

  test('HMR-porten nekas lika väl som workbenchens port; utan regeln når sandlådan kanariet', async () => {
    const asHmr = await runProbe({ ...env.t.config, port: 18497, hmrPort: CANARY_PORT });
    assert.equal(asHmr.results[`c: ansluta 127.0.0.1:${CANARY_PORT}`], 'BLOCKED EPERM');
    assert.equal(asHmr.results[`c: ansluta ::ffff:127.0.0.1:${CANARY_PORT}`], 'BLOCKED EPERM');
    // Kontroll: varken port eller hmrPort är kanariet, så då är det regeln (och inget annat) som stoppar.
    const neither = await runProbe({ ...env.t.config, port: 18497, hmrPort: 18496 });
    assert.equal(neither.results[`c: ansluta 127.0.0.1:${CANARY_PORT}`], 'ALLOWED');
    assert.equal(neither.results['a: skriva ../escape.txt'], 'BLOCKED EPERM');
  });
});

/* ---------- avvikelserna från kontraktets profil, mätta mot kontraktets egen form ---------- */

describe('kontraktets regler ordagrant har hål som profilen stänger', { skip: !HAS_SANDBOX, timeout: 60_000 }, () => {
  const dir = path.join(ROOT, '.scratch', 'server-backends', `escape-forms-${process.pid}`);
  const servers: net.Server[] = [];
  const leftovers: string[] = [dir];
  let app = '';
  let input: Parameters<typeof buildProfile>[0];

  before(async () => {
    fs.rmSync(dir, { recursive: true, force: true });
    app = path.join(dir, 'apps', 'aforms1');
    fs.mkdirSync(path.join(app, 'data'), { recursive: true });
    const ccDir = `/private/tmp/cc-socks-wbtest-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
    fs.mkdirSync(ccDir, { mode: 0o700 });
    leftovers.push(ccDir);
    const sockDir = homeSockDir();
    leftovers.push(sockDir);
    const homeSock = path.join(sockDir, 'agent.sock');
    fs.writeFileSync(
      path.join(app, 'main.mjs'),
      `import net from 'node:net';
const connect = (o) => new Promise((r) => { const s = net.connect(o); s.on('connect', () => { s.destroy(); r('ALLOWED'); }); s.on('error', (e) => r('BLOCKED ' + e.code)); });
console.log(JSON.stringify({
  v4mapped: await connect({ host: '::ffff:127.0.0.1', port: ${CANARY_PORT} }),
  loopback: await connect({ host: '127.0.0.1', port: ${CANARY_PORT} }),
  homeSock: await connect({ path: ${JSON.stringify(homeSock)} }),
  ccSock: await connect({ path: ${JSON.stringify(path.join(ccDir, 'x.sock'))} }),
}));`,
    );
    const tcp = net.createServer((s) => {
      s.on('error', () => {});
      s.end();
    });
    await new Promise<void>((resolve, reject) => {
      tcp.once('error', reject);
      tcp.listen(CANARY_PORT, '127.0.0.1', resolve);
    });
    servers.push(tcp);
    for (const p of [homeSock, path.join(ccDir, 'x.sock')]) servers.push(await sockServer(p));
    const home = fs.realpathSync.native(os.userInfo().homedir);
    const wbHome = fs.realpathSync.native(dir);
    input = {
      home,
      workbenchHome: wbHome,
      appDir: fs.realpathSync.native(app),
      tmpDir: fs.realpathSync.native(os.tmpdir()),
      guardFile: fs.realpathSync.native(path.join(ROOT, 'server', 'backends', 'guard.mjs')),
      nodeDir: nodeReadDir(process.execPath, closedRoots(home, wbHome)),
      deniedPorts: [CANARY_PORT],
    };
  }, { timeout: 30_000 });

  after(async () => {
    await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
    for (const p of leftovers) fs.rmSync(p, { recursive: true, force: true });
  }, { timeout: 30_000 });

  const runWith = (profile: string): Promise<Record<string, string>> => {
    const file = path.join(dir, `p-${crypto.randomBytes(4).toString('hex')}.sb`);
    fs.writeFileSync(file, profile);
    return new Promise((resolve, reject) => {
      execFile(
        '/usr/bin/sandbox-exec',
        ['-f', file, process.execPath, `--import=${pathToFileURL(input.guardFile).href}`, '--', 'main.mjs'],
        { cwd: app, timeout: 15_000 },
        (err, stdout, stderr) => {
          if (err) reject(new Error(String(stderr) || err.message));
          else resolve(JSON.parse(String(stdout)) as Record<string, string>);
        },
      );
    });
  };

  test('localhost:<port> släpper igenom ::ffff:127.0.0.1; *:<port> gör det inte', async () => {
    const ours = buildProfile(input);
    const contractForm = ours.replace(`(remote ip "*:${CANARY_PORT}")`, `(remote ip "localhost:${CANARY_PORT}")`);
    assert.notEqual(contractForm, ours);
    const hole = await runWith(contractForm);
    assert.equal(hole.loopback, 'BLOCKED EPERM', 'kontraktets form stoppar 127.0.0.1');
    assert.equal(hole.v4mapped, 'ALLOWED', 'hålet syns: IPv4-mappad IPv6 går igenom');
    const closed = await runWith(ours);
    assert.equal(closed.loopback, 'BLOCKED EPERM');
    assert.equal(closed.v4mapped, 'BLOCKED EPERM');
  });

  test('kontraktets cc-socks-regel lämnar andra unix-socketar öppna; den blanka nekningen stänger alla', async () => {
    const ours = buildProfile(input);
    // Kontraktets ursprungliga form: bara cc-socks nekas, resten är öppet via (allow default).
    const contractForm = ours
      .split('\n')
      .filter((l) => l !== '(deny network-outbound (remote unix-socket))' && !l.includes('mDNSResponder'))
      .join('\n') + `\n(deny network-outbound (remote unix-socket (path-prefix "/private/tmp/cc-socks")))\n`;
    assert.notEqual(contractForm, ours);
    const hole = await runWith(contractForm);
    assert.equal(hole.ccSock, 'BLOCKED EPERM');
    assert.equal(hole.homeSock, 'ALLOWED', 'hålet syns: en socket under hemkatalogen går att nå');
    const closed = await runWith(ours);
    assert.equal(closed.ccSock, 'BLOCKED EPERM');
    assert.equal(closed.homeSock, 'BLOCKED EPERM');
  });
});

/* ---------------- lsof fångar det guard.mjs inte kan (planterad läcka) ---------------- */

const LEAK_SERVER = `
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
console.log('PID ' + process.pid);
const mode = fs.readFileSync('mode.txt', 'utf8').trim();
if (mode === 'child') {
  // Ett barn utan guard.mjs (som python -m http.server) lyssnar på alla gränssnitt. Utan NODE_OPTIONS, annars laddar det vakten.
  const child = spawn(process.execPath, ['-e', 'require("net").createServer().listen(0, "0.0.0.0", () => console.log("LYSSNAR"))'], { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, NODE_OPTIONS: '' } });
  console.log('BARN ' + child.pid);
  await new Promise((r) => child.stdout.once('data', r));
} else {
  // Förbi den lappade listen() i samma process.
  net.createServer()._listen2('0.0.0.0', 0, 4, 511);
}
http.createServer((req, res) => res.end('ok')).listen(Number(process.env.PORT));
`;

describe('lsof efter redo: lyssnar något i processgruppen utanför loopback stoppas backenden', { skip: !HAS_SANDBOX, timeout: 60_000 }, () => {
  let t: TestHome;
  let registry: FakeRegistry;
  let logs: FakeLogs;
  before(() => {
    t = makeHome('escape-lsof');
    registry = fakeRegistry();
    logs = fakeLogs();
    makeApp(t, registry, 'aleak1', { 'server.mjs': LEAK_SERVER, 'mode.txt': 'child' });
  });
  after(() => fs.rmSync(t.home, { recursive: true, force: true }));
  const pidOf = (prefix: string): number => Number(logs.of('aleak1', 'backend').filter((l) => l.startsWith(prefix)).at(-1)?.slice(prefix.length));

  test('kalibrering: med kontrollen avslagen lyssnar barnet faktiskt på alla gränssnitt', async () => {
    const backends = createBackends({ config: t.config, paths: t.paths, registry, logs }, { ...OPTIONS, lsof: '/saknas/lsof' });
    try {
      const port = await backends.ensure('aleak1');
      assert.ok(port);
      const rows = await listeners({ pgid: pidOf('PID ') });
      assert.ok(rows.some((r) => r.pid === pidOf('BARN ') && !r.name.startsWith('127.')), `läckan syns inte: ${JSON.stringify(rows)}`);
      assert.ok(logs.of('aleak1', 'workbench').some((l) => l.includes('/saknas/lsof gick inte att köra')));
    } finally {
      await backends.stopAll();
    }
    // Barnet dör av processgruppens signal men städas undan först av launchd; under last tar det en stund.
    await waitFor(() => !isAlive(pidOf('BARN ')), 3000, 'barnet överlevde stopAll');
  });

  for (const mode of ['child', 'inprocess'] as const) {
    test(`ett ${mode === 'child' ? 'barn' : 'handtag i samma process'} på 0.0.0.0 stoppar backenden: crashed tills restart`, async () => {
      fs.writeFileSync(path.join(t.paths.appDir('aleak1'), 'mode.txt'), mode);
      const backends = createBackends({ config: t.config, paths: t.paths, registry, logs }, OPTIONS);
      try {
        const before = logs.lines.length;
        assert.equal(await backends.ensure('aleak1'), null);
        assert.equal(backends.state('aleak1'), 'crashed');
        const notes = logs.lines.slice(before).filter((l) => l.source === 'workbench').map((l) => l.line);
        assert.ok(notes.some((l) => /lyssnade på (\*|0\.0\.0\.0):\d+.*stoppades/.test(l)), notes.join(' | '));
        assert.ok(!isAlive(pidOf('PID ')), 'backenden lever');
        // Barnet städas undan av launchd efter gruppens signal; under last (flera körningar samtidigt) tar det en stund.
        if (mode === 'child') await waitFor(() => !isAlive(pidOf('BARN ')), 3000, 'att barnet dör');
        // ingen automatisk omstart, och ensure() startar inte om den
        await sleep(300);
        assert.equal(await backends.ensure('aleak1'), null);
        assert.ok(!logs.lines.slice(before).some((l) => l.line.startsWith('Startar om')));
      } finally {
        await backends.stopAll();
      }
    });
  }
});

/* ---------------- lsof under drift: en lyssnare som öppnas senare (planterad läcka) ---------------- */

const LATE_LEAK_SERVER = `
import http from 'node:http';
import net from 'node:net';
console.log('PID ' + process.pid);
http.createServer((req, res) => res.end('ok')).listen(Number(process.env.PORT), () => {
  // En stund efter redo: ett handtag förbi den lappade listen(), som ett barn utan vakten.
  setTimeout(() => { net.createServer()._listen2('0.0.0.0', 0, 4, 511); console.log('LÄCKER'); }, 400);
});
`;

describe('lsof under drift: en lyssnare utanför loopback som öppnas senare stoppar också backenden', { skip: !HAS_SANDBOX, timeout: 60_000 }, () => {
  let t: TestHome;
  let registry: FakeRegistry;
  let logs: FakeLogs;
  before(() => {
    t = makeHome('escape-late');
    registry = fakeRegistry();
    logs = fakeLogs();
    makeApp(t, registry, 'asen1', { 'server.mjs': LATE_LEAK_SERVER });
  });
  after(() => fs.rmSync(t.home, { recursive: true, force: true }));
  const pid = (): number => Number(logs.of('asen1', 'backend').filter((l) => l.startsWith('PID ')).at(-1)?.slice(4));

  test('kalibrering: utan upprepad kontroll lyssnar backenden kvar på alla gränssnitt', async () => {
    const backends = createBackends({ config: t.config, paths: t.paths, registry, logs }, { ...OPTIONS, listenCheckMs: 0 });
    try {
      assert.ok(await backends.ensure('asen1'));
      await waitFor(() => logs.of('asen1', 'backend').includes('LÄCKER'), 4000, 'läckan');
      await sleep(600);
      assert.equal(backends.state('asen1'), 'running');
      const rows = await listeners({ pgid: pid() });
      assert.ok(rows.some((r) => !r.name.startsWith('127.')), `läckan syns inte: ${JSON.stringify(rows)}`);
    } finally {
      await backends.stopAll();
    }
  });

  test('kontrollen körs om medan backenden kör (standard var 30:e sekund): crashed tills restart', async () => {
    const backends = createBackends({ config: t.config, paths: t.paths, registry, logs }, { ...OPTIONS, listenCheckMs: 200 });
    try {
      const before = logs.lines.length;
      assert.ok(await backends.ensure('asen1'));
      assert.equal(backends.state('asen1'), 'running');
      await waitFor(() => backends.state('asen1') === 'crashed', 4000, 'att backenden stoppas');
      const notes = logs.lines.slice(before).filter((l) => l.source === 'workbench').map((l) => l.line);
      assert.ok(notes.some((l) => /lyssnade på (\*|0\.0\.0\.0):\d+.*stoppades/.test(l)), notes.join(' | '));
      await waitFor(() => !isAlive(pid()), 3000, 'att backenden dör');
      await sleep(300);
      assert.equal(await backends.ensure('asen1'), null);
      assert.ok(!logs.lines.slice(before).some((l) => l.line.startsWith('Startar om')));
    } finally {
      await backends.stopAll();
    }
    assert.equal(DEFAULT_OPTIONS.listenCheckMs, 30_000);
  });
});
