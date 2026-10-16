// server/stt.ts — tal till text på servern (CONTRACT §12). Provar WORKBENCH_STT-ordningen:
//   1. whisper: ffmpeg (execFile, childEnv()) gör 16 kHz mono WAV → POST {WHISPER_URL}/inference, 8 s
//   2. openai:  gpt-transcribe med originalfilen (speech.webm/speech.mp4), 20 s
// Texten trimmas; tom text räknas som misslyckad. Fungerar ingen metod kastar transcribe (routen svarar 503).
// OPENAI_API_KEY läses bara här, i serverprocessen; ffmpeg får aldrig nyckeln (childEnv är en vitlista).
import { execFile } from 'node:child_process';
import type { SttResponse } from '../shared/protocol.ts';
import { childEnv } from './config.ts';
import type { Config } from './types.ts';

const VOCABULARY = 'Workbench, HUD, mejlklient, kub, prisma';
/** Whispers prompt rymmer bara en kort text; appnamnen kortas av därefter. */
const PROMPT_MAX = 600;
/** 16 kHz mono 16 bit är 32 kB/s; 64 MB räcker till över en halvtimme. */
const WAV_MAX = 64 * 1024 * 1024;

type Provider = SttResponse['provider'];

/** Ordningen för WORKBENCH_STT. */
export function sttOrder(stt: Config['stt']): Provider[] {
  switch (stt) {
    case 'auto':
      return ['whisper', 'openai'];
    case 'whisper':
      return ['whisper'];
    case 'openai':
      return ['openai'];
    case 'off':
      return [];
  }
}

/** Ordförrådet plus appnamnen (unika, utan tomma), högst PROMPT_MAX tecken. */
export function sttPrompt(hints: string[]): string {
  const names: string[] = [];
  for (const h of hints) {
    const n = h.replace(/\s+/g, ' ').trim();
    if (n && !names.includes(n)) names.push(n);
  }
  let out = VOCABULARY;
  for (const n of names) {
    if (out.length + 2 + n.length > PROMPT_MAX) break;
    out += `, ${n}`;
  }
  return out;
}

/**
 * ffmpeg skriver WAV till en rörledning utan att kunna gå tillbaka och fylla i längderna (0xFFFFFFFF).
 * Här rättas RIFF- och data-längderna efter den faktiska bufferten, så att whisper-servern läser hela ljudet.
 */
export function fixWavHeader(b: Buffer): Buffer {
  if (b.length < 12 || b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WAVE') return b;
  b.writeUInt32LE(b.length - 8, 4);
  let i = 12;
  while (i + 8 <= b.length) {
    const id = b.toString('latin1', i, i + 4);
    const size = b.readUInt32LE(i + 4);
    if (id === 'data') {
      b.writeUInt32LE(b.length - i - 8, i + 4);
      break;
    }
    if (size > b.length) break;
    i += 8 + size + (size & 1);
  }
  return b;
}

/** ffmpeg -i pipe:0 -ar 16000 -ac 1 -f wav pipe:1, via execFile med argv och childEnv(). */
export function toWav(audio: Buffer, signal: AbortSignal, ffmpeg = 'ffmpeg'): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      ffmpeg,
      ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-ar', '16000', '-ac', '1', '-f', 'wav', 'pipe:1'],
      { env: childEnv(), encoding: 'buffer', maxBuffer: WAV_MAX, signal, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          const detail = Buffer.isBuffer(stderr) ? stderr.toString('utf8').trim().split('\n').pop() : '';
          reject(new Error(`ffmpeg: ${detail || err.message}`));
          return;
        }
        resolve(fixWavHeader(stdout));
      },
    );
    // ffmpeg kan sluta läsa tidigt (trasig fil); EPIPE på stdin får inte ta ner servern.
    child.stdin?.on('error', () => {});
    child.stdin?.end(audio);
  });
}

async function readText(r: Response, who: string): Promise<string> {
  if (!r.ok) throw new Error(`${who} svarade ${r.status}`);
  const j = (await r.json()) as { text?: unknown };
  return typeof j.text === 'string' ? j.text.trim() : '';
}

export interface SttProviders {
  whisper(config: Config, audio: Buffer, mime: string, prompt: string): Promise<string>;
  openai(config: Config, audio: Buffer, mime: string, prompt: string): Promise<string>;
}

export interface ProviderOptions {
  whisperTimeoutMs: number;
  openaiTimeoutMs: number;
  openaiUrl: string;
  ffmpeg: string;
}

/** Kontraktets värden (§12). Testerna byter bara tider och adresser, aldrig själva anropen. */
export const DEFAULT_PROVIDER_OPTIONS: ProviderOptions = {
  whisperTimeoutMs: 8_000,
  openaiTimeoutMs: 20_000,
  openaiUrl: 'https://api.openai.com/v1/audio/transcriptions',
  ffmpeg: 'ffmpeg',
};

export function createProviders(overrides: Partial<ProviderOptions> = {}): SttProviders {
  const o = { ...DEFAULT_PROVIDER_OPTIONS, ...overrides };
  return {
    async whisper(config, audio, _mime, prompt) {
      const signal = AbortSignal.timeout(o.whisperTimeoutMs);
      const wav = await toWav(audio, signal, o.ffmpeg);
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'speech.wav');
      form.append('response_format', 'json');
      form.append('temperature', '0');
      form.append('language', 'sv');
      form.append('prompt', prompt);
      const url = `${config.whisperUrl.replace(/\/+$/, '')}/inference`;
      return readText(await fetch(url, { method: 'POST', body: form, signal }), 'whisper');
    },
    async openai(config, audio, mime, prompt) {
      if (!config.openaiKey) throw new Error('OPENAI_API_KEY saknas');
      const ext = mime === 'audio/mp4' ? 'mp4' : 'webm';
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(audio)], { type: mime }), `speech.${ext}`);
      form.append('model', 'gpt-transcribe');
      form.append('languages[]', 'sv');
      form.append('prompt', prompt);
      const r = await fetch(o.openaiUrl, {
        method: 'POST',
        headers: { authorization: `Bearer ${config.openaiKey}` },
        body: form,
        signal: AbortSignal.timeout(o.openaiTimeoutMs),
      });
      return readText(r, 'openai');
    },
  };
}

export async function transcribeWith(
  providers: SttProviders,
  config: Config,
  audio: Buffer,
  mime: string,
  hints: string[],
): Promise<SttResponse> {
  const prompt = sttPrompt(hints);
  const failures: string[] = [];
  for (const provider of sttOrder(config.stt)) {
    try {
      const text = (await providers[provider](config, audio, mime, prompt)).trim();
      if (text) return { text, provider };
      failures.push(`${provider}: tom text`);
    } catch (err) {
      failures.push(`${provider}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(failures.length ? failures.join('; ') : 'tal till text är avstängt');
}

const realProviders = createProviders();

export async function transcribe(config: Config, audio: Buffer, mime: string, hints: string[]): Promise<SttResponse> {
  return transcribeWith(realProviders, config, audio, mime, hints);
}
