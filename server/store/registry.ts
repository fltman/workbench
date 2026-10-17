// server/store/registry.ts — alla appar: mappar under apps/, manifest, status och rev (CONTRACT §6, §7, §4.6), och
// felsignalen trouble för ett fel efter turen (§7.2).
//
// Vid start registreras varje katalog under apps/ vars namn matchar APP_ID_RE (aldrig symboliska länkar), fönster
// vars app saknas tas bort, och alla appar får status 'idle' och rev = Date.now(). En app utan fönster (t.ex. om
// scenfilen gått förlorad) får ett nytt fönster till höger om de andra, så att den inte blir osynlig.
//
// Manifestet (apps/<id>/app.json, skrivet av Claude) normaliseras här och bara här:
// - faces saknas, är tom eller har bara ogiltiga sidor: DEFAULT_FACES. Högst 6 sidor, unika id [a-z0-9-]{1,32}.
// - faces[].page och backend.entry kontrolleras som statiska sökvägar (§4.6): realpath (närmaste befintliga
//   förfader) ska ligga i appen, inga segment som börjar med '.', första segmentet inte data eller node_modules
//   (skiftlägesokänsligt), och sökvägen får inte börja med '-'. Tecken som har betydelse i en URL (?, #, %) och '\'
//   avvisas, så att skalet kan bygga iframe-adressen av sidan som den står.
// - okända permissions tas bort; built = filen för faces[0].page finns.
// Allt sker synkront (refresh är synkron i AppRegistry), med fs.realpathSync.native, som ger diskens skiftläge
// precis som fs.promises.realpath (till skillnad från fs.realpathSync).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { APP_ID_RE, DEFAULT_FACES, OPEN_KINDS } from '../../shared/protocol.ts';
import type {
  AppInfo, AppManifest, AppPermission, AppStatus, BackendState, FaceDef, ServerMsg, WindowState,
} from '../../shared/protocol.ts';
import type { AppGit, AppRegistry, Hub, Paths, SceneStore } from '../types.ts';
import { windowError } from './scene.ts';

export type NormalizedManifest = AppManifest & { name: string; faces: FaceDef[]; permissions: AppPermission[] };

