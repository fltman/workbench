// server/http/rest.ts — REST på skalets origin (CONTRACT §7.1) och flödena som spänner över moduler (§7.4).
import type { IncomingMessage, ServerResponse } from 'node:http';
import { APP_ID_RE } from '../../shared/protocol.ts';
import type { CreateAppRequest, OpenItem, RouteResponse, SttResponse } from '../../shared/protocol.ts';
import { normalizeItem } from '../../shared/open.ts';
import type { AppGit, AppRegistry, Backends, Config, SceneStore, Sessions } from '../types.ts';
import { HttpError, createLocks, isPlainObject, mediaType, methodNotAllowed, readBody, readJson, sendError, sendJson } from './util.ts';

export const STT_MAX = 10 * 1024 * 1024;
export const STT_TYPES = new Set(['audio/webm', 'audio/mp4']);
const JSON_MAX = 64 * 1024;
const HISTORY_LIMIT = 300;
/** Världskoordinater är obegränsade i princip; det här stoppar bara orimliga tal. */
const COORD_MAX = 1e9;

export type Transcribe = (config: Config, audio: Buffer, mime: string, hints: string[]) => Promise<SttResponse>;

export interface RestDeps {
  config: Config;
  scene: Pick<SceneStore, 'get'>;
  registry: Pick<AppRegistry, 'list' | 'get' | 'manifest' | 'create' | 'remove' | 'refresh' | 'bumpRev'>;
  sessions: Pick<Sessions, 'forget' | 'busy' | 'noteUndo' | 'history'>;
  backends: Pick<Backends, 'stop' | 'restart' | 'state'>;
  git: Pick<AppGit, 'undo'>;
  logs: { clear(appId: string): void };
  transcribe: Transcribe;
  /** Förslag på förbättringar (§8.12). Saknas: 404. */
  ideas?: (appId: string) => Promise<{ rev: number; items: string[] }>;
  /** Vart det som skrivs i fältet ska (§8.13). Saknas: 404. */
  route?: (text: string, known: OpenItem | null) => Promise<RouteResponse>;
}

/** Validerar CreateAppRequest enligt §5: heltal w 240–2400, h 160–1600, scale 0,05–20. Kastar HttpError(400). */
export function parseCreateApp(body: unknown): CreateAppRequest {
  if (!isPlainObject(body)) throw new HttpError(400, 'ett objekt krävs');
  const { x, y, w, h, scale } = body;
  const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  if (!finite(x) || !finite(y) || Math.abs(x) > COORD_MAX || Math.abs(y) > COORD_MAX) throw new HttpError(400, 'x och y måste vara tal');
  if (!Number.isInteger(w) || (w as number) < 240 || (w as number) > 2400) throw new HttpError(400, 'w måste vara ett heltal 240–2400');
  if (!Number.isInteger(h) || (h as number) < 160 || (h as number) > 1600) throw new HttpError(400, 'h måste vara ett heltal 160–1600');
  if (!finite(scale) || scale < 0.05 || scale > 20) throw new HttpError(400, 'scale måste vara 0,05–20');
  return { x, y, w: w as number, h: h as number, scale };
}

