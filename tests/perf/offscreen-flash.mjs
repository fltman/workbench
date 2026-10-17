// tests/perf/offscreen-flash.mjs — syns det att en app varit dold (CONTRACT §10.5, wb-offscreen)?
// Kör: node tests/perf/offscreen-flash.mjs [--port 8350] [--runs 3]
// Egen server med låtsas-Claude och tillfälligt hem (tests/perf/rig.mjs), riktig Chrome med DSF 2 och Chromes vanliga
// strypning av dolda ramar (Playwright slår annars av den). Två kontroller, var och en omväxlande med kontroll
// (world.debug.cull(false): inget döljs) och behandling (döljs utanför vyn):
//  1. Timers: en 16 ms-timer och requestAnimationFrame räknas i 1,5 s i en klocka (låtsas-Claudes) i vyn, utanför vyn
//     och utanför vyn dold. Sedan döljs klockan 10 s, och när den kommer tillbaka jämförs texten den visar med tiden.
//  2. Vit blink: en mörk app (bakgrund #0b1020) kommer in i bild på sju sätt: panorering med 20 px per bildruta (zoom 1
//     och 0,3) och 60 px per bildruta (zoom 0,3), flygning via kantmarkören utan zoomändring och med (zoom 1 →
//     passning), utzoomning med ×1,07 per bildruta (ett snabbt nyp) och kantmarkören med minskad rörelse (kameran
//     hoppar). Varje bildruta spelas in med CDP:s screencast och knyts till skalets bildruta närmast före. Vita
//     bildpunkter räknas inom appens rektangel (4 px in från kanten): appen har inga, men fönstrets vita ark syns där
//     iframen inte ritats.
// Skriver en JSON-rad per körning och en sammanfattning: tomma bildrutor (fler än 400 vita bildpunkter och minst 5 % av
// appens synliga del) av bildrutorna där appen är i vyn, vilken bildruta efter inträdet de var (vita/synliga
// bildpunkter), och hur många bildrutor före inträdet appen visades. Kontrollen blinkar också ibland (Chrome ritar inte
// alltid en ram utanför vyn i första bildrutan den kommer in), olika ofta från körning till körning: jämför bara inom
// samma körning.
import fs from 'node:fs';
import path from 'node:path';
import { buildApps, load, openShell, setCam, sleep, startServer } from './rig.mjs';

const runsArg = process.argv.indexOf('--runs');
const RUNS = runsArg > 0 ? Number(process.argv[runsArg + 1]) : 3;
const VW = 1440;
const VH = 900;
const DARK = { x: 4000, y: 0, w: 480, h: 320 };
// Klockan ligger långt nedanför, så att dess vita bakgrund aldrig syns medan den mörka appen spelas in.
const CLOCK = { x: 0, y: 6000, w: 480, h: 320 };
const DARK_HTML = `<!doctype html>
<html lang="sv">
<head><meta charset="utf-8"><title>Mörk</title>
<style>html, body { margin: 0; height: 100%; background: #0b1020; }</style>
</head>
<body></body>
</html>
`;

