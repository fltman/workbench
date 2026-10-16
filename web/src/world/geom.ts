// geom.ts — streckets snäpp till den exakta rundade rektangeln (CONTRACT §14, Materialisering steg 1).
// Ren geometri i skärm-px, utan DOM, enhetstestad.
//
// Omkretsen parametriseras medurs (y nedåt) med båglängd u ∈ [0, P): överkanten från vänster, övre högra
// bågen, högerkanten nedåt, nedre högra bågen, nederkanten åt vänster, nedre vänstra bågen, vänsterkanten
// uppåt och sist övre vänstra bågen.
import { clamp } from './math.ts';

export interface Pt {
  x: number;
  y: number;
}

interface Arc {
  cx: number;
  cy: number;
  a0: number; // startvinkel (radianer, y nedåt: −π/2 är rakt upp)
  u0: number; // parameter där bågen börjar
}

export class RoundedRect {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
  readonly r: number;
  readonly ew: number; // överkantens raka längd
  readonly eh: number; // sidornas raka längd
  readonly q: number; // kvartsbågens längd
  readonly P: number;
  readonly arcs: Arc[];

  constructor(x: number, y: number, w: number, h: number, r: number) {
    this.x0 = x;
    this.y0 = y;
    this.x1 = x + w;
    this.y1 = y + h;
    this.r = clamp(r, 0, Math.min(w, h) / 2);
    this.ew = w - 2 * this.r;
    this.eh = h - 2 * this.r;
    this.q = (Math.PI / 2) * this.r;
    this.P = 2 * this.ew + 2 * this.eh + 4 * this.q;
    const { x0, y0, x1, y1, ew, eh, q } = this;
    const rr = this.r;
    this.arcs = [
      { cx: x1 - rr, cy: y0 + rr, a0: -Math.PI / 2, u0: ew },
      { cx: x1 - rr, cy: y1 - rr, a0: 0, u0: ew + q + eh },
      { cx: x0 + rr, cy: y1 - rr, a0: Math.PI / 2, u0: 2 * ew + 2 * q + eh },
      { cx: x0 + rr, cy: y0 + rr, a0: Math.PI, u0: 2 * ew + 3 * q + 2 * eh },
    ];
  }

  get w(): number {
    return this.x1 - this.x0;
  }

  get h(): number {
    return this.y1 - this.y0;
  }

  get cx(): number {
    return (this.x0 + this.x1) / 2;
  }

  get cy(): number {
    return (this.y0 + this.y1) / 2;
  }

  /** Punkten på omkretsen vid parametern u (periodisk). */
  at(uIn: number): Pt {
    const { P, ew, eh, q, r, x0, y0, x1, y1 } = this;
    let u = ((uIn % P) + P) % P;
    if (u <= ew) return { x: x0 + r + u, y: y0 };
    u -= ew;
    if (u <= q) return this.#arcPt(0, u);
    u -= q;
    if (u <= eh) return { x: x1, y: y0 + r + u };
    u -= eh;
    if (u <= q) return this.#arcPt(1, u);
    u -= q;
    if (u <= ew) return { x: x1 - r - u, y: y1 };
    u -= ew;
    if (u <= q) return this.#arcPt(2, u);
    u -= q;
    if (u <= eh) return { x: x0, y: y1 - r - u };
    u -= eh;
    return this.#arcPt(3, Math.min(u, q));
  }

