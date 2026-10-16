// tests/unit/server-store-watcher.test.ts — bevakaren (CONTRACT §7.3), med riktig fs.watch och falska registry/sessions.
// Varje "inget händer" kalibreras i samma test: en vanlig ändring direkt efteråt ger ett anrop, så bevakaren levde.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { AppInfo } from '../../shared/protocol.ts';
import { createAppGit } from '../../server/live/git.ts';
import { isIgnoredPath, watchApps } from '../../server/live/watcher.ts';
import { makePaths } from '../../server/paths.ts';
import type { AppRegistry, Config, Paths } from '../../server/types.ts';

const roots: string[] = [];
const stops: (() => void)[] = [];
after(() => {
  for (const s of stops) s();
  for (const d of roots) fs.rmSync(d, { recursive: true, force: true });
});

function fakeRegistry(ids: string[]) {
  const apps = new Set(ids);
  const calls: string[] = [];
  const registry = {
    list: () => [...apps].map((id) => ({ id }) as AppInfo),
    get: (id: string) => (apps.has(id) ? ({ id } as AppInfo) : undefined),
    refresh: (id: string) => {
      calls.push(`refresh ${id}`);
    },
    bumpRev: (id: string) => {
      calls.push(`bumpRev ${id}`);
    },
  } as unknown as AppRegistry;
  return { apps, calls, registry };
}

function setup(ids: string[]): { paths: Paths; busy: Set<string>; reg: ReturnType<typeof fakeRegistry>; stop: () => void } {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'wb-watch-')));
  roots.push(home);
  const paths = makePaths({ home } as Config);
  for (const id of ids) fs.mkdirSync(paths.appDir(id), { recursive: true });
  const busy = new Set<string>();
  const reg = fakeRegistry(ids);
  const stop = watchApps({ paths, registry: reg.registry, sessions: { busy: (id) => busy.has(id) } });
  stops.push(stop);
  return { paths, busy, reg, stop };
}

async function waitFor(cond: () => boolean, ms = 2000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(20);
  }
  return cond();
}

const ID = 'a000001';
const PAIR = [`refresh ${ID}`, `bumpRev ${ID}`];
/** Längre än debouncen (200 ms) plus FSEvents fördröjning (uppmätt 5–25 ms), med marginal. */
const QUIET_MS = 700;

test('isIgnoredPath: node_modules/, data/ (första segmentet), .git/, .DS_Store och <namn>.tmp.<pid>.<hex>', () => {
  for (const p of ['node_modules', 'node_modules/p/index.js', 'sub/node_modules/x.js', 'Node_Modules/x', 'data', 'data/store.json',
    'Data/secrets.json', '.git/HEAD', 'sub/.git/config', '.DS_Store', 'sub/.DS_Store', 'index.html.tmp.40567.0aabc40cad1a',
    'sub/app.json.tmp.1.ff']) {
    assert.equal(isIgnoredPath(p), true, p);
  }
  for (const p of ['index.html', 'app.json', 'sub/data/x.json', 'data.json', 'mydata/x', 'index.tmp.html', 'x.tmp.12.zz',
    'CLAUDE.md', 'server.mjs', 'a000001']) {
    assert.equal(isIgnoredPath(p), false, p);
  }
});

test('en manuell ändring ger refresh och sedan bumpRev, en gång per skur (debouncat)', async () => {
  const { paths, reg } = setup([ID]);
  await sleep(100);
  const dir = paths.appDir(ID);
  for (let i = 0; i < 10; i++) {
    fs.writeFileSync(path.join(dir, 'index.html'), `<p>${i}</p>`);
    await sleep(10);
  }
  assert.ok(await waitFor(() => reg.calls.length >= 2), 'refresh och bumpRev kom');
  await sleep(QUIET_MS);
  assert.deepEqual(reg.calls, PAIR, 'exakt ett par, refresh före bumpRev');
});

