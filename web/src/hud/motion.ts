// motion.ts — HUD:ens rörelser: fjädrarna ur tokens.css (§14) och en liten fjäder för höjden.
// Fjädrarna är uträknade dämpade fjädrar samplade till CSS linear().

export interface Easing {
  easing: string;
  ms: number;
}

const FALLBACK: Record<'soft' | 'pop' | 'calm', Easing> = {
  soft: { easing: 'cubic-bezier(0.2, 0.9, 0.25, 1)', ms: 773 },
  pop: { easing: 'cubic-bezier(0.3, 1.4, 0.5, 1)', ms: 771 },
  calm: { easing: 'cubic-bezier(0.25, 1, 0.35, 1)', ms: 785 },
};

const cache = new Map<string, Easing>();

/** En fjäder ur tokens.css, t.ex. spring('soft') = { easing: 'linear(…)', ms: 773 }. */
export function spring(name: 'soft' | 'pop' | 'calm'): Easing {
  const hit = cache.get(name);
  if (hit) return hit;
  const css = getComputedStyle(document.documentElement);
  const easing = css.getPropertyValue(`--wb-spring-${name}`).trim();
  const ms = parseFloat(css.getPropertyValue(`--wb-spring-${name}-ms`));
  const ok = /^linear\(/.test(easing) && CSS.supports('transition-timing-function', easing);
  const e = ok && ms > 0 ? { easing, ms } : FALLBACK[name];
  if (ok) cache.set(name, e);
  return e;
}

export const easeOutCubic = (t: number): number => 1 - (1 - t) ** 3;
export const clamp01 = (t: number): number => (t < 0 ? 0 : t > 1 ? 1 : t);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export function reducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Dämpad fjäder (massa 1) som stegas per bildruta. Används för HUD:ens höjd. */
export class Spring {
  x: number;
  v = 0;
  to: number;
  readonly k: number;
  readonly c: number;

  constructor(x: number, k: number, c: number) {
    this.x = x;
    this.to = x;
    this.k = k;
    this.c = c;
  }

  snap(x: number): void {
    this.x = this.to = x;
    this.v = 0;
  }

  /** Stegar dt sekunder. Returnerar true medan fjädern rör sig. */
  step(dt: number): boolean {
    if (this.x === this.to && this.v === 0) return false;
    const n = Math.max(1, Math.ceil(dt * 480));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      const a = -this.k * (this.x - this.to) - this.c * this.v;
      this.v += a * h;
      this.x += this.v * h;
    }
    if (Math.abs(this.x - this.to) < 0.25 && Math.abs(this.v) < 4) {
      this.x = this.to;
      this.v = 0;
      return false;
    }
    return true;
  }
}
