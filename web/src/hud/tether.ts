// tether.ts — linjen mellan appens prick och dess HUD (CONTRACT §14). Ren geometri, enhetstestad.
// Anders 16 oktober: "det borde dras ett blått streck mellan hud och tillhörande app så att det är glasklart vilken
// app en hud hör till".
import type { ScreenRect } from '../types.ts';

/** Linjen börjar så här långt från prickens mitt, utanför kärnan, så att pricken syns. */
export const TETHER_FROM_DOT = 8;
/** Kortare linjer än så ritas inte: då ligger HUD:en redan vid pricken. */
export const TETHER_MIN = 6;

export interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/**
 * Från pricken d till närmaste punkt på panelens rundade rektangel r (hörnradie rad), i skärm-px. Ligger pricken
 * utanför vyn går linjen ut ur bild mot den, så att det syns åt vilket håll appen ligger. null när pricken saknas,
 * när den ligger i panelen och när HUD:en ligger så nära att ingen linje behövs.
 */
export function tetherSegment(d: { x: number; y: number } | null, r: ScreenRect, rad: number): Segment | null {
  if (!d || !Number.isFinite(d.x) || !Number.isFinite(d.y)) return null;
  // Den rundade rektangeln är den inre rektangeln (krympt med radien) plus en cirkel: närmaste punkt på den inre,
  // sedan radien ut mot pricken.
  const R = Math.max(0, Math.min(rad, r.w / 2, r.h / 2));
  const ix = clamp(d.x, r.x + R, r.x + r.w - R);
  const iy = clamp(d.y, r.y + R, r.y + r.h - R);
  const dist = Math.hypot(d.x - ix, d.y - iy);
  if (dist <= R) return null;
  const ux = (d.x - ix) / dist;
  const uy = (d.y - iy) / dist;
  if (dist - R < TETHER_FROM_DOT + TETHER_MIN) return null;
  return { x1: d.x - ux * TETHER_FROM_DOT, y1: d.y - uy * TETHER_FROM_DOT, x2: ix + ux * R, y2: iy + uy * R };
}
