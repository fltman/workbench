// voice-gate.ts — avgör om en inspelning är tyst (CONTRACT §12). Ren funktion, enhetstestad mot riktiga ljud.
// Tyst = färre än 10 % av 20 ms-blocken ligger över 4 × brusgolvet. Brusgolvet är 10:e percentilen av
// blockens RMS, räknat bara på block som inte är digital tystnad (MediaRecorder börjar ofta med nollor),
// och aldrig lägre än FLOOR_MIN, så att nästan helt tyst ingång inte gör varje litet brus till "tal".

export const BLOCK_MS = 20;
export const ABOVE_FACTOR = 4;
export const MIN_SHARE = 0.1;
/** −74 dBFS: under detta räknas allt som tystnad även om brusgolvet är ännu lägre. */
export const FLOOR_MIN = 2e-4;
/** Under detta är ett block digital tystnad (nollor eller dither). */
const DIGITAL_SILENCE = 1e-6;

export function blockRms(samples: Float32Array, sampleRate: number, blockMs = BLOCK_MS): Float64Array {
  const n = Math.max(1, Math.round((sampleRate * blockMs) / 1000));
  const count = Math.floor(samples.length / n);
  const out = new Float64Array(count);
  for (let b = 0; b < count; b++) {
    let s = 0;
    for (let i = b * n, end = i + n; i < end; i++) s += samples[i] * samples[i];
    out[b] = Math.sqrt(s / n);
  }
  return out;
}

export interface GateResult {
  silent: boolean;
  blocks: number;
  above: number;
  floor: number;
}

export function speechGate(samples: Float32Array, sampleRate: number): GateResult {
  const rms = blockRms(samples, sampleRate);
  const live = Array.from(rms).filter((v) => v > DIGITAL_SILENCE).sort((a, b) => a - b);
  if (!rms.length || !live.length) return { silent: true, blocks: rms.length, above: 0, floor: 0 };
  const p10 = live[Math.floor((live.length - 1) * 0.1)];
  const floor = Math.max(p10, FLOOR_MIN);
  let above = 0;
  for (const v of rms) if (v > ABOVE_FACTOR * floor) above++;
  return { silent: above < MIN_SHARE * rms.length, blocks: rms.length, above, floor };
}

/** Blanda ned flera kanaler till en. */
export function mixDown(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0];
  const n = Math.min(...channels.map((c) => c.length));
  const out = new Float32Array(n);
  for (const c of channels) for (let i = 0; i < n; i++) out[i] += c[i] / channels.length;
  return out;
}
