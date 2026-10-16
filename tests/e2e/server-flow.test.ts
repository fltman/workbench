// tests/e2e/server-flow.test.ts — hela servern (CONTRACT §7–§9) mot låtsas-Claude, i en riktig process.
// Startar `node server/main.ts` med WORKBENCH_FAKE_CLAUDE=1, WORKBENCH_FAKE_SPEED=4, egna portar (8270/8279)
// och en tillfällig WORKBENCH_HOME under .scratch. Flödet (en ordnad kedja): snapshot → skapa app →
// chat.open/send → händelseström och turslut → commit och rev → appens origin serverar den byggda sidan med
// wb.js först → store fram och tillbaka → backend-appen via proxyn → "fråga" (behörighet) → "hemlig"
// (secret, värdet bara i data/secrets.json) → ångra → ta bort (papperskorg + 421). Till sist en skärmbild
// genom shots.ts mot den levande origin (riktig Chrome): viewport-avrundning och avbruten främmande navigering.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { WebSocket } from 'ws';
import { chromium } from 'playwright-core';
import type { Browser } from 'playwright-core';
import { createShots } from '../../server/claude/shots.ts';
import { tryApp } from '../../server/claude/tools.ts';
import type { ToolDeps } from '../../server/claude/tools.ts';
import type { AppInfo, ChatEvent, Scene, ServerMsg, WindowState } from '../../shared/protocol.ts';
import type { AppRegistry, SceneStore, Shots } from '../../server/types.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// Andra portar med WB_E2E_PORT (HMR = porten + 9), så att flera körningar inte krockar.
const PORT = Number(process.env.WB_E2E_PORT) || 8270;
const HMR = PORT + 9;
const SHELL = `http://localhost:${PORT}`;
// Tillfälliga hem och felloggar: WB_E2E_DIR, annars .scratch/integrator.
const SCRATCH = process.env.WB_E2E_DIR ? path.resolve(process.env.WB_E2E_DIR) : path.join(ROOT, '.scratch', 'integrator');
const execFileP = promisify(execFile);

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';

interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
  body: Buffer;
}

