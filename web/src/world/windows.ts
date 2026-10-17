// windows.ts — ett fönster i #world (CONTRACT §10.5, §4.4, §5 och §14): vitt ark med rundade hörn och mjuk
// skugga, fröyta med konstruktionslinjer medan appen inte är byggd, en iframe per sida, byte utan vit
// blinkning när rev ändras, och prismor som bara står i 3D medan de vrids, tittar eller snurrar.
import type { AppInfo, AppPermission, FaceDef, WindowState } from '../../../shared/protocol.ts';
import { grantsFor } from '../bus.ts';
import type { Mat4 } from './math.ts';
import { clamp, project } from './math.ts';
import {
  SwipeRotor, peekDeg, angleForFace, angleToFace, faceMatrix, faceTransform, mod,
  perspectiveFor, rotTransform, stepDeg,
} from './prism.ts';
import type { PrismPose } from './prism.ts';
import { IDEAS_FACE, IDEAS_LABEL, IdeasView } from './ideas.ts';
import { seedGroups, seedGuides } from './seed.ts';
import type { Tokens } from './tokens.ts';
import { reducedMotion } from './tokens.ts';

/** §4.4. Utan top-navigation kan en app aldrig navigera bort skalet. */
export const IFRAME_SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads';

/** Om sandbox-attributet sätts. Det behålls: med och utan är apparna lika skarpa i riktig Chrome (uppmätt, §4.4). */
export const USE_SANDBOX = true;

const FEATURE: Record<AppPermission, string> = {
  microphone: 'microphone',
  camera: 'camera',
  'clipboard-read': 'clipboard-read',
  geolocation: 'geolocation',
};

/** allow-attributet: fullscreen och clipboard-write, plus de behörigheter appen bett om och användaren gett. */
export function allowAttr(app: Pick<AppInfo, 'id' | 'permissions'>): string {
  const granted = new Set(grantsFor(app.id));
  return ['fullscreen', 'clipboard-write', ...app.permissions.filter((p) => granted.has(p)).map((p) => FEATURE[p])].join('; ');
}

export interface ViewHost {
  port: string;
  tokens: Tokens;
  registerFrame(iframe: HTMLIFrameElement, view: WindowView, faceId: string): void;
  unregisterFrame(iframe: HTMLIFrameElement): void;
  /** Löser när iframen skickat hello (eller aldrig). */
  helloOf(iframe: HTMLIFrameElement): Promise<void>;
  /** Sidan som vetter framåt i vila har ändrats (spara win.face och berätta för sidorna). */
  frontChanged(view: WindowView): void;
  /** Något syns annorlunda: en bildruta behövs. */
  changed(): void;
  /** Ett klick på ett förslag på sidan Förslag (§10.8). */
  pickIdea(view: WindowView, text: string): void;
}

const NS = 'http://www.w3.org/2000/svg';
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const frames2 = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

function div(cls: string, parent?: Element): HTMLDivElement {
  const d = document.createElement('div');
  d.className = cls;
  if (parent) parent.append(d);
  return d;
}

function loaded(f: HTMLIFrameElement): Promise<void> {
  return new Promise((resolve) => f.addEventListener('load', () => resolve(), { once: true }));
}

export class FaceView {
  def: FaceDef;
  readonly el: HTMLDivElement;
  readonly sheet: HTMLDivElement;
  readonly frames: HTMLDivElement;
  readonly shade: HTMLDivElement;
  iframe: HTMLIFrameElement | null = null;
  incoming: HTMLIFrameElement | null = null;
  /** Sidan Förslag (§10.8): skalets egen sida, utan iframe. */
  ideas: IdeasView | null = null;

  constructor(def: FaceDef, parent: Element) {
    this.def = def;
    this.el = div('wb-face', parent);
    this.el.dataset.face = def.id;
    this.sheet = div('wb-sheet', this.el);
    this.frames = div('wb-frames', this.sheet);
    this.shade = div('wb-shade', this.sheet);
  }
}

