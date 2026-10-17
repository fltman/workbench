// tests/unit/server-store-registry.test.ts — registret (CONTRACT §6, §7, §7.4).
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEFAULT_FACES } from '../../shared/protocol.ts';
import type { ServerMsg, WindowState } from '../../shared/protocol.ts';
import { createAppGit } from '../../server/live/git.ts';
import { makePaths } from '../../server/paths.ts';
import { createRegistry, troubleLine } from '../../server/store/registry.ts';
import { createSceneStore } from '../../server/store/scene.ts';
import type { AppGit, Config, Hub, Paths, SceneStore } from '../../server/types.ts';
import { applyLeak, type Patch } from '../bridge-harness/leaks.ts';

const roots: string[] = [];
after(() => {
  for (const d of roots) fs.rmSync(d, { recursive: true, force: true });
});

function fakeHub(): Hub & { msgs: ServerMsg[]; types(): string[] } {
  const msgs: ServerMsg[] = [];
  return {
    msgs,
    broadcast(msg) {
      msgs.push(structuredClone(msg));
    },
    clients: () => 0,
    types: () => msgs.map((m) => m.t),
  };
}

function fakeGit(fail = false): AppGit & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async init(appId) {
      calls.push(`init ${appId}`);
      if (fail) throw new Error('git saknas');
    },
    async commitAll() {
      return false;
    },
    async undo() {
      return false;
    },
    async redo() {
      return false;
    },
    async canRedo() {
      return false;
    },
  };
}

interface World {
  home: string;
  paths: Paths;
  scene: SceneStore;
  hub: ReturnType<typeof fakeHub>;
  git: ReturnType<typeof fakeGit>;
}

function world(prepare?: (paths: Paths) => void, git = fakeGit()): World & { registry: ReturnType<typeof createRegistry> } {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'wb-registry-')));
  roots.push(home);
  const paths = makePaths({ home } as Config);
  prepare?.(paths);
  const scene = createSceneStore(paths);
  const hub = fakeHub();
  const registry = createRegistry({ paths, scene, hub, git });
  return { home, paths, scene, hub, git, registry };
}

async function quiet<T>(fn: () => T | Promise<T>): Promise<{ result: T; warnings: string[] }> {
  const warnings: string[] = [];
  const orig = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  };
  try {
    return { result: await fn(), warnings };
  } finally {
    console.warn = orig;
  }
}

const REQ = { x: 100.5, y: -40, w: 640, h: 480, scale: 1.25 };

/* ------------------------------ create ------------------------------ */

test('create: id, frö-filer, data/apps/<id>, git.init, fönster och AppInfo', async () => {
  const w = world();
  const t0 = Date.now();
  const { app, win } = await w.registry.create(REQ);
  assert.match(app.id, /^a[a-z0-9]{6}$/);
  assert.deepEqual(app, {
    id: app.id, name: '', faces: DEFAULT_FACES, permissions: [], built: false, status: 'idle', backend: 'none', rev: app.rev,
  });
  assert.ok(app.rev >= t0 && app.rev <= Date.now());
  assert.deepEqual(win, { id: `w-${app.id}`, appId: app.id, x: 100.5, y: -40, w: 640, h: 480, scale: 1.25, face: 0, z: 1 });

  const dir = w.paths.appDir(app.id);
  assert.equal(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), '/data/\nnode_modules/\n.DS_Store\n');
  assert.equal(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8'), `# ${app.id}\n\nInga anteckningar ännu.\n`);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['.gitignore', 'CLAUDE.md']);
  assert.ok(fs.statSync(w.paths.appDataDir(app.id)).isDirectory());
  assert.deepEqual(w.git.calls, [`init ${app.id}`]);

  assert.deepEqual(w.hub.types(), ['app', 'scene.window'], "sänder 'app' och sedan 'scene.window'");
  assert.deepEqual(w.hub.msgs[0], { t: 'app', app });
  assert.deepEqual(w.hub.msgs[1], { t: 'scene.window', win });
  assert.deepEqual(w.registry.get(app.id), app);
  assert.deepEqual(w.scene.window(app.id), win);
  const saved = JSON.parse(fs.readFileSync(w.paths.sceneFile, 'utf8'));
  assert.deepEqual(saved.windows, [win], 'fönstret är sparat direkt (flush)');
});

