// hud-browser.test.ts — HUD:en i riktig Chrome mot en egen server (låtsas-Claude, egna portar, tillfälligt hem).
// Visar det som inte kan visas i Node: att strängar från Claude aldrig blir HTML i den riktiga DOM:en
// (kalibrerat mot en planterad innerHTML-läcka), Esc-regeln för oanvända appar, "skriv var som helst" och
// att ett hemligt värde lämnar DOM:en direkt men hamnar i appens data/secrets.json, att Esc aldrig kastar en
// halvskriven beskrivning och att HUD:en med sitt utkast överlever en omladdning av sidan.
// HUD_TEST_PORT, HUD_TEST_HMR_PORT och HUD_TEST_HOME_DIR väljer egna portar och hemkatalog (annars lediga portar
// och .scratch/hud-browser-*). Saknas Chrome hoppas filen över.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { testPort } from '../ports.ts';

const root = path.resolve(import.meta.dirname, '../..');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Saknas Chrome hoppas hela filen över (som tests/e2e/shell-flow.test.ts). Alla andra fel vid start får testet att falla.
// Låtsasmikrofon (B7): en ton i stället för en riktig mikrofon, och ingen fråga om behörighet.
let browser: Browser | null = null;
let noChrome: string | false = false;
try {
  browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--force-device-scale-factor=2', '--mute-audio', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  });
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
let serverLog = '';

async function frames(n = 2): Promise<void> {
  await page.evaluate((k) => new Promise<void>((res) => {
    let i = 0;
    const f = () => (++i >= k ? res() : requestAnimationFrame(f));
    requestAnimationFrame(f);
  }), n);
}

/** Den aktiva HUD:ens app (null när ingen är öppen). */
async function hudOpenFor(): Promise<string | null> {
  return page.evaluate(() => (window as any).__wb.world.debug.hudApp() as string | null);
}

/** Alla öppna HUD:ar i öppningsordning. (Före flera HUD:ar fanns bara hudApp: en eller ingen.) */
async function openApps(): Promise<string[]> {
  return page.evaluate(() => {
    const d = (window as any).__wb.world.debug;
    if (typeof d.huds === 'function') return d.huds().open as string[];
    const a = d.hudApp() as string | null;
    return a ? [a] : [];
  });
}

/** Väljare för appens HUD (aldrig en kopia som fälls ihop: de ligger utanför .wbh). */
const H = (id: string, s = '') => `.wbh[data-app="${id}"]:not([hidden])${s ? ' ' + s : ''}`;

/** Ingen öppen HUD (för appen, eller alls). */
async function waitClosed(id?: string): Promise<void> {
  await page.waitForFunction((a) => ![...document.querySelectorAll<HTMLElement>('.wbh')].some((e) => !e.hidden && (!a || e.dataset.app === a)), id ?? null, { timeout: 5000 });
}

/** Appen vars HUD har tangentbordsfokus (null om fokus inte ligger i någon HUD). */
async function focusedHud(): Promise<string | null> {
  return page.evaluate(() => (document.activeElement?.closest('.wbh') as HTMLElement | null)?.dataset.app ?? null);
}

async function appIds(): Promise<string[]> {
  return page.evaluate(() => [...(window as any).__wb.store.apps.keys()] as string[]);
}

async function newApp(x: number, y: number): Promise<string> {
  const id = await page.evaluate(async ([px, py]) => {
    const res = await (window as any).__wb.store.createApp({ x: px, y: py, w: 480, h: 320, scale: 1 });
    return res.app.id as string;
  }, [x, y] as const);
  await page.waitForFunction((a) => !!(window as any).__wb.world.screenRectOf(a), id);
  return id;
}

async function openHud(appId: string): Promise<void> {
  await page.evaluate((a) => (window as any).__wb.bus.emit('hud:open', { appId: a, reason: 'dot' }), appId);
  await page.waitForFunction((a) => {
    const el = document.querySelector(`.wbh[data-app="${a}"]`) as HTMLElement | null;
    return !!el && !el.hidden;
  }, appId);
  await frames(3);
}

/** Loggrader från appens konsol, som wb.js postar dem till appens egen origin (POST /__wb/log, §7.2). */
function postAppLog(appId: string, entries: { level: string; text: string }[]): Promise<number> {
  const port = Number(new URL(base).port);
  const origin = `http://${appId}.localhost:${port}`;
  const body = Buffer.from(JSON.stringify(entries));
  return new Promise((resolve, reject) => {
    const r = http.request(
      {
        host: '127.0.0.1', port, method: 'POST', path: '/__wb/log',
        headers: { host: `${appId}.localhost:${port}`, origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', 'content-length': String(body.length) },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    r.on('error', reject);
    r.end(body);
  });
}

/** Ta bort alla appar (mellan testerna), så att ritandet alltid börjar på tom yta. */
async function clearApps(): Promise<void> {
  await page.evaluate(async () => {
    const w = (window as any).__wb;
    for (const el of document.querySelectorAll<HTMLElement>('.wbh')) if (!el.hidden && el.dataset.app) w.bus.emit('hud:close', { appId: el.dataset.app });
    for (const id of [...w.store.apps.keys()]) await w.store.deleteApp(id).catch(() => {});
  });
  await page.waitForFunction(() => (window as any).__wb.store.apps.size === 0);
  await sleep(500);
}

async function drawApp(x0: number, y0: number, x1: number, y1: number): Promise<string> {
  const before = new Set(await appIds());
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  for (let i = 1; i <= 14; i++) await page.mouse.move(x0 + ((x1 - x0) * i) / 14, y0 + ((y1 - y0) * i) / 14);
  await page.mouse.up();
  await page.waitForFunction((b) => [...(window as any).__wb.store.apps.keys()].some((k: string) => !b.includes(k)), [...before]);
  const id = (await appIds()).find((k) => !before.has(k)) as string;
  await page.waitForFunction((a) => (window as any).__wb.world.debug.hudApp() === a, id);
  await sleep(500);
  return id;
}

describe('HUD:en i riktig Chrome', { skip: noChrome, timeout: 180_000 }, () => {
  before(async () => {
    const port = await testPort('HUD_TEST_PORT');
    // En slumpad port ger en egen Vite-cache (node_modules/.vite-<port>, CONTRACT §4.3) som annars blir kvar.
    if (!process.env.HUD_TEST_PORT) viteCache = path.join(root, 'node_modules', `.vite-${port}`);
    const hmr = await testPort('HUD_TEST_HMR_PORT');
    const homeDir = process.env.HUD_TEST_HOME_DIR || path.join(root, '.scratch');
    fs.mkdirSync(homeDir, { recursive: true });
    home = fs.mkdtempSync(path.join(homeDir, 'hud-browser-'));
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
    base = `http://localhost:${port}`;
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
    // Fångar CSP-överträdelser och "lyckade" injektioner från första stund.
    await page.addInitScript(() => {
      (window as any).__violations = [];
      document.addEventListener('securitypolicyviolation', (e) => (window as any).__violations.push(`${e.violatedDirective}: ${e.sample}`));
    });
    await page.goto(base + '/');
    await page.waitForFunction(() => (window as any).__wb?.store?.connected === true, null, { timeout: 60_000 });
  }, { timeout: 120_000 });

  after(async () => {
    await browser?.close().catch(() => {});
    if (server && server.exitCode === null) {
      server.kill('SIGTERM');
      await new Promise((r) => server?.once('exit', r));
    }
    if (home) fs.rmSync(home, { recursive: true, force: true });
    if (viteCache) fs.rmSync(viteCache, { recursive: true, force: true });
  }, { timeout: 30_000 });

  test('XSS: HTML från Claude, appen och servern visas som text och körs aldrig (kalibrerat)', async () => {
    const payloads = ['<img src=x onerror=window.__pwned=1>', '</code><script>window.__pwned=2</script>', '<svg onload=window.__pwned=3>'];
    // Planterad läcka: samma innehåll via innerHTML i HUD-lagret måste fällas av båda detektorerna.
    const planted = await page.evaluate(async (p) => {
      const d = document.createElement('div');
      d.className = 'planted';
      document.getElementById('hud-layer')!.append(d);
      d.innerHTML = p.join(' ');
      await new Promise((r) => setTimeout(r, 300));
      const found = d.querySelectorAll('img, script, svg[onload]').length;
      d.remove();
      return { found, violations: (window as any).__violations.length as number };
    }, payloads);
    assert.ok(planted.found >= 2, 'detektorn ser element från innerHTML');
    assert.ok(planted.violations >= 1, 'CSP-överträdelsen syns när en hanterare försöker köras');
    await page.evaluate(() => ((window as any).__violations = []));

    const id = await newApp(-600, -300);
    await openHud(id);
    await page.evaluate(([appId, p]) => {
      const w = (window as any).__wb;
      const now = Date.now();
      const app = w.store.apps.get(appId);
      w.store.receive({ t: 'app', app: { ...app, name: p[0], status: 'waiting', permissions: ['microphone'] } });
      const evs = [
        { k: 'user', id: 'x-u', text: p[0], via: 'text', at: now - 900 },
        { k: 'turn', phase: 'start', at: now - 800 },
        { k: 'text', id: 'x-t', text: `Svar ${p[0]} och \`${p[1]}\` och **${p[2]}**`, at: now - 700 },
        { k: 'note', id: 'x-n', text: p[1], at: now - 650 },
        { k: 'tool', id: 'x-tool', name: 'Write', label: p[2], at: now - 600 },
        { k: 'ask', id: 'x-a1', at: now - 500, ask: { kind: 'permission', tool: 'WebFetch', title: p[0], detail: p[1], canRemember: true, defaultNo: false } },
        { k: 'ask', id: 'x-a2', at: now - 400, ask: { kind: 'question', questions: [{ question: p[1], multiSelect: true, options: [{ label: p[0], description: p[2] }] }] } },
        { k: 'ask', id: 'x-a3', at: now - 300, ask: { kind: 'secret', key: 'k', label: p[2] } },
      ];
      for (const ev of evs) w.store.receive({ t: 'chat', appId, ev });
      w.store.receive({ t: 'chat', appId, ev: { k: 'delta', text: `strömmar ${p[0]}` } });
    }, [id, payloads] as const);
    await sleep(400);
    const res = await page.evaluate(() => {
      const hud = document.querySelector('.wbh:not([hidden])') as HTMLElement;
      const bad = [...hud.querySelectorAll('img, script, iframe, object, embed')].length;
      const onAttrs = [...hud.querySelectorAll('*')].filter((e) => [...e.attributes].some((a) => a.name.startsWith('on'))).length;
      const svgs = [...hud.querySelectorAll('svg')].filter((s) => !s.closest('.wbh-icon') && !s.classList.contains('wbh-check')).length;
      return { bad, onAttrs, svgs, text: hud.textContent ?? '', pwned: (window as any).__pwned ?? null, violations: (window as any).__violations as string[] };
    });
    assert.equal(res.bad, 0, 'inga element ur strängar');
    assert.equal(res.onAttrs, 0, 'inga on*-attribut');
    assert.equal(res.svgs, 0, 'bara HUD:ens egna ikoner är SVG');
    assert.equal(res.pwned, null);
    assert.deepEqual(res.violations, []);
    for (const p of payloads) assert.ok(res.text.includes(p), `syns som text: ${p}`);
    // städa: frågorna besvarade, appen idle
    await page.evaluate((appId) => {
      const w = (window as any).__wb;
      for (const a of ['x-a1', 'x-a2', 'x-a3']) w.store.receive({ t: 'chat', appId, ev: { k: 'ask-done', id: a, decision: 'cancelled' } });
      w.store.receive({ t: 'app', app: { ...w.store.apps.get(appId), status: 'idle', permissions: [] } });
      w.bus.emit('hud:close', { appId });
    }, id);
    await sleep(500);
  });

  test('Esc tar bort en nyss ritad, oanvänd app; klick på tom yta behåller den', async () => {
    await clearApps();
    // Esc direkt efter ritandet: appen löses upp och tas bort på servern.
    const a = await drawApp(200, 160, 640, 460);
    assert.equal(await hudOpenFor(), a);
    await page.keyboard.press('Escape');
    await page.waitForFunction((x) => !(window as any).__wb.store.apps.has(x), a, { timeout: 5000 });
    assert.equal(await hudOpenFor(), null);
    const r = await fetch(`${base}/api/snapshot`, { headers: { origin: base } }).then((x) => x.json());
    assert.ok(!r.apps.some((x: { id: string }) => x.id === a), 'borta på servern');
    await sleep(900); // världen löser upp fönstret innan nästa fyrkant ritas på samma ställe

    // Klick på tom yta: HUD:en sjunker in i pricken, fyrkanten finns kvar.
    const b = await drawApp(200, 160, 640, 460);
    await page.mouse.click(1200, 820);
    await waitClosed();
    await sleep(300);
    assert.ok((await appIds()).includes(b), 'behålls vid klick på tom yta');

    // Öppnad med pricken (inte created): Esc stänger bara.
    await openHud(b);
    await page.keyboard.press('Escape');
    await waitClosed();
    await sleep(300);
    assert.ok((await appIds()).includes(b), 'behålls när HUD:en öppnades med pricken');
    await page.evaluate((x) => (window as any).__wb.store.deleteApp(x), b);
    await sleep(400);
  });

  test('Esc efter ett skickat meddelande behåller appen', async () => {
    await clearApps();
    const a = await drawApp(220, 180, 660, 480);
    await page.keyboard.type('Jag vill ha en klocka');
    await page.keyboard.press('Enter');
    await page.waitForFunction((x) => (window as any).__wb.store.apps.get(x)?.status !== 'idle' || (window as any).__wb.store.apps.get(x)?.built, a);
    await page.keyboard.press('Escape');
    await waitClosed();
    await sleep(400);
    assert.ok((await appIds()).includes(a));
    await page.waitForFunction((x) => (window as any).__wb.store.apps.get(x)?.status === 'idle', a, { timeout: 20_000 });
    await page.evaluate((x) => (window as any).__wb.store.deleteApp(x), a);
    await sleep(400);
  });

  test('skriv var som helst: tecken hamnar i inmatningen när fokus ligger på skalet', async () => {
    await clearApps();
    const id = await newApp(-500, -260);
    await openHud(id);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    assert.equal(await page.evaluate(() => document.activeElement === document.body), true);
    await page.keyboard.type('Hej då');
    const value = await page.evaluate((s) => (document.querySelector(s) as HTMLTextAreaElement).value, H(id, '.wbh-input'));
    assert.equal(value, 'Hej då');
    // Med ett annat fält i fokus (planterat i skalet) får HUD:en inget.
    await page.evaluate((s) => {
      (document.querySelector(s) as HTMLTextAreaElement).value = '';
      const f = document.createElement('input');
      f.id = 'other-field';
      f.style.cssText = 'position:fixed;left:10px;top:10px';
      document.body.append(f);
      f.focus();
    }, H(id, '.wbh-input'));
    await page.keyboard.type('xyz');
    const after = await page.evaluate((s) => ({
      hud: (document.querySelector(s) as HTMLTextAreaElement).value,
      other: (document.getElementById('other-field') as HTMLInputElement).value,
    }), H(id, '.wbh-input'));
    assert.deepEqual(after, { hud: '', other: 'xyz' });
    await page.evaluate((a) => {
      document.getElementById('other-field')?.remove();
      (window as any).__wb.bus.emit('hud:close', { appId: a });
    }, id);
    await sleep(400);
  });

  test('menyn: Ta bort appen bekräftas i menyn och tar bort appen på servern', async () => {
    await clearApps();
    const id = await newApp(-520, -260);
    await openHud(id);
    await page.hover(H(id, '.wbh-panel'));
    await page.click(H(id, '.wbh-more'));
    const items = await page.evaluate(() => [...document.querySelectorAll('.wbh-menu-item')].map((b) => b.textContent));
    // Inte byggd: inget att öppna i egen flik; ingen tur pågår: ångra finns; loggen finns alltid (§13). Fönstret står på
    // sin plats: Minimera (§10.7).
    assert.deepEqual(items, ['Ångra senaste ändringen', 'Visa loggen', 'Minimera', 'Ta bort appen']);
    await page.click('text=Ta bort appen');
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('.wbh-menu button')].map((b) => b.textContent)), ['Ta bort', 'Avbryt']);
    await page.click('.wbh-menu >> text=Avbryt');
    assert.equal(await page.evaluate(() => (document.querySelector('.wbh-menu') as HTMLElement).hidden), true);
    assert.ok((await appIds()).includes(id), 'Avbryt behåller appen');
    await page.click(H(id, '.wbh-more'));
    await page.click('text=Ta bort appen');
    await page.click(H(id, '.wbh-menu .wbh-btn.is-danger'));
    await page.waitForFunction((a) => !(window as any).__wb.store.apps.has(a), id, { timeout: 5000 });
    assert.equal(await hudOpenFor(), null);
    const r = await fetch(`${base}/api/snapshot`, { headers: { origin: base } }).then((x) => x.json());
    assert.ok(!r.apps.some((x: { id: string }) => x.id === id));
  });

  test('menyn: Gör om finns bara efter ett ångra, gör om ändringen och försvinner vid toppen, efter nästa tur och efter ett 409 (§13)', async () => {
    await clearApps();
    const id = await newApp(-520, -260);
    await openHud(id);
    const app = () => page.evaluate((a) => (window as any).__wb.store.apps.get(a) as { status: string; built: boolean; rev: number }, id);
    const items = () => page.evaluate((s) => [...document.querySelectorAll(s)].map((b) => b.textContent), H(id, '.wbh-menu-item'));
    const notes = (text: string) => page.evaluate(([s, t]) => [...document.querySelectorAll(s)].filter((e) => e.textContent === t).length, [H(id, '.wbh-note'), text] as const);
    const openMenu = async () => {
      await page.hover(H(id, '.wbh-panel'));
      await page.click(H(id, '.wbh-more'));
      return items();
    };
    /** Klickar en rad i menyn och väntar in serverns svar (skalet läser canRedo ur det). */
    const choose = async (text: string, route: 'undo' | 'redo') => {
      const answered = page.waitForResponse((r) => r.url().endsWith(`/api/apps/${id}/${route}`));
      await page.locator(H(id, '.wbh-menu-item'), { hasText: text }).click();
      await answered;
      await frames(3);
    };
    const turnsDone = () => page.evaluate((a) => ((window as any).__wb.store.chats.get(a) ?? []).filter((e: any) => e.k === 'turn' && e.phase === 'end').length as number, id);
    /** Skickar ett meddelande och väntar tills turen och §8.6 är klara (status idle sätts sist). */
    const build = async (text: string) => {
      const n = await turnsDone();
      await page.click(H(id, '.wbh-input'));
      await page.keyboard.type(text);
      await page.keyboard.press('Enter');
      await page.waitForFunction(([a, k]) => {
        const w = (window as any).__wb;
        const x = w.store.apps.get(a);
        const ends = (w.store.chats.get(a) ?? []).filter((e: any) => e.k === 'turn' && e.phase === 'end').length;
        return ends > k && x?.status === 'idle' && x.built === true;
      }, [id, n] as const, { timeout: 20_000 });
    };

    await build('Jag vill ha en anteckningsapp');
    // Kalibrering: före ångra finns ingen Gör om-rad (och ingen avstängd rad).
    const before = await openMenu();
    assert.ok(before.includes('Ångra senaste ändringen'), JSON.stringify(before));
    assert.ok(!before.includes('Gör om'), `Gör om före ångra: ${JSON.stringify(before)}`);
    await choose('Ångra senaste ändringen', 'undo');
    await page.waitForFunction((a) => (window as any).__wb.store.apps.get(a)?.built === false, id, { timeout: 5000 });
    const afterUndo = await openMenu();
    assert.equal(afterUndo.indexOf('Gör om'), afterUndo.indexOf('Ångra senaste ändringen') + 1, `Gör om direkt efter Ångra: ${JSON.stringify(afterUndo)}`);

    const rev = (await app()).rev;
    await choose('Gör om', 'redo');
    await page.waitForFunction(([s, t]) => [...document.querySelectorAll(s)].some((e) => e.textContent === t), [H(id, '.wbh-note'), 'Gjorde om ändringen.'] as const, { timeout: 5000 });
    await page.waitForFunction(([a, r]) => {
      const x = (window as any).__wb.store.apps.get(a);
      return x?.built === true && x.rev !== r;
    }, [id, rev] as const, { timeout: 5000 });
    assert.equal(await notes('Gjorde om ändringen.'), 1);
    assert.ok(!(await openMenu()).includes('Gör om'), 'framme vid toppen: ingen Gör om');
    await page.keyboard.press('Escape');

    // Ett nytt ångra ger Gör om igen, och det står kvar när HUD:en stängs och öppnas.
    await openMenu();
    await choose('Ångra senaste ändringen', 'undo');
    await page.evaluate((a) => (window as any).__wb.bus.emit('hud:close', { appId: a }), id);
    await waitClosed(id);
    await openHud(id);
    assert.ok((await openMenu()).includes('Gör om'), 'Gör om efter att HUD:en öppnats igen');
    await page.keyboard.press('Escape');

    // Nästa tur tar bort det (servern har en ny commit, och skalet glömmer det vid turen).
    await build('Gör den mörk');
    assert.ok(!(await openMenu()).includes('Gör om'), 'ingen Gör om efter nästa tur');
    await page.keyboard.press('Escape');

    // Ett 409 från menyn (servern är redan framme, som efter gör om i en annan flik): en kort rad lokalt, och Gör om försvinner.
    await openMenu();
    await choose('Ångra senaste ändringen', 'undo');
    const direct = await page.evaluate(async (a) => {
      const r = await fetch(`/api/apps/${a}/redo`, { method: 'POST' });
      return { status: r.status, body: await r.json() };
    }, id);
    assert.deepEqual(direct, { status: 200, body: { ok: true, canRedo: false } }, 'kalibrering: servern är framme utan att skalet vet det');
    assert.ok((await openMenu()).includes('Gör om'), 'kalibrering: skalet har kvar Gör om');
    await choose('Gör om', 'redo');
    const lines = () => page.evaluate((s) => [...document.querySelectorAll(s)].map((e) => e.textContent), H(id, '.wbh-line'));
    await page
      .waitForFunction(([s, t]) => [...document.querySelectorAll(s)].some((e) => e.textContent === t), [H(id, '.wbh-line'), 'Det finns inget att göra om'] as const, { timeout: 3000 })
      .catch(async () => assert.fail(`raden efter 409: ${JSON.stringify(await lines())}`));
    assert.ok(!(await openMenu()).includes('Gör om'), 'efter 409: ingen Gör om');
    await page.keyboard.press('Escape');
    await page.evaluate((a) => (window as any).__wb.bus.emit('hud:close', { appId: a }), id);
    await sleep(400);
  });

  test('behörighetskortet: Tillåt sparar med setGrants och sänder grants:changed; Neka frågar inte igen', async () => {
    await clearApps();
    const id = await newApp(-520, -260);
    await openHud(id);
    await page.evaluate((a) => {
      const w = (window as any).__wb;
      (window as any).__grants = [];
      w.bus.on('grants:changed', (e: { appId: string }) => (window as any).__grants.push(e.appId));
      w.store.receive({ t: 'app', app: { ...w.store.apps.get(a), name: 'Diktering', permissions: ['microphone'] } });
    }, id);
    await page.waitForSelector('.wbh-card');
    assert.equal(await page.evaluate(() => document.querySelector('.wbh-card-title')!.textContent), 'Diktering vill använda mikrofonen');
    assert.equal(await page.evaluate(() => !!document.activeElement?.closest('.wbh-card')), false, 'kortet tar aldrig fokus');
    await page.click('.wbh-card .wbh-btn.is-primary');
    const saved = await page.evaluate((a) => ({ ls: JSON.parse(localStorage.getItem('wb:grants') ?? '{}')[a], ev: (window as any).__grants }), id);
    assert.deepEqual(saved, { ls: ['microphone'], ev: [id] });
    await page.waitForFunction(() => document.querySelectorAll('.wbh-card').length === 0);
    await page.evaluate((a) => {
      const w = (window as any).__wb;
      w.store.receive({ t: 'app', app: { ...w.store.apps.get(a), permissions: ['microphone', 'camera'] } });
    }, id);
    await page.waitForSelector('.wbh-card');
    assert.equal(await page.evaluate(() => document.querySelector('.wbh-card-title')!.textContent), 'Diktering vill använda kameran');
    await page.click('.wbh-card .wbh-btn:not(.is-primary)');
    await page.evaluate((a) => (window as any).__wb.bus.emit('hud:close', { appId: a }), id);
    await sleep(450);
    await openHud(id);
    assert.equal(await page.evaluate(() => document.querySelectorAll('.wbh-card').length), 0);
    assert.deepEqual(await page.evaluate((a) => JSON.parse(localStorage.getItem('wb:grants') ?? '{}')[a], id), ['microphone'], 'Neka ger ingenting');
  });

  test('automatik: när appen börjar vänta öppnar HUD:en sig, och frågekortet tar fokus i en tom inmatning', async () => {
    await clearApps();
    const id = await newApp(-520, -260);
    await openHud(id);
    await page.keyboard.type('Läs dokumentationen men fråga först');
    await page.keyboard.press('Enter');
    await page.evaluate((a) => (window as any).__wb.bus.emit('hud:close', { appId: a }), id);
    await waitClosed(id);
    await page.waitForFunction((a) => !!document.querySelector(`.wbh[data-app="${a}"]:not([hidden])`), id, { timeout: 15_000 });
    await page.waitForSelector('.wbh-card');
    await sleep(200);
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Tillåt');
    assert.equal(await page.evaluate(() => document.querySelector('.wbh-card-title')!.textContent), 'Hämta från nätet?');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => !document.querySelector('.wbh-card'), null, { timeout: 5000 });
    await page.waitForFunction((a) => (window as any).__wb.store.apps.get(a)?.status === 'idle', id, { timeout: 20_000 });
    const answer = await page.evaluate((a) => ((window as any).__wb.store.chats.get(a) ?? []).filter((e: any) => e.k === 'ask-done').map((e: any) => e.decision), id);
    assert.deepEqual(answer, ['allow']);
  });

  test('defaultNo: Neka har fokus och Enter godkänner aldrig (kontroll: utan defaultNo godkänner Enter)', async () => {
    await clearApps();
    const id = await newApp(-520, -260);
    await openHud(id);
    const ask = (askId: string, defaultNo: boolean) =>
      page.evaluate(([a, q, d]) => {
        const w = (window as any).__wb;
        (window as any).__sent = [];
        if (!(window as any).__spy) {
          const orig = w.store.send.bind(w.store);
          (window as any).__origSend = w.store.send;
          w.store.send = (m: any) => {
            if (m.t === 'chat.answer') {
              (window as any).__sent.push(m.decision);
              return true; // frågan finns bara i klienten; servern ska inte få svaret
            }
            return orig(m);
          };
          (window as any).__spy = true;
        }
        w.store.receive({ t: 'app', app: { ...w.store.apps.get(a), status: 'waiting' } });
        w.store.receive({ t: 'chat', appId: a, ev: { k: 'ask', id: q, at: Date.now(), ask: { kind: 'permission', tool: 'Bash', title: 'Köra ett kommando?', detail: 'rm -rf data', canRemember: true, defaultNo: d } } });
      }, [id, askId, defaultNo] as const);
    // Kontroll: utan defaultNo har Tillåt fokus och Enter godkänner.
    await ask('dn-1', false);
    await page.waitForSelector('.wbh-card');
    await sleep(150);
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Tillåt');
    await page.keyboard.press('Enter');
    assert.deepEqual(await page.evaluate(() => (window as any).__sent), ['allow']);
    await page.evaluate((a) => (window as any).__wb.store.receive({ t: 'chat', appId: a, ev: { k: 'ask-done', id: 'dn-1', decision: 'allow' } }), id);
    await page.waitForFunction(() => !document.querySelector('.wbh-card'));
    // defaultNo: Neka har fokus; Enter på Tillåt eller Alltid gör ingenting.
    await ask('dn-2', true);
    await page.waitForSelector('.wbh-card');
    await sleep(150);
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Neka');
    for (const label of ['Tillåt', 'Alltid']) {
      await page.evaluate((l) => [...document.querySelectorAll<HTMLButtonElement>('.wbh-card button')].find((b) => b.textContent === l)!.focus(), label);
      await page.keyboard.press('Enter');
    }
    assert.deepEqual(await page.evaluate(() => (window as any).__sent), [], 'Enter godkänner aldrig');
    await page.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>('.wbh-card button')].find((b) => b.textContent === 'Neka')!.focus());
    await page.keyboard.press('Enter');
    assert.deepEqual(await page.evaluate(() => (window as any).__sent), ['deny']);
    await page.evaluate((a) => {
      const w = (window as any).__wb;
      w.store.receive({ t: 'chat', appId: a, ev: { k: 'ask-done', id: 'dn-2', decision: 'deny' } });
      w.store.receive({ t: 'app', app: { ...w.store.apps.get(a), status: 'idle' } });
      // Spionen bort: nästa test ska prata med servern på riktigt.
      w.store.send = (window as any).__origSend;
      (window as any).__spy = false;
    }, id);
  });

  test('Esc med en halvskriven beskrivning behåller fyrkanten och utkastet (kalibrerat: tom inmatning tar bort)', async () => {
    await clearApps();
    const a = await drawApp(200, 160, 640, 460);
    await page.keyboard.type('en budgetapp med kategorier');
    await page.keyboard.press('Escape');
    await waitClosed();
    await sleep(900);
    assert.ok((await appIds()).includes(a), 'fyrkanten finns kvar');
    await openHud(a);
    assert.equal(await page.evaluate((s) => (document.querySelector(s) as HTMLTextAreaElement).value, H(a, '.wbh-input')), 'en budgetapp med kategorier');
    await page.evaluate((s) => {
      const i = document.querySelector(s) as HTMLTextAreaElement;
      i.value = '';
      i.dispatchEvent(new Event('input'));
    }, H(a, '.wbh-input'));
    await page.evaluate((x) => (window as any).__wb.bus.emit('hud:close', { appId: x }), a);
    await sleep(400);
    // Kalibrering: samma ritning med tom inmatning (utanför den kvarvarande fyrkanten) tas bort av Esc.
    const b = await drawApp(760, 160, 1200, 460);
    await page.keyboard.press('Escape');
    await page.waitForFunction((x) => !(window as any).__wb.store.apps.has(x), b, { timeout: 5000 });
  });

  test('omladdning av sidan: HUD:en öppnas igen för samma app med utkastet (kalibrerat: utan sparat tillstånd stängd)', async () => {
    await clearApps();
    const id = await newApp(-560, -280);
    await openHud(id);
    await page.keyboard.type('ett halvskrivet meddelande');
    const reload = async () => {
      await page.reload({ waitUntil: 'load' });
      await page.waitForFunction(() => (window as any).__wb?.store?.connected === true, null, { timeout: 60_000 });
      await sleep(700);
    };
    await reload();
    assert.equal(await hudOpenFor(), id);
    assert.equal(await page.evaluate((s) => (document.querySelector(s) as HTMLTextAreaElement).value, H(id, '.wbh-input')), 'ett halvskrivet meddelande');
    assert.equal(await focusedHud(), id, 'fokus i just den HUD:ens inmatning');
    assert.equal(await page.evaluate(() => !!document.activeElement?.classList.contains('wbh-input')), true);
    // Kalibrering: utan det sparade tillståndet är HUD:en stängd efter omladdningen (beteendet före rättelsen).
    await page.evaluate(() => sessionStorage.removeItem('wb.hud'));
    await reload();
    assert.equal(await hudOpenFor(), null);
  });

  test('hemligheten: skickas i chat.answer, lämnar DOM:en direkt och hamnar bara i data/secrets.json', async () => {
    await clearApps();
    const secret = `s3kret-${Math.random().toString(36).slice(2, 10)}`;
    const id = await newApp(-560, -280);
    await openHud(id);
    await page.keyboard.type('En hemlig nyckel behövs');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.wbh-secret', { timeout: 20_000 });
    await page.click('.wbh-secret');
    await page.keyboard.type(secret);
    // Kalibrering: medan värdet står i fältet hittar sökningen det.
    const findIt = (s: string) =>
      page.evaluate((v) => {
        const inDom = document.documentElement.outerHTML.includes(v);
        const inFields = [...document.querySelectorAll('input, textarea')].some((f) => (f as HTMLInputElement).value.includes(v));
        return inDom || inFields;
      }, s);
    assert.equal(await findIt(secret), true, 'detektorn ser värdet i fältet');
    await page.click('.wbh-card .wbh-btn.is-primary');
    assert.equal(await findIt(secret), false, 'borta ur DOM:en direkt efter Spara');
    await page.waitForFunction((a) => (window as any).__wb.store.apps.get(a)?.status === 'idle', id, { timeout: 20_000 });
    const stored = JSON.parse(fs.readFileSync(path.join(home, 'apps', id, 'data', 'secrets.json'), 'utf8'));
    assert.equal(stored.api_nyckel, secret, 'request_secret skrev värdet');
    const chat = fs.readFileSync(path.join(home, 'data', 'apps', id, 'chat.jsonl'), 'utf8');
    assert.ok(!chat.includes(secret), 'inte i chatthistoriken');
    assert.ok(!serverLog.includes(secret), 'inte i serverns logg');
    assert.equal(await findIt(secret), false);
    // Det besvarade kortet släppte fokus till body (Spara stängdes av); när kortet gått ligger fokus i inmatningen.
    await page.waitForFunction(() => !document.querySelector('.wbh-card'), null, { timeout: 5_000 });
    assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('wbh-input') ?? false), true, 'fokus i inmatningen efter svaret');
  });
  /* ------------------------------ flera HUD:ar (§13) ------------------------------ */

  const panelRect = (id: string) =>
    page.evaluate((s) => {
      const r = document.querySelector(s)!.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    }, H(id, '.wbh-panel'));
  const overlaps = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
    Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 0.5 && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 0.5;
  const zOf = (id: string) => page.evaluate((s) => Number(getComputedStyle(document.querySelector(s)!).zIndex) || 0, H(id));
  const inputOf = (id: string) => page.evaluate((s) => (document.querySelector(s) as HTMLTextAreaElement | null)?.value ?? null, H(id, '.wbh-input'));
  /** Animationer som går under appens HUD i aktivitetsradens halo och kantljuset. */
  const breathing = (id: string) =>
    page.evaluate((s) => {
      const el = document.querySelector(s);
      if (!el) return { running: -1, start: null as number | null, sweep: '', sweepStart: [] as number[] };
      const anims = [...el.querySelectorAll('.wbh-act-halo, .wbh-rim > i')].flatMap((e) => e.getAnimations()).filter((a) => a.playState === 'running');
      const halo = el.querySelector('.wbh-act-halo')?.getAnimations()[0];
      const sweep = el.querySelector('.wbh-act-sweep');
      // Svepets CSS-animationer (ljuset och kopian): på dokumentets tidslinje från 0, samma fas på varje rad (§14).
      const sweepStart = [...el.querySelectorAll('.wbh-act-sweep')].flatMap((e) => e.getAnimations({ subtree: true })).map((a) => (a.startTime === null ? -1 : Number(a.startTime)));
      return { running: anims.length, start: halo ? Number(halo.startTime) : null, sweep: sweep ? getComputedStyle(sweep).display : 'saknas', sweepStart };
    }, H(id));
  const building = (id: string, label: string) =>
    page.evaluate(([a, l]) => {
      const w = (window as any).__wb;
      const now = Date.now();
      w.store.receive({ t: 'app', app: { ...w.store.apps.get(a), status: 'building' } });
      w.store.receive({ t: 'chat', appId: a, ev: { k: 'turn', phase: 'start', at: now } });
      w.store.receive({ t: 'chat', appId: a, ev: { k: 'tool', id: `t-${now}`, name: 'Write', label: l, at: now + 1 } });
    }, [id, label] as const);
  const idle = (id: string) =>
    page.evaluate((a) => {
      const w = (window as any).__wb;
      w.store.receive({ t: 'chat', appId: a, ev: { k: 'turn', phase: 'end', ok: true, at: Date.now() + 5 } });
      w.store.receive({ t: 'app', app: { ...w.store.apps.get(a), status: 'idle' } });
    }, id);

  test('B1 två HUD:ar samtidigt: båda öppna, den nya aktiv överst, den andra lugn och stilla, globala rader bara i den aktiva', async () => {
    await clearApps();
    const a = await newApp(-660, -300);
    const b = await newApp(260, -300);
    await openHud(a);
    // Kalibrering av andningskontrollen: medan A är aktiv och bygger går andningen, på prickens tidslinje.
    await building(a, 'Skriver index.html');
    await sleep(300);
    const on = await breathing(a);
    assert.ok(on.running >= 3, `andningen går i den aktiva (${on.running})`);
    assert.equal(on.start, 0);
    assert.ok(on.sweepStart.length > 0 && on.sweepStart.every((t) => t === 0), `kalibrering: svepet går från 0 i den aktiva (${on.sweepStart})`);
    await openHud(b);
    assert.deepEqual(await openApps(), [a, b], 'båda öppna, i öppningsordning');
    assert.equal(await hudOpenFor(), b);
    assert.equal(await focusedHud(), b, 'fokus i den nya');
    const cls = await page.evaluate(([x, y]) => ({
      aActive: document.querySelector(x)!.classList.contains('is-active'),
      aCalm: document.querySelector(`${x} .wbh-panel`)!.classList.contains('is-calm'),
      bCalm: document.querySelector(`${y} .wbh-panel`)!.classList.contains('is-calm'),
    }), [H(a), H(b)] as const);
    assert.deepEqual(cls, { aActive: false, aCalm: true, bCalm: false });
    assert.ok((await zOf(b)) > (await zOf(a)), 'den aktiva överst');
    const ra = await panelRect(a);
    assert.ok(overlaps(ra, ra), 'kalibrering: en rektangel överlappar sig själv');
    assert.equal(overlaps(ra, await panelRect(b)), false, 'panelerna överlappar inte');
    await sleep(300);
    const calm = await breathing(a);
    assert.equal(calm.running, 0, 'ingen andning i den lugna');
    assert.equal(calm.sweep, 'none', 'inget svep i den lugna');
    await page.evaluate(() => (window as any).__wb.store.receive({ t: 'limits', fiveHour: 0.85, sevenDay: 0.1 }));
    await sleep(200);
    const quota = await page.evaluate(([x, y]) => [x, y].map((s) => [...document.querySelectorAll(`${s} .wbh-line`)].map((e) => e.textContent)), [H(a), H(b)] as const);
    assert.deepEqual(quota[0], [], 'kvoten inte i den lugna');
    assert.equal(quota[1].length, 1, 'kvoten i den aktiva');
    // Klick i A: A aktiv, andningen igen på samma tidslinje.
    await page.click(H(a, '.wbh-input'));
    await sleep(300);
    const again = await breathing(a);
    assert.ok(again.running >= 3, 'andningen igen när A blir aktiv');
    assert.equal(again.start, 0, 'i fas med appens prick');
    // Svepet var dolt i den lugna panelen: när det kommer tillbaka står det i samma fas som på varje rad (startTime 0),
    // så att ljuset inte hoppar när nästa etikett kommer (§14).
    assert.ok(again.sweepStart.length > 0 && again.sweepStart.every((t) => t === 0), `svepet i fas igen, inte omstartat (${again.sweepStart})`);
    await idle(a);
    await page.evaluate(() => (window as any).__wb.store.receive({ t: 'limits', fiveHour: 0.1, sevenDay: 0.1 }));
  });

  test('B2 Esc stänger den aktiva, sedan den som senast var aktiv; apparna står kvar', async () => {
    await clearApps();
    const a = await newApp(-660, -300);
    const b = await newApp(-60, -300);
    const c = await newApp(-660, 120);
    await openHud(a);
    await openHud(b);
    await openHud(c);
    assert.deepEqual(await openApps(), [a, b, c]);
    await page.click(H(a, '.wbh-input'));
    assert.equal(await hudOpenFor(), a);
    await page.keyboard.press('Escape');
    await waitClosed(a);
    assert.equal(await hudOpenFor(), c);
    assert.equal(await focusedHud(), c, 'fokus till nästa');
    await page.keyboard.press('Escape');
    await waitClosed(c);
    assert.equal(await hudOpenFor(), b);
    await page.keyboard.press('Escape');
    await waitClosed(b);
    assert.equal(await hudOpenFor(), null);
    assert.deepEqual(await openApps(), []);
    await sleep(300);
    const ids = await appIds();
    for (const x of [a, b, c]) assert.ok(ids.includes(x), 'appen finns kvar');
  });

  test('B3 tryck stänger den aktiva, ritande stänger ingen; inga tecken hamnar i den gamla medan man ritar', async () => {
    await clearApps();
    const a = await newApp(150, -320);
    await openHud(a);
    assert.equal(await focusedHud(), a);
    // Rita med A öppen: tecken medan knappen hålls och direkt efter släppet hamnar aldrig i A.
    await page.mouse.move(60, 520);
    await page.mouse.down();
    await page.keyboard.type('ab');
    for (let i = 1; i <= 14; i++) await page.mouse.move(60 + (400 * i) / 14, 520 + (320 * i) / 14);
    await page.mouse.up();
    await page.keyboard.type('cd');
    await page.waitForFunction((x) => (window as any).__wb.store.apps.size === 2 && (window as any).__wb.world.debug.hudApp() !== x, a, { timeout: 5000 });
    await sleep(700);
    const n = (await appIds()).find((x) => x !== a) as string;
    assert.deepEqual(await openApps(), [a, n], 'A står kvar när N ritas');
    assert.equal(await hudOpenFor(), n);
    assert.equal(await inputOf(a), '', 'inget i A');
    assert.equal(await inputOf(n), 'cd', 'tecknen efter släppet i N');
    // Tryck på tom yta: bara N stängs, A blir aktiv och får fokus.
    await page.mouse.click(1200, 820);
    await waitClosed(n);
    assert.deepEqual(await openApps(), [a]);
    assert.equal(await hudOpenFor(), a);
    assert.equal(await focusedHud(), a);
    // Ett kort drag (mindre än 120×80) på tom yta stänger ingen.
    await page.mouse.move(1250, 700);
    await page.mouse.down();
    await page.mouse.move(1300, 730, { steps: 6 });
    await page.mouse.up();
    await sleep(500);
    assert.deepEqual(await openApps(), [a], 'ett drag stänger ingen');
    // Kalibrering: utan skölden (drag som världen inte ser) hamnar tecknen i A.
    await page.mouse.move(1250, 600);
    await page.mouse.down();
    await page.evaluate(() => document.documentElement.classList.remove('wb-dragging'));
    await page.keyboard.type('xy');
    const leaked = await inputOf(a);
    await page.mouse.up();
    assert.equal(leaked, 'xy', 'kalibrering: den planterade läckan syns');
  });

  test('B4 klick gör en HUD aktiv och ger appen fokus; ⌘K gäller den HUD man skriver i', async () => {
    await clearApps();
    const a = await newApp(-660, -300);
    const b = await newApp(-60, -300);
    const c = await newApp(-660, 120);
    await openHud(a);
    await openHud(b);
    assert.equal(await hudOpenFor(), b);
    // C i fokus (klick på fröytan), sedan tillbaka in i A.
    const rc = await page.evaluate((x) => (window as any).__wb.world.screenRectOf(x), c);
    await page.mouse.click(rc.x + rc.w / 2, rc.y + rc.h / 2);
    await sleep(200);
    assert.equal(await page.evaluate(() => (window as any).__wb.world.debug.focused()), c, 'kalibrering: C i fokus');
    await page.click(H(a, '.wbh-input'));
    assert.equal(await hudOpenFor(), a);
    assert.ok((await zOf(a)) > (await zOf(b)), 'A överst');
    assert.equal(await page.evaluate(() => (window as any).__wb.world.debug.focused()), a, 'A:s app i fokus');
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.type('x');
    assert.equal(await inputOf(a), 'x', 'skriv var som helst hamnar i den aktiva');
    assert.equal(await inputOf(b), '');
    await page.keyboard.press('Meta+KeyK');
    await waitClosed(a);
    assert.deepEqual(await openApps(), [b], '⌘K stängde A och öppnade inte C');
    assert.equal(await hudOpenFor(), b);
  });

  test('B5 automatiken öppnar bakom den aktiva utan att ta fokus; Esc ger den väntande, med fokus i inmatningen', async () => {
    await clearApps();
    const a = await newApp(-660, -300);
    const b = await newApp(-60, -300);
    await openHud(a);
    await page.keyboard.type('Läs dokumentationen men fråga först');
    await page.keyboard.press('Enter');
    await page.evaluate((x) => (window as any).__wb.bus.emit('hud:close', { appId: x }), a);
    await waitClosed(a);
    await openHud(b);
    await page.keyboard.type('hej');
    await page.waitForFunction((s) => !!document.querySelector(s), H(a, '.wbh-card'), { timeout: 15_000 });
    await sleep(300);
    assert.deepEqual(await openApps(), [b, a]);
    assert.equal(await hudOpenFor(), b, 'den väntande blev inte aktiv');
    assert.equal(await focusedHud(), b, 'fokus kvar i B');
    assert.equal(await inputOf(b), 'hej');
    assert.equal(await page.evaluate(() => !!document.activeElement?.closest('.wbh-card')), false, 'kortet tog inte fokus');
    assert.equal(await page.evaluate((s) => document.querySelector(s)!.classList.contains('is-calm'), H(a, '.wbh-panel')), true, 'den som öppnades bakom är lugn');
    // Kalibrering: hud:open med pricken flyttar fokus.
    await page.evaluate((x) => (window as any).__wb.bus.emit('hud:open', { appId: x, reason: 'dot' }), a);
    await sleep(150);
    assert.equal(await focusedHud(), a, 'kalibrering: pricken flyttar fokus');
    await page.click(H(b, '.wbh-input'));
    assert.equal(await hudOpenFor(), b);
    await page.keyboard.press('Escape');
    await waitClosed(b);
    assert.equal(await hudOpenFor(), a);
    assert.equal(await page.evaluate(() => !!document.activeElement?.classList.contains('wbh-input') && (document.activeElement?.closest('.wbh') as HTMLElement).dataset.app), a, 'fokus i A:s inmatning, inte kortet');
    await page.click(H(a, '.wbh-card .wbh-btn.is-primary'));
    await page.waitForFunction((x) => (window as any).__wb.store.apps.get(x)?.status === 'idle', a, { timeout: 20_000 });
  });

  test('B6 omladdning med två HUD:ar: samma ordning, samma aktiva, utkasten och sidorna; pricken och trycket fungerar efteråt (kalibrerat)', async () => {
    await clearApps();
    const a = await newApp(-660, -300);
    const b = await newApp(-60, -300);
    await openHud(a);
    await page.keyboard.type('utkast A');
    await openHud(b);
    await page.keyboard.type('utkast B');
    await page.click(H(a, '.wbh-input'));
    assert.equal(await hudOpenFor(), a);
    await sleep(500);
    const before = { a: await panelRect(a), b: await panelRect(b) };
    const reload = async () => {
      await page.reload({ waitUntil: 'load' });
      await page.waitForFunction(() => (window as any).__wb?.store?.connected === true, null, { timeout: 60_000 });
    };
    await reload();
    // Sidorna står kvar medan historiken läses in.
    const sides = await page.evaluate(async ([x, y]) => {
      const seen = new Set<string>();
      const t0 = performance.now();
      while (performance.now() - t0 < 1500) {
        for (const s of [x, y]) seen.add(`${s}=${(document.querySelector(s) as HTMLElement | null)?.dataset.side ?? '-'}`);
        await new Promise((r) => requestAnimationFrame(r));
      }
      return [...seen];
    }, [H(a), H(b)] as const);
    assert.deepEqual(await openApps(), [a, b], 'samma ordning');
    assert.equal(await hudOpenFor(), a, 'samma aktiva');
    assert.equal(await focusedHud(), a, 'fokus i den aktiva');
    assert.equal(await inputOf(a), 'utkast A');
    assert.equal(await inputOf(b), 'utkast B');
    const calm = await page.evaluate(([x, y]) => [x, y].map((s) => document.querySelector(s)!.classList.contains('is-calm')), [H(a, '.wbh-panel'), H(b, '.wbh-panel')] as const);
    assert.deepEqual(calm, [false, true], 'efter omladdningen är den aktiva klar och den andra lugn');
    assert.equal(sides.filter((x) => !x.endsWith('=-')).length, 2, `en sida per HUD hela tiden: ${sides.join(', ')}`);
    const after = { a: await panelRect(a), b: await panelRect(b) };
    for (const k of ['a', 'b'] as const) {
      assert.ok(Math.abs(after[k].x - before[k].x) <= 1 && Math.abs(after[k].y - before[k].y) <= 1, `${k} på samma plats`);
    }
    // Världen vet efter omladdningen: pricken stänger A (i stället för att öppna), trycket stänger den aktiva.
    const dot = await page.evaluate((x) => (window as any).__wb.world.dotOf(x), a);
    await page.mouse.move(dot.x - 40, dot.y - 40);
    await page.mouse.move(dot.x, dot.y, { steps: 6 });
    await page.mouse.down();
    await page.mouse.up();
    await waitClosed(a);
    assert.deepEqual(await openApps(), [b]);
    await page.mouse.click(1300, 840);
    await waitClosed(b);
    // Kalibrering: ett sparat värde i den äldre formen (en enda app) ger bara den HUD:en.
    await page.evaluate((x) => sessionStorage.setItem('wb.hud', JSON.stringify({ app: x, reason: 'dot', sent: false, drafts: {} })), b);
    await reload();
    await sleep(700);
    assert.deepEqual(await openApps(), [b], 'den äldre formen läses som en HUD');
  });

  test('ta bort en app vars HUD är öppen medan en annan är aktiv: bara dess HUD försvinner', async () => {
    await clearApps();
    const a = await newApp(-660, -300);
    const b = await newApp(-60, -300);
    await openHud(a);
    await openHud(b);
    assert.deepEqual(await openApps(), [a, b], 'kalibrering: båda öppna innan A tas bort');
    await page.evaluate((x) => (window as any).__wb.store.deleteApp(x), a);
    await waitClosed(a);
    assert.deepEqual(await openApps(), [b]);
    assert.equal(await hudOpenFor(), b);
    assert.equal(await focusedHud(), b);
  });
  test('B7 bara den aktiva spelar in, och svaret på inspelningen går till HUD:en som spelade in även om en annan blivit aktiv', async () => {
    await clearApps();
    const a = await newApp(-660, -300);
    const b = await newApp(-60, -300);
    await openHud(a);
    await openHud(b);
    await page.click(H(a, '.wbh-input'));
    assert.equal(await hudOpenFor(), a);
    const mic = await page.evaluate((s) => {
      const r = document.querySelector(s)!.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }, H(b, '.wbh-mic'));
    // Håll B:s mikrofon: B blir aktiv och bara B spelar in.
    await page.mouse.move(mic.x, mic.y, { steps: 6 });
    await page.mouse.down();
    await page.waitForFunction((s) => document.querySelector(s)?.getAttribute('aria-pressed') === 'true', H(b, '.wbh-mic'), { timeout: 8000 });
    assert.equal(await hudOpenFor(), b, 'B blev aktiv');
    const rec = await page.evaluate(([x, y]) => [x, y].map((s) => document.querySelector(s)!.classList.contains('is-rec')), [H(a, '.wbh-mic'), H(b, '.wbh-mic')] as const);
    assert.deepEqual(rec, [false, true], 'bara B spelar in');
    // A blir aktiv medan B fortfarande spelar in (fokus flyttas dit). Inspelningen hör fortfarande till B.
    await page.evaluate((s) => (document.querySelector(s) as HTMLTextAreaElement).focus(), H(a, '.wbh-input'));
    assert.equal(await hudOpenFor(), a);
    await sleep(700);
    await page.mouse.up();
    // WORKBENCH_STT=off: inspelningen ger ett fel ("Hörde inget" eller "Kunde inte tolka talet"), och raden hamnar i B.
    await page.waitForFunction(([x, y]) => document.querySelectorAll(x).length + document.querySelectorAll(y).length > 0, [H(a, '.wbh-line'), H(b, '.wbh-line')] as const, { timeout: 15_000 });
    await sleep(200);
    const lines = await page.evaluate(([x, y]) => [x, y].map((s) => [...document.querySelectorAll(s)].map((e) => e.textContent)), [H(a, '.wbh-line'), H(b, '.wbh-line')] as const);
    assert.deepEqual(lines[0], [], `inget i A: ${JSON.stringify(lines)}`);
    assert.equal(lines[1].length, 1, `raden i B: ${JSON.stringify(lines)}`);
  });
  test('B8 pricken stänger en HUD som inte är aktiv utan att ta fokus: mellanslaget blir tryck-och-prata i den aktiva och öppnar inte den stängda igen (kalibrerat)', async () => {
    await clearApps();
    const a = await newApp(-660, -300);
    const b = await newApp(-60, -300);
    await openHud(a);
    await openHud(b);
    assert.equal(await focusedHud(), b);
    const clickDot = async (id: string) => {
      const d = await page.evaluate((x) => (window as any).__wb.world.dotOf(x) as { x: number; y: number }, id);
      await page.mouse.move(d.x, d.y, { steps: 8 });
      await page.mouse.down();
      await page.mouse.up();
      await sleep(450);
    };
    const holdSpace = async () => {
      await page.keyboard.down(' ');
      await sleep(700);
      const rec = await page.evaluate((s) => document.querySelector(s)?.classList.contains('is-rec') ?? null, H(b, '.wbh-mic'));
      await page.keyboard.up(' ');
      await sleep(600);
      return rec;
    };
    // Kalibrering: med en planterad prick som tar fokus vid mousedown (som före rättningen) öppnar mellanslaget A igen.
    await page.evaluate(() => {
      const w = window as any;
      w.__plantDot = (e: MouseEvent) => {
        const d = e.target instanceof Element ? (e.target.closest('.wb-dot') as HTMLElement | null) : null;
        if (d) d.focus();
      };
      document.addEventListener('mousedown', w.__plantDot, true);
    });
    await clickDot(a);
    assert.deepEqual(await openApps(), [b], 'kalibrering: pricken stängde A');
    await holdSpace();
    assert.ok((await openApps()).includes(a), 'kalibrering: den planterade pricken med fokus öppnar A igen med mellanslaget');
    await page.evaluate(() => document.removeEventListener('mousedown', (window as any).__plantDot, true));
    await page.evaluate((x) => (window as any).__wb.bus.emit('hud:close', { appId: x }), a);
    await waitClosed(a);
    // På riktigt: A öppen men inte aktiv, B aktiv med fokus.
    await openHud(a);
    await page.click(H(b, '.wbh-input'));
    assert.equal(await hudOpenFor(), b);
    await clickDot(a);
    assert.deepEqual(await openApps(), [b], 'pricken stängde A');
    assert.equal(await focusedHud(), b, 'fokus låg kvar i B');
    const rec = await holdSpace();
    assert.equal(rec, true, 'mellanslaget blev tryck-och-prata i B');
    assert.deepEqual(await openApps(), [b], 'A öppnades inte igen');
    assert.equal(await hudOpenFor(), b);
  });

  /* ------------------------------ fältets röst och det hållna mellanslaget (§10.9, §12) ------------------------------ */

  // Håll mellanslag på tom yta utan öppen HUD. Mikrofonen är Chromes låtsasmikrofon (som i B7); tal till text svarar
  // sidan själv (page.route), eftersom servern körs med WORKBENCH_STT=off.
  const fieldNow = () =>
    page.evaluate(() => {
      const f = document.querySelector('.wbf') as HTMLElement | null;
      const led = document.querySelector('.wbf-led') as HTMLElement | null;
      const card = document.querySelector('.wbf-card') as HTMLElement | null;
      return {
        open: !!f && !f.hidden,
        listening: !!f?.classList.contains('is-listening'),
        led: !!led && !led.hidden,
        value: (document.querySelector('.wbf-input') as HTMLInputElement | null)?.value ?? '',
        card: card && !card.hidden ? card.textContent : null,
      };
    });
  /** Fältet spelar in: LED:en lyser, och med heard följer skenet ljudet (inspelningen har börjat, inte bara mikrofonen). */
  const fieldListening = (heard: boolean) =>
    page.waitForFunction((h) => {
      const led = document.querySelector('.wbf-led') as HTMLElement | null;
      return !!document.querySelector('.wbf.is-listening') && (!h || Number(led?.style.getPropertyValue('--lvl') || 0) > 0);
    }, heard, { timeout: 8000 });
  const fieldCard = () =>
    page.waitForFunction(() => {
      const c = document.querySelector('.wbf-card') as HTMLElement | null;
      return !!c && !c.hidden;
    }, null, { timeout: 15_000 });
  /** Svaret från tal till text (null ger 503, som när ingen metod fungerar) och antalet anrop. */
  const stt = { text: null as string | null, calls: 0 };
  const routeStt = () =>
    page.route('**/api/stt', (route) => {
      stt.calls++;
      return stt.text === null
        ? route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"stt"}' })
        : route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ text: stt.text, provider: 'whisper' }) });
    });
  /** getUserMedia som dröjer (som när webbläsaren frågar om mikrofonen). Strömmarna sparas i __mics. */
  const slowMic = (ms: number) =>
    page.evaluate((delay) => {
      const w = window as any;
      w.__gum ??= navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      w.__mics = [];
      navigator.mediaDevices.getUserMedia = async (c?: MediaStreamConstraints) => {
        if (delay) await new Promise((r) => setTimeout(r, delay));
        const s: MediaStream = await w.__gum(c);
        w.__mics.push(s);
        return s;
      };
    }, ms);
  /** Spåren i strömmarna sedan slowMic: 'live' eller 'ended'. */
  const micTracks = () => page.evaluate(() => ((window as any).__mics as MediaStream[]).flatMap((s) => s.getTracks().map((t) => t.readyState)));
  /** Uppläsningen i en låtsasröst (Chrome utan skärm har ingen svensk röst): texterna hamnar i __spoken. */
  const fakeSpeech = () =>
    page.evaluate(() => {
      const w = window as any;
      w.__spoken = [];
      w.__Utterance ??= w.SpeechSynthesisUtterance;
      speechSynthesis.getVoices = () => [{ name: 'Alva', lang: 'sv-SE', localService: true, default: false, voiceURI: 'Alva' }] as unknown as SpeechSynthesisVoice[];
      w.SpeechSynthesisUtterance = class {
        text: string;
        voice: unknown = null;
        lang = '';
        rate = 1;
        constructor(t: string) {
          this.text = t;
        }
      };
      speechSynthesis.speak = (u: SpeechSynthesisUtterance) => void w.__spoken.push(u.text);
    });
  /** Fokus lämnar skalets fönster en stund (som när en app eller webbläsarens fråga om mikrofonen tar det). */
  const windowBlur = () =>
    page.evaluate(async () => {
      const f = document.createElement('iframe');
      document.body.append(f);
      f.contentWindow!.focus();
      await new Promise((r) => setTimeout(r, 80));
      f.remove();
      window.focus();
    });
  /**
   * Planterat fel: fönstrets blur når aldrig skalets lyssnare. Vid fönstrets egen blur går Chrome i registreringsordning,
   * även för capture (uppmätt), så lyssnaren läggs i ett init-skript före skalets och slås på med __plantBlur.
   */
  async function armPlantBlur(): Promise<void> {
    await page.addInitScript(() => {
      addEventListener('blur', (e) => {
        if ((window as any).__plantBlur && e.target === window) e.stopImmediatePropagation();
      });
    });
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => (window as any).__wb?.store?.connected === true, null, { timeout: 60_000 });
  }
  const plantBlur = (on: boolean) => page.evaluate((x) => ((window as any).__plantBlur = x), on);
  const toShell = () => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
  async function restoreVoice(): Promise<void> {
    await page.unroute('**/api/stt');
    await page.evaluate(() => {
      const w = window as any;
      w.__plantBlur = false;
      delete (navigator.mediaDevices as any).getUserMedia;
      delete (speechSynthesis as any).getVoices;
      delete (speechSynthesis as any).speak;
      if (w.__Utterance) w.SpeechSynthesisUtterance = w.__Utterance;
    });
  }

  test('F1 håll mellanslag på tom yta utan öppen HUD: fältet spelar in, släppet skickar texten dit den passar och ett talat förslag läses upp; i det öppna fältet talar mellanslaget in igen och trycker aldrig på Bygg; ett kort tryck ändrar ingenting, och med en HUD öppen är mellanslaget som förut (kalibrerat)', async () => {
    await clearApps();
    await routeStt();
    await slowMic(0);
    await fakeSpeech();
    try {
      stt.text = 'dn.se';
      await toShell();
      // Håll: fältet öppnas tomt och spelar in. LED:en lyser, och skenet följer ljudet.
      await page.keyboard.down(' ');
      await fieldListening(true);
      const rec = await fieldNow();
      assert.deepEqual({ open: rec.open, led: rec.led, value: rec.value, card: rec.card }, { open: true, led: true, value: '', card: null }, `under inspelningen: ${JSON.stringify(rec)}`);
      assert.deepEqual(await micTracks(), ['live'], 'mikrofonen är öppen');
      await sleep(1000);
      await page.keyboard.up(' ');
      // Släppet: texten hamnar i fältet och går vidare som skriven text. Ingen app tar adressen, så låtsas-Claude föreslår en webbläsare.
      await fieldCard();
      const done = await fieldNow();
      assert.equal(stt.calls, 1, 'ett anrop till tal till text');
      assert.equal(done.value, 'dn.se', 'texten står i fältet');
      assert.equal(done.listening, false);
      assert.ok(done.card!.includes('Ingen app passar.') && done.card!.includes('https://dn.se/'), `förslaget: ${done.card}`);
      // Talat in: förslaget läses upp.
      await page.waitForFunction(() => (window as any).__spoken.length > 0, null, { timeout: 3000 });
      assert.deepEqual(await page.evaluate(() => (window as any).__spoken), ['En webbläsare som öppnar https://dn.se/']);
      // Bygg har fokus, så att Enter bygger. Ett kort tryck på mellanslag ändrar ingenting: Bygg trycks inte, och
      // förslaget och texten står kvar.
      assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Bygg');
      const apps0 = (await appIds()).length;
      await page.keyboard.press(' ');
      await sleep(900);
      const tap = await fieldNow();
      assert.equal((await appIds()).length, apps0, `ett kort tryck på förslaget trycker inte på Bygg: ${JSON.stringify(tap)}`);
      assert.deepEqual(tap, done, 'ett kort tryck på förslaget ändrar ingenting');
      assert.equal(stt.calls, 1, 'ett kort tryck tolkas inte');
      // Mellanslag som hålls på förslaget spelar in igen i stället för att trycka på Bygg, och det nya talet går vidare.
      stt.text = 'köp mjölk';
      await page.keyboard.down(' ');
      const heard = await fieldListening(true).then(() => true, () => false);
      await sleep(400);
      await page.keyboard.up(' ');
      await sleep(300);
      assert.equal((await appIds()).length, apps0, 'ett mellanslag som hålls på förslaget trycker inte på Bygg');
      assert.ok(heard, 'fältet spelade in igen');
      await page.waitForFunction(() => !!document.querySelector('.wbf-card:not([hidden])')?.textContent?.includes('köp mjölk'), null, { timeout: 15_000 });
      assert.equal(stt.calls, 2, 'det nya talet tolkades');
      assert.equal((await fieldNow()).value, 'köp mjölk', 'det nya talet ersatte texten');
      await page.waitForFunction(() => (window as any).__spoken.length > 1, null, { timeout: 3000 });
      assert.deepEqual(await page.evaluate(() => (window as any).__spoken.slice(1)), ['köp mjölk'], 'det nya förslaget läses upp');
      // Esc stänger fältet, och mikrofonen släpps direkt när ingen HUD är öppen.
      await page.keyboard.press('Escape');
      assert.equal((await fieldNow()).open, false);
      assert.deepEqual(await micTracks(), ['ended'], 'mikrofonen släpptes när fältet stängdes');
      // Kalibrering: samma text skriven och skickad med Enter ger samma förslag men läses inte upp.
      await toShell();
      await page.keyboard.type('dn.se');
      await page.keyboard.press('Enter');
      await fieldCard();
      assert.ok((await fieldNow()).card!.includes('https://dn.se/'), 'kalibrering: samma förslag');
      await sleep(300);
      assert.equal(await page.evaluate(() => (window as any).__spoken.length), 2, 'skriven text läses inte upp');
      // Inte heller på ett förslag till skriven text trycker mellanslaget på Bygg.
      const typed = await fieldNow();
      await page.keyboard.press(' ');
      await sleep(900);
      assert.equal((await appIds()).length, apps0, 'mellanslag på ett förslag till skriven text trycker inte på Bygg');
      assert.deepEqual(await fieldNow(), typed, 'ett kort tryck på ett förslag till skriven text ändrar ingenting');
      await page.keyboard.press('Escape');
      // Ett kort tryck på tom yta stänger bara fältet igen: inget kort, och inget går till tal till text.
      await toShell();
      await page.keyboard.press(' ');
      await sleep(900);
      const shut = await fieldNow();
      assert.deepEqual({ open: shut.open, card: shut.card }, { open: false, card: null }, `efter ett kort tryck: ${JSON.stringify(shut)}`);
      assert.equal(stt.calls, 2, 'ett kort tryck tolkas inte');
      // Ett fel (tal till text svarar 503) står i kortet med fokus i den tomma inmatningen. Där ändrar ett kort tryck
      // ingenting, och ett mellanslag som hålls talar in igen i stället för att skriva mellanslag.
      stt.text = null;
      await toShell();
      await page.keyboard.down(' ');
      await fieldListening(true);
      await sleep(600);
      await page.keyboard.up(' ');
      await fieldCard();
      const err = await fieldNow();
      assert.deepEqual({ value: err.value, card: err.card }, { value: '', card: 'Kunde inte tolka talet.' }, `felet: ${JSON.stringify(err)}`);
      assert.equal(await page.evaluate(() => document.activeElement?.className), 'wbf-input', 'fokus i fältet');
      await page.keyboard.press(' ');
      await sleep(900);
      assert.deepEqual(await fieldNow(), err, 'ett kort tryck i den tomma inmatningen ändrar ingenting');
      const calls = stt.calls;
      stt.text = 'dn.se';
      await page.keyboard.down(' ');
      const heard2 = await fieldListening(true).then(() => true, () => false);
      await sleep(400);
      const held = await fieldNow();
      await page.keyboard.up(' ');
      assert.equal(held.value, '', `mellanslaget skrev inget i fältet: ${JSON.stringify(held)}`);
      assert.ok(heard2, 'mellanslag i den tomma inmatningen talar in');
      await page.waitForFunction(() => !!document.querySelector('.wbf-card:not([hidden])')?.textContent?.includes('https://dn.se/'), null, { timeout: 15_000 });
      assert.equal(stt.calls, calls + 1, 'talet tolkades');
      assert.equal((await fieldNow()).value, 'dn.se');
      await page.keyboard.press('Escape');
      // Med en HUD öppen är mellanslaget tryck-och-prata i den aktiva HUD:en som förut, och fältet öppnas inte.
      const a = await newApp(-600, -300);
      await openHud(a);
      await toShell();
      await page.keyboard.down(' ');
      await page.waitForFunction((s) => !!document.querySelector(s)?.classList.contains('is-rec'), H(a, '.wbh-mic'), { timeout: 8000 });
      assert.equal((await fieldNow()).open, false, 'fältet öppnades inte med en HUD öppen');
      await sleep(700);
      stt.text = null;
      await page.keyboard.up(' ');
      // Tal till text svarar 503 (eller grinden hör inget): raden hamnar i HUD:en, och fältet står stängt.
      await page.waitForFunction((s) => !!document.querySelector(s), H(a, '.wbh-line'), { timeout: 15_000 });
      assert.equal((await fieldNow()).open, false);
    } finally {
      await restoreVoice();
    }
  });

  test('F2 fältets inspelning: blur stoppar den som ett släpp, en HUD som öppnas av sig själv avbryter den, och ett släpp som tappas eller Esc medan mikrofonen öppnas lämnar den aldrig på (kalibrerat)', async () => {
    await clearApps();
    await armPlantBlur();
    await routeStt();
    await slowMic(0);
    try {
      stt.text = 'köp mjölk';
      // Kalibrering: med en planterad lyssnare som stoppar fönstrets blur spelar fältet fortfarande in efter blur.
      await toShell();
      await plantBlur(true);
      await page.keyboard.down(' ');
      await fieldListening(true);
      await windowBlur();
      await sleep(700);
      const planted = await fieldNow();
      assert.equal(planted.listening, true, `kalibrering: utan blur spelar fältet fortfarande in (${JSON.stringify(planted)}, ${stt.calls} anrop)`);
      await plantBlur(false);
      await page.keyboard.up(' ');
      await fieldCard();
      await page.keyboard.press('Escape');
      // Blur under inspelningen stoppar den som ett släpp, fast mellanslaget fortfarande hålls: talet tolkas och går vidare.
      let calls = stt.calls;
      const apps0 = (await appIds()).length;
      await toShell();
      await page.keyboard.down(' ');
      await fieldListening(true);
      await sleep(600);
      await windowBlur();
      await fieldCard();
      assert.equal(stt.calls, calls + 1, 'inspelningen tolkades efter blur');
      assert.equal((await fieldNow()).value, 'köp mjölk');
      // Mellanslaget som fortfarande hålls (upprepningar) och släppet efteråt trycker inte på Bygg och spelar inte in igen.
      await page.keyboard.down(' ');
      await page.keyboard.down(' ');
      await page.keyboard.up(' ');
      await sleep(500);
      const kept = await fieldNow();
      assert.ok(kept.open && !!kept.card?.includes('Ingen app passar.'), `förslaget står kvar: ${JSON.stringify(kept)}`);
      assert.equal((await appIds()).length, apps0, 'Bygg trycktes inte');
      assert.equal(stt.calls, calls + 1, 'ingen ny inspelning');
      await page.keyboard.press('Escape');
      // En gömd flik (visibilitychange utan blur) stoppar inspelningen på samma sätt.
      calls = stt.calls;
      await toShell();
      await page.keyboard.down(' ');
      await fieldListening(true);
      await sleep(600);
      try {
        await page.evaluate(() => {
          Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
          document.dispatchEvent(new Event('visibilitychange'));
        });
        await sleep(300);
        assert.equal((await fieldNow()).listening, false, 'en gömd flik stoppade inspelningen');
        await fieldCard();
      } finally {
        await page.evaluate(() => delete (document as any).hidden);
      }
      assert.equal(stt.calls, calls + 1, 'inspelningen tolkades efter att fliken gömts');
      await page.keyboard.up(' ');
      await page.keyboard.press('Escape');
      // En HUD som öppnas av sig själv (automatiken, §13) avbryter inspelningen: fältet stängs, inget tolkas, och
      // mellanslaget som fortfarande hålls skriver inget i HUD:en. Appen är den i fokus (ett klick i fönstret), så att
      // HUD:en inte anropar world.focus när den tar fokus, och fältet inte stängs av app:focus.
      const a = await newApp(-600, -300);
      const r = await page.evaluate((id) => (window as any).__wb.world.screenRectOf(id), a);
      await page.mouse.move(r.x + r.w / 2 - 30, r.y + r.h / 2 - 30);
      await page.mouse.move(r.x + r.w / 2, r.y + r.h / 2, { steps: 6 });
      await page.mouse.down();
      await page.mouse.up();
      assert.equal(await page.evaluate(() => (window as any).__wb.world.debug.focused()), a, 'appen är den i fokus');
      calls = stt.calls;
      await toShell();
      await page.keyboard.down(' ');
      await fieldListening(true);
      await sleep(400);
      await page.evaluate((id) => {
        const w = (window as any).__wb;
        w.store.receive({ t: 'app', app: { ...w.store.apps.get(id), status: 'waiting' } });
      }, a);
      await page.waitForFunction((s) => !!document.querySelector(s), H(a), { timeout: 3000 });
      assert.equal((await fieldNow()).open, false, 'fältet stängdes när HUD:en öppnades');
      assert.equal(await focusedHud(), a, 'HUD:en har fokus');
      await page.keyboard.down(' ');
      await page.keyboard.down(' ');
      await page.keyboard.up(' ');
      await sleep(1200);
      assert.equal(stt.calls, calls, 'inspelningen avbröts: inget tolkades');
      assert.equal(await inputOf(a), '', 'mellanslaget skrev inget i HUD:en');
      await page.evaluate((id) => {
        const w = (window as any).__wb;
        w.store.receive({ t: 'app', app: { ...w.store.apps.get(id), status: 'idle' } });
        w.bus.emit('hud:close', { appId: id });
      }, a);
      await waitClosed(a);
      // Frågan om mikrofonen (getUserMedia som dröjer 900 ms): fönstret tappar fokus och släppet når inte sidan.
      // Kalibrering: utan blur börjar inspelningen när mikrofonen till slut kommer, och den står på.
      await slowMic(900);
      await plantBlur(true);
      await toShell();
      await page.keyboard.down(' ');
      await sleep(200);
      assert.equal((await fieldNow()).listening, true, 'LED:en lyser medan mikrofonen öppnas');
      await windowBlur();
      await sleep(1400);
      assert.equal((await fieldNow()).listening, true, 'kalibrering: utan blur spelar fältet in när mikrofonen kommer');
      await plantBlur(false);
      await page.keyboard.up(' ');
      await fieldCard();
      await page.keyboard.press('Escape');
      // På riktigt: ingen inspelning, fältet stängs igen, och mikrofonen släpps.
      calls = stt.calls;
      await slowMic(900);
      await toShell();
      await page.keyboard.down(' ');
      await sleep(200);
      await windowBlur();
      await sleep(1400);
      const lost = await fieldNow();
      assert.deepEqual({ open: lost.open, listening: lost.listening }, { open: false, listening: false }, `efter frågan: ${JSON.stringify(lost)}`);
      assert.deepEqual(await micTracks(), ['ended'], 'mikrofonen släpptes');
      await page.keyboard.up(' ');
      await sleep(300);
      assert.equal((await fieldNow()).open, false, 'släppet som till slut kommer gör ingenting');
      // Esc medan mikrofonen öppnas: fältet stängs, och mikrofonen som kommer efteråt stängs direkt.
      await slowMic(900);
      await toShell();
      await page.keyboard.down(' ');
      await sleep(200);
      await page.keyboard.press('Escape');
      await page.keyboard.up(' ');
      assert.equal((await fieldNow()).open, false);
      await sleep(1400);
      assert.deepEqual(await micTracks(), ['ended'], 'mikrofonen som kom efter Esc stängdes');
      assert.equal(stt.calls, calls, 'inget tolkades');
    } finally {
      await restoreVoice();
    }
  });

  test('mellanslaget som hålls i en HUD: ett frågekort som tar fokus under tiden godkänns inte av upprepningarna eller släppet, och släppet stoppar inspelningen även från mikrofonknappen (kalibrerat: ett nytt tryck godkänner)', async () => {
    await clearApps();
    const id = await newApp(-520, -260);
    await openHud(id);
    // Svaren fångas i klienten (frågorna finns bara där). Tal till text svarar 503 (WORKBENCH_STT=off).
    await page.evaluate(() => {
      const w = (window as any).__wb;
      const orig = w.store.send.bind(w.store);
      (window as any).__sent = [];
      (window as any).__origSend = w.store.send;
      w.store.send = (m: any) => {
        if (m.t !== 'chat.answer') return orig(m);
        (window as any).__sent.push(m.decision);
        return true;
      };
    });
    const ask = (askId: string) =>
      page.evaluate(([a, q]) => {
        const w = (window as any).__wb;
        w.store.receive({ t: 'app', app: { ...w.store.apps.get(a), status: 'waiting' } });
        w.store.receive({ t: 'chat', appId: a, ev: { k: 'ask', id: q, at: Date.now(), ask: { kind: 'permission', tool: 'Bash', title: 'Köra ett kommando?', detail: 'rm -rf data', canRemember: true, defaultNo: false } } });
      }, [id, askId] as const);
    const answered = (askId: string) =>
      page.evaluate(([a, q]) => {
        const w = (window as any).__wb;
        w.store.receive({ t: 'chat', appId: a, ev: { k: 'ask-done', id: q, decision: 'allow' } });
        w.store.receive({ t: 'app', app: { ...w.store.apps.get(a), status: 'idle' } });
      }, [id, askId] as const);
    const mic = () => page.evaluate((s) => document.querySelector(s)!.className, H(id, '.wbh-mic'));
    const sent = () => page.evaluate(() => (window as any).__sent as string[]);
    try {
      // Mellanslag i den tomma inmatningen spelar in, och frågekortet tar fokus medan det hålls.
      assert.equal(await focusedHud(), id);
      await page.keyboard.down(' ');
      await page.waitForFunction((s) => !!document.querySelector(s)?.classList.contains('is-rec'), H(id, '.wbh-mic'), { timeout: 8000 });
      await ask('h-1');
      await page.waitForFunction(() => document.activeElement?.textContent === 'Tillåt', null, { timeout: 3000 });
      await page.keyboard.down(' ');
      await page.keyboard.down(' ');
      await page.keyboard.up(' ');
      await sleep(300);
      assert.deepEqual(await sent(), [], 'upprepningarna och släppet godkände inte');
      // Kontroll: ett nytt tryck på Tillåt godkänner, för knappar behåller mellanslaget.
      assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Tillåt');
      await page.keyboard.press(' ');
      assert.deepEqual(await sent(), ['allow'], 'kontroll: ett nytt tryck på Tillåt godkänner');
      await answered('h-1');
      await page.waitForFunction(() => !document.querySelector('.wbh-card'), null, { timeout: 5000 });
      await page.waitForFunction((s) => !/\bis-(rec|busy)\b/.test(document.querySelector(s)!.className), H(id, '.wbh-mic'), { timeout: 15_000 });
      // Mikrofonknappen: mellanslag på den spelar in, kortet tar fokus från den, och släppet stoppar ändå inspelningen.
      await page.focus(H(id, '.wbh-mic'));
      await page.keyboard.down(' ');
      await page.waitForFunction((s) => !!document.querySelector(s)?.classList.contains('is-rec'), H(id, '.wbh-mic'), { timeout: 8000 });
      await ask('h-2');
      await page.waitForFunction(() => document.activeElement?.textContent === 'Tillåt', null, { timeout: 3000 });
      await page.keyboard.down(' ');
      await page.keyboard.up(' ');
      await sleep(300);
      assert.deepEqual(await sent(), ['allow'], 'upprepningen och släppet godkände inte');
      assert.doesNotMatch(await mic(), /\bis-rec\b/, 'släppet stoppade inspelningen');
      await answered('h-2');
    } finally {
      await page.evaluate((a) => {
        const w = (window as any).__wb;
        w.store.send = (window as any).__origSend;
        w.store.receive({ t: 'app', app: { ...w.store.apps.get(a), status: 'idle' } });
      }, id);
    }
  });

  test('lång historik skrollar i panelen: högst min(40vh, 320 px), och senaste svaret syns (kalibrerat: kort historik växer inte till taket)', async () => {
    await clearApps();
    const id = await newApp(-600, -300);
    await openHud(id);
    const push = (n: number) =>
      page.evaluate(([appId, n]) => {
        const w = (window as any).__wb;
        const t0 = Date.now() - 100_000;
        for (let i = 0; i < n; i++) {
          w.store.receive({ t: 'chat', appId, ev: { k: 'user', id: `h-u${i}`, text: `Fråga nummer ${i}`, via: 'text', at: t0 + i * 10 } });
          w.store.receive({ t: 'chat', appId, ev: { k: 'turn', phase: 'start', at: t0 + i * 10 + 1 } });
          w.store.receive({ t: 'chat', appId, ev: { k: 'text', id: `h-t${i}`, text: `Svar nummer ${i}, med en mening som är lång nog att bryta raden i panelen.`, at: t0 + i * 10 + 2 } });
          w.store.receive({ t: 'chat', appId, ev: { k: 'turn', phase: 'end', ok: true, at: t0 + i * 10 + 3 } });
        }
      }, [id, n] as const);
    const size = () =>
      page.evaluate((s) => {
        const p = document.querySelector(`${s} .wbh-panel`)!.getBoundingClientRect();
        const sc = document.querySelector(`${s} .wbh-scroll`) as HTMLElement;
        const last = [...document.querySelectorAll(`${s} .wbh-msgs .wbh-reply`)].at(-1)!.getBoundingClientRect();
        return { h: p.height, scrolls: sc.scrollHeight > sc.clientHeight + 1, lastVisible: last.bottom <= sc.getBoundingClientRect().bottom + 1 && last.top >= p.top, max: Math.min(innerHeight * 0.4, 320) };
      }, H(id));
    await push(1);
    await sleep(700);
    const short = await size();
    assert.ok(short.h < short.max - 40 && !short.scrolls, `kalibrering: ett svar ger en låg panel utan skroll (${short.h})`);
    await push(12);
    await sleep(900);
    const long = await size();
    assert.ok(long.h <= long.max + 0.5, `högst taket (${long.h} > ${long.max})`);
    assert.ok(long.h > long.max - 2, `växer till taket (${long.h})`);
    assert.ok(long.scrolls, 'listan skrollar');
    assert.ok(long.lastVisible, 'senaste svaret syns längst ned');
  });

  test('B9 linjen går från varje apps fönster till dess egen HUD, kant mot kant och aldrig över appen, stark i den aktiva, och följer kameran (kalibrerat mot den andra appens fönster)', async () => {
    await clearApps();
    const a = await newApp(-660, -300);
    const b = await newApp(260, -300);
    await openHud(a);
    await openHud(b);
    // Linjen tonar in när panelen glidit ut.
    await page.waitForFunction(
      (ids) => ids.every((id) => {
        const svg = document.querySelector(`.wbh-tether[data-app="${id}"]`);
        return !!svg && getComputedStyle(svg).opacity === '1';
      }),
      [a, b],
      { timeout: 4000 },
    );
    const line = () =>
      page.evaluate(([x, y]) => {
        const one = (id: string) => {
          const l = document.querySelector(`.wbh-tether[data-app="${id}"] line`);
          const svg = l?.parentElement as Element | null | undefined;
          const p = document.querySelector(`.wbh[data-app="${id}"] .wbh-panel`)!.getBoundingClientRect();
          if (!l || !svg) return null;
          const n = (k: string) => Number(l.getAttribute(k));
          const w = (window as any).__wb.world;
          const own = w.screenRectOf(id);
          const other = w.screenRectOf(id === x ? y : x);
          // Avståndet från en punkt till en rektangels kant (0 på kanten; hörnens rundning ger några px).
          const edgeOf = (px: number, py: number, r: { x: number; y: number; w: number; h: number }) => {
            const dx = Math.max(r.x - px, 0, px - (r.x + r.w));
            const dy = Math.max(r.y - py, 0, py - (r.y + r.h));
            const outside = Math.hypot(dx, dy);
            const inside = Math.min(px - r.x, r.x + r.w - px, py - r.y, r.y + r.h - py);
            return outside > 0 ? outside : inside;
          };
          const mid = { x: (n('x1') + n('x2')) / 2, y: (n('y1') + n('y2')) / 2 };
          const insideOwn = mid.x > own.x + 2 && mid.x < own.x + own.w - 2 && mid.y > own.y + 2 && mid.y < own.y + own.h - 2;
          return {
            shown: getComputedStyle(svg).opacity === '1' && getComputedStyle(l).display !== 'none',
            opacity: Number(getComputedStyle(l).strokeOpacity),
            own: edgeOf(n('x1'), n('y1'), own),
            other: edgeOf(n('x1'), n('y1'), other),
            edge: edgeOf(n('x2'), n('y2'), { x: p.left, y: p.top, w: p.width, h: p.height }),
            insideOwn,
          };
        };
        return { a: one(x), b: one(y) };
      }, [a, b] as const);
    let m = await line();
    assert.ok(m.a && m.b, 'en linje per HUD');
    assert.ok(m.a.other > 40, `kalibrering: A:s linje mäts inte mot B:s fönster (${m.a.other})`);
    for (const [k, v] of [['A', m.a], ['B', m.b]] as const) {
      assert.ok(v.shown, `${k}: linjen syns`);
      assert.ok(v.own < 6, `${k}: börjar på det egna fönstrets kant (${v.own})`);
      assert.ok(v.edge < 6, `${k}: slutar på den egna panelens kant (${v.edge})`);
      assert.equal(v.insideOwn, false, `${k}: går inte över appen`);
    }
    assert.equal(m.b.opacity, 1, 'stark i den aktiva');
    assert.ok(Math.abs(m.a.opacity - 0.45) < 0.01, `svagare i den lugna (${m.a.opacity})`);
    await page.evaluate(() => {
      const w = (window as any).__wb.world.debug;
      const c = w.camera();
      w.setCamera({ ...c, cx: c.cx + 60, cy: c.cy - 40 });
    });
    await frames(2);
    m = await line();
    assert.ok(m.a!.own < 6 && m.b!.own < 6, 'följer kameran i samma bildruta');
    await page.evaluate((x) => (window as any).__wb.bus.emit('hud:close', { appId: x }), b);
    await waitClosed(b);
    await sleep(300);
    assert.equal(await page.evaluate((x) => !!document.querySelector(`.wbh-tether[data-app="${x}"]`), b), false, 'den stängdas linje är borta');
    assert.equal(await page.evaluate((x) => !!document.querySelector(`.wbh-tether[data-app="${x}"]`), a), true, 'den andras står kvar');
  });

  test('⋯ Visa loggen öppnar appens senaste loggrader som text i en egen flik, och bara appens egna (§13, §7.1)', async () => {
    await clearApps();
    const id = await newApp(-520, -260);
    const other = await newApp(200, -260);
    const marker = `loggrad-${Date.now()}`;
    assert.equal(await postAppLog(id, [{ level: 'error', text: `${marker} <b id="x">inte html</b>` }]), 204);
    assert.equal(await postAppLog(other, [{ level: 'error', text: `annan-${marker}` }]), 204);
    await openHud(id);
    await page.hover(H(id, '.wbh-panel'));
    await page.click(H(id, '.wbh-more'));
    const items = await page.evaluate(() => [...document.querySelectorAll('.wbh-menu-item')].map((b) => b.textContent));
    assert.ok(items.includes('Visa loggen'), items.join(', '));
    const [tab] = await Promise.all([page.context().waitForEvent('page'), page.click('.wbh-menu >> text=Visa loggen')]);
    await tab.waitForLoadState('load');
    const got = await tab.evaluate(() => ({ path: location.pathname, type: document.contentType, text: document.body.innerText, html: document.querySelectorAll('#x').length }));
    await tab.close();
    assert.equal(got.path, `/api/apps/${id}/logs`);
    assert.equal(got.type, 'text/plain');
    assert.equal(got.html, 0, 'loggens HTML blir aldrig element');
    assert.match(got.text, new RegExp(`\\[console\\] error: ${marker} <b id="x">inte html</b>`));
    // Kalibrering: den andra appens rad finns i dess egen logg men inte här.
    assert.ok(!got.text.includes(`annan-${marker}`), 'en annan apps logg');
    const theirs = await page.evaluate(async (x) => (await fetch(`/api/apps/${x}/logs`)).text(), other);
    assert.ok(theirs.includes(`annan-${marker}`));
    assert.equal(await page.evaluate(() => (document.querySelector('.wbh-menu') as HTMLElement).hidden), true, 'menyn stängdes');
  });

  test('en användarrad vars meddelande aldrig kördes dämpas på plats när noten kommer (§13, §14)', async () => {
    await clearApps();
    const id = await newApp(-520, -260);
    await openHud(id);
    const feed = (evs: unknown[]) => page.evaluate(([a, list]) => {
      const w = (window as any).__wb;
      for (const ev of list as unknown[]) w.store.receive({ t: 'chat', appId: a, ev });
    }, [id, evs] as const);
    const now = Date.now();
    await feed([
      { k: 'user', id: 'd-u1', text: 'en anteckningsapp', via: 'text', at: now - 900 },
      { k: 'turn', phase: 'start', at: now - 800 },
      { k: 'user', id: 'd-u2', text: 'och en rubrik', via: 'text', at: now - 700 },
    ]);
    await frames(3);
    const look = () => page.evaluate((s) => [...document.querySelectorAll<HTMLElement>(`${s} .wbh-user`)].map((n) => ({ text: n.textContent, dropped: n.classList.contains('is-dropped'), color: getComputedStyle(n).color })), H(id));
    const before = await look();
    assert.deepEqual(before.map((u) => u.dropped), [false, false]);
    assert.equal(before[1].color, 'rgba(255, 255, 255, 0.82)', 'kalibrering: en vanlig rad har radernas färg');
    await feed([
      { k: 'note', id: 'd-n1', text: 'Stoppad – ”och en rubrik” skickades inte', dropped: 'd-u2', at: now - 600 },
      { k: 'turn', phase: 'end', ok: false, interrupted: true, at: now - 500 },
    ]);
    await frames(3);
    const after = await look();
    assert.deepEqual(after.map((u) => [u.text, u.dropped, u.color]), [
      ['en anteckningsapp', false, 'rgba(255, 255, 255, 0.82)'],
      ['och en rubrik', true, 'rgba(255, 255, 255, 0.65)'],
    ]);
    await page.evaluate((a) => (window as any).__wb.bus.emit('hud:close', { appId: a }), id);
    await waitClosed(id);
  });

  test('Stopp mitt i strömmen: det delvisa svaret och noten Avbröts står i HUD:en, också efter en omladdning (§8.3, §8.6)', async () => {
    await clearApps();
    const id = await newApp(-520, -260);
    await openHud(id);
    // Stoppet går iväg från sidan när första ordet strömmat in (låtsas-Claude strömmar i 250 ms vid WORKBENCH_FAKE_SPEED=4).
    await page.evaluate((a) => {
      const w = (window as any).__wb;
      const off = w.store.on('chat', (x: string) => {
        if (x !== a || !(w.store.live.get(a) ?? '').trim()) return;
        off();
        w.store.send({ t: 'chat.stop', appId: a });
      });
    }, id);
    await page.keyboard.type('Jag vill ha anteckningar');
    await page.keyboard.press('Enter');
    await page.waitForFunction((a) => {
      const w = (window as any).__wb;
      return w.store.apps.get(a)?.status === 'idle' && (w.store.chats.get(a) ?? []).some((e: any) => e.k === 'note');
    }, id, { timeout: 20_000 });
    await frames(3);
    const shown = () => page.evaluate((s) => [...document.querySelectorAll<HTMLElement>(`${s} .wbh-msgs > *, ${s} .wbh-queued > *`)].map((n) => [n.className.split(' ')[0], n.textContent ?? '']), H(id));
    const now = await shown();
    assert.equal(now.length, 3, JSON.stringify(now));
    assert.deepEqual(now[0], ['wbh-user', 'Jag vill ha anteckningar']);
    assert.equal(now[1][0], 'wbh-reply');
    assert.ok(now[1][1].length > 0 && 'Jag bygger en anteckningsapp åt dig.'.startsWith(now[1][1].trim()), `det delvisa svaret: ${now[1][1]}`);
    assert.equal(now[2][0], 'wbh-note');
    assert.ok(['Avbröts', 'Avbröts – ändringarna finns kvar'].includes(now[2][1]), now[2][1]);
    // Sparat i chat.jsonl: samma rader när sidan laddas om och historiken läses in.
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => (window as any).__wb?.store?.connected === true, null, { timeout: 60_000 });
    await page.waitForFunction((s) => document.querySelectorAll(`${s} .wbh-msgs > *`).length >= 3, H(id), { timeout: 10_000 });
    assert.deepEqual(await shown(), now);
    await page.evaluate((a) => (window as any).__wb.bus.emit('hud:close', { appId: a }), id);
    await waitClosed(id);
  });

  test('noten efter turslutet står under den stoppade turen, ovanför meddelandet som skickades efter Stopp (§8.6, §13)', async () => {
    await clearApps();
    const id = await newApp(-520, -260);
    await openHud(id);
    // Serverns ordning (server-claude-sessions.test.ts): meddelandet efter Stopp hålls och dess rad kommer före turslutet.
    const feed = (evs: unknown[]) => page.evaluate(([a, list]) => {
      const w = (window as any).__wb;
      for (const ev of list as unknown[]) w.store.receive({ t: 'chat', appId: a, ev });
    }, [id, evs] as const);
    const now = Date.now();
    await feed([
      { k: 'user', id: 'o-u1', text: 'en klocka', via: 'text', at: now - 900 },
      { k: 'turn', phase: 'start', at: now - 800 },
      { k: 'user', id: 'o-u2', text: 'gör en väckarklocka i stället', via: 'text', at: now - 700 },
      { k: 'text', id: 'o-t1', text: 'Jag bygger en klocka', at: now - 600 },
      { k: 'turn', phase: 'end', ok: false, interrupted: true, at: now - 500 },
      { k: 'note', id: 'o-n1', text: 'Avbröts – ändringarna finns kvar', at: now - 499 },
    ]);
    await frames(3);
    const shown = () => page.evaluate((s) => [...document.querySelectorAll<HTMLElement>(`${s} .wbh-msgs > *, ${s} .wbh-queued > *`)].map((n) => `${n.className.split(' ')[0]}:${n.textContent ?? ''}`), H(id));
    assert.deepEqual(await shown(), ['wbh-user:en klocka', 'wbh-reply:Jag bygger en klocka', 'wbh-note:Avbröts – ändringarna finns kvar', 'wbh-user:gör en väckarklocka i stället']);
    await feed([
      { k: 'turn', phase: 'start', at: now - 400 },
      { k: 'text', id: 'o-t2', text: 'Klart. Väckarklockan finns.', at: now - 300 },
      { k: 'turn', phase: 'end', ok: true, at: now - 200 },
    ]);
    await frames(3);
    assert.deepEqual(await shown(), [
      'wbh-user:en klocka', 'wbh-reply:Jag bygger en klocka', 'wbh-note:Avbröts – ändringarna finns kvar', 'wbh-user:gör en väckarklocka i stället', 'wbh-reply:Klart. Väckarklockan finns.',
    ]);
    await page.evaluate((a) => (window as any).__wb.bus.emit('hud:close', { appId: a }), id);
    await waitClosed(id);
  });

  test('uppläsning: ett röstmeddelande som skickas under §8.6 läses upp när dess egen tur slutar, inte den förra turens svar (§12)', async () => {
    await clearApps();
    const id = await newApp(-520, -260);
    await openHud(id);
    // Låtsas: en svensk röst som skriver ned vad som läses upp, en utskrift av inspelningen, och chat.send som aldrig når
    // servern (händelserna matas in nedan i serverns ordning). Avkodningen misslyckas, så att inspelningen inte räknas som tyst.
    await page.evaluate((a) => {
      const w = window as any;
      w.__spoken = [];
      w.__sent = [];
      speechSynthesis.getVoices = () => [{ name: 'Alva', lang: 'sv-SE', localService: true, default: true, voiceURI: 'Alva' } as unknown as SpeechSynthesisVoice];
      speechSynthesis.speak = (u: SpeechSynthesisUtterance) => void w.__spoken.push(u.text);
      speechSynthesis.cancel = () => {};
      w.SpeechSynthesisUtterance = class { text: string; constructor(t: string) { this.text = t; } };
      w.__decode = AudioContext.prototype.decodeAudioData;
      AudioContext.prototype.decodeAudioData = () => Promise.reject(new Error('låtsas'));
      const store = w.__wb.store;
      const send = store.send.bind(store);
      store.send = (m: { t: string; appId?: string }) => (m.t === 'chat.send' && m.appId === a ? (w.__sent.push(m), true) : send(m));
      store.transcribe = async () => 'gör en väckarklocka';
    }, id);
    const feed = (evs: unknown[]) => page.evaluate(([a, list]) => {
      const w = (window as any).__wb;
      for (const ev of list as unknown[]) w.store.receive({ t: 'chat', appId: a, ev });
    }, [id, evs] as const);
    const now = await page.evaluate(() => Date.now());
    // Ett skrivet meddelande och dess svar; turen är i §8.6 (turslutet har inte kommit).
    await feed([
      { k: 'user', id: 'v-u1', text: 'en klocka', via: 'text', at: now - 900 },
      { k: 'turn', phase: 'start', at: now - 800 },
      { k: 'text', id: 'v-t1', text: 'Klockan går nu.', at: now - 700 },
    ]);
    // Röstmeddelandet: håll mikrofonen, när HUD:en glidit ut och står still.
    await sleep(700);
    const mic = await page.evaluate((s) => {
      const r = document.querySelector(s)!.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }, H(id, '.wbh-mic'));
    assert.equal(await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest('.wbh-mic') !== null, [mic.x, mic.y] as const), true, 'mikrofonen ligger under pekaren');
    await page.mouse.move(mic.x, mic.y, { steps: 6 });
    await page.mouse.down();
    await page.waitForFunction((s) => document.querySelector(s)?.getAttribute('aria-pressed') === 'true', H(id, '.wbh-mic'), { timeout: 8000 });
    await sleep(500);
    await page.mouse.up();
    await page.waitForFunction(() => (window as any).__sent.length === 1, null, { timeout: 10_000 });
    assert.deepEqual(await page.evaluate(() => (window as any).__sent[0]), { t: 'chat.send', appId: id, text: 'gör en väckarklocka', via: 'voice' });
    // Serverns ordning: det hållna röstmeddelandets rad, den förra turens slut, och sedan röstmeddelandets egen tur.
    const t = await page.evaluate(() => Date.now());
    await feed([
      { k: 'user', id: 'v-u2', text: 'gör en väckarklocka', via: 'voice', at: t },
      { k: 'turn', phase: 'end', ok: true, at: t + 1 },
    ]);
    await sleep(300);
    assert.deepEqual(await page.evaluate(() => (window as any).__spoken), [], 'den förra turen svarade på ett skrivet meddelande');
    await feed([
      { k: 'turn', phase: 'start', at: t + 2 },
      { k: 'text', id: 'v-t2', text: 'Väckarklockan ringer i morgon bitti. Den står på sju.', at: t + 3 },
      { k: 'turn', phase: 'end', ok: true, at: t + 4 },
    ]);
    await page.waitForFunction(() => (window as any).__spoken.length > 0, null, { timeout: 5000 }).catch(() => {});
    await sleep(200);
    assert.deepEqual(await page.evaluate(() => (window as any).__spoken), ['Väckarklockan ringer i morgon bitti.']);
    await page.evaluate((a) => {
      const w = window as any;
      AudioContext.prototype.decodeAudioData = w.__decode;
      delete w.__wb.store.send;
      delete w.__wb.store.transcribe;
      w.__wb.bus.emit('hud:close', { appId: a });
    }, id);
    await waitClosed(id);
  });

  /** En byggd klocka från låtsas-Claude, i vila och utan öppen HUD, och dess sida i iframen. */
  async function builtClock(x: number, y: number): Promise<{ id: string; frame: import('playwright-core').Frame }> {
    const id = await newApp(x, y);
    await page.evaluate((a) => (window as any).__wb.bus.emit('hud:send', { appId: a, text: 'Jag vill ha en klocka' }), id);
    await page.waitForFunction((a) => {
      const app = (window as any).__wb.store.apps.get(a);
      return !!app?.built && app.status === 'idle';
    }, id, { timeout: 20_000 });
    await page.evaluate((a) => (window as any).__wb.bus.emit('hud:close', { appId: a }), id);
    await waitClosed(id);
    let frame: import('playwright-core').Frame | undefined;
    for (let i = 0; i < 100 && !frame; i++) {
      frame = page.frames().find((f) => f.url().startsWith(`http://${id}.localhost`));
      if (!frame) await sleep(50);
    }
    assert.ok(frame, 'appens sida laddades aldrig');
    await frame.waitForFunction(() => typeof (window as any).wb === 'object' && document.readyState === 'complete');
    await sleep(800); // det appen loggar när den laddas hinner fram
    return { id, frame };
  }

  /** Den enda appens prick (testerna rensar först). */
  const dotState = () =>
    page.evaluate(() => {
      const d = document.querySelector('.wb-cw:not(.wb-gone) .wb-dot');
      const b = d?.querySelector<HTMLElement>('.wb-dot-badge') ?? null;
      const core = d?.querySelector('.wb-dot-core')?.getBoundingClientRect();
      const cs = b ? getComputedStyle(b) : null;
      const r = b?.getBoundingClientRect();
      return {
        amber: d?.classList.contains('wb-amber') ?? null,
        badge: b && cs && r && core
          ? { text: b.textContent, html: b.innerHTML, shown: cs.display !== 'none' && r.width > 0, w: r.width, h: r.height, gap: r.left - core.right, dy: r.top + r.height / 2 - (core.top + core.height / 2), font: cs.fontSize }
          : null,
      };
    });

  test('felsignalen (§7.2): ett ohanterat fel efter turen gör pricken bärnstensfärgad och lägger "Rätta felet" först i Förslag, även medan förslagen hämtas; ett vanligt console.error gör det inte', async () => {
    await clearApps();
    const { id, frame } = await builtClock(-240, -200);
    // En pollande app som loggar ett fel per förfrågan: ingen signal.
    await frame.evaluate(() => {
      for (let i = 0; i < 3; i++) console.error('Kunde inte hämta flödet: HTTP 503');
    });
    await sleep(1500);
    assert.equal((await dotState()).amber, false, 'ett vanligt console.error');
    assert.equal(await page.evaluate((a) => (window as any).__wb.store.apps.get(a).trouble ?? null, id), null);
    // Kontroll i samma körning: ett ohanterat fel ger signalen.
    await frame.evaluate(() => void setTimeout(() => {
      throw new Error('trasig klocka');
    }));
    await page.waitForFunction(() => document.querySelector('.wb-cw:not(.wb-gone) .wb-dot')?.classList.contains('wb-amber'), null, { timeout: 5000 });
    assert.equal(await page.evaluate((a) => (window as any).__wb.store.apps.get(a).trouble, id), 'Uncaught Error: trasig klocka');
    // Förslagen dröjer: det lokala förslaget står där ändå, före Claudes.
    let release = (): void => {};
    const held = new Promise<void>((r) => (release = r));
    await page.route('**/api/apps/*/ideas', async (route) => {
      await held;
      await route.continue();
    });
    try {
      const dots = await page.$$('.wb-cw:not(.wb-gone) .wb-facedot');
      assert.equal(dots.length, 2, 'klockan och Förslag');
      const box = (await dots[1].boundingBox())!;
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await page.waitForSelector('.wb-ideas[data-state="loading"] .wb-idea-fix', { timeout: 3000 });
      release();
      await page.waitForSelector('.wb-ideas[data-state="ready"] .wb-idea-fix', { timeout: 5000 });
    } finally {
      release();
      await page.unroute('**/api/apps/*/ideas');
    }
    const items = await page.evaluate(() => [...document.querySelectorAll('.wb-ideas .wb-idea')].map((b) => b.textContent));
    assert.equal(items[0], 'Rätta felet: Uncaught Error: trasig klocka');
    assert.ok(items.length > 1, 'Claudes förslag står under');
    // Ett klick skickar raden citerad som appens feltext; turens slut (ny version) tar bort signalen.
    await page.click('.wb-ideas .wb-idea-fix');
    await page.waitForFunction((a) => [...document.querySelectorAll(`.wbh[data-app="${a}"] *`)].some((e) => e.children.length === 0 && e.textContent === 'Rätta felet som appen fick efter bygget: ”Uncaught Error: trasig klocka”'), id, { timeout: 5000 });
    await page.waitForFunction((a) => {
      const app = (window as any).__wb.store.apps.get(a);
      return app?.status === 'idle' && !app.trouble;
    }, id, { timeout: 20_000 });
    assert.equal((await dotState()).amber, false, 'turens slut tar bort signalen');
  });

  test('märket (wb.badge, §10.5): bredvid prickens kärna som text, dolt medan Claude bygger eller väntar, en fylld prick på miniatyren, och borta när sidan laddas om utan att sätta det igen', async () => {
    await clearApps();
    const { id, frame } = await builtClock(-240, -200);
    const setStatus = (status: string) =>
      page.evaluate(([a, s]) => {
        const w = (window as any).__wb;
        w.store.receive({ t: 'app', app: { ...w.store.apps.get(a), status: s } });
      }, [id, status] as const);
    assert.equal((await dotState()).badge?.shown ?? false, false, 'inget märke innan appen satt ett');
    await frame.evaluate(() => (window as any).wb.badge('<i>'));
    await page.waitForFunction(() => document.querySelector('.wb-cw:not(.wb-gone) .wb-dot-badge')?.textContent === '<i>');
    assert.equal((await dotState()).badge?.html, '&lt;i&gt;', 'textContent, aldrig HTML');
    await frame.evaluate(() => (window as any).wb.badge(12));
    await page.waitForFunction(() => document.querySelector('.wb-cw:not(.wb-gone) .wb-dot-badge')?.textContent === '12');
    let s = await dotState();
    assert.ok(s.badge?.shown, 'märket syns i vila');
    assert.ok(s.badge && s.badge.gap >= 0 && s.badge.gap <= 8 && Math.abs(s.badge.dy) <= 2, `bredvid kärnan: ${JSON.stringify(s.badge)}`);
    const full = s.badge!.w;
    for (const st of ['building', 'waiting']) {
      await setStatus(st);
      assert.equal((await dotState()).badge?.shown, false, `Claudes läge går före: ${st}`);
    }
    await setStatus('error');
    s = await dotState();
    assert.ok(s.amber && s.badge?.shown, 'bärnsten och märket syns samtidigt');
    await setStatus('idle');
    // Miniatyren: en fylld prick utan text.
    await page.evaluate((a) => (window as any).__wb.world.minimize(a), id);
    await page.waitForFunction((a) => {
      const v = (window as any).__wb.world.debug.views().find((x: any) => x.appId === a);
      return v?.minimized && !v.flying;
    }, id, { timeout: 5000 });
    await frames(3);
    s = await dotState();
    assert.ok(s.badge?.shown && s.badge.w <= 9 && s.badge.h <= 9 && s.badge.w < full, `fylld prick på miniatyren: ${JSON.stringify(s.badge)}`);
    assert.equal(s.badge?.font, '0px', 'ingen text på miniatyren');
    await page.evaluate((a) => (window as any).__wb.world.restore(a), id);
    await page.waitForFunction((a) => !(window as any).__wb.world.debug.views().find((x: any) => x.appId === a)?.flying, id, { timeout: 5000 });
    await frames(3);
    assert.ok((await dotState()).badge?.shown, 'tillbaka på sin plats: märket igen');
    // Ny version (handredigerad fil): sidan laddas om och har inte satt märket igen, så det är borta.
    const file = path.join(home, 'apps', id, 'index.html');
    const rev0 = await page.evaluate((a) => (window as any).__wb.store.apps.get(a).rev, id);
    fs.appendFileSync(file, '\n<!-- ny version -->\n');
    await page.waitForFunction(([a, r]) => (window as any).__wb.store.apps.get(a).rev !== r, [id, rev0] as const, { timeout: 8000 });
    await page.waitForFunction(() => !document.querySelector('.wb-cw:not(.wb-gone) .wb-dot-badge')?.textContent, null, { timeout: 8000 });
    // Kontroll: en version som sätter märket när den laddas har det kvar efter omladdningen.
    const rev1 = await page.evaluate((a) => (window as any).__wb.store.apps.get(a).rev, id);
    fs.appendFileSync(file, "<script>wb.badge('5')</script>\n");
    await page.waitForFunction(([a, r]) => (window as any).__wb.store.apps.get(a).rev !== r, [id, rev1] as const, { timeout: 8000 });
    await page.waitForFunction(() => document.querySelector('.wb-cw:not(.wb-gone) .wb-dot-badge')?.textContent === '5', null, { timeout: 8000 });
    assert.ok((await dotState()).badge?.shown);
  });

  /* Granskningen av felsignalen och märket: den gamla sidan under bytet, "Rätta felet" under väntan och felraden, och
     märket under ett fönster ovanför. Sidorna skrivs för hand, så att bevakaren gör dem till en ny version. */
  const THROWING = (n: string) => `<!doctype html><meta charset="utf-8"><body><p>${n}</p><script>setInterval(() => { throw new Error('gammal bugg ${n}'); }, 120);</script>\n`;
  const FIXED = (n: string) => `<!doctype html><meta charset="utf-8"><body><p>${n} rättad</p>\n`;
  const appOf = (id: string) => page.evaluate((a) => (window as any).__wb.store.apps.get(a), id);
  const userTexts = (id: string) =>
    page.evaluate((a) => [...((window as any).__wb.store.chats.get(a) ?? [])].filter((e: any) => e.k === 'user').map((e: any) => e.text as string), id);

  /** En ny app som bevakaren hunnit ta upp (inom en sekund, och den ignorerar sin första sekund). */
  async function watchedApp(x: number, y: number, w = 480, h = 320): Promise<string> {
    const id = await page.evaluate(async ([px, py, pw, ph]) => ((await (window as any).__wb.store.createApp({ x: px, y: py, w: pw, h: ph, scale: 1 })).app.id as string), [x, y, w, h] as const);
    await page.waitForFunction((a) => !!(window as any).__wb.world.screenRectOf(a), id);
    await sleep(2200);
    return id;
  }

  /** Skriv index.html för hand och vänta på den nya versionen. */
  async function writeVersion(id: string, html: string): Promise<void> {
    const rev = (await appOf(id))?.rev;
    fs.writeFileSync(path.join(home, 'apps', id, 'index.html'), html);
    await page.waitForFunction(([a, r]) => (window as any).__wb.store.apps.get(a)?.rev !== r, [id, rev] as const, { timeout: 10_000 });
  }

  const waitTrouble = (id: string, re: RegExp) =>
    page.waitForFunction(([a, src]) => new RegExp(src).test((window as any).__wb.store.apps.get(a)?.trouble ?? ''), [id, re.source] as const, { timeout: 10_000 });

  /** Felet som kommer tillbaka inom ms (den gamla iframen står kvar upp till 4 s och tömmer sin bunt när den tas bort), annars null. */
  async function comesBack(id: string, ms = 3000): Promise<string | null> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const t = ((await appOf(id))?.trouble as string | undefined) ?? null;
      if (t) return t;
      await sleep(50);
    }
    return null;
  }

  test('felsignalen: en ny version får inte tillbaka felet från den gamla sidan, som står kvar tills den nya laddats', async () => {
    await clearApps();
    const id = await watchedApp(-240, -200);
    await writeVersion(id, THROWING('v1'));
    await waitTrouble(id, /^Uncaught Error: gammal bugg v1$/);
    await sleep(500);
    await writeVersion(id, FIXED('v2'));
    assert.equal(await comesBack(id), null, 'den gamla sidans fel kom tillbaka på den rättade versionen');
    // Kontroll i samma körning: en ny version som kastar ger signalen igen.
    await writeVersion(id, THROWING('v3'));
    await waitTrouble(id, /gammal bugg v3/);
  });

  test('"Rätta felet" går att klicka medan förslagen hämtas och när de inte gick att ta fram, skickar raden citerad, och turens nya version får inte tillbaka felet', async () => {
    await clearApps();
    const id = await watchedApp(-240, -200);
    await writeVersion(id, THROWING('a'));
    await waitTrouble(id, /gammal bugg a/);

    /** Vrid fram Förslag med förslagen i ett läge, och klicka med musen mitt på "Rätta felet": vad träffas och vad skickas? */
    const clickFix = async (mode: 'loading' | 'error') => {
      let release = (): void => {};
      const held = new Promise<void>((r) => (release = r));
      await page.route('**/api/apps/*/ideas', async (route) => {
        if (mode === 'error') return route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"x"}' });
        await held;
        await route.continue().catch(() => {});
      });
      try {
        const dots = await page.$$('.wb-cw:not(.wb-gone) .wb-facedot');
        const box = (await dots[dots.length - 1].boundingBox())!;
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForSelector(`.wb-ideas[data-state="${mode}"] .wb-idea-fix`, { timeout: 5000 });
        await sleep(1200); // vridningen klar
        const at = await page.evaluate(() => {
          const b = document.querySelector('.wb-ideas .wb-idea-fix')!;
          const r = b.getBoundingClientRect();
          const x = r.left + r.width / 2;
          const y = r.top + r.height / 2;
          const hit = document.elementFromPoint(x, y);
          // "Försök igen" i felraden tar fortfarande sina klick.
          const again = document.querySelector('.wb-ideas .wb-ideas-again')?.getBoundingClientRect();
          const onAgain = again ? document.elementFromPoint(again.left + again.width / 2, again.top + again.height / 2)?.classList.contains('wb-ideas-again') : null;
          return { x, y, onFix: !!hit && b.contains(hit), hit: hit ? `${hit.tagName}.${hit.className}` : null, onAgain };
        });
        const before = (await userTexts(id)).length;
        await page.mouse.move(at.x - 30, at.y - 30, { steps: 4 });
        await page.mouse.move(at.x, at.y, { steps: 6 });
        await page.mouse.click(at.x, at.y);
        await page.waitForFunction(([a, n]) => [...((window as any).__wb.store.chats.get(a) ?? [])].filter((e: any) => e.k === 'user').length > n, [id, before] as const, { timeout: 3000 }).catch(() => {});
        return { at, sent: (await userTexts(id)).slice(before) };
      } finally {
        release();
        await page.unroute('**/api/apps/*/ideas');
      }
    };

    const rev = (await appOf(id)).rev;
    const loading = await clickFix('loading');
    assert.ok(loading.at.onFix, `medan förslagen hämtas träffar klicket ${loading.at.hit}`);
    assert.deepEqual(loading.sent, ['Rätta felet som appen fick efter bygget: ”Uncaught Error: gammal bugg a”']);
    // Turen (låtsas-Claude skriver en ny version utan felet): den gamla sidan, som kastar tills den tas bort, sätter inte tillbaka det.
    await page.waitForFunction(([a, r]) => {
      const x = (window as any).__wb.store.apps.get(a);
      return x?.status === 'idle' && x.rev !== r;
    }, [id, rev] as const, { timeout: 30_000 });
    assert.equal(await comesBack(id), null, 'den gamla sidans fel kom tillbaka efter turen');

    await page.evaluate((a) => (window as any).__wb.bus.emit('hud:close', { appId: a }), id);
    await waitClosed(id);
    await writeVersion(id, THROWING('b'));
    await waitTrouble(id, /gammal bugg b/);
    const failed = await clickFix('error');
    assert.ok(failed.at.onFix, `när förslagen inte gick att ta fram träffar klicket ${failed.at.hit}`);
    assert.equal(failed.at.onAgain, true, '"Försök igen" tar sina klick');
    assert.deepEqual(failed.sent, ['Rätta felet som appen fick efter bygget: ”Uncaught Error: gammal bugg b”']);
    await page.waitForFunction((a) => (window as any).__wb.store.apps.get(a)?.status === 'idle', id, { timeout: 30_000 });
  });

  test('märket döljs där ett fönster ovanför täcker det och tar aldrig det fönstrets klick; ett brett tecken gör det inte hur brett som helst', async () => {
    await clearApps();
    const a = await watchedApp(-600, -200);
    await writeVersion(a, FIXED('a'));
    let fa: import('playwright-core').Frame | undefined;
    for (let i = 0; i < 100 && !fa; i++) {
      fa = page.frames().find((f) => f.url().startsWith(`http://${a}.localhost`));
      if (!fa) await sleep(50);
    }
    assert.ok(fa, 'appens sida laddades aldrig');
    await fa.waitForFunction(() => typeof (window as any).wb === 'object');
    await fa.evaluate(() => (window as any).wb.badge('99'));
    await page.waitForFunction(() => [...document.querySelectorAll('.wb-dot-badge')].some((b) => b.textContent === '99'));
    await frames(3);
    /** Märkets punkt (tre fjärdedelar in, mitt på höjden): vad träffas där, och syns märket? */
    const probe = (pt?: { x: number; y: number }) =>
      page.evaluate((p) => {
        const b = [...document.querySelectorAll<HTMLElement>('.wb-dot-badge')].find((x) => x.textContent === '99')!;
        const r = b.getBoundingClientRect();
        const x = p?.x ?? r.left + r.width * 0.75;
        const y = p?.y ?? r.top + r.height / 2;
        const hit = document.elementFromPoint(x, y);
        return { x, y, w: r.width, onBadge: hit === b, visibility: getComputedStyle(b).visibility, dotShown: getComputedStyle(b.parentElement!).opacity !== '0' };
      }, pt ?? null);
    const free = await probe();
    assert.ok(free.onBadge && free.visibility === 'visible', `kontroll: utan fönster ovanför är märket träffytan (${JSON.stringify(free)})`);
    // B precis till höger om A och lite högre upp, skapad senare (högre z): täcker märkets plats men inte prickens mitt.
    const b = await watchedApp(-600 + 480 + 6, -260, 300, 260);
    await frames(3);
    const rb = await page.evaluate((x) => (window as any).__wb.world.screenRectOf(x), b);
    assert.ok(free.x > rb.x && free.x < rb.x + rb.w && free.y > rb.y && free.y < rb.y + rb.h, 'punkten ligger i fönstret ovanför');
    const covered = await probe(free);
    assert.equal(covered.onBadge, false, `märket tar klicket i fönstret ovanför (${JSON.stringify(covered)})`);
    assert.equal(covered.visibility, 'hidden');
    assert.ok(covered.dotShown, 'pricken själv syns: dess mitt är fri');
    // Fönstret ovanför flyttas bort: märket syns igen.
    await page.evaluate((x) => (window as any).__wb.store.deleteApp(x), b);
    await page.waitForFunction((x) => !(window as any).__wb.store.apps.has(x), b);
    await sleep(600);
    assert.ok((await probe()).onBadge, 'utan fönstret ovanför igen');
    // Ett mycket brett tecken: kapseln har ett tak.
    await fa.evaluate(() => (window as any).wb.badge('﷽﷽﷽'));
    await page.waitForFunction(() => [...document.querySelectorAll('.wb-dot-badge')].some((x) => x.textContent === '﷽﷽﷽'));
    const wide = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.wb-dot-badge')].find((x) => x.textContent === '﷽﷽﷽')!.getBoundingClientRect().width);
    assert.ok(wide <= 44, `kapseln är ${wide} px bred`);
  });
});
