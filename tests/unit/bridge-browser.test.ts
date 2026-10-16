// Appbryggan i riktig Chrome (playwright-core, channel 'chrome', --force-device-scale-factor=2 och
// deviceScaleFactor 2, annars får iframes i andra processer DPR 1). Testriggen (tests/bridge-harness)
// serverar skalet på localhost:<port> och apparna på <id>.localhost:<port> med sdk/wb.js injicerat.
//
// Kalibrering: varje test som visar att något INTE händer (hjulet förhindras, tangenter når inte appen,
// fel avsändare avvisas, inget skickas på toppnivå …) körs också mot en planterad läcka (leaks.ts) och
// måste då fällas.
//
// Uppmätt (se .scratch/bridge/probe): ingen automatiserad indata når en app-iframe som nyp.
// Input.synthesizePinchGesture går till toppramen både headless och headful, även från iframens egen
// CDP-session, och ctrl+hjul via CDP zoomar aldrig sidan på macOS, inte ens oförhindrat. visualViewport.scale
// går därför inte att kalibrera över en iframe. Det kalibrerade måttet är hjulets standardåtgärd: oförhindrat
// scrollar ctrl+hjul listan under markören, förhindrat står den still.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Frame, type Page } from 'playwright-core';
import { startHarness, type Harness } from '../bridge-harness/server.ts';

const PORT = Number(process.env.BRIDGE_HARNESS_PORT ?? 8242);
const EVIDENCE = process.env.BRIDGE_EVIDENCE ? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..', process.env.BRIDGE_EVIDENCE) : null;

interface Placement {
  appId: string;
  page: string;
  face: string;
  x: number;
  y: number;
  s: number;
  w: number;
  h: number;
  registered: boolean;
}

interface Call {
  kind: string;
  appId: string;
  face: string;
  args: unknown[];
}

/** Det testet läser av skalets och appens window (bara typer; koden körs i webbläsaren). */
interface TW {
  __harness: {
    calls: Call[];
    ready: boolean;
    topWheel(): number;
    setReplyFace(f: string | null): void;
    sendFace(i: number, current: string): void;
    selfPost(msg: unknown): void;
    unsubscribe(): void;
  };
  __seen: {
    wheel: Array<{ target: string; ctrl: boolean; prevented: boolean; cancelable: boolean; wdy: number; trusted: boolean }>;
    keys: Array<{ code: string }>;
    keysDoc: Array<{ code: string }>;
    keysField: Array<{ code: string }>;
    messages: Array<{ origin: string; data: unknown }>;
    faceChanges: string[];
    ready: { at: number; face: string } | null;
  };
  __posts: unknown[];
  __preventEscWindow?: boolean;
  __preventEscField?: boolean;
  wb: {
    ready: Promise<void>;
    app: { id: string; name: string; faces: Array<{ id: string; page: string; label?: string }> };
    face: { current: string; show(id: unknown): void; onChange(fn: (id: string) => void): () => void };
    store: {
      get(k: unknown): Promise<unknown>;
      set(k: unknown, v: unknown): Promise<void>;
      delete(k: unknown): Promise<void>;
      all(): Promise<Record<string, unknown>>;
    };
  };
}

let h: Harness;
let browser: Browser;
const evidence: Record<string, unknown> = {};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  h = await startHarness(PORT, !process.env.BRIDGE_HARNESS_PORT); // 8242, eller en ledig port om en annan körning har den
  evidence.port = h.port;
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--force-device-scale-factor=2'] });
  evidence.chrome = browser.version();
});

after(async () => {
  await browser?.close();
  await h?.close();
  if (EVIDENCE) {
    fs.mkdirSync(path.dirname(EVIDENCE), { recursive: true });
    fs.writeFileSync(EVIDENCE, JSON.stringify(evidence, null, 1));
  }
});

const PROBE: Placement = { appId: 'probe', page: 'index.html', face: 'main', x: 101.3, y: 83.7, s: 1.5, w: 660, h: 440, registered: true };

/** Skärmpunkt för en punkt i appens CSS-px. */
const screen = (p: Placement, lx: number, ly: number) => ({ x: p.x + lx * p.s, y: p.y + ly * p.s });

interface Opened {
  context: BrowserContext;
  page: Page;
  frames: Frame[];
  calls(kind?: string): Promise<Call[]>;
  clear(): Promise<void>;
  close(): Promise<void>;
}

async function open(placements: Placement[], leak?: string): Promise<Opened> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  const q = `?cfg=${encodeURIComponent(JSON.stringify(placements))}${leak ? `&leak=${encodeURIComponent(leak)}` : ''}`;
  await page.goto(`${h.shell}/${q}`);
  await page.waitForFunction(() => (window as unknown as TW).__harness?.ready === true);
  const helloes = placements.filter((p) => p.registered).length;
  await page.waitForFunction((n) => (window as unknown as TW).__harness.calls.filter((c) => c.kind === 'hello').length >= n, helloes, { timeout: 5000 });
  const frames: Frame[] = [];
  for (const el of await page.$$('iframe')) {
    const f = await el.contentFrame();
    assert.ok(f, 'iframen saknar ram');
    await f.waitForFunction(() => typeof (window as unknown as TW).wb === 'object');
    frames.push(f);
  }
  // Uppmätt: utan två bildrutor efter load missade 1 av 10 första klick iframen (den gick inte att träffa än).
  const twoFrames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  await page.evaluate(twoFrames);
  for (const f of frames) await f.evaluate(twoFrames);
  const calls = (kind?: string) => page.evaluate((k) => (window as unknown as TW).__harness.calls.filter((c) => !k || c.kind === k), kind ?? null);
  return {
    context,
    page,
    frames,
    calls,
    clear: () => page.evaluate(() => void ((window as unknown as TW).__harness.calls.length = 0)),
    close: () => context.close(),
  };
}

/** Väntar tills villkoret håller, eller tills tiden gått (då returneras sista värdet). */
async function settle<T>(read: () => Promise<T>, ok: (v: T) => boolean, ms = 1500): Promise<T> {
  const end = Date.now() + ms;
  let v = await read();
  while (!ok(v) && Date.now() < end) {
    await sleep(50);
    v = await read();
  }
  return v;
}

async function wheelAt(page: Page, at: { x: number; y: number }, dx: number, dy: number, mods: string[] = []): Promise<void> {
  await page.mouse.move(at.x, at.y);
  for (const m of mods) await page.keyboard.down(m);
  await page.mouse.wheel(dx, dy);
  for (const m of [...mods].reverse()) await page.keyboard.up(m);
}

/**
 * Klick mitt i #field (vänster 320, topp 370, bredd 180 i appens px) på exakt skärmpunkt. Playwrights
 * frame.click räknar fel genom skalade iframes i andra processer och träffar fel element.
 */
async function clickField(o: Opened, p: Placement = PROBE): Promise<void> {
  const at = screen(p, 410, 380);
  for (let attempt = 0; ; attempt++) {
    await o.page.mouse.click(at.x, at.y);
    try {
      await o.frames[0].waitForFunction(() => document.activeElement?.id === 'field', null, { timeout: 1000 });
      return;
    } catch (err) {
      if (attempt >= 1) throw err;
      evidence.clickRetries = ((evidence.clickRetries as number) ?? 0) + 1;
    }
  }
}