interface Seed {
  svg: SVGSVGElement;
  guides: SVGGElement;
  groups: SVGGElement[];
  shown: number;
  band: HTMLDivElement;
  w: number;
  h: number;
}

export class WindowView {
  id: string;
  appId: string;
  win: WindowState;
  app: AppInfo | null = null;
  readonly el: HTMLDivElement;
  readonly shadow: HTMLDivElement;
  readonly lift: HTMLDivElement;
  readonly prism: HTMLDivElement;
  readonly rot: HTMLDivElement;
  faces: FaceView[] = [];
  /** Obyggd: fröytan. */
  seed: Seed | null = null;
  dissolving: Promise<void> | null = null;
  /** Antal tool-händelser som tecknats in på fröytan. */
  tools = 0;

  // rev-hantering
  #seenRev: number | null = null;
  #shownRev: number | null = null;
  #facesKey = '';
  #gen = 0;

  // prismans läge (grader)
  rest = 0; // vinkeln som visar sidan `front`
  front = 0; // sidan som vetter framåt i vila
  peek: -1 | 0 | 1 = 0;
  /** Vridningen mot målet: ease-out med --wb-spring-calm (titten 420 ms). */
  #anim: { from: number; to: number; t0: number; ms: number } | null = null;
  #target = 0;
  #spin: { t0: number; from: number; to: number; ms: number } | null = null;
  #swipe: SwipeRotor | null = null;
  #swipeTimer: ReturnType<typeof setTimeout> | null = null;
  is3d = false;
  theta = 0;
  #last3d = '';
  #flatKey = '';
  /** Appen var obyggd när vi först såg den: första bygget med flera sidor snurrar ett varv. */
  #wasUnbuilt = false;
  /** Minimerad eller på väg (§10.7): stapelordningen över alla fönster i stället för win.z. */
  #miniZ: number | null = null;
  #host: ViewHost;

  constructor(host: ViewHost, layer: HTMLElement, win: WindowState) {
    this.#host = host;
    this.id = win.id;
    this.appId = win.appId;
    this.win = { ...win };
    this.el = div('wb-win');
    this.el.dataset.app = win.appId;
    this.shadow = div('wb-shadow', this.el);
    this.lift = div('wb-shadow wb-lift', this.el);
    this.prism = div('wb-prism', this.el);
    this.rot = div('wb-rot', this.prism);
    this.faces = [new FaceView({ id: 'main', page: 'index.html' }, this.rot)];
    this.el.classList.add('wb-unbuilt');
    this.#ensureSeed();
    layer.append(this.el);
    this.applyGeometry();
    this.#setFrontIndex(win.face, false);
  }

  /** Byt id när en provisorisk vy får sitt riktiga fönster. */
  bind(win: WindowState): void {
    this.id = win.id;
    this.appId = win.appId;
    this.el.dataset.app = win.appId;
    this.setWin(win);
  }

  get n(): number {
    return this.faces.length;
  }

  /** Appens egna sidor (utan Förslag). Titten vid kanten och varvet efter ett bygge gäller bara appar med flera. */
  get appFaces(): number {
    return this.faces.filter((f) => !f.ideas).length;
  }

  /** Sidan Förslag står framåt (eller är på väg fram). */
  get ideasInFront(): boolean {
    return !!this.faces[this.front]?.ideas;
  }

  /** Världsstorlek. */
  get W(): number {
    return this.win.w * this.win.scale;
  }

  get H(): number {
    return this.win.h * this.win.scale;
  }

  /* ------------------------------ geometri ------------------------------ */

  setWin(win: WindowState): void {
    const faceChanged = win.face !== this.win.face;
    this.win = { ...win };
    this.applyGeometry();
    if (faceChanged && win.face !== this.front && this.n > 1) this.rotateTo(win.face, 0, false);
  }

