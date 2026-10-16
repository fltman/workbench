// tests/unit/server-store-scene.test.ts — scenen i data/workbench.json (CONTRACT §5).
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { makePaths } from '../../server/paths.ts';
import { cameraError, createSceneStore, windowError } from '../../server/store/scene.ts';
import type { Config, Paths } from '../../server/types.ts';
import type { WindowState } from '../../shared/protocol.ts';

const roots: string[] = [];
function setup(): Paths {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'wb-scene-')));
  roots.push(home);
  return makePaths({ home } as Config);
}
after(() => {
  for (const d of roots) fs.rmSync(d, { recursive: true, force: true });
});

function win(appId: string, over: Partial<WindowState> = {}): WindowState {
  return { id: `w-${appId}`, appId, x: 10, y: 20, w: 640, h: 480, scale: 1, face: 0, z: 1, ...over };
}

/** Tysta och fånga console.warn under fn. */
async function captureWarnings<T>(fn: () => T | Promise<T>): Promise<{ result: T; warnings: string[] }> {
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

const TMP_RE = /\.tmp\.\d+\.[0-9a-f]+$/;

test('saknad fil ger en ny, tom scen', () => {
  const paths = setup();
  const scene = createSceneStore(paths);
  assert.deepEqual(scene.get(), { version: 1, camera: { cx: 0, cy: 0, zoom: 1 }, windows: [] });
});

test('trasig fil ger en ny scen och sparas undan bredvid', async () => {
  const paths = setup();
  fs.writeFileSync(paths.sceneFile, '{"version": 1, "windows": [');
  const { result: scene, warnings } = await captureWarnings(() => createSceneStore(paths));
  assert.deepEqual(scene.get().windows, []);
  const backups = fs.readdirSync(paths.dataDir).filter((f) => f.startsWith('workbench.json.corrupt-'));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(paths.dataDir, backups[0]), 'utf8'), '{"version": 1, "windows": [');
  assert.equal(warnings.length, 1);
});

test('en annan version än 1 räknas som trasig', async () => {
  const paths = setup();
  fs.writeFileSync(paths.sceneFile, JSON.stringify({ version: 2, camera: { cx: 1, cy: 1, zoom: 1 }, windows: [win('a000001')] }));
  const { result: scene } = await captureWarnings(() => createSceneStore(paths));
  assert.deepEqual(scene.get().windows, []);
});

test('ogiltiga fönster hoppas över vid inläsning; ett fönster per app; ogiltig kamera blir standard', async () => {
  const paths = setup();
  const windows = [
    win('a000001'),
    win('a000002', { w: 300.5 }),
    win('a000003', { w: 100 }),
    win('a000004', { h: 2000 }),
    win('a000005', { scale: 0.01 }),
    win('a000006', { scale: 25 }),
    win('a000007', { face: 6 }),
    win('a000008', { face: -1 }),
    win('a000009', { z: -1 }),
    win('a000010', { z: 1.5 }),
    { ...win('a000011'), id: 'w-a999999' },
    win('A000012'),
    win('a000001', { x: 999 }), // samma app en gång till
    win('a000013', { x: 5, y: 6, w: 240, h: 160, scale: 0.05, face: 5, z: 7 }),
  ];
  fs.writeFileSync(paths.sceneFile, JSON.stringify({ version: 1, camera: { cx: 0, cy: 0, zoom: 100 }, windows }));
  const { result: scene, warnings } = await captureWarnings(() => createSceneStore(paths));
  assert.deepEqual(scene.get().windows.map((w) => [w.appId, w.x]), [['a000001', 10], ['a000013', 5]]);
  assert.deepEqual(scene.get().camera, { cx: 0, cy: 0, zoom: 1 });
  assert.equal(warnings.length, 11);
});