const scrollOf = (f: Frame, id: string) =>
  f.evaluate((i) => {
    const el = document.getElementById(i) as HTMLElement;
    return { top: el.scrollTop, left: el.scrollLeft };
  }, id);

/* ------------------------------------------------------------------ */

describe('bryggan i Chrome: hjulet', () => {
  /** ctrl+hjul över en lista som kan scrolla: standardåtgärden (scroll) är det kalibrerade måttet. */
  async function ctrlWheelOverList(leak?: string) {
    const o = await open([{ ...PROBE, page: `index.html${leak ? `?leak=${leak}` : ''}` }]);
    try {
      await wheelAt(o.page, screen(PROBE, 420, 100), 0, 120, ['Control']);
      const zoom = await settle(() => o.calls('zoom'), (c) => c.length >= 1);
      await sleep(400); // en scroll hinner synas
      const list = await scrollOf(o.frames[0], 'list');
      const seen = await o.frames[0].evaluate(() => (window as unknown as TW).__seen.wheel.at(-1));
      return {
        listScrollTop: list.top,
        appSawPrevented: seen?.prevented,
        appSawCancelable: seen?.cancelable,
        zoomCalls: zoom.length,
        topFrameWheel: await o.page.evaluate(() => (window as unknown as TW).__harness.topWheel()),
        shellVisualViewportScale: await o.page.evaluate(() => visualViewport?.scale),
        appVisualViewportScale: await o.frames[0].evaluate(() => visualViewport?.scale),
        dpr: [await o.page.evaluate(() => devicePixelRatio), await o.frames[0].evaluate(() => devicePixelRatio)],
      };
    } finally {
      await o.close();
    }
  }

  it('ctrl+hjul över appen förhindras: ingen scroll, ingen zoom av sidan, skickas som zoom', async () => {
    const m = await ctrlWheelOverList();
    evidence.ctrlWheelOverList = m;
    assert.deepEqual(m.dpr, [2, 2], 'iframen ska ha DPR 2');
    assert.equal(m.appSawCancelable, true);
    assert.equal(m.appSawPrevented, true);
    assert.equal(m.listScrollTop, 0, 'standardåtgärden får inte ske');
    assert.equal(m.zoomCalls, 1);
    assert.equal(m.topFrameWheel, 0, 'hjulet gick till iframen, inte till skalet');
    assert.equal(m.shellVisualViewportScale, 1);
    assert.equal(m.appVisualViewportScale, 1);
  });

  it('kalibrering: utan preventDefault i wb.js sker standardåtgärden', async () => {
    const m = await ctrlWheelOverList('wheel-prevent');
    evidence.ctrlWheelOverList_leak = m;
    assert.equal(m.appSawPrevented, false);
    assert.ok(m.listScrollTop > 0, `testet ska fälla den planterade läckan (scrollTop ${m.listScrollTop})`);
  });

  /** Zoom kring markören: den skickade punkten ska vara exakt markörens skärmpunkt. */
  async function zoomAnchor(leak?: string) {
    const o = await open([{ ...PROBE, page: `index.html${leak ? `?leak=${leak}` : ''}` }]);
    try {
      const rows = [];
      for (const [lx, ly] of [
        [123.5, 77.5],
        [41.5, 150.5],
        [250.5, 20.5],
      ]) {
        await o.clear();
        const at = screen(PROBE, lx, ly);
        await wheelAt(o.page, at, 0, -40, ['Control']);
        const [z] = await settle(() => o.calls('zoom'), (c) => c.length >= 1);
        assert.ok(z, 'zoom skickades inte');
        const [dy, sx, sy, opts] = z.args as [number, number, number, { alt: boolean; smart: boolean; mode: number }];
        rows.push({ local: [lx, ly], cursor: [at.x, at.y], forwarded: [sx, sy], dy, opts, errPx: Math.hypot(sx - at.x, sy - at.y) });
      }
      return rows;
    } finally {
      await o.close();
    }
  }

  it('zoom kring markören skickas med punkten exakt (fraktionell pekarposition, skala 1,5)', async () => {
    const rows = await zoomAnchor();
    evidence.zoomAnchor = rows;
    for (const r of rows) {
      assert.ok(r.errPx < 0.05, `fel ${r.errPx} px vid ${r.local}`);
      assert.equal(r.dy, -40);
      assert.deepEqual(r.opts, { alt: false, smart: false, mode: 0 });
    }
  });

  it('kalibrering: med hjulets heltalskoordinater blir felet synligt', async () => {
    const rows = await zoomAnchor('precise');
    evidence.zoomAnchor_leak = rows;
    assert.ok(Math.max(...rows.map((r) => r.errPx)) > 0.3, `testet ska fälla den planterade läckan (${rows.map((r) => r.errPx.toFixed(3))})`);
  });

  it('vanligt hjul: listan scrollar när den kan, annars panorerar världen', async () => {
    const o = await open([PROBE]);
    try {
      const f = o.frames[0];
      const list = screen(PROBE, 420, 100);
      await wheelAt(o.page, list, 0, 120);
      const down = await settle(() => scrollOf(f, 'list'), (s) => s.top > 0);
      await sleep(300);
      const panWhileScrolling = (await o.calls('pan')).length;
      // Längst ner: nedåt kan listan inte scrolla, uppåt kan den.
      await f.evaluate(() => void (document.getElementById('list')!.scrollTop = 1e6));
      const bottom = (await scrollOf(f, 'list')).top;
      await wheelAt(o.page, list, 0, 120);
      const pan = await settle(() => o.calls('pan'), (c) => c.length >= 1);
      await wheelAt(o.page, list, 0, -120);
      const up = await settle(() => scrollOf(f, 'list'), (s) => s.top < bottom);
      await sleep(300);
      const panAfterUp = (await o.calls('pan')).length;
      // Ytan som inte kan scrolla: förhindras och panorerar.
      await o.clear();
      await wheelAt(o.page, screen(PROBE, 150, 100), 30, 50);
      const plain = await settle(() => o.calls('pan'), (c) => c.length >= 1);
      const seenPlain = await f.evaluate(() => (window as unknown as TW).__seen.wheel.at(-1));
      evidence.plainWheel = { down, panWhileScrolling, bottom, pan: pan.map((c) => c.args), up, panAfterUp, plain: plain.map((c) => c.args), seenPlain };
      assert.ok(down.top > 0, 'listan scrollade inte');
      assert.equal(panWhileScrolling, 0, 'inget får skickas när appen scrollar');
      assert.equal(pan.length, 1);
      assert.deepEqual(pan[0].args, [0, 120, 0, false]);
      assert.ok(up.top < bottom, 'listan scrollade inte uppåt');
      assert.equal(panAfterUp, 1);
      assert.deepEqual(plain[0].args, [30, 50, 0, false]);
      assert.equal(seenPlain?.prevented, true);
    } finally {
      await o.close();
    }
  });

  it('scrollriktningar: column-reverse, rtl och vågrätt', async () => {
    const o = await open([PROBE]);
    try {
      const f = o.frames[0];
      const rows: Record<string, unknown> = {};
      // Chatt med column-reverse börjar längst ner (scrollTop 0) och går mot −max uppåt.
      const chat = screen(PROBE, 150, 300);
      await wheelAt(o.page, chat, 0, -100);
      rows.chatUp = await settle(() => scrollOf(f, 'chat'), (s) => s.top < 0);
      await wheelAt(o.page, chat, 0, 100);
      rows.chatBack = await settle(() => scrollOf(f, 'chat'), (s) => s.top >= 0);
      await sleep(300);
      rows.panAfterChat = (await o.calls('pan')).length;
      await wheelAt(o.page, chat, 0, 100);
      rows.chatBottomPan = (await settle(() => o.calls('pan'), (c) => c.length >= 1)).length;
      // rtl börjar längst till höger (scrollLeft 0) och går mot −max åt vänster.
      await o.clear();
      const rtl = screen(PROBE, 420, 250);
      await wheelAt(o.page, rtl, -100, 0);
      rows.rtlLeft = await settle(() => scrollOf(f, 'rtl'), (s) => s.left < 0);
      await sleep(300);
      rows.panAfterRtlLeft = (await o.calls('pan')).length;
      await f.evaluate(() => void (document.getElementById('rtl')!.scrollLeft = 0));
      await wheelAt(o.page, rtl, 100, 0);
      rows.rtlRightPan = (await settle(() => o.calls('pan'), (c) => c.length >= 1)).length;
      // ltr
      await o.clear();
      const ltr = screen(PROBE, 420, 320);
      await wheelAt(o.page, ltr, 100, 0);
      rows.ltrRight = await settle(() => scrollOf(f, 'ltr'), (s) => s.left > 0);
      await sleep(300);
      rows.panAfterLtrRight = (await o.calls('pan')).length;
      await f.evaluate(() => void (document.getElementById('ltr')!.scrollLeft = 0));
      await wheelAt(o.page, ltr, -100, 0);
      rows.ltrLeftPan = (await settle(() => o.calls('pan'), (c) => c.length >= 1)).length;
      evidence.scrollDirections = rows;
      assert.ok((rows.chatUp as { top: number }).top < 0);
      assert.equal(rows.panAfterChat, 0);
      assert.equal(rows.chatBottomPan, 1);
      assert.ok((rows.rtlLeft as { left: number }).left < 0);
      assert.equal(rows.panAfterRtlLeft, 0);
      assert.equal(rows.rtlRightPan, 1);
      assert.ok((rows.ltrRight as { left: number }).left > 0);
      assert.equal(rows.panAfterLtrRight, 0);
      assert.equal(rows.ltrLeftPan, 1);
    } finally {
      await o.close();
    }
  });

  it('en sida som scrollar själv (dokumentet) scrollar, och panorerar först längst ner', async () => {
    const LONG: Placement = { ...PROBE, appId: 'long', page: 'index.html' };
    const o = await open([LONG]);
    try {
      const f = o.frames[0];
      const at = screen(LONG, 200, 200);
      await wheelAt(o.page, at, 0, 200);
      const y = await settle(() => f.evaluate(() => scrollY), (v) => v > 0);
      await sleep(300);
      const panWhileScrolling = (await o.calls('pan')).length;
      await f.evaluate(() => scrollTo(0, 1e6));
      await wheelAt(o.page, at, 0, 200);
      const pan = await settle(() => o.calls('pan'), (c) => c.length >= 1);
      evidence.documentScroll = { scrollY: y, panWhileScrolling, panAtBottom: pan.length };
      assert.ok(y > 0, 'dokumentet scrollade inte');
      assert.equal(panWhileScrolling, 0);
      assert.equal(pan.length, 1);
    } finally {
      await o.close();
    }
  });

  it('⌘, ⌥, ctrl+⌥ och smart zoom', async () => {
    const o = await open([PROBE]);
    try {
      const f = o.frames[0];
      const list = screen(PROBE, 420, 100);
      // ⌘+hjul panorerar även över en lista som kan scrolla.
      await wheelAt(o.page, list, 0, 60, ['Meta']);
      const pan = await settle(() => o.calls('pan'), (c) => c.length >= 1);
      await sleep(300);
      const listAfterMeta = (await scrollOf(f, 'list')).top;
      // ⌥+hjul → wheel/alt
      await wheelAt(o.page, screen(PROBE, 150, 100), 40, 0, ['Alt']);
      const alt = await settle(() => o.calls('alt'), (c) => c.length >= 1);
      // ctrl+⌥+hjul → zoom med alt
      const z1 = screen(PROBE, 150, 100);
      await wheelAt(o.page, z1, 0, -25, ['Control', 'Alt']);
      const zoomAlt = await settle(() => o.calls('zoom'), (c) => c.length >= 1);
      // Smart zoom: en äkta (isTrusted) ctrl-hjulhändelse med nollor och wheelDeltaY 0, via CDP.
      await o.clear();
      const z2 = screen(PROBE, 200, 60);
      await o.page.mouse.move(z2.x, z2.y);
      const cdp = await o.context.newCDPSession(o.page);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: z2.x, y: z2.y, deltaX: 0, deltaY: 0, modifiers: 2 });
      const smart = await settle(() => o.calls('zoom'), (c) => c.length >= 1);
      const smartSeen = await f.evaluate(() => (window as unknown as TW).__seen.wheel.at(-1));
      // Nyp med vilande fingrar: nollor men wheelDeltaY ±120 → inte smart.
      await o.clear();
      await f.evaluate(() =>
        document.getElementById('plain')!.dispatchEvent(
          new WheelEvent('wheel', { ctrlKey: true, deltaX: 0, deltaY: 0, wheelDeltaY: 120, clientX: 10, clientY: 10, bubbles: true, cancelable: true } as WheelEventInit),
        ),
      );
      const resting = await settle(() => o.calls('zoom'), (c) => c.length >= 1);
      evidence.modifierWheels = {
        metaPan: pan.map((c) => c.args),
        listAfterMeta,
        alt: alt.map((c) => c.args),
        zoomAlt: zoomAlt.map((c) => c.args),
        smart: smart.map((c) => c.args),
        smartSeen,
        resting: resting.map((c) => c.args),
      };
      assert.deepEqual(pan[0].args, [0, 60, 0, false]);
      assert.equal(listAfterMeta, 0, '⌘+hjul får inte scrolla listan');
      assert.deepEqual(alt[0].args, [40, 0, false]);
      assert.equal(zoomAlt[0].args[0], -25);
      assert.deepEqual(zoomAlt[0].args[3], { alt: true, smart: false, mode: 0 });
      assert.equal(smartSeen?.trusted, true);
      assert.equal(smartSeen?.wdy, 0);
      assert.equal(smart[0].args[0], 0);
      assert.deepEqual(smart[0].args[3], { alt: false, smart: true, mode: 0 });
      assert.ok(Math.hypot((smart[0].args[1] as number) - z2.x, (smart[0].args[2] as number) - z2.y) < 0.05);
      assert.deepEqual(resting[0].args[3], { alt: false, smart: false, mode: 0 });
    } finally {
      await o.close();
    }
  });

  // §11: med data-wb-wheel="app" på <html> skickas vanliga hjul aldrig vidare (appen tar dem själv), men
  // modifierade hjul (ctrl) går ändå till skalet. Kalibrering: utan attributet panorerar samma vanliga hjul.
  it('data-wb-wheel="app" behåller vanliga hjul i appen, men ctrl+hjul går till skalet', async () => {
    const o = await open([PROBE]);
    try {
      const f = o.frames[0];
      // En vanlig hjulhändelse över en yta som inte kan scrolla (#plain). wb.js avgör på attributet.
      const plainWheel = () =>
        f.evaluate(() =>
          document.getElementById('plain')!.dispatchEvent(
            new WheelEvent('wheel', { deltaX: 0, deltaY: 90, clientX: 20, clientY: 20, bubbles: true, cancelable: true } as WheelEventInit),
          ),
        );
      const lastWheelPrevented = () => f.evaluate(() => (window as unknown as TW).__seen.wheel.at(-1)?.prevented);

      // Kalibrering: utan attributet forwardas det vanliga hjulet som pan och förhindras.
      await o.clear();
      await plainWheel();
      const panNoAttr = await settle(() => o.calls('pan'), (c) => c.length >= 1);
      assert.equal(panNoAttr.length, 1, 'utan attributet ska ett vanligt hjul panorera');
      assert.equal(await lastWheelPrevented(), true);

      // Med attributet: samma vanliga hjul stannar i appen (inget forwardas, inget förhindras).
      await f.evaluate(() => document.documentElement.setAttribute('data-wb-wheel', 'app'));
      await o.clear();
      await plainWheel();
      await sleep(300);
      const panWithAttr = await o.calls('pan');
      assert.equal(panWithAttr.length, 0, 'med data-wb-wheel="app" ska vanliga hjul inte forwardas');
      assert.equal(await lastWheelPrevented(), false, 'appen får hjulet oförhindrat');

      // Modifierade hjul går ändå till skalet.
      await o.clear();
      await f.evaluate(() =>
        document.getElementById('plain')!.dispatchEvent(
          new WheelEvent('wheel', { ctrlKey: true, deltaX: 0, deltaY: -30, clientX: 20, clientY: 20, bubbles: true, cancelable: true } as WheelEventInit),
        ),
      );
      const zoom = await settle(() => o.calls('zoom'), (c) => c.length >= 1);
      assert.equal(zoom.length, 1, 'ctrl+hjul ska forwardas även med attributet');
      assert.equal(await lastWheelPrevented(), true);
      evidence.wheelAppAttr = { panNoAttr: panNoAttr.length, panWithAttr: panWithAttr.length, zoom: zoom.length };
    } finally {
      await o.close();
    }
  });
});

