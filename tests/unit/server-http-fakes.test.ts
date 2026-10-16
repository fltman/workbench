// tests/unit/server-http-fakes.test.ts — delade fejkar och hjälpare för server-http-testerna.
// Filen har inga egna tester; den implementerar de frusna gränssnitten i server/types.ts med minnesfejkar,
// så att routern kan provas mot riktiga HTTP-anslutningar utan de andra byggarnas moduler.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_FACES } from '../../shared/protocol.ts';
import type { AppInfo, AppManifest, BackendState, ChatEvent, CreateAppRequest, Scene, WindowState } from '../../shared/protocol.ts';
import type { AppGit, AppLogs, AppRegistry, Backends, Config, Paths, SceneStore, Sessions } from '../../server/types.ts';
import { loadConfig } from '../../server/config.ts';
import { makePaths } from '../../server/paths.ts';
import { createHub } from '../../server/live/hub.ts';
import type { HubEx } from '../../server/live/hub.ts';
import { createRouter } from '../../server/http/router.ts';
import type { ProxyFns, Router, RouterDeps } from '../../server/http/router.ts';
import type { GuardFn } from '../../server/http/guard.ts';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const SCRATCH = path.join(REPO, '.scratch', 'server-http');

/** En ny katalog under .scratch/server-http (under $HOME, som kontraktet kräver för riktiga appmappar). */
export function tempDir(name: string): string {
  const dir = path.join(SCRATCH, `${name}-${process.pid}-${crypto.randomBytes(3).toString('hex')}`);
  fs.mkdirSync(dir, { recursive: true });
  return fs.realpathSync.native(dir);
}

export function rmDir(dir: string): void {
  if (dir.startsWith(SCRATCH + path.sep)) fs.rmSync(dir, { recursive: true, force: true });
}

export function makeConfig(home: string, overrides: Partial<Config> = {}): Config {
  const c = loadConfig({ WORKBENCH_HOME: home, NODE_ENV: 'production', WORKBENCH_STT: 'off' } as NodeJS.ProcessEnv);
  return { ...c, ...overrides };
}

/* ------------------------------ fejkar ------------------------------ */

export type FakeRegistry = AppRegistry & {
  apps: Map<string, AppInfo>;
  manifests: Map<string, AppManifest>;
  created: CreateAppRequest[];
  add(id: string, opts?: { name?: string; backend?: boolean; faces?: AppManifest['faces']; index?: string }): AppInfo;
};

export function fakeRegistry(paths: Paths, calls: string[]): FakeRegistry {
  const apps = new Map<string, AppInfo>();
  const manifests = new Map<string, AppManifest>();
  const created: CreateAppRequest[] = [];
  function add(id: string, opts: { name?: string; backend?: boolean; faces?: AppManifest['faces']; index?: string } = {}): AppInfo {
    const dir = paths.appDir(id);
    fs.mkdirSync(dir, { recursive: true });
    if (opts.index !== undefined) fs.writeFileSync(path.join(dir, 'index.html'), opts.index);
    const m: AppManifest = { name: opts.name ?? '', faces: opts.faces, backend: opts.backend ? { entry: 'server.mjs' } : undefined };
    manifests.set(id, m);
    const info: AppInfo = {
      id, name: opts.name ?? '', faces: opts.faces ?? DEFAULT_FACES, permissions: [], built: opts.index !== undefined,
      status: 'idle', backend: opts.backend ? 'stopped' : 'none', rev: 1,
    };
    apps.set(id, info);
    return info;
  }
  return {
    apps, manifests, created, add,
    list: () => [...apps.values()],
    get: (id) => apps.get(id),
    manifest(id) {
      const m = manifests.get(id);
      if (!m) throw new Error(`okänd app ${id}`);
      return { ...m, faces: m.faces ?? DEFAULT_FACES, permissions: m.permissions ?? [] };
    },
    async create(req) {
      calls.push('registry.create');
      created.push(req);
      const id = `a${crypto.randomBytes(3).toString('hex')}`;
      const app = add(id);
      const win: WindowState = { id: `w-${id}`, appId: id, x: req.x, y: req.y, w: req.w, h: req.h, scale: req.scale, face: 0, z: 1 };
      return { app, win };
    },
    async remove(id) {
      calls.push(`registry.remove ${id}`);
      apps.delete(id);
      manifests.delete(id);
    },
    setStatus: (id, s) => void calls.push(`registry.setStatus ${id} ${s}`),
    setBackend: (id, s) => void calls.push(`registry.setBackend ${id} ${s}`),
    bumpRev: (id) => void calls.push(`registry.bumpRev ${id}`),
    refresh: (id) => void calls.push(`registry.refresh ${id}`),
  };
}