test('create: z = högsta + 1, och id:n är unika', async () => {
  const w = world();
  w.scene.upsertWindow({ id: 'w-a0000z5', appId: 'a0000z5', x: 0, y: 0, w: 300, h: 200, scale: 1, face: 0, z: 5 });
  w.scene.upsertWindow({ id: 'w-a0000z9', appId: 'a0000z9', x: 0, y: 0, w: 300, h: 200, scale: 1, face: 0, z: 9 });
  const a = await w.registry.create(REQ);
  const b = await w.registry.create(REQ);
  assert.equal(a.win.z, 10);
  assert.equal(b.win.z, 11);
  const ids = new Set<string>();
  for (let i = 0; i < 20; i++) ids.add((await w.registry.create(REQ)).app.id);
  assert.equal(ids.size, 20);
  assert.ok(!ids.has(a.app.id) && !ids.has(b.app.id));
});

test('create: ogiltig förfrågan avvisas utan att något skapas eller sänds', async () => {
  const w = world();
  const bad = [
    { ...REQ, w: 300.5 }, { ...REQ, w: 239 }, { ...REQ, h: 1601 }, { ...REQ, scale: 0 }, { ...REQ, scale: 21 },
    { ...REQ, x: Number.NaN }, { ...REQ, y: '1' }, null, 'rita',
  ];
  for (const req of bad) {
    await assert.rejects(w.registry.create(req as typeof REQ), /ogiltig förfrågan/, JSON.stringify(req));
  }
  assert.deepEqual(fs.readdirSync(w.paths.appsDir), []);
  assert.deepEqual(w.hub.types(), []);
  assert.deepEqual(w.git.calls, []);
});

test('create: misslyckas git.init tas de nya katalogerna bort och inget sänds', async () => {
  const w = world(undefined, fakeGit(true));
  await assert.rejects(w.registry.create(REQ), /git saknas/);
  assert.deepEqual(fs.readdirSync(w.paths.appsDir), []);
  assert.deepEqual(fs.readdirSync(path.join(w.paths.dataDir, 'apps')), []);
  assert.deepEqual(w.hub.types(), []);
  assert.deepEqual(w.registry.list(), []);
});

test('create med riktigt git: första commit "Ny app" med .gitignore och CLAUDE.md i data/apps/<id>/git', async () => {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'wb-registry-')));
  roots.push(home);
  const paths = makePaths({ home } as Config);
  const scene = createSceneStore(paths);
  const registry = createRegistry({ paths, scene, hub: fakeHub(), git: createAppGit(paths) });
  const { app } = await registry.create(REQ);
  const look = (...args: string[]) => execFileSync('git', [`--git-dir=${paths.appGitDir(app.id)}`, `--work-tree=${paths.appDir(app.id)}`, ...args], {
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }, encoding: 'utf8',
  }).trim();
  assert.equal(look('log', '--format=%s'), 'Ny app');
  assert.deepEqual(look('ls-files').split('\n'), ['.gitignore', 'CLAUDE.md']);
  assert.equal(fs.existsSync(path.join(paths.appDir(app.id), '.git')), false);
});

/* ------------------------------ remove ------------------------------ */

