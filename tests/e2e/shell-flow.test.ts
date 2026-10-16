// tests/e2e/shell-flow.test.ts — skalet med riktig indata i riktig Chrome mot låtsas-Claude (CONTRACT §10, §13, §15).
// Egen server på 8270/8279 (WB_E2E_PORT, HMR = porten + 9) med WORKBENCH_FAKE_CLAUDE=1 och ett tillfälligt
// WORKBENCH_HOME under .scratch/integrator3 (WB_E2E_DIR) som tas bort efteråt. Hoppas över om Chrome saknas.
// Ett ordnat flöde, steg för steg (faller ett steg hoppas resten över):
//   tom yta → rita (Esc tar bort en orörd fyrkant, och ett nytt drag på samma ställe direkt efteråt ritar) →
//   inmatningen har fokus < 600 ms efter släppet → skriv och Enter → bygget (pricken pulserar, ljusbandet sveper) →
//   klart: ett svar i HUD:en och appens sida i iframen → tryck på tom yta stänger HUD:en och fönstret står kvar →
//   pricken öppnar igen → omladdning (fönstret, HUD:en och utkastet finns kvar) → omladdning medan pekaren vilar
//   över appen (ett nyp där zoomar) → ⋯ Ångra ger ångra-raden → ⌘0 visar allt → en tresidig app ritas medan den
//   första appens HUD är öppen (båda öppna utan att överlappa, den nya aktiv; ett tryck stänger bara den) och vrids
//   med ⌃⌥→ och är platt i vila → Ta bort i ⋯-menyn med bekräftelse → fönstret är borta och servern har inte appen.
// Varje kontroll av att något *inte* händer fälls först i samma körning (kalibrering), och tidsmåttet provas mot
// en känd fördröjning innan det används. WB_SHELL_PLANT=k1 planterar K1-felet (ett fönster som löses upp fångar
// pekaren), och då ska steget med Esc falla.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import type { Browser, Page } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = Number(process.env.WB_E2E_PORT) || 8270;
const HMR = PORT + 9;
const BASE = `http://localhost:${PORT}`;
const SCRATCH = process.env.WB_E2E_DIR ? path.resolve(process.env.WB_E2E_DIR) : path.join(ROOT, '.scratch', 'integrator3');
const VW = 1440;
const VH = 900;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Saknas Chrome hoppas hela filen över. Alla andra fel vid start får testet att falla.
let browser: Browser | null = null;
let noChrome: string | false = false;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--force-device-scale-factor=2'] });
} catch (err) {
  const msg = String((err as Error)?.message ?? err);
  if (/distribution 'chrome' is not (found|supported)|doesn't exist|ENOENT/i.test(msg)) noChrome = 'Chrome saknas';
  else throw err;
}

let server: ChildProcess | null = null;
let home = '';
let page: Page;
/** Fel i skalets konsol (inte appernas egna origins). */
const errors: string[] = [];
/** Första steget som föll; resten av flödet hoppas då över. */
let broken = '';

/* ------------------------------ servern ------------------------------ */

async function startServer(): Promise<void> {
  fs.mkdirSync(SCRATCH, { recursive: true });
  home = fs.realpathSync.native(fs.mkdtempSync(path.join(SCRATCH, 'shell-home-')));
  server = spawn(process.execPath, [path.join(ROOT, 'server', 'main.ts')], {
    cwd: ROOT,
    env: {
      ...process.env,
      WORKBENCH_PORT: String(PORT),
      WORKBENCH_HMR_PORT: String(HMR),
      WORKBENCH_HOME: home,
      WORKBENCH_FAKE_CLAUDE: '1',
      WORKBENCH_FAKE_SPEED: '1',
      NODE_ENV: 'development',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logFile = path.join(home, 'server.log');
  server.stdout?.on('data', (d: Buffer) => fs.appendFileSync(logFile, d));
  server.stderr?.on('data', (d: Buffer) => fs.appendFileSync(logFile, d));
  const end = Date.now() + 30_000;
  for (;;) {
    try {
      if ((await fetch(`${BASE}/api/snapshot`, { headers: { origin: BASE } })).ok) break;
    } catch {
      /* inte uppe än */
    }
    if (Date.now() > end) throw new Error('servern kom inte upp');
    await sleep(200);
  }
}

async function stopServer(): Promise<void> {
  const pid = server?.pid;
  if (!pid) return;
  const gone = new Promise<void>((r) => server?.once('exit', () => r()));
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return;
  }
  await Promise.race([gone, sleep(4000)]);
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    /* redan avslutad */
  }
}

/** Vad servern vet om appen (snapshot). */
async function serverHas(id: string): Promise<{ app: boolean; window: boolean }> {
  const r = await fetch(`${BASE}/api/snapshot`, { headers: { origin: BASE } });
  const s = (await r.json()) as { scene: { windows: Array<{ appId: string }> }; apps: Array<{ id: string }> };
  return { app: s.apps.some((a) => a.id === id), window: s.scene.windows.some((w) => w.appId === id) };
}

/* ------------------------------ skalet ------------------------------ */

interface WinState {
  dom: boolean;
  store: boolean;
  view: boolean;
}

/** Finns fönstret i DOM:en (och löses inte upp), i butiken och i världen? */
function winState(id: string): Promise<WinState> {
  return page.evaluate((id) => {
    const wb = (window as any).__wb;
    const el = document.querySelector(`.wb-win[data-app="${id}"]`);
    return {
      dom: !!el && !el.classList.contains('wb-gone'),
      store: wb.store.apps.has(id) as boolean,
      view: (wb.world.debug.views() as Array<{ appId: string }>).some((v) => v.appId === id),
    };
  }, id);
}

const kept = (w: WinState, s: { app: boolean; window: boolean }): boolean => w.dom && w.store && w.view && s.app && s.window;
const gone = (w: WinState, s: { app: boolean; window: boolean }): boolean => !w.dom && !w.store && !w.view && !s.app && !s.window;

/** Den aktiva HUD:en (flera kan vara öppna, §13): öppen, dess app, fokus i just dess inmatning, och alla öppna. */
function hud(): Promise<{ open: boolean; app: string | null; focused: boolean; hudApp: string | null; list: string[] }> {
  return page.evaluate(() => {
    const d = (window as any).__wb.world.debug;
    const active = d.hudApp() as string | null;
    const h = active ? document.querySelector<HTMLElement>(`.wbh[data-app="${active}"]`) : null;
    const a = document.activeElement;
    return {
      open: !!h && !h.hidden,
      app: active,
      focused: !!a?.classList.contains('wbh-input') && !!h && h.contains(a),
      hudApp: active,
      list: (typeof d.huds === 'function' ? d.huds().open : active ? [active] : []) as string[],
    };
  });
}

/** Skärmrektangeln för appens HUD-panel, eller null. */
function hudRect(id: string): Promise<{ x: number; y: number; w: number; h: number } | null> {
  return page.evaluate((id) => {
    const el = document.querySelector(`.wbh[data-app="${id}"]:not([hidden]) .wbh-panel`);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  }, id);
}

/** Ryms fönstret helt i vyn? */
function fits(id: string): Promise<{ ok: boolean; r: { x: number; y: number; w: number; h: number } | null }> {
  return page.evaluate(
    ([id, vw, vh]) => {
      const r = (window as any).__wb.world.screenRectOf(id) as { x: number; y: number; w: number; h: number } | null;
      return { ok: !!r && r.w >= 100 && r.x >= 0 && r.y >= 0 && r.x + r.w <= vw && r.y + r.h <= vh, r };
    },
    [id, VW, VH] as const,
  );
}

/** En punkt på tom yta: inget fönster, ingen krom, ingen HUD under den. */
async function emptyPoint(): Promise<{ x: number; y: number }> {
  const p = await page.evaluate(() => {
    const cands: Array<[number, number]> = [
      [1380, 860],
      [60, 860],
      [60, 60],
      [1380, 60],
      [720, 875],
      [720, 25],
    ];
    for (const [x, y] of cands) {
      const el = document.elementFromPoint(x, y);
      if (el && (el.id === 'stage' || el.id === 'bg' || el.id === 'world' || el.id === 'chrome' || el.id === 'hud-layer')) return { x, y };
    }
    return null;
  });
  assert.ok(p, 'ingen tom yta att trycka på');
  return p;
}

/** Ett tryck med en riktig pekare som färdas dit, som en mus eller ett finger. */
async function tap(x: number, y: number): Promise<void> {
  await page.mouse.move(x, y, { steps: 8 });
  await page.mouse.down();
  await page.mouse.up();
}

/** Rita en handritad slinga runt rektangeln med riktiga mushändelser. */
async function draw(x: number, y: number, w: number, h: number): Promise<void> {
  const pts: Array<[number, number]> = [];
  const cx = x + w / 2;
  const cy = y + h / 2;
  const p = 5.2;
  for (let i = 0; i <= 60; i++) {
    const a = -Math.PI * 0.78 + (i / 60) * 2 * Math.PI * 1.05;
    const c = Math.cos(a);
    const s = Math.sin(a);
    pts.push([cx + ((Math.sign(c) * Math.abs(c) ** (2 / p) * w) / 2) * 0.99, cy + ((Math.sign(s) * Math.abs(s) ** (2 / p) * h) / 2) * 0.99]);
  }
  await page.mouse.move(pts[0][0], pts[0][1], { steps: 4 });
  await page.mouse.down();
  for (const [px, py] of pts.slice(1)) {
    await page.mouse.move(px, py);
    await sleep(6);
  }
  await page.mouse.up();
}

/** Klicka på appens prick (dit pekaren färdas). */
async function clickDot(id: string): Promise<void> {
  const d = await page.evaluate((id) => (window as any).__wb.world.dotOf(id) as { x: number; y: number } | null, id);
  assert.ok(d, `ingen prick för ${id}`);
  await tap(d.x, d.y);
}

/**
 * Tidsmåttet: från släppet (pointerup i skalet, eller en satt starttid) till första bildruta där villkoret gäller.
 * kind 'hud': HUD:en är öppen för en annan app än `prev` och dess inmatning har fokus. kind 'cal': #wb-cal har fokus.
 */
async function installWatch(kind: 'hud' | 'cal', prev = ''): Promise<void> {
  await page.evaluate(
    ([kind, prev]) => {
      const st = { up: 0, at: 0, app: '' };
      (window as any).__wbWatch = st;
      if (kind === 'hud') {
        window.addEventListener(
          'pointerup',
          () => {
            if (!st.up) st.up = performance.now();
          },
          { capture: true, once: true },
        );
      }
      const ok = (): boolean => {
        const a = document.activeElement;
        if (kind === 'cal') return a?.id === 'wb-cal';
        const h = document.querySelector<HTMLElement>('.wbh.is-active') ?? document.querySelector<HTMLElement>('.wbh:not([hidden])');
        if (!h || h.hidden || !h.dataset.app || h.dataset.app === prev) return false;
        st.app = h.dataset.app;
        return !!a?.classList.contains('wbh-input') && h.contains(a);
      };
      const tick = (): void => {
        if (st.up && ok()) {
          st.at = performance.now();
          return;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    },
    [kind, prev] as const,
  );
}

async function readWatch(timeout = 3000): Promise<{ ms: number; app: string }> {
  await page.waitForFunction(() => (window as any).__wbWatch.at > 0, null, { timeout, polling: 'raf' });
  return page.evaluate(() => {
    const st = (window as any).__wbWatch as { up: number; at: number; app: string };
    return { ms: st.at - st.up, app: st.app };
  });
}

/** Prismans DOM i vila: ingen perspektiv, .rot platt utan transform, bara den främre sidan synlig och utan transform. */
function prismSample(id: string): Promise<{ is3d: boolean; front: number; n: number; flat: boolean; face: string | null }> {
  return page.evaluate((id) => {
    const v = ((window as any).__wb.world.debug.views() as Array<{ appId: string; is3d: boolean; front: number; n: number }>).find((x) => x.appId === id);
    const el = document.querySelector(`.wb-win[data-app="${id}"]`);
    const prism = el?.querySelector<HTMLElement>('.wb-prism');
    const rot = el?.querySelector<HTMLElement>('.wb-rot');
    const faces = rot ? ([...rot.children].filter((c) => c.classList.contains('wb-face')) as HTMLElement[]) : [];
    const visible = faces.filter((f) => getComputedStyle(f).visibility !== 'hidden');
    const flat =
      !!prism &&
      !!rot &&
      getComputedStyle(prism).perspective === 'none' &&
      getComputedStyle(rot).transform === 'none' &&
      getComputedStyle(rot).transformStyle === 'flat' &&
      visible.length === 1 &&
      getComputedStyle(visible[0]).transform === 'none';
    return { is3d: !!v?.is3d, front: v?.front ?? -1, n: v?.n ?? 0, flat, face: visible.length === 1 ? (visible[0].dataset.face ?? null) : null };
  }, id);
}

/* ------------------------------ flödet ------------------------------ */

/** Ett steg i kedjan: faller det hoppas resten över, och en skärmbild sparas. */
function step(name: string, fn: (t: TestContext) => Promise<void>): void {
  test(name, async (t) => {
    if (broken) {
      t.skip(`föregående steg föll: ${broken}`);
      return;
    }
    try {
      await fn(t);
    } catch (err) {
      broken = name;
      try {
        await page.screenshot({ path: path.join(SCRATCH, 'shell-flow-fel.png') });
      } catch {
        /* ingen sida */
      }
      throw err;
    }
  });
}

describe('shell-flow (riktig indata, låtsas-Claude)', { skip: noChrome, timeout: 240_000 }, () => {
  let probe = ''; // fyrkanten som Esc tar bort (kalibrering)
  let app = ''; // appen som byggs
  let cube = ''; // den handskrivna tresidiga appen

  before(async () => {
    await startServer();
    const context = await browser!.newContext({ viewport: { width: VW, height: VH }, deviceScaleFactor: 2 });
    if (process.env.WB_SHELL_PLANT === 'k1') {
      // Kalibrering av K1 (bara för hand): ett fönster som löses upp fångar pekaren igen, som före rättningen.
      await context.addInitScript(() => {
        new MutationObserver((ms) => {
          for (const m of ms) {
            const el = m.target as HTMLElement;
            if (el.classList?.contains('wb-gone')) el.classList.remove('wb-gone');
            if (el.inert) el.inert = false;
          }
        }).observe(document, { subtree: true, attributes: true, attributeFilter: ['class', 'inert'] });
      });
    }
    page = await context.newPage();
    page.on('pageerror', (e) => errors.push(`pageerror: ${String(e)}`));
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      const url = m.location()?.url ?? '';
      if (url.includes('.localhost:')) return; // appernas egna origins
      errors.push(`${m.text()} @ ${url}`);
    });
    await page.goto(`${BASE}/`, { waitUntil: 'load' });
    await page.waitForFunction(() => (window as any).__wb?.store?.connected === true, null, { timeout: 45_000 });
  });

  after(async () => {
    if (broken && home) {
      try {
        fs.copyFileSync(path.join(home, 'server.log'), path.join(SCRATCH, 'shell-flow-server.log'));
      } catch {
        /* ingen logg */
      }
    }
    await browser?.close().catch(() => {});
    await stopServer();
    if (home) fs.rmSync(home, { recursive: true, force: true });
  });

  step('kalibrering: konsolfel fångas och tidsmåttet stämmer mot känd fördröjning', async (t) => {
    await page.evaluate(() => console.error('planterat fel (kalibrering)'));
    await sleep(100);
    assert.equal(errors.filter((e) => e.includes('planterat fel')).length, 1, `konsolfelet fångades inte: ${errors.join(' | ')}`);
    errors.length = 0;

    await installWatch('cal');
    await page.evaluate(() => {
      const inp = document.createElement('input');
      inp.id = 'wb-cal';
      inp.style.cssText = 'position:fixed;left:-200px;top:0;opacity:0';
      document.body.append(inp);
      (window as any).__wbWatch.up = performance.now();
      setTimeout(() => inp.focus(), 300);
    });
    const cal = await readWatch();
    await page.evaluate(() => document.getElementById('wb-cal')?.remove());
    // Undre gränsen är exakt (setTimeout kommer aldrig för tidigt); den övre ger plats för en sen timer och en bildruta.
    assert.ok(cal.ms >= 295 && cal.ms <= 380, `känd fördröjning 300 ms mättes till ${cal.ms.toFixed(1)} ms`);
    t.diagnostic(`kalibrering: känd fördröjning 300 ms mättes till ${cal.ms.toFixed(1)} ms`);
  });

  step('tom yta: inga fönster, ingen krom, ingen HUD', async () => {
    const s = await page.evaluate(() => {
      const wb = (window as any).__wb;
      const h = document.querySelector<HTMLElement>('.wbh');
      return {
        scene: (wb.store.scene.windows as unknown[]).length,
        wins: document.querySelectorAll('.wb-win').length,
        chrome: document.querySelectorAll('#chrome .wb-cw, #chrome .wb-markers > *').length,
        hud: !!h && !h.hidden,
      };
    });
    assert.deepEqual(s, { scene: 0, wins: 0, chrome: 0, hud: false });
  });

  step('Esc tar bort en orörd fyrkant, och ett nytt drag på samma ställe direkt efteråt ritar', async (t) => {
    // Kalibreringen för "fönstret står kvar": en ritad men orörd fyrkant som Esc tar bort måste fälla kontrollen.
    await draw(200, 150, 560, 380);
    await page.waitForFunction(() => document.activeElement?.classList.contains('wbh-input') && !!(document.activeElement?.closest('.wbh') as HTMLElement | null)?.dataset.app, null, { timeout: 3000 });
    probe = (await hud()).app ?? '';
    assert.match(probe, /^a[a-z0-9]{6}$/);
    const before = { w: await winState(probe), s: await serverHas(probe) };
    assert.ok(kept(before.w, before.s), `fyrkanten finns inte: ${JSON.stringify(before)}`);

    await installWatch('hud', probe);
    await page.keyboard.press('Escape');
    await sleep(80);
    // K1: ett nytt drag på samma ställe medan den gamla fyrkanten löses upp.
    await draw(200, 150, 560, 380);
    const w = await readWatch();
    app = w.app;
    assert.ok(app && app !== probe, `inget nytt fönster ritades (app=${app})`);
    assert.ok(w.ms < 600, `inmatningen fick fokus ${w.ms.toFixed(0)} ms efter släppet`);
    t.diagnostic(`fokus ${w.ms.toFixed(0)} ms efter släppet`);

    // Esc-fyrkanten är borta överallt, så kontrollen "står kvar" fälls på den.
    await page.waitForFunction((id) => !document.querySelector(`.wb-win[data-app="${id}"]`), probe, { timeout: 3000 });
    const after = { w: await winState(probe), s: await serverHas(probe) };
    assert.ok(!kept(after.w, after.s), 'kalibrering: kontrollen "står kvar" fälldes inte av en borttagen fyrkant');
    assert.ok(gone(after.w, after.s), `Esc-fyrkanten finns kvar någonstans: ${JSON.stringify(after)}`);
  });

  step('skriv och Enter: bygget syns (pricken pulserar, ljusbandet sveper)', async () => {
    const building = (id: string) =>
      page.evaluate((id) => {
        const wb = (window as any).__wb;
        const el = document.querySelector(`.wb-win[data-app="${id}"]`);
        const band = el?.querySelector('.wb-band');
        return {
          status: wb.store.apps.get(id)?.status as string,
          cls: !!el?.classList.contains('wb-building'),
          band: band ? Number(getComputedStyle(band).opacity) : -1,
          rate: (wb.world.debug.breathRate(id) as number | null) ?? 0,
          frames: el ? el.querySelectorAll('iframe').length : -1,
        };
      }, id);
    // Kalibrering: före Enter står appen stilla och har ingen sida, så båda kontrollerna nedan fälls här.
    const idle = await building(app);
    assert.ok(!(idle.cls && idle.band > 0.5 && idle.rate >= 3), `bygget syns redan före Enter: ${JSON.stringify(idle)}`);
    assert.equal(idle.frames, 0, 'en sida finns redan före bygget');

    await page.keyboard.type('Anteckningar för veckan', { delay: 12 });
    await page.keyboard.press('Enter');
    await page.waitForFunction(
      (id) => {
        const wb = (window as any).__wb;
        const el = document.querySelector(`.wb-win[data-app="${id}"]`);
        const band = el?.querySelector('.wb-band');
        return (
          wb.store.apps.get(id)?.status === 'building' &&
          !!el?.classList.contains('wb-building') &&
          !!band &&
          Number(getComputedStyle(band).opacity) > 0.5 &&
          ((wb.world.debug.breathRate(id) as number | null) ?? 0) >= 3
        );
      },
      app,
      { timeout: 10_000, polling: 'raf' },
    );
  });

  step('klart: ett svar i HUD:en och appens sida i iframen', async () => {
    await page.waitForFunction(
      (id) => {
        const a = (window as any).__wb.store.apps.get(id);
        return a?.status === 'idle' && a.built === true;
      },
      app,
      { timeout: 20_000 },
    );
    const replies = () =>
      page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>('.wbh:not([hidden]) .wbh-msgs .wbh-reply')].filter((e) => !e.hidden && (e.textContent ?? '').trim()).map((e) => (e.textContent ?? '').trim()),
      );
    await page.waitForFunction(() => [...document.querySelectorAll('.wbh:not([hidden]) .wbh-msgs .wbh-reply')].some((e) => (e.textContent ?? '').startsWith('Klart.')), null, { timeout: 5000 });
    await sleep(500);
    const r = await replies();
    assert.equal(r.length, 1, `svaren: ${JSON.stringify(r)}`);
    assert.match(r[0], /^Klart\. Anteckningarna sparas/);
    // Kalibrering av räkningen: ett planterat dubbelsvar räknas som två.
    await page.evaluate(() => {
      const m = document.querySelector('.wbh:not([hidden]) .wbh-msgs .wbh-reply');
      const c = m?.cloneNode(true) as HTMLElement | undefined;
      if (c) {
        c.dataset.planted = '1';
        m?.parentElement?.append(c);
      }
    });
    assert.equal((await replies()).length, 2, 'kalibrering: dubbelsvaret räknades inte');
    await page.evaluate(() => document.querySelector('[data-planted]')?.remove());

    const frame = page.frameLocator(`.wb-win[data-app="${app}"] iframe`).first();
    await frame.locator('textarea[aria-label="Ny anteckning"]').waitFor({ state: 'visible', timeout: 8000 });
    assert.equal(await frame.getByRole('button', { name: 'Lägg till' }).count(), 1);
    await sleep(400); // den gamla iframen (om någon) tonas bort på 180 ms
    assert.equal(await page.locator(`.wb-win[data-app="${app}"] iframe`).count(), 1, 'fler än en iframe efter bytet');
  });

  step('tryck på tom yta stänger HUD:en och fönstret står kvar', async () => {
    assert.equal((await hud()).open, true, 'HUD:en är inte öppen före trycket');
    const p = await emptyPoint();
    await tap(p.x, p.y);
    await page.waitForFunction(() => !document.querySelector('.wbh:not([hidden])'), null, { timeout: 3000 });
    await sleep(700); // längre än upplösningen, så att en borttagning hade hunnit synas
    const h = await hud();
    assert.equal(h.hudApp, null);
    const w = await winState(app);
    const s = await serverHas(app);
    assert.ok(kept(w, s), `fönstret försvann: ${JSON.stringify({ w, s })}`);
  });

  step('klick på pricken öppnar HUD:en igen', async () => {
    await clickDot(app);
    await page.waitForFunction(
      (id) => document.activeElement?.classList.contains('wbh-input') && (document.activeElement?.closest('.wbh:not([hidden])') as HTMLElement | null)?.dataset.app === id,
      app,
      { timeout: 3000 },
    );
  });

  step('omladdning: fönstret, HUD:en och utkastet finns kvar', async () => {
    const restored = () =>
      page.evaluate((id) => {
        const h = document.querySelector<HTMLElement>(`.wbh[data-app="${id}"]`);
        const a = document.activeElement as HTMLTextAreaElement | null;
        return !!h && !h.hidden && !!a && h.contains(a) && !!a?.classList.contains('wbh-input') && a.value === 'ett utkast';
      }, app);
    // Kalibrering: utan utkastet fälls kontrollen.
    assert.equal(await restored(), false, 'kalibrering: kontrollen godtog en tom inmatning');
    await page.keyboard.type('ett utkast', { delay: 10 });
    await sleep(200);
    const r0 = (await fits(app)).r;
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => (window as any).__wb?.store?.connected === true, null, { timeout: 30_000 });
    await page.waitForFunction(
      (id) => {
        const h = document.querySelector<HTMLElement>(`.wbh[data-app="${id}"]`);
        const a = document.activeElement as HTMLTextAreaElement | null;
        return !!h && !h.hidden && !!a && h.contains(a) && !!a?.classList.contains('wbh-input') && a.value === 'ett utkast';
      },
      app,
      { timeout: 5000 },
    );
    assert.equal(await restored(), true);
    const r1 = (await fits(app)).r;
    assert.ok(r0 && r1 && Math.abs(r0.x - r1.x) < 1 && Math.abs(r0.y - r1.y) < 1 && Math.abs(r0.w - r1.w) < 1, `fönstret flyttade sig: ${JSON.stringify({ r0, r1 })}`);
    // Töm utkastet igen, så att resten av flödet börjar som förut.
    await page.keyboard.press('Meta+A');
    await page.keyboard.press('Backspace');
    assert.equal(await page.evaluate(() => (document.activeElement as HTMLTextAreaElement | null)?.value ?? null), '');
  });

  step('omladdning medan pekaren vilar över appen: ett nyp där zoomar innan skalet sett pekaren', async (t) => {
    // §10.3: efter omladdningen vet skalet inte var pekaren är, och grinden godtar ändå hjul från en app vars
    // fönster syns och ligger överst i nypets punkt. Kalibrerat mot en planterad grind utan den regeln (som
    // före rättningen): då släpps nypet och zoomen står still.
    const r = (await fits(app)).r!;
    await page.mouse.move(r.x + r.w / 2, r.y + r.h / 2, { steps: 10 });
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => (window as any).__wb?.store?.connected === true, null, { timeout: 30_000 });
    await page.waitForFunction(
      (id) =>
        !!document.querySelector(`.wb-win[data-app="${id}"] iframe.wb-frame:not(.wb-incoming)`) &&
        !!document.querySelector(`.wbh[data-app="${id}"]:not([hidden])`) &&
        !!document.activeElement?.classList.contains('wbh-input') &&
        (document.activeElement?.closest('.wbh') as HTMLElement | null)?.dataset.app === id,
      app,
      { timeout: 8000 },
    );
    const frame = page.frameLocator(`.wb-win[data-app="${app}"] iframe`).first();
    await frame.locator('textarea[aria-label="Ny anteckning"]').waitFor({ state: 'visible', timeout: 8000 });
    await sleep(300);
    const camera = () => page.evaluate(() => (window as any).__wb.world.debug.camera() as { cx: number; cy: number; zoom: number });
    const c0 = await camera();
    await page.keyboard.down('Control');
    for (let i = 0; i < 2; i++) {
      await page.mouse.wheel(0, -30);
      await sleep(25);
    }
    await page.keyboard.up('Control');
    await sleep(400);
    const c1 = await camera();
    assert.ok(c1.zoom > c0.zoom * 1.2, `nypet över appen släpptes efter omladdningen: zoom ${c0.zoom} → ${c1.zoom}`);
    t.diagnostic(`nyp efter omladdningen: zoom ${c0.zoom} → ${c1.zoom.toFixed(2)}`);
    // Tillbaka till kameran före nypet, så att resten av flödet börjar som förut.
    await page.evaluate((c) => (window as any).__wb.world.debug.setCamera(c), c0);
    await sleep(300);
  });

  step('⋯-menyn: Ångra ger ångra-raden och appen går tillbaka till fröet', async () => {
    const notes = () => page.evaluate((id) => [...document.querySelectorAll(`.wbh[data-app="${id}"] .wbh-note`)].filter((e) => e.textContent === 'Ångrade senaste ändringen.').length, app);
    assert.equal(await notes(), 0, 'ångra-raden fanns redan');
    await page.locator(`.wbh[data-app="${app}"] .wbh-more`).click();
    await page.locator(`.wbh[data-app="${app}"] .wbh-menu-item`, { hasText: 'Ångra senaste ändringen' }).click();
    await page.waitForFunction((id) => [...document.querySelectorAll(`.wbh[data-app="${id}"] .wbh-note`)].some((e) => e.textContent === 'Ångrade senaste ändringen.'), app, { timeout: 5000 });
    assert.equal(await notes(), 1);
    await page.waitForFunction((id) => (window as any).__wb.store.apps.get(id)?.built === false, app, { timeout: 5000 });
  });

  step('⌘0 visar allt', async () => {
    // Panorera bort fönstret med vanliga hjul över tom yta; då fälls kontrollen (kalibrering).
    const p = await emptyPoint();
    await page.mouse.move(p.x, p.y, { steps: 6 });
    for (let i = 0; i < 8; i++) {
      await page.mouse.wheel(160, 0);
      await sleep(20);
    }
    await sleep(300);
    const away = await fits(app);
    assert.equal(away.ok, false, `kalibrering: fönstret ryms fortfarande efter panoreringen: ${JSON.stringify(away.r)}`);

    await page.keyboard.press('Meta+0');
    let last = '';
    for (let i = 0; i < 40; i++) {
      await sleep(100);
      const cam = JSON.stringify(await page.evaluate(() => (window as any).__wb.world.debug.camera()));
      if (cam === last) break;
      last = cam;
    }
    const fit = await fits(app);
    assert.ok(fit.ok, `fönstret ryms inte efter ⌘0: ${JSON.stringify(fit.r)}`);
  });

  step('knappen till höger om greppet minimerar appen till raden i nedre vänstra hörnet; ett klick på miniatyren tar fram den till samma plats (§10.7)', async () => {
    type V = { appId: string; minimized: boolean; flying: boolean; tile: { x: number; y: number; w: number; h: number } | null };
    const view = () => page.evaluate((id) => ((window as any).__wb.world.debug.views() as V[]).find((v) => v.appId === id)!, app);
    const before = (await fits(app)).r!;
    const vh = await page.evaluate(() => innerHeight);
    // Kalibrering: före klicket står fönstret på sin plats, inte i hörnet.
    assert.ok(before.x > 30 || before.y + before.h < vh - 30, `kalibrering: fönstret står redan i hörnet: ${JSON.stringify(before)}`);
    assert.equal((await view()).minimized, false);
    // Knappen sitter till höger om greppet (22 px är halva greppet, 16 px mellanrummet), 12,5 px under fönstret.
    const btn = { x: before.x + before.w / 2 + 22 + 16, y: before.y + before.h + 12.5 };
    assert.equal(await page.evaluate((p) => !!document.elementFromPoint(p.x, p.y)?.closest('.wb-minbtn'), btn), true, 'knappen är inte där');
    const p0 = await emptyPoint();
    await page.mouse.move(p0.x, p0.y, { steps: 4 });
    await page.mouse.move(btn.x, btn.y, { steps: 8 });
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForFunction((id) => { const v = (window as any).__wb.world.debug.views().find((x: V) => x.appId === id); return v.minimized && !v.flying && !!v.tile; }, app, { timeout: 3000 });
    const m = await view();
    assert.ok(m.tile && Math.abs(m.tile.x - 18) < 1 && Math.abs(m.tile.y + m.tile.h - (vh - 18)) < 1 && m.tile.h <= 84.5, `miniatyren står inte i hörnet: ${JSON.stringify(m.tile)}`);
    assert.equal((await hud()).open, false, 'appens HUD stängdes');
    await page.waitForFunction(async (id) => {
      const r = await fetch('/api/snapshot', { headers: { origin: location.origin } });
      const s = await r.json();
      return typeof s.scene.windows.find((w: { appId: string }) => w.appId === id)?.minimized === 'number';
    }, app, { timeout: 3000 });
    const t = m.tile!;
    const p = await emptyPoint();
    await page.mouse.move(p.x, p.y, { steps: 4 });
    await page.mouse.move(t.x + t.w / 2, t.y + t.h / 2, { steps: 8 });
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForFunction((id) => { const v = (window as any).__wb.world.debug.views().find((x: V) => x.appId === id); return !v.minimized && !v.flying && !v.tile; }, app, { timeout: 3000 });
    const after = (await fits(app)).r!;
    for (const k of ['x', 'y', 'w', 'h'] as const) assert.ok(Math.abs(after[k] - before[k]) < 0.5, `inte på samma plats: ${JSON.stringify({ before, after })}`);
    assert.equal(await page.evaluate(() => (window as any).__wb.world.debug.focused()), app, 'appen är i fokus');
    // HUD:en öppnas igen, som nästa steg väntar sig.
    await page.evaluate((id) => (window as any).__wb.bus.emit('hud:open', { appId: id, reason: 'dot' }), app);
    await page.waitForFunction(() => (window as any).__wb.world.debug.huds().open.length === 1, null, { timeout: 3000 });
    // Tills den glidit ut: linjen till appen tonar in först när panelen står på sin plats.
    await page.waitForFunction((id) => { const t = document.querySelector(`.wbh-tether[data-app="${id}"]`); return !!t && getComputedStyle(t).opacity === '1'; }, app, { timeout: 3000 });
  });

  step('en tresidig app ritas medan den första appens HUD är öppen: båda öppna, den nya aktiv; tryck stänger bara den; ⌃⌥→ och platt i vila', async () => {
    // Den första appens HUD står öppen (§13: att rita stänger ingen annan HUD). Rita utanför både fönstret och panelen.
    const h0 = await hud();
    assert.deepEqual({ open: h0.open, app: h0.app, list: h0.list }, { open: true, app, list: [app] }, 'den första HUD:en är inte öppen före ritandet');
    const a = (await fits(app)).r!;
    const hp = (await hudRect(app))!;
    const right = Math.max(a.x + a.w, hp.x + hp.w);
    const left = Math.min(a.x, hp.x);
    let x = right + 60;
    let w = Math.min(400, VW - 48 - x);
    if (w < 260) {
      w = Math.min(400, left - 60 - 48);
      x = left - 60 - w;
    }
    assert.ok(w >= 260, `ingen plats för en ny fyrkant: ${JSON.stringify({ a, hp })}`);
    // Kalibrering: före ritandet är bara en HUD öppen, så kontrollen "två öppna" fälls.
    assert.notEqual((await hud()).list.length, 2, 'kalibrering: två HUD:ar redan före ritandet');
    await draw(x, Math.max(48, Math.min(a.y, hp.y) + 10), w, Math.min(300, a.h));
    await page.waitForFunction((prev) => {
      const d = (window as any).__wb.world.debug;
      return !!d.hudApp() && d.hudApp() !== prev;
    }, app, { timeout: 3000 });
    cube = (await hud()).app ?? '';
    const created = Date.now();
    const h1 = await hud();
    assert.deepEqual(h1.list, [app, cube], 'båda HUD:arna öppna, i öppningsordning');
    await page.waitForFunction(() => document.activeElement?.classList.contains('wbh-input'), null, { timeout: 3000 });
    assert.equal((await hud()).focused, true, 'den nya är aktiv och har fokus');
    await sleep(400); // utglidningen
    const ra = (await hudRect(app))!;
    const rc = (await hudRect(cube))!;
    const overlap = (p: typeof ra, q: typeof ra) => Math.min(p.x + p.w, q.x + q.w) - Math.max(p.x, q.x) > 0.5 && Math.min(p.y + p.h, q.y + q.h) - Math.max(p.y, q.y) > 0.5;
    assert.equal(overlap(ra, ra), true, 'kalibrering: en rektangel överlappar sig själv');
    assert.equal(overlap(ra, rc), false, `panelerna överlappar: ${JSON.stringify({ ra, rc })}`);
    // Ett tryck på tom yta stänger bara den nya; den första blir aktiv och får fokus.
    const q = await emptyPoint();
    await tap(q.x, q.y);
    await page.waitForFunction((id) => !document.querySelector(`.wbh[data-app="${id}"]`), cube, { timeout: 3000 });
    const h2 = await hud();
    assert.deepEqual({ list: h2.list, app: h2.app, focused: h2.focused }, { list: [app], app, focused: true }, 'den första blev aktiv med fokus');
    assert.ok(kept(await winState(cube), await serverHas(cube)), 'den nya fyrkanten försvann');
    // Ett andra tryck stänger den första också.
    await tap(q.x, q.y);
    await page.waitForFunction(() => !document.querySelector('.wbh:not([hidden])'), null, { timeout: 3000 });
    assert.deepEqual((await hud()).list, []);

    // Skriv appen för hand (bevakaren läser av apparna varje sekund, så vänta in den först).
    await sleep(Math.max(0, 1300 - (Date.now() - created)));
    const dir = path.join(home, 'apps', cube);
    const page0 = (text: string, bg: string) =>
      `<!doctype html>\n<html lang="sv">\n<head>\n<meta charset="utf-8">\n<title>Tre sidor</title>\n<style>html,body{margin:0;height:100%}body{display:grid;place-items:center;background:${bg};font:600 32px/1.2 var(--wb-font)}</style>\n</head>\n<body><p>${text}</p></body>\n</html>\n`;
    fs.writeFileSync(path.join(dir, 'sida2.html'), page0('Sida två', '#e8f0ff'));
    fs.writeFileSync(path.join(dir, 'sida3.html'), page0('Sida tre', '#fff3e0'));
    fs.writeFileSync(path.join(dir, 'index.html'), page0('Sida ett', '#ffffff'));
    fs.writeFileSync(
      path.join(dir, 'app.json'),
      `${JSON.stringify({ name: 'Tre sidor', faces: [{ id: 'main', page: 'index.html' }, { id: 'sida2', page: 'sida2.html' }, { id: 'sida3', page: 'sida3.html' }] }, null, 2)}\n`,
    );
    await page.waitForFunction(
      (id) => {
        const wb = (window as any).__wb;
        const a = wb.store.apps.get(id);
        const v = (wb.world.debug.views() as Array<{ appId: string; n: number }>).find((x) => x.appId === id);
        // Tre egna sidor plus sidan Förslag (§10.8), som skalet lägger sist på varje byggd app.
        return a?.built === true && a.faces.length === 3 && v?.n === 4;
      },
      cube,
      { timeout: 10_000 },
    );
    const front = page.frameLocator(`.wb-win[data-app="${cube}"] .wb-face[data-face="main"] iframe`);
    await front.getByText('Sida ett').waitFor({ state: 'visible', timeout: 8000 });

    // Fokus: klicka i appen med en pekare som färdas dit genom skalet.
    const r = (await fits(cube)).r!;
    await page.mouse.move(r.x + r.w / 2, r.y + r.h - 24, { steps: 12 });
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForFunction((id) => (window as any).__wb.world.debug.focused() === id, cube, { timeout: 3000 });
    await page.waitForFunction((id) => {
      const v = ((window as any).__wb.world.debug.views() as Array<{ appId: string; is3d: boolean }>).find((x) => x.appId === id);
      return v && !v.is3d;
    }, cube, { timeout: 5000 });
    const rest0 = await prismSample(cube);
    assert.deepEqual({ front: rest0.front, flat: rest0.flat, face: rest0.face }, { front: 0, flat: true, face: 'main' });

    // Vrid och sampla varje bildruta i 1,6 s.
    await page.evaluate((id) => {
      const out: Array<{ is3d: boolean; flat: boolean }> = [];
      (window as any).__wbRot = out;
      const t0 = performance.now();
      const tick = (): void => {
        const v = ((window as any).__wb.world.debug.views() as Array<{ appId: string; is3d: boolean }>).find((x) => x.appId === id);
        const rot = document.querySelector<HTMLElement>(`.wb-win[data-app="${id}"] .wb-rot`);
        out.push({ is3d: !!v?.is3d, flat: !!rot && getComputedStyle(rot).transform === 'none' });
        if (performance.now() - t0 < 1600) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }, cube);
    await page.keyboard.press('Control+Alt+ArrowRight');
    await sleep(1800);
    const frames = await page.evaluate(() => (window as any).__wbRot as Array<{ is3d: boolean; flat: boolean }>);
    // Kalibrering: mitt i vridningen är prisman i 3D, så kontrollen "platt" fälls där.
    assert.ok(frames.some((f) => f.is3d && !f.flat), `ingen bildruta i 3D under vridningen (${frames.length} bildrutor)`);
    const rest = await prismSample(cube);
    assert.deepEqual({ is3d: rest.is3d, front: rest.front, flat: rest.flat, face: rest.face }, { is3d: false, front: 1, flat: true, face: 'sida2' });
    const second = page.frameLocator(`.wb-win[data-app="${cube}"] .wb-face[data-face="sida2"] iframe`);
    await second.getByText('Sida två').waitFor({ state: 'visible', timeout: 3000 });
  });

  step('två HUD:ar öppna med pricken: Esc stänger bara den aktiva, sedan nästa; apparna står kvar (kalibrerat)', async () => {
    // Båda apparna är byggda nu, så Esc tar inte bort någon av dem (§13: bara oanvända tas bort med Esc).
    assert.deepEqual((await hud()).list, [], 'en HUD är redan öppen före steget');
    const openBoth = async (): Promise<void> => {
      for (const id of [app, cube]) {
        // Pricken måste gå att träffa (ingen HUD över den).
        const hit = await page.evaluate((id) => {
          const d = (window as any).__wb.world.dotOf(id) as { x: number; y: number } | null;
          const el = d ? document.elementFromPoint(d.x, d.y) : null;
          return !!el?.closest('.wb-dot');
        }, id);
        assert.ok(hit, `pricken för ${id} är täckt`);
        await clickDot(id);
        await page.waitForFunction((id) => (window as any).__wb.world.debug.hudApp() === id, id, { timeout: 3000 });
      }
      await page.waitForFunction(
        (id) => (document.activeElement?.closest('.wbh') as HTMLElement | null)?.dataset.app === id && document.activeElement?.classList.contains('wbh-input'),
        cube,
        { timeout: 3000 },
      );
      const h = await hud();
      assert.deepEqual({ list: h.list, app: h.app, focused: h.focused }, { list: [app, cube], app: cube, focused: true }, 'båda öppna, den senast öppnade aktiv med fokus');
    };
    const onlyActiveClosed = async (): Promise<boolean> => {
      const h = await hud();
      return h.list.length === 1 && h.list[0] === app && h.app === app && h.focused;
    };

    // Kalibrering: en planterad Esc som stänger alla HUD:ar fäller kontrollen "bara den aktiva".
    await openBoth();
    await page.evaluate(() => {
      const wb = (window as any).__wb;
      const plant = (e: KeyboardEvent): void => {
        if (e.key !== 'Escape') return;
        for (const id of wb.world.debug.huds().open as string[]) wb.bus.emit('hud:close', { appId: id });
      };
      (window as any).__wbPlant = plant;
      window.addEventListener('keydown', plant, true);
    });
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.wbh'), null, { timeout: 3000 });
    assert.equal(await onlyActiveClosed(), false, 'kalibrering: den planterade Esc stängde inte allt');
    await page.evaluate(() => window.removeEventListener('keydown', (window as any).__wbPlant, true));

    // Riktigt: Esc stänger den aktiva (den nya), och den första blir aktiv med fokus i sin inmatning.
    await openBoth();
    await page.keyboard.press('Escape');
    await page.waitForFunction((id) => !document.querySelector(`.wbh[data-app="${id}"]`), cube, { timeout: 3000 });
    await sleep(300);
    assert.equal(await onlyActiveClosed(), true, `Esc stängde fel: ${JSON.stringify(await hud())}`);
    // Nästa Esc stänger den första.
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.wbh'), null, { timeout: 3000 });
    const h = await hud();
    assert.deepEqual({ list: h.list, app: h.app }, { list: [], app: null });
    assert.ok(kept(await winState(cube), await serverHas(cube)), 'Esc tog bort den tresidiga appen');
    assert.ok(kept(await winState(app), await serverHas(app)), 'Esc tog bort den första appen');
  });

  step('fältet (§10.9): utan öppen HUD öppnar det första tecknet fältet; text som ingen app tar ger ett byggförslag, och Avbryt bygger inget (kalibrerat: med en HUD öppen går tecknet till HUD:en)', async () => {
    const fieldOpen = () => page.evaluate(() => { const f = document.querySelector('.wbf') as HTMLElement | null; return !!f && !f.hidden; });
    const closeHuds = () => page.evaluate(() => { const w = (window as any).__wb; for (const id of w.world.debug.huds().open) w.bus.emit('hud:close', { appId: id }); });
    const blur = () => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
    // Kalibrering: med en HUD öppen hamnar tecknet i HUD:en.
    await clickDot(cube);
    await page.waitForFunction((id) => !!document.querySelector(`.wbh[data-app="${id}"]:not([hidden])`), cube, { timeout: 3000 });
    await blur();
    await page.keyboard.type('q');
    assert.equal(await page.evaluate((id) => (document.querySelector(`.wbh[data-app="${id}"] .wbh-input`) as HTMLTextAreaElement).value, cube), 'q', 'kalibrering: tecknet hamnade inte i HUD:en');
    assert.equal(await fieldOpen(), false, 'kalibrering: fältet öppnades med en HUD öppen');
    await page.evaluate((id) => { const i = document.querySelector(`.wbh[data-app="${id}"] .wbh-input`) as HTMLTextAreaElement; i.value = ''; i.dispatchEvent(new Event('input')); }, cube);
    await closeHuds();
    await page.waitForFunction(() => (window as any).__wb.world.debug.huds().open.length === 0, null, { timeout: 3000 });
    await sleep(500);
    const apps0 = await page.evaluate(() => (window as any).__wb.store.apps.size);
    await blur();
    await page.keyboard.type('köp mjölk');
    assert.equal(await fieldOpen(), true, 'fältet öppnades inte');
    assert.equal(await page.evaluate(() => (document.querySelector('.wbf-input') as HTMLInputElement).value), 'köp mjölk');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => { const c = document.querySelector('.wbf-card') as HTMLElement | null; return !!c && !c.hidden; }, null, { timeout: 5000 });
    const card = await page.evaluate(() => document.querySelector('.wbf-card')!.textContent);
    assert.ok(card!.includes('Ingen app passar.') && card!.includes('köp mjölk'), `förslaget: ${card}`);
    await page.locator('.wbf-card .wbh-btn', { hasText: 'Avbryt' }).click();
    assert.equal(await fieldOpen(), false, 'Avbryt stängde inte fältet');
    await sleep(300);
    assert.equal(await page.evaluate(() => (window as any).__wb.store.apps.size), apps0, 'Avbryt byggde en app');
  });

  step('Ta bort i ⋯-menyn med bekräftelse: fönstret är borta och servern har inte appen', async () => {
    const before = { w: await winState(cube), s: await serverHas(cube) };
    // Kalibrering: kontrollen "borta" fälls medan appen finns.
    assert.ok(!gone(before.w, before.s) && kept(before.w, before.s), `appen saknas redan: ${JSON.stringify(before)}`);
    await clickDot(cube);
    await page.waitForFunction((id) => !!document.querySelector(`.wbh[data-app="${id}"]:not([hidden])`), cube, { timeout: 3000 });
    await page.locator(`.wbh[data-app="${cube}"] .wbh-more`).click();
    await page.locator(`.wbh[data-app="${cube}"] .wbh-menu-item`, { hasText: 'Ta bort appen' }).click();
    await page.locator(`.wbh[data-app="${cube}"] .wbh-menu-confirm .wbh-btn`, { hasText: 'Ta bort' }).click();
    await page.waitForFunction((id) => !document.querySelector(`.wb-win[data-app="${id}"]`), cube, { timeout: 5000 });
    let after = { w: await winState(cube), s: await serverHas(cube) };
    for (let i = 0; i < 20 && !gone(after.w, after.s); i++) {
      await sleep(150);
      after = { w: await winState(cube), s: await serverHas(cube) };
    }
    assert.ok(gone(after.w, after.s), `appen finns kvar: ${JSON.stringify(after)}`);
    assert.equal(fs.existsSync(path.join(home, 'apps', cube)), false, 'appens mapp finns kvar');
    const trash = fs.readdirSync(path.join(home, 'data', 'trash'));
    assert.ok(trash.some((d) => d.startsWith(`${cube}-`)), `inte i papperskorgen: ${JSON.stringify(trash)}`);
    // Den första appen rördes inte.
    assert.ok(kept(await winState(app), await serverHas(app)), 'den första appen försvann också');
  });

  step('krysset under fönstret tar bort appen först vid andra klicket; Esc avbryter (kalibrerat: ett klick tar inte bort)', async () => {
    const r = (await fits(app)).r!;
    const btn = { x: r.x + r.w / 2 + 22 + 16 + 24, y: r.y + r.h + 12.5 };
    assert.equal(await page.evaluate((p) => !!document.elementFromPoint(p.x, p.y)?.closest('.wb-delbtn'), btn), true, 'krysset är inte där');
    const p0 = await emptyPoint();
    const click = async () => {
      await page.mouse.move(p0.x, p0.y, { steps: 4 });
      await page.mouse.move(btn.x, btn.y, { steps: 8 });
      await page.mouse.down();
      await page.mouse.up();
    };
    await click();
    await sleep(200);
    assert.ok(kept(await winState(app), await serverHas(app)), 'kalibrering: ett klick tog bort appen');
    await page.keyboard.press('Escape');
    await sleep(200);
    await click();
    await sleep(200);
    assert.ok(kept(await winState(app), await serverHas(app)), 'efter Esc ska klicket bara fråga igen');
    await click();
    await page.waitForFunction((id) => !document.querySelector(`.wb-win[data-app="${id}"]`), app, { timeout: 5000 });
    let after = { w: await winState(app), s: await serverHas(app) };
    for (let i = 0; i < 20 && !gone(after.w, after.s); i++) {
      await sleep(150);
      after = { w: await winState(app), s: await serverHas(app) };
    }
    assert.ok(gone(after.w, after.s), `appen finns kvar: ${JSON.stringify(after)}`);
  });

  step('inga fel i skalets konsol', async () => {
    assert.deepEqual(errors, []);
  });
});
