// tokens.ts — läser designtokens ur tokens.css (CONTRACT §14) en gång vid start, med reservvärden.
// Fjädrarna finns både som CSS-kurvor (för WAAPI) och som funktioner (för rörelser som drivs per bildruta).
import { parseLinearEasing, parseMs } from './math.ts';

export interface Easing {
  css: string;
  ms: number;
  fn: (t: number) => number;
}

export interface Tokens {
  soft: Easing;
  pop: Easing;
  calm: Easing;
  snap: string;
  winRadius: number;
  dotBreathMs: number;
  canvasCenter: [number, number, number];
  canvasEdge: [number, number, number];
  gridSpacing: number;
  gridDarken: number;
}

/** "#b0b3b8" → [0,69, 0,70, 0,72] (sRGB 0..1). */
export function parseHex(src: string, fallback: [number, number, number]): [number, number, number] {
  const m = /^\s*#([0-9a-f]{6})\s*$/i.exec(src);
  if (!m) return fallback;
  const v = parseInt(m[1], 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

export function parseNum(src: string, fallback: number): number {
  const v = parseFloat(src);
  return Number.isFinite(v) ? v : fallback;
}

const FALLBACK_SOFT =
  'linear(0, 0.0978, 0.3033, 0.5241, 0.7195, 0.8645, 0.9612, 1.0176, 1.0427, 1.0483, 1.0428, 1.0328, 1.0221, 1.0129, 1.0061, 1.0015, 0.999, 0.9979, 0.9977, 0.998, 0.9985, 0.999, 0.9994, 0.9997, 1)';
const FALLBACK_POP =
  'linear(0, 0.146, 0.4423, 0.7493, 0.977, 1.1064, 1.1496, 1.1351, 1.092, 1.0456, 1.0088, 0.9865, 0.9779, 0.9789, 0.9848, 0.9919, 0.9978, 1.0016, 1.0032, 1.0033, 1.0025, 1.0014, 1.0005, 0.9998, 1)';
const FALLBACK_CALM =
  'linear(0, 0.0641, 0.1976, 0.3452, 0.4859, 0.6051, 0.7026, 0.7805, 0.8393, 0.8837, 0.9171, 0.9411, 0.9587, 0.971, 0.9799, 0.9861, 0.9905, 0.9935, 0.9956, 0.997, 0.998, 0.9987, 0.9991, 0.9994, 1)';

function easing(get: (n: string) => string, name: string, fallbackCss: string, fallbackMs: number): Easing {
  let css = get(`--wb-spring-${name}`);
  let fn = parseLinearEasing(css);
  if (!fn) {
    css = fallbackCss;
    fn = parseLinearEasing(css) as (t: number) => number;
  }
  return { css, fn, ms: parseMs(get(`--wb-spring-${name}-ms`), fallbackMs) };
}

/**
 * prefers-reduced-motion: reduce (FE-9). Läses vid varje anrop, så att en ändrad inställning gäller direkt.
 * Då rör sig inget i världen av sig självt: inga skalningar, ingen oskärpa, inga flygningar eller snurr.
 * Toningar (opacitet) står kvar, eftersom de inte rör sig.
 */
export function reducedMotion(): boolean {
  try {
    return matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

export function readTokens(root: Element = document.documentElement): Tokens {
  const cs = getComputedStyle(root);
  const get = (n: string): string => cs.getPropertyValue(n).trim();
  return {
    soft: easing(get, 'soft', FALLBACK_SOFT, 773),
    pop: easing(get, 'pop', FALLBACK_POP, 771),
    calm: easing(get, 'calm', FALLBACK_CALM, 785),
    snap: get('--wb-ease-snap') || 'cubic-bezier(0.77, 0, 0.175, 1)',
    winRadius: parseNum(get('--wb-win-radius'), 16),
    dotBreathMs: parseMs(get('--wb-dot-breath'), 3200),
    canvasCenter: parseHex(get('--wb-canvas-center'), [0xb0 / 255, 0xb3 / 255, 0xb8 / 255]),
    canvasEdge: parseHex(get('--wb-canvas-edge'), [0x85 / 255, 0x88 / 255, 0x8e / 255]),
    gridSpacing: parseNum(get('--wb-grid-spacing'), 24),
    gridDarken: parseNum(get('--wb-grid-darken'), 0.085),
  };
}
