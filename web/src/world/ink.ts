// ink.ts — ritstrecket och spökrektangeln i #ink (skärmkoordinater, CONTRACT §10.4 och §14).
// Strecket är --wb-ink, 2 px med mjuk glöd. Spökrektangeln är streckets omslutande rektangel, streckad,
// och syns först när den är stor nog att bli en app. Vid släpp snäpper strecket till den exakta rundade
// rektangeln (geom.ts) och tonar sedan bort. Inga mått, inga etiketter.
import type { Pt } from './geom.ts';
import { bbox, morphPath, morphTargets, RoundedRect, smoothPath } from './geom.ts';
import { MIN_DRAW_H, MIN_DRAW_W, clampToView } from './layout.ts';
import { easeSnap } from './math.ts';

const NS = 'http://www.w3.org/2000/svg';

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, parent?: Element): SVGElementTagNameMap[K] {
  const el = document.createElementNS(NS, tag);
  for (const k in attrs) el.setAttribute(k, String(attrs[k]));
  if (parent) parent.append(el);
  return el;
}

let seq = 0;

export class InkStroke {
  readonly g: SVGGElement;
  readonly pts: Pt[] = [];
  #ghost: SVGRectElement;
  #glow: SVGPathElement;
  #core: SVGPathElement;
  #filter: SVGFilterElement;
  #defs: SVGDefsElement;
  #radius: number;
  #view: { w: number; h: number } | null;
  #ended = false;

  /**
   * radius: fönsterhörnens radie på skärmen (--wb-win-radius × zoom). view: vyns storlek; spökrektangeln och
   * rect kläms då till vyn (clampToView), så att det som blir ett fönster är det som syns.
   */
  constructor(layer: SVGSVGElement, start: Pt, radius: number, view: { w: number; h: number } | null = null) {
    this.#radius = radius;
    this.#view = view;
    const id = `wb-ink-blur-${++seq}`;
    this.#defs = svg('defs', {}, layer);
    this.#filter = svg('filter', { id, filterUnits: 'userSpaceOnUse', x: start.x - 30, y: start.y - 30, width: 60, height: 60 }, this.#defs);
    svg('feGaussianBlur', { stdDeviation: 2.6 }, this.#filter);
    this.g = svg('g', { class: 'wb-stroke' }, layer);
    this.#ghost = svg('rect', { class: 'wb-ghost' }, this.g);
    this.#glow = svg('path', { class: 'wb-ink-glow', filter: `url(#${id})` }, this.g);
    this.#core = svg('path', { class: 'wb-ink' }, this.g);
    this.pts.push(start);
  }

  add(points: Pt[]): void {
    for (const p of points) {
      const l = this.pts[this.pts.length - 1];
      if (Math.hypot(p.x - l.x, p.y - l.y) >= 0.8) this.pts.push(p);
    }
    this.#render();
  }

  get rect(): { x: number; y: number; w: number; h: number } {
    const r = bbox(this.pts);
    return this.#view ? clampToView(r, this.#view.w, this.#view.h) : r;
  }

  /** Stor nog att bli en app. */
  get valid(): boolean {
    const r = this.rect;
    return r.w >= MIN_DRAW_W && r.h >= MIN_DRAW_H;
  }

  #render(): void {
    const d = smoothPath(this.pts);
    this.#core.setAttribute('d', d);
    this.#glow.setAttribute('d', d);
    const r = this.rect;
    this.#bound(r);
    const rad = Math.max(0, Math.min(this.#radius, r.w / 2, r.h / 2));
    for (const [k, v] of [['x', r.x], ['y', r.y], ['width', r.w], ['height', r.h], ['rx', rad], ['ry', rad]] as const) {
      this.#ghost.setAttribute(k, v.toFixed(2));
    }
    this.#ghost.classList.toggle('wb-on', this.valid);
  }

  /** Glödens filterområde följer strecket (ett område över hela vyn kostar bildrutor). */
  #bound(r: { x: number; y: number; w: number; h: number }): void {
    const m = 24;
    this.#filter.setAttribute('x', (r.x - m).toFixed(0));
    this.#filter.setAttribute('y', (r.y - m).toFixed(0));
    this.#filter.setAttribute('width', (r.w + 2 * m).toFixed(0));
    this.#filter.setAttribute('height', (r.h + 2 * m).toFixed(0));
  }

  /** Tona bort och ta bort (för liten fyrkant, Esc, misslyckat skapande). */
  cancel(ms = 260): void {
    if (this.#ended) return;
    this.#ended = true;
    const a = this.g.animate([{ opacity: 1 }, { opacity: 0 }], { duration: ms, easing: 'ease-out', fill: 'forwards' });
    void a.finished.then(() => this.remove(), () => this.remove());
  }

  /**
   * Snäpp strecket till den exakta rundade rektangeln (skärm-px) under ms med --wb-ease-snap.
   * Spökrektangeln tonar ut under tiden. Löser när strecket ligger exakt på rektangeln.
   */
  snap(target: { x: number; y: number; w: number; h: number; r: number }, ms = 270): Promise<void> {
    const rr = new RoundedRect(target.x, target.y, target.w, target.h, target.r);
    const { src, dst } = morphTargets(this.pts, rr);
    const r0 = this.rect;
    this.#bound({
      x: Math.min(r0.x, target.x),
      y: Math.min(r0.y, target.y),
      w: Math.max(r0.x + r0.w, target.x + target.w) - Math.min(r0.x, target.x),
      h: Math.max(r0.y + r0.h, target.y + target.h) - Math.min(r0.y, target.y),
    });
    this.#ghost.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, easing: 'ease-out', fill: 'forwards' });
    const t0 = performance.now();
    return new Promise((resolve) => {
      const step = (now: number): void => {
        if (!this.g.isConnected) return resolve();
        const p = Math.min(1, (now - t0) / ms);
        const k = easeSnap(p);
        const d = p < 1 ? morphPath(src, dst, k) : rr.pathD();
        this.#core.setAttribute('d', d);
        this.#glow.setAttribute('d', d);
        if (p < 1) requestAnimationFrame(step);
        else resolve();
      };
      requestAnimationFrame(step);
    });
  }

  /** Följ kameran om den rör sig medan strecket finns kvar (skärm_nu = skärm_då·k + (dx, dy)). */
  follow(k: number, dx: number, dy: number): void {
    this.g.setAttribute('transform', `translate(${dx.toFixed(2)} ${dy.toFixed(2)}) scale(${k.toFixed(5)})`);
  }

  /** Tona ut efter delay ms under ms och ta bort. */
  fade(delay: number, ms: number): void {
    if (this.#ended) return;
    this.#ended = true;
    const a = this.g.animate([{ opacity: 1 }, { opacity: 0 }], { duration: ms, delay, easing: 'ease-out', fill: 'forwards' });
    void a.finished.then(() => this.remove(), () => this.remove());
  }

  remove(): void {
    this.g.remove();
    this.#defs.remove();
  }
}