test('windowError: gränserna i §5', () => {
  assert.equal(windowError(win('a000001')), null);
  for (const ok of [{ w: 240 }, { w: 2400 }, { h: 160 }, { h: 1600 }, { scale: 0.05 }, { scale: 20 }, { face: 5 }, { x: -1e6, y: 3.25 }]) {
    assert.equal(windowError(win('a000001', ok)), null, JSON.stringify(ok));
  }
  const bad: Partial<WindowState>[] = [
    { w: 239 }, { w: 2401 }, { w: 640.5 }, { h: 159 }, { h: 1601 }, { h: 480.25 },
    { scale: 0.0499 }, { scale: 20.01 }, { scale: Number.NaN }, { face: 6 }, { face: 0.5 },
    { x: Number.POSITIVE_INFINITY }, { y: Number.NaN }, { z: -1 }, { z: 2.5 },
  ];
  for (const b of bad) assert.match(windowError(win('a000001', b)) ?? '', /./, JSON.stringify(b));
  assert.match(windowError(null) ?? '', /objekt/);
  assert.match(windowError([]) ?? '', /objekt/);
  assert.match(windowError({ ...win('a000001'), id: 'a000001' }) ?? '', /"w-"/);
  assert.match(windowError(win('../x')) ?? '', /app-id/);
  assert.match(windowError(win('a000001', { w: 640.5 })) ?? '', /w måste vara ett heltal mellan 240 och 2400/);
});

test('minimerat fönster (§10.7): minimized saknas eller är ett heltal, sparas och tas bort när fönstret tas fram', async () => {
  for (const ok of [{ minimized: 0 }, { minimized: 1792130000000 }]) assert.equal(windowError(win('a000001', ok)), null, JSON.stringify(ok));
  for (const b of [{ minimized: -1 }, { minimized: 1.5 }, { minimized: Number.NaN }, { minimized: '1' as unknown as number }, { minimized: null as unknown as number }]) {
    assert.match(windowError(win('a000001', b)) ?? '', /minimized/, JSON.stringify(b));
  }
  const paths = setup();
  const scene = createSceneStore(paths);
  scene.upsertWindow(win('a000001', { minimized: 1792130000000 }));
  assert.equal(scene.window('a000001')?.minimized, 1792130000000, 'sparas');
  assert.deepEqual(Object.keys(scene.window('a000001') ?? {}).at(-1), 'minimized');
  scene.upsertWindow(win('a000001'));
  assert.equal('minimized' in (scene.window('a000001') ?? {}), false, 'borta när fönstret tas fram');
});

test('cameraError: zoom 0,05–8 och ändliga tal', () => {
  assert.equal(cameraError({ cx: 1, cy: -2, zoom: 0.05 }), null);
  assert.equal(cameraError({ cx: 1, cy: -2, zoom: 8 }), null);
  for (const bad of [{ cx: 0, cy: 0, zoom: 0.04 }, { cx: 0, cy: 0, zoom: 8.1 }, { cx: Number.NaN, cy: 0, zoom: 1 }, { cx: '1', cy: 0, zoom: 1 }, null]) {
    assert.notEqual(cameraError(bad), null, JSON.stringify(bad));
  }
});

test('upsertWindow och setCamera vägrar ogiltiga värden med fel på svenska och sparar ingenting', async () => {
  const paths = setup();
  const scene = createSceneStore(paths);
  assert.throws(() => scene.upsertWindow(win('a000001', { w: 300.5 })), /ogiltigt fönster: w måste vara ett heltal/);
  assert.throws(() => scene.upsertWindow(win('a000001', { scale: 21 })), /scale måste ligga mellan/);
  assert.throws(() => scene.setCamera({ cx: 0, cy: 0, zoom: 9 }), /ogiltig kamera: zoom/);
  await sleep(300);
  assert.equal(fs.existsSync(paths.sceneFile), false);
  assert.deepEqual(scene.get().windows, []);
});

test('bara kända fält sparas, och get/window ger kopior', async () => {
  const paths = setup();
  const scene = createSceneStore(paths);
  scene.upsertWindow({ ...win('a000001'), evil: '<img src=x onerror=alert(1)>' } as WindowState);
  assert.deepEqual(Object.keys(scene.window('a000001') ?? {}), ['id', 'appId', 'x', 'y', 'w', 'h', 'scale', 'face', 'z']);
  const copy = scene.get();
  copy.windows[0].x = 12345;
  copy.camera.zoom = 7;
  const single = scene.window('a000001');
  if (single) single.y = 999;
  assert.equal(scene.window('a000001')?.x, 10);
  assert.equal(scene.window('a000001')?.y, 20);
  assert.equal(scene.get().camera.zoom, 1);
  await scene.flush();
  assert.equal(fs.readFileSync(paths.sceneFile, 'utf8').includes('evil'), false);
});