/** Plockar ut och avkodar :id. Allt som inte är ett giltigt, registrerat id ger null (=> 404). */
export function appIdFrom(raw: string, registry: Pick<AppRegistry, 'get'>): string | null {
  let id: string;
  try {
    id = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (!APP_ID_RE.test(id)) return null;
  return registry.get(id) ? id : null;
}

export function createRest(deps: RestDeps): (req: IncomingMessage, res: ServerResponse, rawPath: string) => Promise<void> {
  const { config, scene, registry, sessions, backends, git, logs } = deps;
  // DELETE och ångra för samma app körs aldrig samtidigt.
  const lock = createLocks();

  async function createApp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (mediaType(req.headers['content-type']) !== 'application/json') throw new HttpError(415, 'application/json krävs');
    const body = parseCreateApp(await readJson(req, JSON_MAX));
    const { app, win } = await registry.create(body);
    sendJson(res, 200, { app, win });
  }

  /** §7.4: forget → stop → remove (sänder scene.windowRemoved, app.removed) → logs.clear → { ok: true }. */
  async function deleteApp(res: ServerResponse, id: string): Promise<void> {
    await lock(id, async () => {
      if (!registry.get(id)) throw new HttpError(404, 'appen finns inte');
      await sessions.forget(id);
      await backends.stop(id);
      await registry.remove(id);
      logs.clear(id);
    });
    sendJson(res, 200, { ok: true });
  }

  /**
   * §7.4: 409 under en tur; annars git.undo och vid ok refresh → restart → bumpRev → noteUndo.
   * restart anropas villkorslöst: tog ångrandet bort backenden ur manifestet stoppar den den gamla
   * processen, sätter 'none' och returnerar null.
   */
  async function undo(res: ServerResponse, id: string): Promise<void> {
    const ok = await lock(id, async () => {
      if (!registry.get(id)) throw new HttpError(404, 'appen finns inte');
      if (sessions.busy(id)) throw new HttpError(409, 'Claude arbetar');
      const undone = await git.undo(id);
      if (undone) {
        registry.refresh(id);
        await backends.restart(id);
        registry.bumpRev(id);
        sessions.noteUndo(id);
      }
      return undone;
    });
    sendJson(res, 200, { ok });
  }

  async function stt(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const mime = mediaType(req.headers['content-type']);
    if (!STT_TYPES.has(mime)) throw new HttpError(415, 'audio/webm eller audio/mp4 krävs');
    const audio = await readBody(req, STT_MAX);
    if (audio.length === 0) throw new HttpError(400, 'tomt ljud');
    const hints = registry.list().map((a) => a.name).filter((n) => n.trim() !== '');
    let result: SttResponse;
    try {
      result = await deps.transcribe(config, audio, mime, hints);
    } catch (err) {
      console.warn('[workbench] tal till text misslyckades:', err instanceof Error ? err.message : err);
      throw new HttpError(503, 'tal till text fungerar inte just nu');
    }
    sendJson(res, 200, { text: result.text, provider: result.provider });
  }

  return async (req, res, rawPath) => {
    const method = req.method ?? 'GET';
    try {
      if (rawPath === '/api/snapshot') {
        if (method !== 'GET' && method !== 'HEAD') throw methodNotAllowed('GET, HEAD');
        return sendJson(res, 200, { scene: scene.get(), apps: registry.list() });
      }
      if (rawPath === '/api/apps') {
        if (method !== 'POST') throw methodNotAllowed('POST');
        return await createApp(req, res);
      }
      if (rawPath === '/api/stt') {
        if (method !== 'POST') throw methodNotAllowed('POST');
        return await stt(req, res);
      }
      if (rawPath === '/api/route') {
        if (method !== 'POST') throw methodNotAllowed('POST');
        if (!deps.route) throw new HttpError(404, 'okänd sökväg');
        if (mediaType(req.headers['content-type']) !== 'application/json') throw new HttpError(415, 'application/json krävs');
        const body = await readJson(req, JSON_MAX);
        if (!isPlainObject(body) || typeof body.text !== 'string' || !body.text.trim() || body.text.length > 2000) throw new HttpError(400, 'text krävs');
        const k = isPlainObject(body.known) ? normalizeItem(body.known.kind, body.known.url ?? body.known.date ?? body.known.text) : null;
        try {
          return sendJson(res, 200, await deps.route(body.text, k));
        } catch (err) {
          console.warn('[workbench] fältet:', err instanceof Error ? err.message : err);
          throw new HttpError(503, 'kunde inte avgöra vart det ska');
        }
      }
      const m = /^\/api\/apps\/([^/]+)(\/undo|\/chat|\/ideas)?$/.exec(rawPath);
      if (m) {
        const id = appIdFrom(m[1], registry);
        if (!id) throw new HttpError(404, 'appen finns inte');
        if (m[2] === undefined) {
          if (method !== 'DELETE') throw methodNotAllowed('DELETE');
          return await deleteApp(res, id);
        }
        if (m[2] === '/undo') {
          if (method !== 'POST') throw methodNotAllowed('POST');
          return await undo(res, id);
        }
        if (m[2] === '/ideas') {
          // POST: frågan kan kosta en Claude-fråga (sparas per rev), så den görs aldrig på en GET.
          if (method !== 'POST') throw methodNotAllowed('POST');
          if (!deps.ideas) throw new HttpError(404, 'okänd sökväg');
          if (!registry.get(id)?.built) throw new HttpError(409, 'appen är inte byggd än');
          try {
            return sendJson(res, 200, await deps.ideas(id));
          } catch (err) {
            console.warn(`[workbench] förslag för ${id}:`, err instanceof Error ? err.message : err);
            throw new HttpError(503, 'kunde inte ta fram förslag');
          }
        }
        if (method !== 'GET' && method !== 'HEAD') throw methodNotAllowed('GET, HEAD');
        return sendJson(res, 200, { events: sessions.history(id, HISTORY_LIMIT) });
      }
      throw new HttpError(404, 'okänd sökväg');
    } catch (err) {
      await sendError(res, err);
    }
  };
}
