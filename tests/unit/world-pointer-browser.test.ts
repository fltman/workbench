// world-pointer-browser.test.ts — pekaren mot världen i riktig Chrome (CONTRACT §10.3, §10.5, §14): kromen nära
// pekaren (wb-near inom 96 px från fönstret, kalibrerat åt båda hållen) med knapparnas namn som verktygstips, kantmarkörer
// som döljs ovanpå ett fönster (kalibrerat: utan fönstret syns markören), och
// dubbelklick på tom yta som visar allt (kalibrerat: före dubbelklicket ryms fönstren inte; två enkla tryck stänger
// två HUD:ar, ett dubbelklick bara den aktiva; ett andra tryck som blir ett drag ritar bara; dubbelklick på greppet, i en
// app, på en sidprick och i HUD:ens inmatning är som förut). Egen server med låtsas-Claude på lediga portar och ett
// tillfälligt hem under .scratch. Saknas Chrome hoppas filen över.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { testPort } from '../ports.ts';

const root = path.resolve(import.meta.dirname, '../..');
const VW = 1440;
const VH = 900;
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
let base = '';
let home = '';
let viteCache = '';

type Rect = { x: number; y: number; w: number; h: number };
type Cam = { cx: number; cy: number; zoom: number };

/** En app vars fönster står i världen på (x, y), 480 × 320, skala 1. */
async function newApp(x: number, y: number): Promise<string> {
  const id = await page.evaluate(async ([px, py]) => {
    const res = await (window as any).__wb.store.createApp({ x: px, y: py, w: 480, h: 320, scale: 1 });
    return res.app.id as string;
  }, [x, y] as const);
  await page.waitForFunction((a) => !!(window as any).__wb.world.screenRectOf(a), id);
  return id;
}

/** Gör appen byggd: en sida skriven för hand (bevakaren börjar bevaka en ny app inom en sekund, så vänta in den först). */
async function build(id: string): Promise<void> {
  await sleep(1300);
  fs.writeFileSync(path.join(home, 'apps', id, 'index.html'), '<!doctype html>\n<html lang="sv"><head><meta charset="utf-8"><title>Prov</title></head><body style="margin:0;height:100vh"><p>Prov</p></body></html>\n');
}

const rectOf = (id: string): Promise<Rect> => page.evaluate((a) => (window as any).__wb.world.screenRectOf(a) as Rect, id);
const camera = (): Promise<Cam> => page.evaluate(() => (window as any).__wb.world.debug.camera() as Cam);
const setCamera = async (c: Cam): Promise<void> => {
  await page.evaluate((c) => (window as any).__wb.world.debug.setCamera(c), c);
  await sleep(250);
};
const openHuds = (): Promise<string[]> => page.evaluate(() => (window as any).__wb.world.debug.huds().open as string[]);

/** Vänta tills kameran stått still i tre avläsningar (flygningen är ungefär 380 ms). */
async function settle(): Promise<Cam> {
  let last = '';
  let same = 0;
  for (let i = 0; i < 60 && same < 3; i++) {
    await sleep(80);
    const c = JSON.stringify(await camera());
    same = c === last ? same + 1 : 0;
    last = c;
  }
  return JSON.parse(last) as Cam;
}

/** Ryms fönstret helt i vyn? */
async function fits(id: string): Promise<boolean> {
  const r = await rectOf(id);
  return r.w >= 100 && r.x >= 0 && r.y >= 0 && r.x + r.w <= VW && r.y + r.h <= VH;
}

/** Ta bort alla appar, så att varje test börjar på tom yta. */
async function clearApps(): Promise<void> {
  await page.evaluate(async () => {
    const w = (window as any).__wb;
    for (const id of w.world.debug.huds().open as string[]) w.bus.emit('hud:close', { appId: id });
    for (const id of [...w.store.apps.keys()]) await w.store.deleteApp(id).catch(() => {});
  });
  await page.waitForFunction(() => (window as any).__wb.store.apps.size === 0);
  await sleep(500);
}

