// layout.ts — ren geometri för fönster och krom: storlek från en ritad fyrkant (§10.4), prickens plats (§14),
// kantmarkörer (§10.5) och träffytor. Ingen DOM, enhetstestad.
import type { Camera, CreateAppRequest, WindowState } from '../../../shared/protocol.ts';
import type { ScreenRect } from '../types.ts';
import { screenToWorld, xform } from './camera.ts';
import { clamp } from './math.ts';

/** Minsta ritade fyrkant i skärm-px. Mindre tonar bort. */
export const MIN_DRAW_W = 120;
export const MIN_DRAW_H = 80;

/**
 * Så långt in från vyns kanter (skärm-px) en ritad fyrkant kläms: plats för prickens halo och greppet, som
 * annars hamnar utanför bild när draget fortsätter förbi vyns kant (FE-10). Det man inte ser ritar man inte.
 */
export const DRAW_INSET = 24;

/** Den ritade fyrkanten klämd till vyn minus DRAW_INSET (tom rektangel om den ligger helt utanför). */
export function clampToView(r: ScreenRect, vw: number, vh: number, inset = DRAW_INSET): ScreenRect {
  const x0 = clamp(r.x, inset, Math.max(inset, vw - inset));
  const y0 = clamp(r.y, inset, Math.max(inset, vh - inset));
  const x1 = clamp(r.x + r.w, inset, Math.max(inset, vw - inset));
  const y1 = clamp(r.y + r.h, inset, Math.max(inset, vh - inset));
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}

/** Serverns gränser (§5). */
export const LIMITS = { wMin: 240, wMax: 2400, hMin: 160, hMax: 1600, scaleMin: 0.05, scaleMax: 20 } as const;

/**
 * Den ritade fyrkanten (skärm-px) → CreateAppRequest. Layoutstorleken är den ritade storleken i skärm-px,
 * avrundad till heltal, och scale = världsbredd / w: det man ritar är det man får. Hamnar layouten utanför
 * gränserna ändras skalan (med samma proportioner), så att världsrektangeln blir den ritade.
 * Ger null för en fyrkant under 120×80.
 */
export function requestFromDrawn(r: ScreenRect, cam: Camera, vw: number, vh: number): CreateAppRequest | null {
  if (!(r.w >= MIN_DRAW_W && r.h >= MIN_DRAW_H)) return null;
  const tl = screenToWorld(cam, vw, vh, r.x, r.y);
  const ww = r.w / cam.zoom;
  let k = 1;
  if (r.w < LIMITS.wMin || r.h < LIMITS.hMin) k = Math.max(LIMITS.wMin / r.w, LIMITS.hMin / r.h);
  if (r.w * k > LIMITS.wMax || r.h * k > LIMITS.hMax) k = Math.min(LIMITS.wMax / r.w, LIMITS.hMax / r.h);
  const w = clamp(Math.round(r.w * k), LIMITS.wMin, LIMITS.wMax);
  const h = clamp(Math.round(r.h * k), LIMITS.hMin, LIMITS.hMax);
  const scale = clamp(ww / w, LIMITS.scaleMin, LIMITS.scaleMax);
  return { x: tl.x, y: tl.y, w, h, scale };
}

/** Fönstrets storlek i världen. */
export function worldSize(win: Pick<WindowState, 'w' | 'h' | 'scale'>): { w: number; h: number } {
  return { w: win.w * win.scale, h: win.h * win.scale };
}

/** Fönstrets platta rektangel på skärmen. */
export function screenRectOfWin(win: Pick<WindowState, 'x' | 'y' | 'w' | 'h' | 'scale'>, cam: Camera, vw: number, vh: number): ScreenRect {
  const { s, tx, ty } = xform(cam, vw, vh);
  return { x: win.x * s + tx, y: win.y * s + ty, w: win.w * win.scale * s, h: win.h * win.scale * s };
}

/** 45°-punkten på det övre högra hörnets båge, i fönstrets egna koordinater (radien r i samma enhet). */
export function dotPointLocal(width: number, r: number): { x: number; y: number } {
  const k = 1 - Math.SQRT1_2;
  return { x: width - r * k, y: r * k };
}

/** Prickens skala: krymper till 0,6 och tappar halon när fönstret är under 320 px brett på skärmen. */
export const OVERVIEW_DOT_W = 320;

