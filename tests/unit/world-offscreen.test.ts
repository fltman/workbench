// world-offscreen.test.ts — det ingen ser kostar inget (CONTRACT §10.5, §10.8, §14), i riktig Chrome mot en egen server
// (låtsas-Claude, lediga portar, tillfälligt hem under .scratch/world-offscreen-*). Saknas Chrome hoppas filen över.
//   O1 en app långt utanför vyn får sina iframes dolda (wb-offscreen), en i vyn och en minimerad inte, marginalen är
//      fönstrets största sida men minst en halv vy, och en app vars iframe har tangentbordsfokus döljs aldrig
//      (kalibrerat: att dölja den tar fokus från den).
//   O2 i vila går bara de animationer som syns: pricken andas inte i raden, under ett annat fönster eller utanför vyn,
//      sidan Förslag har ingen LED förrän förslagen hämtas och fröytans ljusband sveper bara under bygget och medan det
//      tonar ut. Pricken andas fortfarande fortare under bygget och blinkar när appen väntar (fälldes av koden före
//      rättelsen: tio animationer i stället för två).
//   O3 kromen till ett fönster långt utanför vyn läggs inte ut och står still, kommer tillbaka på rätt plats i första
//      bildrutan (DOM:en och en skärmbild av just den bildrutan, med rAF fryst efter den; kalibrerat mot en plats som
//      rättas en bildruta för sent), och en armerad Ta bort avbryts.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { chromium, type Browser, type Page } from 'playwright-core';
import { testPort } from '../ports.ts';

const root = path.resolve(import.meta.dirname, '../..');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
let page: Page;
let home = '';
let viteCache = '';
let serverLog = '';

type R = { x: number; y: number; w: number; h: number };

/** Kameran där testerna börjar: W1, W2 och W3 i vyn, W5 långt till höger. */
const CAM = { cx: 700, cy: 400, zoom: 1 };
let W1 = ''; // i vyn, fri
let W2 = ''; // i vyn, pricken under W3
let W3 = ''; // i vyn, över W2:s övre högra hörn
let W4 = ''; // minimerad (platsen i världen långt till vänster)
let W5 = ''; // långt utanför vyn

async function setCam(c: { cx: number; cy: number; zoom: number }): Promise<void> {
  await page.evaluate((c) => (window as any).__wb.world.debug.setCamera(c), c);
  await frames(2);
}

async function frames(n = 2): Promise<void> {
  await page.evaluate((k) => new Promise<void>((res) => {
    let i = 0;
    const f = () => (++i >= k ? res() : requestAnimationFrame(f));
    requestAnimationFrame(f);
  }), n);
}

/** En app som låtsas-Claude bygger (texten väljer sorten, §8.9). */
async function build(x: number, y: number, text: string): Promise<string> {
  const id = await page.evaluate(async ([px, py, t]) => {
    const w = (window as any).__wb;
    const res = await w.store.createApp({ x: px, y: py, w: 480, h: 320, scale: 1 });
    w.store.send({ t: 'chat.send', appId: res.app.id, text: t, via: 'text' });
    return res.app.id as string;
  }, [x, y, text] as const);
  return id;
}

/** Fönstrets iframe (appens första sida) och om den är dold. */
const frameOf = (id: string) =>
  page.evaluate((a) => {
    const win = document.querySelector(`.wb-win[data-app="${a}"]`) as HTMLElement;
    const fr = win.querySelector('iframe.wb-frame:not(.wb-incoming)') as HTMLIFrameElement;
    return { cls: win.classList.contains('wb-offscreen'), visibility: getComputedStyle(fr).visibility, focused: document.activeElement === fr };
  }, id);

/** Animationerna som går i världen och kromen (inte HUD:arnas), utan övergångar som bara pågår en stund. */
const runningInWorld = () =>
  page.evaluate(() => {
    const w = (window as any).__wb.world;
    const ids = [...(window as any).__wb.store.apps.keys()] as string[];
    return document
      .getAnimations()
      .filter((a) => a.playState === 'running' && !(a instanceof CSSTransition))
      .map((a) => {
        const t = (a.effect as KeyframeEffect | null)?.target as Element | null;
        if (!t || t.closest('#hud-layer')) return null;
        const dot = t.closest('.wb-dot');
        let app = '';
        if (dot) {
          const r = dot.getBoundingClientRect();
          app = ids.find((id) => {
            const d = w.dotOf(id);
            return d && Math.hypot(d.x - (r.x + r.width / 2), d.y - (r.y + r.height / 2)) < 1.5;
          }) ?? '?';
        } else app = (t.closest('.wb-win') as HTMLElement | null)?.dataset.app ?? '?';
        const kind = (t as HTMLElement).className || t.tagName;
        return `${app}:${kind}`;
      })
      .filter((x): x is string => !!x)
      .sort();
  });

