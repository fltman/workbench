// server/http/router.ts — routningen för båda servrarna (127.0.0.1 och ::1). Vakten körs FÖRST för varje
// request och upgrade (CONTRACT §4.1); därefter skalet (REST, /ws, Vite eller dist/) eller appens origin
// (/__wb/*, /api/* till backenden, statiska filer).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import type { AppGit, AppLogs, AppRegistry, Backends, Config, Paths, SceneStore, Sessions } from '../types.ts';
import type { HubEx } from '../live/hub.ts';
import { guard as realGuard } from './guard.ts';
import type { GuardFn } from './guard.ts';
import { appHtmlHeaders, shellHeaders } from './headers.ts';
import { createRest } from './rest.ts';
import type { RestDeps } from './rest.ts';
import type { Transcribe } from './rest.ts';
import {
  APP_DENY_FIRST, appRealDir, decodeUrlPath, resolveInside, resolveUrlPath, sendEmptyPage, serveFile,
} from './static.ts';
import type { Resolved } from './static.ts';
import { createWbApi } from './wbapi.ts';
import { createWsEndpoint } from './ws.ts';
import { rejectUpgrade, sendEmpty, sendJson, splitUrl } from './util.ts';

/** server/backends/proxy.ts (server-backends); injiceras så att routern går att testa utan den. */
export interface ProxyFns {
  proxyHttp(req: IncomingMessage, res: ServerResponse, port: number): void;
  proxyUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, port: number): void;
}

export type ShellMiddleware = (req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) => void;

export interface RouterDeps {
  config: Config;
  paths: Paths;
  hub: HubEx;
  scene: SceneStore;
  registry: AppRegistry;
  logs: AppLogs;
  git: AppGit;
  backends: Backends;
  sessions: Sessions;
  proxy: ProxyFns;
  transcribe: Transcribe;
  /** Förslag på förbättringar (§8.12). */
  ideas?: (appId: string) => Promise<{ rev: number; items: string[] }>;
  /** Vart det som skrivs i fältet ska (§8.13). */
  route?: RestDeps['route'];
  /** Dev: Vites middlewares. null: dist/ (produktion). */
  vite: { middlewares: ShellMiddleware } | null;
  /** Standard <root>/dist. */
  distDir?: string;
  /** Bara tester (planterad läcka): ersätter vakten. Servern anropar alltid utan. */
  guardFn?: GuardFn;
}

export interface Router {
  request(req: IncomingMessage, res: ServerResponse): void;
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
  close(): void;
}