describe('bryggan i Chrome: tangenter, fokus och sidor', () => {
  const CHORDS = ['Meta+KeyK', 'Meta+Digit0', 'Control+Alt+ArrowLeft', 'Control+Alt+ArrowRight'];

  async function chords(leak?: string) {
    const o = await open([{ ...PROBE, page: `index.html${leak ? `?leak=${leak}` : ''}` }]);
    try {
      const f = o.frames[0];
      await clickField(o);
      await f.evaluate(() => {
        const s = (window as unknown as TW).__seen;
        s.keys.length = s.keysDoc.length = s.keysField.length = 0;
      });
      for (const k of CHORDS) await o.page.keyboard.press(k);
      const keys = await settle(() => o.calls('key'), (c) => c.length >= 4);
      for (const k of ['KeyK', 'Meta+KeyJ', 'ArrowLeft', 'Control+ArrowRight', 'Alt+ArrowLeft', 'ArrowDown']) await o.page.keyboard.press(k);
      await sleep(300);
      const seen = await f.evaluate(() => (window as unknown as TW).__seen);
      const codes = (list: Array<{ code: string }>) => list.map((k) => k.code).filter((c) => !/^(Meta|Control|Alt|Shift)/.test(c));
      return {
        forwarded: (await o.calls('key')).map((c) => c.args[0]),
        appWindowCapture: codes(seen.keys),
        appDocument: codes(seen.keysDoc),
        appField: codes(seen.keysField),
        fieldValue: await f.evaluate(() => (document.getElementById('field') as HTMLInputElement).value),
        keysCallsAfterChords: keys.length,
      };
    } finally {
      await o.close();
    }
  }

  it('⌘K, ⌘0, ⌃⌥←/→ döljs för appen och skickas; andra tangenter når appen', async () => {
    const m = await chords();
    evidence.chords = m;
    assert.deepEqual(m.forwarded, [
      { code: 'KeyK', meta: true, ctrl: false, alt: false, shift: false },
      { code: 'Digit0', meta: true, ctrl: false, alt: false, shift: false },
      { code: 'ArrowLeft', meta: false, ctrl: true, alt: true, shift: false },
      { code: 'ArrowRight', meta: false, ctrl: true, alt: true, shift: false },
    ]);
    for (const list of [m.appWindowCapture, m.appDocument, m.appField]) {
      assert.deepEqual(list, ['KeyK', 'KeyJ', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowDown'], 'appen ska bara se de andra tangenterna');
    }
    assert.equal(m.fieldValue, 'k');
  });

  it('kalibrering: utan stopImmediatePropagation ser appen skalets tangenter', async () => {
    const m = await chords('key-stop');
    evidence.chords_leak = m;
    assert.ok(m.appWindowCapture.includes('Digit0') && m.appField.includes('KeyK'), `testet ska fälla den planterade läckan: ${JSON.stringify(m.appWindowCapture)}`);
  });

  // §11: en hållen tangent (e.repeat) tas om hand men skickas aldrig vidare. Kalibrering: samma tangent
  // utan repeat skickas, så testet skulle fällas om repeat-flaggan inte filtrerades.
  it('upprepade ⌘K och Esc (e.repeat) skickas inte vidare; utan repeat skickas de', async () => {
    const o = await open([PROBE]);
    try {
      const f = o.frames[0];
      await clickField(o);
      await o.clear();
      const fire = (code: string, key: string, repeat: boolean, meta: boolean) =>
        f.evaluate(
          ([c, k, r, m]) =>
            window.dispatchEvent(new KeyboardEvent('keydown', { code: c as string, key: k as string, repeat: r as boolean, metaKey: m as boolean, bubbles: true, cancelable: true })),
          [code, key, repeat, meta] as const,
        );
      // Tre hållna ⌘K och tre hållna Esc först, sedan ett av varje utan repeat.
      for (let i = 0; i < 3; i++) await fire('KeyK', 'k', true, true);
      for (let i = 0; i < 3; i++) await fire('Escape', 'Escape', true, false);
      await fire('KeyK', 'k', false, true);
      await fire('Escape', 'Escape', false, false);
      const keys = await settle(() => o.calls('key'), (c) => c.length >= 2);
      const codes = keys.map((c) => (c.args[0] as { code: string }).code).sort();
      evidence.keyRepeat = codes;
      assert.deepEqual(codes, ['Escape', 'KeyK'], `bara de utan repeat ska skickas, inte ${JSON.stringify(codes)}`);
    } finally {
      await o.close();
    }
  });

  /** Esc när appen själv anropar preventDefault i en egen lyssnare på window (registrerad efter wb.js). */
  async function escapeWhenAppPrevents(leak?: string) {
    const o = await open([{ ...PROBE, page: `index.html${leak ? `?leak=${leak}` : ''}` }]);
    try {
      const f = o.frames[0];
      await clickField(o);
      await f.evaluate(() => void ((window as unknown as TW).__preventEscWindow = true));
      await o.page.keyboard.press('Escape');
      await sleep(300);
      return (await o.calls('key')).length;
    } finally {
      await o.close();
    }
  }

  it('Esc skickas bara när appen inte själv tagit den', async () => {
    const o = await open([PROBE]);
    try {
      const f = o.frames[0];
      await clickField(o);
      const esc = async () => {
        await o.clear();
        await o.page.keyboard.press('Escape');
        await sleep(250);
        return (await o.calls('key')).map((c) => c.args[0]);
      };
      const free = await esc();
      await f.evaluate(() => void ((window as unknown as TW).__preventEscField = true));
      const field = await esc();
      await f.evaluate(() => {
        (window as unknown as TW).__preventEscField = false;
        (window as unknown as TW).__preventEscWindow = true;
      });
      const win = await esc();
      await f.evaluate(() => {
        (window as unknown as TW).__preventEscWindow = false;
        (document.getElementById('dlg') as HTMLDialogElement).showModal();
      });
      const dialog = await esc();
      const dialogOpen = await f.evaluate(() => (document.getElementById('dlg') as HTMLDialogElement).open);
      const after = await esc();
      evidence.escape = { free, field, win, dialog, dialogOpen, after };
      assert.deepEqual(free, [{ code: 'Escape', meta: false, ctrl: false, alt: false, shift: false }]);
      assert.deepEqual(field, [], 'appens fält tog Esc');
      assert.deepEqual(win, [], 'appens egen lyssnare på window tog Esc');
      assert.deepEqual(dialog, [], 'webbläsaren stängde appens dialog');
      assert.equal(dialogOpen, false);
      assert.equal(after.length, 1);
    } finally {
      await o.close();
    }
  });

  it('kalibrering: utan defaultPrevented-kontrollen skickas Esc ändå', async () => {
    const n = await escapeWhenAppPrevents('escape-check');
    evidence.escape_leak = n;
    assert.equal(await escapeWhenAppPrevents(), 0);
    assert.equal(n, 1, 'testet ska fälla den planterade läckan');
  });

  it('pointerdown ger focus; hello, face, onChange och wb.face.show', async () => {
    const BACK: Placement = { ...PROBE, page: 'back.html', face: 'back', x: 800, y: 40, s: 0.5 };
    const o = await open([PROBE, BACK]);
    try {
      const [main, back] = o.frames;
      const hello = (await o.calls('hello')).map((c) => ({ appId: c.appId, face: c.face, info: c.args[0] }));
      const state = (f: Frame) =>
        f.evaluate(() => ({ current: (window as unknown as TW).wb.face.current, ready: (window as unknown as TW).__seen.ready, app: (window as unknown as TW).wb.app, changes: (window as unknown as TW).__seen.faceChanges, msgs: (window as unknown as TW).__seen.messages.length }));
      const before = { main: await state(main), back: await state(back) };
      await o.clear();
      await o.page.mouse.click(screen(PROBE, 150, 100).x, screen(PROBE, 150, 100).y);
      const focus = await settle(() => o.calls('focus'), (c) => c.length >= 1);
      // En avregistrerad onChange-lyssnare anropas inte.
      await main.evaluate(() => {
        const got: string[] = [];
        Object.assign(window, { __offGot: got });
        const off = (window as unknown as TW).wb.face.onChange((id) => got.push(id));
        off();
      });
      // Skalet vrider fram baksidan: alla sidor får veta det.
      await o.page.evaluate(() => {
        (window as unknown as TW).__harness.sendFace(0, 'back');
        (window as unknown as TW).__harness.sendFace(1, 'back');
      });
      const afterTurn = await settle(() => state(main), (s) => s.current === 'back');
      const backAfter = await state(back);
      // Appen ber om en sida.
      await main.evaluate(() => (window as unknown as TW).wb.face.show('main'));
      const req = await settle(() => o.calls('face'), (c) => c.length >= 1);
      const bad = await main.evaluate(() => {
        try {
          (window as unknown as TW).wb.face.show('Fel id');
          return 'inget fel';
        } catch (e) {
          return `${(e as Error).name}: ${(e as Error).message}`;
        }
      });
      const css = await main.evaluate(() => ['--wb-accent', '--wb-radius', '--wb-font'].map((v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim()));
      const cssBack = await back.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--wb-radius').trim());
      evidence.faces = { hello, before, focus: focus.map((c) => c.appId), afterTurn, backAfter, req: req.map((c) => c.args), bad, css, cssBack };
      assert.deepEqual(
        hello.sort((a, b) => a.face.localeCompare(b.face)),
        [
          { appId: 'probe', face: 'back', info: { face: 'back', w: 660, h: 440 } },
          { appId: 'probe', face: 'main', info: { face: 'main', w: 660, h: 440 } },
        ],
      );
      assert.equal(before.main.current, 'main');
      assert.equal(before.back.current, 'back');
      assert.ok(before.main.ready && before.main.ready.at < 1000, 'wb.ready ska bli klart av skalets svar, inte av 1 s-gränsen');
      assert.deepEqual(before.main.app, {
        id: 'probe',
        name: 'Sond',
        faces: [
          { id: 'main', page: 'index.html' },
          { id: 'back', page: 'back.html', label: 'Baksida' },
        ],
      });
      assert.deepEqual(focus.map((c) => c.appId), ['probe']);
      assert.equal(afterTurn.current, 'back');
      assert.deepEqual(afterTurn.changes, ['back']);
      assert.equal(afterTurn.msgs, 0, 'skalets protokoll ska inte synas för appens egna message-lyssnare');
      assert.equal(backAfter.current, 'back');
      assert.deepEqual(backAfter.changes, []);
      assert.deepEqual(await main.evaluate(() => (window as unknown as { __offGot: string[] }).__offGot), [], 'avregistrerad lyssnare');
      assert.deepEqual(req.map((c) => c.args), [['main']]);
      assert.match(bad, /^TypeError: wb\.face\.show: ogiltigt sid-id/);
      assert.equal(css[0], '#2f6bff');
      assert.equal(css[1], '12px');
      assert.match(css[2], /^-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif$/);
      assert.equal(cssBack, '4px', 'appens egen :root-regel vinner');
    } finally {
      await o.close();
    }
  });

  it('wb.ready väntar högst 1 s på skalet', async () => {
    // Skalet svarar med en sida som inte finns i appen: wb.js godtar bara giltiga id, så första face-meddelandet
    // kommer aldrig, och wb.ready ska ändå bli klart efter 1 s.
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
    try {
      const page = await context.newPage();
      await page.goto(`${h.shell}/?cfg=${encodeURIComponent(JSON.stringify([{ ...PROBE, face: 'Ogiltig' }]))}`);
      const frame = await (await page.waitForSelector('iframe')).contentFrame();
      assert.ok(frame);
      await frame.waitForFunction(() => !!(window as unknown as TW).__seen?.ready, null, { timeout: 4000 });
      const ready = await frame.evaluate(() => (window as unknown as TW).__seen.ready);
      evidence.readyTimeout = ready;
      assert.ok(ready && ready.at >= 990 && ready.at < 1800, `wb.ready vid ${ready?.at} ms`);
      assert.equal(ready?.face, 'main', 'gissningen från location.pathname');
    } finally {
      await context.close();
    }
  });
});

describe('bryggan i Chrome: avsändare och hastighet', () => {
  const KEY = { wb: 1, type: 'key', code: 'KeyK', meta: true, ctrl: false, alt: false, shift: false };

  /** En iframe som världen inte känner (men med en känd apps origin) skickar välformade meddelanden. */
  async function unknownWindow(leak?: string) {
    const o = await open([PROBE, { ...PROBE, x: 800, y: 40, s: 0.5, registered: false }], leak);
    try {
      await sleep(300); // den okända iframens hello hinner fram
      await o.clear();
      await o.frames[1].evaluate((k) => {
        parent.postMessage(k, `http://localhost:${location.port}`);
        parent.postMessage({ wb: 1, type: 'focus' }, `http://localhost:${location.port}`);
      }, KEY);
      await o.page.evaluate((k) => (window as unknown as TW).__harness.selfPost(k), KEY);
      await sleep(400);
      return (await o.calls()).length;
    } finally {
      await o.close();
    }
  }

  it('meddelanden från ett okänt fönster och från skalet självt avvisas', async () => {
    const n = await unknownWindow();
    evidence.unknownWindow = n;
    assert.equal(n, 0);
  });

  it('kalibrering: en brygga som litar på origin släpper in det okända fönstret', async () => {
    const n = await unknownWindow('by-origin');
    evidence.unknownWindow_leak = n;
    assert.ok(n >= 2, `testet ska fälla den planterade läckan (${n})`);
  });

  /** Den kända iframen navigerar till en annan app: e.source stämmer, origin inte. */
  async function wrongOrigin(leak?: string) {
    const o = await open([PROBE], leak);
    try {
      await o.clear();
      const el = await o.page.$('iframe');
      await o.frames[0]
        .evaluate((url) => void setTimeout(() => (location.href = url)), `${h.appOrigin('other')}/`)
        .catch(() => {}); // sammanhanget kan försvinna mitt i navigeringen
      await o.page.waitForFunction(() => document.querySelector('iframe')?.contentWindow !== null);
      let f: Frame | null = null;
      for (let i = 0; i < 40 && !f?.url().startsWith(h.appOrigin('other')); i++) {
        await sleep(50);
        f = (await el?.contentFrame()) ?? null;
      }
      assert.ok(f, 'navigeringen syntes inte');
      await f.waitForFunction(() => typeof (window as unknown as TW).wb === 'object');
      await sleep(300); // den andra appens hello hinner fram
      await f.evaluate((k) => parent.postMessage(k, `http://localhost:${location.port}`), KEY);
      await sleep(300);
      return (await o.calls()).map((c) => c.kind);
    } finally {
      await o.close();
    }
  }

  it('en känd iframe som navigerat till en annan origin avvisas', async () => {
    const kinds = await wrongOrigin();
    evidence.wrongOrigin = kinds;
    assert.deepEqual(kinds, []);
  });

  it('kalibrering: utan origin-kontrollen godtas den', async () => {
    const kinds = await wrongOrigin('origin');
    evidence.wrongOrigin_leak = kinds;
    assert.ok(kinds.includes('key'), `testet ska fälla den planterade läckan (${kinds})`);
  });

  async function flood(leak?: string) {
    const o = await open([PROBE], leak);
    try {
      await o.clear();
      await o.frames[0].evaluate(() => {
        for (let i = 0; i < 2000; i++) parent.postMessage({ wb: 1, type: 'focus' }, `http://localhost:${location.port}`);
      });
      await sleep(600);
      return (await o.calls('focus')).length;
    } finally {
      await o.close();
    }
  }

  it('en flod på 2000 meddelanden kapas till ungefär 400', async () => {
    const n = await flood();
    evidence.flood = n;
    // Hinken fylls på medan skalet arbetar sig igenom floden; den exakta takten provas med låtsasklocka
    // i bridge-validation.test.ts. Här visas att begränsningen är inkopplad.
    assert.ok(n >= 400 && n <= 600, `${n} meddelanden godtogs`);
  });

  it('kalibrering: utan hastighetsbegränsning går hela floden igenom', async () => {
    const n = await flood('rate');
    evidence.flood_leak = n;
    assert.equal(n, 2000, 'testet ska fälla den planterade läckan');
  });

  it('avregistreringen stänger bryggan', async () => {
    const o = await open([PROBE]);
    try {
      await o.page.evaluate(() => (window as unknown as TW).__harness.unsubscribe());
      await o.clear();
      await o.page.mouse.click(screen(PROBE, 150, 100).x, screen(PROBE, 150, 100).y);
      await sleep(300);
      assert.equal((await o.calls()).length, 0);
    } finally {
      await o.close();
    }
  });
});

describe('bryggan i Chrome: wb.store och loggar', () => {
  it('wb.store: sparar, läser, listar och tar bort; ogiltiga nycklar kastar tydligt', async () => {
    const o = await open([PROBE]);
    try {
      const r = await o.frames[0].evaluate(async () => {
        const s = (window as unknown as TW).wb.store;
        const out: Record<string, unknown> = {};
        await s.set('notes.v1', { text: 'Hej då, åäö', n: 1 });
        out.get = await s.get('notes.v1');
        await s.set('tom', null);
        out.nullValue = await s.get('tom');
        await s.set('k'.repeat(100), 1);
        out.all = await s.all();
        out.missing = await s.get('saknas');
        await s.delete('notes.v1');
        out.afterDelete = await s.get('notes.v1');
        await s.delete('notes.v1'); // att ta bort något som inte finns är inget fel
        const errors: Record<string, string> = {};
        const tries: Array<[string, () => unknown]> = [
          ['kolon', () => s.get('notes:v1')],
          ['punktpunkt', () => s.get('..')],
          ['punkt', () => s.set('.', 1)],
          ['tom', () => s.get('')],
          ['lång', () => s.get('x'.repeat(101))],
          ['snedstreck', () => s.delete('a/b')],
          ['tal', () => s.get(5)],
          ['odefinierat', () => s.set('a', undefined)],
          ['för stort', () => s.set('a', 'x'.repeat(1024 * 1024))],
          [
            'cirkulärt',
            () => {
              const c: Record<string, unknown> = {};
              c.c = c;
              return s.set('a', c);
            },
          ],
        ];
        for (const [name, fn] of tries) {
          try {
            const p = fn();
            errors[name] = `inget fel (${typeof p})`;
          } catch (e) {
            errors[name] = `${(e as Error).name}: ${(e as Error).message}`;
          }
        }
        out.errors = errors;
        return out;
      });
      evidence.store = { ...r, server: Object.fromEntries(h.stores.get('probe') ?? []) };
      assert.deepEqual(r.get, { text: 'Hej då, åäö', n: 1 });
      assert.equal(r.nullValue, null);
      assert.deepEqual(r.all, { 'notes.v1': { text: 'Hej då, åäö', n: 1 }, tom: null, ['k'.repeat(100)]: 1 });
      assert.equal(r.missing, undefined);
      assert.equal(r.afterDelete, undefined);
      const errors = r.errors as Record<string, string>;
      for (const name of ['kolon', 'punktpunkt', 'punkt', 'tom', 'lång', 'snedstreck', 'tal']) {
        assert.match(errors[name], /^TypeError: wb\.store\.\w+: ogiltig nyckel .*1–100 tecken av A–Z, a–z, 0–9, punkt, understreck och bindestreck/, name);
      }
      assert.match(errors.odefinierat, /^TypeError: wb\.store\.set: värdet för "a" går inte att spara som JSON/);
      assert.match(errors['för stort'], /^RangeError: wb\.store\.set: värdet för "a" är större än 1 MB/);
      assert.match(errors['cirkulärt'], /^TypeError: wb\.store\.set: värdet för "a" går inte att spara som JSON/);
      assert.deepEqual([...(h.stores.get('probe')?.keys() ?? [])].sort(), ['k'.repeat(100), 'tom']);
      assert.deepEqual(h.violations, []);
    } finally {
      await o.close();
    }
  });

  it('konsolfel, varningar, kastade fel och avvisade löften buntas till POST /__wb/log', async () => {
    const o = await open([PROBE]);
    try {
      h.logs.delete('probe');
      h.logPosts.delete('probe');
      await o.frames[0].evaluate(() => {
        console.error('fel %s nr %d', 'ett', 2);
        console.warn({ a: 1, å: 'ä' });
        console.log('det här loggas inte');
        setTimeout(() => {
          throw new Error('kastat');
        });
        void Promise.reject(new Error('avvisat'));
      });
      const logs = await settle(async () => h.logs.get('probe') ?? [], (l) => l.length >= 4, 2500);
      const posts = h.logPosts.get('probe');
      // 120 fel på en gång: högst 50 per bunt, en bunt var 500:e ms.
      h.logs.delete('probe');
      h.logPosts.delete('probe');
      const t0 = Date.now();
      await o.frames[0].evaluate(() => {
        for (let i = 0; i < 120; i++) console.error(`fel ${i}`);
      });
      const many = await settle(async () => h.logs.get('probe') ?? [], (l) => l.length >= 120, 4000);
      evidence.logs = { logs, posts, many: many.length, manyPosts: h.logPosts.get('probe'), manyMs: Date.now() - t0 };
      assert.deepEqual(logs[0], { level: 'error', text: 'fel ett nr 2' });
      assert.deepEqual(logs[1], { level: 'warn', text: '{"a":1,"å":"ä"}' });
      const rest = logs.slice(2).map((l) => l.text);
      assert.ok(rest.some((t) => t.startsWith('Uncaught Error: kastat')), JSON.stringify(rest));
      assert.ok(rest.some((t) => t.startsWith('Uncaught (in promise) Error: avvisat')), JSON.stringify(rest));
      assert.ok(!logs.some((l) => l.text.includes('loggas inte')));
      assert.equal(posts, 1, 'allt inom 500 ms går i en bunt');
      assert.equal(many.length, 120);
      assert.equal(h.logPosts.get('probe'), 3, '50 + 50 + 20');
      assert.deepEqual(h.violations, []);
    } finally {
      await o.close();
    }
  });

  /** Loggen svarar 500: ett enda utskick, och felet loggas aldrig i sin tur. */
  async function logFeedback(leak?: string) {
    const o = await open([{ ...PROBE, page: `index.html${leak ? `?leak=${leak}` : ''}` }]);
    try {
      await sleep(700); // tidigare loggar (t.ex. app.json-varningar) hinner iväg
      h.failLog.add('probe');
      const before = h.logPosts.get('probe') ?? 0;
      await o.frames[0].evaluate(() => console.error('ett fel'));
      await sleep(2700);
      return (h.logPosts.get('probe') ?? 0) - before;
    } finally {
      h.failLog.delete('probe');
      await o.close();
    }
  }

  it('ett misslyckat loggutskick loggas aldrig (ingen återkoppling)', async () => {
    const n = await logFeedback();
    evidence.logFeedback = n;
    assert.equal(n, 1);
  });

  it('kalibrering: en brygga som loggar sina egna loggfel slutar aldrig skicka', async () => {
    const n = await logFeedback('log-feedback');
    evidence.logFeedback_leak = n;
    assert.ok(n >= 3, `testet ska fälla den planterade läckan (${n} utskick)`);
  });

  /** console.error inifrån formateringen av ett console.error-argument. */
  async function logGuard(leak?: string) {
    const o = await open([{ ...PROBE, page: `index.html${leak ? `?leak=${leak}` : ''}` }]);
    try {
      await sleep(700);
      h.logs.delete('probe');
      const threw = await o.frames[0].evaluate(() => {
        try {
          const o2: { toJSON(): string } = {
            toJSON() {
              console.error(o2);
              return 'inre';
            },
          };
          console.error(o2);
          return null;
        } catch (e) {
          return String(e);
        }
      });
      await sleep(1300);
      return { threw, entries: (h.logs.get('probe') ?? []).length, first: h.logs.get('probe')?.[0] };
    } finally {
      await o.close();
    }
  }

  it('rekursionsspärren: console.error inifrån loggningen ger en post', async () => {
    const m = await logGuard();
    evidence.logGuard = m;
    assert.equal(m.threw, null);
    assert.equal(m.entries, 1);
    assert.deepEqual(m.first, { level: 'error', text: '"inre"' });
  });

  it('kalibrering: utan spärren rekurserar loggningen', async () => {
    const m = await logGuard('log-guard');
    evidence.logGuard_leak = m;
    assert.ok(m.entries > 1 || m.threw !== null, `testet ska fälla den planterade läckan (${JSON.stringify(m)})`);
  });

  /** console.error och direkt navigering: posten väntar på nästa bunt när sidan lämnas. */
  async function pagehideFlush(leak?: string) {
    const o = await open([{ ...PROBE, page: `index.html${leak ? `?leak=${leak}` : ''}` }]);
    try {
      await sleep(700);
      h.logs.delete('probe');
      await o.frames[0]
        .evaluate(() => {
          console.error('precis före navigeringen');
          setTimeout(() => (location.href = '/back.html'));
        })
        .catch(() => {});
      return await settle(async () => h.logs.get('probe') ?? [], (l) => l.length >= 1, 1500);
    } finally {
      await o.close();
    }
  }

  it('det som väntar på nästa bunt skickas när sidan lämnas (pagehide)', async () => {
    const logs = await pagehideFlush();
    evidence.pagehide = logs;
    assert.deepEqual(logs, [{ level: 'error', text: 'precis före navigeringen' }]);
  });

  it('kalibrering: utan tömning vid pagehide försvinner posten', async () => {
    const logs = await pagehideFlush('pagehide');
    evidence.pagehide_leak = logs;
    assert.deepEqual(logs, [], 'testet ska fälla den planterade läckan');
  });

  it('wb.js löser sina adresser mot appens origin även med <base href>', async () => {
    const o = await open([{ ...PROBE, appId: 'long' }]);
    try {
      h.logs.delete('long');
      const got = await o.frames[0].evaluate(async () => {
        await (window as unknown as TW).wb.store.set('bas', 'ok');
        console.warn('från en sida med base');
        return (window as unknown as TW).wb.store.get('bas');
      });
      const logs = await settle(async () => h.logs.get('long') ?? [], (l) => l.length >= 1);
      assert.equal(got, 'ok');
      assert.deepEqual(logs, [{ level: 'warn', text: 'från en sida med base' }]);
    } finally {
      await o.close();
    }
  });

  it('wb.store.get av en saknad nyckel: undefined utan "Failed to load resource" i konsolen (K6)', async () => {
    const o = await open([PROBE]);
    try {
      const errors: string[] = [];
      o.page.on('console', (m) => {
        if (m.type() === 'error') errors.push(m.text());
      });
      // Kalibrering: samma förfrågan utan x-wb-optional får 404, och Chrome loggar den i appens konsol.
      await o.frames[0].evaluate(() => fetch('/__wb/store/saknas-kal').then((r) => r.status));
      const seen = await settle(async () => errors.slice(), (e) => e.some((x) => x.includes('Failed to load resource')), 2000);
      assert.ok(seen.some((x) => x.includes('Failed to load resource') && x.includes('404')), `kalibreringen såg inget: ${JSON.stringify(seen)}`);
      errors.length = 0;
      const got = await o.frames[0].evaluate(() => (window as unknown as TW).wb.store.get('saknas').then((v) => v === undefined));
      await sleep(600);
      assert.equal(got, true);
      assert.deepEqual(errors.filter((x) => x.includes('Failed to load resource')), []);
    } finally {
      await o.close();
    }
  });
});

describe('bryggan i Chrome: toppnivå (skärmbild, egen flik)', () => {
  async function topLevel(leak?: string) {
    const context = await browser.newContext({ viewport: { width: 900, height: 600 }, deviceScaleFactor: 2 });
    try {
      const page = await context.newPage();
      await page.goto(`${h.appOrigin('probe')}/?spy=1${leak ? `&leak=${leak}` : ''}`);
      await page.waitForFunction(() => !!(window as unknown as TW).__seen?.ready);
      h.logs.delete('probe');
      const s = await page.evaluate(async () => {
        const w = (window as unknown as TW);
        const css = getComputedStyle(document.documentElement).getPropertyValue('--wb-accent').trim();
        await w.wb.store.set('topp', [1, 2, 3]);
        const stored = await w.wb.store.get('topp');
        w.wb.face.show('back');
        console.error('fel på toppnivå');
        return { css, stored, ready: w.__seen.ready, current: w.wb.face.current, parentIsSelf: window.parent === window };
      });
      // Webbläsarens egna gester ska fungera som vanligt på toppnivå.
      await page.mouse.move(150, 100);
      await page.keyboard.down('Control');
      await page.mouse.wheel(0, 40);
      await page.keyboard.up('Control');
      await page.click('#field');
      await page.keyboard.press('Meta+KeyK');
      await page.keyboard.press('Escape');
      await sleep(300);
      const after = await page.evaluate(() => ({
        posts: (window as unknown as TW).__posts.length,
        wheel: (window as unknown as TW).__seen.wheel.at(-1),
        keys: (window as unknown as TW).__seen.keys.map((k) => k.code),
      }));
      const logs = await settle(async () => h.logs.get('probe') ?? [], (l) => l.length >= 1);
      await page.goto(`${h.appOrigin('probe')}/back.html?spy=1${leak ? `&leak=${leak}` : ''}`);
      await page.waitForFunction(() => !!(window as unknown as TW).__seen?.ready);
      const back = await page.evaluate(() => (window as unknown as TW).wb.face.current);
      return { ...s, ...after, logs, back };
    } finally {
      await context.close();
    }
  }

  it('wb, CSS-variablerna, store och loggar fungerar; inget skickas till någon förälder', async () => {
    const m = await topLevel();
    evidence.topLevel = m;
    assert.equal(m.parentIsSelf, true);
    assert.equal(m.css, '#2f6bff');
    assert.deepEqual(m.stored, [1, 2, 3]);
    assert.ok(m.ready && m.ready.at < 900, 'på toppnivå väntar wb.ready inte på något skal');
    assert.equal(m.current, 'main');
    assert.equal(m.back, 'back');
    assert.deepEqual(m.logs, [{ level: 'error', text: 'fel på toppnivå' }]);
    assert.equal(m.wheel?.ctrl, true);
    assert.equal(m.wheel?.prevented, false, 'ctrl+hjul ska inte förhindras på toppnivå');
    assert.ok(m.keys.includes('KeyK'), '⌘K ska nå appen på toppnivå');
    assert.equal(m.posts, 0);
  });

  it('wb.js fungerar även när den injicerats efter doctype eller allra först (§7.2)', async () => {
    const context = await browser.newContext({ viewport: { width: 900, height: 600 }, deviceScaleFactor: 2 });
    try {
      const page = await context.newPage();
      const rows: Record<string, unknown> = {};
      for (const name of ['bare.html', 'naked.html']) {
        await page.goto(`${h.appOrigin('other')}/${name}`);
        rows[name] = await page.evaluate(async () => {
          const w = window as unknown as TW;
          await w.wb.ready;
          const first = document.head.firstElementChild;
          return {
            mode: document.compatMode,
            accent: getComputedStyle(document.documentElement).getPropertyValue('--wb-accent').trim(),
            firstInHead: first?.tagName + (first?.getAttribute('src') ?? ''),
            app: w.wb.app.name,
          };
        });
      }
      evidence.injection = rows;
      assert.deepEqual(rows['bare.html'], { mode: 'CSS1Compat', accent: '#2f6bff', firstInHead: 'SCRIPT/__wb/wb.js', app: 'Annan' });
      assert.deepEqual(rows['naked.html'], { mode: 'BackCompat', accent: '#2f6bff', firstInHead: 'SCRIPT/__wb/wb.js', app: 'Annan' });
    } finally {
      await context.close();
    }
  });

  it('kalibrering: en brygga som tror att den ligger i en iframe skickar meddelanden', async () => {
    const m = await topLevel('toplevel');
    evidence.topLevel_leak = { posts: m.posts };
    assert.ok(m.posts > 0, 'testet ska fälla den planterade läckan');
  });
});
