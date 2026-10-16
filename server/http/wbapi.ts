// server/http/wbapi.ts — /__wb/* på appernas origins (CONTRACT §7.2): wb.js, app.json, loggar och store.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AppLogs, AppRegistry, Config, Paths } from '../types.ts';
import { appRealDir } from './static.ts';
import { HttpError, createLocks, isPlainObject, methodNotAllowed, readBody, readJson, sendEmpty, sendError, sendJson } from './util.ts';

export const STORE_KEY_RE = /^[A-Za-z0-9._-]{1,100}$/;
/** PUT-kroppen (§7.2). */
export const STORE_PUT_MAX = 1024 * 1024;
/** Hela store.json; skyddar disken mot en app som lägger in obegränsat många nycklar. */
export const STORE_TOTAL_MAX = 10 * 1024 * 1024;
export const LOG_MAX_ENTRIES = 50;
export const LOG_MAX_TEXT = 2000;
export const LOG_RATE_PER_S = 100;
/**
 * Tokenhinkens storlek: 1,5 s av takten. wb.js skickar en bunt på högst 50 poster var 500 ms, alltså just
 * 100 poster/s; med marginalen släpps inget när buntarna kommer ojämnt (§7.2), men en flod stoppas ändå.
 */
export const LOG_BURST = 150;
const LOG_BODY_MAX = 1024 * 1024;
const LEVELS = new Set(['error', 'warn', 'log']);

const { O_RDONLY, O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW, O_NONBLOCK } = fs.constants;

export interface WbApiDeps {
  config: Pick<Config, 'root'>;
  paths: Paths;
  registry: Pick<AppRegistry, 'get'>;
  logs: Pick<AppLogs, 'append'>;
  /** Klocka för hastighetsgränsen (tester). */
  now?: () => number;
}

export interface WbApi {
  /** Hanterar /__wb/*. Sökvägen är den råa (oavkodade) URL-sökvägen. */
  handle(req: IncomingMessage, res: ServerResponse, appId: string, rawPath: string): Promise<void>;
  /** För tester och REST: läs hela store-objektet. */
  readStore(appId: string): Promise<Map<string, unknown>>;
}

/** Gör en loggtext till en rad: radbrytningar blir ⏎ och andra kontrolltecken mellanslag, högst 2000 tecken. */
export function logLine(level: string, text: string): string {
  const cut = text.length > LOG_MAX_TEXT ? `${text.slice(0, LOG_MAX_TEXT)}…` : text;
  const flat = cut.replace(/\r\n|\r|\n/g, ' ⏎ ').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ');
  return `${level}: ${flat}`;
}

