// camera.ts — kamerans matematik (CONTRACT §10.2). Ren, utan DOM, enhetstestad.
// Camera { cx, cy, zoom }: världspunkten mitt i vyn och zoom. Internt s = zoom, tx = vw/2 − cx·s,
// ty = vh/2 − cy·s, och skärm = värld·s + t.
import type { Camera, Rect } from '../../../shared/protocol.ts';
import { clamp, lerp } from './math.ts';

export const ZOOM_MIN = 0.05;
export const ZOOM_MAX = 8;

export interface Xform {
  s: number;
  tx: number;
  ty: number;
}

export function xform(cam: Camera, vw: number, vh: number): Xform {
  return { s: cam.zoom, tx: vw / 2 - cam.cx * cam.zoom, ty: vh / 2 - cam.cy * cam.zoom };
}

export function worldToScreen(cam: Camera, vw: number, vh: number, wx: number, wy: number): { x: number; y: number } {
  const t = xform(cam, vw, vh);
  return { x: wx * t.s + t.tx, y: wy * t.s + t.ty };
}

export function screenToWorld(cam: Camera, vw: number, vh: number, sx: number, sy: number): { x: number; y: number } {
  return { x: cam.cx + (sx - vw / 2) / cam.zoom, y: cam.cy + (sy - vh / 2) / cam.zoom };
}

/** Zooma kring skärmpunkten (sx, sy): världspunkten under den står still. Zoom kläms till 0,05–8. */
export function zoomAround(cam: Camera, vw: number, vh: number, sx: number, sy: number, factor: number): Camera {
  const zoom = clamp(cam.zoom * factor, ZOOM_MIN, ZOOM_MAX);
  const w = screenToWorld(cam, vw, vh, sx, sy);
  return { cx: w.x - (sx - vw / 2) / zoom, cy: w.y - (sy - vh / 2) / zoom, zoom };
}

/** Flytta innehållet dx, dy skärm-px (positivt = världen följer fingrarna åt höger/ned). */
export function panBy(cam: Camera, dx: number, dy: number): Camera {
  return { cx: cam.cx - dx / cam.zoom, cy: cam.cy - dy / cam.zoom, zoom: cam.zoom };
}

/** three.js OrthographicCamera för samma vy (three.js har y uppåt, världen y nedåt). */
export function ortho(cam: Camera, vw: number, vh: number): { left: number; right: number; top: number; bottom: number } {
  const { s, tx, ty } = xform(cam, vw, vh);
  return { left: -tx / s, right: (vw - tx) / s, top: ty / s, bottom: -(vh - ty) / s };
}

/**
 * Mellanläge för en flygning. e = framsteg efter övergångskurvan (0..1). Zoom interpoleras i log-skala och
 * mitten följer 1/zoom, så att en flygning som byter zoom rör sig som ett nyp kring en fast punkt.
 */
export function lerpCamera(a: Camera, b: Camera, e: number): Camera {
  const zoom = Math.exp(lerp(Math.log(a.zoom), Math.log(b.zoom), e));
  let u = e;
  const ia = 1 / a.zoom;
  const ib = 1 / b.zoom;
  if (Math.abs(Math.log(b.zoom / a.zoom)) > 0.05) u = (1 / zoom - ia) / (ib - ia);
  return { cx: lerp(a.cx, b.cx, u), cy: lerp(a.cy, b.cy, u), zoom };
}

/** Kamera som visar världsrektangeln med marginal (skärm-px). maxZoom begränsar inzoomningen. */
export function fitRect(r: Rect, vw: number, vh: number, margin: number, maxZoom = ZOOM_MAX, reserveRight = 0): Camera {
  const aw = Math.max(1, vw - 2 * margin - reserveRight);
  const ah = Math.max(1, vh - 2 * margin);
  const zoom = clamp(Math.min(aw / Math.max(1e-6, r.w), ah / Math.max(1e-6, r.h)), ZOOM_MIN, Math.min(ZOOM_MAX, maxZoom));
  // Med reserv till höger förskjuts mitten åt vänster, så att rektangeln hamnar mitt i den fria delen.
  const shift = reserveRight / 2 / zoom;
  return { cx: r.x + r.w / 2 + shift, cy: r.y + r.h / 2, zoom };
}

/** Omslutande rektangel för flera rektanglar, eller null om listan är tom. */
export function boundsOf(rects: Rect[]): Rect | null {
  if (!rects.length) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const r of rects) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w);
    y1 = Math.max(y1, r.y + r.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function sameCamera(a: Camera, b: Camera): boolean {
  return a.cx === b.cx && a.cy === b.cy && a.zoom === b.zoom;
}

/** Normaliserar ett protokollvärde: rimliga tal och zoom inom gränserna. */
export function sanitizeCamera(c: Camera | undefined): Camera {
  const ok = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  if (!c || !ok(c.cx) || !ok(c.cy) || !ok(c.zoom)) return { cx: 0, cy: 0, zoom: 1 };
  return { cx: c.cx, cy: c.cy, zoom: clamp(c.zoom, ZOOM_MIN, ZOOM_MAX) };
}