test("remove: båda katalogerna till data/trash/<id>-<tid>/ med strukturen kvar; 'scene.windowRemoved' före 'app.removed'", async () => {
  const w = world();
  const { app } = await w.registry.create(REQ);
  const dir = w.paths.appDir(app.id);
  fs.writeFileSync(path.join(dir, 'index.html'), '<p>Hej</p>');
  fs.mkdirSync(path.join(dir, 'data'));
  fs.writeFileSync(path.join(dir, 'data', 'store.json'), '{"a":1}');
  fs.writeFileSync(path.join(w.paths.appDataDir(app.id), 'chat.jsonl'), '{}\n');
  w.hub.msgs.length = 0;

  await w.registry.remove(app.id);

  assert.deepEqual(w.hub.msgs, [{ t: 'scene.windowRemoved', id: `w-${app.id}` }, { t: 'app.removed', appId: app.id }]);
  assert.equal(fs.existsSync(dir), false);
  assert.equal(fs.existsSync(w.paths.appDataDir(app.id)), false);
  const entries = fs.readdirSync(w.paths.trashDir);
  assert.equal(entries.length, 1);
  assert.match(entries[0], new RegExp(`^${app.id}-\\d{8}T\\d{6}\\.\\d{3}Z$`));
  const t = path.join(w.paths.trashDir, entries[0]);
  assert.equal(fs.readFileSync(path.join(t, 'apps', app.id, 'index.html'), 'utf8'), '<p>Hej</p>');
  assert.equal(fs.readFileSync(path.join(t, 'apps', app.id, 'data', 'store.json'), 'utf8'), '{"a":1}');
  assert.equal(fs.readFileSync(path.join(t, 'apps', app.id, 'CLAUDE.md'), 'utf8'), `# ${app.id}\n\nInga anteckningar ännu.\n`);
  assert.equal(fs.readFileSync(path.join(t, 'data', 'apps', app.id, 'chat.jsonl'), 'utf8'), '{}\n');

  assert.equal(w.registry.get(app.id), undefined);
  assert.deepEqual(w.registry.list(), []);
  assert.equal(w.scene.window(app.id), undefined);
  assert.deepEqual(JSON.parse(fs.readFileSync(w.paths.sceneFile, 'utf8')).windows, [], 'borttagningen är sparad');
  assert.throws(() => w.registry.manifest(app.id), /okänd app/);
});

test('remove: vägrar okända och ogiltiga id utan att röra något', async () => {
  const w = world();
  const { app } = await w.registry.create(REQ);
  w.hub.msgs.length = 0;
  for (const bad of ['a999999', '../x', '..%2F..%2Fx', 'A..', '', `${app.id}/..`]) {
    await assert.rejects(w.registry.remove(bad), /okänd app/, bad);
  }
  assert.deepEqual(w.hub.types(), []);
  assert.ok(fs.existsSync(w.paths.appDir(app.id)));
  assert.deepEqual(fs.readdirSync(w.paths.trashDir), []);
});

test('remove: två samtidiga anrop flyttar en gång; efteråt är appen okänd', async () => {
  const w = world();
  const { app } = await w.registry.create(REQ);
  w.hub.msgs.length = 0;
  await Promise.all([w.registry.remove(app.id), w.registry.remove(app.id)]);
  assert.deepEqual(w.hub.types(), ['scene.windowRemoved', 'app.removed']);
  assert.equal(fs.readdirSync(w.paths.trashDir).length, 1);
  await assert.rejects(w.registry.remove(app.id), /okänd app/);
});

test('ett id i papperskorgen eller med kvarglömd data återanvänds aldrig (det är appens origin och lagring) — kalibrerat', async () => {
  // Styrd slump: de sex första tecknen blir '0' (a000000), alla senare '1' (a111111).
  const orig = crypto.randomInt;
  let calls = 0;
  const steered = ((max: number) => {
    assert.equal(max, 36);
    return calls++ < 6 ? 26 : 27; // 'abcdefghijklmnopqrstuvwxyz0123456789'[26] = '0'
  }) as unknown as typeof crypto.randomInt;
  (crypto as { randomInt: typeof crypto.randomInt }).randomInt = steered;
  try {
    const plain = world();
    assert.equal((await plain.registry.create(REQ)).app.id, 'a000000', 'kalibrering: den styrda slumpen ger a000000');

    calls = 0;
    const trashed = world((paths) => fs.mkdirSync(path.join(paths.trashDir, 'a000000-20261016T000000.000Z')));
    assert.equal((await trashed.registry.create(REQ)).app.id, 'a111111', 'a000000 ligger i papperskorgen');

    calls = 0;
    const orphan = world((paths) => fs.mkdirSync(paths.appDataDir('a000000'), { recursive: true }));
    assert.equal((await orphan.registry.create(REQ)).app.id, 'a111111', 'data/apps/a000000 finns redan');
  } finally {
    (crypto as { randomInt: typeof crypto.randomInt }).randomInt = orig;
  }
});

/* ------------------------------ start (§7) ------------------------------ */

