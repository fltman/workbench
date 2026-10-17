// tests/perf/rig.mjs — gemensam rigg för mätskripten i tests/perf/ (körs inte själv).
// En egen server (låtsas-Claude, lediga portar eller --port <p> med HMR p + 1, tillfälligt hem under .scratch/perf-*),
// riktig Chrome med --force-device-scale-factor=2, appar som låtsas-Claude bygger, och mätverktygen: CPU per
// processtyp (CDP SystemInfo), skalets huvudtråd per bildruta (CDP Performance) och en kamera som drivs en gång per
// bildruta. Allt startas och stängs av skripten själva.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { testPort } from '../ports.ts';

export const ROOT = path.resolve(import.meta.dirname, '../..');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** --port <p> ur argumenten (annars en ledig port). */
export function portArg() {
  const i = process.argv.indexOf('--port');
  return i > 0 ? Number(process.argv[i + 1]) : null;
}

export async function startServer({ speed = 4 } = {}) {
  const fixed = portArg();
  const port = fixed ?? (await testPort());
  const hmr = fixed ? fixed + 1 : await testPort();
  fs.mkdirSync(path.join(ROOT, '.scratch'), { recursive: true });
  const home = fs.mkdtempSync(path.join(ROOT, '.scratch', `perf-${process.pid}-`));
  const viteCache = path.join(ROOT, 'node_modules', `.vite-${port}`);
  let log = '';
  const server = spawn(process.execPath, [path.join(ROOT, 'server/main.ts')], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      TMPDIR: process.env.TMPDIR ?? '',
      WORKBENCH_PORT: String(port),
      WORKBENCH_HMR_PORT: String(hmr),
      WORKBENCH_HOME: home,
      WORKBENCH_FAKE_CLAUDE: '1',
      WORKBENCH_FAKE_SPEED: String(speed),
      WORKBENCH_STT: 'off',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => (log += d));
  server.stderr.on('data', (d) => (log += d));
  const base = `http://localhost:${port}`;
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`${base}/api/snapshot`, { headers: { origin: base } })).ok) break;
    } catch {
      /* inte uppe än */
    }
    if (i > 200) throw new Error(`servern kom inte upp:\n${log}`);
    await sleep(150);
  }
  const stop = async () => {
    if (server.exitCode === null) {
      server.kill('SIGTERM');
      await Promise.race([new Promise((r) => server.once('exit', r)), sleep(5000)]);
      try {
        server.kill('SIGKILL');
      } catch {
        /* redan borta */
      }
    }
    fs.rmSync(home, { recursive: true, force: true });
    if (!fixed) fs.rmSync(viteCache, { recursive: true, force: true });
  };
  return { base, home, stop, log: () => log };
}

export async function openShell(base) {
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--force-device-scale-factor=2'],
    // Som en vanlig Chrome: Playwright stänger annars av strypningen av timers i dolda ramar och nedprioriteringen av
    // renderare som bara har dolda ramar, och just det är vad mätningarna ska se.
    ignoreDefaultArgs: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
  });
  const bcdp = await browser.newBrowserCDPSession();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Performance.enable');
  await page.goto(base + '/');
  await page.waitForFunction(() => window.__wb?.store?.connected === true, null, { timeout: 60_000 });
  return { browser, bcdp, ctx, page, cdp };
}

/** Appar som låtsas-Claude bygger, fyra åt gången (taket på levande processer, CONTRACT §8.1). */
export async function buildApps(page, specs) {
  const ids = [];
  for (let i = 0; i < specs.length; i += 4) {
    const batch = await page.evaluate(async (specs) => {
      const w = window.__wb;
      const out = [];
      for (const s of specs) {
        const res = await w.store.createApp({ x: s.x, y: s.y, w: s.w ?? 720, h: s.h ?? 460, scale: 1 });
        w.store.send({ t: 'chat.send', appId: res.app.id, text: s.text, via: 'text' });
        out.push(res.app.id);
      }
      return out;
    }, specs.slice(i, i + 4));
    await page.waitForFunction(
      (ids) => ids.every((id) => {
        const a = window.__wb.store.apps.get(id);
        return a?.built === true && a.status === 'idle' && !!document.querySelector(`.wb-win[data-app="${id}"] iframe.wb-frame:not(.wb-incoming)`);
      }),
      batch,
      { timeout: 120_000, polling: 250 },
    );
    ids.push(...batch);
  }
  return ids;
}

/** Fem gånger tre fönster på 720 × 460 med 100 px mellanrum (som granskningens mätning den 17 oktober). */
export const GRID = Array.from({ length: 15 }, (_, i) => ({
  x: (i % 5) * 820,
  y: Math.floor(i / 5) * 580,
  text: ['anteckningar', 'en kub med tre sidor', 'en klocka'][i % 3],
}));

export const setCam = (page, c) => page.evaluate((c) => window.__wb.world.debug.setCamera(c), c);

function stats(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: s.length, mean: +(s.reduce((a, b) => a + b, 0) / s.length).toFixed(2), p95: +q(0.95).toFixed(2), max: +s[s.length - 1].toFixed(2), over20: s.filter((x) => x > 20).length };
}

/**
 * Driv kameran en gång per bildruta i `frames` bildrutor: 'pan' (±6 skärm-px per bildruta, vänder var 60:e), 'zoom'
 * (×1,012 per bildruta, vänder var 60:e) eller 'idle'. Ger huvudtråden per bildruta (ms), CPU per processtyp (%) och
 * bildrutornas avstånd (ms).
 */
export async function drive({ page, cdp, bcdp }, kind, frames = 240) {
  const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
  const procs = async () => (await bcdp.send('SystemInfo.getProcessInfo')).processInfo;
  const m0 = await metrics();
  const c0 = await procs();
  const t0 = Date.now();
  const deltas = await page.evaluate(([kind, N]) => new Promise((res) => {
    const d = window.__wb.world.debug;
    let cam = d.camera();
    const out = [];
    let last = 0;
    let i = 0;
    requestAnimationFrame(function f(t) {
      if (last) out.push(t - last);
      last = t;
      const dir = Math.floor(i / 60) % 2 === 0 ? 1 : -1;
      if (kind === 'pan') cam = { ...cam, cx: cam.cx + (dir * 6) / cam.zoom };
      else if (kind === 'zoom') cam = { ...cam, zoom: cam.zoom * (dir > 0 ? 1.012 : 1 / 1.012) };
      if (kind !== 'idle') d.setCamera(cam);
      if (++i < N) requestAnimationFrame(f);
      else res(out);
    });
  }), [kind, frames]);
  const sec = (Date.now() - t0) / 1000;
  const c1 = await procs();
  const m1 = await metrics();
  const by = {};
  for (const p of c1) {
    const q = c0.find((x) => x.id === p.id);
    if (q) by[p.type] = (by[p.type] || 0) + ((p.cpuTime - q.cpuTime) / sec) * 100;
  }
  const n = deltas.length;
  const per = (k) => +(((m1[k] - m0[k]) * 1000) / n).toFixed(3);
  return {
    renderer: +(by.renderer || 0).toFixed(1),
    gpu: +(by.GPU || 0).toFixed(1),
    task: per('TaskDuration'),
    script: per('ScriptDuration'),
    style: per('RecalcStyleDuration'),
    layout: per('LayoutDuration'),
    frames: stats(deltas),
  };
}

/** Medel, minsta och största värde för ett mått över körningarna. */
export function spread(runs, key) {
  const v = runs.map((r) => r[key]);
  return { mean: +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(2), min: Math.min(...v), max: Math.max(...v) };
}

export const load = () => os.loadavg().map((x) => +x.toFixed(2));