  #arcPt(i: number, s: number): Pt {
    const a = this.arcs[i];
    if (this.r === 0) return { x: a.cx, y: a.cy };
    const ang = a.a0 + s / this.r;
    return { x: a.cx + this.r * Math.cos(ang), y: a.cy + this.r * Math.sin(ang) };
  }

  /** Parametern för den punkt på omkretsen som ligger närmast p. */
  nearest(p: Pt): number {
    const { x0, y0, x1, y1, r, ew, eh, q } = this;
    let best = Infinity;
    let bu = 0;
    const consider = (d2: number, u: number): void => {
      if (d2 < best) {
        best = d2;
        bu = u;
      }
    };
    // Raka kanter.
    {
      const x = clamp(p.x, x0 + r, x1 - r);
      consider((p.x - x) ** 2 + (p.y - y0) ** 2, x - (x0 + r));
    }
    {
      const y = clamp(p.y, y0 + r, y1 - r);
      consider((p.x - x1) ** 2 + (p.y - y) ** 2, ew + q + (y - (y0 + r)));
    }
    {
      const x = clamp(p.x, x0 + r, x1 - r);
      consider((p.x - x) ** 2 + (p.y - y1) ** 2, ew + 2 * q + eh + (x1 - r - x));
    }
    {
      const y = clamp(p.y, y0 + r, y1 - r);
      consider((p.x - x0) ** 2 + (p.y - y) ** 2, 2 * ew + 3 * q + eh + (y1 - r - y));
    }
    // Bågar.
    if (r > 0) {
      for (const a of this.arcs) {
        let ang = Math.atan2(p.y - a.cy, p.x - a.cx) - a.a0;
        ang = ((ang % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
        if (ang > Math.PI * 1.25) ang = 0; // före bågen (bortom mittlinjen i det uteslutna området): närmast dess början
        const s = clamp(ang, 0, Math.PI / 2) * r;
        const pt = { x: a.cx + r * Math.cos(a.a0 + s / r), y: a.cy + r * Math.sin(a.a0 + s / r) };
        consider((p.x - pt.x) ** 2 + (p.y - pt.y) ** 2, a.u0 + s);
      }
    }
    return bu;
  }

  /** Där strålen från mitten genom p skär omkretsen (radiell projektion), som parameter. */
  radial(p: Pt): number {
    const { cx, cy } = this;
    const dx = p.x - cx;
    const dy = p.y - cy;
    if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) return 0;
    const hw = this.w / 2;
    const hh = this.h / 2;
    const t = Math.min(dx ? hw / Math.abs(dx) : Infinity, dy ? hh / Math.abs(dy) : Infinity);
    let qx = cx + dx * t;
    let qy = cy + dy * t;
    const r = this.r;
    if (r > 0 && Math.abs(qx - cx) > hw - r + 1e-9 && Math.abs(qy - cy) > hh - r + 1e-9) {
      // Strålen träffar ett hörn: skär den med hörnets cirkel och ta den yttre roten.
      const ccx = cx + Math.sign(dx) * (hw - r);
      const ccy = cy + Math.sign(dy) * (hh - r);
      const fx = cx - ccx;
      const fy = cy - ccy;
      const A = dx * dx + dy * dy;
      const B = 2 * (fx * dx + fy * dy);
      const C = fx * fx + fy * fy - r * r;
      const disc = Math.max(0, B * B - 4 * A * C);
      const s = (-B + Math.sqrt(disc)) / (2 * A);
      qx = cx + dx * s;
      qy = cy + dy * s;
    }
    return this.nearest({ x: qx, y: qy });
  }

  /**
   * Hörnpunkter som måste finnas för att polygonen ska bli exakt: bågarnas ändar och tätt liggande punkter
   * längs varje båg (högst `step` px mellan dem). Sorterade, inom [0, P).
   */
  vertices(step = 2.5): number[] {
    const out: number[] = [];
    const m = Math.max(1, Math.ceil(this.q / step));
    for (const a of this.arcs) for (let j = 0; j <= m; j++) out.push(a.u0 + (this.q * j) / m);
    return [...new Set(out.map((u) => ((u % this.P) + this.P) % this.P))].sort((a, b) => a - b);
  }

  /** SVG-sökväg för den exakta rundade rektangeln (medurs, från överkantens vänstra ände). */
  pathD(): string {
    const { x0, y0, x1, y1, r } = this;
    const f = (v: number): string => (Math.round(v * 100) / 100).toString();
    if (r <= 0) return `M${f(x0)} ${f(y0)}H${f(x1)}V${f(y1)}H${f(x0)}Z`;
    return (
      `M${f(x0 + r)} ${f(y0)}H${f(x1 - r)}A${f(r)} ${f(r)} 0 0 1 ${f(x1)} ${f(y0 + r)}` +
      `V${f(y1 - r)}A${f(r)} ${f(r)} 0 0 1 ${f(x1 - r)} ${f(y1)}H${f(x0 + r)}` +
      `A${f(r)} ${f(r)} 0 0 1 ${f(x0)} ${f(y1 - r)}V${f(y0 + r)}A${f(r)} ${f(r)} 0 0 1 ${f(x0 + r)} ${f(y0)}Z`
    );
  }
}

/** Avståndet från p till närmaste punkt på omkretsen. */
export function distanceToEdge(rr: RoundedRect, p: Pt): number {
  const q = rr.at(rr.nearest(p));
  return Math.hypot(p.x - q.x, p.y - q.y);
}

/** Jämnt fördelade punkter längs en polyline (efter båglängd). */
export function resample(pts: Pt[], n: number): Pt[] {
  if (pts.length === 0) return [];
  if (pts.length === 1) return Array.from({ length: n }, () => ({ ...pts[0] }));
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  const total = cum[cum.length - 1];
  if (total === 0) return Array.from({ length: n }, () => ({ ...pts[0] }));
  const out: Pt[] = [];
  let i = 1;
  for (let j = 0; j < n; j++) {
    const l = (total * j) / (n - 1);
    while (i < pts.length - 1 && cum[i] < l) i++;
    const seg = cum[i] - cum[i - 1] || 1;
    const f = clamp((l - cum[i - 1]) / seg, 0, 1);
    out.push({ x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * f, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * f });
  }
  return out;
}