export function createRouter(deps: RouterDeps): Router {
  const { config, paths, registry, backends, proxy } = deps;
  const guardFn = deps.guardFn ?? realGuard;
  const distDir = deps.distDir ?? path.join(config.root, 'dist');
  const rest = createRest({
    config, scene: deps.scene, registry, sessions: deps.sessions, backends, git: deps.git, logs: deps.logs, transcribe: deps.transcribe, ideas: deps.ideas, route: deps.route,
  });
  const wbapi = createWbApi({ config, paths, registry, logs: deps.logs });
  const ws = createWsEndpoint({ hub: deps.hub, scene: deps.scene, registry, sessions: deps.sessions });
  const guardOpts = (upgrade: boolean) => ({ port: config.port, appExists: (id: string) => !!registry.get(id), upgrade });
  let warnedDist = false;

  /* ------------------------------ skalet ------------------------------ */

  async function serveDist(req: IncomingMessage, res: ServerResponse, rawPath: string): Promise<void> {
    const method = req.method ?? 'GET';
    const headers = shellHeaders(config);
    if (method !== 'GET' && method !== 'HEAD') return sendEmpty(res, 405, { ...headers, allow: 'GET, HEAD' });
    const distReal = await fs.promises.realpath(distDir).catch(() => null);
    if (!distReal) {
      if (!warnedDist) console.warn('[workbench] dist/ saknas: kör npm run build');
      warnedDist = true;
      return sendEmpty(res, 503, headers);
    }
    let resolved = rawPath === '/' ? await resolveInside(distReal, 'index.html', []) : await resolveUrlPath(distReal, rawPath, []);
    // SPA-fallback: en sökväg helt utan punkt (ingen fil, ingen punktfil) som inte finns ger index.html.
    if (!resolved.ok && resolved.status === 404 && !(decodeUrlPath(rawPath) ?? '.').includes('.')) {
      resolved = await resolveInside(distReal, 'index.html', []);
    }
    if (!resolved.ok) return sendEmpty(res, resolved.status, headers);
    const ok = await serveFile(res, method, distReal, resolved, [], { headers, cacheControl: 'no-cache' });
    if (!ok) sendEmpty(res, 404, headers);
  }

  function shell(req: IncomingMessage, res: ServerResponse): void {
    for (const [k, v] of Object.entries(shellHeaders(config))) res.setHeader(k, v);
    const { path: p } = splitUrl(req.url);
    if (p === '/api' || p.startsWith('/api/')) {
      void rest(req, res, p);
      return;
    }
    if (p === '/ws') {
      sendJson(res, 426, { error: 'WebSocket krävs' });
      return;
    }
    if (deps.vite) {
      deps.vite.middlewares(req, res, (err?: unknown) => {
        if (err) console.error('[workbench] Vite:', err);
        sendEmpty(res, err ? 500 : 404);
      });
      return;
    }
    serveDist(req, res, p).catch((err: unknown) => {
      console.error('[workbench] dist:', err);
      sendEmpty(res, 500);
    });
  }

  /* ------------------------------ apparna ------------------------------ */

  async function serveApp(req: IncomingMessage, res: ServerResponse, appId: string, rawPath: string): Promise<void> {
    const method = req.method ?? 'GET';
    const html = appHtmlHeaders(config.port);
    if (method !== 'GET' && method !== 'HEAD') return sendEmptyPage(res, 405, { ...html, allow: 'GET, HEAD' });
    const appReal = await appRealDir(paths.appsDir, paths.appDir, appId);
    if (!appReal) return sendEmptyPage(res, 404, html);
    let resolved: Resolved;
    if (rawPath === '/') {
      // "/" ger första sidan (faces[0].page), med samma kontroll som alla andra sökvägar.
      let page: string;
      try {
        page = registry.manifest(appId).faces[0]?.page ?? 'index.html';
      } catch {
        return sendEmptyPage(res, 404, html); // appen togs bort under tiden
      }
      resolved = await resolveInside(appReal, page, APP_DENY_FIRST);
    } else {
      resolved = await resolveUrlPath(appReal, rawPath, APP_DENY_FIRST);
    }
    if (!resolved.ok) return sendEmptyPage(res, resolved.status, html);
    const ok = await serveFile(res, method, appReal, resolved, APP_DENY_FIRST, { htmlHeaders: html, inject: true, refuseHardLinks: true });
    if (!ok) sendEmptyPage(res, 404, html);
  }

  async function proxyHttpTo(req: IncomingMessage, res: ServerResponse, appId: string): Promise<void> {
    let port: number | null = null;
    try {
      port = await backends.ensure(appId);
    } catch (err) {
      console.error('[workbench] backend kunde inte startas:', err);
    }
    if (req.socket?.destroyed || res.writableEnded) return;
    if (port === null) return sendJson(res, 503, { error: 'backend' });
    proxy.proxyHttp(req, res, port);
  }

  async function proxyUpgradeTo(req: IncomingMessage, socket: Duplex, head: Buffer, appId: string): Promise<void> {
    let port: number | null = null;
    try {
      port = await backends.ensure(appId);
    } catch (err) {
      console.error('[workbench] backend kunde inte startas:', err);
    }
    if (socket.destroyed) return;
    if (port === null) return rejectUpgrade(socket, 503, { json: { error: 'backend' } });
    proxy.proxyUpgrade(req, socket, head, port);
  }

  function app(req: IncomingMessage, res: ServerResponse, appId: string): void {
    const { path: p } = splitUrl(req.url);
    const done = (err: unknown): void => {
      console.error('[workbench] app-förfrågan:', err);
      sendEmpty(res, 500);
    };
    if (p.startsWith('/__wb/')) {
      wbapi.handle(req, res, appId, p).catch(done);
      return;
    }
    if (p.startsWith('/api/')) {
      proxyHttpTo(req, res, appId).catch(done);
      return;
    }
    serveApp(req, res, appId, p).catch(done);
  }

  /* ------------------------------ ingångarna ------------------------------ */

  return {
    request(req, res) {
      res.on('error', () => {
        /* klienten försvann */
      });
      try {
        const d = guardFn(req, guardOpts(false));
        if (!d.ok) {
          const headers: Record<string, string> = { connection: 'close' };
          if (d.location) headers.location = d.location;
          sendEmpty(res, d.status, headers);
          return;
        }
        if (d.kind === 'shell') shell(req, res);
        else app(req, res, d.appId);
      } catch (err) {
        // Fel i vakten eller routningen: stängt, aldrig vidare.
        console.error('[workbench] förfrågan:', err);
        sendEmpty(res, 500, { connection: 'close' });
      }
    },

    upgrade(req, socket, head) {
      // Node 25 tar annars ner processen på EPIPE.
      socket.on('error', () => {
        /* klienten försvann */
      });
      try {
        const d = guardFn(req, guardOpts(true));
        if (!d.ok) return rejectUpgrade(socket, d.status, { location: d.location });
        const { path: p } = splitUrl(req.url);
        if (d.kind === 'shell') {
          if (p === '/ws') return ws.handleUpgrade(req, socket, head);
          return rejectUpgrade(socket, 404);
        }
        if (p.startsWith('/api/')) {
          proxyUpgradeTo(req, socket, head, d.appId).catch((err: unknown) => {
            console.error('[workbench] uppgradering:', err);
            rejectUpgrade(socket, 502, { json: { error: 'backend' } });
          });
          return;
        }
        rejectUpgrade(socket, 404);
      } catch (err) {
        console.error('[workbench] uppgradering:', err);
        rejectUpgrade(socket, 500);
      }
    },

    close() {
      ws.close();
    },
  };
}

/**
 * Två http.Server med samma hanterare för request och upgrade: 127.0.0.1 och ::1 (§3), aldrig nätverket.
 * Saknar datorn IPv6 på loopback loggas en varning och bara 127.0.0.1 används.
 */
export async function listenBoth(port: number, router: Router): Promise<http.Server[]> {
  const make = (): http.Server => {
    const s = http.createServer();
    s.on('request', router.request);
    s.on('upgrade', router.upgrade);
    s.on('clientError', (_err, socket) => {
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nconnection: close\r\ncontent-length: 0\r\n\r\n');
      else socket.destroy();
    });
    return s;
  };
  const listen = (s: http.Server, host: string): Promise<void> =>
    new Promise((resolve, reject) => {
      s.once('error', reject);
      s.listen({ port, host, ipv6Only: host === '::1' }, () => {
        s.off('error', reject);
        s.on('error', (err) => console.error(`[workbench] server ${host}:`, err));
        resolve();
      });
    });
  const v4 = make();
  await listen(v4, '127.0.0.1');
  const v6 = make();
  try {
    await listen(v6, '::1');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EADDRNOTAVAIL' || code === 'EAFNOSUPPORT') {
      console.warn('[workbench] ::1 är inte tillgänglig; lyssnar bara på 127.0.0.1');
      return [v4];
    }
    v4.close();
    throw err;
  }
  return [v4, v6];
}