export function createWbApi(deps: WbApiDeps): WbApi {
  const { config, paths, registry, logs } = deps;
  const now = deps.now ?? Date.now;
  const lock = createLocks();
  /** Tokenhink per app för /__wb/log: fylls på med 100 poster/s, rymmer LOG_BURST. */
  const buckets = new Map<string, { tokens: number; t: number }>();

  /** Hur många av n poster som får läggas i loggen just nu. */
  function takeTokens(appId: string, n: number): number {
    const t = now();
    let b = buckets.get(appId);
    if (!b) {
      b = { tokens: LOG_BURST, t };
      buckets.set(appId, b);
    } else {
      b.tokens = Math.min(LOG_BURST, b.tokens + (Math.max(0, t - b.t) / 1000) * LOG_RATE_PER_S);
      b.t = t;
    }
    const k = Math.max(0, Math.min(n, Math.floor(b.tokens)));
    b.tokens -= k;
    return k;
  }

  /**
   * apps/<id>/data efter lstat: en symbolisk länk eller något annat än en katalog vägras (§4.6).
   * create = true skapar katalogen (före en skrivning).
   */
  async function dataDir(appId: string, create: boolean): Promise<string | null> {
    const appReal = await appRealDir(paths.appsDir, paths.appDir, appId);
    if (!appReal) throw new HttpError(404, 'appen saknas');
    const dir = path.join(appReal, 'data');
    let st = await fs.promises.lstat(dir).catch(() => null);
    if (!st) {
      if (!create) return null;
      await fs.promises.mkdir(dir).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== 'EEXIST') throw e;
      });
      st = await fs.promises.lstat(dir);
    }
    if (st.isSymbolicLink() || !st.isDirectory()) throw new HttpError(403, 'data/ är inte en katalog');
    return dir;
  }

  async function readStore(appId: string): Promise<Map<string, unknown>> {
    const dir = await dataDir(appId, false);
    if (!dir) return new Map();
    let fh: fs.promises.FileHandle;
    try {
      fh = await fs.promises.open(path.join(dir, 'store.json'), O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
      throw new HttpError(403, 'store.json kan inte läsas');
    }
    try {
      const st = await fh.stat();
      if (!st.isFile()) throw new HttpError(403, 'store.json är ingen fil');
      if (st.size > STORE_TOTAL_MAX + 1024) throw new HttpError(500, 'store.json är för stor');
      const text = await fh.readFile('utf8');
      if (text.trim() === '') return new Map();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new HttpError(500, 'store.json är trasig');
      }
      if (!isPlainObject(parsed)) throw new HttpError(500, 'store.json är trasig');
      // Object.entries tar med en egen "__proto__"-nyckel från JSON.parse; Map ger ingen prototypförorening.
      return new Map(Object.entries(parsed));
    } finally {
      await fh.close().catch(() => {});
    }
  }

  async function writeStore(appId: string, store: Map<string, unknown>): Promise<void> {
    const dir = await dataDir(appId, true);
    if (!dir) throw new HttpError(500);
    // Object.fromEntries skapar egna egenskaper, även för nyckeln "__proto__".
    const data = Buffer.from(JSON.stringify(Object.fromEntries(store)));
    if (data.length > STORE_TOTAL_MAX) throw new HttpError(413, 'store är full');
    const tmp = path.join(dir, `store.json.tmp.${process.pid}.${crypto.randomBytes(6).toString('hex')}`);
    const fh = await fs.promises.open(tmp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600);
    try {
      await fh.writeFile(data);
      await fh.datasync();
    } catch (e) {
      await fh.close().catch(() => {});
      await fs.promises.unlink(tmp).catch(() => {});
      throw e;
    }
    await fh.close();
    try {
      await fs.promises.rename(tmp, path.join(dir, 'store.json'));
    } catch (e) {
      await fs.promises.unlink(tmp).catch(() => {});
      throw e;
    }
  }

  async function serveWbJs(res: ServerResponse, method: string): Promise<void> {
    let body: Buffer;
    try {
      body = await fs.promises.readFile(path.join(config.root, 'sdk', 'wb.js'));
    } catch {
      sendEmpty(res, 404);
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': String(body.length),
      'x-content-type-options': 'nosniff',
    });
    res.end(method === 'HEAD' ? undefined : body);
  }

  async function handleLog(req: IncomingMessage, res: ServerResponse, appId: string): Promise<void> {
    const raw = await readBody(req, LOG_BODY_MAX);
    let entries: unknown;
    try {
      entries = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new HttpError(400, 'ogiltig JSON');
    }
    if (!Array.isArray(entries) || entries.length > LOG_MAX_ENTRIES) throw new HttpError(400, 'en lista med högst 50 poster');
    for (const e of entries) {
      if (!isPlainObject(e) || typeof e.level !== 'string' || !LEVELS.has(e.level) || typeof e.text !== 'string') {
        throw new HttpError(400, 'ogiltig post');
      }
    }
    // Högst 100 poster per sekund och app (tokenhink med marginal för buntning); resten släpps.
    const list = entries as { level: string; text: string }[];
    const k = takeTokens(appId, list.length);
    for (const e of list.slice(0, k)) logs.append(appId, 'console', logLine(e.level, e.text));
    sendEmpty(res, 204);
  }

  async function handleStore(req: IncomingMessage, res: ServerResponse, appId: string, rest: string): Promise<void> {
    const method = req.method ?? 'GET';
    if (rest === '') {
      if (method !== 'GET' && method !== 'HEAD') {
        throw methodNotAllowed('GET, HEAD');
      }
      sendJson(res, 200, Object.fromEntries(await readStore(appId)));
      return;
    }
    if (!rest.startsWith('/')) throw new HttpError(404, 'okänd sökväg');
    let key: string;
    try {
      key = decodeURIComponent(rest.slice(1));
    } catch {
      throw new HttpError(400, 'ogiltig nyckel');
    }
    if (!STORE_KEY_RE.test(key) || key === '.' || key === '..') throw new HttpError(400, 'ogiltig nyckel');

    if (method === 'GET' || method === 'HEAD') {
      const store = await readStore(appId);
      if (!store.has(key)) {
        // wb.js skickar x-wb-optional: 1 och får 204 i stället för 404 (K6): en 404 skriver Chrome som
        // "Failed to load resource" i appens konsol vid varje första get() av en nyckel som inte satts än.
        if (req.headers['x-wb-optional'] === '1') sendEmpty(res, 204);
        else sendJson(res, 404, { error: 'nyckeln saknas' });
        return;
      }
      sendJson(res, 200, store.get(key));
      return;
    }
    if (method === 'PUT') {
      const value = await readJson(req, STORE_PUT_MAX);
      await lock(appId, async () => {
        const store = await readStore(appId);
        store.set(key, value);
        await writeStore(appId, store);
      });
      sendEmpty(res, 204);
      return;
    }
    if (method === 'DELETE') {
      await lock(appId, async () => {
        const store = await readStore(appId);
        if (store.delete(key)) await writeStore(appId, store);
      });
      sendEmpty(res, 204);
      return;
    }
    throw methodNotAllowed('GET, HEAD, PUT, DELETE');
  }

  async function handle(req: IncomingMessage, res: ServerResponse, appId: string, rawPath: string): Promise<void> {
    const method = req.method ?? 'GET';
    try {
      if (rawPath === '/__wb/wb.js') {
        if (method !== 'GET' && method !== 'HEAD') throw methodNotAllowed('GET, HEAD');
        return await serveWbJs(res, method);
      }
      if (rawPath === '/__wb/app.json') {
        if (method !== 'GET' && method !== 'HEAD') throw methodNotAllowed('GET, HEAD');
        const app = registry.get(appId);
        if (!app) throw new HttpError(404, 'appen saknas');
        return sendJson(res, 200, { id: app.id, name: app.name, faces: app.faces });
      }
      if (rawPath === '/__wb/log') {
        if (method !== 'POST') throw methodNotAllowed('POST');
        return await handleLog(req, res, appId);
      }
      if (rawPath === '/__wb/store' || rawPath.startsWith('/__wb/store/')) {
        return await handleStore(req, res, appId, rawPath.slice('/__wb/store'.length));
      }
      sendJson(res, 404, { error: 'okänd sökväg' });
    } catch (err) {
      await sendError(res, err);
    }
  }

  return { handle, readStore };
}
