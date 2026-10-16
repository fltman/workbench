// chrome.ts — skärmfast fönsterkrom i #chrome (CONTRACT §10.5, §14): LED-pricken, greppet, sidprickarna, minimeringen,
// borttagningen,
// de osynliga storlekszonerna, titt-zonerna vid prismors kanter och kantmarkörerna för fönster utanför bild.
// Kromen ritas utanför iframen, så den fungerar även när en app hänger. Ingen text.
import type { AppStatus, BackendState } from '../../../shared/protocol.ts';
import type { ScreenRect } from '../types.ts';
import type { Tokens } from './tokens.ts';
import { reducedMotion } from './tokens.ts';
import { pushEscape } from '../escape.ts';

export const EDGES = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const;
export type Edge = (typeof EDGES)[number];

/** Storlekszonerna ligger så här långt utanför kanten (skärm-px). */
export const ZONE = 10;
/** Titt-zonen vid en prismas sidokant. */
export const PEEK_ZONE = 24;

export interface ChromeHandlers {
  dot(): void;
  gripDown(e: PointerEvent): void;
  gripDouble(): void;
  zoneDown(e: PointerEvent, edge: Edge): void;
  faceDot(i: number): void;
  peek(dir: -1 | 0 | 1): void;
  peekClick(dir: -1 | 1): void;
  focus(): void;
  /** Knappen till höger om greppet (§10.7). */
  minimize(): void;
  /** Ta bort appen (§10.5): knappen längst till höger, efter ett andra klick. */
  remove(): void;
}

export interface ChromeLayout {
  rect: ScreenRect;
  dot: { x: number; y: number };
  /** Fönstret är under 320 px brett: pricken krymper och halon försvinner. */
  small: boolean;
  /** Något annat fönster ligger över pricken eller greppet. */
  dotHidden: boolean;
  gripHidden: boolean;
  /** Prismor har titt-zoner. */
  prism: boolean;
  /** I 3D: silhuettens nederkant på skärmen (greppet hamnar under den i stället för under den platta rektangeln). */
  bottom?: number;
  /** Under en animation (vridning, flygning) ska zonerna inte ta emot pekaren. */
  interactive: boolean;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent?: Element): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (parent) parent.append(e);
  return e;
}

const at = (e: HTMLElement, x: number, y: number): void => {
  e.style.transform = `translate(${x.toFixed(2)}px, ${y.toFixed(2)}px)`;
};

export class ChromeView {
  readonly root: HTMLDivElement;
  readonly dot: HTMLButtonElement;
  readonly pop: HTMLSpanElement;
  readonly haloWrap: HTMLSpanElement;
  readonly halo: HTMLElement;
  readonly core: HTMLElement;
  readonly flash: HTMLElement;
  readonly grip: HTMLDivElement;
  readonly pill: HTMLElement;
  readonly faceDots: HTMLDivElement;
  readonly faceRow: HTMLDivElement;
  readonly minBtn: HTMLButtonElement;
  readonly delBtn: HTMLButtonElement;
  #delArmed: { timer: ReturnType<typeof setTimeout>; unEsc: () => void; off: () => void } | null = null;
  readonly zones = new Map<Edge, HTMLDivElement>();
  readonly peekL: HTMLDivElement;
  readonly peekR: HTMLDivElement;
  #faceBtns: HTMLButtonElement[] = [];
  #breath: Animation;
  #blink: Animation | null = null;
  #n = 1;
  #status: AppStatus = 'idle';
  #small = false;
  #tokens: Tokens;
  #gone = false;
  /** Senast skrivna storlek per zon: vid en ren panorering skrivs bara transformer. */
  #sizes = new Map<HTMLElement, string>();