/** Hur många radianer strecket sveper runt mitten (med tecken). En slinga sveper mer än ungefär 240°. */
export function sweep(pts: Pt[], c: Pt): number {
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    let d = Math.atan2(pts[i].y - c.y, pts[i].x - c.x) - Math.atan2(pts[i - 1].y - c.y, pts[i - 1].x - c.x);
    if (d > Math.PI) d -= 2 * Math.PI;
    else if (d < -Math.PI) d += 2 * Math.PI;
    total += d;
  }
  return total;
}

export const LOOP_SWEEP = 4.2;

/**
 * Punktpar för snäppet. Varje källpunkt (på strecket) får en målpunkt på den rundade rektangeln:
 * - en slinga projiceras radiellt från mitten, i den riktning den ritades; en lucka sluts av svansen
 * - ett rakt drag (till exempel en snabb diagonal) vecklas ut medurs längs hela omkretsen, från kantpunkten
 *   närmast startpunkten
 * Där två målpunkter ligger på var sin sida om en båg sätts bågens punkter in exakt, så att linjära
 * mellanlägen slutar i en exakt rundad rektangel.
 */
export function morphTargets(stroke: Pt[], rr: RoundedRect, n?: number): { src: Pt[]; dst: Pt[]; loop: boolean } {
  const N = n ?? Math.round(clamp(rr.P / 3, 120, 600));
  const src = resample(stroke, N);
  const P = rr.P;
  const loop = Math.abs(sweep(src, { x: rr.cx, y: rr.cy })) > LOOP_SWEEP;
  let us: number[];
  if (loop) {
    us = src.map((p) => rr.radial(p));
    for (let i = 1; i < N; i++) {
      while (us[i] - us[i - 1] > P / 2) us[i] -= P;
      while (us[i] - us[i - 1] < -P / 2) us[i] += P;
    }
    // En slinga som inte når runt hela vägen sluts av svansen.
    const span = us[N - 1] - us[0];
    const dir = Math.sign(span) || 1;
    if (Math.abs(span) < P) {
      const gap = P - Math.abs(span);
      for (let i = 0; i < N; i++) {
        const t = clamp((i / (N - 1) - 0.7) / 0.3, 0, 1);
        us[i] += dir * gap * t * t * (3 - 2 * t);
      }
    }
  } else {
    const u0 = rr.nearest(src[0]);
    us = src.map((_, j) => u0 + (P * j) / (N - 1));
  }
  const V = rr.vertices();
  const S: Pt[] = [];
  const T: Pt[] = [];
  for (let i = 0; i < N; i++) {
    if (i > 0 && us[i] !== us[i - 1]) {
      const ua = us[i - 1];
      const ub = us[i];
      const lo = Math.min(ua, ub);
      const hi = Math.max(ua, ub);
      const ins: number[] = [];
      for (const v of V) {
        for (let k = Math.floor((lo - v) / P); v + k * P < hi; k++) {
          const val = v + k * P;
          if (val > lo) ins.push(val);
        }
      }
      ins.sort((a, b) => (ub > ua ? a - b : b - a));
      for (const v of ins) {
        const f = (v - ua) / (ub - ua);
        S.push({ x: src[i - 1].x + (src[i].x - src[i - 1].x) * f, y: src[i - 1].y + (src[i].y - src[i - 1].y) * f });
        T.push(rr.at(v));
      }
    }
    S.push(src[i]);
    T.push(rr.at(us[i]));
  }
  return { src: S, dst: T, loop };
}

/** Mellanläget k (0..1) som SVG-sökväg. */
export function morphPath(src: Pt[], dst: Pt[], k: number): string {
  let d = '';
  for (let i = 0; i < src.length; i++) {
    const x = src[i].x + (dst[i].x - src[i].x) * k;
    const y = src[i].y + (dst[i].y - src[i].y) * k;
    d += `${i ? 'L' : 'M'}${x.toFixed(2)} ${y.toFixed(2)}`;
  }
  return d;
}

/** Mjuk SVG-sökväg genom punkterna (kvadratiska kurvor genom mittpunkterna). */
export function smoothPath(pts: Pt[]): string {
  const n = pts.length;
  if (!n) return '';
  const f = (v: number): string => v.toFixed(1);
  let d = `M${f(pts[0].x)} ${f(pts[0].y)}`;
  if (n < 3) {
    for (let i = 1; i < n; i++) d += `L${f(pts[i].x)} ${f(pts[i].y)}`;
    if (n === 1) d += 'l0.01 0';
    return d;
  }
  for (let i = 1; i < n - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    d += `Q${f(a.x)} ${f(a.y)} ${f((a.x + b.x) / 2)} ${f((a.y + b.y) / 2)}`;
  }
  const l = pts[n - 1];
  return d + `L${f(l.x)} ${f(l.y)}`;
}

/** Omslutande rektangel för punkterna. */
export function bbox(pts: Pt[]): { x: number; y: number; w: number; h: number } {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of pts) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  if (!pts.length) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