test('start: registrerar giltiga appmappar, tar bort fönster vars app saknas, status idle och rev = nu', async () => {
  const t0 = Date.now();
  const { result: w, warnings } = await quiet(() =>
    world((paths) => {
      const good = paths.appDir('a111111');
      fs.mkdirSync(good, { recursive: true });
      fs.writeFileSync(path.join(good, 'app.json'), JSON.stringify({ name: 'Mejl', backend: { entry: 'server.mjs' }, permissions: ['microphone'] }));
      fs.writeFileSync(path.join(good, 'index.html'), '<p>Hej</p>');
      fs.mkdirSync(path.join(paths.appsDir, 'Bad_Name'));
      fs.mkdirSync(path.join(paths.appsDir, 'x'));
      fs.writeFileSync(path.join(paths.appsDir, 'a333333'), 'en fil, ingen mapp');
      const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-elsewhere-'));
      roots.push(elsewhere);
      fs.symlinkSync(elsewhere, path.join(paths.appsDir, 'a222222'));
      const win = (appId: string, z: number): WindowState => ({ id: `w-${appId}`, appId, x: 0, y: 0, w: 640, h: 480, scale: 1, face: 0, z });
      fs.writeFileSync(paths.sceneFile, JSON.stringify({ version: 1, camera: { cx: 0, cy: 0, zoom: 1 }, windows: [win('a111111', 1), win('a999999', 2)] }));
    }),
  );
  assert.deepEqual(warnings, []);
  const apps = w.registry.list();
  assert.deepEqual(apps.map((a) => a.id), ['a111111']);
  const a = apps[0];
  assert.equal(a.name, 'Mejl');
  assert.equal(a.built, true);
  assert.equal(a.status, 'idle');
  assert.equal(a.backend, 'stopped');
  assert.deepEqual(a.permissions, ['microphone']);
  assert.ok(a.rev >= t0 && a.rev <= Date.now());
  assert.deepEqual(w.scene.get().windows.map((x) => x.appId), ['a111111'], 'fönstret för a999999 togs bort');
  assert.deepEqual(w.registry.manifest('a111111'), { name: 'Mejl', faces: DEFAULT_FACES, permissions: ['microphone'], backend: { entry: 'server.mjs' } });
  assert.deepEqual(w.hub.types(), [], 'start sänder ingenting (skalet får en snapshot)');
});

test('start: en app utan fönster får ett nytt till höger om de andra', async () => {
  const { result: w, warnings } = await quiet(() =>
    world((paths) => {
      for (const id of ['a111111', 'a444444', 'a555555']) fs.mkdirSync(paths.appDir(id), { recursive: true });
      const win: WindowState = { id: 'w-a111111', appId: 'a111111', x: 100, y: 50, w: 400, h: 300, scale: 2, face: 0, z: 3 };
      fs.writeFileSync(paths.sceneFile, JSON.stringify({ version: 1, camera: { cx: 0, cy: 0, zoom: 1 }, windows: [win] }));
    }),
  );
  assert.equal(warnings.length, 2);
  const wins = w.scene.get().windows;
  assert.deepEqual(wins.map((x) => [x.appId, x.x, x.y, x.w, x.h, x.scale, x.z]), [
    ['a111111', 100, 50, 400, 300, 2, 3],
    ['a444444', 980, 50, 640, 480, 1, 4],
    ['a555555', 1700, 50, 640, 480, 1, 5],
  ]);
});

/* ------------------------------ status, backend, rev, refresh ------------------------------ */

test("setStatus, setBackend och bumpRev sänder 'app' bara när något ändrats; okända id ignoreras", async () => {
  const w = world();
  const { app } = await w.registry.create(REQ);
  w.hub.msgs.length = 0;
  w.registry.setStatus(app.id, 'idle');
  w.registry.setBackend(app.id, 'none');
  assert.deepEqual(w.hub.types(), []);
  w.registry.setStatus(app.id, 'building');
  w.registry.setStatus(app.id, 'building');
  w.registry.setBackend(app.id, 'running');
  w.registry.setBackend(app.id, 'running');
  w.registry.setStatus(app.id, 'bogus' as 'idle');
  w.registry.setBackend(app.id, 'bogus' as 'none');
  assert.deepEqual(w.hub.msgs.map((m) => (m.t === 'app' ? [m.app.status, m.app.backend] : m.t)), [['building', 'none'], ['building', 'running']]);

  w.hub.msgs.length = 0;
  const r0 = w.registry.get(app.id)?.rev ?? 0;
  w.registry.bumpRev(app.id);
  w.registry.bumpRev(app.id);
  const revs = w.hub.msgs.map((m) => (m.t === 'app' ? m.app.rev : 0));
  assert.equal(revs.length, 2);
  assert.ok(revs[0] > r0 && revs[1] > revs[0], 'rev ökar strikt även inom samma millisekund');

  w.hub.msgs.length = 0;
  for (const bad of ['a999999', '../x']) {
    assert.doesNotThrow(() => {
      w.registry.setStatus(bad, 'error');
      w.registry.setBackend(bad, 'crashed');
      w.registry.bumpRev(bad);
      w.registry.refresh(bad);
    });
  }
  assert.deepEqual(w.hub.types(), []);
  assert.equal(w.registry.get('../x'), undefined);
  assert.throws(() => w.registry.manifest('a999999'), /okänd app/);
});

