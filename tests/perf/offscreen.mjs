// tests/perf/offscreen.mjs — vad det ingen ser kostar (CONTRACT §10.5): dolda iframes, gömd krom och pausade animationer.
// Kör: node tests/perf/offscreen.mjs [--port 8350] [--runs 3]
// Egen server med låtsas-Claude och tillfälligt hem (tests/perf/rig.mjs), riktig Chrome med DSF 2. Bygger först en app
// och mäter den ensam (ankaret), bygger sedan 14 till i ett rutnät 5 × 3 och jämför kontroll och behandling på samma
// sida, omväxlande (K B B K K B …), med samma kameradrivning (240 bildrutor):
//   - kontroll: world.debug.cull(false), det vill säga utan dolda iframes och gömd krom (som före rättelsen);
//   - "kromen ensam": behandling med iframes synliga ändå, så att bara den gömda kromen skiljer;
//   - vila: LED:arna på sidorna Förslag och halornas andning återställda som före rättelsen (kontroll) mot nu.
// Skriver en JSON-rad per körning och till sist en sammanfattning per scenario: medel [minst–störst] för renderarnas
// CPU (% av en kärna, skalet och alla appar), GPU-processens CPU och skalets huvudtråd i ms per bildruta, och skillnaden
// kontroll − behandling inom varje par med medianen. Maskinens belastning (loadavg) skrivs ut, eftersom absoluta tal
// beror på den (en upptagen Mac flyttar trådar mellan kärntyper); jämför bara kontroll och behandling i samma par.
import { GRID, buildApps, drive, load, openShell, setCam, sleep, spread, startServer } from './rig.mjs';

const runsArg = process.argv.indexOf('--runs');
const RUNS = runsArg > 0 ? Number(process.argv[runsArg + 1]) : 3;