test('tillfälliga filer, data/, node_modules/, .git/ och .DS_Store ignoreras (kalibrerat)', async () => {
  const { paths, reg } = setup([ID]);
  await sleep(100);
  const dir = paths.appDir(ID);
  fs.writeFileSync(path.join(dir, 'index.html.tmp.12345.0aabc40cad1a'), 'tmp');
  fs.mkdirSync(path.join(dir, 'data'));
  fs.writeFileSync(path.join(dir, 'data', 'store.json'), '{}');
  fs.writeFileSync(path.join(dir, 'data', 'store.json.tmp.999.abc'), '{}');
  fs.mkdirSync(path.join(dir, 'node_modules', 'p'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'p', 'index.js'), '1');
  fs.mkdirSync(path.join(dir, '.git'));
  fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: x');
  fs.writeFileSync(path.join(dir, '.DS_Store'), 'x');
  fs.unlinkSync(path.join(dir, 'index.html.tmp.12345.0aabc40cad1a'));
  await sleep(QUIET_MS);
  assert.deepEqual(reg.calls, [], 'inget anrop för ignorerade sökvägar');

  fs.writeFileSync(path.join(dir, 'index.html'), '<p>Hej</p>'); // kalibrering
  assert.ok(await waitFor(() => reg.calls.length >= 2), 'kalibrering: bevakaren levde hela tiden');
  assert.deepEqual(reg.calls, PAIR);
});

test('händelser från före starten och om appmappen själv ignoreras (kalibrerat mot en rå fs.watch)', async (t) => {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'wb-watch-')));
  roots.push(home);
  const paths = makePaths({ home } as Config);
  const dir = paths.appDir(ID);
  // Som registry.create: mappen och frö-filerna skrivs, och bevakningen börjar strax efter.
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.gitignore'), 'data/\n');
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# x\n');
  const raw: string[] = [];
  const rawWatcher = fs.watch(dir, { recursive: true }, (_type, name) => raw.push(String(name)));
  const reg = fakeRegistry([ID]);
  stops.push(watchApps({ paths, registry: reg.registry, sessions: { busy: () => false } }));
  await sleep(QUIET_MS);
  rawWatcher.close();
  if (raw.length === 0) {
    t.skip('FSEvents levererade inga gamla händelser den här gången, så det finns inget att kalibrera mot');
    return;
  }
  assert.deepEqual(reg.calls, [], `de gamla händelserna (${raw.join(', ')}) gav inget anrop`);
  fs.writeFileSync(path.join(dir, 'index.html'), 'x');
  assert.ok(await waitFor(() => reg.calls.length >= 2), 'kalibrering: en ny ändring ger ett anrop');
  assert.deepEqual(reg.calls, PAIR);
});

test('gör ingenting medan sessions.busy (kalibrerat)', async () => {
  const { paths, reg, busy } = setup([ID]);
  await sleep(100);
  const dir = paths.appDir(ID);
  busy.add(ID);
  fs.writeFileSync(path.join(dir, 'index.html'), '<p>Claude skriver</p>');
  fs.writeFileSync(path.join(dir, 'app.json'), '{}');
  await sleep(QUIET_MS);
  assert.deepEqual(reg.calls, [], 'inget anrop under en tur');

  busy.delete(ID);
  fs.writeFileSync(path.join(dir, 'index.html'), '<p>Användaren skriver</p>'); // kalibrering
  assert.ok(await waitFor(() => reg.calls.length >= 2), 'kalibrering: utan tur laddas appen om');
  assert.deepEqual(reg.calls, PAIR);
});

test('blir appen upptagen under debouncen görs ingenting (kalibrerat)', async () => {
  const { paths, reg, busy } = setup([ID]);
  await sleep(100);
  const index = path.join(paths.appDir(ID), 'index.html');
  fs.writeFileSync(index, '<p>0</p>'); // kalibrering: samma ändring utan tur ger ett anrop
  assert.ok(await waitFor(() => reg.calls.length >= 2));
  await sleep(QUIET_MS);
  reg.calls.length = 0;

  fs.writeFileSync(index, '<p>1</p>');
  await sleep(60); // händelsen har kommit, debouncen väntar
  busy.add(ID);
  await sleep(QUIET_MS);
  assert.deepEqual(reg.calls, []);
});