test("refresh: läser om app.json, sänder 'app' bara vid ändring; ogiltig JSON ger standardvärden och en varning", async () => {
  const w = world();
  const { app } = await w.registry.create(REQ);
  const dir = w.paths.appDir(app.id);
  w.hub.msgs.length = 0;

  w.registry.refresh(app.id);
  assert.deepEqual(w.hub.types(), [], 'inget ändrat');

  fs.writeFileSync(path.join(dir, 'app.json'), JSON.stringify({
    name: 'Kub', faces: [{ id: 'main', page: 'index.html' }, { id: 'sida2', page: 'sida2.html', label: 'Baksida' }], permissions: ['camera'],
  }));
  fs.writeFileSync(path.join(dir, 'index.html'), '<p>Hej</p>');
  w.registry.refresh(app.id);
  assert.equal(w.hub.msgs.length, 1);
  const msg = w.hub.msgs[0];
  assert.ok(msg.t === 'app');
  assert.equal(msg.app.name, 'Kub');
  assert.equal(msg.app.built, true);
  assert.deepEqual(msg.app.faces.map((f) => f.id), ['main', 'sida2']);
  assert.deepEqual(msg.app.permissions, ['camera']);
  assert.equal(msg.app.rev, app.rev, 'refresh ändrar inte rev');
  w.registry.refresh(app.id);
  assert.equal(w.hub.msgs.length, 1, 'samma innehåll: ingen ny sändning');

  fs.writeFileSync(path.join(dir, 'app.json'), '{ "name": "Kub", ');
  const { warnings } = await quiet(() => {
    w.registry.refresh(app.id);
    w.registry.refresh(app.id);
  });
  assert.equal(warnings.length, 1, 'en varning per nytt problem');
  assert.match(warnings[0], /inte giltig JSON/);
  const last = w.hub.msgs[w.hub.msgs.length - 1];
  assert.ok(last.t === 'app');
  assert.equal(last.app.name, '');
  assert.deepEqual(last.app.faces, DEFAULT_FACES);
  assert.equal(last.app.built, true, 'index.html finns fortfarande');
  assert.deepEqual(w.registry.manifest(app.id).faces, DEFAULT_FACES);
});

test('refresh och backend: none ↔ stopped följer manifestet; ett känt tillstånd behålls', async () => {
  const w = world();
  const { app } = await w.registry.create(REQ);
  const file = path.join(w.paths.appDir(app.id), 'app.json');
  fs.writeFileSync(file, JSON.stringify({ backend: { entry: 'server.mjs' } }));
  w.registry.refresh(app.id);
  assert.equal(w.registry.get(app.id)?.backend, 'stopped');
  w.registry.setBackend(app.id, 'running');
  w.registry.refresh(app.id);
  assert.equal(w.registry.get(app.id)?.backend, 'running');
  fs.writeFileSync(file, JSON.stringify({ name: 'Utan backend' }));
  w.registry.refresh(app.id);
  assert.equal(w.registry.get(app.id)?.backend, 'none');
});

test('get, list och manifest ger kopior', async () => {
  const w = world();
  const { app } = await w.registry.create(REQ);
  const got = w.registry.get(app.id);
  if (got) {
    got.status = 'error';
    got.faces.push({ id: 'x', page: 'x.html' });
  }
  w.registry.list()[0].name = 'ändrat';
  w.registry.manifest(app.id).faces.length = 0;
  assert.deepEqual(w.registry.get(app.id), app);
  assert.deepEqual(w.registry.manifest(app.id).faces, DEFAULT_FACES);
});

/* ------------------------------ felsignalen (§7.2) ------------------------------ */