export type FakeScene = SceneStore & { scene: Scene };

export function fakeScene(calls: string[]): FakeScene {
  const scene: Scene = { version: 1, camera: { cx: 0, cy: 0, zoom: 1 }, windows: [] };
  return {
    scene,
    get: () => scene,
    window: (appId) => scene.windows.find((w) => w.appId === appId),
    upsertWindow(win) {
      calls.push(`scene.upsertWindow ${win.id}`);
      const i = scene.windows.findIndex((w) => w.id === win.id);
      if (i >= 0) scene.windows[i] = win;
      else scene.windows.push(win);
    },
    removeWindowForApp(appId) {
      const w = scene.windows.find((x) => x.appId === appId);
      scene.windows = scene.windows.filter((x) => x.appId !== appId);
      return w;
    },
    setCamera(camera) {
      calls.push(`scene.setCamera ${camera.cx} ${camera.cy} ${camera.zoom}`);
      scene.camera = camera;
    },
    flush: async () => {},
  };
}

export interface AnswerCall {
  appId: string;
  askId: string;
  decision: string;
  answers?: Record<string, string>;
  secret?: string;
}

export type FakeSessions = Sessions & { busySet: Set<string>; hist: Map<string, ChatEvent[]>; answerCalls: AnswerCall[] };

export function fakeSessions(calls: string[]): FakeSessions {
  const busySet = new Set<string>();
  const hist = new Map<string, ChatEvent[]>();
  const answerCalls: AnswerCall[] = [];
  return {
    busySet, hist, answerCalls,
    open: (id) => void calls.push(`sessions.open ${id}`),
    close: (id) => void calls.push(`sessions.close ${id}`),
    send: (id, text, via) => void calls.push(`sessions.send ${id} ${via} ${text}`),
    stop: async (id) => void calls.push(`sessions.stop ${id}`),
    answer(appId, askId, decision, answers, secret) {
      calls.push(`sessions.answer ${appId} ${askId} ${decision}`);
      answerCalls.push({ appId, askId, decision, answers, secret });
    },
    history(id, limit = 300) {
      calls.push(`sessions.history ${id} ${limit}`);
      return (hist.get(id) ?? []).slice(-limit);
    },
    noteUndo: (id) => void calls.push(`sessions.noteUndo ${id}`),
    busy: (id) => busySet.has(id),
    forget: async (id) => void calls.push(`sessions.forget ${id}`),
    closeAll: async () => void calls.push('sessions.closeAll'),
  };
}

export type FakeBackends = Backends & { nextPort: number | null; states: Map<string, BackendState> };

export function fakeBackends(calls: string[]): FakeBackends {
  const b: FakeBackends = {
    nextPort: null,
    states: new Map(),
    async ensure(id) {
      calls.push(`backends.ensure ${id}`);
      return b.nextPort;
    },
    async restart(id) {
      calls.push(`backends.restart ${id}`);
      return b.nextPort;
    },
    stop: async (id) => {
      calls.push(`backends.stop ${id}`);
      b.states.delete(id);
    },
    stopAll: async () => void calls.push('backends.stopAll'),
    state: (id) => b.states.get(id) ?? 'none',
    port: () => b.nextPort,
  };
  return b;
}

export type FakeLogs = AppLogs & { lines: { appId: string; source: string; line: string }[] };

export function fakeLogs(calls: string[]): FakeLogs {
  const lines: { appId: string; source: string; line: string }[] = [];
  return {
    lines,
    append: (appId, source, line) => void lines.push({ appId, source, line }),
    tail: () => [],
    clear: (id) => void calls.push(`logs.clear ${id}`),
  };
}

export type FakeGit = AppGit & { undoResult: boolean };

