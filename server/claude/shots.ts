// server/claude/shots.ts — skärmbilder av appar i en beständig, osynlig Chrome (CONTRACT §8.8).
// playwright-core med channel 'chrome', en sida per app med viewport round(w)×round(h) och deviceScaleFactor 1.
// Varje toppnavigering till en annan origin än appens egen avbryts, och förfrågningar till skalet, andra appar
// och andra lokala portar stoppas, så att en app aldrig kan visa Claude något annat än sig själv.
import { chromium } from 'playwright-core';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { childEnv } from '../config.ts';
import type { AppLogs, AppRegistry, Config, SceneStore, Shots } from '../types.ts';

export const SHOTS_IDLE_MS = 10 * 60_000;
/** try_app (K8): högst så länge per steg och per körning, och så många tecken synlig text. */
export const TRY_STEP_MS = 5_000;
export const TRY_RUN_MS = 30_000;
export const TRY_TEXT_MAX = 1500;
const TRY_WRITE_SHOWN = 300;
/** drag: så många punkter, och så många musrörelser per sträcka (som en riktig pekare). */
export const TRY_DRAG_MIN = 2;
export const TRY_DRAG_MAX = 50;
const DRAG_SUBSTEPS = 5;

/** Ett steg i en provkörning; exakt en åtgärd per steg (tools.ts validerar). */
export interface TryStep {
  click?: string;
  hover?: string;
  fill?: string;
  text?: string;
  type?: string;
  press?: string;
  wait?: string | number;
  shot?: boolean;
  /** Punkter [x, y] i fönstrets CSS-px: tryck vid den första, rör genom de andra, släpp vid den sista. */
  drag?: number[][];
}

export interface TryInput {
  face?: string;
  /** 'copy': läsningar går till appens riktiga store, skrivningar till en kasserad kopia. 'empty' eller ett frö: bara kopian. */
  store?: 'copy' | 'empty' | Record<string, unknown>;
  /** Låtsade GET/HEAD-svar från appens backend, nyckel = sökväg (med eller utan ?fråga). Når aldrig backenden. */
  api?: Record<string, unknown>;
  steps: TryStep[];
  /** Bara testernas kalibrering: utan isolering når körningen den riktiga store och backendens skrivande routes. */
  unsafeNoIsolation?: boolean;
  /** Turens avbrott (stopp): kontexten stängs direkt, så att körningen och spärren inte lever kvar. */
  signal?: AbortSignal;
}

export interface TryResult {
  lines: string[];
  pngs: Buffer[];
  w: number;
  h: number;
  face: string;
}

export interface TryShots extends Shots {
  tryRun(appId: string, input: TryInput): Promise<TryResult>;
}

function firstLine(err: unknown): string {
  return String((err as Error)?.message ?? err).split('\n')[0].slice(0, 300);
}

function clip(s: string, max: number): string {
  const cps = Array.from(s);
  return cps.length > max ? cps.slice(0, max - 1).join('') + '…' : s;
}

/** Fel i ett drag (antal, tal, inom fönstret när w och h är kända), eller null. */
export function dragProblem(pts: unknown, w = Infinity, h = Infinity): string | null {
  if (!Array.isArray(pts) || pts.length < TRY_DRAG_MIN || pts.length > TRY_DRAG_MAX) return `drag needs ${TRY_DRAG_MIN}–${TRY_DRAG_MAX} points.`;
  for (const [i, p] of pts.entries()) {
    if (!Array.isArray(p) || p.length !== 2 || !p.every((v) => typeof v === 'number' && Number.isFinite(v))) return `drag point ${i + 1} must be [x, y] with two numbers.`;
    if (p[0] < 0 || p[1] < 0 || p[0] > w || p[1] > h) {
      return `drag point ${i + 1} (${p.join(',')}) is outside the window${Number.isFinite(w) ? ` (0–${w} × 0–${h})` : ''}.`;
    }
  }
  return null;
}