  constructor(layer: HTMLElement, tokens: Tokens, h: ChromeHandlers) {
    this.#tokens = tokens;
    this.root = el('div', 'wb-cw', layer);

    // Titt-zoner (under storlekszonerna i staplingen).
    this.peekL = el('div', 'wb-peek', this.root);
    this.peekR = el('div', 'wb-peek', this.root);
    for (const [z, dir] of [[this.peekL, -1], [this.peekR, 1]] as const) {
      z.addEventListener('pointerenter', () => h.peek(dir));
      z.addEventListener('pointerleave', () => h.peek(0));
      z.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        h.focus();
      });
      z.addEventListener('click', (e) => {
        e.stopPropagation();
        h.peekClick(dir);
      });
    }

    for (const edge of EDGES) {
      const z = el('div', `wb-zone wb-zone-${edge}`, this.root);
      z.dataset.edge = edge;
      z.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        h.focus();
        h.zoneDown(e, edge);
      });
      // Titten fortsätter när pekaren går vidare från titt-zonen in i storlekszonen.
      if (edge === 'e' || edge === 'w') {
        const dir = edge === 'e' ? 1 : -1;
        z.addEventListener('pointerenter', () => {
          if (this.peekL.style.display !== 'none') h.peek(dir);
        });
        z.addEventListener('pointerleave', (e) => {
          const to = e.relatedTarget;
          if (to !== this.peekL && to !== this.peekR) h.peek(0);
        });
      }
      this.zones.set(edge, z);
    }

    this.grip = el('div', 'wb-grip', this.root);
    this.pill = el('i', '', this.grip);
    this.grip.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      h.focus();
      h.gripDown(e);
    });
    this.grip.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      h.gripDouble();
    });

    this.faceDots = el('div', 'wb-facedots', this.root);
    this.faceRow = el('div', 'wb-facedots-row', this.faceDots);

    // Minimera (§10.7): en liten nedåtpil till höger om greppet. Den tar inte fokus från en HUD:s inmatning.
    this.minBtn = el('button', 'wb-minbtn', this.root);
    this.minBtn.type = 'button';
    this.minBtn.setAttribute('aria-label', 'Minimera');
    el('i', '', this.minBtn);
    this.minBtn.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      h.focus();
    });
    this.minBtn.addEventListener('mousedown', (e) => e.preventDefault());
    this.minBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      h.minimize();
    });

    // Ta bort (§10.5): ett kryss till höger om minimeringen. Första klicket gör det till en röd "Ta bort" som bara
    // gäller en stund; först det andra tar bort appen. Esc, ett klick någon annanstans eller 4 s avbryter.
    this.delBtn = el('button', 'wb-delbtn', this.root);
    this.delBtn.type = 'button';
    this.delBtn.setAttribute('aria-label', 'Ta bort appen');
    el('i', '', this.delBtn);
    el('span', '', this.delBtn).textContent = 'Ta bort';
    this.delBtn.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      h.focus();
    });
    this.delBtn.addEventListener('mousedown', (e) => e.preventDefault());
    this.delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.#delArmed) {
        this.#disarm();
        h.remove();
      } else this.#arm();
    });

    this.dot = el('button', 'wb-dot', this.root);
    this.dot.type = 'button';
    this.dot.setAttribute('aria-label', 'Chatt');
    this.pop = el('span', 'wb-dot-pop', this.dot);
    this.haloWrap = el('span', 'wb-dot-halo-wrap', this.pop);
    this.halo = el('i', 'wb-dot-halo', this.haloWrap);
    this.flash = el('i', 'wb-dot-flash', this.pop);
    this.core = el('i', 'wb-dot-core', this.pop);
    this.dot.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      h.focus();
    });
    // Pricken tar inte fokus från en öppen HUD:s inmatning när man klickar på den (som HUD:ens ikonknappar).
    // Annars ligger fokus kvar på pricken när den stängt en HUD som inte var aktiv, och nästa mellanslag
    // öppnar den HUD:en igen i stället för att bli tryck-och-prata i den aktiva.
    this.dot.addEventListener('mousedown', (e) => e.preventDefault());
    this.dot.addEventListener('click', (e) => {
      e.stopPropagation();
      h.dot();
    });

    // Andningen är en WAAPI-animation, så att building kan köra den 3,3 gånger fortare utan att fasen hoppar.
    // Med minskad rörelse andas halon bara i ljusstyrka (ingen skalning), så att statusen ändå syns.
    const still = reducedMotion();
    this.#breath = this.halo.animate(
      [
        { transform: still ? 'scale(0.84)' : 'scale(0.62)', opacity: 0.55 },
        { transform: still ? 'scale(0.84)' : 'scale(1.06)', opacity: 1, offset: 0.5 },
        { transform: still ? 'scale(0.84)' : 'scale(0.62)', opacity: 0.55 },
      ],
      { duration: tokens.dotBreathMs, iterations: Infinity, easing: 'ease-in-out' },
    );
    this.setFaces(1, 0, h);
  }

  /** Status → pricken (§10.5): idle andas, building andas 3,3× fortare, waiting blinkar, error/crashed bärnsten. */
  setStatus(status: AppStatus, backend: BackendState): void {
    this.#status = status;
    const amber = status === 'error' || backend === 'crashed';
    this.dot.classList.toggle('wb-amber', amber);
    this.dot.dataset.status = amber ? 'error' : status;
    this.#breath.updatePlaybackRate(status === 'building' ? 3.3 : 1);
    if (status === 'waiting' && !this.#blink) {
      this.#blink = this.core.animate(
        [
          { opacity: 1 },
          { opacity: 1, offset: 0.5 },
          { opacity: 0.18, offset: 0.62 },
          { opacity: 0.18, offset: 0.8 },
          { opacity: 1, offset: 0.92 },
          { opacity: 1 },
        ],
        { duration: 1000, iterations: Infinity },
      );
    } else if (status !== 'waiting' && this.#blink) {
      this.#blink.cancel();
      this.#blink = null;
    }
  }

  get status(): AppStatus {
    return this.#status;
  }

  /** Spelhastigheten för andningen (för tester och mätningar). */
  get breathRate(): number {
    return this.#breath.playbackRate;
  }

  setFaces(n: number, current: number, h: Pick<ChromeHandlers, 'faceDot'>, labels: string[] = []): void {
    if (n !== this.#n || this.#faceBtns.length !== (n > 1 ? n : 0)) {
      this.#n = n;
      this.faceRow.replaceChildren();
      this.#faceBtns = [];
      if (n > 1) {
        for (let i = 0; i < n; i++) {
          const b = el('button', 'wb-facedot', this.faceRow);
          b.type = 'button';
          b.setAttribute('aria-label', labels[i] || `Sida ${i + 1}`);
          el('i', '', b);
          b.addEventListener('pointerdown', (e) => e.stopPropagation());
          b.addEventListener('click', (e) => {
            e.stopPropagation();
            h.faceDot(i);
          });
          this.#faceBtns.push(b);
        }
      }
    }
    this.#faceBtns.forEach((b, i) => {
      b.classList.toggle('wb-on', i === current);
      if (labels[i]) b.setAttribute('aria-label', labels[i]);
    });
  }

  layout(L: ChromeLayout): void {
    if (this.#gone) return;
    const r = L.rect;
    at(this.dot, L.dot.x, L.dot.y);
    if (L.small !== this.#small) {
      this.#small = L.small;
      this.dot.classList.toggle('wb-small', L.small);
    }
    this.dot.classList.toggle('wb-covered', L.dotHidden);

    // Greppet: 10 px under nederkanten, mitt under fönstret. Sidprickarna till vänster om det.
    const tiny = r.w < 90 || r.h < 40;
    const gx = r.x + r.w / 2;
    const gy = Math.max(r.y + r.h, L.bottom ?? -Infinity) + 10 + 2.5;
    at(this.grip, gx, gy);
    this.grip.classList.toggle('wb-hidden', tiny || L.gripHidden);
    at(this.faceDots, gx - 22 - 10, gy);
    this.faceDots.classList.toggle('wb-hidden', tiny || L.gripHidden || this.#n <= 1);
    at(this.minBtn, gx + 22 + 16, gy);
    this.minBtn.classList.toggle('wb-hidden', tiny || L.gripHidden || !L.interactive);
    at(this.delBtn, gx + 22 + 16 + 24, gy);
    const delHidden = tiny || L.gripHidden || !L.interactive;
    if (delHidden) this.#disarm();
    this.delBtn.classList.toggle('wb-hidden', delHidden);

    // Storlekszonerna, 10 px utanför kanter och hörn (hörnen når 4 px in i hörnets rundning).
    const show = L.interactive && !tiny;
    const Z = ZONE;
    const C = ZONE + 4;
    const place = (edge: Edge, x: number, y: number, w: number, h: number): void => {
      const z = this.zones.get(edge) as HTMLDivElement;
      if (!show) {
        z.style.display = 'none';
        return;
      }
      z.style.display = '';
      this.#size(z, w, h);
      at(z, x, y);
    };
    place('n', r.x, r.y - Z, r.w, Z);
    place('s', r.x, r.y + r.h, r.w, Z);
    place('w', r.x - Z, r.y, Z, r.h);
    place('e', r.x + r.w, r.y, Z, r.h);
    place('nw', r.x - Z, r.y - Z, C, C);
    place('ne', r.x + r.w - 4, r.y - Z, C, C);
    place('sw', r.x - Z, r.y + r.h - 4, C, C);
    place('se', r.x + r.w - 4, r.y + r.h - 4, C, C);

    // Titt-zonerna: 24 px utanför sidokanterna, mittre 76 % av höjden.
    const peekOn = show && L.prism;
    for (const [z, x] of [[this.peekL, r.x - PEEK_ZONE], [this.peekR, r.x + r.w]] as const) {
      if (!peekOn) {
        z.style.display = 'none';
        continue;
      }
      z.style.display = '';
      this.#size(z, PEEK_ZONE, r.h * 0.76);
      at(z, x, r.y + r.h * 0.12);
    }
  }

  #size(z: HTMLElement, w: number, h: number): void {
    const key = `${Math.max(0, w).toFixed(2)}|${Math.max(0, h).toFixed(2)}`;
    if (this.#sizes.get(z) === key) return;
    this.#sizes.set(z, key);
    z.style.width = `${Math.max(0, w).toFixed(2)}px`;
    z.style.height = `${Math.max(0, h).toFixed(2)}px`;
  }

  /** Pricken tänds (§14 Materialisering steg 3) och greppet växer fram. */
  ignite(delay: number): void {
    const t = this.#tokens;
    if (reducedMotion()) {
      for (const e of [this.pop, this.pill]) e.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, delay, easing: 'ease-out', fill: 'backwards' });
      return;
    }
    this.pop.animate([{ transform: 'scale(0)', opacity: 0 }, { transform: 'scale(1)', opacity: 1 }], {
      duration: t.pop.ms,
      delay,
      easing: t.pop.css,
      fill: 'backwards',
    });
    this.pill.animate([{ transform: 'scaleX(0.3)', opacity: 0 }, { transform: 'none', opacity: 1 }], {
      duration: t.soft.ms,
      delay,
      easing: t.soft.css,
      fill: 'backwards',
    });
  }

  /** Pricken "sväljer" HUD:en: skala 1,6 med --wb-spring-pop och en blixtring på 760 ms. */
  gulp(): void {
    if (reducedMotion()) return;
    const t = this.#tokens;
    this.pop.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.6)', offset: 0.22 }, { transform: 'scale(1)' }], {
      duration: t.pop.ms,
      easing: 'cubic-bezier(.2,.8,.2,1)',
    });
    this.flash.animate([{ opacity: 0.95, transform: 'scale(0.7)' }, { opacity: 0, transform: 'scale(3.4)' }], {
      duration: 760,
      easing: 'cubic-bezier(.15,.7,.25,1)',
    });
  }

  /** Lyft greppet medan fönstret dras. */
  setActive(on: boolean): void {
    this.grip.classList.toggle('wb-active', on);
  }

  #arm(): void {
    if (this.#delArmed || this.#gone) return;
    this.delBtn.classList.add('wb-armed');
    this.delBtn.setAttribute('aria-label', 'Bekräfta: ta bort appen');
    const away = (e: PointerEvent): void => {
      if (!(e.target instanceof Node && this.delBtn.contains(e.target))) this.#disarm();
    };
    document.addEventListener('pointerdown', away, true);
    this.#delArmed = {
      timer: setTimeout(() => this.#disarm(), 4000),
      unEsc: pushEscape(() => {
        if (this.#delArmed) this.#delArmed.unEsc = () => {};
        this.#disarm();
      }),
      off: () => document.removeEventListener('pointerdown', away, true),
    };
  }

  #disarm(): void {
    const a = this.#delArmed;
    if (!a) return;
    this.#delArmed = null;
    clearTimeout(a.timer);
    a.unEsc();
    a.off();
    this.delBtn.classList.remove('wb-armed');
    this.delBtn.setAttribute('aria-label', 'Ta bort appen');
  }

  dissolve(): void {
    if (this.#gone) return;
    this.#disarm();
    this.#gone = true;
    // Som fönstret: pricken, greppet och zonerna har pointer-events: auto och skulle annars fånga pekaren.
    this.root.classList.add('wb-gone');
    this.root.inert = true;
    const a = this.root.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 220, easing: 'ease-out', fill: 'forwards' });
    const done = (): void => this.root.remove();
    void a.finished.then(done, done);
  }
}

/** Kantmarkörer: en 8 px prick vid vyns kant för varje fönster helt utanför bild. Klick flyger dit. */
export class Markers {
  readonly root: HTMLDivElement;
  #items = new Map<string, HTMLButtonElement>();
  #onClick: (appId: string) => void;

  constructor(layer: HTMLElement, onClick: (appId: string) => void) {
    this.root = el('div', 'wb-markers', layer);
    this.#onClick = onClick;
  }

  /** points: appId → skärmpunkt, eller null när fönstret syns. */
  update(points: Map<string, { x: number; y: number } | null>): void {
    for (const [appId, b] of this.#items) {
      if (!points.get(appId)) {
        b.remove();
        this.#items.delete(appId);
      }
    }
    for (const [appId, p] of points) {
      if (!p) continue;
      let b = this.#items.get(appId);
      if (!b) {
        b = el('button', 'wb-marker', this.root);
        b.type = 'button';
        b.dataset.app = appId;
        b.setAttribute('aria-label', 'Flyg dit');
        el('i', '', b);
        b.addEventListener('pointerdown', (e) => e.stopPropagation());
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          this.#onClick(appId);
        });
        this.#items.set(appId, b);
      }
      at(b, p.x, p.y);
    }
  }
}
