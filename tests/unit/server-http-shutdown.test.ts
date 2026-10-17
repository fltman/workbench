// Signalerna (CONTRACT §7): första SIGINT/SIGTERM väntar ut pågående turer (tömningen), en andra stänger direkt.
// Hanteraren provas med en injicerad räkning av pågående turer, utan Claude, och sedan i en riktig process med
// riktiga signaler. Kalibrering: den gamla hanteraren i main.ts (stäng vid första signalen) fälls av samma kontroll.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { createSignalHandler, DRAIN_MAX_MS } from '../../server/shutdown.ts';
import type { SignalDeps } from '../../server/shutdown.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Make = (d: SignalDeps) => (signal: string) => void;

/** Den gamla hanteraren i main.ts före tömningen: första signalen stänger, nästa avslutar. Planterat fel. */
const oldHandler: Make = (d) => {
  let stopping = false;
  return () => {
    if (stopping) return;
    stopping = true;
    d.shutdown();
  };
};

function rig(make: Make, o: { busy: number; fake?: boolean; maxWaitMs?: number }) {
  const r = { busy: o.busy, calls: [] as string[], lines: [] as string[] };
  const on = make({
    busy: () => r.busy,
    drain: () => void r.calls.push('drain'),
    shutdown: () => void r.calls.push('shutdown'),
    fake: o.fake ?? false,
    log: (l) => void r.lines.push(l),
    pollMs: 5,
    ...(o.maxWaitMs !== undefined ? { maxWaitMs: o.maxWaitMs } : {}),
  });
  return { r, on };
}

/** Två signaler med en pågående tur: vad som hänt efter den första (och en stund) och efter den andra. */
async function twoSignals(make: Make): Promise<{ first: string[]; second: string[] }> {
  const { r, on } = rig(make, { busy: 1 });
  on('SIGTERM');
  await sleep(40);
  const first = [...r.calls];
  on('SIGTERM');
  await sleep(20);
  return { first, second: [...r.calls] };
}

test('en pågående tur: första signalen väntar och tömmer, den andra stänger direkt (kalibrerat mot den gamla hanteraren)', async () => {
  const now = await twoSignals(createSignalHandler);
  assert.deepEqual(now, { first: ['drain'], second: ['drain', 'shutdown'] });
  // Kalibrering: den gamla hanteraren stängde vid första signalen, mitt i turen.
  const old = await twoSignals(oldHandler);
  assert.deepEqual(old.first, ['shutdown'], 'den gamla hanteraren ska fällas av kontrollen ovan');
});

test('turerna blir klara: avslutet startar då, en gång, och en sen signal gör inget mer', async () => {
  const { r, on } = rig(createSignalHandler, { busy: 2 });
  on('SIGINT');
  await sleep(30);
  assert.deepEqual(r.calls, ['drain']);
  r.busy = 1;
  await sleep(30);
  assert.deepEqual(r.calls, ['drain'], 'en tur pågår fortfarande');
  r.busy = 0;
  await sleep(30);
  assert.deepEqual(r.calls, ['drain', 'shutdown']);
  on('SIGTERM');
  await sleep(20);
  assert.deepEqual(r.calls, ['drain', 'shutdown'], 'avslutet anropas bara en gång');
});

test('raden säger hur många turer och att en signal till stänger direkt', async () => {
  const one = rig(createSignalHandler, { busy: 1 });
  one.on('SIGTERM');
  const two = rig(createSignalHandler, { busy: 2 });
  two.on('SIGINT');
  await sleep(10);
  assert.deepEqual(one.r.lines, ['[workbench] SIGTERM: väntar på 1 pågående tur innan servern stänger (högst 15 min, en signal till stänger direkt)']);
  assert.deepEqual(two.r.lines, ['[workbench] SIGINT: väntar på 2 pågående turer innan servern stänger (högst 15 min, en signal till stänger direkt)']);
  two.on('SIGINT');
  one.r.busy = 0;
  await sleep(20);
  assert.deepEqual(two.r.lines.at(-1), '[workbench] SIGINT: stänger utan att vänta på turerna');
});

test('inget pågår: stänger direkt; med låtsas-Claude stänger servern direkt även när något pågår', () => {
  const idle = rig(createSignalHandler, { busy: 0 });
  idle.on('SIGTERM');
  assert.deepEqual(idle.r.calls, ['shutdown']);
  assert.deepEqual(idle.r.lines, ['[workbench] SIGTERM: stänger']);
  const fake = rig(createSignalHandler, { busy: 3, fake: true });
  fake.on('SIGTERM');
  assert.deepEqual(fake.r.calls, ['shutdown'], 'testerna räknar med snabba avslut');
});

test('högst 15 min: en tur som hänger stoppar inte avslutet för alltid', async () => {
  assert.equal(DRAIN_MAX_MS, 15 * 60_000);
  const { r, on } = rig(createSignalHandler, { busy: 1, maxWaitMs: 40 });
  on('SIGTERM');
  await sleep(15);
  assert.deepEqual(r.calls, ['drain']);
  await sleep(80);
  assert.deepEqual(r.calls, ['drain', 'shutdown']);
});

/* I en riktig process: riktiga signaler till en nodeprocess som kopplar hanteraren som main.ts gör. */

const CHILD = `
import { createSignalHandler } from ${JSON.stringify(path.resolve(import.meta.dirname, '../../server/shutdown.ts'))};
const t0 = Date.now();
let busy = 1;
setTimeout(() => (busy = 0), Number(process.env.BUSY_MS));
let stopping = false;
const on = createSignalHandler({
  busy: () => busy,
  drain: () => {},
  shutdown: () => { stopping = true; console.log('shutdown ' + (Date.now() - t0)); setTimeout(() => process.exit(0), 5); },
  fake: false,
  log: (l) => console.log(l),
  pollMs: 10,
});
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { if (stopping) process.exit(1); on(s); });
console.log('ready');
setInterval(() => {}, 1000);
`;

/** Startar barnet, skickar signalerna med mellanrum och ger tiden till avslutet (ms sedan första signalen). */
function childRun(busyMs: number, signals: number): Promise<{ ms: number; out: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', CHILD], { env: { PATH: process.env.PATH ?? '', BUSY_MS: String(busyMs) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let sentAt = 0;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`barnet avslutades inte: ${out}`));
    }, 10_000);
    child.stdout.on('data', (d) => {
      out += String(d);
      if (sentAt || !out.includes('ready')) return;
      sentAt = Date.now();
      for (let i = 0; i < signals; i++) setTimeout(() => child.kill('SIGTERM'), 20 * i);
    });
    child.stderr.on('data', (d) => (out += String(d)));
    child.on('error', reject);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ ms: Date.now() - sentAt, out, code });
    });
  });
}

test('i en riktig process: en SIGTERM väntar ut turen, två stänger direkt', { timeout: 30_000 }, async () => {
  const one = await childRun(600, 1);
  assert.match(one.out, /väntar på 1 pågående tur/);
  assert.ok(one.ms >= 550, `en signal: avslutet kom efter ${one.ms} ms, före turens slut (600 ms)`);
  assert.equal(one.code, 0);
  const two = await childRun(600, 2);
  assert.match(two.out, /stänger utan att vänta/);
  assert.ok(two.ms < 400, `två signaler: avslutet dröjde ${two.ms} ms`);
  assert.equal(two.code, 0);
});
