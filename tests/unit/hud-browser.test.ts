// hud-browser.test.ts — HUD:en i riktig Chrome mot en egen server (låtsas-Claude, egna portar, tillfälligt hem).
// Visar det som inte kan visas i Node: att strängar från Claude aldrig blir HTML i den riktiga DOM:en
// (kalibrerat mot en planterad innerHTML-läcka), Esc-regeln för oanvända appar, "skriv var som helst" och
// att ett hemligt värde lämnar DOM:en direkt men hamnar i appens data/secrets.json, att Esc aldrig kastar en
// halvskriven beskrivning och att HUD:en med sitt utkast överlever en omladdning av sidan.
// HUD_TEST_PORT, HUD_TEST_HMR_PORT och HUD_TEST_HOME_DIR väljer egna portar och hemkatalog (annars lediga portar
// och .scratch/hud-browser-*).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';

const root = path.resolve(import.meta.dirname, '../..');

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let server: ChildProcess | null = null;
let browser: Browser | null = null;
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

describe('HUD:en i riktig Chrome', { timeout: 180_000 }, () => {
  before(async () => {
    const port = Number(process.env.HUD_TEST_PORT) || (await freePort());
    // En slumpad port ger en egen Vite-cache (node_modules/.vite-<port>, CONTRACT §4.3) som annars blir kvar.
    if (!process.env.HUD_TEST_PORT) viteCache = path.join(root, 'node_modules', `.vite-${port}`);
    const hmr = Number(process.env.HUD_TEST_HMR_PORT) || (await freePort());
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
    // Låtsasmikrofon (B7): en ton i stället för en riktig mikrofon, och ingen fråga om behörighet.
    browser = await chromium.launch({
      channel: 'chrome',
      headless: true,
      args: ['--force-device-scale-factor=2', '--mute-audio', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
    });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
    page = await ctx.newPage();
    // Fångar CSP-överträdelser och "lyckade" injektioner från första stund.
    await page.addInitScript(() => {
      (window as any).__violations = [];
      document.addEventListener('securitypolicyviolation', (e) => (window as any).__violations.push(`${e.violatedDirective}: ${e.sample}`));
    });
    await page.goto(base + '/');
    await page.waitForFunction(() => (window as any).__wb?.store?.connected === true, null, { timeout: 60_000 });
  });

  after(async () => {
    await browser?.close().catch(() => {});
    if (server && server.exitCode === null) {
      server.kill('SIGTERM');
      await new Promise((r) => server?.once('exit', r));
    }
    if (home) fs.rmSync(home, { recursive: true, force: true });
    if (viteCache) fs.rmSync(viteCache, { recursive: true, force: true });
  });

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
    // Inte byggd: inget att öppna i egen flik; ingen tur pågår: ångra finns. Fönstret står på sin plats: Minimera (§10.7).
    assert.deepEqual(items, ['Ångra senaste ändringen', 'Minimera', 'Ta bort appen']);
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
});