/** En kopia av registry.ts med ett planterat fel (exakta textbyten), för kalibreringen av "sätter inget". */
const PLANTS = {
  /** Varje console.error räknas, inte bara ohanterade fel. */
  'every-error': [['const CONSOLE_TROUBLE = /^error: (Uncaught\\b.*)/;', 'const CONSOLE_TROUBLE = /^error: (.*)/;']],
  /** Varje rad på backendens stderr räknas. */
  'every-stderr': [['const STDERR_TROUBLE = /^\\s*\\[?(?:Uncaught\\s+)?(?:[A-Z][A-Za-z]*)?(?:Error|Exception|Rejection)\\b/;', 'const STDERR_TROUBLE = /(?:)/;']],
  /** Fel räknas även under en tur. */
  'any-status': [["if (!e || !e.info.built || e.info.status !== 'idle') return;", 'if (!e || !e.info.built) return;']],
  /** Sidans version (x-wb-rev) spelar ingen roll: den gamla iframen och skärmbildssidan räknas också. */
  'any-rev': [["      if (source === 'console' && rev !== e.info.rev) return;\n", '']],
} as const satisfies Record<string, readonly Patch[]>;

async function plantedRegistry(name: keyof typeof PLANTS): Promise<typeof createRegistry> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dir = path.join(here, '../../.scratch/registry-plants');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `registry-${name}-${process.pid}.ts`);
  roots.push(file);
  const orig = path.join(here, '../../server/store/registry.ts');
  // Varje relativ import pekar på originalets moduler, så att kopian tål en ny import i registry.ts.
  const src = applyLeak(fs.readFileSync(orig, 'utf8'), PLANTS[name])
    .replace(/(from\s+)'(\.{1,2}\/[^']+)'/g, (_, from: string, rel: string) => `${from}'${pathToFileURL(path.resolve(path.dirname(orig), rel)).href}'`);
  fs.writeFileSync(file, src);
  return ((await import(pathToFileURL(file).href)) as { createRegistry: typeof createRegistry }).createRegistry;
}

/** Ett register med en byggd app (status idle), utan något sänt. */
async function withBuiltApp(make: typeof createRegistry = createRegistry) {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'wb-registry-')));
  roots.push(home);
  const paths = makePaths({ home } as Config);
  const scene = createSceneStore(paths);
  const hub = fakeHub();
  const registry = make({ paths, scene, hub, git: fakeGit() });
  const { app } = await registry.create(REQ);
  fs.writeFileSync(path.join(paths.appDir(app.id), 'index.html'), '<p>Hej</p>');
  registry.refresh(app.id);
  hub.msgs.length = 0;
  /** En rad från en sida som laddade appens nuvarande version (x-wb-rev, §7.2). */
  const fromPage = (line: string, appId = app.id): void => registry.noteLog(appId, 'console', line, registry.get(appId)?.rev);
  return { registry, hub, paths, id: app.id, fromPage };
}

const UNCAUGHT = "error: Uncaught TypeError: Cannot read properties of null (reading 'x') ⏎     at tick (http://a1b2c3d.localhost:8220/index.html:12:5) ⏎     at index.html:20:1";
const UNCAUGHT_FIRST = "Uncaught TypeError: Cannot read properties of null (reading 'x')";
/** Det wb.js och handleLog skriver för ett vanligt console.error och en varning (inte ohanterade fel). */
const POLLING = ['error: Kunde inte hämta flödet: HTTP 503', 'error: TypeError: Failed to fetch', 'warn: Uncaught-liknande varning', 'log: Uncaught'];
/** Nodes egna varningar och vanlig text på stderr, och platsraderna före ett felnamn i en krasch. */
const STDERR_QUIET = [
  '(node:4242) [DEP0040] DeprecationWarning: The `punycode` module is deprecated. Please use a userland alternative instead.',
  '(Use `node --trace-deprecation ...` to show where the warning was created)',
  'Kunde inte ansluta till IMAP, försöker igen om 60 s',
  'file:///Users/x/apps/a1b2c3d/server.mjs:12',
  "    throw new Error('trasig');",
  '    at Server.<anonymous> (file:///Users/x/apps/a1b2c3d/server.mjs:12:11)',
  'Node.js v25.2.1',
  'Errors: 0',
];