/** Prickens kromelement (knappen) för appen: den vars mitt står på world.dotOf, och om den syns. */
const dotEl = (id: string) =>
  page.evaluate((a) => {
    const d = (window as any).__wb.world.dotOf(a);
    for (const b of document.querySelectorAll<HTMLElement>('#chrome .wb-dot')) {
      const r = b.getBoundingClientRect();
      if (Math.hypot(d.x - (r.x + r.width / 2), d.y - (r.y + r.height / 2)) < 1.5) {
        const cw = b.closest('.wb-cw') as HTMLElement;
        return { found: true, shown: getComputedStyle(cw).display !== 'none' && r.width > 0 };
      }
    }
    return { found: false, shown: false };
  }, id);

/** Rutorna i en skärmbild (PNG) som är tydligt blå: deras tyngdpunkt i CSS-px inom klippet. */
function bluest(png: Buffer, scale: number): { x: number; y: number; n: number } {
  const { w, h, rgba } = decodePng(png);
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const r = rgba[i];
      const g = rgba[i + 1];
      const b = rgba[i + 2];
      if (b - (r + g) / 2 > 110 && b > 200) {
        sx += x;
        sy += y;
        n++;
      }
    }
  }
  return n ? { x: sx / n / scale, y: sy / n / scale, n } : { x: NaN, y: NaN, n: 0 };
}

/** En minimal PNG-avkodare (8 bitar, RGB eller RGBA, utan interlace), som Chromes skärmbilder. */
function decodePng(buf: Buffer): { w: number; h: number; rgba: Uint8Array } {
  let p = 8;
  let w = 0;
  let h = 0;
  let type = 0;
  const idat: Buffer[] = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const kind = buf.toString('latin1', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (kind === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      if (data[8] !== 8 || data[12] !== 0) throw new Error('bara 8 bitar utan interlace');
      type = data[9];
    } else if (kind === 'IDAT') idat.push(data);
    else if (kind === 'IEND') break;
    p += 12 + len;
  }
  const bpp = type === 6 ? 4 : type === 2 ? 3 : 0;
  if (!bpp) throw new Error(`PNG-typ ${type} stöds inte`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const out = new Uint8Array(w * h * 4);
  const prev = new Uint8Array(stride);
  const cur = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const pa = Math.abs(b - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - 2 * c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[i] = v & 255;
    }
    for (let x = 0; x < w; x++) {
      out[(y * w + x) * 4] = cur[x * bpp];
      out[(y * w + x) * 4 + 1] = cur[x * bpp + 1];
      out[(y * w + x) * 4 + 2] = cur[x * bpp + 2];
      out[(y * w + x) * 4 + 3] = bpp === 4 ? cur[x * bpp + 3] : 255;
    }
    prev.set(cur);
  }
  return { w, h, rgba: out };
}