const srv = await startServer();
let browser;
try {
  const shell = await openShell(srv.base);
  browser = shell.browser;
  const { page, ctx } = shell;
  const cull = (on) => page.evaluate((on) => window.__wb.world.debug.cull(on), on);

  // Den mörka appen skrivs direkt i hemmet: bevakaren (§7.3) gör den byggd.
  const dark = await page.evaluate(async (r) => (await window.__wb.store.createApp({ ...r, scale: 1 })).app.id, DARK);
  await sleep(1500); // bevakaren börjar bevaka nya appar inom en sekund
  fs.writeFileSync(path.join(srv.home, 'apps', dark, 'app.json'), JSON.stringify({ name: 'Mörk', faces: [{ id: 'main', page: 'index.html' }] }) + '\n');
  fs.writeFileSync(path.join(srv.home, 'apps', dark, 'index.html'), DARK_HTML);
  const [clock] = await buildApps(page, [{ ...CLOCK, text: 'en klocka' }]);
  await page.waitForFunction((id) => !!document.querySelector(`.wb-win[data-app="${id}"] iframe.wb-frame:not(.wb-incoming)`), dark, { timeout: 30_000 });
  await page.evaluate(() => {
    const w = window.__wb;
    for (const id of w.world.debug.huds().open) w.bus.emit('hud:close', { appId: id });
  });
  await sleep(1000);
  console.log(JSON.stringify({ load: load(), dark, clock }));

  /* ------------------------------ 1. timers ------------------------------ */

  const clockFrame = () => page.frames().find((f) => f.url().includes(`${clock}.localhost`));
  const probe = () =>
    clockFrame().evaluate(() => new Promise((res) => {
      let on = true;
      let raf = 0;
      let tm = 0;
      (function r() {
        if (!on) return;
        raf++;
        requestAnimationFrame(r);
      })();
      const iv = setInterval(() => tm++, 16);
      setTimeout(() => {
        on = false;
        clearInterval(iv);
        res({ timers16ms: tm, raf });
      }, 1500);
    }));
  const inView = { cx: CLOCK.x + CLOCK.w / 2, cy: CLOCK.y + CLOCK.h / 2, zoom: 1 };
  const offView = { ...inView, cx: inView.cx + 5000 };
  const timers = [];
  for (let i = 0; i < RUNS; i++) {
    for (const [label, cam, on] of i % 2 ? [['utanför vyn, dold', offView, true], ['utanför vyn', offView, false], ['i vyn', inView, true]] : [['i vyn', inView, true], ['utanför vyn', offView, false], ['utanför vyn, dold', offView, true]]) {
      await cull(on);
      await setCam(page, cam);
      await sleep(500);
      const hidden = await page.evaluate((id) => document.querySelector(`.wb-win[data-app="${id}"]`).classList.contains('wb-offscreen'), clock);
      const r = { check: 'timers', label, hidden, ...(await probe()) };
      console.log(JSON.stringify(r));
      timers.push(r);
    }
  }
  // Klockan dold i 10 s, sedan tillbaka: texten i första bildrutan jämfört med tiden i appen.
  await cull(true);
  await setCam(page, offView);
  await sleep(10_000);
  await page.evaluate((c) => new Promise((res) => {
    window.__wb.world.debug.setCamera(c);
    requestAnimationFrame(() => res());
  }), inView);
  // Klockan tickar en gång i sekunden, så den får visa sekunden före (som i vyn).
  const back = await clockFrame().evaluate(() => {
    const shown = document.getElementById('tid').textContent;
    const now = new Date();
    const ok = [0, -1000].some((d) => new Date(now.getTime() + d).toLocaleTimeString('sv-SE') === shown);
    return { shown, now: now.toLocaleTimeString('sv-SE'), ok };
  });
  console.log(JSON.stringify({ check: 'klockan efter 10 s dold', ...back }));

  /* ------------------------------ 2. vit blink ------------------------------ */

  // Bildrutorna avkodas i en egen sida (createImageBitmap), efter inspelningen. Bara appens rektangel räknas.
  const lab = await ctx.newPage();
  await lab.goto('about:blank');
  const whites = (b64, r) =>
    lab.evaluate(async ([b64, r, VW, VH]) => {
      const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const bmp = await createImageBitmap(new Blob([bin], { type: 'image/jpeg' }));
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const g = c.getContext('2d');
      g.drawImage(bmp, 0, 0);
      const k = bmp.width / VW;
      const x0 = Math.max(0, Math.floor((r.x + 4) * k));
      const y0 = Math.max(0, Math.floor((r.y + 4) * k));
      const x1 = Math.min(bmp.width, Math.ceil(Math.min(VW, r.x + r.w - 4) * k));
      const y1 = Math.min(bmp.height, Math.ceil(Math.min(VH, r.y + r.h - 4) * k));
      if (x1 <= x0 || y1 <= y0) return { n: 0, area: 0 };
      const d = g.getImageData(x0, y0, x1 - x0, y1 - y0).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] >= 235 && d[i + 1] >= 235 && d[i + 2] >= 235) n++;
      return { n, area: (x1 - x0) * (y1 - y0) };
    }, [b64, r, VW, VH]);
  const cdp = await ctx.newCDPSession(page);
  async function record(fn) {
    const frames = [];
    const onFrame = (e) => {
      frames.push({ t: e.metadata.timestamp * 1000, data: e.data });
      cdp.send('Page.screencastFrameAck', { sessionId: e.sessionId }).catch(() => {});
    };
    cdp.on('Page.screencastFrame', onFrame);
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 80, maxWidth: VW, maxHeight: VH, everyNthFrame: 1 });
    await sleep(300);
    const rec = await fn();
    await sleep(300);
    await cdp.send('Page.stopScreencast');
    cdp.off('Page.screencastFrame', onFrame);
    return { frames, rec };
  }
  const seen = (r) => r.x < VW && r.x + r.w > 0 && r.y < VH && r.y + r.h > 0;
  /** Bildrutor i inspelningen där appens fönster syns (enligt skalets bildruta närmast före) och hur många som är tomma. */
  async function analyse(frames, rec, hiddenBefore) {
    const enterAt = rec.findIndex(seen);
    // Bara när appen var dold före körningen: bildrutor från att den visades (wb-offscreen borta) till att den syns.
    const shownAt = hiddenBefore ? rec.findIndex((r) => !r.cls) : -1;
    let inView = 0;
    const blanks = [];
    for (const f of frames) {
      const i = rec.findLastIndex((x) => x.t <= f.t);
      const r = rec[i];
      if (!r || !seen(r)) continue;
      inView++;
      const { n, area } = await whites(f.data, r);
      if (n > 400 && n > 0.05 * area) blanks.push(`${i - enterAt}:${n}/${area}`); // bildruta efter inträdet:vita/synliga
    }
    return { framesInView: inView, blank: blanks.length, blanks, leadFrames: shownAt >= 0 && enterAt >= 0 ? enterAt - shownAt : null };
  }

  /** Skalets bildrutor: appens skärmrektangel och om den är dold. step(cam) ger nästa kamera, eller null för att stå still. */
  const drive = (setup) =>
    record(() => page.evaluate(([id, setup]) => new Promise((res) => {
      const w = window.__wb.world;
      const el = document.querySelector(`.wb-win[data-app="${id}"]`);
      let cam = w.debug.camera();
      const out = [];
      let extra = 12;
      if (setup.kind === 'marker') document.querySelector(`.wb-marker[data-app="${id}"]`).click();
      requestAnimationFrame(function f(t) {
        const r = w.screenRectOf(id);
        out.push({ t: performance.timeOrigin + t, x: r.x, y: r.y, w: r.w, h: r.h, cls: el.classList.contains('wb-offscreen') });
        if (setup.kind === 'pan') {
          if (r.x + r.w <= 1440 - 40 && --extra <= 0) return res(out);
          cam = { ...cam, cx: cam.cx + setup.speed / cam.zoom };
          w.debug.setCamera(cam);
        } else if (setup.kind === 'zoomout' && cam.zoom > setup.min) {
          cam = { ...cam, zoom: Math.max(setup.min, cam.zoom / setup.rate) };
          w.debug.setCamera(cam);
        }
        if (out.length < 50 || setup.kind === 'pan') requestAnimationFrame(f);
        else res(out);
      });
    }), [dark, setup]));

  // Kameran där en flygning via kantmarkören landar (passningen), för flygningen utan zoomändring.
  await cull(false);
  await setCam(page, { cx: DARK.x - 3500, cy: DARK.y + 160, zoom: 1 });
  await sleep(600);
  await page.evaluate((id) => document.querySelector(`.wb-marker[data-app="${id}"]`).click(), dark);
  await sleep(900);
  const fit = await page.evaluate(() => window.__wb.world.debug.camera());

  // Panoreringen börjar långt utanför marginalen (dold från början).
  const startPan = (zoom) => ({ cx: DARK.x - (VW + 1600 - VW / 2) / zoom, cy: DARK.y + DARK.h / 2, zoom });
  const scenarios = [
    { name: 'panorering 20 px per bildruta, zoom 1', start: startPan(1), setup: { kind: 'pan', speed: 20 } },
    { name: 'panorering 20 px per bildruta, zoom 0,3', start: startPan(0.3), setup: { kind: 'pan', speed: 20 } },
    { name: 'panorering 60 px per bildruta, zoom 0,3', start: startPan(0.3), setup: { kind: 'pan', speed: 60 } },
    { name: 'flygning via kantmarkören utan zoomändring', start: { cx: fit.cx - 3500 / fit.zoom, cy: fit.cy, zoom: fit.zoom }, setup: { kind: 'marker' } },
    { name: `flygning via kantmarkören med zoom (1 → ${fit.zoom.toFixed(2)})`, start: { cx: DARK.x - 3500, cy: DARK.y + 160, zoom: 1 }, setup: { kind: 'marker' } },
    { name: 'utzoomning ×1,07 per bildruta (2,5 → 0,3)', start: { cx: DARK.x - 1500, cy: DARK.y + 160, zoom: 2.5 }, setup: { kind: 'zoomout', rate: 1.07, min: 0.3 } },
    { name: 'kantmarkören med minskad rörelse (kameran hoppar)', start: { cx: DARK.x - 3500, cy: DARK.y + 160, zoom: 1 }, setup: { kind: 'marker' }, reduce: true },
  ];
  const summary = [];
  for (const s of scenarios) {
    await page.emulateMedia({ reducedMotion: s.reduce ? 'reduce' : 'no-preference' });
    const by = { kontroll: [], behandling: [] };
    for (let i = 0; i < RUNS; i++) {
      for (const mode of i % 2 ? ['behandling', 'kontroll'] : ['kontroll', 'behandling']) {
        await cull(mode === 'behandling');
        await setCam(page, s.start);
        await sleep(2000);
        const hiddenBefore = await page.evaluate((id) => document.querySelector(`.wb-win[data-app="${id}"]`).classList.contains('wb-offscreen'), dark);
        const { frames, rec } = await drive(s.setup);
        const r = { check: 'blink', scenario: s.name, mode, hiddenBefore, frames: frames.length, rafs: rec.length, ...(await analyse(frames, rec, hiddenBefore)) };
        console.log(JSON.stringify(r));
        by[mode].push(r);
      }
    }
    summary.push({ scenario: s.name, ...by });
  }
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await cull(true);

  console.log(`\nSammanfattning   loadavg ${load().join(' ')}`);
  for (const label of ['i vyn', 'utanför vyn', 'utanför vyn, dold']) {
    const rs = timers.filter((t) => t.label === label);
    console.log(`  timers ${label.padEnd(18)} 16 ms-timer ${rs.map((r) => r.timers16ms).join('/')} per 1,5 s, rAF ${rs.map((r) => r.raf).join('/')}`);
  }
  console.log(`  klockan efter 10 s dold: visar ${back.shown}, tiden ${back.now} (${back.ok ? 'rätt' : 'FEL'})`);
  for (const s of summary) {
    console.log(`  ${s.scenario}`);
    for (const mode of ['kontroll', 'behandling']) {
      const rs = s[mode];
      console.log(`    ${mode.padEnd(10)} tomma bildrutor ${rs.map((r) => `${r.blank}/${r.framesInView}`).join(', ')} (bildruta efter inträdet:vita/synliga ${rs.flatMap((r) => r.blanks).join(' ') || '–'})  visad före inträdet ${rs.map((r) => r.leadFrames ?? '–').join('/')} bildrutor`);
    }
  }
} catch (err) {
  console.error('FEL', err);
  console.error(srv.log().slice(-2000));
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  await srv.stop();
}