test('felsignalen: ett ohanterat fel i en sida sätter trouble (första raden) och sänds en gång; bumpRev tar bort det', async () => {
  const { registry, hub, id, fromPage } = await withBuiltApp();
  fromPage(UNCAUGHT);
  fromPage('error: Uncaught (in promise) Error: avvisat ⏎     at x');
  fromPage(UNCAUGHT);
  assert.equal(registry.get(id)?.trouble, UNCAUGHT_FIRST);
  assert.deepEqual(hub.msgs.map((m) => (m.t === 'app' ? m.app.trouble : m.t)), [UNCAUGHT_FIRST], "en enda 'app' per fel efter turen");
  assert.deepEqual(registry.troubles(id), [UNCAUGHT_FIRST, 'Uncaught (in promise) Error: avvisat'], 'olika rader, utan dubbletter');
  assert.equal(registry.list()[0].trouble, UNCAUGHT_FIRST, 'med i snapshoten');
  registry.bumpRev(id);
  const last = hub.msgs.at(-1);
  assert.ok(last?.t === 'app');
  assert.equal('trouble' in last.app, false, 'ny version: borta i sändningen');
  assert.equal(registry.get(id)?.trouble, undefined);
  assert.deepEqual(registry.troubles(id), []);
});

test('felsignalen: texten kortas till 120 tecken, högst 5 rader sparas åt förslagen, och styrtecken tas bort', async () => {
  const { registry, id, fromPage } = await withBuiltApp();
  fromPage(`error: Uncaught Error: ${'å'.repeat(400)}`);
  const t = registry.get(id)?.trouble ?? '';
  assert.equal([...t].length, 120);
  assert.ok(t.startsWith('Uncaught Error: åå') && t.endsWith('…'));
  for (let i = 0; i < 9; i++) fromPage(`error: Uncaught Error: nr ${i}‮`);
  const lines = registry.troubles(id);
  assert.equal(lines.length, 5);
  assert.ok(lines.every((l) => [...l].length <= 300 && !l.includes('‮')), JSON.stringify(lines.map((l) => l.length)));
});

test('felsignalen: formattecken (Unicode Cf) blir mellanslag som riktningstecknen, också U+061C och tecken med noll bredd', () => {
  assert.equal(troubleLine('console', 'error: Uncaught Error: a\u061Cb\u200Bc\u2060d\u202Ee'), 'Uncaught Error: a b c d e');
  assert.equal(troubleLine('stderr', 'TypeError: \u00ADx\uFEFF'), 'TypeError: x');
});

test('felsignalen: turens slut tar bort trouble; under en tur, med status error och i en obyggd app sätts inget', async () => {
  const { registry, id, fromPage } = await withBuiltApp();
  registry.setStatus(id, 'building');
  fromPage(UNCAUGHT);
  registry.setStatus(id, 'waiting');
  registry.noteLog(id, 'stderr', 'Error: trasig');
  assert.equal(registry.get(id)?.trouble, undefined, 'under en tur');
  registry.setStatus(id, 'idle');
  assert.deepEqual(registry.troubles(id), [], 'felen under turen sparas inte heller');
  fromPage(UNCAUGHT);
  assert.equal(registry.get(id)?.trouble, UNCAUGHT_FIRST, 'kontroll: efter turen sätts det');
  registry.setStatus(id, 'building');
  assert.equal(registry.get(id)?.trouble, UNCAUGHT_FIRST, 'står kvar medan nästa tur pågår');
  registry.setStatus(id, 'error');
  assert.equal(registry.get(id)?.trouble, undefined, 'turens slut (även utan ny version) tar bort det');
  fromPage(UNCAUGHT);
  assert.equal(registry.get(id)?.trouble, undefined, 'status error: pricken är redan bärnstensfärgad');
  const { app: unbuilt } = await registry.create({ ...REQ, x: 2000 });
  fromPage(UNCAUGHT, unbuilt.id);
  assert.equal(registry.get(unbuilt.id)?.trouble, undefined, 'obyggd app');
  assert.doesNotThrow(() => {
    registry.noteLog('a999999', 'console', UNCAUGHT);
    registry.noteLog('../x', 'stderr', 'Error: x');
  });
  assert.deepEqual(registry.troubles('a999999'), []);
});

