// Tal till text på servern (CONTRACT §12). Inga riktiga anrop: whisper och OpenAI är lokala fejkservrar,
// men ffmpeg är den riktiga. Att nyckeln aldrig når ffmpeg kalibreras mot en planterad läcka.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { Config } from '../../server/types.ts';
import { createProviders, fixWavHeader, sttOrder, sttPrompt, toWav, transcribeWith } from '../../server/stt.ts';
import type { SttProviders } from '../../server/stt.ts';
import { makeConfig, rmDir, tempDir } from './server-http-fakes.test.ts';

const VOCAB = 'Workbench, HUD, mejlklient, kub, prisma';

describe('ordning och prompt', () => {
  test('WORKBENCH_STT', () => {
    assert.deepEqual(sttOrder('auto'), ['whisper', 'openai']);
    assert.deepEqual(sttOrder('whisper'), ['whisper']);
    assert.deepEqual(sttOrder('openai'), ['openai']);
    assert.deepEqual(sttOrder('off'), []);
  });
  test('ordförrådet plus unika appnamn, högst 600 tecken', () => {
    assert.equal(sttPrompt([]), VOCAB);
    assert.equal(sttPrompt(['Mejl', '', '  ', 'Mejl', 'Kalender  ', 'Öl  lista']), `${VOCAB}, Mejl, Kalender, Öl lista`);
    const many = sttPrompt(Array.from({ length: 200 }, (_, i) => `Appen nummer ${i}`));
    assert.ok(many.length <= 600);
    assert.ok(many.startsWith(VOCAB));
  });
});

describe('transcribeWith: reserver och tom text', () => {
  const home = tempDir('sttcfg');
  const base = makeConfig(home);
  after(() => rmDir(home));
  const cfg = (stt: Config['stt']): Config => ({ ...base, stt });
  const fake = (w: () => Promise<string>, o: () => Promise<string>): SttProviders & { calls: string[] } => {
    const calls: string[] = [];
    return {
      calls,
      whisper: async () => {
        calls.push('whisper');
        return w();
      },
      openai: async () => {
        calls.push('openai');
        return o();
      },
    };
  };
  const audio = Buffer.from('x');

  test('whisper först; texten trimmas', async () => {
    const p = fake(async () => '  Jag vill ha en mejlklient.\n', async () => 'fel');
    assert.deepEqual(await transcribeWith(p, cfg('auto'), audio, 'audio/webm', []), { text: 'Jag vill ha en mejlklient.', provider: 'whisper' });
    assert.deepEqual(p.calls, ['whisper']);
  });
  test('tom text eller fel hos whisper: OpenAI', async () => {
    let p = fake(async () => '   ', async () => 'Hej');
    assert.deepEqual(await transcribeWith(p, cfg('auto'), audio, 'audio/webm', []), { text: 'Hej', provider: 'openai' });
    p = fake(async () => {
      throw new Error('nere');
    }, async () => 'Hej');
    assert.deepEqual(await transcribeWith(p, cfg('auto'), audio, 'audio/webm', []), { text: 'Hej', provider: 'openai' });
  });
  test('inget fungerar, eller off: kastar', async () => {
    const p = fake(async () => '', async () => {
      throw new Error('openai nere');
    });
    await assert.rejects(transcribeWith(p, cfg('auto'), audio, 'audio/webm', []), /whisper: tom text; openai: openai nere/);
    await assert.rejects(transcribeWith(p, cfg('off'), audio, 'audio/webm', []), /avstängt/);
    const q = fake(async () => 'Hej', async () => 'Hej');
    await assert.rejects(transcribeWith(q, cfg('off'), audio, 'audio/webm', []));
    assert.deepEqual(q.calls, []);
    assert.deepEqual((await transcribeWith(q, cfg('openai'), audio, 'audio/webm', [])).provider, 'openai');
    assert.deepEqual(q.calls, ['openai']);
  });
});

/* ------------------------------ riktig ffmpeg, fejkade tjänster ------------------------------ */

interface Seen {
  path: string;
  headers: http.IncomingHttpHeaders;
  form: FormData;
}

function fakeService(reply: (seen: Seen) => { status: number; body: unknown } | null): Promise<{ url: string; seen: Seen[]; close(): Promise<void> }> {
  const seen: Seen[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const form = await new Response(Buffer.concat(chunks), { headers: { 'content-type': String(req.headers['content-type']) } }).formData();
    const s: Seen = { path: req.url ?? '', headers: req.headers, form };
    seen.push(s);
    const r = reply(s);
    if (!r) return; // svarar aldrig (tidsgräns)
    res.writeHead(r.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(r.body));
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
        seen,
        close: () => {
          server.closeAllConnections();
          return new Promise<void>((r) => server.close(() => r()));
        },
      }),
    ),
  );
}

