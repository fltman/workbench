// server/http/guard.ts — vakten (CONTRACT §4.1). Körs FÖRST för varje request och upgrade på båda servrarna,
// före Vite, REST, /ws, /__wb/* och proxyn. Ren funktion: läser bara metod, sökväg och huvuden.
import type { IncomingHttpHeaders } from 'node:http';
import { APP_ID_RE } from '../../shared/protocol.ts';
import { header } from './util.ts';

export type GuardDecision =
  | { ok: true; kind: 'shell' }
  | { ok: true; kind: 'app'; appId: string }
  | { ok: false; status: 308 | 403 | 421; reason: string; location?: string };

export interface GuardRequest {
  method?: string;
  url?: string;
  headers: IncomingHttpHeaders;
}

export interface GuardOptions {
  port: number;
  /** Finns appen i registret? */
  appExists(appId: string): boolean;
  /** true för 'upgrade' (WebSocket). */
  upgrade: boolean;
}

export type GuardFn = (req: GuardRequest, opts: GuardOptions) => GuardDecision;

export function shellOrigin(port: number): string {
  return `http://localhost:${port}`;
}

export function appOrigin(appId: string, port: number): string {
  return `http://${appId}.localhost:${port}`;
}

const SAFE_SITES = new Set(['same-origin', 'none']);

function deny(status: 403 | 421, reason: string): GuardDecision {
  return { ok: false, status, reason };
}

/** Sökvägen för en 308 till localhost. Bara en vanlig absolut sökväg med synliga ASCII-tecken följer med. */
function redirectPath(url: string | undefined): string {
  return url && url.startsWith('/') && !url.startsWith('//') && /^[\x21-\x7e]*$/.test(url) ? url : '/';
}

export const guard: GuardFn = (req, opts) => {
  const host = header(req.headers, 'host');
  if (!host) return deny(421, 'Host saknas');
  const suffix = `:${opts.port}`;
  // Host är skiftlägesokänsligt; webbläsare skickar gemener.
  const h = host.trim().toLowerCase();
  if (!h.endsWith(suffix)) return deny(421, 'fel port eller värd');
  const name = h.slice(0, -suffix.length);

  const method = (req.method ?? 'GET').toUpperCase();
  const origin = header(req.headers, 'origin');
  const site = header(req.headers, 'sec-fetch-site');
  const mode = header(req.headers, 'sec-fetch-mode');
  const dest = header(req.headers, 'sec-fetch-dest');

  if (name === 'localhost') {
    const own = shellOrigin(opts.port);
    if (origin !== undefined && origin !== own) return deny(403, 'främmande Origin');
    if (site !== undefined && !SAFE_SITES.has(site) && !(mode === 'navigate' && dest === 'document')) {
      return deny(403, 'främmande Sec-Fetch-Site');
    }
    if ((opts.upgrade || (method !== 'GET' && method !== 'HEAD')) && origin !== own) {
      return deny(403, 'Origin krävs');
    }
    return { ok: true, kind: 'shell' };
  }

  if (name === '127.0.0.1' || name === '[::1]') {
    if (method === 'GET' || method === 'HEAD') {
      return { ok: false, status: 308, reason: 'till localhost', location: `http://localhost:${opts.port}${redirectPath(req.url)}` };
    }
    return deny(421, 'IP-adress som värd');
  }

  if (name.endsWith('.localhost')) {
    const appId = name.slice(0, -'.localhost'.length);
    if (APP_ID_RE.test(appId) && opts.appExists(appId)) {
      if (origin !== undefined && origin !== appOrigin(appId, opts.port)) return deny(403, 'främmande Origin');
      // Backendens /api/* och /__wb/* får bara navigeras till som dokument, aldrig ramas in av en annan
      // webbplats (SEC-4): annars kan vilken sida som helst rama in och trigga en backends GET-routes.
      // Skalet ramar bara in appens sidor; OAuth-återanrop är toppnavigeringar och fungerar som förut.
      const p = (req.url ?? '/').split('?')[0];
      const api = p === '/api' || p.startsWith('/api/') || p.startsWith('/__wb/');
      if (
        site !== undefined &&
        !SAFE_SITES.has(site) &&
        !(mode === 'navigate' && (dest === 'document' || (dest === 'iframe' && !api)))
      ) {
        return deny(403, 'främmande Sec-Fetch-Site');
      }
      // Service workers kan aldrig registreras, så att inget överlever ett ångra (§4.1).
      if (header(req.headers, 'service-worker') !== undefined) return deny(403, 'service worker');
      return { ok: true, kind: 'app', appId };
    }
  }

  // Allt annat: skydd mot DNS-rebinding.
  return deny(421, 'okänd värd');
};
