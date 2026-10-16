// server/store/scene.ts — scenen i data/workbench.json (CONTRACT §5).
// Servern äger filen. Den läses en gång vid start (saknad eller trasig fil ger en ny, tom scen; en trasig fil
// sparas undan bredvid), varje fönster valideras, och ändringar skrivs atomiskt (tmp + rename) högst 200 ms
// efter första osparade ändringen. flush() skriver direkt och väntar in pågående skrivningar.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { APP_ID_RE } from '../../shared/protocol.ts';
import type { Camera, Scene, WindowState } from '../../shared/protocol.ts';
import type { Paths, SceneStore } from '../types.ts';

/** Gränserna i §5 (fönster) och §10.2 (kamerans zoom). */
export const LIMITS = {
  wMin: 240,
  wMax: 2400,
  hMin: 160,
  hMax: 1600,
  scaleMin: 0.05,
  scaleMax: 20,
  zoomMin: 0.05,
  zoomMax: 8,
  faces: 6,
  coord: 1e9, // rimlighetsgräns för världskoordinater
} as const;

const SAVE_DELAY_MS = 200;
const DEFAULT_CAMERA: Camera = { cx: 0, cy: 0, zoom: 1 };

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function finite(v: unknown, limit = LIMITS.coord): v is number {
  return typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= limit;
}

function intIn(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
}

/** Varför fönstret är ogiltigt (på svenska), eller null om det är giltigt. */
export function windowError(win: unknown): string | null {
  if (!isObject(win)) return 'fönstret måste vara ett objekt';
  const { id, appId, x, y, w, h, scale, face, z, minimized } = win;
  if (typeof appId !== 'string' || !APP_ID_RE.test(appId)) return 'ogiltigt app-id i fönstret';
  if (id !== `w-${appId}`) return 'fönstrets id måste vara "w-" + appens id';
  if (!finite(x) || !finite(y)) return 'x och y måste vara ändliga tal';
  if (!intIn(w, LIMITS.wMin, LIMITS.wMax)) return `w måste vara ett heltal mellan ${LIMITS.wMin} och ${LIMITS.wMax}`;
  if (!intIn(h, LIMITS.hMin, LIMITS.hMax)) return `h måste vara ett heltal mellan ${LIMITS.hMin} och ${LIMITS.hMax}`;
  if (!finite(scale) || scale < LIMITS.scaleMin || scale > LIMITS.scaleMax) {
    return `scale måste ligga mellan ${LIMITS.scaleMin} och ${LIMITS.scaleMax}`;
  }
  if (!intIn(face, 0, LIMITS.faces - 1)) return `face måste vara ett heltal mellan 0 och ${LIMITS.faces - 1}`;
  if (!intIn(z, 0, Number.MAX_SAFE_INTEGER)) return 'z måste vara ett heltal som inte är negativt';
  if (minimized !== undefined && !intIn(minimized, 0, Number.MAX_SAFE_INTEGER)) return 'minimized måste saknas eller vara ett heltal som inte är negativt';
  return null;
}

/** Varför kameran är ogiltig (på svenska), eller null om den är giltig. */
export function cameraError(camera: unknown): string | null {
  if (!isObject(camera)) return 'kameran måste vara ett objekt';
  const { cx, cy, zoom } = camera;
  if (!finite(cx) || !finite(cy)) return 'cx och cy måste vara ändliga tal';
  if (!finite(zoom) || zoom < LIMITS.zoomMin || zoom > LIMITS.zoomMax) {
    return `zoom måste ligga mellan ${LIMITS.zoomMin} och ${LIMITS.zoomMax}`;
  }
  return null;
}

/** Bara de kända fälten, i fast ordning. Anroparen har redan validerat. */
function cleanWindow(win: WindowState): WindowState {
  const { id, appId, x, y, w, h, scale, face, z, minimized } = win;
  return minimized === undefined ? { id, appId, x, y, w, h, scale, face, z } : { id, appId, x, y, w, h, scale, face, z, minimized };
}

function cleanCamera(camera: Camera): Camera {
  return { cx: camera.cx, cy: camera.cy, zoom: camera.zoom };
}

