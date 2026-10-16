// server.ts — testrigg för appbryggan. En Node-process med två roller, som den riktiga servern:
//   http://localhost:<port>/          skalets testsida (shell.html + shell.ts, som laddar web/src/bridge.ts)
//   http://<id>.localhost:<port>/     testappar med /__wb/wb.js injicerat först i <head> (CONTRACT §7.2),
//                                     plus /__wb/app.json, /__wb/store och /__wb/log i minnet
// TypeScript transpileras vid varje förfrågan. ?leak=<namn> serverar en planterad läcka (leaks.ts).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import type { FaceDef } from '../../shared/protocol.ts';
import { BRIDGE_LEAKS, WB_LEAKS, applyLeak } from './leaks.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');

export interface HarnessApp {
  id: string;
  name: string;
  faces: FaceDef[];
}

export const HARNESS_APPS: HarnessApp[] = [
  { id: 'probe', name: 'Sond', faces: [{ id: 'main', page: 'index.html' }, { id: 'back', page: 'back.html', label: 'Baksida' }] },
  { id: 'long', name: 'Lång', faces: [{ id: 'main', page: 'index.html' }] },
  { id: 'other', name: 'Annan', faces: [{ id: 'main', page: 'index.html' }] },
];

export interface LogEntry {
  level: 'error' | 'warn' | 'log';
  text: string;
}

export interface Harness {
  port: number;
  shell: string;
  appOrigin(id: string): string;
  /** Loggposter som kommit till POST /__wb/log, per app. */
  logs: Map<string, LogEntry[]>;
  /** Antal POST /__wb/log per app, även misslyckade. */
  logPosts: Map<string, number>;
  /** Appar vars /__wb/log svarar 500. */
  failLog: Set<string>;
  stores: Map<string, Map<string, string>>;
  /** Förfrågningar mot /__wb/* som vakten (§4.1) hade fällt. Ska vara tom. */
  violations: string[];
  close(): Promise<void>;
}

const LOG_LEVELS = new Set(['error', 'warn', 'log']);
const KEY_RE = /^[A-Za-z0-9._-]{1,100}$/;

function transpile(file: string, leak: string | null, leaks: Record<string, readonly (readonly [string, string])[]>): string {
  let src = fs.readFileSync(file, 'utf8');
  if (leak) {
    const patches = leaks[leak];
    if (!patches) throw new Error(`okänd läcka: ${leak}`);
    src = applyLeak(src, patches);
  }
  return ts.transpileModule(src, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, verbatimModuleSyntax: true },
    fileName: path.basename(file),
  }).outputText;
}