/**
 * Var kantmarkören för ett fönster utanför bild hamnar: där linjen från vyns mitt mot fönstrets mitt
 * korsar vyns kant (indragen med inset). null när någon del av fönstret syns.
 */
export function edgeMarker(r: ScreenRect, vw: number, vh: number, inset = 14): { x: number; y: number } | null {
  const visible = r.x + r.w > 0 && r.y + r.h > 0 && r.x < vw && r.y < vh;
  if (visible) return null;
  const cx = vw / 2;
  const cy = vh / 2;
  const dx = r.x + r.w / 2 - cx;
  const dy = r.y + r.h / 2 - cy;
  const hw = vw / 2 - inset;
  const hh = vh / 2 - inset;
  if (hw <= 0 || hh <= 0) return null;
  const t = Math.min(dx ? hw / Math.abs(dx) : Infinity, dy ? hh / Math.abs(dy) : Infinity);
  return { x: cx + dx * t, y: cy + dy * t };
}

export function inRect(r: ScreenRect, x: number, y: number): boolean {
  return x >= r.x && y >= r.y && x <= r.x + r.w && y <= r.y + r.h;
}

/** Den översta (högst z) av fönstren vars skärmrektangel innehåller punkten. */
export function topmostAt<T extends { z: number; rect: ScreenRect }>(items: T[], x: number, y: number): T | null {
  let best: T | null = null;
  for (const it of items) if (inRect(it.rect, x, y) && (!best || it.z > best.z)) best = it;
  return best;
}

/** Ny storlek vid ändring från en kant eller ett hörn (layout-px, heltal, inom gränserna). */
export function resizeFrom(
  start: Pick<WindowState, 'x' | 'y' | 'w' | 'h' | 'scale'>,
  edge: string,
  dxWorld: number,
  dyWorld: number,
): { x: number; y: number; w: number; h: number } {
  const k = start.scale;
  let { x, y, w, h } = start;
  if (edge.includes('e')) w = clamp(Math.round(start.w + dxWorld / k), LIMITS.wMin, LIMITS.wMax);
  if (edge.includes('s')) h = clamp(Math.round(start.h + dyWorld / k), LIMITS.hMin, LIMITS.hMax);
  if (edge.includes('w')) {
    w = clamp(Math.round(start.w - dxWorld / k), LIMITS.wMin, LIMITS.wMax);
    x = start.x + (start.w - w) * k;
  }
  if (edge.includes('n')) {
    h = clamp(Math.round(start.h - dyWorld / k), LIMITS.hMin, LIMITS.hMax);
    y = start.y + (start.h - h) * k;
  }
  return { x, y, w, h };
}

/**
 * Ny skala vid ⇧+hörn: världsbredden följer hörnet, motsatta hörnet står still, ingen omflödning.
 * Skalan väljs efter den axel som rört sig mest relativt sin storlek.
 */
export function scaleFrom(
  start: Pick<WindowState, 'x' | 'y' | 'w' | 'h' | 'scale'>,
  corner: string,
  dxWorld: number,
  dyWorld: number,
): { x: number; y: number; scale: number } {
  const W0 = start.w * start.scale;
  const H0 = start.h * start.scale;
  const sx = corner.includes('w') ? -1 : 1;
  const sy = corner.includes('n') ? -1 : 1;
  const fx = (W0 + sx * dxWorld) / W0;
  const fy = (H0 + sy * dyWorld) / H0;
  const f = Math.abs(fx - 1) >= Math.abs(fy - 1) ? fx : fy;
  const scale = clamp(start.scale * f, LIMITS.scaleMin, LIMITS.scaleMax);
  const W = start.w * scale;
  const H = start.h * scale;
  return { x: sx < 0 ? start.x + W0 - W : start.x, y: sy < 0 ? start.y + H0 - H : start.y, scale };
}

/** Skala fönstret kring en världspunkt (⌥+nyp): punkten ligger kvar på samma ställe i fönstret. */
export function scaleAround(
  win: Pick<WindowState, 'x' | 'y' | 'scale'>,
  px: number,
  py: number,
  factor: number,
): { x: number; y: number; scale: number } {
  const scale = clamp(win.scale * factor, LIMITS.scaleMin, LIMITS.scaleMax);
  const f = scale / win.scale;
  return { x: px - (px - win.x) * f, y: py - (py - win.y) * f, scale };
}