/** Nyckeln i try_app:s api som webbläsaren skriver den (pathname + search), eller null om den inte är en /api-sökväg. */
export function apiKey(k: unknown): string | null {
  if (typeof k !== 'string' || k.includes('#') || !(k === '/api' || k.startsWith('/api/'))) return null;
  try {
    const u = new URL(k, 'http://app.invalid');
    // Efter normaliseringen (punktsegment, %2e, snedstreck bakåt) måste den fortfarande ligga under /api.
    if (u.origin !== 'http://app.invalid' || !(u.pathname === '/api' || u.pathname.startsWith('/api/'))) return null;
    return u.pathname + u.search;
  } catch {
    return null;
  }
}

/** Musens anrop saknar egen tidsgräns, och en sida som hänger får inte hålla kvar steget. */
function within<T>(p: Promise<T>, ms: number): Promise<T> {
  p.catch(() => {}); // ett övergivet löfte avvisas när kontexten stängs
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error(`Timeout ${ms}ms exceeded.`)), ms);
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

/** Ett drag som en riktig pekare: tryck vid första punkten, några mellansteg per sträcka, släpp vid den sista. */
async function dragAlong(page: Page, pts: number[][]): Promise<void> {
  await page.mouse.move(pts[0][0], pts[0][1]);
  await page.mouse.down();
  for (const [x, y] of pts.slice(1)) await page.mouse.move(x, y, { steps: DRAG_SUBSTEPS });
  await page.mouse.up();
}

function describeStep(st: TryStep): string {
  if (st.click !== undefined) return `click ${JSON.stringify(st.click)}`;
  if (st.hover !== undefined) return `hover ${JSON.stringify(st.hover)}`;
  if (st.fill !== undefined) return `fill ${JSON.stringify(st.fill)} ${JSON.stringify(st.text ?? '')}`;
  if (st.type !== undefined) return `type ${JSON.stringify(st.type)}`;
  if (st.press !== undefined) return `press ${JSON.stringify(st.press)}`;
  if (st.wait !== undefined) return `wait ${JSON.stringify(st.wait)}`;
  if (st.drag !== undefined) {
    const pts: unknown[] = Array.isArray(st.drag) ? st.drag : [];
    const pt = (p: unknown) => (Array.isArray(p) ? `(${p.map((v) => (typeof v === 'number' ? Math.round(v * 10) / 10 : '?')).join(',')})` : '(?)');
    return `drag ${pts.length} points ${pt(pts[0])}→${pt(pts[pts.length - 1])}`;
  }
  return 'shot';
}
const SETTLE_MS = 300;
const GOTO_TIMEOUT_MS = 20_000;
const DEFAULT_SIZE = { w: 640, h: 480 };

interface AppPage {
  context: BrowserContext;
  page: Page;
  w: number;
  h: number;
}

/** Värdnamn som räknas som den här datorn, även med avslutande punkt och som ospecificerad eller IPv4-mappad IPv6. */
export function isLocalHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || h === '::' || h.startsWith('::ffff:') || h === '0.0.0.0' || /^127\./.test(h);
}