export function fakeGit(calls: string[]): FakeGit {
  const g: FakeGit = {
    undoResult: true,
    init: async () => {},
    commitAll: async () => true,
    async undo(id) {
      calls.push(`git.undo ${id}`);
      return g.undoResult;
    },
  };
  return g;
}

/* ------------------------------ en router på en riktig port ------------------------------ */

export interface Started {
  port: number;
  config: Config;
  paths: Paths;
  home: string;
  calls: string[];
  hub: HubEx;
  registry: FakeRegistry;
  scene: FakeScene;
  sessions: FakeSessions;
  backends: FakeBackends;
  logs: FakeLogs;
  git: FakeGit;
  router: Router;
  server: http.Server;
  close(): Promise<void>;
}

export interface StartOptions {
  home?: string;
  root?: string;
  dev?: boolean;
  hmrPort?: number;
  guardFn?: GuardFn;
  vite?: RouterDeps['vite'];
  transcribe?: RouterDeps['transcribe'];
  proxy?: ProxyFns;
  distDir?: string;
  ideas?: RouterDeps['ideas'];
  route?: RouterDeps['route'];
}

export const noProxy: ProxyFns = {
  proxyHttp: (_req, res) => {
    res.writeHead(599);
    res.end('proxyHttp');
  },
  proxyUpgrade: (_req, socket) => socket.destroy(),
};

export async function startRouter(opts: StartOptions = {}): Promise<Started> {
  const home = opts.home ?? tempDir('home');
  const config = makeConfig(home, { root: opts.root ?? REPO, dev: opts.dev ?? false, ...(opts.hmrPort ? { hmrPort: opts.hmrPort } : {}) });
  const paths = makePaths(config);
  const calls: string[] = [];
  const hub = createHub();
  const registry = fakeRegistry(paths, calls);
  const scene = fakeScene(calls);
  const sessions = fakeSessions(calls);
  const backends = fakeBackends(calls);
  const logs = fakeLogs(calls);
  const git = fakeGit(calls);
  const server = http.createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  config.port = (server.address() as { port: number }).port;
  const router = createRouter({
    config, paths, hub, scene, registry, logs, git, backends, sessions,
    proxy: opts.proxy ?? noProxy,
    transcribe: opts.transcribe ?? (async () => {
      throw new Error('ingen stt i testet');
    }),
    vite: opts.vite ?? null,
    ideas: opts.ideas,
    route: opts.route,
    distDir: opts.distDir,
    guardFn: opts.guardFn,
  });
  server.on('request', router.request);
  server.on('upgrade', router.upgrade);
  return {
    port: config.port, config, paths, home, calls, hub, registry, scene, sessions, backends, logs, git, router, server,
    async close() {
      hub.closeAll();
      router.close();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

/* ------------------------------ HTTP-klient med full kontroll över huvudena ------------------------------ */

export interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  text: string;
}

export function request(
  port: number,
  opts: { method?: string; path: string; host?: string; headers?: Record<string, string>; body?: string | Buffer },
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: opts.method ?? 'GET',
        path: opts.path,
        headers: { host: opts.host ?? `localhost:${port}`, ...(opts.headers ?? {}) },
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks);
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body, text: body.toString('utf8') });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(opts.body);
  });
}

/** Huvuden som Chrome skickar för en navigering som användaren själv startat. */
export const NAV: Record<string, string> = { 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };

/** Huvuden för en fetch/XHR från samma origin (Origin skickas av Chrome bara vid annat än GET/HEAD). */
export function sameOrigin(origin?: string): Record<string, string> {
  return {
    'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty',
    ...(origin ? { origin } : {}),
  };
}

/**
 * En planterad läcka: en "vakt" som bara sorterar på värdnamnet och aldrig fäller något.
 * Testerna visar först att deras detektor larmar med den, sedan att den riktiga vakten fäller samma förfrågan.
 */
export const leakyGuard: GuardFn = (req) => {
  const host = String(req.headers.host ?? '').toLowerCase().replace(/:\d+$/, '');
  if (host.endsWith('.localhost')) return { ok: true, kind: 'app', appId: host.slice(0, -'.localhost'.length) };
  return { ok: true, kind: 'shell' };
};