const srv = await startServer();
let browser;
const summary = [];
const anchors = [];
try {
  const shell = await openShell(srv.base);
  browser = shell.browser;
  const { page } = shell;
  const near = { cx: 360, cy: 230, zoom: 1.7 }; // inzoomad på den första appen: bara den i vyn, de flesta andra långt borta
  const all = { cx: 2000, cy: 810, zoom: 0.35 }; // alla 15 i vyn (smala fönster: prickarna utan halo)
  const away = { cx: 90_000, cy: 90_000, zoom: 0.35 }; // ingenting i vyn

  // "Kromen ensam": iframes synliga trots wb-offscreen (stilen slås på och av med media).
  await page.evaluate(() => {
    const s = document.createElement('style');
    s.id = 'perf-frames-visible';
    s.media = 'not all';
    s.textContent = '.wb-win.wb-offscreen .wb-frame { visibility: visible !important; }';
    document.head.append(s);
  });
  const framesVisible = (on) => page.evaluate((on) => (document.getElementById('perf-frames-visible').media = on ? 'all' : 'not all'), on);
  const cull = (on) => page.evaluate((on) => window.__wb.world.debug.cull(on), on);
  // Vila som före rättelsen: en LED som andas på varje sida Förslag och halor som andas även när de inte syns.
  const oldIdle = () =>
    page.evaluate(() => {
      const emu = { leds: [], anims: [] };
      for (const f of document.querySelectorAll('.wb-ideas[data-state="idle"]')) {
        const wait = document.createElement('div');
        wait.className = 'wb-ideas-wait';
        const led = document.createElement('i');
        led.className = 'wb-ideas-led';
        wait.append(led);
        f.append(wait);
        emu.leds.push(wait);
      }
      for (const h of document.querySelectorAll('.wb-dot-halo')) for (const a of h.getAnimations()) if (a.playState === 'paused') (a.play(), emu.anims.push(a));
      window.__perfEmu = emu;
    });
  const nowIdle = () =>
    page.evaluate(() => {
      const emu = window.__perfEmu;
      if (!emu) return;
      for (const e of emu.leds) e.remove();
      for (const a of emu.anims) a.pause();
      window.__perfEmu = null;
    });
  const running = () => page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running' && !(a instanceof CSSTransition)).length);

  async function ab(name, kind, cam, modes, n = RUNS) {
    const runs = { K: [], B: [] };
    const order = Array.from({ length: n }, (_, i) => (i % 2 === 0 ? ['K', 'B'] : ['B', 'K'])).flat();
    for (const m of order) {
      await setCam(page, cam);
      await sleep(300);
      await modes[m]();
      await sleep(900);
      const anims = await running();
      const r = { scenario: name, mode: m === 'K' ? 'kontroll' : 'behandling', anims, ...(await drive(shell, kind)) };
      console.log(JSON.stringify(r));
      runs[m].push(r);
    }
    await modes.B();
    const row = { scenario: name, load: load() };
    for (const [m, label] of [['K', 'kontroll'], ['B', 'behandling']]) {
      row[label] = { renderer: spread(runs[m], 'renderer'), gpu: spread(runs[m], 'gpu'), task: spread(runs[m], 'task'), style: spread(runs[m], 'style'), anims: spread(runs[m], 'anims') };
    }
    // Skillnaden kontroll − behandling inom varje par (körningarna i[K] och i[B] gick direkt efter varandra).
    row.diff = {};
    for (const key of ['renderer', 'gpu', 'task', 'style']) row.diff[key] = runs.K.map((k, i) => +(k[key] - runs.B[i][key]).toFixed(2));
    summary.push(row);
  }

  const control = async () => {
    await framesVisible(false);
    await cull(false);
  };
  const treatment = async () => {
    await framesVisible(false);
    await cull(true);
  };
  const chromeOnly = async () => {
    await framesVisible(true);
    await cull(true);
  };

  console.log(JSON.stringify({ load: load() }));
  const [first] = await buildApps(page, GRID.slice(0, 1));
  await page.evaluate(() => {
    const w = window.__wb;
    for (const id of w.world.debug.huds().open) w.bus.emit('hud:close', { appId: id });
  });
  // Ankaret: en app ensam, med samma kamera och drivningar som nedan.
  for (const kind of ['pan', 'zoom']) {
    const runs = [];
    for (let i = 0; i < RUNS; i++) {
      await setCam(page, near);
      await sleep(900);
      const r = { scenario: `ankare: en app, ${kind}`, ...(await drive(shell, kind)) };
      console.log(JSON.stringify(r));
      runs.push(r);
    }
    anchors.push({ scenario: `ankare: en app ensam, ${kind}, inzoomad`, load: load(), renderer: spread(runs, 'renderer'), gpu: spread(runs, 'gpu'), task: spread(runs, 'task'), style: spread(runs, 'style') });
  }
  const ids = [first, ...(await buildApps(page, GRID.slice(1)))];
  await page.evaluate(() => {
    const w = window.__wb;
    for (const id of w.world.debug.huds().open) w.bus.emit('hud:close', { appId: id });
  });
  await sleep(1500);
  console.log(JSON.stringify({ built: ids.length, load: load() }));

  await ab('zoom, inzoomad på en app av 15', 'zoom', near, { K: control, B: treatment });
  await ab('pan, inzoomad på en app av 15', 'pan', near, { K: control, B: treatment });
  await ab('pan, inzoomad: bara kromen (iframes synliga i båda)', 'pan', near, { K: control, B: chromeOnly });
  await ab('zoom, ingenting i vyn', 'zoom', away, { K: control, B: treatment });
  await ab('zoom, alla 15 i vyn', 'zoom', all, { K: control, B: treatment });
  await ab('vila, alla 15 i vyn: LED och halor som före rättelsen mot nu', 'idle', all, {
    K: async () => {
      await treatment();
      await nowIdle();
      await oldIdle();
    },
    B: async () => {
      await treatment();
      await nowIdle();
    },
  });

  console.log('\nSammanfattning (medel [minst–störst] över körningarna):');
  const f = (x, u = '') => `${x.mean}${u} [${x.min}–${x.max}]`;
  for (const a of anchors) console.log(`\n${a.scenario}   loadavg ${a.load.join(' ')}\n  ${''.padEnd(10)} renderare ${f(a.renderer, ' %')}  GPU ${f(a.gpu, ' %')}  huvudtråd ${f(a.task, ' ms')}  stil ${f(a.style, ' ms')}`);
  for (const row of summary) {
    console.log(`\n${row.scenario}   loadavg ${row.load.join(' ')}`);
    for (const label of ['kontroll', 'behandling']) {
      const s = row[label];
      console.log(`  ${label.padEnd(10)} renderare ${f(s.renderer, ' %')}  GPU ${f(s.gpu, ' %')}  huvudtråd ${f(s.task, ' ms')}  stil ${f(s.style, ' ms')}  animationer ${s.anims.mean}`);
    }
    const med = (v) => [...v].sort((a, b) => a - b)[Math.floor((v.length - 1) / 2)];
    const d = row.diff;
    console.log(`  kontroll − behandling per par: renderare ${d.renderer.join(' ')} (median ${med(d.renderer)})  GPU ${d.gpu.join(' ')} (median ${med(d.gpu)})  huvudtråd ${d.task.join(' ')} ms (median ${med(d.task)})`);
  }
} catch (err) {
  console.error('FEL', err);
  console.error(srv.log().slice(-2000));
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  await srv.stop();
}
