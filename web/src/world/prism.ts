// prism.ts — prismornas matematik (CONTRACT §10.5). Ren, utan DOM, enhetstestad.
//
// DOM-kedjan (världsenheter, transform-origin mitt i fönstret):
//   .wb-win     left x, top y, W × H (W = w·scale, H = h·scale)
//   .wb-prism   perspective: P (perspective-origin mitt i)
//   .wb-rot     translateZ(−a) rotateY(θ)                    (preserve-3d)
//   .wb-face i  rotateY(i·360/n) translateZ(a)               (backface-visibility: hidden)
//   .wb-frames  scale(scale), origin 0 0                     (iframen i layout-px)
// I vila plattas allt till: inga transformer, övriga sidor dolda.
import type { Mat4 } from './math.ts';
import { chain, clamp, perspective, project, rotateY, scale3, translate3 } from './math.ts';

/** Perspektivet i världsenheter. 1400 enligt kontraktet; växer med mycket breda fönster så att djupet inte blir våldsamt. */
export function perspectiveFor(worldW: number): number {
  return Math.max(1400, worldW * 2);
}

export const stepDeg = (n: number): number => 360 / Math.max(1, n);

/** Apotemet a = W / (2·tan(π/n)); 0 för n = 2 (ett kort med baksida). */
export function apothem(worldW: number, n: number): number {
  if (n <= 2) return 0;
  return worldW / (2 * Math.tan(Math.PI / n));
}

export const mod = (i: number, n: number): number => ((i % n) + n) % n;

/** Vinkeln som visar sida i framåt. */
export const angleForFace = (i: number, n: number): number => -i * stepDeg(n);

/** Sidan vars normal pekar mest mot betraktaren vid vridningen θ (grader). */
export function frontFace(theta: number, n: number): number {
  let best = 0;
  let bc = -Infinity;
  for (let i = 0; i < n; i++) {
    const c = Math.cos(((theta + i * stepDeg(n)) * Math.PI) / 180);
    if (c > bc + 1e-9) {
      bc = c;
      best = i;
    }
  }
  return best;
}

/** Närmaste vinkel (till current) som visar sidan target framåt, eventuellt i en given riktning. */
export function angleToFace(current: number, target: number, n: number, dir: -1 | 0 | 1 = 0): number {
  const st = stepDeg(n);
  const base = angleForFace(target, n);
  const k = Math.round((current - base) / 360);
  let a = base + k * 360;
  if (dir < 0 && a > current - 1e-6) a -= 360; // vrid åt minskande vinkel
  if (dir > 0 && a < current + 1e-6) a += 360;
  if (dir === 0) {
    if (a - current > 180) a -= 360;
    if (current - a > 180) a += 360;
  }
  // En sida åt gången vid riktad vridning (⌃⌥←/→): aldrig mer än ett steg plus det som redan vridits.
  if (dir !== 0 && Math.abs(a - current) > 360 - st / 2) a -= Math.sign(a - current) * 360;
  return a;
}

export interface PrismPose {
  /** Fönstrets vänstra övre hörn i världen. */
  x: number;
  y: number;
  /** Världsstorlek. */
  W: number;
  H: number;
  /** Förstoring av innehållet (layout-px → världsenheter). */
  scale: number;
  n: number;
  theta: number; // vridning i grader
  flat: boolean;
}

/** Kamerans 2D-transform som matris. */
export function cameraMatrix(s: number, tx: number, ty: number): Mat4 {
  return chain(translate3(tx, ty), scale3(s, s));
}

/**
 * Exakt CSS-kedja för sida i: layout-px i sidans iframe → skärm-px.
 * cam = cameraMatrix(s, tx, ty).
 */