export function createShots(deps: { config: Config; registry: AppRegistry; scene: SceneStore; logs: AppLogs }): TryShots {
  const { config, registry, scene, logs } = deps;
  let browser: Browser | null = null;
  let launching: Promise<Browser> | null = null;
  const pages = new Map<string, AppPage>();
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const appOrigin = (appId: string) => `http://${appId}.localhost:${config.port}`;

  function touch(): void {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      void close();
    }, SHOTS_IDLE_MS);
    idleTimer.unref?.();
  }

  async function getBrowser(): Promise<Browser> {
    if (browser?.isConnected()) return browser;
    if (launching) return launching;
    launching = (async () => {
      const b = await chromium.launch({ channel: 'chrome', headless: true, env: childEnv() });
      b.on('disconnected', () => {
        if (browser === b) {
          browser = null;
          pages.clear();
        }
      });
      browser = b;
      return b;
    })();
    try {
      return await launching;
    } finally {
      launching = null;
    }
  }

  async function pageFor(appId: string, w: number, h: number): Promise<AppPage> {
    const existing = pages.get(appId);
    if (existing && !existing.page.isClosed()) {
      if (existing.w !== w || existing.h !== h) {
        await existing.page.setViewportSize({ width: w, height: h });
        existing.w = w;
        existing.h = h;
      }
      return existing;
    }
    const b = await getBrowser();
    const context = await b.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
    const origin = appOrigin(appId);
    const page = await context.newPage();
    await page.route('**/*', (route) => {
      const req = route.request();
      let url: URL;
      try {
        url = new URL(req.url());
      } catch {
        return route.abort();
      }
      const sameOrigin = url.origin === origin;
      let mainFrame = false;
      try {
        mainFrame = req.frame() === page.mainFrame();
      } catch {
        mainFrame = false;
      }
      // Toppnavigering bort från appen: avbryt.
      if (req.isNavigationRequest() && mainFrame && !sameOrigin) return route.abort('blockedbyclient');
      // Skalet, andra appar och andra lokala portar: aldrig.
      if (!sameOrigin && isLocalHost(url.hostname)) return route.abort('blockedbyclient');
      return route.continue();
    });
    // wb.js postar redan appens egna console.error/warn, window.onerror och avvisade löften till /__wb/log,
    // även på skärmbildssidor (§8.8). Här loggas därför bara det wb.js INTE kan se: meddelanden som
    // webbläsaren själv skriver (misslyckade laddningar, CSP-överträdelser). De känns igen på att de saknar
    // argument (ingen console.*-anropare). 404 för /__wb/store/<nyckel> (en saknad nyckel) filtreras bort.
    // pageerror hanteras inte: wb.js:s egen error-lyssnare postar redan varje ohanterat fel.
    page.on('console', (msg) => {
      const type = msg.type();
      if (type !== 'error' && type !== 'warning') return;
      if (msg.args().length > 0) return; // ett console.error/warn-anrop: wb.js har redan postat det
      const url = msg.location()?.url ?? '';
      if (url.includes('/__wb/store/')) return; // "Failed to load resource: … 404" för en saknad nyckel
      logs.append(appId, 'console', `${type === 'warning' ? 'warn' : 'error'}: ${msg.text()}`);
    });
    const ap: AppPage = { context, page, w, h };
    pages.set(appId, ap);
    return ap;
  }

  async function screenshot(appId: string, face?: string): Promise<{ png: Buffer; w: number; h: number; face: string }> {
    touch();
    const app = registry.get(appId);
    if (!app) throw new Error(`Unknown app ${appId}.`);
    const faces = registry.manifest(appId).faces;
    const win = scene.window(appId);
    let f = face !== undefined ? faces.find((x) => x.id === face) : faces[Math.min(Math.max(0, win?.face ?? 0), faces.length - 1)];
    if (!f) throw new Error(`No face ${JSON.stringify(face)}. Faces: ${faces.map((x) => x.id).join(', ')}.`);
    const w = Math.max(1, Math.round(win?.w ?? DEFAULT_SIZE.w));
    const h = Math.max(1, Math.round(win?.h ?? DEFAULT_SIZE.h));
    const ap = await pageFor(appId, w, h);
    const url = `${appOrigin(appId)}/${f.page.split('/').map(encodeURIComponent).join('/')}`;
    let res;
    try {
      res = await ap.page.goto(url, { waitUntil: 'load', timeout: GOTO_TIMEOUT_MS });
    } catch (err) {
      throw new Error(`Could not load ${f.page}: ${(err as Error).message.split('\n')[0]}`);
    }
    if (!res) throw new Error(`Could not load ${f.page}.`);
    if (res.status() >= 400) throw new Error(`The page ${f.page} does not exist (HTTP ${res.status()}).`);
    await ap.page.waitForTimeout(SETTLE_MS);
    if (new URL(ap.page.url()).origin !== appOrigin(appId)) {
      await ap.page.goto('about:blank').catch(() => {});
      throw new Error('The page navigated away from the app.');
    }
    const png = await ap.page.screenshot({ type: 'png' });
    touch();
    return { png, w, h, face: f.id };
  }

  const trying = new Set<string>();

  /**
   * try_app (K8): kör appen i en NY, osynlig kontext i fönstrets storlek och utför stegen. Isoleringen är
   * stängd som standard: wb.store-skrivningar hamnar i en kopia som kastas (läsningar ser kopian först),
   * backendens /api/* får bara GET/HEAD, andra origins bara GET, inga WebSocketar och inga service workers.
   * Inget skrivs till disk och rev ändras inte. context.close() i finally kastar allt.
   */
  async function tryRun(appId: string, input: TryInput): Promise<TryResult> {
    touch();
    if (!registry.get(appId)) throw new Error(`Unknown app ${appId}.`);
    if (trying.has(appId)) throw new Error('A try_app run is already in progress for this app.');
    if (input.signal?.aborted) throw new Error('The turn was stopped.');
    const t0 = Date.now();
    const faces = registry.manifest(appId).faces;
    const win = scene.window(appId);
    const f = input.face !== undefined ? faces.find((x) => x.id === input.face) : faces[Math.min(Math.max(0, win?.face ?? 0), faces.length - 1)];
    if (!f) throw new Error(`No face ${JSON.stringify(input.face)}. Faces: ${faces.map((x) => x.id).join(', ')}.`);
    const w = Math.max(1, Math.round(win?.w ?? DEFAULT_SIZE.w));
    const h = Math.max(1, Math.round(win?.h ?? DEFAULT_SIZE.h));
    const origin = appOrigin(appId);
    const mode = input.store === undefined || input.store === 'copy' ? 'copy' : 'local';
    const overlay = new Map<string, string | null>(); // null = borttagen i kopian
    if (input.store && typeof input.store === 'object') for (const [k, v] of Object.entries(input.store)) overlay.set(k, JSON.stringify(v));
    const writes = new Map<string, string | null>();
    // Låtsade GET-svar: normaliserad nyckel → JSON, och träffar per nyckel som Claude skrev den.
    const fakes = new Map<string, { key: string; body: string; hits: number }>();
    for (const [k, v] of Object.entries(input.api ?? {})) {
      const n = apiKey(k);
      if (n === null) throw new Error(`Invalid api key ${JSON.stringify(k)}: it must start with /api/ and contain no #.`);
      fakes.set(n, { key: k, body: JSON.stringify(v) ?? 'null', hits: 0 });
    }
    const blocked: string[] = [];
    const opened: string[] = [];
    const faceChanges: string[] = [];
    const consoleErrors: string[] = [];
    const logged: string[] = [];
    const isolate = !input.unsafeNoIsolation;
    // Spärren tas först här (inget await sedan kontrollen ovan) och släpps i finally, även om Chrome inte startar.
    trying.add(appId);
    let context: BrowserContext;
    try {
      context = await (await getBrowser()).newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, serviceWorkers: 'block' });
    } catch (err) {
      trying.delete(appId);
      throw err;
    }
    const onAbort = (): void => void context.close().catch(() => {});
    input.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const page = await context.newPage();
      const json = (status: number, body: unknown) => ({ status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body) });
      await context.route('**/*', async (route) => {
        try {
          const req = route.request();
          const url = new URL(req.url());
          const method = req.method().toUpperCase();
          const same = url.origin === origin;
          let ours = false;
          try {
            ours = req.frame().page() === page;
          } catch {
            ours = false;
          }
          const mainFrame = ours && (() => {
            try {
              return req.frame() === page.mainFrame();
            } catch {
              return false;
            }
          })();
          if (req.isNavigationRequest() && (!ours || (mainFrame && !same))) {
            opened.push(url.href);
            return await route.abort('blockedbyclient');
          }
          if (!same) {
            if (isLocalHost(url.hostname) || (isolate && method !== 'GET' && method !== 'HEAD')) {
              blocked.push(`${method} ${url.href}`);
              return await route.abort('blockedbyclient');
            }
            return await route.continue();
          }
          if (!isolate) return await route.continue();
          const p = url.pathname;
          if (p === '/__wb/log') {
            try {
              const list = JSON.parse(req.postData() ?? '[]') as { level?: string; text?: string }[];
              for (const e of Array.isArray(list) ? list.slice(0, 50) : []) logged.push(`${e.level}: ${clip(String(e.text ?? ''), 300)}`);
            } catch {
              /* trasig bunt */
            }
            return await route.fulfill({ status: 204 });
          }
          if (p === '/__wb/store') {
            if (method !== 'GET' && method !== 'HEAD') return await route.fulfill(json(405, { error: 'metoden' }));
            let all: Record<string, unknown> = {};
            if (mode === 'copy') {
              const r = await route.fetch();
              if (r.ok()) all = (await r.json().catch(() => ({}))) as Record<string, unknown>;
            }
            for (const [k, v] of overlay) {
              if (v === null) delete all[k];
              else all[k] = JSON.parse(v);
            }
            return await route.fulfill(json(200, all));
          }
          if (p.startsWith('/__wb/store/')) {
            const key = decodeURIComponent(p.slice('/__wb/store/'.length));
            if (method === 'GET' || method === 'HEAD') {
              if (overlay.has(key)) {
                const v = overlay.get(key);
                if (v === null) return await route.fulfill({ status: 204 });
                return await route.fulfill({ status: 200, contentType: 'application/json; charset=utf-8', body: v as string });
              }
              if (mode === 'copy') return await route.continue();
              return await route.fulfill({ status: 204 });
            }
            if (method === 'PUT') {
              const body = req.postData() ?? '';
              JSON.parse(body);
              overlay.set(key, body);
              writes.set(key, body);
              return await route.fulfill({ status: 204 });
            }
            if (method === 'DELETE') {
              overlay.set(key, null);
              writes.set(key, null);
              return await route.fulfill({ status: 204 });
            }
            return await route.fulfill(json(405, { error: 'metoden' }));
          }
          if (p === '/api' || p.startsWith('/api/')) {
            if (method === 'GET' || method === 'HEAD') {
              // Exakt pathname + search först, annars pathname mot en nyckel utan ?. Backenden nås aldrig.
              const fake = fakes.get(p + url.search) ?? fakes.get(p);
              if (!fake) return await route.continue();
              fake.hits++;
              return await route.fulfill({ status: 200, contentType: 'application/json; charset=utf-8', body: fake.body });
            }
            blocked.push(`${method} ${p}`);
            return await route.fulfill(json(409, { error: 'try_app: writes are not sent during a test run' }));
          }
          return await route.continue();
        } catch {
          // Stängt som standard: allt som inte gick att avgöra stoppas.
          await route.abort('blockedbyclient').catch(() => {});
        }
      });
      // Inga WebSocketar alls i en provkörning: de kan skriva till backenden eller till andra tjänster.
      if (isolate) {
        await context.routeWebSocket(/.*/, (ws) => {
          blocked.push(`WebSocket ${ws.url()}`);
          void ws.close({ code: 1008, reason: 'try_app' });
        });
      }
      context.on('page', (pg) => {
        if (pg === page) return;
        opened.push(pg.url());
        void pg.close().catch(() => {});
      });
      page.on('console', (msg) => {
        if (msg.type() !== 'error') return;
        const t = msg.text();
        if (/status of 409/.test(t)) return; // verktygets egna nej till skrivningar
        consoleErrors.push(clip(t, 300));
      });
      page.on('pageerror', (err) => consoleErrors.push(clip(`Uncaught ${firstLine(err)}`, 300)));
      await page.addInitScript(() => {
        (window as unknown as { __wbTry: boolean }).__wbTry = true;
      });
      const pagePath = (pg: string) => '/' + pg.split('/').map(encodeURIComponent).join('/');
      let lastPath = pagePath(f.page);
      page.on('framenavigated', (fr) => {
        if (fr !== page.mainFrame()) return;
        try {
          const u = new URL(fr.url());
          if (u.origin !== origin || u.pathname === lastPath) return;
          const from = faces.find((x) => pagePath(x.page) === lastPath)?.id ?? lastPath;
          const to = faces.find((x) => pagePath(x.page) === u.pathname)?.id ?? u.pathname;
          faceChanges.push(`${from} → ${to}`);
          lastPath = u.pathname;
        } catch {
          /* about:blank */
        }
      });
      const res = await page.goto(`${origin}${pagePath(f.page)}`, { waitUntil: 'load', timeout: Math.min(GOTO_TIMEOUT_MS, TRY_RUN_MS) });
      if (!res || res.status() >= 400) throw new Error(`The page ${f.page} could not be loaded${res ? ` (HTTP ${res.status()})` : ''}.`);
      await page.waitForTimeout(SETTLE_MS);
      const lines: string[] = [];
      const pngs: Buffer[] = [];
      let failed = false;
      for (const [i, st] of input.steps.entries()) {
        const what = describeStep(st);
        const left = TRY_RUN_MS - (Date.now() - t0);
        if (failed || left <= 0) {
          lines.push(`skip ${i + 1} ${what}${failed ? '' : ' (30 s run limit)'}`);
          continue;
        }
        const timeout = Math.min(TRY_STEP_MS, left);
        const ts = Date.now();
        try {
          if (st.click !== undefined) await page.locator(st.click).first().click({ timeout });
          else if (st.hover !== undefined) await page.locator(st.hover).first().hover({ timeout });
          else if (st.fill !== undefined) await page.locator(st.fill).first().fill(st.text ?? '', { timeout });
          else if (st.type !== undefined) await page.keyboard.type(st.type);
          else if (st.press !== undefined) await page.keyboard.press(st.press);
          else if (typeof st.wait === 'number') await page.waitForTimeout(Math.min(3000, Math.max(0, st.wait)));
          else if (typeof st.wait === 'string') await page.locator(st.wait).first().waitFor({ state: 'visible', timeout });
          else if (st.shot) pngs.push(await page.screenshot({ type: 'png', timeout }));
          else if (st.drag !== undefined) {
            const bad = dragProblem(st.drag, w, h);
            if (bad) throw new Error(bad);
            await within(dragAlong(page, st.drag), timeout);
          }
          await page.waitForLoadState('networkidle', { timeout: 1000 }).catch(() => {});
          await page.waitForTimeout(150);
          lines.push(`ok   ${i + 1} ${what} ${Date.now() - ts} ms`);
        } catch (err) {
          failed = true;
          lines.push(`FAIL ${i + 1} ${what} ${Date.now() - ts} ms: ${firstLine(err)}`);
        }
      }
      let visible = '';
      try {
        visible = clip((await page.locator('body').innerText({ timeout: 2000 })).replace(/\n{3,}/g, '\n\n').trim(), TRY_TEXT_MAX);
      } catch {
        visible = '(could not read the page text)';
      }
      // En sida som hänger ger ingen bild; svaret (stegen) kommer ändå, inom taket.
      let shotFailed = '';
      try {
        pngs.push(await page.screenshot({ type: 'png', timeout: Math.max(1000, Math.min(TRY_STEP_MS, TRY_RUN_MS - (Date.now() - t0))) }));
      } catch (err) {
        shotFailed = `Final screenshot failed: ${firstLine(err)}`;
      }
      const out = [`Ran ${input.steps.length} step(s) in ${Date.now() - t0} ms at ${w}×${h}, face ${f.id}, store ${mode === 'copy' ? 'copy' : input.store === 'empty' ? 'empty' : 'seed'}. Nothing was saved.`, ...lines];
      out.push(writes.size ? `Discarded store writes:\n${[...writes].map(([k, v]) => `${k} = ${v === null ? '(deleted)' : clip(v, TRY_WRITE_SHOWN)}`).join('\n')}` : 'Discarded store writes: none');
      if (fakes.size) {
        const used = [...fakes.values()].map((x) => `${x.key} (${x.hits ? `${x.hits}×` : 'never requested'})`);
        out.push(`Faked GET responses: ${used.join(', ')}`);
      }
      if (blocked.length) out.push(`Blocked requests:\n${blocked.slice(0, 30).join('\n')}`);
      if (opened.length) out.push(`Opened (blocked) URLs:\n${opened.slice(0, 20).join('\n')}`);
      if (faceChanges.length) out.push(`Face changes: ${faceChanges.join(', ')}`);
      const errs = [...consoleErrors, ...logged.filter((l) => l.startsWith('error:'))];
      out.push(errs.length ? `Console errors:\n${errs.slice(0, 30).join('\n')}` : 'Console errors: none');
      out.push(`Visible text:\n${visible || '(empty)'}`);
      if (shotFailed) out.push(shotFailed);
      return { lines: out, pngs, w, h, face: f.id };
    } finally {
      input.signal?.removeEventListener('abort', onAbort);
      trying.delete(appId);
      await context.close().catch(() => {});
      touch();
    }
  }

  async function close(): Promise<void> {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    const b = browser ?? (launching ? await launching.catch(() => null) : null);
    browser = null;
    pages.clear();
    if (b) await b.close().catch(() => {});
  }

  return { screenshot, tryRun, close };
}
