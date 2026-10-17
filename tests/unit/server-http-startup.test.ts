// Startraderna (CONTRACT §7): servern säger när den startar att /usr/bin/sandbox-exec eller ffmpeg saknas, i stället
// för att det märks först när en app startar en backend (en varning per app) eller när någon talar ("Kunde inte
// tolka talet"). Servern körs på riktigt: produktionsläge (utan Vite), låtsas-Claude, lediga portar, tillfälligt hem.
// Att sandbox-exec saknas planteras med en förladdning som får fs.existsSync att svara nej för just den sökvägen,
// och att ffmpeg saknas med en PATH utan den. Fallen utan rad kalibreras av fallen med rad.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { testPort } from '../ports.ts';
import { REPO, rmDir, tempDir } from './server-http-fakes.test.ts';

const SANDBOX_LINE = '[workbench] /usr/bin/sandbox-exec saknas: backends och Claudes Bash körs utan sandlåda';
const FFMPEG_LINE = '[workbench] ffmpeg saknas i PATH: tal till text kan inte gå via Whisper';
/** Lika länge som fallen utan rad väntar efter adressraden; fallen med rad visar att raderna hinner fram långt före. */
const GRACE_MS = 500;
const NO_SANDBOX_EXEC = `--import=data:text/javascript,${encodeURIComponent(
  "import fs from 'node:fs'; const real = fs.existsSync; fs.existsSync = (p) => (p === '/usr/bin/sandbox-exec' ? false : real(p));",
)}`;
const HAS_SANDBOX = process.platform === 'darwin' && fs.existsSync('/usr/bin/sandbox-exec');

interface Boot {
  out: string;
  /** ms från adressraden till varje startrad, om den kom */
  delays: Map<string, number>;
}

let dir: string;
let empty: string;
let withFfmpeg: string;

/** Startar servern, väntar in adressraden och GRACE_MS till, stänger den och ger det den skrev. */
async function boot(env: Record<string, string>, opts: { noSandboxExec?: boolean } = {}): Promise<Boot> {
  const port = await testPort();
  const home = fs.mkdtempSync(path.join(dir, 'hem-'));
  const child = spawn(process.execPath, [...(opts.noSandboxExec ? [NO_SANDBOX_EXEC] : []), path.join(REPO, 'server/main.ts')], {
    cwd: REPO,
    env: {
      HOME: process.env.HOME ?? '',
      TMPDIR: process.env.TMPDIR ?? '',
      NODE_ENV: 'production',
      WORKBENCH_PORT: String(port),
      WORKBENCH_HMR_PORT: String(await testPort()),
      WORKBENCH_HOME: home,
      WORKBENCH_FAKE_CLAUDE: '1',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let urlAt = 0;
  const seen = new Map<string, number>();
  const url = `[workbench] http://localhost:${port}`;
  const ready = new Promise<void>((resolve, reject) => {
    const onData = (d: Buffer): void => {
      out += String(d);
      const now = Date.now();
      if (!urlAt && out.includes(url)) urlAt = now;
      for (const line of [SANDBOX_LINE, FFMPEG_LINE]) if (!seen.has(line) && out.includes(line)) seen.set(line, now);
      if (urlAt) resolve();
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', (code) => reject(new Error(`servern avslutades (${code}) före adressraden:\n${out}`)));
    setTimeout(() => reject(new Error(`ingen adressrad på 20 s:\n${out}`)), 20_000).unref();
  });
  try {
    await ready;
    await new Promise((r) => setTimeout(r, GRACE_MS));
  } finally {
    if (child.exitCode === null) {
      const exited = new Promise((r) => child.once('exit', r));
      child.kill('SIGTERM');
      const t = setTimeout(() => child.kill('SIGKILL'), 10_000);
      await exited;
      clearTimeout(t);
    }
  }
  const delays = new Map([...seen].map(([line, at]) => [line, Math.max(0, at - urlAt)]));
  return { out, delays };
}

describe('startraderna om sandbox-exec och ffmpeg', { timeout: 120_000 }, () => {
  before(() => {
    dir = tempDir('startup');
    empty = path.join(dir, 'tom-bin');
    withFfmpeg = path.join(dir, 'ffmpeg-bin');
    fs.mkdirSync(empty);
    fs.mkdirSync(withFfmpeg);
    fs.writeFileSync(path.join(withFfmpeg, 'ffmpeg'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  });
  after(() => rmDir(dir));

  test('båda saknas: en rad om var efter adressraden', { timeout: 60_000 }, async (t) => {
    const b = await boot({ PATH: empty, WORKBENCH_STT: 'auto' }, { noSandboxExec: true });
    assert.ok(b.delays.has(SANDBOX_LINE), `ingen rad om sandbox-exec:\n${b.out}`);
    assert.ok(b.delays.has(FFMPEG_LINE), `ingen rad om ffmpeg:\n${b.out}`);
    t.diagnostic(`efter adressraden: ${[...b.delays.values()].join(' och ')} ms`);
    for (const [line, ms] of b.delays) assert.ok(ms < GRACE_MS / 2, `${line} kom ${ms} ms efter adressraden`);
  });

  test('allt finns: inga rader (kalibrerat av fallet ovan)', { timeout: 60_000 }, async () => {
    const b = await boot({ PATH: withFfmpeg, WORKBENCH_STT: 'whisper' });
    assert.ok(!b.out.includes(FFMPEG_LINE), b.out);
    if (HAS_SANDBOX) assert.ok(!b.out.includes(SANDBOX_LINE), b.out);
  });

  test('sandlådan avstängd och tal till text utan whisper: inga rader, fast båda saknas', { timeout: 60_000 }, async () => {
    for (const stt of ['openai', 'off']) {
      const b = await boot({ PATH: empty, WORKBENCH_STT: stt, WORKBENCH_SANDBOX: '0' }, { noSandboxExec: true });
      assert.ok(!b.out.includes(FFMPEG_LINE), `${stt}:\n${b.out}`);
      assert.ok(!b.out.includes(SANDBOX_LINE), `${stt}:\n${b.out}`);
    }
  });
});
