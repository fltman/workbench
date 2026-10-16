// tether.ts — linjen mellan appens fönster och dess HUD (CONTRACT §13, §14). Ren geometri, enhetstestad.
// Anders 16 oktober: "det borde dras ett blått streck mellan hud och tillhörande app så att det är glasklart vilken
// app en hud hör till".
import type { ScreenRect } from '../types.ts';

/** Kortare linjer än så ritas inte: då ligger HUD:en redan vid pricken. */
export const TETHER_MIN = 6;

export interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** Var på överlappet linjen går: nära början (överkanten eller vänsterkanten), högst mitt på. */
const pick = (lo: number, hi: number): number => Math.min(lo + 36, (lo + hi) / 2);

/**
 * Kortaste linjen mellan appens fönster a (hörnradie ra) och panelen b (hörnradie rb), kant mot kant, i skärm-px. Den
 * korsar aldrig fönstret eller panelen, som en linje från pricken gjorde när HUD:en låg under fönstret (diagonalt över
 * appen, syntes i demofilmen). Rundade rektanglar är en inre rektangel plus en cirkel, så linjen räknas mellan de inre
 * rektanglarna och kortas med radierna. Överlappar fönstret och panelen i en led står linjen vinkelrätt nära början av
 * överlappet. null när de överlappar, nuddar eller ligger närmare än TETHER_MIN.
 */
export function tetherBetween(a: ScreenRect, ra: number, b: ScreenRect, rb: number): Segment | null {
  const vals = [a.x, a.y, a.w, a.h, b.x, b.y, b.w, b.h, ra, rb];
  if (!vals.every(Number.isFinite)) return null;
  const Ra = Math.max(0, Math.min(ra, a.w / 2, a.h / 2));
  const Rb = Math.max(0, Math.min(rb, b.w / 2, b.h / 2));
  const A = { x0: a.x + Ra, y0: a.y + Ra, x1: a.x + a.w - Ra, y1: a.y + a.h - Ra };
  const B = { x0: b.x + Rb, y0: b.y + Rb, x1: b.x + b.w - Rb, y1: b.y + b.h - Rb };
  const axis = (a0: number, a1: number, b0: number, b1: number): [number, number] => {
    const lo = Math.max(a0, b0);
    const hi = Math.min(a1, b1);
    if (lo <= hi) {
      const v = pick(lo, hi);
      return [v, v];
    }
    return a1 < b0 ? [a1, b0] : [a0, b1];
  };
  const [px, qx] = axis(A.x0, A.x1, B.x0, B.x1);
  const [py, qy] = axis(A.y0, A.y1, B.y0, B.y1);
  const d = Math.hypot(qx - px, qy - py);
  if (d - Ra - Rb < TETHER_MIN) return null;
  const ux = (qx - px) / d;
  const uy = (qy - py) / d;
  return { x1: px + ux * Ra, y1: py + uy * Ra, x2: qx - ux * Rb, y2: qy - uy * Rb };
}
