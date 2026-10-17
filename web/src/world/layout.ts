// layout.ts — ren geometri för fönster och krom: storlek från en ritad fyrkant (§10.4), prickens plats (§14),
// kantmarkörer (§10.5) och träffytor. Ingen DOM, enhetstestad.
import type { Camera, CreateAppRequest, WindowState } from '../../../shared/protocol.ts';
import type { ScreenRect } from '../types.ts';
import type { Size } from '../hud/placement.ts';
import { candidate, choosePlacement, coversOwn, GAP, GAP_BELOW, HUD_WEIGHT, MARGIN, overlapArea } from '../hud/placement.ts';
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

/**
 * Fönstret med kromen runt det på skärmen: prickens sken utanför det övre högra hörnet (6 px) och greppets rad under
 * nederkanten (26 px). En kantmarkör som når in här ritas inte (§10.5), för den låg annars ovanpå appen eller vid greppet.
 */
export function withChrome(r: ScreenRect): ScreenRect {
  return { x: r.x - 6, y: r.y - 6, w: r.w + 12, h: r.h + 6 + 26 };
}

/** Rektangeln utvidgad med m px åt alla håll. */
export function grow(r: ScreenRect, m: number): ScreenRect {
  return { x: r.x - m, y: r.y - m, w: r.w + 2 * m, h: r.h + 2 * m };
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

/* ------------------------------ kromens zoner under andra fönster (§10.5) ------------------------------ */

const hits = (a: ScreenRect, b: ScreenRect): boolean => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

/** Täcks rektangeln (helt eller delvis) av något av fönstren ovanför? */
export function coveredRect(z: ScreenRect, covers: readonly ScreenRect[]): boolean {
  return covers.some((c) => hits(z, c));
}

/** Ligger punkten under något av fönstren ovanför? */
export function coveredPoint(x: number, y: number, covers: readonly ScreenRect[]): boolean {
  return covers.some((c) => x > c.x && x < c.x + c.w && y > c.y && y < c.y + c.h);
}

/**
 * Den största delen av en zon (en smal remsa längs en kant) som inget fönster ovanför täcker. Kromen ligger över alla
 * fönster, så en zon som ett annat fönster täcker skulle annars ta pekaren från det fönstret (Anders 16 oktober: "när
 * jag drar muspekaren över en app så triggas även appar som ligger bakom den"). axis 'x': remsan går vågrätt, 'y':
 * lodrätt. Ett fönster som täcker remsan på tvären tar hela sin bredd av den. null när mindre än min px är fri.
 */
export function freeStrip(z: ScreenRect, covers: readonly ScreenRect[], axis: 'x' | 'y', min = 8): ScreenRect | null {
  const a0 = axis === 'x' ? z.x : z.y;
  const a1 = a0 + (axis === 'x' ? z.w : z.h);
  const blocks: Array<[number, number]> = [];
  for (const c of covers) {
    if (!hits(z, c)) continue;
    const b0 = axis === 'x' ? c.x : c.y;
    const b1 = b0 + (axis === 'x' ? c.w : c.h);
    blocks.push([Math.max(a0, b0), Math.min(a1, b1)]);
  }
  blocks.sort((p, q) => p[0] - q[0]);
  let best: [number, number] | null = null;
  let cur = a0;
  for (const [b0, b1] of blocks) {
    if (b0 > cur && (!best || b0 - cur > best[1] - best[0])) best = [cur, b0];
    cur = Math.max(cur, b1);
  }
  if (a1 > cur && (!best || a1 - cur > best[1] - best[0])) best = [cur, a1];
  if (!best || best[1] - best[0] < min) return null;
  return axis === 'x' ? { x: best[0], y: z.y, w: best[1] - best[0], h: z.h } : { x: z.x, y: best[0], w: z.w, h: best[1] - best[0] };
}

/* ------------------------------ en ny app från fältet (§10.9) ------------------------------ */

/** Minsta storlek (skärm-px) för en app från fältet. */
export const FIELD_MIN: Size = { w: 320, h: 220 };

/** Trappsteget (skärm-px) när en app från fältet annars skulle begrava ett annat fönster. */
export const CASCADE = 32;

/**
 * Begraver en app på r fönstret o? Då ligger o:s prick (några px in från det övre högra hörnet, §14) under appen, och
 * o:s grepp (12,5 px under nederkanten, mitt under fönstret) ligger också under den eller under appens eget grepp
 * (träffytan 72 × 24 px). Kvar syns bara en kant av o, utan något att ta i.
 */
export function buries(r: ScreenRect, o: ScreenRect): boolean {
  if (!coveredPoint(o.x + o.w - 4, o.y + 4, [r])) return false;
  const gx = o.x + o.w / 2;
  const gy = o.y + o.h + 12.5;
  return coveredPoint(gx, gy, [r]) || (Math.abs(r.x + r.w / 2 - gx) < 72 && Math.abs(r.y + r.h + 12.5 - gy) < 24);
}

/**
 * Begraver r något av fönstren flyttas den ett trappsteg (CASCADE) i taget: först upp åt vänster, för pricken sitter
 * uppe till höger och greppet under fönstret, så att båda syns bredvid den nya appen; sedan ned åt vänster, ned åt
 * höger och upp åt höger (då syns pricken, men greppet hamnar under appen). Den första platsen i vyn (MARGIN in) som inte
 * begraver något och inte överlappar mer än mitten vinner; annars mitten om den inte begraver något, annars den första
 * platsen som inte begraver något. Finns ingen står r kvar.
 */
function cascade(r: ScreenRect, wins: readonly ScreenRect[], view: Size, cost: (q: ScreenRect) => number, centre: ScreenRect): ScreenRect {
  const free = (q: ScreenRect): boolean => !wins.some((o) => buries(q, o));
  if (free(r)) return r;
  const bound = cost(centre);
  let dear: ScreenRect | null = null;
  const steps = Math.ceil(Math.max(view.w, view.h) / CASCADE);
  for (let k = 1; k <= steps; k++) {
    for (const [dx, dy] of [[-1, -1], [-1, 1], [1, 1], [1, -1]] as const) {
      const q = { x: r.x + dx * k * CASCADE, y: r.y + dy * k * CASCADE, w: r.w, h: r.h };
      if (q.x < MARGIN || q.y < MARGIN || q.x > view.w - q.w - MARGIN || q.y > view.h - q.h - MARGIN || !free(q)) continue;
      if (cost(q) <= bound) return q;
      dear ??= q;
    }
  }
  if (free(centre)) return centre;
  return dear ?? r;
}

/**
 * Var en ny app från fältet hamnar (skärm-px): mitt i vyn om mitten är fri. Annars bredvid ett fönster med HUD:ens
 * kandidater (§13: höger, vänster, under, över), först appen i fokus (utan fokus fönstret som täcker mest av mitten,
 * eller täcker inget fönster mitten, det närmast den), sedan de andra, närmast först: i full storlek där det är fritt,
 * annars krympt till platsen bredvid (bredden till höger och vänster, höjden under och över), ned till FIELD_MIN. Är det
 * fullt överallt blir det den sida bredvid appen i fokus som överlappar minst, eller mitten om den överlappar mindre
 * (och alltid mitten utan fönster), och begraver den ett fönster (buries) ett trappsteg upp åt vänster (cascade). Som
 * en ritad fyrkant (§10.4) står appen minst DRAW_INSET från vyns kanter, så att pricken och greppet syns. Kameran
 * flyttas aldrig.
 * focused: fönstret i fokus om det syns; others: andra fönster på skärmen; obstacles: öppna HUD:ar och miniatyrerna i
 * raden, som undviks (HUD:ar väger dubbelt, som i §13) men inte är något att stå bredvid.
 */
export function fieldRect(size: Size, view: Size, focused: ScreenRect | null, others: ScreenRect[], obstacles: ScreenRect[] = []): ScreenRect {
  // HUD:ens kandidater kläms MARGIN in i vyn. I en vy som är DRAW_INSET − MARGIN mindre runt om hamnar de DRAW_INSET in
  // i den riktiga, och mitten blir densamma.
  const d = DRAW_INSET - MARGIN;
  const by = (r: ScreenRect, k: number): ScreenRect => ({ x: r.x + k, y: r.y + k, w: r.w, h: r.h });
  const inner = { w: view.w - 2 * d, h: view.h - 2 * d };
  return by(placeField(size, inner, focused && by(focused, -d), others.map((o) => by(o, -d)), obstacles.map((o) => by(o, -d))), d);
}

function placeField(size: Size, view: Size, focused: ScreenRect | null, others: ScreenRect[], obstacles: ScreenRect[]): ScreenRect {
  const centre = { x: (view.w - size.w) / 2, y: (view.h - size.h) / 2 + 30, w: size.w, h: size.h };
  const wins = focused ? [focused, ...others] : others;
  const cost = (r: ScreenRect, skip: ScreenRect | null): number =>
    wins.reduce((c, o) => (o === skip ? c : c + overlapArea(r, o)), 0) + obstacles.reduce((c, o) => c + HUD_WEIGHT * overlapArea(r, o), 0);
  if (cost(centre, null) === 0) return centre;
  const far = (r: ScreenRect, p: ScreenRect): number => Math.hypot(r.x + r.w / 2 - (p.x + p.w / 2), r.y + r.h / 2 - (p.y + p.h / 2));
  // Utan fokus kan mitten vara upptagen av bara en HUD eller en miniatyr; då står appen bredvid fönstret närmast mitten.
  const own = focused ?? [...others].sort((a, b) => overlapArea(centre, b) - overlapArea(centre, a) || far(a, centre) - far(b, centre))[0];
  if (!own) return centre;
  const anchors = [own, ...wins.filter((o) => o !== own).sort((a, b) => far(a, own) - far(b, own))];
  const at = (p: { x: number; y: number }, s: Size): ScreenRect => ({ x: p.x, y: p.y, w: s.w, h: s.h });
  for (const a of anchors) {
    const p = choosePlacement(a, wins.filter((o) => o !== a), size, view, obstacles);
    if (p.side !== 'overlay' && cost(at(p, size), a) === 0) return at(p, size);
  }
  for (const a of anchors) {
    const room = { right: view.w - MARGIN - (a.x + a.w + GAP), left: a.x - GAP - MARGIN, below: view.h - MARGIN - (a.y + a.h + GAP_BELOW), above: a.y - GAP - MARGIN };
    for (const side of ['right', 'left', 'below', 'above'] as const) {
      const fit = Math.floor(room[side]);
      const s = side === 'right' || side === 'left' ? { w: Math.min(size.w, fit), h: size.h } : { w: size.w, h: Math.min(size.h, fit) };
      if (s.w < FIELD_MIN.w || s.h < FIELD_MIN.h) continue;
      const p = candidate(side, a, s, view);
      if (!coversOwn(p, s, a) && cost(at(p, s), a) === 0) return at(p, s);
    }
  }
  const p = choosePlacement(own, wins.filter((o) => o !== own), size, view, obstacles);
  const least = p.side !== 'overlay' ? at(p, size) : centre;
  // Aldrig mer överlapp än mitten, där appen alltid hamnade förut. Men aldrig exakt över ett annat fönster: med samma
  // storlek blir mitten eller sidan bredvid appen i fokus ofta just ett äldre fältbygges rektangel (QA 17 oktober).
  return cascade(cost(least, null) <= cost(centre, null) ? least : centre, wins, view, (q) => cost(q, null), centre);
}
