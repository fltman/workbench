// math.ts — rena hjälpfunktioner för världen: klämning, övergångskurvor och 4×4-matriser.
// Inga DOM-beroenden, så att allt här kan enhetstestas i Node.

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

export const easeOutCubic = (t: number): number => 1 - (1 - clamp(t, 0, 1)) ** 3;

/** CSS cubic-bezier(x1, y1, x2, y2) som funktion av tiden 0..1. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const X = (t: number): number => ((ax * t + bx) * t + cx) * t;
  const Y = (t: number): number => ((ay * t + by) * t + cy) * t;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let lo = 0;
    let hi = 1;
    let t = x;
    for (let i = 0; i < 40; i++) {
      const v = X(t);
      if (Math.abs(v - x) < 1e-7) break;
      if (v < x) lo = t;
      else hi = t;
      t = (lo + hi) / 2;
    }
    return Y(t);
  };
}

/** --wb-ease-snap: easeInOutQuart (streck → exakt rektangel). */
export const easeSnap = cubicBezier(0.77, 0, 0.175, 1);

/**
 * Tolkar en CSS-kurva `linear(0, 0.1, …, 1)` (jämnt fördelade punkter, som fjädrarna i tokens.css)
 * till en funktion av tiden 0..1. Ger null om strängen inte är en sådan kurva.
 */
export function parseLinearEasing(src: string): ((t: number) => number) | null {
  const m = /^\s*linear\(([^)]*)\)\s*$/.exec(src);
  if (!m) return null;
  const pts = m[1].split(',').map((s) => Number(s.trim()));
  if (pts.length < 2 || pts.some((v) => !Number.isFinite(v))) return null;
  const n = pts.length - 1;
  return (t) => {
    if (t <= 0) return pts[0];
    if (t >= 1) return pts[n];
    const f = t * n;
    const i = Math.floor(f);
    return lerp(pts[i], pts[i + 1], f - i);
  };
}

/** "773ms" eller "0.4s" → millisekunder. */
export function parseMs(src: string, fallback: number): number {
  const m = /^\s*([\d.]+)\s*(ms|s)\s*$/.exec(src);
  if (!m) return fallback;
  const v = Number(m[1]) * (m[2] === 's' ? 1000 : 1);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/* ------------------------------ 4×4-matriser (som CSS-transformer) ------------------------------ */
// Radordning, kolumnvektorer: p' = M·p. En CSS-lista "A B C" motsvarar mul(A, mul(B, C)).

export type Mat4 = number[];

export const identity = (): Mat4 => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export function mul(a: Mat4, b: Mat4): Mat4 {
  const o = new Array<number>(16);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      o[r * 4 + c] = a[r * 4] * b[c] + a[r * 4 + 1] * b[4 + c] + a[r * 4 + 2] * b[8 + c] + a[r * 4 + 3] * b[12 + c];
    }
  }
  return o;
}

export function chain(...ms: Mat4[]): Mat4 {
  return ms.reduce((acc, m) => mul(acc, m), identity());
}

export const translate3 = (x: number, y: number, z = 0): Mat4 => [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1];
export const scale3 = (sx: number, sy = sx, sz = 1): Mat4 => [sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, sz, 0, 0, 0, 0, 1];

/** CSS rotateY(deg): högerkanten går bort från betraktaren vid positiv vinkel. */
export function rotateY(deg: number): Mat4 {
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0, 0, 0, 0, 1];
}

/** CSS rotateX(deg). */
export function rotateX(deg: number): Mat4 {
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [1, 0, 0, 0, 0, c, -s, 0, 0, s, c, 0, 0, 0, 0, 1];
}

/** CSS perspective(d). */
export const perspective = (d: number): Mat4 => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -1 / d, 1];

/** Projicera en punkt: (x, y, z, 1) → skärmens (x/w, y/w). */
export function project(m: Mat4, x: number, y: number, z = 0): { x: number; y: number } {
  const X = m[0] * x + m[1] * y + m[2] * z + m[3];
  const Y = m[4] * x + m[5] * y + m[6] * z + m[7];
  const W = m[12] * x + m[13] * y + m[14] * z + m[15];
  return { x: X / W, y: Y / W };
}