describe('leverantörerna mot lokala fejkservrar', () => {
  let dir: string;
  let webm: Buffer;
  before(() => {
    dir = tempDir('stt');
    // 0,6 s ton som webm/opus, som MediaRecorder skulle skicka.
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.6', '-c:a', 'libopus', '-b:a', '32k', path.join(dir, 'ton.webm')]);
    webm = fs.readFileSync(path.join(dir, 'ton.webm'));
  });
  after(() => rmDir(dir));

  test('toWav: 16 kHz mono WAV med rättade längder (ffmpeg skriver 0xFFFFFFFF till en rörledning)', async () => {
    const wav = await toWav(webm, AbortSignal.timeout(5000));
    assert.equal(wav.toString('latin1', 0, 4), 'RIFF');
    assert.equal(wav.readUInt32LE(4), wav.length - 8);
    assert.equal(wav.readUInt16LE(22), 1, 'kanaler');
    assert.equal(wav.readUInt32LE(24), 16000, 'samplingsfrekvens');
    const dataAt = wav.indexOf('data', 12, 'latin1');
    assert.ok(dataAt > 0);
    assert.equal(wav.readUInt32LE(dataAt + 4), wav.length - dataAt - 8);
    // 0,6 s * 16000 * 2 byte ≈ 19 200 byte ljud.
    assert.ok(Math.abs(wav.readUInt32LE(dataAt + 4) - 19200) < 2000);
  });

  test('fixWavHeader rör inte annat än RIFF/WAVE', () => {
    const other = Buffer.from('inte en wav-fil');
    assert.equal(fixWavHeader(Buffer.from(other)).toString(), 'inte en wav-fil');
  });

  test('whisper: /inference med speech.wav, json, temperature 0, sv och prompten med appnamnen', async () => {
    const svc = await fakeService(() => ({ status: 200, body: { text: ' Jag vill ha en mejlklient.\n' } }));
    try {
      const config: Config = { ...makeConfig(dir), whisperUrl: `${svc.url}/`, stt: 'whisper' };
      const r = await transcribeWith(createProviders(), config, webm, 'audio/webm', ['Kalender']);
      assert.deepEqual(r, { text: 'Jag vill ha en mejlklient.', provider: 'whisper' });
      const s = svc.seen[0];
      assert.equal(s.path, '/inference');
      const file = s.form.get('file') as File;
      assert.equal(file.name, 'speech.wav');
      assert.equal(file.type, 'audio/wav');
      assert.equal(Buffer.from(await file.arrayBuffer()).toString('latin1', 0, 4), 'RIFF');
      assert.equal(s.form.get('response_format'), 'json');
      assert.equal(s.form.get('temperature'), '0');
      assert.equal(s.form.get('language'), 'sv');
      assert.equal(s.form.get('prompt'), `${VOCAB}, Kalender`);
    } finally {
      await svc.close();
    }
  });

  test('openai: gpt-transcribe, speech.webm/speech.mp4, languages[]=sv, samma prompt och Bearer-nyckeln', async () => {
    const svc = await fakeService(() => ({ status: 200, body: { text: 'Hej då' } }));
    try {
      const config: Config = { ...makeConfig(dir), openaiKey: 'test-nyckel', stt: 'openai' };
      const providers = createProviders({ openaiUrl: `${svc.url}/v1/audio/transcriptions` });
      assert.deepEqual(await transcribeWith(providers, config, webm, 'audio/webm', ['Mejl']), { text: 'Hej då', provider: 'openai' });
      await transcribeWith(providers, config, Buffer.from('mp4'), 'audio/mp4', []);
      const [a, b] = svc.seen;
      assert.equal(a.headers.authorization, 'Bearer test-nyckel');
      assert.equal(a.path, '/v1/audio/transcriptions');
      assert.equal((a.form.get('file') as File).name, 'speech.webm');
      assert.equal((a.form.get('file') as File).type, 'audio/webm');
      assert.equal((a.form.get('file') as File).size, webm.length);
      assert.equal(a.form.get('model'), 'gpt-transcribe');
      assert.deepEqual(a.form.getAll('languages[]'), ['sv']);
      assert.equal(a.form.get('prompt'), `${VOCAB}, Mejl`);
      assert.equal((b.form.get('file') as File).name, 'speech.mp4');
      assert.equal((b.form.get('file') as File).type, 'audio/mp4');
    } finally {
      await svc.close();
    }
  });

  test('utan nyckel anropas OpenAI aldrig', async () => {
    const svc = await fakeService(() => ({ status: 200, body: { text: 'x' } }));
    try {
      const config: Config = { ...makeConfig(dir), openaiKey: undefined, stt: 'openai' };
      await assert.rejects(transcribeWith(createProviders({ openaiUrl: svc.url }), config, webm, 'audio/webm', []), /OPENAI_API_KEY saknas/);
      assert.equal(svc.seen.length, 0);
    } finally {
      await svc.close();
    }
  });

  test('whisper som aldrig svarar: tidsgränsen löser ut och OpenAI tar över', async () => {
    const slow = await fakeService(() => null);
    const oa = await fakeService(() => ({ status: 200, body: { text: 'Reserv' } }));
    try {
      const config: Config = { ...makeConfig(dir), whisperUrl: slow.url, openaiKey: 'k', stt: 'auto' };
      const t0 = Date.now();
      const r = await transcribeWith(createProviders({ whisperTimeoutMs: 400, openaiUrl: oa.url }), config, webm, 'audio/webm', []);
      assert.deepEqual(r, { text: 'Reserv', provider: 'openai' });
      assert.ok(Date.now() - t0 < 3000);
      assert.equal(slow.seen.length, 1);
    } finally {
      await slow.close();
      await oa.close();
    }
  });

  test('whisper svarar fel eller ffmpeg får skräp: OpenAI tar över', async () => {
    const bad = await fakeService(() => ({ status: 500, body: { error: 'x' } }));
    const oa = await fakeService(() => ({ status: 200, body: { text: 'Reserv' } }));
    try {
      const config: Config = { ...makeConfig(dir), whisperUrl: bad.url, openaiKey: 'k', stt: 'auto' };
      const p = createProviders({ openaiUrl: oa.url });
      assert.equal((await transcribeWith(p, config, webm, 'audio/webm', [])).provider, 'openai');
      assert.equal((await transcribeWith(p, config, Buffer.from('skräp, inget ljud'), 'audio/webm', [])).provider, 'openai');
      assert.equal(bad.seen.length, 1, 'skräpet skickades aldrig till whisper');
    } finally {
      await bad.close();
      await oa.close();
    }
  });
});