/** Rå HTTP mot 127.0.0.1:PORT med en valfri Host (så att <id>.localhost kan nås utan DNS). */
function req(opts: { method?: string; path: string; host?: string; headers?: Record<string, string>; body?: string | Buffer }): Promise<Res> {
  return new Promise((resolve, reject) => {
    const payload = opts.body === undefined ? undefined : Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(opts.body);
    const r = http.request(
      {
        host: '127.0.0.1',
        port: PORT,
        method: opts.method ?? 'GET',
        path: opts.path,
        headers: {
          host: opts.host ?? `localhost:${PORT}`,
          'user-agent': UA,
          accept: '*/*',
          ...(payload ? { 'content-length': String(payload.length) } : {}),
          ...(opts.headers ?? {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks);
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text: body.toString('utf8'), body });
        });
      },
    );
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

/** Headrar en webbläsare skickar för en same-origin fetch/XHR. */
const sameOrigin = (origin: string) => ({ origin, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' });
/** Headrar för en dokument-/iframe-navigering (ingen Origin). */
const navigate = { 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };

const appHost = (id: string) => `${id}.localhost:${PORT}`;
const appOriginOf = (id: string) => `http://${id}.localhost:${PORT}`;

/** En WS-klient som samlar alla ServerMsg. */
class Client {
  ws: WebSocket;
  msgs: ServerMsg[] = [];
  #waiters: (() => void)[] = [];
  constructor() {
    this.ws = new WebSocket(`ws://localhost:${PORT}/ws`, { origin: SHELL, headers: { 'user-agent': UA } });
    this.ws.on('message', (data) => {
      try {
        this.msgs.push(JSON.parse(String(data)) as ServerMsg);
      } catch {
        /* strunta */
      }
      for (const w of this.#waiters.splice(0)) w();
    });
  }
  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws.once('open', () => {
        this.send({ t: 'hello', v: 1 }); // servern svarar med snapshot efter hello (§7.1)
        resolve();
      });
      this.ws.once('error', reject);
    });
  }
  send(msg: unknown): void {
    this.ws.send(JSON.stringify(msg));
  }
  chat(appId: string): ChatEvent[] {
    return this.msgs.filter((m): m is Extract<ServerMsg, { t: 'chat' }> => m.t === 'chat' && m.appId === appId).map((m) => m.ev);
  }
  async waitFor(pred: () => boolean | Promise<boolean>, ms = 30_000, what = 'villkoret'): Promise<void> {
    const end = Date.now() + ms;
    while (!(await pred())) {
      if (Date.now() > end) throw new Error(`timeout: ${what}`);
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 200);
        this.#waiters.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }
  }
  /** Väntar tills appens tur är slut (turn end efter minst en turn start). */
  async turnEnd(appId: string, ms = 30_000): Promise<Extract<ChatEvent, { k: 'turn' }>> {
    await this.waitFor(() => this.chat(appId).some((e) => e.k === 'turn' && e.phase === 'end'), ms, 'turslut');
    return this.chat(appId).filter((e): e is Extract<ChatEvent, { k: 'turn' }> => e.k === 'turn' && e.phase === 'end').at(-1)!;
  }
  pendingAsk(appId: string): Extract<ChatEvent, { k: 'ask' }> | undefined {
    const done = new Set(this.chat(appId).filter((e) => e.k === 'ask-done').map((e) => (e as { id: string }).id));
    return this.chat(appId).filter((e): e is Extract<ChatEvent, { k: 'ask' }> => e.k === 'ask' && !done.has(e.id)).at(-1);
  }
  close(): void {
    try {
      this.ws.close();
    } catch {
      /* redan stängd */
    }
  }
}

/** git-logg i appens externa git-katalog. */
async function gitCommits(home: string, id: string): Promise<string[]> {
  const gitDir = path.join(home, 'data', 'apps', id, 'git');
  const workTree = path.join(home, 'apps', id);
  const { stdout } = await execFileP(
    'git',
    ['-c', 'core.hooksPath=/dev/null', `--git-dir=${gitDir}`, `--work-tree=${workTree}`, 'log', '--format=%s'],
    { env: { PATH: process.env.PATH ?? '', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }, encoding: 'utf8' },
  );
  return stdout.split('\n').filter(Boolean);
}

let server: ChildProcess | null = null;
let home = '';
let browser: Browser | null = null;

async function startServer(): Promise<void> {
  fs.mkdirSync(SCRATCH, { recursive: true });
  home = fs.realpathSync.native(fs.mkdtempSync(path.join(SCRATCH, 'e2e-home-')));
  server = spawn('node', [path.join(ROOT, 'server', 'main.ts')], {
    env: {
      ...process.env,
      WORKBENCH_PORT: String(PORT),
      WORKBENCH_HMR_PORT: String(HMR),
      WORKBENCH_HOME: home,
      WORKBENCH_FAKE_CLAUDE: '1',
      WORKBENCH_FAKE_SPEED: '4',
      NODE_ENV: 'development',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logFile = path.join(home, 'server.log');
  server.stdout?.on('data', (d: Buffer) => fs.appendFileSync(logFile, d));
  server.stderr?.on('data', (d: Buffer) => fs.appendFileSync(logFile, d));
  // Vänta tills skalet svarar.
  const end = Date.now() + 30_000;
  for (;;) {
    try {
      const r = await req({ path: '/api/snapshot', headers: sameOrigin(SHELL) });
      if (r.status === 200) break;
    } catch {
      /* inte uppe än */
    }
    if (Date.now() > end) throw new Error('servern kom inte upp');
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function createApp(req0: { x: number; y: number; w: number; h: number; scale: number }): Promise<{ app: AppInfo; win: WindowState }> {
  const r = await req({
    method: 'POST',
    path: '/api/apps',
    headers: { ...sameOrigin(SHELL), 'content-type': 'application/json' },
    body: JSON.stringify(req0),
  });
  assert.equal(r.status, 200, `POST /api/apps: ${r.status} ${r.text}`);
  return JSON.parse(r.text) as { app: AppInfo; win: WindowState };
}

/** Kör en hel tur och returnerar app-id. */
async function build(c: Client, text: string, req0 = { x: 0, y: 0, w: 640, h: 480, scale: 1 }): Promise<string> {
  const { app } = await createApp(req0);
  c.send({ t: 'chat.open', appId: app.id });
  c.send({ t: 'chat.send', appId: app.id, text, via: 'text' });
  return app.id;
}

/** Fakeservern kan vara mitt i att starta om backenden när turen är klar; vänta in running. */
async function snapshotApp(id: string): Promise<AppInfo | undefined> {
  const r = await req({ path: '/api/snapshot', headers: sameOrigin(SHELL) });
  const { apps } = JSON.parse(r.text) as { scene: Scene; apps: AppInfo[] };
  return apps.find((a) => a.id === id);
}

describe('server-flow (låtsas-Claude, riktig process)', { timeout: 180_000 }, () => {
  let c: Client;

  before(async () => {
    try {
      await startServer();
      c = new Client();
      await c.open();
      await c.waitFor(() => c.msgs.some((m) => m.t === 'snapshot'), 5000, 'snapshot');
    } catch (err) {
      let log = '';
      try {
        if (home) log = fs.readFileSync(path.join(home, 'server.log'), 'utf8');
      } catch {
        /* ingen logg */
      }
      fs.writeFileSync(path.join(SCRATCH, 'before-err.txt'), `${String((err as Error).stack ?? err)}\n--- server.log ---\n${log}`);
      throw err;
    }
  });

  after(async () => {
    c?.close();
    await browser?.close().catch(() => {});
    if (server?.pid) {
      try {
        process.kill(server.pid, 'SIGTERM');
      } catch {
        /* redan borta */
      }
      await new Promise((r) => setTimeout(r, 1500));
      try {
        process.kill(server.pid, 'SIGKILL');
      } catch {
        /* avslutad */
      }
    }
    if (home) fs.rmSync(home, { recursive: true, force: true });
  });

  test('snapshot via hello', () => {
    const snap = c.msgs.find((m): m is Extract<ServerMsg, { t: 'snapshot' }> => m.t === 'snapshot');
    assert.ok(snap, 'ingen snapshot');
    assert.equal(snap.scene.version, 1);
    assert.deepEqual(snap.apps, []);
  });

  test('skapa app, bygg en anteckningsapp, händelseström och turslut', async () => {
    const id = await build(c, 'Jag vill ha anteckningar');
    const end = await c.turnEnd(id);
    assert.equal(end.ok, true);
    assert.equal(end.interrupted, false);
    const kinds = c.chat(id).map((e) => (e.k === 'turn' ? `turn:${e.phase}` : e.k));
    // user, turn start, (delta|text), minst ett tool + tool-done, text, turn end — i den ordningen i stort.
    assert.equal(kinds[0], 'user');
    assert.equal(kinds[1], 'turn:start');
    assert.equal(kinds.at(-1), 'turn:end');
    assert.ok(kinds.includes('tool') && kinds.includes('tool-done'), 'minst ett verktyg');
    assert.ok(c.chat(id).some((e) => e.k === 'text' && /Klart/.test((e as { text: string }).text)));
    (c as unknown as { notesId: string }).notesId = id;
  });

  test('commit bortom fröet, rev bumpad, built = true', async () => {
    const id = (c as unknown as { notesId: string }).notesId;
    await c.waitFor(async () => !!(await snapshotApp(id))?.built, 10_000, 'built').catch(() => {});
    const commits = await gitCommits(home, id);
    assert.ok(commits.length >= 2, `förväntade commit bortom fröet: ${JSON.stringify(commits)}`);
    assert.equal(commits.at(-1), 'Ny app');
    assert.equal(commits[0], 'Jag vill ha anteckningar');
    const info = await snapshotApp(id);
    assert.equal(info?.built, true);
    // rev bumpas vid turslut: 'app'-meddelanden med strikt växande rev.
    const revs = c.msgs.filter((m): m is Extract<ServerMsg, { t: 'app' }> => m.t === 'app' && m.app.id === id).map((m) => m.app.rev);
    assert.ok(revs.length >= 2 && revs.at(-1)! > revs[0], `rev bumpades inte: ${JSON.stringify(revs)}`);
  });

  test('appens origin serverar den byggda sidan med wb.js injicerat först', async () => {
    const id = (c as unknown as { notesId: string }).notesId;
    const r = await req({ path: '/', host: appHost(id), headers: navigate });
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-type'], 'text/html; charset=utf-8');
    assert.equal(r.headers['content-security-policy'], `frame-ancestors http://localhost:${PORT}`);
    const wbAt = r.text.indexOf('<script src="/__wb/wb.js"></script>');
    assert.ok(wbAt >= 0, 'wb.js injicerades inte');
    const firstScript = r.text.toLowerCase().indexOf('<script');
    assert.equal(wbAt, firstScript, 'wb.js ska stå före alla andra skript');
    // wb.js serveras och har rätt typ.
    const js = await req({ path: '/__wb/wb.js', host: appHost(id), headers: sameOrigin(appOriginOf(id)) });
    assert.equal(js.status, 200);
    assert.match(String(js.headers['content-type']), /text\/javascript/);
    assert.equal(js.headers['cache-control'], 'no-store');
  });

  test('store fram och tillbaka på appens origin', async () => {
    const id = (c as unknown as { notesId: string }).notesId;
    const origin = appOriginOf(id);
    const put = await req({
      method: 'PUT',
      path: '/__wb/store/anteckningar',
      host: appHost(id),
      headers: { ...sameOrigin(origin), 'content-type': 'application/json' },
      body: JSON.stringify(['Köp mjölk', 'Ring å ä ö']),
    });
    assert.equal(put.status, 204);
    const get = await req({ path: '/__wb/store/anteckningar', host: appHost(id), headers: sameOrigin(origin) });
    assert.equal(get.status, 200);
    assert.deepEqual(JSON.parse(get.text), ['Köp mjölk', 'Ring å ä ö']);
    // Saknad nyckel ger 404.
    assert.equal((await req({ path: '/__wb/store/saknas', host: appHost(id), headers: sameOrigin(origin) })).status, 404);
    // På disk, 0600.
    const file = path.join(home, 'apps', id, 'data', 'store.json');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  });

  test('backend-app: GET /api/tid genom proxyn från den sandlådade backenden', async () => {
    const id = await build(c, 'Bygg en app med backend', { x: 800, y: 0, w: 480, h: 360, scale: 1 });
    const end = await c.turnEnd(id);
    assert.equal(end.ok, true);
    await c.waitFor(async () => (await snapshotApp(id))?.backend === 'running', 20_000, 'backend running');
    const r = await req({ path: '/api/tid', host: appHost(id), headers: sameOrigin(appOriginOf(id)) });
    assert.equal(r.status, 200, `GET /api/tid: ${r.status} ${r.text}`);
    const data = JSON.parse(r.text) as { tid: string; text: string };
    assert.ok(typeof data.text === 'string' && data.text.length > 0);
    assert.match(String(r.headers['content-type']), /application\/json/);
    (c as unknown as { backendId: string }).backendId = id;
  });

  test('"fråga": ett behörighetskort besvaras via chat.answer', async () => {
    const id = await build(c, 'Bygg anteckningar och ställ en fråga', { x: 0, y: 600, w: 520, h: 360, scale: 1 });
    await c.waitFor(() => !!c.pendingAsk(id), 20_000, 'frågekort');
    const ask = c.pendingAsk(id)!;
    assert.equal(ask.ask.kind, 'permission');
    assert.equal((ask.ask as { title: string }).title, 'Hämta från nätet?');
    c.send({ t: 'chat.answer', appId: id, askId: ask.id, decision: 'allow' });
    const end = await c.turnEnd(id);
    assert.equal(end.ok, true);
    assert.ok(c.chat(id).some((e) => e.k === 'ask-done' && e.id === ask.id));
  });

  test('"hemlig": ett secret-kort besvaras, och värdet hamnar bara i data/secrets.json', async () => {
    const id = await build(c, 'Bygg anteckningar med en hemlig nyckel', { x: 700, y: 600, w: 520, h: 360, scale: 1 });
    await c.waitFor(() => c.pendingAsk(id)?.ask.kind === 'secret', 20_000, 'secret-kort');
    const ask = c.pendingAsk(id)!;
    const value = `hemligt-${crypto.randomBytes(8).toString('hex')}`;
    c.send({ t: 'chat.answer', appId: id, askId: ask.id, decision: 'answered', secret: value });
    const end = await c.turnEnd(id);
    assert.equal(end.ok, true);
    // Värdet i secrets.json (0600) …
    const file = path.join(home, 'apps', id, 'data', 'secrets.json');
    const secrets = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, string>;
    assert.ok(Object.values(secrets).includes(value), 'värdet sparades inte i secrets.json');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    // … och ingen annanstans (planterad kontroll: en känd sträng ska verkligen gå att hitta).
    const scan = (p: string): boolean => {
      try {
        return fs.readFileSync(p, 'utf8').includes(value);
      } catch {
        return false;
      }
    };
    assert.equal(scan(file), true, 'kalibrering: sökningen hittar värdet i secrets.json');
    assert.equal(scan(path.join(home, 'data', 'apps', id, 'chat.jsonl')), false, 'värdet läckte till chat.jsonl');
    assert.equal(scan(path.join(home, 'data', 'apps', id, 'logs.txt')), false, 'värdet läckte till logs.txt');
    assert.equal(scan(path.join(home, 'server.log')), false, 'värdet läckte till serverns konsol');
    assert.ok(!c.msgs.some((m) => JSON.stringify(m).includes(value)), 'värdet läckte över WebSocket');
  });

  test('ångra: note, ok och rev bumpad', async () => {
    const id = (c as unknown as { backendId: string }).backendId;
    const before = (await snapshotApp(id))!.rev;
    const commitsBefore = await gitCommits(home, id);
    const r = await req({ method: 'POST', path: `/api/apps/${id}/undo`, headers: sameOrigin(SHELL) });
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.text), { ok: true });
    await c.waitFor(() => c.chat(id).some((e) => e.k === 'note' && /Ångrade/.test((e as { text: string }).text)), 10_000, 'ångra-note');
    await c.waitFor(async () => ((await snapshotApp(id))?.rev ?? 0) > before, 10_000, 'rev efter ångra');
    const commitsAfter = await gitCommits(home, id);
    assert.equal(commitsAfter.length, commitsBefore.length - 1, 'en commit ångrades');
  });

  test('ta bort: papperskorg med rätt layout, och appens origin ger 421', async () => {
    const id = (c as unknown as { notesId: string }).notesId;
    const r = await req({ method: 'DELETE', path: `/api/apps/${id}`, headers: sameOrigin(SHELL) });
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.text), { ok: true });
    await c.waitFor(() => c.msgs.some((m) => m.t === 'app.removed' && m.appId === id), 5000, 'app.removed');
    // Ordningen: scene.windowRemoved före app.removed.
    const idxWin = c.msgs.findIndex((m) => m.t === 'scene.windowRemoved' && m.id === `w-${id}`);
    const idxApp = c.msgs.findIndex((m) => m.t === 'app.removed' && m.appId === id);
    assert.ok(idxWin >= 0 && idxWin < idxApp, 'scene.windowRemoved ska komma före app.removed');
    // Papperskorgens layout.
    const trash = fs.readdirSync(path.join(home, 'data', 'trash')).filter((n) => n.startsWith(`${id}-`));
    assert.equal(trash.length, 1, `papperskorgen: ${JSON.stringify(trash)}`);
    assert.match(trash[0], new RegExp(`^${id}-\\d{8}T\\d{6}\\.\\d{3}Z$`));
    assert.ok(fs.existsSync(path.join(home, 'data', 'trash', trash[0], 'apps', id)));
    assert.ok(fs.existsSync(path.join(home, 'data', 'trash', trash[0], 'data', 'apps', id)));
    assert.ok(!fs.existsSync(path.join(home, 'apps', id)), 'apps/<id> flyttades');
    // Appens origin ger nu 421 (appen finns inte i registret).
    const page = await req({ path: '/', host: appHost(id), headers: navigate });
    assert.equal(page.status, 421);
  });

  test('skärmbild genom shots.ts mot den levande origin: viewport-avrundning och avbruten främmande navigering', async () => {
    // Egen app med en udda storlek; shots använder round(w)×round(h) och deviceScaleFactor 1.
    const { app, win } = await createApp({ x: 1400, y: 0, w: 517, h: 383, scale: 1 });
    // Fakeservern bygger den inte (inget chat.send): skriv en enkel sida direkt och en som navigerar bort.
    const dir = path.join(home, 'apps', app.id);
    fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html lang="sv"><head><meta charset="utf-8"><title>Prov</title></head><body style="margin:0;background:#2f6bff"><p>Hej å ä ö</p></body></html>');

    // Ett eget litet Shots med disk-läsande registry/scene (shots använder bara get/manifest/window).
    const faces = [{ id: 'main', page: 'index.html' }];
    const registry = {
      get: (id: string) => (id === app.id ? app : undefined),
      manifest: () => ({ name: 'Prov', faces, permissions: [] }),
    } as unknown as AppRegistry;
    const scene = { window: (id: string) => (id === app.id ? win : undefined) } as unknown as SceneStore;
    const config = { port: PORT } as { port: number };
    const logLines: string[] = [];
    const logs = { append: (_a: string, _s: string, l: string) => void logLines.push(l) };
    const shots: Shots = createShots({ config: config as never, registry, scene, logs: logs as never });
    try {
      const shot = await shots.screenshot(app.id);
      assert.equal(shot.w, 517);
      assert.equal(shot.h, 383);
      assert.equal(shot.face, 'main');
      // PNG-måtten är round(w)×round(h) vid deviceScaleFactor 1.
      const dims = pngSize(shot.png);
      assert.deepEqual(dims, { w: 517, h: 383 }, `PNG-storlek ${JSON.stringify(dims)}`);

      // Främmande navigering avbryts: skriv en sida som genast går till skalet, screenshota igen.
      fs.writeFileSync(
        path.join(dir, 'index.html'),
        `<!doctype html><html lang="sv"><head><meta charset="utf-8"><title>Nav</title></head><body style="margin:0;background:#0a0"><script>location.href=${JSON.stringify(SHELL + '/')}</script></body></html>`,
      );
      // Kalibrering: utan shots route-avbrott navigerar en vanlig Chrome bort till skalet.
      browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--force-device-scale-factor=2'] });
      const page = await browser.newPage();
      await page.goto(`${appOriginOf(app.id)}/`, { waitUntil: 'load' }).catch(() => {});
      await page.waitForTimeout(600);
      assert.equal(new URL(page.url()).origin, SHELL, 'kalibrering: sidan ska verkligen navigera bort utan avbrottet');
      await page.close();

      // Med shots.ts avbryts toppnavigeringen och ett fel kastas i stället för att visa skalet.
      await assert.rejects(shots.screenshot(app.id), /navigated away|Could not load/);
    } finally {
      await shots.close();
    }
  });

  // try_app (K8): isoleringen, kalibrerad mot en körning utan isolering.
  test('try_app: skrivningar når aldrig den riktiga store eller backendens skrivande routes; utan isolering gör de det (kalibrering)', async () => {
    const { app, win } = await createApp({ x: 2200, y: 0, w: 480, h: 320, scale: 1 });
    const id = app.id;
    const dir = path.join(home, 'apps', id);
    // Bevakaren börjar bevaka en ny app inom en sekund; filer skrivna före det kan missas (§7.3).
    await new Promise((res) => setTimeout(res, 1500));
    const faces = [{ id: 'main', page: 'index.html' }];
    fs.writeFileSync(path.join(dir, 'app.json'), JSON.stringify({ name: 'Räknare', faces, backend: { entry: 'server.mjs' } }));
    fs.writeFileSync(
      path.join(dir, 'server.mjs'),
      `import fs from 'node:fs'; import http from 'node:http'; import path from 'node:path';
const f = path.join(process.env.DATA_DIR, 'hits.log');
http.createServer((q, s) => {
  if (q.url === '/api/hit' && q.method === 'POST') { fs.appendFileSync(f, 'x\\n'); s.end('ok'); return; }
  if (q.url === '/api/hits') { s.end(String(fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\\n').filter(Boolean).length : 0)); return; }
  s.statusCode = 404; s.end();
}).listen(Number(process.env.PORT), '127.0.0.1');`,
    );
    fs.writeFileSync(
      path.join(dir, 'index.html'),
      `<!doctype html><html lang="sv"><head><meta charset="utf-8"><title>Räknare</title></head><body>
<button id="b">Öka</button> <button id="ws">Koppla</button> <span id="n">–</span> <button id="hang">Häng</button>
<script>
document.getElementById('hang').onclick = () => { for (;;) {} };
document.getElementById('ws').onclick = () => {
  const s = new WebSocket(location.origin.replace('http', 'ws') + '/api/ws');
  s.onclose = (e) => { document.getElementById('n').textContent = 'stängd ' + e.code; };
};
document.getElementById('b').onclick = async () => {
  const n = (await wb.store.get('count')) ?? 0;
  await wb.store.set('count', n + 1);
  await fetch('/api/hit', { method: 'POST' }).catch(() => {});
  document.getElementById('n').textContent = 'värde ' + (n + 1);
};
</script></body></html>`,
    );
    const own = appOriginOf(id);
    assert.equal((await req({ method: 'PUT', path: '/__wb/store/count', host: appHost(id), headers: { ...sameOrigin(own), 'content-type': 'application/json' }, body: '5' })).status, 204);
    // Bevakaren läser app.json (backend) inom ett par sekunder; sedan startar proxyn backenden.
    const t0 = Date.now();
    for (;;) {
      const r = await req({ path: '/api/hits', host: appHost(id), headers: sameOrigin(own) });
      if (r.status === 200) break;
      if (Date.now() - t0 > 15000) throw new Error(`backenden startade inte: ${r.status} ${r.text}`);
      await new Promise((res) => setTimeout(res, 300));
    }
    const storeFile = path.join(dir, 'data', 'store.json');
    const hits = async () => Number((await req({ path: '/api/hits', host: appHost(id), headers: sameOrigin(own) })).text);
    const registry = { get: (x: string) => (x === id ? app : undefined), manifest: () => ({ name: 'Räknare', faces, permissions: [] }) } as unknown as AppRegistry;
    const scene = { window: (x: string) => (x === id ? win : undefined) } as unknown as SceneStore;
    const shots = createShots({ config: { port: PORT } as never, registry, scene, logs: { append: () => {} } as never });
    try {
      // Kalibrering: utan isolering ändrar samma klick den riktiga store och når POST /api/hit.
      const cal = await shots.tryRun(id, { steps: [{ click: '#b' }, { wait: 'text=värde 6' }], unsafeNoIsolation: true });
      assert.ok(cal.lines.some((l) => l.startsWith('ok   2')), cal.lines.join('\n'));
      assert.equal(JSON.parse(fs.readFileSync(storeFile, 'utf8')).count, 6, 'kalibrering: den riktiga store ska ha ändrats');
      assert.equal(await hits(), 1, 'kalibrering: backendens POST ska ha nåtts');
      // Kalibrering för WebSocketar: utan isolering når uppgraderingen backenden (som vägrar: 1006).
      const calWs = await shots.tryRun(id, { steps: [{ click: '#ws' }, { wait: 'text=/stängd \\d+/' }], unsafeNoIsolation: true });
      assert.match(calWs.lines.join('\n'), /Visible text:\nÖka Koppla stängd 1006/);

      const before = fs.readFileSync(storeFile);
      const r = await shots.tryRun(id, { steps: [{ click: '#b' }, { click: '#b' }, { wait: 'text=värde 8' }] });
      const out = r.lines.join('\n');
      // Läsningar ser kopian först och sedan den riktiga store (6 → 7 → 8), men inget sparas.
      assert.ok(r.lines.some((l) => l.startsWith('ok   3')), out);
      assert.ok(fs.readFileSync(storeFile).equals(before), 'den riktiga store ändrades');
      assert.equal(await hits(), 1, 'backendens POST nåddes');
      assert.match(out, /Discarded store writes:\ncount = 8/);
      assert.match(out, /Blocked requests:\nPOST \/api\/hit\nPOST \/api\/hit/);
      assert.match(out, /Visible text:\nÖka Koppla värde 8/);
      // WebSocketar stängs av verktyget (1008) och når aldrig backenden.
      const ws = await shots.tryRun(id, { steps: [{ click: '#ws' }, { wait: 'text=/stängd \\d+/' }] });
      const wsOut = ws.lines.join('\n');
      assert.match(wsOut, /Visible text:\nÖka Koppla stängd 1008/);
      assert.match(wsOut, /Blocked requests:\nWebSocket ws:\/\/[a-z0-9]+\.localhost:\d+\/api\/ws/);
      assert.equal(r.pngs.length, 1);
      assert.deepEqual(pngSize(r.pngs[0]), { w: 480, h: 320 });
      // Ett frö: kopian börjar från provvärdena, och ett misslyckat steg stoppar resten.
      const seeded = await shots.tryRun(id, { store: { count: 41 }, steps: [{ click: '#b' }, { wait: 'text=värde 42' }, { click: '#finns-inte' }, { click: '#b' }] });
      const so2 = seeded.lines.join('\n');
      assert.match(so2, /ok {3}2 wait/);
      assert.match(so2, /FAIL 3 click "#finns-inte"/);
      assert.match(so2, /skip 4 click "#b"/);
      assert.ok(fs.readFileSync(storeFile).equals(before));
      // Stopp mitt i en körning: kontexten stängs direkt och spärren släpps, så att nästa körning går
      // (utan avbrottet tar de tre väntestegen 9 s och nästa körning vägras som pågående).
      const ac = new AbortController();
      const t1 = Date.now();
      const slow = shots.tryRun(id, { steps: [{ wait: 3000 }, { wait: 3000 }, { wait: 3000 }], signal: ac.signal }).then(
        () => 'klar',
        (e: Error) => e.message,
      );
      setTimeout(() => ac.abort(), 1500);
      await new Promise((res) => setTimeout(res, 2000));
      const next = await shots.tryRun(id, { steps: [{ wait: 10 }] }).then((x) => x.lines[1], (e: Error) => e.message);
      assert.match(next, /^ok {3}1 wait/, next);
      await slow;
      assert.ok(Date.now() - t1 < 6000, `den avbrutna körningen levde i ${Date.now() - t1} ms`);
      // En sida som hänger (oändlig slinga i en klickhanterare): körningen svarar ändå med sina rader, inom taket.
      const t2 = Date.now();
      const hung = await shots.tryRun(id, { steps: [{ click: '#hang' }] }).then((x) => x.lines.join('\n'), (e: Error) => `kastade efter ${Date.now() - t2} ms: ${e.message}`);
      assert.match(hung, /^Ran 1 step/, hung);
      assert.ok(Date.now() - t2 < 31_000, `körningen tog ${Date.now() - t2} ms`);
    } finally {
      await shots.close();
    }
  });

  // try_app drag och api, genom verktyget (checkTryInput + tryRun): ett drag går genom alla punkter
  // (kalibrerat mot ett klick), och låtsade GET-svar visas utan att backenden nås (kalibrerat utan api).
  test('try_app: drag går genom punkterna och api låtsas GET-svar utan att nå backenden; kalibrerat mot klick och körning utan api', async () => {
    const { app, win } = await createApp({ x: 2800, y: 0, w: 480, h: 320, scale: 1 });
    const id = app.id;
    const dir = path.join(home, 'apps', id);
    await new Promise((res) => setTimeout(res, 1500));
    const faces = [{ id: 'main', page: 'index.html' }];
    fs.writeFileSync(path.join(dir, 'app.json'), JSON.stringify({ name: 'Ritblock', faces, backend: { entry: 'server.mjs' } }));
    fs.writeFileSync(
      path.join(dir, 'server.mjs'),
      `import fs from 'node:fs'; import http from 'node:http'; import path from 'node:path';
const f = path.join(process.env.DATA_DIR, 'items.log');
http.createServer((q, s) => {
  if (q.url === '/api/items' && q.method === 'GET') { fs.appendFileSync(f, 'x\\n'); s.setHeader('content-type', 'application/json'); s.end(JSON.stringify(['riktig-a', 'riktig-b'])); return; }
  if (q.url === '/api/items-count') { s.end(String(fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\\n').filter(Boolean).length : 0)); return; }
  s.statusCode = 404; s.end();
}).listen(Number(process.env.PORT), '127.0.0.1');`,
    );
    fs.writeFileSync(
      path.join(dir, 'index.html'),
      `<!doctype html><html lang="sv"><head><meta charset="utf-8"><title>Ritblock</title>
<style>body{margin:0;font:14px sans-serif} #pad{width:400px;height:200px;background:#ddd;touch-action:none}</style></head><body>
<div id="pad"></div><div id="fälla" style="position:absolute;left:410px;top:0;width:60px;height:100px;background:#c00"></div><p id="spar">inget drag</p><p id="lista">laddar</p><button id="post">Skicka</button> <span id="st"></span>
<script>
const pad = document.getElementById('pad');
document.getElementById('fälla').addEventListener('pointerdown', () => { for (;;) {} });
const r1 = (v) => Math.round(v * 10) / 10;
let pts = [], down = false, moves = 0;
pad.addEventListener('pointerdown', (e) => { down = true; moves = 0; pts = [[r1(e.clientX), r1(e.clientY)]]; });
pad.addEventListener('pointermove', (e) => { if (down) { moves++; pts.push([r1(e.clientX), r1(e.clientY)]); } });
pad.addEventListener('pointerup', (e) => { down = false; pts.push([r1(e.clientX), r1(e.clientY)]); document.getElementById('spar').textContent = 'rörelser ' + moves + ' spår ' + JSON.stringify(pts); });
fetch('/api/items').then((r) => r.json()).then((items) => { document.getElementById('lista').textContent = 'poster: ' + items.join(', '); }, () => { document.getElementById('lista').textContent = 'fel'; });
document.getElementById('post').onclick = async () => { const r = await fetch('/api/items', { method: 'POST', body: '{}' }); document.getElementById('st').textContent = 'status ' + r.status; };
</script></body></html>`,
    );
    const own = appOriginOf(id);
    const t0 = Date.now();
    for (;;) {
      const r = await req({ path: '/api/items-count', host: appHost(id), headers: sameOrigin(own) });
      if (r.status === 200) break;
      if (Date.now() - t0 > 15000) throw new Error(`backenden startade inte: ${r.status} ${r.text}`);
      await new Promise((res) => setTimeout(res, 300));
    }
    const count = async () => Number((await req({ path: '/api/items-count', host: appHost(id), headers: sameOrigin(own) })).text);
    const registry = { get: (x: string) => (x === id ? app : undefined), manifest: () => ({ name: 'Ritblock', faces, permissions: [] }) } as unknown as AppRegistry;
    const scene = { window: (x: string) => (x === id ? win : undefined) } as unknown as SceneStore;
    const shots = createShots({ config: { port: PORT } as never, registry, scene, logs: { append: () => {} } as never });
    // tryApp använder bara appId och shots.
    const d = { appId: id, shots } as unknown as ToolDeps;
    const run = async (input: Parameters<typeof tryApp>[1]) => {
      const r = await tryApp(d, input);
      return { text: r.content.filter((x) => x.type === 'text').map((x) => (x as { text: string }).text).join('\n'), isError: r.isError === true };
    };
    const target = [[40, 40], [200, 60], [300, 150], [100, 180]];
    const trail = (out: string): number[][] => {
      const m = /spår (\[\[.*?\]\])/.exec(out);
      return m ? (JSON.parse(m[1]) as number[][]) : [];
    };
    const through = (out: string) => {
      const p = trail(out);
      return target.every(([x, y]) => p.some(([px, py]) => Math.abs(px - x) <= 1 && Math.abs(py - y) <= 1));
    };
    try {
      // Kalibrering: ett klick på samma yta ger inget spår genom punkterna.
      const click = await run({ steps: [{ click: '#pad' }] });
      assert.match(click.text, /rörelser 0 spår/, click.text);
      assert.equal(through(click.text), false, `kalibrering: ett klick ska inte ge ett spår genom punkterna: ${click.text}`);
      // drag: tryck vid första punkten, några rörelser per sträcka, släpp vid den sista.
      const dragged = await run({ steps: [{ drag: target }] });
      assert.match(dragged.text, /ok {3}1 drag 4 points \(40,40\)→\(100,180\) \d+ ms/, dragged.text);
      assert.ok(through(dragged.text), `spåret går inte genom alla punkter: ${dragged.text}`);
      const p = trail(dragged.text);
      assert.deepEqual([p[0], p.at(-1)], [[40, 40], [100, 180]], dragged.text);
      const moves = Number(/rörelser (\d+)/.exec(dragged.text)?.[1]);
      assert.ok(moves >= 3 * (target.length - 1), `för få rörelser: ${moves}`);
      // En punkt utanför fönstret (480×320) ger en FAIL-rad i stället för ett drag.
      const outside = await run({ steps: [{ drag: [[10, 10], [481, 10]] }] });
      assert.match(outside.text, /FAIL 1 drag 2 points \(10,10\)→\(481,10\) \d+ ms: drag point 2 \(481,10\) is outside the window/, outside.text);
      assert.match(outside.text, /inget drag/);

      // Kalibrering: utan api visas backendens poster och backenden nås.
      const n0 = await count();
      const real = await run({ steps: [{ wait: 'text=/poster:/' }] });
      assert.match(real.text, /poster: riktig-a, riktig-b/, real.text);
      assert.equal(await count(), n0 + 1, 'kalibrering: utan api ska backenden ha nåtts');
      assert.doesNotMatch(real.text, /Faked GET responses/);
      // Med api visas de låtsade posterna och backenden nås inte; en POST till samma nyckel får ändå 409.
      const n1 = await count();
      const faked = await run({
        api: { '/api/items': ['låtsad-1', 'låtsad-2'], '/api/folders': [] },
        steps: [{ wait: 'text=/poster:/' }, { click: '#post' }, { wait: 'text=/status \\d+/' }],
      });
      assert.match(faked.text, /poster: låtsad-1, låtsad-2/, faked.text);
      assert.equal(await count(), n1, 'en låtsad GET nådde backenden');
      assert.match(faked.text, /Faked GET responses: \/api\/items \(1×\), \/api\/folders \(never requested\)/);
      assert.match(faked.text, /status 409/);
      assert.match(faked.text, /Blocked requests:\nPOST \/api\/items/);
      // En nyckel utanför /api vägras av valideringen, före webbläsaren.
      const refused = await run({ api: { '/items': [] }, steps: [{ shot: true }] });
      assert.equal(refused.isError, true);
      assert.match(refused.text, /Invalid api path "\/items"/);

      // En sida som hänger i pointerdown: musens anrop saknar egen tidsgräns, men draget får stegets,
      // och svaret kommer ändå inom taket.
      const t1 = Date.now();
      const hung = await Promise.race([
        run({ steps: [{ drag: [[420, 20], [460, 80]] }] }),
        new Promise<{ text: string }>((res) => setTimeout(() => res({ text: 'hängde i 25 s' }), 25_000)),
      ]);
      assert.match(hung.text, /FAIL 1 drag 2 points \(420,20\)→\(460,80\) \d+ ms: Timeout 5000ms exceeded/, hung.text);
      assert.ok(Date.now() - t1 < 25_000, `körningen tog ${Date.now() - t1} ms`);

      // Lokala värdar avbryts i alla stavningar som Chrome når (§8.7): avslutande punkt, IPv4-mappad och
      // ospecificerad IPv6. Kalibrerat: med den gamla isLocalHost nådde alla tre lyssnaren.
      const seen: string[] = [];
      const listeners = await Promise.all(
        ['127.0.0.1', '::1'].map(
          (host) =>
            new Promise<http.Server>((res, rej) => {
              const srv = http.createServer((q, s) => {
                seen.push(`${q.headers.host} ${q.url}`);
                s.end('x');
              });
              srv.once('error', rej);
              srv.listen(PORT + 2, host, () => res(srv));
            }),
        ),
      );
      try {
        const urls = [`http://localhost.:${PORT + 2}/punkt`, `http://[::ffff:127.0.0.1]:${PORT + 2}/mappad`, `http://[::]:${PORT + 2}/ospecificerad`];
        fs.writeFileSync(
          path.join(dir, 'index.html'),
          `<!doctype html><p id="o"></p><script>Promise.allSettled(${JSON.stringify(urls)}.map((u) => fetch(u, { mode: 'no-cors' }))).then((r) => { document.getElementById('o').textContent = 'klart ' + r.map((x) => x.status).join(','); });</script>`,
        );
        const lokal = await run({ steps: [{ wait: 'text=/klart/' }] });
        assert.deepEqual(seen, [], `lokala värdar nåddes: ${seen.join(', ')}\n${lokal.text}`);
        assert.match(lokal.text, /klart rejected,rejected,rejected/, lokal.text);
      } finally {
        for (const srv of listeners) srv.close();
      }
    } finally {
      await shots.close();
    }
  });
});

/** Läser bredd och höjd ur en PNG (IHDR). */
function pngSize(png: Buffer): { w: number; h: number } {
  return { w: png.readUInt32BE(16), h: png.readUInt32BE(20) };
}