test('ångra (git reset --hard) laddar inte om via bevakaren; ångra-flödet gör det självt (kalibrerat)', async () => {
  const { paths, reg } = setup([ID]);
  const git = createAppGit(paths);
  await git.init(ID);
  await sleep(100);
  const dir = paths.appDir(ID);
  // Kalibrering: samma filer ändrade för hand ger ett anrop.
  fs.writeFileSync(path.join(dir, 'index.html'), 'v1');
  fs.writeFileSync(path.join(dir, 'ny.js'), 'x');
  assert.ok(await waitFor(() => reg.calls.length >= 2), 'kalibrering: ändringarna syns för bevakaren');
  assert.equal(await git.commitAll(ID, 'tur'), true);
  await sleep(QUIET_MS);
  reg.calls.length = 0;

  assert.equal(await git.undo(ID), true); // tar bort index.html och ny.js
  assert.equal(fs.existsSync(path.join(dir, 'ny.js')), false);
  await sleep(QUIET_MS);
  assert.deepEqual(reg.calls, [], 'git:s egen omskrivning är ingen manuell ändring');

  fs.writeFileSync(path.join(dir, 'index.html'), 'för hand'); // efter fönstret laddar en manuell ändring om igen
  assert.ok(await waitFor(() => reg.calls.length >= 2), 'bevakaren lever efter ångra');
  assert.deepEqual(reg.calls, PAIR);
});

test('appar som skapas senare börjar bevakas, borttagna slutar (kalibrerat)', async () => {
  const { paths, reg } = setup([]);
  const later = 'a000002';
  fs.mkdirSync(paths.appDir(later), { recursive: true });
  reg.apps.add(later);
  await sleep(1300); // registret läses om varje sekund
  fs.writeFileSync(path.join(paths.appDir(later), 'index.html'), 'x');
  assert.ok(await waitFor(() => reg.calls.length >= 2), 'en ny app bevakas');
  assert.deepEqual(reg.calls, [`refresh ${later}`, `bumpRev ${later}`]);

  reg.calls.length = 0;
  reg.apps.delete(later);
  await sleep(1300);
  fs.writeFileSync(path.join(paths.appDir(later), 'index.html'), 'y');
  await sleep(QUIET_MS);
  assert.deepEqual(reg.calls, [], 'en borttagen app bevakas inte längre');
});

test('appmappen flyttas till papperskorgen: inget anrop för en app som inte längre finns i registret (kalibrerat)', async () => {
  const { paths, reg } = setup([ID]);
  await sleep(100);
  fs.writeFileSync(path.join(paths.appDir(ID), 'index.html'), 'x'); // kalibrering
  assert.ok(await waitFor(() => reg.calls.length >= 2));
  await sleep(QUIET_MS);
  reg.calls.length = 0;

  reg.apps.delete(ID); // som registry.remove: appen avregistreras ...
  fs.renameSync(paths.appDir(ID), path.join(paths.trashDir, `${ID}-x`)); // ... och mappen flyttas
  await sleep(QUIET_MS);
  assert.deepEqual(reg.calls, []);
});

test('den returnerade funktionen stänger allt (kalibrerat)', async () => {
  const { paths, reg, stop } = setup([ID]);
  await sleep(100);
  fs.writeFileSync(path.join(paths.appDir(ID), 'index.html'), 'w'); // kalibrering
  assert.ok(await waitFor(() => reg.calls.length >= 2));
  await sleep(QUIET_MS);
  reg.calls.length = 0;

  stop();
  fs.writeFileSync(path.join(paths.appDir(ID), 'index.html'), 'x');
  await sleep(QUIET_MS);
  assert.deepEqual(reg.calls, []);
});