describe('OPENAI_API_KEY når aldrig ffmpeg (childEnv)', () => {
  let dir: string;
  let fake: string;
  const PLANTED = 'sk-planterad-testnyckel';
  before(() => {
    dir = tempDir('sttenv');
    fake = path.join(dir, 'fake-ffmpeg.mjs');
    // Skriver bara variabelnamnen och om den planterade nyckeln finns, aldrig några värden.
    fs.writeFileSync(
      fake,
      '#!/usr/bin/env node\nprocess.stdin.resume();\nprocess.stdin.on("end", () => process.stdout.write(JSON.stringify({ names: Object.keys(process.env), planted: process.env.OPENAI_API_KEY === ' +
        JSON.stringify(PLANTED) + ' })));\n',
    );
    fs.chmodSync(fake, 0o755);
  });
  after(() => rmDir(dir));

  const leaks = (out: string): boolean => {
    const r = JSON.parse(out) as { names: string[]; planted: boolean };
    return r.planted || r.names.includes('OPENAI_API_KEY');
  };

  test('kalibrering, sedan den riktiga vägen', async () => {
    const saved = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = PLANTED;
    try {
      // Planterad läcka: samma program med hela process.env.
      const planted = await new Promise<string>((resolve, reject) => {
        const c = execFile(fake, [], { env: process.env }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
        c.stdin?.end('x');
      });
      assert.equal(leaks(planted), true, 'detektorn larmar inte på den planterade läckan');
      const real = (await toWav(Buffer.from('x'), AbortSignal.timeout(5000), fake)).toString('utf8');
      assert.equal(leaks(real), false, 'OPENAI_API_KEY nådde ffmpeg');
      const names = (JSON.parse(real) as { names: string[] }).names.filter((n) => !n.startsWith('__CF'));
      const allowed = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TERM']);
      assert.deepEqual(names.filter((n) => !allowed.has(n)), [], 'ffmpeg fick variabler utanför vitlistan');
    } finally {
      if (saved === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = saved;
    }
  });
});