export function faceMatrix(cam: Mat4, p: PrismPose, i: number): Mat4 {
  const base = chain(cam, translate3(p.x, p.y));
  if (p.flat) return chain(base, scale3(p.scale, p.scale));
  const cx = p.W / 2;
  const cy = p.H / 2;
  const a = apothem(p.W, p.n);
  const c = translate3(cx, cy);
  const uc = translate3(-cx, -cy);
  return chain(
    base,
    c, perspective(perspectiveFor(p.W)), uc,
    c, translate3(0, 0, -a), rotateY(p.theta), uc,
    c, rotateY(i * stepDeg(p.n)), translate3(0, 0, a), uc,
    scale3(p.scale, p.scale),
  );
}

/** Layout-punkt på sida i → skärmpunkt. */
export function faceToScreen(cam: Mat4, p: PrismPose, i: number, lx: number, ly: number): { x: number; y: number } {
  return project(faceMatrix(cam, p, i), lx, ly);
}

/** CSS-transformerna för DOM:en (strängar), så att samma tal används överallt. */
export function rotTransform(p: Pick<PrismPose, 'W' | 'n' | 'theta'>): string {
  const a = apothem(p.W, p.n);
  return `translateZ(${(-a).toFixed(3)}px) rotateY(${p.theta.toFixed(4)}deg)`;
}

export function faceTransform(W: number, n: number, i: number): string {
  return `rotateY(${(i * stepDeg(n)).toFixed(4)}deg) translateZ(${apothem(W, n).toFixed(3)}px)`;
}

/**
 * Under en vridning glider prickens punkt längs en sidas överkant mot det vänstra hörnet när sidan vrids
 * mellan dessa vinklar (grader), så att den möter grannsidans hörn innan grannsidan tar över (med perspektiv
 * sker det före 90°).
 */
export const DOT_SLIDE_FROM = 55;
export const DOT_SLIDE_TO = 85;

export const PEEK_DEG = 16;

/**
 * Tittens vinkel för en prisma med n sidor. 16° (§10.5) visar grannsidan på en kub och däröver, men en
 * tresidig prismas grannsida vetter mot betraktaren först efter 30°: där lutar titten 42°,
 * annars syns bara den främre sidan luta och titten visar ingenting (K3). Ett kort (n = 2) har ingen grannsida
 * att visa före 90°, så där står 16° kvar som en ren lutning mot baksidan.
 */
export function peekDeg(n: number): number {
  return n === 3 ? 42 : PEEK_DEG;
}

/**
 * ⌥-svepet: vinkeln följer fingrarna, högst en sida per gest. När fingrarna släpper (första momentum-händelsen
 * eller 140 ms utan händelser) väljs sidan: en snabb flick går en sida, annars närmaste.
 */
export class SwipeRotor {
  readonly n: number;
  readonly degPerPx: number;
  startAngle = 0;
  angle = 0;
  vel = 0; // grader per ms
  lastT = 0;
  live = false;

  constructor(n: number, degPerPx = 0.35) {
    this.n = n;
    this.degPerPx = degPerPx;
  }

  /** Börja ett svep från viloläget start (en sida rakt fram); current är vinkeln som syns just nu. */
  begin(start: number, current = start): void {
    this.live = true;
    this.startAngle = start;
    this.angle = clamp(current, start - stepDeg(this.n), start + stepDeg(this.n));
    this.vel = 0;
    this.lastT = 0;
  }

  /** Ett hjulsteg (dx i px, t i ms). Ger den nya vinkeln. */
  move(dx: number, t: number): number {
    const d = -dx * this.degPerPx;
    const dt = this.lastT ? Math.max(1, t - this.lastT) : 16;
    this.lastT = t;
    this.vel = 0.7 * this.vel + 0.3 * (d / dt);
    const st = stepDeg(this.n);
    this.angle = clamp(this.angle + d, this.startAngle - st, this.startAngle + st);
    return this.angle;
  }

  /** Fingrarna släppte: vinkeln att snäppa till. */
  release(): number {
    this.live = false;
    const st = stepDeg(this.n);
    const rel = this.angle - this.startAngle;
    let steps: number;
    if (Math.abs(this.vel) > 0.6) steps = Math.sign(this.vel);
    else steps = Math.round(rel / st);
    steps = clamp(steps, -1, 1);
    return this.startAngle + steps * st;
  }
}