const FACE_ID_RE = /^[a-z0-9-]{1,32}$/;
const MAX_FACES = 6;
const PERMISSIONS: readonly AppPermission[] = ['microphone', 'camera', 'clipboard-read', 'geolocation'];
const STATUSES: readonly AppStatus[] = ['idle', 'building', 'waiting', 'error'];
const BACKEND_STATES: readonly BackendState[] = ['none', 'stopped', 'starting', 'running', 'crashed'];
const MANIFEST_MAX_BYTES = 256 * 1024;
const MAX_PATH = 512;
const MAX_NAME = 64;
const MAX_LABEL = 40;
const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const FALLBACK_WINDOW = { w: 640, h: 480, scale: 1, gap: 80 } as const;
/** Felsignalen (§7.2): AppInfo.trouble är första felets första rad, högst så många kodpunkter. */
const TROUBLE_MAX = 120;
/** Felraderna som sparas åt förslagen (§8.12): högst så många, och högst så långa. */
const TROUBLE_LINES = 5;
const TROUBLE_LINE_MAX = 300;
/** Ett ohanterat fel i en sida: wb.js skriver "Uncaught …" för window.onerror och avvisade löften, handleLog "error: " före. */
const CONSOLE_TROUBLE = /^error: (Uncaught\b.*)/;
/** En felrad på backendens stderr börjar med ett felnamn: "Error: …", "TypeError [ERR_X]: …", "[UnhandledPromiseRejection: …". */
const STDERR_TROUBLE = /^\s*\[?(?:Uncaught\s+)?(?:[A-Z][A-Za-z]*)?(?:Error|Exception|Rejection)\b/;

/** Frön som create() skriver (§6). /data/ är förankrad, så att t.ex. src/data/ versioneras och kan ångras. */
export const SEED_GITIGNORE = '/data/\nnode_modules/\n.DS_Store\n';
export function seedClaudeMd(appId: string): string {
  return `# ${appId}\n\nInga anteckningar ännu.\n`;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Styrtecken och formattecken (Unicode Cc och Cf: riktningstecknen, också U+061C, och tecken med noll bredd) blir
 * mellanslag, blanktecken slås ihop, högst max kodpunkter.
 */
function cleanText(v: unknown, max: number): string {
  if (typeof v !== 'string') return '';
  const s = v.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/gu, ' ').trim();
  return Array.from(s).slice(0, max).join('').trim();
}

/**
 * Felsignalen (§7.2): texten för en loggrad som är ett fel efter turen, annars null. Från en sida räknas bara ett
 * ohanterat fel, inte ett vanligt console.error (en pollande app skulle annars aldrig bli av med signalen), och från
 * backendens stderr bara en rad som börjar med ett felnamn (inte Nodes varningar eller platsraderna i en krasch).
 * Supervisorn minns den sista sådana raden och lämnar den bara när backenden kraschat (§9), eftersom ett hanterat fel
 * som loggas med console.error ser likadant ut. Bara första raden, utan kontroll- och formattecken, högst
 * TROUBLE_LINE_MAX kodpunkter.
 */
export function troubleLine(source: 'console' | 'stderr', line: string): string | null {
  if (typeof line !== 'string') return null;
  let first: string;
  if (source === 'console') {
    const m = CONSOLE_TROUBLE.exec(line);
    if (!m) return null;
    first = m[1].split(' ⏎ ')[0]; // handleLog gör radbrytningar till ⏎
  } else if (source === 'stderr' && STDERR_TROUBLE.test(line)) first = line;
  else return null;
  return cleanText(first, TROUBLE_LINE_MAX) || null;
}

/* ------------------------------ sökvägar (§4.6) ------------------------------ */

/** Styrtecken, '\' och det som har betydelse i en URL-sökväg. */
const BAD_PATH_CHARS = /[\p{Cc}\\?#%]/u;

/** Regeln för segment, på en sökväg relativt appens mapp: inget segment börjar med '.', första är inte data/node_modules. */
function allowedRel(rel: string): boolean {
  if (!rel || path.isAbsolute(rel)) return false;
  const segs = rel.split('/');
  if (segs.some((s) => s === '' || s.startsWith('.'))) return false;
  const first = segs[0].toLowerCase();
  return first !== 'data' && first !== 'node_modules';
}

/** realpath av sökvägen, eller av närmaste befintliga förfader med resten tillagd. null vid dinglande länk eller annat fel. */
function realpathDeepest(full: string): string | null {
  const rest: string[] = [];
  let cur = full;
  for (;;) {
    try {
      const real = fs.realpathSync.native(cur);
      return rest.length ? path.join(real, ...rest.reverse()) : real;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return null;
      // En dinglande symbolisk länk är inte "finns inte än": den kan peka vart som helst.
      try {
        if (fs.lstatSync(cur).isSymbolicLink()) return null;
      } catch {
        // finns inte alls
      }
      const parent = path.dirname(cur);
      if (parent === cur) return null;
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}

function inside(appRealDir: string, real: string): boolean {
  const rel = path.relative(appRealDir, real);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel) && allowedRel(rel);
}

export interface AppPath {
  /** Normaliserad relativ sökväg som den angavs (t.ex. "./a/../index.html" blir "index.html"). */
  rel: string;
  /** En vanlig fil finns där (efter realpath). */
  isFile: boolean;
}

/**
 * Kontrollera faces[].page eller backend.entry (§4.6). appRealDir är appmappens realpath.
 * Sökvägen behöver inte finnas än, men det som finns av den måste ligga i appen.
 */
export function checkAppPath(appRealDir: string, p: unknown): AppPath | null {
  if (typeof p !== 'string' || p.length === 0 || p.length > MAX_PATH) return null;
  if (BAD_PATH_CHARS.test(p) || p.startsWith('-') || p.startsWith('/')) return null;
  const norm = path.posix.normalize(p);
  if (norm.endsWith('/') || !allowedRel(norm)) return null;
  const real = realpathDeepest(path.join(appRealDir, norm));
  if (real === null || !inside(appRealDir, real)) return null;
  let isFile = false;
  try {
    isFile = fs.statSync(real).isFile();
  } catch {
    isFile = false;
  }
  return { rel: norm, isFile };
}

/* ------------------------------ manifestet (§6) ------------------------------ */

/** Läs app.json. raw är undefined om filen saknas eller är oanvändbar; problem säger varför (för loggen). */
export function readManifest(appRealDir: string): { raw: unknown; problem?: string } {
  const file = path.join(appRealDir, 'app.json');
  let real: string;
  try {
    real = fs.realpathSync.native(file);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') return { raw: undefined, problem: `app.json kunde inte läsas (${code})` };
    try {
      if (fs.lstatSync(file).isSymbolicLink()) return { raw: undefined, problem: 'app.json är en länk som inte går att följa' };
    } catch {
      // saknas: standardvärden, inget problem
    }
    return { raw: undefined };
  }
  if (!inside(appRealDir, real)) return { raw: undefined, problem: 'app.json pekar ut ur appens mapp' };
  let text: string;
  try {
    const st = fs.statSync(real);
    if (!st.isFile()) return { raw: undefined, problem: 'app.json är ingen vanlig fil' };
    if (st.size > MANIFEST_MAX_BYTES) return { raw: undefined, problem: 'app.json är större än 256 kB' };
    text = fs.readFileSync(real, 'utf8');
  } catch (err) {
    return { raw: undefined, problem: `app.json kunde inte läsas (${String(err)})` };
  }
  try {
    return { raw: JSON.parse(text.replace(/^\u{feff}/u, '')) };
  } catch (err) {
    return { raw: undefined, problem: `app.json är inte giltig JSON (${(err as Error).message})` };
  }
}

/**
 * Normalisera ett manifest (§6). appRealDir är appmappens realpath, eller null om mappen saknas
 * (då blir allt standardvärden och built false).
 */
export function normalizeManifest(raw: unknown, appRealDir: string | null): { manifest: NormalizedManifest; built: boolean } {
  const obj = isObject(raw) ? raw : {};
  const faces: FaceDef[] = [];
  const ids = new Set<string>();
  let firstIsFile = false;
  if (appRealDir && Array.isArray(obj.faces)) {
    for (const f of obj.faces) {
      if (faces.length >= MAX_FACES) break;
      if (!isObject(f) || typeof f.id !== 'string' || !FACE_ID_RE.test(f.id) || ids.has(f.id)) continue;
      const page = checkAppPath(appRealDir, f.page);
      if (!page) continue;
      const face: FaceDef = { id: f.id, page: page.rel };
      const label = cleanText(f.label, MAX_LABEL);
      if (label) face.label = label;
      if (faces.length === 0) firstIsFile = page.isFile;
      ids.add(f.id);
      faces.push(face);
    }
  }
  if (faces.length === 0) {
    for (const f of DEFAULT_FACES) faces.push({ ...f });
    firstIsFile = appRealDir ? (checkAppPath(appRealDir, faces[0].page)?.isFile ?? false) : false;
  }
  const permissions: AppPermission[] = [];
  if (Array.isArray(obj.permissions)) {
    for (const p of obj.permissions) {
      const perm = PERMISSIONS.find((k) => k === p);
      if (perm && !permissions.includes(perm)) permissions.push(perm);
    }
  }
  const manifest: NormalizedManifest = { name: cleanText(obj.name, MAX_NAME), faces, permissions };
  if (Array.isArray(obj.opens)) {
    const opens = OPEN_KINDS.filter((k) => (obj.opens as unknown[]).includes(k));
    if (opens.length) manifest.opens = opens;
  }
  if (appRealDir && isObject(obj.backend)) {
    const entry = checkAppPath(appRealDir, obj.backend.entry);
    if (entry) manifest.backend = { entry: entry.rel };
  }
  return { manifest, built: firstIsFile };
}

/* ------------------------------ registret ------------------------------ */

interface Entry {
  info: AppInfo;
  manifest: NormalizedManifest;
  problem?: string;
  removing?: Promise<void>;
  /** Felraderna sedan senaste turslut eller version (§7.2); info.trouble kommer från den första. */
  troubles?: string[];
}

interface Inspection {
  manifest: NormalizedManifest;
  built: boolean;
  problem?: string;
}

/** Kataloger under apps/ med giltigt id. Symboliska länkar räknas inte. */
function scanAppDirs(appsDir: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(appsDir);
  } catch {
    return [];
  }
  return names
    .filter((n) => {
      if (!APP_ID_RE.test(n)) return false;
      try {
        return fs.lstatSync(path.join(appsDir, n)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
}

/** ISO 8601 i basformat (inga kolon, som Finder visar som snedstreck), t.ex. 20261016T123456.789Z. */
function isoStamp(d = new Date()): string {
  return d.toISOString().replace(/[-:]/g, '');
}

async function moveIfExists(from: string, to: string): Promise<boolean> {
  try {
    await fs.promises.rename(from, to);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

export function createRegistry(deps: { paths: Paths; scene: SceneStore; hub: Hub; git: AppGit }): AppRegistry {
  const { paths, scene, hub, git } = deps;
  const apps = new Map<string, Entry>();

  function emit(msg: ServerMsg): void {
    try {
      hub.broadcast(msg);
    } catch (err) {
      console.warn(`[registry] kunde inte sända ${msg.t}: ${String(err)}`);
    }
  }

  function publish(e: Entry): void {
    emit({ t: 'app', app: structuredClone(e.info) });
  }

  /** Appen finns och håller inte på att tas bort. */
  function active(appId: string): Entry | undefined {
    const e = apps.get(appId);
    return e && !e.removing ? e : undefined;
  }

  /** Felsignalen gäller bara tiden sedan senaste turslut och version (§7.2). */
  function clearTrouble(e: Entry): void {
    e.troubles = undefined;
    delete e.info.trouble;
  }

  function inspect(appId: string): Inspection {
    let appReal: string | null;
    try {
      appReal = fs.realpathSync.native(paths.appDir(appId));
    } catch {
      appReal = null;
    }
    if (!appReal) return normalizeManifest(undefined, null);
    const { raw, problem } = readManifest(appReal);
    return { ...normalizeManifest(raw, appReal), problem };
  }

  /** För in en ny inläsning i AppInfo. Sant om något ändrades. Varnar en gång per nytt problem med app.json. */
  function apply(e: Entry, r: Inspection): boolean {
    const before = JSON.stringify(e.info);
    e.manifest = r.manifest;
    e.info.name = r.manifest.name;
    e.info.faces = structuredClone(r.manifest.faces);
    e.info.permissions = [...r.manifest.permissions];
    if (r.manifest.opens?.length) e.info.opens = [...r.manifest.opens];
    else delete e.info.opens;
    e.info.built = r.built;
    if (!r.manifest.backend) e.info.backend = 'none';
    else if (e.info.backend === 'none') e.info.backend = 'stopped';
    if (r.problem !== e.problem) {
      if (r.problem) console.warn(`[registry] ${e.info.id}: ${r.problem}; använder standardvärden`);
      e.problem = r.problem;
    }
    return JSON.stringify(e.info) !== before;
  }

  function newEntry(appId: string, rev: number): Entry {
    const r = inspect(appId);
    const e: Entry = {
      info: {
        id: appId,
        name: r.manifest.name,
        faces: structuredClone(r.manifest.faces),
        permissions: [...r.manifest.permissions],
        ...(r.manifest.opens?.length ? { opens: [...r.manifest.opens] } : {}),
        built: r.built,
        status: 'idle',
        backend: r.manifest.backend ? 'stopped' : 'none',
        rev,
      },
      manifest: r.manifest,
    };
    if (r.problem) {
      console.warn(`[registry] ${appId}: ${r.problem}; använder standardvärden`);
      e.problem = r.problem;
    }
    return e;
  }

  function maxZ(): number {
    return scene.get().windows.reduce((m, w) => Math.max(m, w.z), 0);
  }

  /** Id som ligger i papperskorgen (data/trash/<id>-<tid>): de återanvänds aldrig, eftersom id:t är appens origin och lagring. */
  function trashedIds(): Set<string> {
    try {
      return new Set(fs.readdirSync(paths.trashDir).map((n) => n.split('-')[0]));
    } catch {
      return new Set();
    }
  }

  function newId(): string {
    const trashed = trashedIds();
    for (let attempt = 0; attempt < 1000; attempt++) {
      let id = 'a';
      for (let i = 0; i < 6; i++) id += ID_ALPHABET[crypto.randomInt(ID_ALPHABET.length)];
      if (apps.has(id) || trashed.has(id)) continue;
      if (fs.existsSync(paths.appDir(id)) || fs.existsSync(paths.appDataDir(id))) continue;
      return id;
    }
    throw new Error('kunde inte hitta ett ledigt app-id');
  }

  /* ------------------------------ start (§7) ------------------------------ */

  const startRev = Date.now();
  for (const id of scanAppDirs(paths.appsDir)) apps.set(id, newEntry(id, startRev));
  for (const w of scene.get().windows) {
    if (!apps.has(w.appId)) scene.removeWindowForApp(w.appId);
  }
  {
    const wins = scene.get().windows;
    const withWindow = new Set(wins.map((w) => w.appId));
    let x = wins.length ? Math.max(...wins.map((w) => w.x + w.w * w.scale)) + FALLBACK_WINDOW.gap : 0;
    const y = wins.length ? Math.min(...wins.map((w) => w.y)) : 0;
    for (const id of apps.keys()) {
      if (withWindow.has(id)) continue;
      const { w, h, scale, gap } = FALLBACK_WINDOW;
      scene.upsertWindow({ id: `w-${id}`, appId: id, x, y, w, h, scale, face: 0, z: maxZ() + 1 });
      console.warn(`[registry] ${id} saknade fönster och fick ett nytt`);
      x += w * scale + gap;
    }
  }

  /* ------------------------------ gränssnittet ------------------------------ */

  return {
    list() {
      return [...apps.values()].map((e) => structuredClone(e.info));
    },

    get(appId) {
      const e = apps.get(appId);
      return e ? structuredClone(e.info) : undefined;
    },

    manifest(appId) {
      const e = apps.get(appId);
      if (!e) throw new Error(`okänd app: ${JSON.stringify(appId)}`);
      return structuredClone(e.manifest);
    },

    async create(req) {
      const problem = isObject(req)
        ? windowError({ id: 'w-a000000', appId: 'a000000', x: req.x, y: req.y, w: req.w, h: req.h, scale: req.scale, face: 0, z: 0 })
        : 'förfrågan måste vara ett objekt';
      if (problem) throw new Error(`ogiltig förfrågan: ${problem}`);

      const id = newId();
      const appDir = paths.appDir(id);
      const dataDir = paths.appDataDir(id);
      await fs.promises.mkdir(paths.appsDir, { recursive: true });
      await fs.promises.mkdir(appDir); // inte recursive: fel om mappen redan finns
      try {
        await fs.promises.writeFile(path.join(appDir, '.gitignore'), SEED_GITIGNORE, { flag: 'wx' });
        await fs.promises.writeFile(path.join(appDir, 'CLAUDE.md'), seedClaudeMd(id), { flag: 'wx' });
        await fs.promises.mkdir(dataDir, { recursive: true });
        await git.init(id);
      } catch (err) {
        // Ta bort det som nyss skapades, så att ingen halv app registreras vid nästa start.
        await fs.promises.rm(appDir, { recursive: true, force: true }).catch(() => {});
        await fs.promises.rm(dataDir, { recursive: true, force: true }).catch(() => {});
        throw err;
      }

      const e = newEntry(id, Date.now());
      const win: WindowState = {
        id: `w-${id}`, appId: id, x: req.x, y: req.y, w: req.w, h: req.h, scale: req.scale, face: 0, z: maxZ() + 1,
      };
      apps.set(id, e);
      scene.upsertWindow(win);
      publish(e);
      emit({ t: 'scene.window', win: { ...win } });
      await scene.flush(); // ett nytt fönster ska överleva en omstart direkt
      return { app: structuredClone(e.info), win: { ...win } };
    },

    remove(appId) {
      const e = apps.get(appId);
      if (!e) return Promise.reject(new Error(`okänd app: ${JSON.stringify(appId)}`));
      if (e.removing) return e.removing;
      const removing = (async () => {
        const stamp = isoStamp();
        let dest = path.join(paths.trashDir, `${appId}-${stamp}`);
        for (let i = 2; fs.existsSync(dest); i++) dest = path.join(paths.trashDir, `${appId}-${stamp}-${i}`);
        await fs.promises.mkdir(path.join(dest, 'apps'), { recursive: true });
        await fs.promises.mkdir(path.join(dest, 'data', 'apps'), { recursive: true });
        // Appens mapp först: går det inte ändras ingenting.
        await moveIfExists(paths.appDir(appId), path.join(dest, 'apps', appId));
        try {
          await moveIfExists(paths.appDataDir(appId), path.join(dest, 'data', 'apps', appId));
        } catch (err) {
          console.warn(`[registry] ${appId}: data/apps/${appId} kunde inte flyttas till papperskorgen: ${String(err)}`);
        }
        scene.removeWindowForApp(appId);
        apps.delete(appId);
        emit({ t: 'scene.windowRemoved', id: `w-${appId}` });
        emit({ t: 'app.removed', appId });
        await scene.flush();
      })();
      e.removing = removing;
      removing.catch(() => {
        if (apps.get(appId) === e) e.removing = undefined; // misslyckades: får försökas igen
      });
      return removing;
    },

    setStatus(appId, status) {
      const e = active(appId);
      if (!e || !STATUSES.includes(status) || e.info.status === status) return;
      // Turen är slut (även utan ny version, till exempel när Claude Code inte kunde starta).
      if ((e.info.status === 'building' || e.info.status === 'waiting') && (status === 'idle' || status === 'error')) clearTrouble(e);
      e.info.status = status;
      publish(e);
    },

    setBackend(appId, state) {
      const e = active(appId);
      if (!e || !BACKEND_STATES.includes(state) || e.info.backend === state) return;
      e.info.backend = state;
      publish(e);
    },

    bumpRev(appId) {
      const e = active(appId);
      if (!e) return;
      e.info.rev = Math.max(Date.now(), e.info.rev + 1);
      clearTrouble(e);
      publish(e);
    },

    refresh(appId) {
      const e = active(appId);
      if (!e) return;
      if (apply(e, inspect(appId))) publish(e);
    },

    noteLog(appId, source, line, rev) {
      const e = active(appId);
      if (!e || !e.info.built || e.info.status !== 'idle') return;
      // En sida med en äldre version (den gamla iframen under bytet, Claudes skärmbildssida) satte annars tillbaka
      // felet som just rättats.
      if (source === 'console' && rev !== e.info.rev) return;
      const t = troubleLine(source, line);
      if (!t) return;
      const list = (e.troubles ??= []);
      if (list.length >= TROUBLE_LINES || list.includes(t)) return;
      list.push(t);
      if (e.info.trouble !== undefined) return; // sänds en gång per tur
      const cps = Array.from(t);
      e.info.trouble = cps.length > TROUBLE_MAX ? `${cps.slice(0, TROUBLE_MAX - 1).join('')}…` : t;
      publish(e);
    },

    troubles(appId) {
      return [...(apps.get(appId)?.troubles ?? [])];
    },
  };
}