describe('pekaren mot världen i riktig Chrome', { skip: noChrome, timeout: 180_000 }, () => {
  before(async () => {
    const port = await testPort();
    viteCache = path.join(root, 'node_modules', `.vite-${port}`);
    const hmr = await testPort();
    const homeDir = path.join(root, '.scratch');
    fs.mkdirSync(homeDir, { recursive: true });
    home = fs.realpathSync.native(fs.mkdtempSync(path.join(homeDir, `world-pointer-${process.pid}-`)));
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
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    base = `http://localhost:${port}`;
    for (let i = 0; i < 200; i++) {
      try {
        if ((await fetch(`${base}/api/snapshot`, { headers: { origin: base } })).ok) break;
      } catch {
        /* inte uppe än */
      }
      await sleep(150);
    }
    const ctx = await browser!.newContext({ viewport: { width: VW, height: VH }, deviceScaleFactor: 2 });
    page = await ctx.newPage();
    await page.goto(base + '/');
    await page.waitForFunction(() => (window as any).__wb?.store?.connected === true, null, { timeout: 60_000 });
  }, { timeout: 120_000 });

  after(async () => {
    await browser?.close().catch(() => {});
    if (server && server.exitCode === null) {
      const gone = new Promise((r) => server?.once('exit', r));
      server.kill('SIGTERM');
      await Promise.race([gone, sleep(5000)]);
      if (server.exitCode === null) server.kill('SIGKILL');
    }
    if (home) fs.rmSync(home, { recursive: true, force: true });
    if (viteCache) fs.rmSync(viteCache, { recursive: true, force: true });
  }, { timeout: 30_000 });

  test('kromen nära pekaren: inom 96 px från fönstret är greppet, knapparna och sidprickarna mörkare, längre bort inte (kalibrerat åt båda hållen); knapparna har sina namn som verktygstips', async () => {
    await clearApps();
    await setCamera({ cx: 0, cy: 0, zoom: 1 });
    // Fönstret på skärmen: 480–960 × 290–610. En byggd app har två sidor (sin egen och Förslag), så sidprickarna syns.
    const id = await newApp(-240, -160);
    await build(id);
    await page.waitForFunction((a) => (window as any).__wb.store.apps.get(a)?.built === true && document.querySelectorAll('#chrome .wb-facedot').length === 2, id, { timeout: 10_000 });
    const r = await rectOf(id);
    assert.deepEqual(r, { x: 480, y: 290, w: 480, h: 320 });
    const sample = () =>
      page.evaluate(() => {
        const cw = document.querySelector('#chrome .wb-cw') as HTMLElement;
        const css = (sel: string, prop: string, pseudo?: string) => getComputedStyle(cw.querySelector(sel) as Element, pseudo).getPropertyValue(prop);
        return {
          near: cw.classList.contains('wb-near'),
          grip: css('.wb-grip i', 'background-color'),
          min: css('.wb-minbtn i', 'border-bottom-color'),
          del: css('.wb-delbtn i', 'background-color', '::before'),
          face: css('.wb-facedot:not(.wb-on) i', 'background-color'),
        };
      });
    const far = { near: false, grip: 'rgba(20, 24, 32, 0.28)', min: 'rgba(20, 24, 32, 0.28)', del: 'rgba(20, 24, 32, 0.28)', face: 'rgba(20, 24, 32, 0.3)' };
    // Sidprickarna stannar ljusare än greppet, så att den främre sidans prick (0,85) går att skilja från dem även nära.
    const close = { near: true, grip: 'rgba(20, 24, 32, 0.6)', min: 'rgba(20, 24, 32, 0.6)', del: 'rgba(20, 24, 32, 0.6)', face: 'rgba(20, 24, 32, 0.45)' };
    // Avstånd till fönstrets vänsterkant, på tom yta i höjd med fönstrets mitt.
    for (const [dx, want] of [[300, far], [60, close], [104, far], [90, close], [0, close], [200, far]] as const) {
      await page.mouse.move(r.x - dx, r.y + r.h / 2, { steps: 6 });
      await sleep(320); // färgerna tonar på 200 ms
      assert.deepEqual(await sample(), want, `${dx} px från fönstret`);
    }
    // Verktygstipsen: samma namn som aria-label.
    const tips = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('#chrome .wb-minbtn, #chrome .wb-delbtn, #chrome .wb-facedot')].map((b) => [b.title, b.getAttribute('aria-label')]),
    );
    assert.equal(tips.length, 4);
    for (const [title, label] of tips) {
      assert.ok(label, 'saknar aria-label');
      assert.equal(title, label);
    }
  });

  test('en kantmarkör som når in i ett fönster eller dess krom döljs och tar ingen pekare (kalibrerat: samma markör utan fönstret syns och tar pekaren)', async () => {
    await clearApps();
    await setCamera({ cx: 0, cy: 0, zoom: 1 });
    // Ett fönster långt till höger: dess markör sitter vid vyns högra kant, nära vyns mitt i höjd.
    const far = await newApp(5000, -80);
    const marker = () =>
      page.evaluate((id) => {
        const m = document.querySelector(`.wb-marker[data-app="${id}"]`) as HTMLElement | null;
        if (!m) return null;
        const r = m.getBoundingClientRect();
        const x = r.x + r.width / 2;
        const y = r.y + r.height / 2;
        return { x, y, hidden: getComputedStyle(m).visibility === 'hidden', hit: !!document.elementFromPoint(x, y)?.closest('.wb-marker') };
      }, far);
    // Markören läggs ut i nästa bildruta.
    await page.waitForFunction((id) => !!document.querySelector(`.wb-marker[data-app="${id}"]`), far, { timeout: 3000 });
    const before = await marker();
    assert.ok(before && !before.hidden && before.hit, `kalibrering: utan fönstret syns markören och tar pekaren: ${JSON.stringify(before)}`);
    // Ett fönster som sticker ut över vyns högra kant, där markören sitter (QA: blå prickar på en apps sida).
    await newApp(300, -160);
    await sleep(200);
    const over = await marker();
    assert.ok(over && over.hidden && !over.hit, `markören ovanpå fönstret: ${JSON.stringify(over)}`);
  });

  test('dubbelklick på tom yta: visar allt när det inte finns något att flyga tillbaka till, och samma igen flyger tillbaka, men inte till en vy utan fönster (kalibrerat: före dubbelklicket ryms fönstren inte)', async () => {
    await clearApps();
    await setCamera({ cx: 0, cy: 0, zoom: 1 });
    const a = await newApp(-600, -300);
    const b = await newApp(200, 40);
    // Utzoomat så långt det går (zoom 0,05, som tio ctrl-hjulsteg i granskningen): fönstren syns som 24 × 16 px stora
    // rutor uppe till vänster om vyns mitt, där varken draget eller dubbelklicken nedan träffar dem.
    const away: Cam = { cx: 3000, cy: 1500, zoom: 0.05 };
    await setCamera(away);
    for (const id of [a, b]) {
      const r = await rectOf(id);
      assert.ok(r.w < 30 && r.x > 0 && r.y > 0 && r.x + r.w < 700 && r.y + r.h < 440, `fönstret i den utzoomade vyn: ${JSON.stringify(r)}`);
    }
    assert.equal(await fits(a), false, 'kalibrering: fönstret ryms före dubbelklicket');
    assert.equal(await fits(b), false, 'kalibrering: fönstret ryms före dubbelklicket');
    const apps0 = await page.evaluate(() => (window as any).__wb.store.apps.size);
    const ink = () => page.evaluate(() => document.querySelectorAll('#ink > *').length);
    // Kalibrering av "inget streck": ett riktigt litet drag på tom yta syns i #ink medan knappen hålls (och tonar bort).
    await page.mouse.move(700, 440, { steps: 6 });
    await page.mouse.down();
    await page.mouse.move(740, 470, { steps: 6 });
    assert.ok((await ink()) > 0, 'kalibrering: draget syntes inte i #ink');
    await page.mouse.up();
    await page.waitForFunction(() => document.querySelectorAll('#ink > *').length === 0, null, { timeout: 3000 });
    await page.mouse.dblclick(720, 450);
    await settle();
    assert.equal(await fits(a), true, `efter dubbelklicket: ${JSON.stringify(await rectOf(a))}`);
    assert.equal(await fits(b), true, `efter dubbelklicket: ${JSON.stringify(await rectOf(b))}`);
    // Inget ritades: inga nya appar och inget streck.
    assert.equal(await page.evaluate(() => (window as any).__wb.store.apps.size), apps0);
    assert.equal(await ink(), 0);
    // Samma igen: tillbaka dit kameran var.
    await page.mouse.dblclick(720, 450);
    const back = await settle();
    for (const k of ['cx', 'cy', 'zoom'] as const) assert.ok(Math.abs(back[k] - away[k]) < 1e-6, `tillbaka: ${JSON.stringify(back)}`);
    // Vilse på tom yta, utan något fönster i vyn: visa allt, men ett andra dubbelklick flyger inte tillbaka ut i
    // tomheten (QA 17 oktober). Kalibrerat: före ändringen flög det tillbaka hit.
    const lost: Cam = { cx: 6000, cy: 4000, zoom: 1.4 };
    await setCamera(lost);
    await page.mouse.dblclick(720, 450);
    const all = await settle();
    assert.equal(await fits(a), true, `efter dubbelklicket: ${JSON.stringify(await rectOf(a))}`);
    await page.mouse.dblclick(720, 450);
    const still = await settle();
    for (const k of ['cx', 'cy', 'zoom'] as const) assert.ok(Math.abs(still[k] - all[k]) < 1e-6, `flög tillbaka till tom yta: ${JSON.stringify(still)}`);
    // Esc flyger inte heller dit.
    await page.keyboard.press('Escape');
    const esc = await settle();
    for (const k of ['cx', 'cy', 'zoom'] as const) assert.ok(Math.abs(esc[k] - all[k]) < 1e-6, `Esc flög tillbaka till tom yta: ${JSON.stringify(esc)}`);
  });

  test('ett dubbelklick på tom yta stänger högst den aktiva HUD:en, som ett tryck (kalibrerat: två enkla tryck stänger två)', async () => {
    await clearApps();
    await setCamera({ cx: 0, cy: 0, zoom: 1 });
    const a = await newApp(-660, -380);
    const b = await newApp(-660, 40);
    const openBoth = async () => {
      for (const id of [a, b]) {
        await page.evaluate((x) => (window as any).__wb.bus.emit('hud:open', { appId: x, reason: 'dot' }), id);
        await page.waitForFunction((x) => (window as any).__wb.world.debug.hudApp() === x, id);
      }
      await sleep(400);
      assert.deepEqual(await openHuds(), [a, b]);
    };
    const empty = { x: 1380, y: 860 };
    assert.equal(await page.evaluate((p) => document.elementFromPoint(p.x, p.y)?.id, empty), 'stage', 'punkten är inte tom yta');
    await openBoth();
    await page.mouse.move(empty.x, empty.y, { steps: 6 });
    await page.mouse.click(empty.x, empty.y);
    await sleep(150);
    await page.mouse.click(empty.x, empty.y);
    await page.waitForFunction(() => (window as any).__wb.world.debug.huds().open.length === 0, null, { timeout: 3000 });

    await openBoth();
    await page.mouse.dblclick(empty.x, empty.y);
    await sleep(600);
    assert.deepEqual(await openHuds(), [a], 'dubbelklicket stängde fler än den aktiva');
  });

  test('ett dubbelklick vars andra tryck blir ett drag ritar en app och rör inte kameran, och ett vars andra tryck avbryts med Esc gör ingenting (kalibrerat: webbläsaren ser båda dubbelklicken)', async () => {
    await clearApps();
    await setCamera({ cx: 0, cy: 0, zoom: 1 });
    await newApp(-660, -380); // något för visa allt att flyga till
    const still: Cam = { cx: 300, cy: 200, zoom: 1.2 };
    await setCamera(still);
    const apps0 = await page.evaluate(() => (window as any).__wb.store.apps.size);
    const p = { x: 700, y: 420 };
    assert.equal(await page.evaluate((q) => document.elementFromPoint(q.x, q.y)?.id, p), 'stage', 'punkten är inte tom yta');
    await page.evaluate(() => {
      const w = window as any;
      w.__dbl = 0;
      w.__countDbl = () => w.__dbl++;
      document.getElementById('stage')!.addEventListener('dblclick', w.__countDbl);
    });
    // Det andra trycket i ett dubbelklick blir ett drag: Chrome skickar ändå click och dblclick vid släppet.
    await page.mouse.move(p.x, p.y, { steps: 6 });
    await page.mouse.down({ clickCount: 1 });
    await page.mouse.up({ clickCount: 1 });
    await page.mouse.down({ clickCount: 2 });
    for (let i = 1; i <= 30; i++) await page.mouse.move(p.x + i * 10, p.y + i * 7);
    await page.mouse.up({ clickCount: 2 });
    await page.waitForFunction((n) => (window as any).__wb.store.apps.size === n + 1, apps0, { timeout: 5000 });
    const c = await settle();
    const dbl = () => page.evaluate(() => (window as any).__dbl as number);
    assert.equal(await dbl(), 1, 'kalibrering: webbläsaren skickade inget dubbelklick');
    for (const k of ['cx', 'cy', 'zoom'] as const) assert.ok(Math.abs(c[k] - still[k]) < 1e-6, `kameran flyttades: ${JSON.stringify(c)}`);
    assert.equal(await page.evaluate(() => (window as any).__wb.store.apps.size), apps0 + 1, 'draget ritade ingen app');
    // Det andra trycket avbryts med Esc och släpps där det trycktes: inget tryck, alltså inget dubbelklick.
    await page.evaluate(() => {
      const w = (window as any).__wb;
      for (const id of w.world.debug.huds().open as string[]) w.bus.emit('hud:close', { appId: id });
    });
    await page.waitForFunction(() => (window as any).__wb.world.debug.huds().open.length === 0);
    await setCamera(still);
    const q = { x: 400, y: 760 };
    assert.equal(await page.evaluate((s) => document.elementFromPoint(s.x, s.y)?.id, q), 'stage', 'punkten är inte tom yta');
    await page.mouse.move(q.x, q.y, { steps: 6 });
    await page.mouse.down({ clickCount: 1 });
    await page.mouse.up({ clickCount: 1 });
    await page.mouse.down({ clickCount: 2 });
    await page.keyboard.press('Escape');
    await page.mouse.up({ clickCount: 2 });
    const c2 = await settle();
    assert.equal(await dbl(), 2, 'kalibrering: webbläsaren skickade inget andra dubbelklick');
    for (const k of ['cx', 'cy', 'zoom'] as const) assert.ok(Math.abs(c2[k] - still[k]) < 1e-6, `kameran flyttades efter Esc: ${JSON.stringify(c2)}`);
    await page.evaluate(() => {
      const w = window as any;
      document.getElementById('stage')!.removeEventListener('dblclick', w.__countDbl);
    });
  });

  test('dubbelklick på greppet flyger till fönstret; dubbelklick i en app, på en sidprick och i HUD:ens inmatning rör inte kameran (kalibrerat: utan skalets kontroll av målet flyger den)', async () => {
    await clearApps();
    await setCamera({ cx: 0, cy: 0, zoom: 1 });
    const id = await newApp(-240, -160);
    await build(id);
    await page.waitForFunction((a) => !!document.querySelector(`.wb-win[data-app="${a}"] iframe.wb-frame:not(.wb-incoming)`), id, { timeout: 10_000 });
    await page.waitForFunction(() => document.querySelectorAll('#chrome .wb-facedot').length === 2, null, { timeout: 10_000 });
    await sleep(600);
    const r = await rectOf(id);
    // I appen: skalet ser aldrig dubbelklicket, så kameran står still. Kalibrerat av greppet nedan, som flyttar den.
    const c0 = await camera();
    await page.mouse.move(r.x - 40, r.y + r.h / 2, { steps: 6 });
    await page.mouse.move(r.x + r.w / 2, r.y + r.h / 2, { steps: 8 });
    await page.mouse.dblclick(r.x + r.w / 2, r.y + r.h / 2);
    await sleep(600);
    assert.deepEqual(await camera(), c0, 'ett dubbelklick i appen flyttade kameran');
    // Sidprickarna och HUD:arna ligger i #stage, så deras dubbelklick når skalets lyssnare för tom yta. Kameran står där
    // varken visa allt eller tillbaka-stacken har den, så att ett dubbelklick som togs för tom yta syns.
    const still: Cam = { cx: 60, cy: 40, zoom: 1.15 };
    const unmoved = (c: Cam, what: string) => {
      for (const k of ['cx', 'cy', 'zoom'] as const) assert.ok(Math.abs(c[k] - still[k]) < 1e-6, `ett dubbelklick ${what} flyttade kameran: ${JSON.stringify(c)}`);
    };
    const centreOf = (sel: string) =>
      page.evaluate((s) => {
        const b = (document.querySelector(s) as HTMLElement).getBoundingClientRect();
        return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
      }, sel);
    await setCamera(still);
    const face = await centreOf('#chrome .wb-facedot:not(.wb-on)');
    await page.mouse.move(face.x - 30, face.y, { steps: 6 });
    await page.mouse.move(face.x, face.y, { steps: 4 });
    await page.mouse.dblclick(face.x, face.y);
    unmoved(await settle(), 'på en sidprick');
    // HUD:ens inmatning: ett dubbelklick markerar ett ord.
    await page.evaluate((a) => (window as any).__wb.bus.emit('hud:open', { appId: a, reason: 'dot' }), id);
    await page.waitForFunction((a) => (window as any).__wb.world.debug.hudApp() === a, id);
    await page.keyboard.type('hej och hå');
    await setCamera(still);
    await sleep(400);
    const input = await centreOf('.wbh-input');
    await page.mouse.move(input.x, input.y, { steps: 6 });
    await page.mouse.dblclick(input.x, input.y);
    unmoved(await settle(), 'i HUD:ens inmatning');
    await page.evaluate((a) => (window as any).__wb.bus.emit('hud:close', { appId: a }), id);
    await page.waitForFunction(() => (window as any).__wb.world.debug.huds().open.length === 0);
    await setCamera({ cx: 0, cy: 0, zoom: 1 });
    // Greppet: flyg till fönstret (det fyller vyn med 48 px marginal, alltså zoom över 1), inte visa allt (zoom högst 1).
    const grip = { x: r.x + r.w / 2, y: r.y + r.h + 12.5 };
    assert.equal(await page.evaluate((p) => !!document.elementFromPoint(p.x, p.y)?.closest('.wb-grip'), grip), true, 'greppet är inte där');
    await page.mouse.move(grip.x, grip.y, { steps: 6 });
    await page.mouse.dblclick(grip.x, grip.y);
    const c1 = await settle();
    assert.ok(c1.zoom > 2, `greppet flög inte till fönstret: ${JSON.stringify(c1)}`);
  });
});