  applyGeometry(): void {
    const { x, y, w, h, scale, z } = this.win;
    const s = this.el.style;
    s.left = `${x}px`;
    s.top = `${y}px`;
    s.width = `${w * scale}px`;
    s.height = `${h * scale}px`;
    s.zIndex = String(this.#miniZ ?? z);
    s.setProperty('--wb-k', String(scale));
    for (const f of this.faces) this.#sizeFace(f);
    if (this.seed && (this.seed.w !== w || this.seed.h !== h)) this.#drawSeed();
    this.#last3d = '';
  }

  #sizeFace(f: FaceView): void {
    const { w, h, scale } = this.win;
    const st = f.frames.style;
    st.width = `${w}px`;
    st.height = `${h}px`;
    st.transform = scale === 1 ? '' : `scale(${scale})`;
    for (const fr of [f.iframe, f.incoming]) {
      if (!fr) continue;
      fr.style.width = `${w}px`;
      fr.style.height = `${h}px`;
    }
  }

  /* ------------------------------ app, rev och iframes ------------------------------ */

  setApp(app: AppInfo): void {
    const prev = this.app;
    this.app = app;
    this.el.classList.toggle('wb-building', app.status === 'building');
    const first = this.#seenRev === null;
    const revChanged = !first && app.rev !== this.#seenRev;
    this.#seenRev = app.rev;
    if (first) {
      this.#wasUnbuilt = !app.built;
      if (app.built) void this.#load();
    } else if (revChanged) {
      if (app.built) void this.#load();
      else if (this.#shownRev !== null) this.#backToSeed();
    }
    if (prev && prev.name !== app.name) for (const f of this.faces) if (f.iframe) f.iframe.title = this.#title(f.def);
    for (const f of this.faces) f.ideas?.setTrouble(app.trouble ?? null);
  }

  /** grants:changed: samma byte som vid ny rev. */
  reloadFrames(): void {
    if (this.app?.built && this.#shownRev !== null) void this.#load();
  }

  #title(def: FaceDef): string {
    return def.label || this.app?.name || def.id;
  }

  #url(def: FaceDef): string {
    return new URL(def.page, `http://${this.appId}.localhost:${this.#host.port}/`).href;
  }

  #makeFrame(def: FaceDef): HTMLIFrameElement {
    const f = document.createElement('iframe');
    if (USE_SANDBOX) f.setAttribute('sandbox', IFRAME_SANDBOX);
    f.setAttribute('allow', this.app ? allowAttr(this.app) : 'fullscreen; clipboard-write');
    f.setAttribute('title', this.#title(def));
    f.className = 'wb-frame';
    f.style.width = `${this.win.w}px`;
    f.style.height = `${this.win.h}px`;
    f.src = this.#url(def);
    return f;
  }

  async #load(): Promise<void> {
    const app = this.app;
    if (!app || this.dissolving) return;
    const gen = ++this.#gen;
    this.#shownRev = app.rev;
    // Varje byggd app får sidan Förslag sist (§10.8).
    const own = (app.faces.length ? app.faces : [{ id: 'main', page: 'index.html' }]).filter((d) => d.id !== IDEAS_FACE);
    const defs = [...own, { id: IDEAS_FACE, page: '', label: IDEAS_LABEL }];
    const key = defs.map((d) => `${d.id}:${d.page}`).join('|');
    const facesChanged = this.#facesKey !== '' && key !== this.#facesKey;
    this.#facesKey = key;
    const firstReveal = !this.faces.some((f) => f.iframe);
    const frontId = this.faces[this.front]?.def.id;