function readBody(req: http.IncomingMessage, limit: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size <= limit) chunks.push(c);
    });
    req.on('end', () => resolve(size > limit ? null : Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Som §7.2: skriptet direkt efter <head…>, annars efter <html…>, annars efter doctype, annars först. */
function inject(html: string, tag: string): string {
  for (const re of [/<head(\s[^>]*)?>/i, /<html(\s[^>]*)?>/i, /^(\s|<!--[\s\S]*?-->)*<!doctype[^>]*>/i]) {
    const m = re.exec(html);
    if (m) return html.slice(0, m.index + m[0].length) + tag + html.slice(m.index + m[0].length);
  }
  return tag + html;
}

/** Ledig port på både 127.0.0.1 och ::1 (testerna får inte krocka när flera körningar pågår samtidigt). */
async function freePort(): Promise<number> {
  for (let i = 0; i < 20; i++) {
    const a = http.createServer();
    const p = await new Promise<number>((resolve, reject) => {
      a.once('error', reject);
      a.listen(0, '127.0.0.1', () => resolve((a.address() as { port: number }).port));
    });
    const b = http.createServer();
    const ok = await new Promise<boolean>((resolve) => {
      b.once('error', () => resolve(false));
      b.listen(p, '::1', () => resolve(true));
    });
    await Promise.all([a, b].map((s) => new Promise<void>((r) => (s.listening ? s.close(() => r()) : r()))));
    if (ok) return p;
  }
  throw new Error('hittade ingen ledig port');
}

/**
 * Startar riggen på port (standard 8242). Är porten upptagen och fallback satt, används en ledig port
 * som systemet väljer, så att två testkörningar samtidigt inte fäller varandra.
 */
export async function startHarness(wanted = 8242, fallback = false): Promise<Harness> {
  try {
    return await listenHarness(wanted);
  } catch (err) {
    if (!fallback || (err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
  }
  for (let i = 0; ; i++) {
    try {
      return await listenHarness(await freePort());
    } catch (err) {
      if (i >= 4 || (err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
    }
  }
}

async function listenHarness(port: number): Promise<Harness> {
  const shell = `http://localhost:${port}`;
  const appOrigin = (id: string): string => `http://${id}.localhost:${port}`;
  const logs = new Map<string, LogEntry[]>();
  const logPosts = new Map<string, number>();
  const failLog = new Set<string>();
  const stores = new Map<string, Map<string, string>>();
  const violations: string[] = [];
  const logRate = new Map<string, { t: number; tokens: number }>();

  function send(res: http.ServerResponse, status: number, body: string | Buffer, type: string, extra: Record<string, string> = {}): void {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...extra });
    res.end(body);
  }
  const json = (res: http.ServerResponse, status: number, v: unknown): void => send(res, status, JSON.stringify(v), 'application/json; charset=utf-8');
  const empty = (res: http.ServerResponse, status: number): void => {
    res.writeHead(status, { 'cache-control': 'no-store' });
    res.end();
  };

  async function handleWb(app: HarnessApp, req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    const p = url.pathname;
    if (p === '/__wb/wb.js' && req.method === 'GET') {
      let src = fs.readFileSync(path.join(ROOT, 'sdk/wb.js'), 'utf8');
      const leak = url.searchParams.get('leak');
      if (leak) {
        const patches = (WB_LEAKS as Record<string, readonly (readonly [string, string])[]>)[leak];
        if (!patches) return send(res, 400, `okänd läcka ${leak}`, 'text/plain; charset=utf-8');
        src = applyLeak(src, patches);
      }
      return send(res, 200, src, 'text/javascript; charset=utf-8');
    }
    if (p === '/__wb/app.json' && req.method === 'GET') return json(res, 200, { id: app.id, name: app.name, faces: app.faces });
    if (p === '/__wb/log' && req.method === 'POST') {
      logPosts.set(app.id, (logPosts.get(app.id) ?? 0) + 1);
      if (failLog.has(app.id)) return empty(res, 500);
      const body = await readBody(req, 1024 * 1024);
      let list: unknown;
      try {
        list = JSON.parse(String(body));
      } catch {
        return empty(res, 400);
      }
      if (!Array.isArray(list) || list.length > 50) return empty(res, 400);
      for (const e of list as Array<Record<string, unknown>>) {
        if (!e || typeof e.text !== 'string' || e.text.length > 2000 || !LOG_LEVELS.has(e.level as string)) return empty(res, 400);
      }
      // Högst 100 poster/s per app (§7.2), som en hink så att buntarnas tidsjitter inte spelar in.
      const now = Date.now();
      const r = logRate.get(app.id) ?? { t: now, tokens: 100 };
      r.tokens = Math.min(100, r.tokens + ((now - r.t) / 1000) * 100);
      r.t = now;
      const kept = (list as LogEntry[]).slice(0, Math.floor(r.tokens));
      r.tokens -= kept.length;
      logRate.set(app.id, r);
      logs.set(app.id, [...(logs.get(app.id) ?? []), ...kept]);
      return empty(res, 204);
    }
    if (p === '/__wb/store' || p.startsWith('/__wb/store/')) {
      const st = stores.get(app.id) ?? new Map<string, string>();
      stores.set(app.id, st);
      if (p === '/__wb/store') {
        if (req.method !== 'GET') return empty(res, 405);
        const all: Record<string, unknown> = {};
        for (const [k, v] of st) all[k] = JSON.parse(v);
        return json(res, 200, all);
      }
      const key = p.slice('/__wb/store/'.length);
      if (!KEY_RE.test(key)) return empty(res, 400);
      if (req.method === 'GET') {
        if (st.has(key)) return send(res, 200, st.get(key) as string, 'application/json; charset=utf-8');
        return empty(res, req.headers['x-wb-optional'] === '1' ? 204 : 404); // som servern (K6)
      }
      if (req.method === 'DELETE') {
        const had = st.delete(key);
        return empty(res, had ? 204 : 404);
      }
      if (req.method === 'PUT') {
        const body = await readBody(req, 1024 * 1024);
        if (body === null) return empty(res, 413);
        try {
          JSON.parse(String(body));
        } catch {
          return empty(res, 400);
        }
        st.set(key, String(body));
        return empty(res, 204);
      }
      return empty(res, 405);
    }
    return empty(res, 404);
  }

  function handleAppPage(app: HarnessApp, res: http.ServerResponse, url: URL): void {
    const rel = url.pathname === '/' ? app.faces[0].page : decodeURIComponent(url.pathname.slice(1));
    const dir = path.join(HERE, 'apps', app.id);
    const file = path.resolve(dir, rel);
    if (!file.startsWith(dir + path.sep) || !fs.existsSync(file)) return send(res, 404, '', 'text/html; charset=utf-8');
    const ext = path.extname(file);
    if (ext === '.js') return send(res, 200, fs.readFileSync(file), 'text/javascript; charset=utf-8');
    if (ext !== '.html') return send(res, 404, '', 'text/plain');
    const leak = url.searchParams.get('leak');
    let tag = `<script src="/__wb/wb.js${leak ? `?leak=${encodeURIComponent(leak)}` : ''}"></script>`;
    // Bara för testet av toppnivån: en spion före wb.js som ser varje postMessage.
    if (url.searchParams.has('spy')) {
      tag = '<script>window.__posts=[];const __pm=window.postMessage.bind(window);window.postMessage=function(m,o){window.__posts.push([m,o]);return __pm(m,o)};</script>' + tag;
    }
    const html = inject(fs.readFileSync(file, 'utf8'), tag);
    send(res, 200, html, 'text/html; charset=utf-8', {
      'content-security-policy': `frame-ancestors ${shell}`,
      'referrer-policy': 'same-origin',
    });
  }

  function handleShell(req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
    const headers = {
      'content-security-policy':
        `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://localhost:${port}; ` +
        `frame-src http://*.localhost:${port}; img-src 'self' data: blob:; media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`,
      'x-frame-options': 'DENY',
      'referrer-policy': 'same-origin',
    };
    const leak = url.searchParams.get('leak');
    try {
      if (url.pathname === '/') return send(res, 200, fs.readFileSync(path.join(HERE, 'shell.html')), 'text/html; charset=utf-8', headers);
      if (url.pathname === '/shell.ts') return send(res, 200, transpile(path.join(HERE, 'shell.ts'), null, {}), 'text/javascript; charset=utf-8');
      if (url.pathname === '/web/src/bridge.ts') return send(res, 200, transpile(path.join(ROOT, 'web/src/bridge.ts'), leak, BRIDGE_LEAKS), 'text/javascript; charset=utf-8');
      // bridge.ts importerar den delade kontrollen av det som lämnas till appar (§10.9).
      if (url.pathname === '/shared/open.ts') return send(res, 200, transpile(path.join(ROOT, 'shared/open.ts'), null, {}), 'text/javascript; charset=utf-8');
    } catch (err) {
      return send(res, 500, String(err), 'text/plain; charset=utf-8');
    }
    if (url.pathname === '/favicon.ico') return empty(res, 204);
    empty(res, req.method === 'GET' ? 404 : 405);
  }

  async function handler(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const host = String(req.headers.host ?? '').toLowerCase();
    const url = new URL(req.url ?? '/', 'http://x');
    if (host === `localhost:${port}`) return handleShell(req, res, url);
    const m = /^([a-z][a-z0-9]{2,30})\.localhost:(\d+)$/.exec(host);
    const app = m && Number(m[2]) === port ? HARNESS_APPS.find((a) => a.id === m[1]) : undefined;
    if (!app) return empty(res, 421);
    if (url.pathname.startsWith('/__wb/')) {
      // Samma regler som vakten för appar (§4.1); bryggan ska aldrig bryta mot dem.
      const origin = req.headers.origin;
      const site = req.headers['sec-fetch-site'];
      if ((origin !== undefined && origin !== appOrigin(app.id)) || (site !== undefined && site !== 'same-origin' && site !== 'none')) {
        violations.push(`${req.method} ${host}${url.pathname} origin=${origin} sec-fetch-site=${site}`);
        return empty(res, 403);
      }
      return handleWb(app, req, res, url);
    }
    return handleAppPage(app, res, url);
  }

  const servers: http.Server[] = [];
  for (const addr of ['127.0.0.1', '::1']) {
    try {
      servers.push(
        await new Promise<http.Server>((resolve, reject) => {
          const s = http.createServer((req, res) => {
            handler(req, res).catch((err: unknown) => {
              if (!res.headersSent) send(res, 500, String(err), 'text/plain; charset=utf-8');
              else res.destroy();
            });
          });
          s.once('error', reject);
          s.listen(port, addr, () => resolve(s));
        }),
      );
    } catch (err) {
      for (const s of servers) s.close();
      throw err;
    }
  }

  return {
    port,
    shell,
    appOrigin,
    logs,
    logPosts,
    failLog,
    stores,
    violations,
    close: async () => {
      await Promise.all(
        servers.map(
          (s) =>
            new Promise<void>((resolve) => {
              s.closeAllConnections();
              s.close(() => resolve());
            }),
        ),
      );
    },
  };
}

// Manuell körning: node tests/bridge-harness/server.ts [port]
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2] ?? 8242);
  const h = await startHarness(port);
  console.log(`bryggans testrigg: ${h.shell}/  (appar: ${HARNESS_APPS.map((a) => h.appOrigin(a.id)).join(', ')})`);
}