/** Skriv en fil atomiskt: en tillfällig fil <fil>.tmp.<pid>.<hex> i samma katalog, fsync, sedan rename. */
export async function writeFileAtomic(file: string, data: string, mode = 0o600): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}.${crypto.randomBytes(6).toString('hex')}`;
  const fh = await fs.promises.open(tmp, 'wx', mode);
  try {
    await fh.writeFile(data, 'utf8');
    await fh.sync();
  } catch (err) {
    await fh.close().catch(() => {});
    await fs.promises.unlink(tmp).catch(() => {});
    throw err;
  }
  await fh.close();
  try {
    await fs.promises.rename(tmp, file);
  } catch (err) {
    await fs.promises.unlink(tmp).catch(() => {});
    throw err;
  }
}

function freshScene(): Scene {
  return { version: 1, camera: { ...DEFAULT_CAMERA }, windows: [] };
}

/** Basformat enligt ISO 8601 (inga kolon, som Finder visar som snedstreck), t.ex. 20261016T123456.789Z. */
function isoStamp(d = new Date()): string {
  return d.toISOString().replace(/[-:]/g, '');
}

/** Läs scenen. Ogiltiga fönster hoppas över; en oläslig fil sparas undan som workbench.json.corrupt-<tid>. */
function loadScene(file: string): Scene {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(`[scene] kunde inte läsa ${file}: ${String(err)}`);
    return freshScene();
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    raw = undefined;
  }
  if (!isObject(raw) || raw.version !== 1) {
    const backup = `${file}.corrupt-${isoStamp()}`;
    try {
      fs.copyFileSync(file, backup);
      console.warn(`[scene] ${file} gick inte att tolka; sparad som ${backup}, börjar med en tom scen`);
    } catch (err) {
      console.warn(`[scene] ${file} gick inte att tolka och kunde inte sparas undan: ${String(err)}`);
    }
    return freshScene();
  }
  const camera = cameraError(raw.camera) ? { ...DEFAULT_CAMERA } : cleanCamera(raw.camera as Camera);
  const windows: WindowState[] = [];
  const seen = new Set<string>();
  for (const w of Array.isArray(raw.windows) ? raw.windows : []) {
    const err = windowError(w);
    if (err) {
      console.warn(`[scene] hoppar över ogiltigt fönster: ${err}`);
      continue;
    }
    const win = w as WindowState;
    if (seen.has(win.appId)) continue; // ett fönster per app
    seen.add(win.appId);
    windows.push(cleanWindow(win));
  }
  return { version: 1, camera, windows };
}

export function createSceneStore(paths: Paths): SceneStore {
  const file = paths.sceneFile;
  const scene = loadScene(file);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let dirty = false;
  let writing: Promise<void> = Promise.resolve();

  function save(): Promise<void> {
    dirty = false;
    const data = `${JSON.stringify(scene, null, 2)}\n`;
    // Skrivningarna köas, så att två rename aldrig kan komma i fel ordning.
    writing = writing.then(() => writeFileAtomic(file, data)).catch((err: unknown) => {
      dirty = true; // försöks igen vid nästa ändring eller flush()
      console.warn(`[scene] kunde inte spara ${file}: ${String(err)}`);
    });
    return writing;
  }

  function changed(): void {
    dirty = true;
    if (timer) return; // ändringar under väntan samlas i samma skrivning
    timer = setTimeout(() => {
      timer = null;
      if (dirty) void save();
    }, SAVE_DELAY_MS);
    timer.unref();
  }

  return {
    get() {
      return structuredClone(scene);
    },

    window(appId) {
      const win = scene.windows.find((w) => w.appId === appId);
      return win ? { ...win } : undefined;
    },

    upsertWindow(win) {
      const err = windowError(win);
      if (err) throw new Error(`ogiltigt fönster: ${err}`);
      const clean = cleanWindow(win);
      const i = scene.windows.findIndex((w) => w.id === clean.id);
      if (i >= 0) {
        if (JSON.stringify(scene.windows[i]) === JSON.stringify(clean)) return;
        scene.windows[i] = clean;
      } else {
        scene.windows.push(clean);
      }
      changed();
    },

    removeWindowForApp(appId) {
      const i = scene.windows.findIndex((w) => w.appId === appId);
      if (i < 0) return undefined;
      const [removed] = scene.windows.splice(i, 1);
      changed();
      return { ...removed };
    },

    setCamera(camera) {
      const err = cameraError(camera);
      if (err) throw new Error(`ogiltig kamera: ${err}`);
      const next = cleanCamera(camera);
      if (JSON.stringify(scene.camera) === JSON.stringify(next)) return;
      scene.camera = next;
      changed();
    },

    async flush() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (dirty) await save();
      else await writing;
    },
  };
}