    // Sidorna: samma id återanvänds (dess iframe byts), nya skapas, borttagna tas bort när bytet är klart.
    const next: FaceView[] = defs.map((d) => {
      const old = this.faces.find((f) => f.def.id === d.id);
      if (old) {
        old.def = d;
        return old;
      }
      const fv = new FaceView(d, this.rot);
      this.#sizeFace(fv);
      if (d.id === IDEAS_FACE) {
        fv.ideas = new IdeasView(fv.frames, this.appId, (text) => this.#host.pickIdea(this, text));
        fv.ideas.setTrouble(app.trouble ?? null);
      }
      return fv;
    });
    const obsolete = this.faces.filter((f) => !next.includes(f));
    for (const f of obsolete) f.el.style.visibility = 'hidden';
    this.faces = next;
    // Första gången gäller fönstrets sparade sida; vid ett byte står samma sida (samma id) kvar framåt.
    let fi = firstReveal ? -1 : next.findIndex((f) => f.def.id === frontId);
    if (fi < 0) fi = clamp(this.win.face, 0, next.length - 1);
    this.#setFrontIndex(fi, true);
    this.#last3d = '';
    if (this.seed && next[0] && this.seed.svg.parentElement !== next[0].frames) next[0].frames.append(this.seed.svg);

    await Promise.all(next.filter((f) => !f.ideas).map((f) => this.#swapFace(f, gen, firstReveal)));
    if (gen !== this.#gen || this.dissolving) return;
    this.#faceShown();
    for (const f of obsolete) {
      for (const fr of [f.iframe, f.incoming]) if (fr) this.#host.unregisterFrame(fr);
      f.el.remove();
    }
    if (firstReveal) this.#reveal();
    if ((facesChanged || (firstReveal && this.#wasUnbuilt)) && this.appFaces > 1) this.spin();
    this.#wasUnbuilt = false;
    this.#host.changed();
  }

  async #swapFace(f: FaceView, gen: number, firstReveal: boolean): Promise<void> {
    if (f.incoming) {
      this.#host.unregisterFrame(f.incoming);
      f.incoming.remove();
      f.incoming = null;
    }
    const fr = this.#makeFrame(f.def);
    fr.classList.add('wb-incoming');
    const old = f.iframe;
    // Den nya läggs bakom den gamla (som syns tills den nya har ritat sig).
    if (old) f.frames.insertBefore(fr, old);
    else f.frames.prepend(fr);
    if (firstReveal) fr.style.opacity = '0';
    f.incoming = fr;
    this.#host.registerFrame(fr, this, f.def.id);
    const t0 = performance.now();
    const ok = await Promise.race([loaded(fr).then(() => true), sleep(4000).then(() => false)]);
    if (ok) {
      // Appen har kört sina skript när hello kommit; ge den en kort stund att rita (högst 4 s totalt).
      const left = Math.max(0, 4000 - (performance.now() - t0));
      await Promise.race([this.#host.helloOf(fr), sleep(Math.min(350, left))]);
      await Promise.race([sleep(60), sleep(left)]);
      await frames2();
    }
    if (gen !== this.#gen || this.dissolving || f.incoming !== fr) {
      if (f.incoming === fr) f.incoming = null;
      this.#host.unregisterFrame(fr);
      fr.remove();
      return;
    }
    f.incoming = null;
    f.iframe = fr;
    fr.classList.remove('wb-incoming');
    if (old) {
      const a = old.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 180, easing: 'ease-out', fill: 'forwards' });
      old.style.pointerEvents = 'none';
      const done = (): void => {
        this.#host.unregisterFrame(old);
        old.remove();
      };
      void a.finished.then(done, done);
    } else if (firstReveal) {
      const a = fr.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 260, easing: 'cubic-bezier(.2,.7,.2,1)', fill: 'forwards' });
      const done = (): void => {
        fr.style.opacity = '';
        a.cancel();
      };
      void a.finished.then(done, done);
    }
  }

  #reveal(): void {
    this.el.classList.remove('wb-unbuilt');
    const seed = this.seed;
    if (!seed) return;
    this.seed = null;
    const a = seed.svg.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 240, easing: 'ease-out', fill: 'forwards' });
    seed.band.remove();
    const done = (): void => seed.svg.remove();
    void a.finished.then(done, done);
  }

