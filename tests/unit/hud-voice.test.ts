// hud-voice.test.ts — rösten i HUD:en (CONTRACT §12): tystnadsgrinden och valet av svensk röst.
// Grinden kalibreras mot riktiga ljud (macOS say + ffmpeg när de finns) och mot en planterad naiv grind
// som måste släppa igenom rumsbrus, så att testet visar att det kan fällas.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { blockRms, speechGate } from '../../web/src/hud/voice-gate.ts';
import { pickSwedishVoice, voiceScore } from '../../web/src/hud/tts.ts';

const RATE = 48_000;

function has(cmd: string): boolean {
  try {
    execFileSync('/usr/bin/which', [cmd], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Avkoda en ljudfil till mono float32 i 48 kHz med ffmpeg. */
function decode(file: string): Float32Array {
  const raw = execFileSync('ffmpeg', ['-v', 'quiet', '-i', file, '-ac', '1', '-ar', String(RATE), '-f', 'f32le', 'pipe:1'], {
    maxBuffer: 64 << 20,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
}

/** Deterministiskt brus (Box–Muller med en enkel LCG), rms ungefär `level`. */
function noise(seconds: number, level: number, seed = 7): Float32Array {
  const n = Math.round(seconds * RATE);
  const out = new Float32Array(n);
  let s = seed;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) + 0.5) / 2 ** 32;
  for (let i = 0; i < n; i += 2) {
    const r = Math.sqrt(-2 * Math.log(rnd()));
    const a = 2 * Math.PI * rnd();
    out[i] = level * r * Math.cos(a);
    if (i + 1 < n) out[i + 1] = level * r * Math.sin(a);
  }
  return out;
}

/** "Tal": stavelser av amplitudmodulerat brus med pauser emellan, ovanpå rumsbrus. */
function syllables(seconds: number): Float32Array {
  const base = noise(seconds, 0.001, 3);
  const voice = noise(seconds, 0.08, 11);
  for (let i = 0; i < base.length; i++) {
    const t = i / RATE;
    const env = Math.max(0, Math.sin(2 * Math.PI * 3.2 * t)) ** 2 * (Math.floor(t * 1.6) % 3 === 2 ? 0 : 1);
    base[i] += voice[i] * env;
  }
  return base;
}

const concat = (...parts: Float32Array[]) => {
  const out = new Float32Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

/** En planterad, naiv grind: "något ljud alls" räknas som tal. Ska fällas av rumsbrus. */
const naiveSilent = (s: Float32Array) => !s.some((v) => Math.abs(v) > 1e-6);

test('blockRms: 20 ms-block, rätt nivå för en känd sinus', () => {
  const n = RATE; // 1 s
  const sine = new Float32Array(n).map((_, i) => 0.5 * Math.sin((2 * Math.PI * 440 * i) / RATE));
  const rms = blockRms(sine, RATE);
  assert.equal(rms.length, 50);
  for (const v of rms) assert.ok(Math.abs(v - 0.5 / Math.SQRT2) < 0.01, String(v));
});

test('grinden: digital tystnad och rumsbrus kastas, stavelser släpps igenom', () => {
  assert.equal(speechGate(new Float32Array(RATE * 2), RATE).silent, true);
  assert.equal(speechGate(noise(2, 0.001), RATE).silent, true, 'rumsbrus −60 dBFS');
  assert.equal(speechGate(noise(2, 0.02), RATE).silent, true, 'högre jämnt brus är också tyst (relativt brusgolvet)');
  assert.equal(speechGate(syllables(2), RATE).silent, false);
});

test('grinden: MediaRecorders inledande nollor gör inte rumsbrus till tal', () => {
  const recording = concat(new Float32Array(Math.round(0.4 * RATE)), noise(1.6, 0.001));
  assert.equal(speechGate(recording, RATE).silent, true);
  const speech = concat(new Float32Array(Math.round(0.4 * RATE)), syllables(1.6));
  assert.equal(speechGate(speech, RATE).silent, false);
});

test('kalibrering: den naiva grinden fälls av rumsbrus (testet kan alltså se en läcka)', () => {
  assert.equal(naiveSilent(noise(2, 0.001)), false, 'den naiva grinden släpper igenom brus');
  assert.equal(speechGate(noise(2, 0.001), RATE).silent, true, 'den riktiga gör det inte');
});

test('grinden mot riktiga ljud: svenskt tal (Alva) släpps igenom, tystnad och brus från ffmpeg kastas', { skip: !(has('say') && has('ffmpeg')) && 'kräver macOS say och ffmpeg' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-voice-'));
  try {
    const aiff = path.join(dir, 'tal.aiff');
    execFileSync('say', ['-v', 'Alva', 'Jag vill ha en enkel klocka', '-o', aiff]);
    const webm = path.join(dir, 'tal.webm');
    // Samma kodning som MediaRecorder i HUD:en: opus 32 kbps.
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', aiff, '-ar', '48000', '-ac', '1', '-c:a', 'libopus', '-b:a', '32k', webm]);
    const speech = speechGate(decode(webm), RATE);
    assert.equal(speech.silent, false, JSON.stringify(speech));
    assert.ok(speech.above / speech.blocks > 0.3);
    const quiet = path.join(dir, 'brus.webm');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'anoisesrc=a=0.0015:c=pink:r=48000:d=2', '-c:a', 'libopus', '-b:a', '32k', quiet]);
    assert.equal(speechGate(decode(quiet), RATE).silent, true);
    const mute = path.join(dir, 'tyst.webm');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono', '-t', '2', '-c:a', 'libopus', '-b:a', '32k', mute]);
    assert.equal(speechGate(decode(mute), RATE).silent, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('röstvalet: Tilde/Axel premium före Alva, svenska före allt annat', () => {
  const v = (name: string, lang = 'sv-SE', localService = true) => ({ name, lang, localService });
  assert.equal(pickSwedishVoice([v('Alva'), v('Tilde (Premium)'), v('Samantha', 'en-US')])?.name, 'Tilde (Premium)');
  assert.equal(pickSwedishVoice([v('Alva'), v('Axel (Förbättrad)'), v('Klara')])?.name, 'Axel (Förbättrad)');
  assert.equal(pickSwedishVoice([v('Klara'), v('Alva'), v('Oskar', 'sv_SE', false)])?.name, 'Alva');
  assert.equal(pickSwedishVoice([v('Alva (Enhanced)'), v('Alva')])?.name, 'Alva (Enhanced)');
  assert.equal(pickSwedishVoice([v('Samantha', 'en-US'), v('Nora', 'nb-NO')]), null);
  assert.equal(voiceScore(v('Daniel', 'en-GB')), -1);
});