test('debouncat: ändringar inom 200 ms blir en enda skrivning med det sista läget', async () => {
  const paths = setup();
  const scene = createSceneStore(paths);
  const renames: string[] = [];
  const orig = fs.promises.rename;
  fs.promises.rename = (async (from: fs.PathLike, to: fs.PathLike) => {
    if (String(to) === paths.sceneFile) renames.push(String(from));
    return orig(from, to);
  }) as typeof fs.promises.rename;
  try {
    for (let i = 0; i < 5; i++) scene.upsertWindow(win('a000001', { x: i }));
    scene.setCamera({ cx: 3, cy: 4, zoom: 2 });
    await sleep(100);
    assert.equal(fs.existsSync(paths.sceneFile), false, 'inget skrivet efter 100 ms');
    await sleep(350);
    assert.equal(renames.length, 1, 'exakt en skrivning');
    assert.match(path.basename(renames[0]), TMP_RE, 'via en tillfällig fil <fil>.tmp.<pid>.<hex>');
    const saved = JSON.parse(fs.readFileSync(paths.sceneFile, 'utf8'));
    assert.equal(saved.windows[0].x, 4);
    assert.deepEqual(saved.camera, { cx: 3, cy: 4, zoom: 2 });
  } finally {
    fs.promises.rename = orig;
  }
});

test('atomisk skrivning (tmp + rename), kalibrerad mot en skrivning på plats', async () => {
  const paths = setup();
  const scene = createSceneStore(paths);
  scene.upsertWindow(win('a000001'));
  await scene.flush();
  const observer = `${paths.sceneFile}.observer`;
  fs.linkSync(paths.sceneFile, observer); // samma inod som den sparade filen

  // Kalibrering: en skrivning på plats syns genom den hårda länken.
  fs.writeFileSync(paths.sceneFile, 'PÅ PLATS');
  assert.equal(fs.readFileSync(observer, 'utf8'), 'PÅ PLATS', 'kalibrering: detektorn ser skrivningar på plats');

  scene.upsertWindow(win('a000002', { z: 2 }));
  await scene.flush();
  assert.equal(fs.readFileSync(observer, 'utf8'), 'PÅ PLATS', 'den gamla inoden rördes inte: filen byttes med rename');
  assert.notEqual(fs.statSync(paths.sceneFile).ino, fs.statSync(observer).ino);
  const saved = JSON.parse(fs.readFileSync(paths.sceneFile, 'utf8'));
  assert.deepEqual(saved.windows.map((w: WindowState) => w.appId), ['a000001', 'a000002']);
  assert.deepEqual(fs.readdirSync(paths.dataDir).filter((f) => TMP_RE.test(f)), [], 'inga tillfälliga filer kvar');
  assert.equal(fs.statSync(paths.sceneFile).mode & 0o777, 0o600);
});

test('flush skriver direkt; en ny butik läser tillbaka samma scen', async () => {
  const paths = setup();
  const scene = createSceneStore(paths);
  scene.upsertWindow(win('a000001', { x: -50.5, y: 1e6, w: 2400, h: 160, scale: 19.5, face: 3, z: 9 }));
  scene.setCamera({ cx: -10, cy: 20.25, zoom: 0.5 });
  await scene.flush();
  assert.ok(fs.existsSync(paths.sceneFile), 'skrivet utan att vänta på debouncen');
  assert.deepEqual(createSceneStore(paths).get(), scene.get());
});

test('removeWindowForApp tar bort och returnerar fönstret, och sparar', async () => {
  const paths = setup();
  const scene = createSceneStore(paths);
  scene.upsertWindow(win('a000001'));
  scene.upsertWindow(win('a000002', { z: 2 }));
  assert.deepEqual(scene.removeWindowForApp('a000001'), win('a000001'));
  assert.equal(scene.removeWindowForApp('a000001'), undefined);
  assert.equal(scene.window('a000001'), undefined);
  await scene.flush();
  assert.deepEqual(createSceneStore(paths).get().windows.map((w) => w.appId), ['a000002']);
});