  /** En ny rev utan byggd app (till exempel ångra till första versionen): tillbaka till fröytan. */
  #backToSeed(): void {
    this.#gen++;
    this.#shownRev = null;
    this.#facesKey = '';
    for (const f of this.faces) {
      for (const fr of [f.iframe, f.incoming]) {
        if (!fr) continue;
        this.#host.unregisterFrame(fr);
        fr.remove();
      }
      f.iframe = f.incoming = null;
    }
    for (const f of this.faces.slice(1)) f.el.remove();
    this.faces = this.faces.slice(0, 1);
    this.#setFrontIndex(0, true);
    this.el.classList.add('wb-unbuilt');
    this.tools = 0;
    this.#ensureSeed();
    this.#host.changed();
  }

  /** Alla iframes som just nu hör till vyn (för bryggan). */
  *iframes(): Generator<HTMLIFrameElement> {
    for (const f of this.faces) {
      if (f.iframe) yield f.iframe;
      if (f.incoming) yield f.incoming;
    }
  }

  /* ------------------------------ fröytan ------------------------------ */

  #ensureSeed(): void {
    if (this.seed) return;
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'wb-seed');
    const guides = document.createElementNS(NS, 'g');
    guides.setAttribute('class', 'wb-guides');
    svg.append(guides);
    const band = div('wb-band');
    this.faces[0].sheet.append(band);
    this.faces[0].frames.append(svg);
    this.seed = { svg, guides, groups: [], shown: 0, band, w: 0, h: 0 };
    this.#drawSeed();
  }

  #drawSeed(): void {
    const seed = this.seed;
    if (!seed) return;
    const { w, h } = this.win;
    seed.w = w;
    seed.h = h;
    seed.svg.setAttribute('width', String(w));
    seed.svg.setAttribute('height', String(h));
    seed.svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    seed.guides.replaceChildren(...seedGuides(w, h).map((d) => this.#path(d)));
    for (const g of seed.groups) g.remove();
    seed.groups = seedGroups(w, h).map((grp, i) => {
      const g = document.createElementNS(NS, 'g');
      g.setAttribute('class', 'wb-group');
      g.dataset.group = String(i);
      for (const d of grp.paths) {
        const p = this.#path(d);
        p.setAttribute('pathLength', '1');
        g.append(p);
      }
      seed.svg.append(g);
      return g;
    });
    const shown = seed.shown;
    seed.shown = 0;
    this.#showGroups(shown, false);
  }

  #path(d: string): SVGPathElement {
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', d);
    return p;
  }

  /** Tecknar in konstruktionslinjerna: en grupp per tool-händelse under bygget. */
  setTools(count: number): void {
    this.tools = Math.max(this.tools, count);
    if (this.seed) this.#showGroups(this.tools, true);
  }

  #showGroups(count: number, animate: boolean): void {
    const seed = this.seed;
    if (!seed) return;
    const target = Math.min(count, seed.groups.length);
    for (let i = seed.shown; i < target; i++) {
      const g = seed.groups[i];
      g.classList.add('wb-on');
      if (!animate || reducedMotion()) continue;
      [...g.children].forEach((p, j) => {
        p.animate([{ strokeDashoffset: 1, opacity: 0 }, { strokeDashoffset: 1, opacity: 1, offset: 0.02 }, { strokeDashoffset: 0, opacity: 1 }], {
          duration: 520,
          delay: Math.min(j * 22, 420),
          easing: 'cubic-bezier(.8,0,.2,1)',
          fill: 'backwards',
        });
      });
    }
    seed.shown = Math.max(seed.shown, target);
  }

  /* ------------------------------ prisman ------------------------------ */

  #setFrontIndex(i: number, persist: boolean): void {
    const n = this.n;
    const fi = n > 0 ? mod(Math.round(i) || 0, n) : 0;
    this.front = fi;
    this.rest = angleForFace(fi, n);
    this.#anim = null;
    this.#target = this.theta = this.rest;
    this.#last3d = '';
    if (persist) this.#host.frontChanged(this);
  }

  /** Vrid fram sidan i. dir −1 = mot minskande vinkel (nästa sida, ⌃⌥→), +1 = föregående, 0 = kortaste vägen. */
  rotateTo(i: number, dir: -1 | 0 | 1, persist = true): void {
    const n = this.n;
    if (n <= 1 || this.dissolving) return;
    const target = mod(i, n);
    if (target === this.front && dir === 0) return;
    this.#spin = null;
    this.rest = angleToFace(this.rest, target, n, dir);
    this.front = target;
    if (persist) this.#host.frontChanged(this);
    this.#faceShown();
    this.#host.changed();
  }

  /** Sidan Förslag är på väg fram eller står framåt: förslagen hämtas för appens nuvarande version. */
  #faceShown(): void {
    const f = this.faces[this.front];
    if (f?.ideas && this.app?.built) f.ideas.want(this.app.rev);
  }

  /** Nästa (+1) eller föregående (−1) sida. */
  rotateBy(steps: 1 | -1): void {
    this.rotateTo(this.front + steps, steps > 0 ? -1 : 1);
  }

  setPeek(dir: -1 | 0 | 1): void {
    if (this.appFaces <= 1 || this.peek === dir) return;
    this.peek = dir;
    this.#host.changed();
  }

  /** Ett varv efter en tur som ändrat sidorna (1,2 s, --wb-spring-calm), sedan platt. */
  spin(): void {
    if (this.n <= 1 || reducedMotion()) return;
    this.#spin = { t0: performance.now(), from: this.rest, to: this.rest - 360, ms: 1200 };
    this.#host.changed();
  }

  /** ⌥+vågrätt svep: följer fingrarna och snäpper vid första momentum-händelsen eller efter 140 ms. */
  swipe(dx: number, t: number, momentum: boolean): void {
    const n = this.n;
    if (n <= 1 || this.dissolving) return;
    if (momentum) {
      if (this.#swipe?.live) this.#releaseSwipe();
      return;
    }
    if (!this.#swipe || !this.#swipe.live) {
      this.#spin = null;
      this.#swipe = new SwipeRotor(n);
      this.#swipe.begin(this.rest, this.theta);
      this.#anim = null;
    }
    const a = this.#swipe.move(dx, t);
    this.theta = this.#target = a;
    if (this.#swipeTimer) clearTimeout(this.#swipeTimer);
    this.#swipeTimer = setTimeout(() => this.#releaseSwipe(), 140);
    this.#host.changed();
  }

  #releaseSwipe(): void {
    if (this.#swipeTimer) clearTimeout(this.#swipeTimer);
    this.#swipeTimer = null;
    const sw = this.#swipe;
    if (!sw || !sw.live) return;
    const a = sw.release();
    const n = this.n;
    const i = mod(Math.round(-a / stepDeg(n)), n);
    this.rest = a;
    const changed = i !== this.front;
    this.front = i;
    if (changed) this.#host.frontChanged(this);
    this.#faceShown();
    this.#host.changed();
  }

  get swiping(): boolean {
    return !!this.#swipe?.live;
  }

  /** Läget för den här bildrutan: vinkel och lutning. */
  pose(): PrismPose {
    return {
      x: this.win.x,
      y: this.win.y,
      W: this.W,
      H: this.H,
      scale: this.win.scale,
      n: this.n,
      theta: this.theta,
      flat: !this.is3d,
    };
  }

  /**
   * Stega prismans rörelser och skriv DOM:en. I vila ligger den alltid platt, på alla zoomnivåer (Anders: "när en
   * app har roterat så lägger den sig lite snett", om översiktslutningen under zoom 0,85). Ger true medan något rör
   * sig (då behövs en bildruta till).
   */
  tick(now: number): boolean {
    const n = this.n;
    if (n <= 1) {
      if (this.is3d || this.#flatKey !== `${this.front}|${n}`) this.#flatten();
      return false;
    }
    let moving = false;
    const calm = this.#host.tokens.calm.fn;
    if (this.#spin) {
      const sp = this.#spin;
      const p = clamp((now - sp.t0) / sp.ms, 0, 1);
      this.theta = sp.from + (sp.to - sp.from) * calm(p);
      if (p >= 1) {
        this.#spin = null;
        this.#anim = null;
        this.#target = this.theta = this.rest;
      } else moving = true;
    } else if (this.#swipe?.live) {
      moving = true;
    } else {
      // Nytt mål (vridning, titt in eller ut): en ny ease-out från vinkeln som syns nu.
      const pk = peekDeg(n);
      const to = this.rest - pk * this.peek;
      if (to !== this.#target) {
        this.#target = to;
        // --wb-spring-calm i sin egen längd för en hel sida (synligt klar efter ungefär 450 ms), kortare för kortare vägar.
        const dist = Math.abs(to - this.theta);
        const full = this.#host.tokens.calm.ms;
        const ms = dist <= pk + 0.5 ? 420 : clamp(full * Math.sqrt(dist / stepDeg(n)), 420, full);
        // Minskad rörelse: sidan byts direkt (och plattas till i samma bildruta).
        this.#anim = reducedMotion() ? null : { from: this.theta, to, t0: now, ms };
        if (!this.#anim) this.theta = to;
      }
      const a = this.#anim;
      if (a) {
        const p = clamp((now - a.t0) / a.ms, 0, 1);
        this.theta = a.from + (a.to - a.from) * calm(p);
        if (p >= 1) {
          this.theta = a.to;
          this.#anim = null;
        } else moving = true;
      }
      if (!moving && this.peek === 0) this.#normalize();
    }
    const need3d = moving || this.peek !== 0 || !!this.#spin;
    if (need3d) this.#apply3d();
    else if (this.is3d || this.#flatKey !== `${this.front}|${n}`) this.#flatten();
    return moving;
  }

  /** Håll vinklarna nära noll (varvtal spelar ingen roll i vila). */
  #normalize(): void {
    const k = Math.round(this.rest / 360);
    if (k !== 0) {
      this.rest -= k * 360;
      this.theta -= k * 360;
      this.#target -= k * 360;
    }
  }

  #apply3d(): void {
    this.#flatKey = '';
    const n = this.n;
    const W = this.W;
    const p = this.pose();
    p.flat = false;
    const rot = rotTransform(p);
    const key = `${rot}|${n}|${W}`;
    if (!this.is3d) {
      this.is3d = true;
      this.el.classList.add('wb-3d');
      this.prism.style.perspective = `${perspectiveFor(W).toFixed(0)}px`;
      this.rot.style.transformStyle = 'preserve-3d';
    }
    if (key === this.#last3d) return;
    this.#last3d = key;
    this.prism.style.perspective = `${perspectiveFor(W).toFixed(0)}px`;
    this.rot.style.transform = rot;
    this.faces.forEach((f, i) => {
      f.el.style.transform = faceTransform(W, n, i);
      f.el.style.visibility = '';
      // Sidor som vänder sig bort skuggas lätt, så att kroppen läses som en kropp; nästan raka sidor förblir ljusa.
      const c = Math.cos(((this.theta + i * stepDeg(n)) * Math.PI) / 180);
      f.shade.style.opacity = (0.34 * Math.max(0, Math.min(1, 1 - c)) ** 1.4).toFixed(3);
    });
  }

  #flatten(): void {
    this.is3d = false;
    this.#last3d = '';
    this.#flatKey = `${this.front}|${this.n}`;
    this.el.classList.remove('wb-3d');
    this.prism.style.perspective = 'none';
    this.rot.style.transformStyle = 'flat';
    this.rot.style.transform = 'none';
    this.faces.forEach((f, i) => {
      f.el.style.transform = 'none';
      f.el.style.visibility = i === this.front ? '' : 'hidden';
      f.shade.style.opacity = '0';
    });
  }

  /** Sidan i:s vridning i grader (−180..180]; 0 = rakt mot betraktaren. */
  yawOf(i: number): number {
    const y = this.theta + i * stepDeg(this.n);
    return ((((y + 180) % 360) + 360) % 360) - 180;
  }

  /** Matrisen för sida i: layout-px → skärm, genom fönstret, prisman och kameran. */
  faceMatrix(cam: Mat4, i: number): Mat4 {
    return faceMatrix(cam, this.pose(), i);
  }

  /** Layout-punkt på sida i → skärm. */
  toScreen(cam: Mat4, i: number, lx: number, ly: number): { x: number; y: number } {
    return project(this.faceMatrix(cam, i), lx, ly);
  }

  /* ------------------------------ in och ut ------------------------------ */

  /** Arket läggs ned (§14 Materialisering steg 2). */
  layDown(delay: number): void {
    const t = this.#host.tokens;
    this.el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 240, delay, easing: 'ease-out', fill: 'backwards' });
    if (!reducedMotion()) this.el.animate([{ transform: 'scale(1.012)' }, { transform: 'none' }], { duration: t.soft.ms, delay, easing: t.soft.css, fill: 'backwards' });
    this.shadow.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 600, delay, easing: 'ease-out', fill: 'backwards' });
  }

  setLifted(on: boolean): void {
    this.el.classList.toggle('wb-lifted', on);
  }

  /**
   * Minimerad (§10.7): fönstret står kvar i #world men flyttas med en egen transform (kring mitten) till raden i
   * hörnet, och tar emot pekaren som en enda knapp (base.css). null: tillbaka på sin plats med sin egen z.
   */
  setMiniPose(transform: string | null, z: number | null = null, blur = 0): void {
    const s = this.el.style;
    if (transform === null) {
      if (this.#miniZ === null && !this.el.classList.contains('wb-mini')) return;
      this.#miniZ = null;
      this.el.classList.remove('wb-mini');
      s.transform = '';
      s.transformOrigin = '';
      s.filter = '';
      s.zIndex = String(this.win.z);
      return;
    }
    this.el.classList.add('wb-mini');
    s.transformOrigin = '50% 50%';
    if (s.transform !== transform) s.transform = transform;
    const f = blur > 0.05 ? `blur(${blur.toFixed(2)}px)` : '';
    if (s.filter !== f) s.filter = f;
    if (z !== null && z !== this.#miniZ) {
      this.#miniZ = z;
      s.zIndex = String(z);
    }
  }

  dissolve(): Promise<void> {
    if (this.dissolving) return this.dissolving;
    this.#gen++;
    // Fönstret tar aldrig mer emot pekaren: .wb-face har pointer-events: auto, som vinner över en ärvd
    // inline-none, så det måste vara .wb-gone (base.css) och inert (K1: annars ritar ett nytt drag inte).
    this.el.classList.add('wb-gone');
    this.el.inert = true;
    // Ett minimerat fönster löses upp där det står (i raden), inte på sin plats i världen.
    const base = this.el.style.transform || 'none';
    const a = reducedMotion()
      ? this.el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, easing: 'ease-out', fill: 'forwards' })
      : this.el.animate(
          [
            { opacity: 1, transform: base, filter: 'blur(0px)' },
            { opacity: 0, transform: base === 'none' ? 'scale(0.97)' : `${base} scale(0.97)`, filter: 'blur(6px)' },
          ],
          { duration: 340, easing: 'cubic-bezier(.4,0,.6,1)', fill: 'forwards' },
        );
    this.dissolving = a.finished.then(
      () => this.#dispose(),
      () => this.#dispose(),
    );
    return this.dissolving;
  }

  #dispose(): void {
    for (const fr of [...this.iframes()]) this.#host.unregisterFrame(fr);
    if (this.#swipeTimer) clearTimeout(this.#swipeTimer);
    this.el.remove();
  }
}