test('kalibrering: ett register som räknar fel även under en tur fälls', async () => {
  const { registry, id, fromPage } = await withBuiltApp(await plantedRegistry('any-status'));
  registry.setStatus(id, 'building');
  fromPage(UNCAUGHT);
  assert.equal(registry.get(id)?.trouble, UNCAUGHT_FIRST, 'testet ska fälla det planterade felet');
});

test('felsignalen: ett vanligt console.error, varningar och loggar sätter inget (en pollande app blir inte bärnstensfärgad)', async () => {
  const { registry, hub, id, fromPage } = await withBuiltApp();
  for (let i = 0; i < 3; i++) for (const line of POLLING) fromPage(line);
  assert.equal(registry.get(id)?.trouble, undefined);
  assert.deepEqual(registry.troubles(id), []);
  assert.deepEqual(hub.msgs, []);
});

test('kalibrering: ett register som räknar varje console.error fälls', async () => {
  const { registry, id, fromPage } = await withBuiltApp(await plantedRegistry('every-error'));
  for (const line of POLLING) fromPage(line);
  assert.equal(registry.get(id)?.trouble, 'Kunde inte hämta flödet: HTTP 503', 'testet ska fälla det planterade felet');
});

/** En sida som laddades före bumpRev (den gamla iframen under bytet, Claudes skärmbildssida) och en utan huvudet. */
function staleLines(registry: ReturnType<typeof createRegistry>, id: string): void {
  const old = registry.get(id)!.rev;
  registry.bumpRev(id);
  registry.noteLog(id, 'console', UNCAUGHT, old);
  registry.noteLog(id, 'console', 'error: Uncaught Error: utan version');
}

test('felsignalen: bara en sida som laddade nuvarande version räknas (x-wb-rev); den gamla sidan sätter inte tillbaka felet', async () => {
  const { registry, hub, id, fromPage } = await withBuiltApp();
  fromPage(UNCAUGHT);
  assert.equal(registry.get(id)?.trouble, UNCAUGHT_FIRST);
  staleLines(registry, id);
  assert.equal(registry.get(id)?.trouble, undefined, 'den rättade versionen får inte tillbaka felet');
  assert.deepEqual(registry.troubles(id), [], 'inte heller åt förslagen');
  assert.equal(hub.msgs.filter((m) => m.t === 'app' && m.app.trouble).length, 1, 'bara den första sändningen bar felet');
  // Kontroll i samma körning: en sida med den nya versionen sätter det.
  fromPage('error: Uncaught Error: ny bugg');
  assert.equal(registry.get(id)?.trouble, 'Uncaught Error: ny bugg');
});

test('kalibrering: ett register som inte ser på sidans version fälls', async () => {
  const { registry, id } = await withBuiltApp(await plantedRegistry('any-rev'));
  staleLines(registry, id);
  assert.equal(registry.get(id)?.trouble, UNCAUGHT_FIRST, 'testet ska fälla det planterade felet');
});

test('felsignalen från backenden (supervisorn lämnar raden bara vid en krasch, §9): en rad som börjar med ett felnamn räknas; Nodes varningar, vanlig text och platsrader inte', async () => {
  const { registry, id } = await withBuiltApp();
  for (const line of STDERR_QUIET) registry.noteLog(id, 'stderr', line);
  assert.equal(registry.get(id)?.trouble, undefined, JSON.stringify(registry.troubles(id)));
  const errors = [
    "Error: ENOENT: no such file or directory, open '/x/data/mejl.json'",
    'TypeError [ERR_INVALID_ARG_TYPE]: The "path" argument must be of type string. Received undefined',
    '[UnhandledPromiseRejection: This error originated either by throwing inside of an async function without a catch block.]',
    'SqliteError: no such table: mejl',
    '  Uncaught Exception: trasig',
  ];
  for (const line of errors) registry.noteLog(id, 'stderr', line);
  assert.equal(registry.get(id)?.trouble, errors[0]);
  assert.deepEqual(registry.troubles(id), [errors[0], errors[1], errors[2], errors[3], 'Uncaught Exception: trasig']);
});

test('kalibrering: ett register som räknar varje stderr-rad fälls', async () => {
  const { registry, id } = await withBuiltApp(await plantedRegistry('every-stderr'));
  for (const line of STDERR_QUIET) registry.noteLog(id, 'stderr', line);
  assert.ok(registry.get(id)?.trouble?.startsWith('(node:4242) [DEP0040]'), 'testet ska fälla det planterade felet');
});