describe('det ingen ser i riktig Chrome', { skip: noChrome, timeout: 240_000 }, () => {
  before(async () => {
    const port = await testPort();
    viteCache = path.join(root, 'node_modules', `.vite-${port}`);
    const hmr = await testPort();
    const homeDir = path.join(root, '.scratch');
    fs.mkdirSync(homeDir, { recursive: true });
    home = fs.mkdtempSync(path.join(homeDir, `world-offscreen-${process.pid}-`));
    server = spawn(process.execPath, [path.join(root, 'server/main.ts')], {
      cwd: root,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        TMPDIR: process.env.TMPDIR ?? '',
        WORKBENCH_PORT: String(port),
        WORKBENCH_HMR_PORT: String(hmr),
        WORKBENCH_HOME: home,
        WORKBENCH_FAKE_CLAUDE: '1',
        WORKBENCH_FAKE_SPEED: '4',
        WORKBENCH_STT: 'off',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout?.on('data', (d) => (serverLog += String(d)));
    server.stderr?.on('data', (d) => (serverLog += String(d)));
    const base = `http://localhost:${port}`;
    for (let i = 0; i < 100; i++) {
      try {
        const r = await fetch(`${base}/api/snapshot`, { headers: { origin: base } });
        if (r.ok) break;
      } catch {
        /* inte uppe än */
      }
      await sleep(150);
    }
    const ctx = await browser!.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
    page = await ctx.newPage();
    await page.goto(base + '/');
    await page.waitForFunction(() => (window as any).__wb?.store?.connected === true, null, { timeout: 60_000 });
    // I skärmen med kameran CAM: W1 (80, 90)–(560, 410), W2 (660, 90)–(1140, 410), W3 (920, 70)–(1400, 390) över W2:s
    // prick, W4 långt till vänster (minimeras), W5 långt till höger. W3 skapas efter W2 och ligger därför över den.
    W1 = await build(60, 40, 'anteckningar');
    W2 = await build(640, 40, 'anteckningar');
    W3 = await build(900, 20, 'en klocka');
    W4 = await build(-3000, 40, 'anteckningar');
    W5 = await build(6000, 0, 'en klocka');
    const ids = [W1, W2, W3, W4, W5];
    await page.waitForFunction(
      (ids) => ids.every((id) => {
        const a = (window as any).__wb.store.apps.get(id);
        return a?.built === true && a.status === 'idle' && !!document.querySelector(`.wb-win[data-app="${id}"] iframe.wb-frame:not(.wb-incoming)`);
      }),
      ids,
      { timeout: 90_000, polling: 200 },
    );
    await page.evaluate((id) => (window as any).__wb.world.minimize(id), W4);
    await setCam(CAM);
    await sleep(1500); // flykten ned i raden (720 ms) och iframes som tonar in
  }, { timeout: 150_000 });

  after(async () => {
    await browser?.close().catch(() => {});
    if (server && server.exitCode === null) {
      server.kill('SIGTERM');
      await Promise.race([new Promise((r) => server?.once('exit', r)), sleep(8000)]);
    }
    if (home) fs.rmSync(home, { recursive: true, force: true });
    if (viteCache) fs.rmSync(viteCache, { recursive: true, force: true });
  }, { timeout: 30_000 });

  test('O1 iframes långt utanför vyn döljs, i vyn och i raden inte; marginalen är minst en halv vy; en iframe med fokus döljs aldrig (kalibrerat)', async () => {
    await setCam(CAM);
    assert.deepEqual(await frameOf(W1), { cls: false, visibility: 'visible', focused: false }, 'i vyn');
    assert.deepEqual(await frameOf(W4), { cls: false, visibility: 'visible', focused: false }, 'minimerad: syns i raden');
    assert.deepEqual(await frameOf(W5), { cls: true, visibility: 'hidden', focused: false }, 'långt utanför vyn');
    // Marginalen är fönstrets största sida, men minst en halv vy: W5 (480 × 320) döljs när den ligger mer än 720 px utanför
    // vyns högra kant (1440 / 2), inte innanför. I zoom 2 (960 px bred) är det fönstrets egen bredd.
    const camFor = (gap: number, zoom = 1) => ({ cx: 6000 - (1440 / 2 + gap) / zoom, cy: 160, zoom }); // W5:s vänsterkant vid x = 1440 + gap
    await setCam(camFor(740));
    assert.equal((await frameOf(W5)).visibility, 'hidden', '740 px utanför: dold');
    await setCam(camFor(700));
    assert.equal((await frameOf(W5)).visibility, 'visible', '700 px utanför: syns redan (förvärmd)');
    await setCam(camFor(980, 2));
    assert.equal((await frameOf(W5)).visibility, 'hidden', 'zoom 2, 980 px utanför: dold');
    await setCam(camFor(940, 2));
    assert.equal((await frameOf(W5)).visibility, 'visible', 'zoom 2, 940 px utanför: syns');
    // Fokus i W5:s app: den döljs inte när kameran går därifrån.
    await setCam(camFor(-600));
    await page.evaluate((a) => (document.querySelector(`.wb-win[data-app="${a}"] iframe.wb-frame:not(.wb-incoming)`) as HTMLIFrameElement).focus(), W5);
    await sleep(100);
    assert.equal((await frameOf(W5)).focused, true, 'kalibrering: W5:s iframe har fokus');
    await setCam(CAM);
    assert.deepEqual(await frameOf(W5), { cls: false, visibility: 'visible', focused: true }, 'med fokus: syns och behåller fokus');
    // Kalibrering: att dölja iframen som har fokus tar fokus från den (därför undantaget).
    await page.evaluate((a) => document.querySelector(`.wb-win[data-app="${a}"]`)!.classList.add('wb-offscreen'), W5);
    await frames(2);
    await sleep(100);
    const planted = await page.evaluate((a) => {
      const fr = document.querySelector(`.wb-win[data-app="${a}"] iframe.wb-frame:not(.wb-incoming)`);
      return { hidden: getComputedStyle(fr!).visibility === 'hidden', focused: document.activeElement === fr };
    }, W5);
    assert.deepEqual(planted, { hidden: true, focused: false }, 'kalibrering: dold iframe tappar fokus');
    // Utan fokus döljs den igen vid nästa bildruta.
    await setCam({ ...CAM, cx: CAM.cx + 1 });
    assert.deepEqual(await frameOf(W5), { cls: true, visibility: 'hidden', focused: false }, 'utan fokus: dold igen');
    // En flygning dit (kantmarkören): framme syns appen.
    await page.evaluate((a) => document.querySelector<HTMLElement>(`.wb-marker[data-app="${a}"]`)!.click(), W5);
    await sleep(600);
    assert.equal((await frameOf(W5)).visibility, 'visible', 'framme');
  });

  test('O2 i vila går bara synliga animationer (prickar, LED, ljusband); pricken andas fortare under bygget och blinkar när appen väntar (kalibrerat mot koden före rättelsen)', async () => {
    await setCam(CAM);
    await sleep(800);
    assert.deepEqual(await runningInWorld(), [`${W1}:wb-dot-halo`, `${W3}:wb-dot-halo`].sort(), 'bara de synliga prickarnas halo andas');
    assert.equal(await page.evaluate(() => document.querySelectorAll('.wb-ideas-led').length), 0, 'ingen LED på sidorna Förslag i vila');

    // Bygger: den synliga pricken andas 3,3 gånger fortare; den täckta står still tills den syns.
    const status = (id: string, s: string) =>
      page.evaluate(([a, st]) => {
        const w = (window as any).__wb;
        w.store.receive({ t: 'app', app: { ...w.store.apps.get(a), status: st } });
      }, [id, s] as const);
    const breath = (id: string) =>
      page.evaluate((a) => {
        const d = (window as any).__wb.world.dotOf(a);
        for (const b of document.querySelectorAll<HTMLElement>('#chrome .wb-dot')) {
          const r = b.getBoundingClientRect();
          if (Math.hypot(d.x - (r.x + r.width / 2), d.y - (r.y + r.height / 2)) >= 1.5) continue;
          const halo = b.querySelector('.wb-dot-halo')!.getAnimations()[0];
          const core = b.querySelector('.wb-dot-core')!.getAnimations().filter((x) => x.effect && (x.effect as KeyframeEffect).getTiming().iterations === Infinity)[0];
          return { halo: halo?.playState ?? 'saknas', rate: halo?.playbackRate ?? 0, blink: core?.playState ?? 'saknas' };
        }
        return null;
      }, id);
    await status(W1, 'building');
    await status(W2, 'building');
    await page.waitForFunction((a) => (window as any).__wb.world.debug.breathRate(a) > 3, W1, { timeout: 3000 });
    assert.deepEqual(await breath(W1), { halo: 'running', rate: 3.3, blink: 'saknas' }, 'synlig och bygger: andas fortare');
    assert.equal((await breath(W2))?.halo, 'paused', 'täckt och bygger: står still');
    await page.evaluate((a) => (window as any).__wb.world.focus(a), W2);
    await frames(2);
    await page.waitForFunction((a) => (window as any).__wb.world.debug.breathRate(a) > 3, W2, { timeout: 3000 });
    assert.deepEqual(await breath(W2), { halo: 'running', rate: 3.3, blink: 'saknas' }, 'överst: andas fortare');
    await status(W1, 'idle');
    await status(W2, 'idle');
    await page.evaluate((a) => (window as any).__wb.world.focus(a), W3);
    await frames(2);

    // Väntar: pricken blinkar där den syns, även liten i raden, men inte utanför vyn.
    await status(W1, 'waiting');
    await status(W4, 'waiting');
    await status(W5, 'waiting');
    await sleep(300);
    assert.equal((await breath(W1))?.blink, 'running', 'synlig och väntar: blinkar');
    assert.equal((await breath(W4))?.blink, 'running', 'i raden och väntar: blinkar (pricken syns där)');
    assert.equal((await breath(W4))?.halo, 'paused', 'i raden: halon syns inte och andas inte');
    const offBlink = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('#chrome .wb-cw')].filter((cw) => getComputedStyle(cw).display === 'none').flatMap((cw) => [...cw.querySelectorAll('.wb-dot-core')].flatMap((c) => c.getAnimations())).map((a) => a.playState),
    );
    assert.deepEqual(offBlink, ['paused'], 'utanför vyn och väntar: blinkningen står still');
    for (const id of [W1, W4, W5]) await status(id, 'idle');
    await page.evaluate(() => {
      const w = (window as any).__wb;
      for (const id of w.world.debug.huds().open) w.bus.emit('hud:close', { appId: id });
    });
    await sleep(1500); // pricken sväljer HUD:en 300 ms efter stängningen (771 ms)
    assert.deepEqual(await runningInWorld(), [`${W1}:wb-dot-halo`, `${W3}:wb-dot-halo`].sort(), 'i vila igen: bara de synliga');

    // Sidan Förslag: LED:en andas medan förslagen hämtas (§10.8), och sedan inte.
    const loading = await page.evaluate((a) => {
      const d = (window as any).__wb.world.dotOf(a);
      // W1:s sidprickar: den andra är Förslag.
      const rows = [...document.querySelectorAll<HTMLElement>('#chrome .wb-cw')].filter((cw) => {
        const b = cw.querySelector('.wb-dot')!.getBoundingClientRect();
        return Math.hypot(d.x - (b.x + b.width / 2), d.y - (b.y + b.height / 2)) < 1.5;
      });
      const btn = rows[0]?.querySelectorAll<HTMLButtonElement>('.wb-facedot')[1];
      btn?.click();
      const led = document.querySelector(`.wb-win[data-app="${a}"] .wb-ideas[data-state="loading"] .wb-ideas-led`);
      return { clicked: !!btn, led: !!led, state: led?.getAnimations()[0]?.playState ?? 'saknas' };
    }, W1);
    assert.deepEqual(loading, { clicked: true, led: true, state: 'running' }, 'LED:en andas medan förslagen hämtas');
    await page.waitForFunction((a) => !!document.querySelector(`.wb-win[data-app="${a}"] .wb-ideas[data-state="ready"]`), W1, { timeout: 10_000 });
    assert.equal(await page.evaluate(() => document.querySelectorAll('.wb-ideas-led').length), 0, 'ingen LED när förslagen kommit');
    await page.evaluate((a) => {
      const w = (window as any).__wb.world;
      const d = w.dotOf(a);
      for (const cw of document.querySelectorAll<HTMLElement>('#chrome .wb-cw')) {
        const b = cw.querySelector('.wb-dot')!.getBoundingClientRect();
        if (Math.hypot(d.x - (b.x + b.width / 2), d.y - (b.y + b.height / 2)) < 1.5) cw.querySelectorAll<HTMLButtonElement>('.wb-facedot')[0]?.click();
      }
    }, W1);
    await sleep(1200);

    // Fröytans ljusband (§14) sveper bara medan appen byggs och medan bandet tonar ut efteråt (0,5 s). Utan bygge, och
    // utanför vyn, finns inget svep.
    const seed = await page.evaluate(async () => (await (window as any).__wb.store.createApp({ x: 640, y: 480, w: 480, h: 320, scale: 1 })).app.id as string);
    await page.waitForFunction((a) => !!document.querySelector(`.wb-win[data-app="${a}"] .wb-band`), seed);
    await frames(2);
    // Svepet (::after); bandets egen toning (en övergång på 0,5 s) räknas inte.
    const band = () => page.evaluate((a) => document.querySelector(`.wb-win[data-app="${a}"] .wb-band`)!.getAnimations({ subtree: true }).filter((x) => x instanceof CSSAnimation).map((x) => x.playState).join(), seed);
    assert.equal(await band(), '', 'obyggd i vila: inget svep');
    await status(seed, 'building');
    await frames(2);
    assert.equal(await band(), 'running', 'bygger: bandet sveper');
    await status(seed, 'idle');
    await frames(2);
    assert.equal(await band(), 'running', 'klar: svepet går vidare medan bandet tonar ut');
    await sleep(700);
    assert.equal(await band(), '', 'klar och uttonat: inget svep');
    await status(seed, 'building');
    await frames(2);
    await setCam({ ...CAM, cx: CAM.cx - 20_000 });
    await sleep(700);
    assert.equal(await band(), '', 'bygger utanför vyn: inget svep');
    await setCam(CAM);
    assert.equal(await band(), 'running', 'bygger, tillbaka i vyn: bandet sveper');
    await status(seed, 'idle');
    await page.evaluate((a) => (window as any).__wb.store.deleteApp(a), seed);
    await page.waitForFunction((a) => !document.querySelector(`.wb-win[data-app="${a}"]`), seed, { timeout: 5000 });
  });

  test('O3 kromen långt utanför vyn läggs inte ut; den kommer tillbaka på rätt plats i första bildrutan, i DOM:en och i en skärmbild av just den bildrutan; en armerad Ta bort avbryts (kalibrerat)', async (t) => {
    await setCam(CAM);
    const hiddenChromes = () => page.evaluate(() => [...document.querySelectorAll<HTMLElement>('#chrome .wb-cw')].filter((cw) => getComputedStyle(cw).display === 'none').length);
    assert.equal(await hiddenChromes(), 1, 'en krom dold: W5:s');
    assert.equal((await dotEl(W1)).shown, true);
    assert.equal(await page.evaluate((a) => !!document.querySelector(`.wb-marker[data-app="${a}"]`), W5), true, 'kantmarkören till W5 finns kvar');

    // W5 syns i near. I before syns den också, 400 px längre till vänster: där läggs kromen ut sist innan den göms, så en
    // krom som kommer tillbaka en bildruta för sent står på fel plats i första bildrutan.
    const near = { cx: 6000 + 240, cy: 160, zoom: 1 };
    const before = { ...near, cx: near.cx + 400 };
    /**
     * Första bildrutan efter att kameran flyttats till c. rAF fryses mellan världens bildruta och nästa (det som begärs
     * därefter väntar tills tinat), så att både DOM:en och skärmbilden visar just det som ritades i den bildrutan och
     * inget som en senare bildruta rättar. plant flyttar pricken 40 px i den bildrutan och rättar den i nästa.
     */
    const firstFrame = async (c: typeof near, id: string, plant = false) => {
      const at = await page.evaluate(([c, a, plant]) => new Promise<{ order: boolean; d: { x: number; y: number }; dot: number; grip: number }>((res) => {
        const w = (window as any).__wb.world;
        const worldEl = document.getElementById('world')!;
        const native = window.requestAnimationFrame.bind(window);
        const queued: FrameRequestCallback[] = [];
        let frozen = false;
        window.requestAnimationFrame = (f) => (frozen ? (queued.push(f), -1) : native(f));
        (window as any).__wbThaw = () => {
          window.requestAnimationFrame = native;
          for (const f of queued.splice(0)) native(f);
        };
        const was = worldEl.style.transform;
        let order = false;
        // Före världens bildruta (den begärs av setCamera nedan): världen har inte flyttats än.
        native(() => {
          frozen = true;
          order = worldEl.style.transform === was;
        });
        w.debug.setCamera(c);
        // Efter världens bildruta, i samma bildruta.
        native(() => {
          order &&= worldEl.style.transform !== was;
          const d = w.dotOf(a);
          const r = w.screenRectOf(a);
          let best = { dot: Infinity, grip: Infinity };
          let dot: HTMLElement | null = null;
          for (const cw of document.querySelectorAll<HTMLElement>('#chrome .wb-cw')) {
            if (getComputedStyle(cw).display === 'none') continue;
            const b = cw.querySelector<HTMLElement>('.wb-dot')!;
            const bb = b.getBoundingClientRect();
            const g = cw.querySelector('.wb-grip')!.getBoundingClientRect();
            const dd = Math.hypot(d.x - (bb.x + bb.width / 2), d.y - (bb.y + bb.height / 2));
            if (dd < best.dot) {
              best = { dot: dd, grip: Math.hypot(r.x + r.w / 2 - (g.x + g.width / 2), r.y + r.h + 12.5 - (g.y + g.height / 2)) };
              dot = b;
            }
          }
          if (plant && dot) {
            const put = dot.style.transform;
            dot.style.transform = `${put} translate(-40px, 0)`;
            window.requestAnimationFrame(() => (dot!.style.transform = put));
          }
          res({ order, d, ...best });
        });
      }), [c, id, plant] as const);
      const clip = { x: Math.round(at.d.x - 40), y: Math.round(at.d.y - 40), width: 80, height: 80 };
      try {
        const b = bluest(await page.screenshot({ clip }), 2);
        return { ...at, dx: clip.x + b.x - at.d.x, dy: clip.y + b.y - at.d.y, n: b.n };
      } finally {
        await page.evaluate(() => (window as any).__wbThaw());
      }
    };
    // Det kända goda läget: den blå prickens tyngdpunkt när kameran stått still en stund i near. Detektorns egen avvikelse
    // från dotOf (kärnans förskjutna gradient, halons andning: 1–2,5 px) räknas på så sätt bort.
    await setCam(near);
    await sleep(300);
    const d0 = await page.evaluate((a) => (window as any).__wb.world.dotOf(a), W5);
    const clip0 = { x: Math.round(d0.x - 40), y: Math.round(d0.y - 40), width: 80, height: 80 };
    const b0 = bluest(await page.screenshot({ clip: clip0 }), 2);
    const ref = { dx: clip0.x + b0.x - d0.x, dy: clip0.y + b0.y - d0.y, n: b0.n };

    await setCam(before);
    await setCam(CAM);
    const ok = await firstFrame(near, W5);
    assert.ok(ok.order, 'kalibrering: frysningen kom mellan kameran och världens bildruta');
    assert.ok(ok.dot < 1 && ok.grip < 1, `pricken och greppet på plats i första bildrutan (DOM): ${JSON.stringify(ok)}`);
    const err = Math.hypot(ok.dx - ref.dx, ok.dy - ref.dy);
    assert.ok(ref.n > 4 && ok.n > 4 && err < 4, `pricken på plats i skärmbilden av första bildrutan: ${JSON.stringify({ ref, ok, err })}`);
    // Kalibrering: en prick som står fel i första bildrutan och rättas i nästa syns i skärmbilden.
    await setCam(before);
    await setCam(CAM);
    const late = await firstFrame(near, W5, true);
    const lateErr = Math.hypot(late.dx - ref.dx, late.dy - ref.dy);
    assert.ok(late.order && lateErr > 30, `kalibrering: en plats som rättas en bildruta för sent syns (${JSON.stringify({ late, lateErr })})`);
    t.diagnostic(`pricken i skärmbilden av första bildrutan ${err.toFixed(2)} px från det stilla läget (${ok.n} blå rutor), rättad en bildruta för sent ${lateErr.toFixed(1)} px`);
    await setCam({ ...near, cx: near.cx + 1 });
    assert.equal((await dotEl(W5)).shown, true, 'tinad: pricken på plats');

    // En armerad Ta bort (första klicket) avbryts när fönstret lämnar vyn: annars skulle Esc gå till en knapp som inte syns.
    await setCam(CAM);
    const del = await page.evaluate((a) => {
      const d = (window as any).__wb.world.dotOf(a);
      for (const cw of document.querySelectorAll<HTMLElement>('#chrome .wb-cw')) {
        const b = cw.querySelector('.wb-dot')!.getBoundingClientRect();
        if (Math.hypot(d.x - (b.x + b.width / 2), d.y - (b.y + b.height / 2)) >= 1.5) continue;
        const r = cw.querySelector('.wb-delbtn')!.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }
      return null;
    }, W1);
    assert.ok(del, 'W1:s kryss');
    await page.mouse.move(del!.x - 60, del!.y + 30);
    await page.mouse.move(del!.x, del!.y, { steps: 8 });
    await page.mouse.down();
    await page.mouse.up();
    const armed = () => page.evaluate(() => document.querySelectorAll('.wb-delbtn.wb-armed').length);
    assert.equal(await armed(), 1, 'kalibrering: första klicket armerar');
    await setCam({ cx: -9000, cy: 400, zoom: 1 });
    await setCam(CAM);
    assert.equal(await armed(), 0, 'avbruten när fönstret lämnade vyn');
    assert.ok((await page.evaluate(() => [...(window as any).__wb.store.apps.keys()])).includes(W1), 'appen finns kvar');
  });
});
