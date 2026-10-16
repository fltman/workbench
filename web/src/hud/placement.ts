// placement.ts — var HUD:en står på skärmen (CONTRACT §13). Ren geometri utan DOM, enhetstestad.
// Kandidaterna prövas i ordningen höger, vänster, under, över, med 14 px mellanrum, toppen eller vänsterkanten
// i linje med fönstret och klämd i vyn:
//   1. första kandidaten som varken överlappar något annat fönsters skärmrektangel eller en HUD som öppnades
//      före den här,
//   2. annars den med minst överlapp (överlapp med en HUD väger dubbelt; vid lika står HUD:en kvar på sin sida),
//   3. täcker alla kandidater det egna fönstret läggs HUD:en ovanpå fönstrets högra del, nere i hörnet.
//      Appar har ofta sina viktigaste knappar uppe till höger (uppmätt: "Lägg till" doldes av HUD:en där),
//      och med botten fast växer HUD:en uppåt, så inmatningen och stoppknappen står still.
// Utan fönster (världen svarar null) dockar HUD:en nere till höger i vyn.
import type { ScreenRect } from '../types.ts';

export type Side = 'right' | 'left' | 'below' | 'above' | 'overlay' | 'dock';

export interface Size {
  w: number;
  h: number;
}

export interface Placement {
  side: Side;
  x: number;
  y: number;
}

export const GAP = 14;
/** Under fönstret sitter världens grepp 10–15 px nedanför kanten. Där lämnar HUD:en större lucka så greppet syns. */
export const GAP_BELOW = 28;
export const MARGIN = 12;
const ORDER: readonly Side[] = ['right', 'left', 'below', 'above'];

/** Kandidatens övre vänstra hörn för en sida, klämt i vyn. */
export function candidate(side: Side, own: ScreenRect | null, size: Size, view: Size): { x: number; y: number } {
  let x: number;
  let y: number;
  if (!own || side === 'dock') {
    x = view.w - size.w - MARGIN;
    y = view.h - size.h - MARGIN;
  } else if (side === 'right') {
    x = own.x + own.w + GAP;
    y = own.y;
  } else if (side === 'left') {
    x = own.x - GAP - size.w;
    y = own.y;
  } else if (side === 'below') {
    x = own.x;
    y = own.y + own.h + GAP_BELOW;
  } else if (side === 'above') {
    x = own.x;
    y = own.y - GAP - size.h;
  } else {
    // ovanpå fönstrets högra del, nere i hörnet
    x = own.x + own.w - size.w - GAP;
    y = own.y + own.h - size.h - GAP;
  }
  return { x: clamp(x, MARGIN, view.w - size.w - MARGIN), y: clamp(y, MARGIN, view.h - size.h - MARGIN) };
}

/** Överlappets yta mellan två rektanglar (0 om de inte möts). */
export function overlapArea(a: ScreenRect, b: ScreenRect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/** Täcker HUD:en på denna plats det egna fönstret? En halv pixel avrundning räknas inte. */
export function coversOwn(p: { x: number; y: number }, size: Size, own: ScreenRect | null): boolean {
  if (!own) return false;
  const w = Math.min(p.x + size.w, own.x + own.w) - Math.max(p.x, own.x);
  const h = Math.min(p.y + size.h, own.y + own.h) - Math.max(p.y, own.y);
  return w > 0.5 && h > 0.5;
}

/** Överlapp med en äldre HUD väger dubbelt mot överlapp med ett fönster (§13). */
export const HUD_WEIGHT = 2;
/** Så mycket (px, åt båda hållen) måste en äldre HUD täcka den nuvarande platsen innan follow() väljer om. */
export const HUD_SLACK = 6;

/**
 * Välj plats enligt §13. huds: målrektanglarna för HUD:ar som öppnades före den här. prefer: nuvarande sida,
 * som vinner när kostnaden är lika (inom 1 px²).
 */
export function choosePlacement(
  own: ScreenRect | null,
  others: ScreenRect[],
  size: Size,
  view: Size,
  huds: ScreenRect[] = [],
  prefer: Side | null = null,
): Placement {
  if (!own) return { side: 'dock', ...candidate('dock', null, size, view) };
  const free: Array<Placement & { cost: number; i: number }> = [];
  for (const side of ORDER) {
    const p = candidate(side, own, size, view);
    if (coversOwn(p, size, own)) continue;
    const r = { x: p.x, y: p.y, w: size.w, h: size.h };
    let cost = 0;
    for (const o of others) cost += overlapArea(r, o);
    for (const h of huds) cost += HUD_WEIGHT * overlapArea(r, h);
    if (cost <= 0) return { side, ...p };
    free.push({ side, ...p, cost, i: side === prefer ? -1 : free.length });
  }
  if (!free.length) return { side: 'overlay', ...candidate('overlay', own, size, view) };
  free.sort((a, b) => (Math.abs(a.cost - b.cost) <= 1 ? a.i - b.i : a.cost - b.cost));
  return { side: free[0].side, x: free[0].x, y: free[0].y };
}

/** Täcker en äldre HUD platsen mer än HUD_SLACK åt båda hållen? */
function hitsHud(p: { x: number; y: number }, size: Size, huds: ScreenRect[]): boolean {
  for (const h of huds) {
    const w = Math.min(p.x + size.w, h.x + h.w) - Math.max(p.x, h.x);
    const v = Math.min(p.y + size.h, h.y + h.h) - Math.max(p.y, h.y);
    if (w > HUD_SLACK && v > HUD_SLACK) return true;
  }
  return false;
}

/**
 * Följ fönstret med samma sida så länge den inte täcker det egna fönstret eller en äldre HUD; annars välj om.
 * Ett annat fönster som flyttas dit ger inget nytt val. `overlay` och `dock` är nödlägen och prövas om varje gång
 * (en riktig sida kan ha blivit ledig). moving: kameran rör sig (nyp, zoom, flygning). Då prövas inte äldre HUD:ar,
 * eftersom fönstren skalar men HUD:arna inte gör det, och överlappen kommer och går för varje bildruta.
 */
export function follow(
  current: Side | null,
  own: ScreenRect | null,
  others: ScreenRect[],
  size: Size,
  view: Size,
  huds: ScreenRect[] = [],
  moving = false,
): Placement {
  if (current && own && ORDER.includes(current)) {
    const p = candidate(current, own, size, view);
    if (!coversOwn(p, size, own) && (moving || !hitsHud(p, size, huds))) return { side: current, ...p };
  }
  if (current === 'dock' && !own) return { side: 'dock', ...candidate('dock', null, size, view) };
  return choosePlacement(own, others, size, view, huds, current);
}

function clamp(v: number, lo: number, hi: number): number {
  return hi < lo ? lo : v < lo ? lo : v > hi ? hi : v;
}
