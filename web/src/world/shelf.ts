// shelf.ts — raden med minimerade appar i nedre vänstra hörnet (CONTRACT §10.7). Ren geometri, enhetstestad.
// Anders 16 oktober: "man borde kunna minimera appar på något coolt sätt t.ex att dom roterar och glider ner på rad
// i det vänstra hörnet".
import { clamp, easeOutCubic } from './math.ts';

/** En minimerad app är en levande miniatyr av sig själv, så här hög på skärmen (skärm-px). */
export const TILE_H = 84;
/** Breda fönster blir högst så här breda. */
export const TILE_W_MAX = 168;
/** Raden börjar så här långt från vyns vänstra kant och nederkant. */
export const SHELF_MARGIN = 18;
export const SHELF_GAP = 14;
/** Flykten ned i raden och tillbaka (ms). */
export const FLIGHT_MS = 720;
/** Störst rörelseoskärpa mitt i flykten (skärm-px). Anders: "med någon blur". */
export const FLIGHT_BLUR = 3.2;

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Miniatyrens storlek: fönstrets form, TILE_H hög, men högst TILE_W_MAX bred. */
export function tileSize(W: number, H: number): { w: number; h: number } {
  const aspect = W > 0 && H > 0 ? W / H : 1;
  let h = TILE_H;
  let w = h * aspect;
  if (w > TILE_W_MAX) {
    w = TILE_W_MAX;
    h = w / aspect;
  }
  return { w, h };
}

/**
 * Rutorna på rad från vänster, i den ordning apparna minimerades, med nederkanterna i linje. Ryms de inte skjuts de
 * ihop lika mycket, så att de överlappar men alla syns (den senaste sist och överst).
 */
export function shelfSlots(sizes: Array<{ w: number; h: number }>, vw: number, vh: number): Box[] {
  if (!sizes.length) return [];
  const room = Math.max(0, vw - 2 * SHELF_MARGIN);
  const total = sizes.reduce((s, z) => s + z.w, 0) + SHELF_GAP * (sizes.length - 1);
  // Steget mellan rutornas vänsterkanter; trångt: alla steg krymper lika, men aldrig under 24 px.
  const squeeze = total > room && sizes.length > 1 ? (total - room) / (sizes.length - 1) : 0;
  const out: Box[] = [];
  let x = SHELF_MARGIN;
  for (const z of sizes) {
    out.push({ x, y: vh - SHELF_MARGIN - z.h, w: z.w, h: z.h });
    x += Math.max(24, z.w + SHELF_GAP - squeeze);
  }
  return out;
}

const easeInOut = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/**
 * Läget under flykten från a till b (skärm-px), p = 0..1: mitten, bredden, vridningen i tre dimensioner och
 * oskärpan. Anders: "kanske rotera i flera dimensioner?". Ett helt varv runt den lodräta axeln (yaw) och ett runt den
 * vågräta (pitch, lite senare), och en lutning i planet (roll) som är störst mitt i flykten och borta när den landar.
 * Storleken ändras först, så att vridningarna mest sker när miniatyren redan är liten. I sidled går den mjukt, i
 * höjdled snabbare i början, så att den glider ned i en båge. dir: 1 ned i raden, −1 tillbaka (allt baklänges).
 */
export function flight(a: Box, b: Box, p: number, dir: 1 | -1): { cx: number; cy: number; w: number; yaw: number; pitch: number; roll: number; blur: number } {
  const t = clamp(p, 0, 1);
  const size = easeOutCubic(clamp(t / 0.7, 0, 1));
  const w = Math.exp(Math.log(Math.max(1e-3, a.w)) + (Math.log(Math.max(1e-3, b.w)) - Math.log(Math.max(1e-3, a.w))) * size);
  const ax = a.x + a.w / 2;
  const ay = a.y + a.h / 2;
  const bx = b.x + b.w / 2;
  const by = b.y + b.h / 2;
  const cx = ax + (bx - ax) * easeInOut(t);
  const cy = ay + (by - ay) * easeOutCubic(t);
  const yaw = -360 * dir * easeInOut(clamp((t - 0.06) / 0.94, 0, 1));
  const pitch = 360 * dir * easeInOut(clamp((t - 0.2) / 0.8, 0, 1));
  const arc = Math.sin(Math.PI * t);
  const roll = -16 * dir * arc;
  const blur = FLIGHT_BLUR * arc ** 1.5;
  return { cx, cy, w, yaw, pitch, roll, blur };
}
