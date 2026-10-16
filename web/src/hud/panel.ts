// panel.ts — en HUD-panel för en app och dess tillstånd (CONTRACT §13, §14): bygger DOM:en, renderar chatten,
// följer fönstret, glider ut under fönstrets kant och sjunker in i pricken. En panel skapas när appens HUD öppnas
// och kastas när den stängs; den byter aldrig app. Det som delas mellan HUD:arna (Esc, rösten, utkasten, vilken som
// är aktiv, ordningen och lagringen) ägs av hanteraren i hud.ts via PanelHost.
// Alla strängar från Claude, appar och servern sätts med textContent eller byggda noder, aldrig som HTML.
import type { AppStatus } from '../../../shared/protocol.ts';
import type { ScreenRect, World } from '../types.ts';
import { store } from '../store.ts';
import { parseMarkdown, plainText } from './markdown.ts';
import { renderBlocks } from './markdown-dom.ts';
import { candidate, follow, GAP, GAP_BELOW, MARGIN, type Placement, type Side } from './placement.ts';
import * as M from './model.ts';
import { askCard, el, type Card } from './asks.ts';
import * as grants from './grants.ts';
import { createMenu, type Menu } from './menu.ts';
import type { VoiceFailure, VoiceState } from './voice.ts';
import { clamp01, easeOutCubic, lerp, reducedMotion, Spring, spring } from './motion.ts';
import { tetherBetween } from './tether.ts';
import { guardFocus } from './focusguard.ts';
import './activity.css';

export type Reason = 'created' | 'dot' | 'key' | 'auto';
export type CloseHow = 'esc' | 'close' | 'removed' | 'deleted';

/** Det panelen får av hanteraren (hud.ts). Allt som gäller flera HUD:ar går hit. */
export interface PanelHost {
  readonly world: World;
  /** Den gemensamma .wbh-root: varje panel och varje kopia som fälls ihop ligger där. */
  readonly root: HTMLElement;
  /** Pågående ihopfällningar per app, så att en snabb återöppning kan avbryta dem. */
  readonly ghosts: Map<string, () => void>;
  draft(appId: string): string;
  /** '' tar bort utkastet. Sparas. */
  setDraft(appId: string, text: string): void;
  noteSent(appId: string, via: 'text' | 'voice'): void;
  isActive(appId: string): boolean;
  /** Pekaren eller tangentbordsfokus gick in i panelen. */
  activate(appId: string, from: 'pointer' | 'focus'): void;
  /** Ta bort appen (⋯-menyn). */
  remove(appId: string): void;
  /** Andra fönster, och målrektanglarna för HUD:ar som öppnades före den här. */
  obstacles(appId: string): { windows: ScreenRect[]; huds: ScreenRect[] };
  /** Panelens målrektangel ändrades: HUD:ar som öppnades efter den placeras om. sideChanged: sidan sparas. */
  moved(appId: string, sideChanged: boolean): void;
  /** Kameran eller fönstren rör sig just nu (då prövas inte äldre HUD:ar, se placement.follow). */
  cameraMoving(): boolean;
  voiceStart(appId: string): void;
  voiceStop(appId: string): void;
  announce(appId: string, text: string, kind: 'reply' | 'card' | 'line'): void;
}

const SLIDE_DELAY_CREATED = 220;
const SWITCH_MS = 220;
const COLLAPSE_MS = 370;
const DOT = 11;
const LINE = 22;
const MAX_LINES = 6;
/**
 * Medan Claude arbetar växer panelen i steg: varje gång innehållet passerar golvet läggs plats för
 * aktivitetsraden och ett par rader text till på en gång. Då står inmatningen och stoppknappen still
 * medan texten strömmar in, i stället för att krypa nedåt med varje rad (uppmätt 77 px på 500 ms).
 */
const BUSY_STEP = 96;
/**
 * Högsta höjden: därefter skrollar listan. Anders 16 oktober: "lång historik borde väl lösas med overflow scroll inte
 * ett större och större fönster". Förut min(70vh, 560 px), som gav HUD:ar som täckte andra appar och varandra.
 */
const MAX_H = 320;
const MAX_VH = 0.4;
/** Aktivitetsradens prick andas i samma takt som appens prick under building (world/chrome.ts, §14). */
const BUILDING_RATE = 3.3;
/**
 * Panelens kantljus andas med halva prickens takt (cirka 1,94 s): en hel panel som pulserar varje 0,97 s blir
 * jäktig, och 1,9 s är samma andetag som fröytans ljusband och svepet. Prickens topp ligger mitt i varvet;
 * kantljuset börjar en kvarts varv in, så att dess topp sammanfaller med varannan topp hos pricken.
 */
const RIM_RATE = BUILDING_RATE / 2;
const RIM_ITERATION_START = 0.25;
/**
 * Allt som andas medan Claude arbetar går på dokumentets tidslinje från 0 (startTime 0), som svepet: pricken och
 * kantljuset slår aldrig mot varandra, oavsett när de skapas (ny tur, HUD:en öppnad igen, omladdning).
 */
const BREATH_START = 0;
/** När turen är slut tonar raden ut (§13 punkt 3). */
const ACTIVITY_FADE_MS = 160;

/** --wb-dot-breath i ms (världens andning i vila; building spelar den BUILDING_RATE gånger fortare). */
function breathMs(): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--wb-dot-breath').trim();
  const v = parseFloat(raw);
  if (!Number.isFinite(v) || v <= 0) return 3200;
  return raw.endsWith('ms') ? v : v * 1000;
}

const FAIL_TEXT: Record<VoiceFailure, string | null> = {
  short: null,
  silent: 'Hörde inget',
  denied: 'Ingen åtkomst till mikrofonen',
  stt: 'Kunde inte tolka talet',
  unsupported: 'Röstinmatning stöds inte här',
};

/* ------------------------------ ikoner (byggda, inte HTML) ------------------------------ */

type Shape = [tag: string, attrs: Record<string, string>];

function icon(shapes: Shape[], cls: string): SVGSVGElement {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', cls);
  for (const [tag, attrs] of shapes) {
    const s = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) s.setAttribute(k, v);
    svg.append(s);
  }
  return svg;
}

const MIC: Shape[] = [
  ['rect', { x: '9', y: '3.25', width: '6', height: '11.25', rx: '3' }],
  ['path', { d: 'M5.75 11.25a6.25 6.25 0 0 0 12.5 0' }],
  ['path', { d: 'M12 17.5v3' }],
];
const STOP: Shape[] = [['rect', { x: '7.25', y: '7.25', width: '9.5', height: '9.5', rx: '2.25' }]];
const MORE: Shape[] = [
  ['circle', { cx: '6.5', cy: '12', r: '1.55' }],
  ['circle', { cx: '12', cy: '12', r: '1.55' }],
  ['circle', { cx: '17.5', cy: '12', r: '1.55' }],
];

function iconButton(label: string, shapes: Shape[], cls: string, iconCls: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `wbh-icon ${cls}`;
  b.setAttribute('aria-label', label);
  b.append(icon(shapes, iconCls));
  // Knapparna tar inte fokus från inmatningen när man klickar.
  b.addEventListener('mousedown', (e) => e.preventDefault());
  return b;
}

/* ---------------------------------------- panelen ---------------------------------------- */

export class HudPanel {
  readonly el: HTMLDivElement;
  readonly panel: HTMLDivElement;
  readonly scroll: HTMLDivElement;
  readonly content: HTMLDivElement;
  readonly msgs: HTMLDivElement;
  /** Meddelanden som köats medan turen pågår: under turens levande text tills turen fått sin text (model.messages). */
  readonly queued: HTMLDivElement;
  readonly live: HTMLDivElement;
  readonly error: HTMLDivElement;
  readonly cards: HTMLDivElement;
  readonly activity: HTMLDivElement;
  /** Aktivitetsradens LED-prick (halo + kärna) och spåret som etiketterna glider i. */
  readonly actHalo: HTMLElement;
  readonly actTrack: HTMLSpanElement;
  /** Kantljuset (kuvertet) och dess två ljus: en skarp kant och ett mjukt sken (activity.css). */
  readonly rim: HTMLElement;
  readonly rimLights: readonly [edge: HTMLElement, glow: HTMLElement];
  readonly lines: HTMLDivElement;
  readonly composer: HTMLDivElement;
  readonly input: HTMLTextAreaElement;
  readonly more: HTMLButtonElement;
  readonly stopBtn: HTMLButtonElement;
  readonly mic: HTMLButtonElement;
  readonly menu: Menu;
  /** Linjen från appens prick till panelen (§14), under alla paneler i .wbh-root. */
  readonly tether: SVGSVGElement;
  readonly #tetherLine: SVGLineElement;
  /** --wb-hud-radius i px, för linjens slutpunkt på panelens rundade kant. */
  #radius = 22;

  readonly appId: string;
  readonly reason: Reason;
  sentSinceOpen: boolean;

  #host: PanelHost;
  #world: World;
  #ro: ResizeObserver;
  #disposed = false;
  /** Den aktiva HUD:en (§13). De andra är lugnare: ingen andning, inget svep, inga globala rader (§14). */
  #active = false;
  #initialSide: Side | null;
  #placement: Placement | null = null;
  /** Målrektangeln (sluthöjd) som HUD:ar som öppnades senare undviker. */
  #target: ScreenRect | null = null;
  #pos = { x: 0, y: 0 };
  #switch: { from: { x: number; y: number }; t0: number } | null = null;
  #height = new Spring(54, 300, 34);
  #raf = 0;
  #lastT = 0;
  #slide: Animation | null = null;
  #rendered = new Map<string, HTMLElement>();
  #cards = new Map<string, { card: Card | null; el: HTMLElement }>();
  #activityText: string | null = null;
  /** Raden visas (Claude arbetar), med eller utan etikett. */
  #activityOn = false;
  #breath: Animation | null = null;
  #activityFade: Animation | null = null;
  /** Kantljuset: av, på (andas) eller på väg ut (tonar ut på 160 ms medan det andas vidare). */
  #rimState: 'off' | 'on' | 'leaving' = 'off';
  #rimFade: Animation | null = null;
  #rimBreath: Animation[] = [];
  #liveText = '';
  #lastLive = '';
  #linesKey = '';
  #transient: { text: string; timer: ReturnType<typeof setTimeout> } | null = null;
  #spaceHeld = false;
  #stick = true;
  /** När användaren senast skrollade själv (hjul, pekare, tangent). Bara sådana skrollningar släpper botten. */
  #userScrollAt = 0;
  #width = 360;

  constructor(host: PanelHost, appId: string, reason: Reason, sent: boolean, side: Side | null = null) {
    this.#host = host;
    this.#world = host.world;
    this.appId = appId;
    this.reason = reason;
    this.sentSinceOpen = sent;
    this.#initialSide = side;
    this.el = el('div', 'wbh');
    this.el.hidden = true;
    this.el.setAttribute('role', 'dialog');
    this.el.setAttribute('aria-modal', 'false');
    // En ny panel är lugn tills hanteraren gör den aktiv (setActive), så att en HUD som aldrig varit aktiv
    // (automatiken bakom en annan, eller återställd efter en omladdning) också ser lugn ut.
    this.panel = el('div', 'wbh-panel is-calm');
    this.scroll = el('div', 'wbh-scroll');
    this.content = el('div', 'wbh-content');
    this.msgs = el('div', 'wbh-msgs');
    this.queued = el('div', 'wbh-msgs wbh-queued');
    this.live = el('div', 'wbh-reply wbh-live');
    this.live.hidden = true;
    this.error = el('div', 'wbh-error');
    this.error.hidden = true;
    this.cards = el('div', 'wbh-cards');
    this.activity = el('div', 'wbh-activity');
    this.activity.hidden = true;
    this.activity.setAttribute('aria-hidden', 'true');
    const dot = el('span', 'wbh-act-dot');
    this.actHalo = el('i', 'wbh-act-halo');
    dot.append(this.actHalo, el('i', 'wbh-act-core'));
    this.actTrack = el('span', 'wbh-act-track');
    this.activity.append(dot, this.actTrack);
    this.rim = el('i', 'wbh-rim');
    this.rim.setAttribute('aria-hidden', 'true');
    this.rimLights = [el('i', 'wbh-rim-edge'), el('i', 'wbh-rim-glow')];
    this.rim.append(...this.rimLights);
    this.lines = el('div', 'wbh-lines');
    this.composer = el('div', 'wbh-composer');
    this.input = el('textarea', 'wbh-input');
    this.input.rows = 1;
    this.input.spellcheck = true;
    this.input.setAttribute('aria-label', 'Meddelande');
    this.input.setAttribute('autocomplete', 'off');
    this.more = iconButton('Mer', MORE, 'wbh-more', 'wbh-ico-fill');
    this.stopBtn = iconButton('Stoppa', STOP, 'wbh-stop', 'wbh-ico-fill');
    this.stopBtn.hidden = true;
    this.mic = iconButton('Håll för att tala', MIC, 'wbh-mic', 'wbh-ico-line');
    this.el.dataset.app = appId;
    const NS = 'http://www.w3.org/2000/svg';
    this.tether = document.createElementNS(NS, 'svg');
    this.tether.setAttribute('class', 'wbh-tether is-calm');
    this.tether.setAttribute('aria-hidden', 'true');
    this.tether.dataset.app = appId;
    this.#tetherLine = document.createElementNS(NS, 'line');
    this.tether.append(this.#tetherLine);

    this.content.append(this.msgs, this.live, this.queued, this.error, this.cards, this.activity, this.lines);
    this.scroll.append(this.content);
    this.composer.append(this.input, this.more, this.stopBtn, this.mic);
    this.panel.append(this.scroll, this.composer, this.rim);
    this.el.append(this.panel);
    host.root.append(this.tether, this.el);
    this.#radius = parseFloat(getComputedStyle(this.panel).borderTopLeftRadius) || this.#radius;

    this.menu = createMenu(this.more, this.el, {
      canUndo: () => !this.#disposed && !M.isActive(this.#status()),
      canOpenTab: () => !this.#disposed && !!store.apps.get(this.appId)?.built,
      undo: () => void this.#undo(),
      openTab: () => this.#openTab(),
      minimized: () => (this.#disposed || !this.#world.screenRectOf(this.appId) ? null : this.#world.isMinimized(this.appId)),
      toggleMinimize: () => (this.#world.isMinimized(this.appId) ? this.#world.restore(this.appId) : this.#world.minimize(this.appId)),
      remove: () => this.#remove(),
      closed: (restore) => {
        // Fokus går tillbaka bara till den aktiva HUD:en, aldrig till en som inte är aktiv.
        if (restore && host.isActive(this.appId)) this.focusInput();
      },
    });

    this.#wireComposer();
    // En app som tar fokus av sig själv (autofocus efter ett bygge) tar det inte från den aktiva HUD:ens inmatning.
    guardFocus(this.input, () => !this.#disposed && host.isActive(this.appId));
    // Pekaren eller fokus i panelen gör den aktiv (§13). Pekaren fångas i capture-fasen, också på knappar som
    // inte tar fokus (mikrofonen, ⋯, stopp).
    this.el.addEventListener('pointerdown', () => host.activate(this.appId, 'pointer'), true);
    this.el.addEventListener('focusin', () => host.activate(this.appId, 'focus'));
    // Panelen skrollar också själv (#pin, och webbläsaren när innehållet krymper). De skrollningarna får aldrig
    // släppa botten, annars hamnar nästa svar under inmatningen. Bara en egen skrollning uppåt släpper den.
    const byUser = () => (this.#userScrollAt = performance.now());
    for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const) {
      this.scroll.addEventListener(type, byUser, { passive: true });
    }
    this.scroll.addEventListener('scroll', () => {
      const s = this.scroll;
      const atBottom = s.scrollHeight - s.scrollTop - s.clientHeight < 28;
      if (atBottom) this.#stick = true;
      else if (performance.now() - this.#userScrollAt < 600) this.#stick = false;
      s.classList.toggle('is-scrolled', s.scrollTop > 2);
    });
    this.#ro = new ResizeObserver(() => this.#onResize());
    this.#ro.observe(this.content);
    this.#ro.observe(this.composer);
  }

  /* ------------------------------------- öppna och stänga ------------------------------------- */

  /**
   * Visa panelen (den skapades just). slideDelay: väntan innan utglidningen börjar (ms). focus: inmatningen får
   * fokus (bara när den blir aktiv; automatiken bakom en aktiv HUD tar aldrig fokus).
   */
  show(slideDelay: number, focus: boolean): void {
    this.#resetContent();
    this.input.value = this.#host.draft(this.appId);
    this.el.hidden = false;
    this.#autosize();
    this.renderAll(false);
    this.#height.snap(this.#natural());
    this.panel.style.height = `${this.#height.x}px`;
    // Efter en omladdning står HUD:en kvar på sin sida så länge den är giltig.
    this.#placement = this.#initialSide ? { side: this.#initialSide, x: 0, y: 0 } : null;
    this.#switch = null;
    this.place();
    this.#switch = null;
    this.#stick = true;
    this.#pin();
    this.#slideOut(Math.max(0, Math.min(SLIDE_DELAY_CREATED, slideDelay)));
    if (focus) this.focusInput();
    store.loadHistory(this.appId).catch(() => {});
  }

  /**
   * Aktiv eller lugn (§13, §14). En lugn panel har en mörk slöja (hud.css), ingen andning i prickens halo eller
   * kantljuset, inget svep och inga globala rader. Andningarna avbryts i stället för att pausas: de går på
   * dokumentets tidslinje från BREATH_START, och pause/play skulle flytta fasen mot appens prick.
   */
  setActive(on: boolean): void {
    if (this.#disposed || on === this.#active) return;
    this.#active = on;
    this.el.classList.toggle('is-active', on);
    this.panel.classList.toggle('is-calm', !on);
    this.tether.classList.toggle('is-calm', !on);
    if (!on) this.menu.close(false);
    // Svepet var dolt i den lugna panelen, så dess CSS-animation börjar om nu. Samma fas som på varje rad
    // (startTime 0, §14), så att ljuset inte hoppar när nästa etikett kommer.
    if (on) for (const x of this.actTrack.getAnimations({ subtree: true })) if (x instanceof CSSAnimation) x.startTime = 0;
    this.#syncBreath();
    this.#syncRim();
    this.#renderLines();
    this.#updateHas();
    this.#onResize();
  }

  get active(): boolean {
    return this.#active;
  }

  /** Stäng och kasta panelen. del: Esc på en oanvänd app (hanteraren löser upp och tar bort den). */
  close(how: CloseHow): { del: boolean } {
    const appId = this.appId;
    if (this.#disposed) return { del: false };
    const app = store.apps.get(appId);
    const draft = !!this.input.value.trim();
    const del = how === 'esc' && M.deleteOnEsc({ reason: this.reason, sentSinceOpen: this.sentSinceOpen, built: app?.built, draft });
    this.menu.close(false);
    this.#spaceHeld = false;
    for (const c of this.#cards.values()) c.card?.wipe();
    this.#host.setDraft(appId, this.input.value.trim() && !del ? this.input.value : '');
    if (this.el.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();

    if (how === 'removed' || how === 'deleted') this.#fadeGhost();
    else if (del || this.#slide) this.#retractGhost(appId);
    else this.#collapseGhost(appId);

    this.#slide?.cancel();
    this.#slide = null;
    this.el.getAnimations().forEach((x) => x.cancel());
    this.el.style.clip = '';
    this.#clipSide = null;
    this.el.hidden = true;
    // Linjen tonar bort medan kopian sjunker in i pricken.
    const tether = this.tether;
    tether.classList.remove('is-shown');
    setTimeout(() => tether.remove(), 240);
    // Stängd mitt i en tur: prickens och kantljusets andning (oändlig WAAPI) får inte fortsätta på den dolda panelen.
    this.#activityHide();
    this.#rimOff();
    cancelAnimationFrame(this.#raf);
    this.#raf = 0;
    this.#lastT = 0;
    if (!del && how !== 'removed' && how !== 'deleted') store.send({ t: 'chat.close', appId });
    this.#clearTransient();
    this.#disposed = true;
    this.#ro.disconnect();
    this.el.remove();
    return { del };
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  focusInput(): void {
    if (this.#disposed) return;
    if (document.activeElement !== this.input) this.input.focus({ preventScroll: true });
  }

  /** Startar tryck-för-att-tala med mellanslag (skriv var som helst, tom inmatning). */
  spaceDown(): void {
    if (this.#spaceHeld || this.#disposed) return;
    this.#spaceHeld = true;
    this.#host.voiceStart(this.appId);
  }

  /* ---------------------------------------- rendering ---------------------------------------- */

  #status(): AppStatus | undefined {
    return store.apps.get(this.appId)?.status;
  }

  #resetContent(): void {
    this.#floor = null;
    this.#rendered.clear();
    this.msgs.replaceChildren();
    this.queued.replaceChildren();
    for (const c of this.#cards.values()) c.card?.wipe();
    this.#cards.clear();
    this.cards.replaceChildren();
    this.#activityHide();
    this.#rimOff();
    this.#liveText = '';
    this.#lastLive = '';
    this.live.replaceChildren();
    this.live.hidden = true;
    this.#linesKey = '';
    this.lines.replaceChildren();
    this.error.textContent = '';
    this.error.hidden = true;
    this.content.classList.remove('has');
  }

  /** Rendera allt för den öppna appen. animate = nya delar glider in (inte vid första visningen). */
  renderAll(animate: boolean): void {
    const appId = this.appId;
    if (this.#disposed) return;
    const app = store.apps.get(appId);
    const list = store.chats.get(appId);
    const events = list ?? [];
    const status = app?.status;
    this.el.setAttribute('aria-label', app?.name?.trim() || 'Ny app');
    this.el.classList.toggle('is-busy', M.isActive(status));
    const busyChanged = this.#busy !== M.isActive(status);
    this.#busy = M.isActive(status);
    // Efter en ny snapshot är chatten tömd tills historiken lästs in igen: behåll det som syns så länge.
    const live = store.live.get(appId) ?? '';
    if (list || this.#rendered.size === 0) this.#renderMessages(events, animate, live.trim() !== '');
    this.#renderLive(live);
    this.#renderCards(events, status, animate);
    this.#renderActivity(M.activity(events, status), status);
    this.#renderError(M.turnError(events));
    this.#renderLines();
    this.stopBtn.hidden = !M.isActive(status);
    this.#updateHas();
    // Golvet (BUSY_STEP) sätts och släpps när Claude börjar och slutar arbeta, även om inget byter storlek.
    if (busyChanged) this.#onResize();
  }

  /** Har panelen något ovanför inmatningen? Utan innehåll är hela HUD:en en enda kapsel. */
  #updateHas(): void {
    const has =
      this.msgs.childElementCount > 0 ||
      this.queued.childElementCount > 0 ||
      !this.live.hidden ||
      !this.error.hidden ||
      this.cards.childElementCount > 0 ||
      !this.activity.hidden ||
      this.lines.childElementCount > 0;
    this.content.classList.toggle('has', has);
    this.panel.classList.toggle('is-empty', !has);
  }

  #renderMessages(events: Parameters<typeof M.messages>[0], animate: boolean, streaming: boolean): void {
    const list = M.messages(events, streaming);
    const keep = new Set(list.map((m) => m.key));
    // Ersätter en ny text något som just syntes (turens förra text eller den strömmande texten)?
    let replaced = this.#liveText.trim() !== '';
    for (const [k, node] of this.#rendered) {
      if (!keep.has(k)) {
        if (k.startsWith('t:') && node.isConnected) replaced = true;
        node.remove();
        this.#rendered.delete(k);
      }
    }
    const nodes: HTMLElement[] = [];
    const fresh: Array<{ node: HTMLElement; kind: M.Message['kind']; text: string }> = [];
    for (const m of list) {
      let n = this.#rendered.get(m.key);
      if (!n) {
        n = this.#messageNode(m);
        this.#rendered.set(m.key, n);
        fresh.push({ node: n, kind: m.kind, text: m.text });
      }
      nodes.push(n);
    }
    // Det som köats under turen står under den levande texten; när turen fått sin text flyttas det upp i listan,
    // på samma plats som förut.
    const split = nodes.length - list.queued;
    for (const [box, want] of [[this.msgs, nodes.slice(0, split)], [this.queued, nodes.slice(split)]] as const) {
      const kids = box.children;
      if (want.length !== kids.length || want.some((n, i) => kids[i] !== n)) box.replaceChildren(...want);
    }
    if (!animate || fresh.length === 0 || fresh.length > 4) return;
    const motion = !reducedMotion();
    for (const f of fresh) {
      if (f.kind === 'reply') {
        this.#announce(plainText(parseMarkdown(f.text)), 'reply');
        // Samma text som just strömmade in: ingen ny rörelse, bara ett byte.
        const same = this.#lastLive && f.text.trim().startsWith(this.#lastLive.trim().slice(0, 40));
        if (same || !motion) continue;
        // En annan text på samma plats: den nya tonar upp från halvt synlig, så att platsen aldrig står tom
        // (från 0 gav uppmätt ≈70 ms utan läsbar text, .scratch/rev-frontend/p7-stream.mjs).
        if (replaced) f.node.animate([{ opacity: 0.5 }, { opacity: 1 }], { duration: 240, easing: 'ease-out' });
        else f.node.animate([{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], { duration: 420, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
      } else if (motion) {
        const s = spring('soft');
        f.node.animate([{ opacity: 0, transform: 'translateY(12px)' }, { opacity: 1, transform: 'none' }], { duration: s.ms, easing: s.easing });
      }
    }
  }

  #messageNode(m: M.Message): HTMLElement {
    if (m.kind === 'user') {
      const d = el('div', 'wbh-user', m.text);
      return d;
    }
    if (m.kind === 'note') return el('div', 'wbh-note', m.text);
    const d = el('div', 'wbh-reply');
    d.append(renderBlocks(parseMarkdown(m.text)));
    return d;
  }

  #renderLive(text: string): void {
    if (text === this.#liveText) return;
    this.#liveText = text;
    if (!text.trim()) {
      this.live.hidden = true;
      this.live.replaceChildren();
      return;
    }
    this.#lastLive = text;
    this.live.hidden = false;
    this.live.replaceChildren(renderBlocks(parseMarkdown(text)));
  }

  #renderCards(events: Parameters<typeof M.pendingAsks>[0], status: AppStatus | undefined, animate: boolean): void {
    const appId = this.appId;
    const app = store.apps.get(appId);
    const want = new Map<string, () => { card: Card | null; el: HTMLElement }>();
    for (const p of M.pendingAsks(events, status)) {
      want.set(`ask:${p.id}`, () => {
        const card = askCard(p.ask, (decision, extra) => this.#answer(p.id, decision, extra));
        return { card, el: card.el };
      });
    }
    const perms = app ? grants.pendingFor(appId, app.permissions) : [];
    if (perms.length && app) {
      want.set(`grants:${perms.join(',')}`, () => ({
        card: null,
        el: grants.grantsCard(app.name, perms, () => {
          grants.allow(appId, perms);
          this.renderAll(true);
          if (this.#host.isActive(appId)) this.focusInput();
        }, () => {
          grants.deny(appId, perms);
          this.renderAll(true);
          if (this.#host.isActive(appId)) this.focusInput();
        }),
      }));
    }
    for (const [k, c] of this.#cards) {
      if (want.has(k)) continue;
      this.#cards.delete(k);
      c.card?.wipe();
      // Ett besvarat kort släpper fokus till body redan innan det går (knapparna stängs av, det hemliga fältet tas bort),
      // så body räknas som att fokus låg i kortet.
      const a = document.activeElement;
      const hadFocus = c.el.contains(a) || a === null || a === document.body;
      c.el.classList.add('is-leaving');
      if (animate && !reducedMotion()) {
        c.el.style.pointerEvents = 'none';
        const gone = () => {
          c.el.remove();
          this.#updateHas();
        };
        c.el.animate([{ opacity: 1 }, { opacity: 0, transform: 'scale(0.985)' }], { duration: 200, easing: 'ease-out', fill: 'forwards' }).finished.then(gone, gone);
      } else c.el.remove();
      if (hadFocus && this.#host.isActive(appId)) this.focusInput();
    }
    for (const [k, make] of want) {
      if (this.#cards.has(k)) continue;
      const c = make();
      this.#cards.set(k, c);
      this.cards.append(c.el);
      const title = c.el.getAttribute('aria-label') ?? c.el.querySelector('.wbh-card-title')?.textContent ?? '';
      if (title) this.#announce(title, 'card');
      if (animate && !reducedMotion()) {
        const s = spring('soft');
        c.el.animate([{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'none' }], { duration: s.ms, easing: s.easing });
      }
      // Frågekort får fokus bara när inmatningen är tom, så att ett Enter i en halvskriven rad aldrig svarar, och
      // bara i den aktiva HUD:en: ett kort i en HUD som inte är aktiv tar aldrig fokus (§13).
      // Behörighetskortet tar aldrig fokus: ett Enter av misstag ska inte ge en app mikrofonen.
      const free = () => {
        const a = document.activeElement;
        return this.#host.isActive(appId) && !this.#disposed && !this.input.value.trim() && (a === this.input || a === document.body || a === null || this.el.contains(a));
      };
      const target = c.card?.focusTarget() ?? null;
      // Prövas igen i bildrutan: hann en annan HUD bli aktiv under tiden tar kortet inte fokus från den.
      if (free() && target) requestAnimationFrame(() => {
        if (free()) target.focus({ preventScroll: true });
      });
    }
  }

  #answer(
    askId: string,
    decision: 'allow' | 'allow-always' | 'deny' | 'answered',
    extra?: { answers?: Record<string, string>; secret?: string },
  ): boolean {
    if (this.#disposed) return false;
    return store.send({ t: 'chat.answer', appId: this.appId, askId, decision, ...(extra ?? {}) });
  }

  /**
   * Aktivitetsraden (§13 punkt 3, §14): pricken andas så länge Claude arbetar, även innan första verktyget,
   * och senaste etiketten står efter den. Raden har samma höjd med och utan etikett.
   */
  #renderActivity(a: { label: string | null } | null, status: AppStatus | undefined): void {
    if (!a) {
      // Ett frågekort tar radens plats direkt; när turen är slut tonar raden ut. Kantljuset tonar ut i båda fallen.
      if (this.#activityOn) {
        if (status === 'waiting') this.#activityHide();
        else this.#activityLeave();
      }
      this.#rimLeave();
      this.#activityOn = false;
      this.#activityText = null;
      return;
    }
    const wasOn = this.#activityOn;
    if (!wasOn) this.#activityEnter();
    this.#rimOn();
    this.#activityOn = true;
    const label = a.label;
    if (label === this.#activityText) return;
    this.#activityText = label;
    const old = this.actTrack.lastElementChild as HTMLElement | null;
    const motion = wasOn && !reducedMotion();
    if (old && motion) {
      // Den gamla raden glider upp och bort (§14).
      old.animate([{ transform: 'none', opacity: 1 }, { transform: 'translateY(-100%)', opacity: 0 }], {
        duration: 260,
        easing: 'cubic-bezier(0.4, 0, 1, 1)',
        fill: 'forwards',
      }).finished.then(() => old.remove(), () => old.remove());
    } else old?.remove();
    if (!label) return;
    const line = el('span', 'wbh-activity-line', label);
    const sweep = el('span', 'wbh-act-sweep');
    sweep.dataset.label = label;
    line.append(sweep);
    this.actTrack.append(line);
    // Svepet har samma fas på varje rad (startTime 0 på dokumentets tidslinje), så att ljuset vandrar
    // vidare i stället för att börja om när etiketten byts.
    for (const x of line.getAnimations({ subtree: true })) x.startTime = 0;
    if (!motion) return;
    // En ny rad glider upp: efter den gamla, eller direkt när första etiketten kommer efter pricken.
    const s = spring('soft');
    line.animate([{ transform: 'translateY(100%)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: s.ms, easing: s.easing, delay: old ? 60 : 0, fill: 'backwards' });
  }

  /** Raden visas: pricken börjar andas (samma nyckelbilder och takt som världens prick under building). */
  #activityEnter(): void {
    this.#activityFade?.cancel();
    this.#activityFade = null;
    const row = this.activity;
    row.classList.remove('is-leaving');
    row.style.removeProperty('top');
    row.style.removeProperty('left');
    row.style.removeProperty('width');
    const wasHidden = row.hidden;
    row.hidden = false;
    this.#syncBreath();
    if (wasHidden) row.animate([{ opacity: 0 }, { opacity: 1 }], { duration: ACTIVITY_FADE_MS, easing: 'ease-out' });
  }

  /**
   * Prickens andning finns bara medan raden syns och HUD:en är aktiv. I en lugn HUD står pricken still (§13 punkt 3);
   * blir den aktiv igen skapas andningen på nytt, på samma tidslinje som appens prick (startTime BREATH_START).
   */
  #syncBreath(): void {
    const want = this.#active && !this.#disposed && !this.activity.hidden;
    if (!want) {
      this.#breath?.cancel();
      this.#breath = null;
      return;
    }
    if (this.#breath) return;
    // Med minskad rörelse andas halon bara i ljusstyrka (ingen skala), som världens prick.
    const still = reducedMotion();
    this.#breath = this.actHalo.animate(
      [
        { transform: still ? 'scale(0.84)' : 'scale(0.62)', opacity: 0.55 },
        { transform: still ? 'scale(0.84)' : 'scale(1.06)', opacity: 1, offset: 0.5 },
        { transform: still ? 'scale(0.84)' : 'scale(0.62)', opacity: 0.55 },
      ],
      { duration: breathMs(), iterations: Infinity, easing: 'ease-in-out' },
    );
    this.#breath.playbackRate = BUILDING_RATE;
    this.#breath.startTime = BREATH_START;
  }

  /**
   * Turen är slut: raden tonar ut på 160 ms. Den lämnar flödet direkt men står kvar på sin plats medan den tonar,
   * så att panelen krymper en gång, i samma stund som golvet släpps, och inte en gång till efteråt.
   */
  #activityLeave(): void {
    const row = this.activity;
    if (row.hidden || this.#disposed || this.el.hidden) {
      this.#activityHide();
      return;
    }
    const top = row.offsetTop;
    const left = row.offsetLeft;
    const width = row.offsetWidth;
    row.classList.add('is-leaving');
    row.style.top = `${top}px`;
    row.style.left = `${left}px`;
    row.style.width = `${width}px`;
    this.#activityFade?.cancel();
    const a = row.animate([{ opacity: 1 }, { opacity: 0 }], { duration: ACTIVITY_FADE_MS, easing: 'ease-out', fill: 'forwards' });
    this.#activityFade = a;
    a.finished.then(() => {
      if (this.#activityFade === a) this.#activityHide();
    }, () => {});
  }

  /** Raden borta: inga animationer kvar. */
  #activityHide(): void {
    const fade = this.#activityFade;
    this.#activityFade = null;
    fade?.cancel();
    this.#breath?.cancel();
    this.#breath = null;
    const row = this.activity;
    row.hidden = true;
    row.classList.remove('is-leaving');
    row.style.removeProperty('top');
    row.style.removeProperty('left');
    row.style.removeProperty('width');
    for (const x of row.getAnimations({ subtree: true })) x.cancel();
    this.actTrack.replaceChildren();
    this.#activityOn = false;
    this.#activityText = null;
    this.#updateHas();
  }

  /**
   * Kantljuset tänds (bara under building): kuvertet tonar in på 160 ms, och kanten och skenet andas på prickens
   * tidslinje. Med minskad rörelse andas det inte, utan står stilla (activity.css) och tonar bara in och ut.
   */
  #rimOn(): void {
    if (this.#rimState === 'on') return;
    const from = this.#rimState === 'leaving' ? parseFloat(getComputedStyle(this.rim).opacity) || 0 : 0;
    this.#rimFade?.cancel();
    this.#rimFade = null;
    this.#rimState = 'on';
    this.rim.classList.add('is-on');
    this.#syncRim();
    const a = this.rim.animate([{ opacity: from }, { opacity: 1 }], { duration: ACTIVITY_FADE_MS * (1 - from), easing: 'ease-out' });
    this.#rimFade = a;
    a.finished.then(() => {
      if (this.#rimFade === a) this.#rimFade = null;
    }, () => {});
  }

  /**
   * Kantljusets andning finns bara medan det är tänt och HUD:en är aktiv. I en lugn HUD andas det inte (§14); blir
   * den aktiv igen skapas andningen på nytt på prickens tidslinje (startTime BREATH_START, iterationStart 0,25).
   */
  #syncRim(): void {
    const want = this.#active && !this.#disposed && this.#rimState !== 'off' && !reducedMotion();
    if (!want) {
      for (const a of this.#rimBreath) a.cancel();
      this.#rimBreath = [];
      return;
    }
    if (!this.#rimBreath.length) {
      const ms = breathMs();
      const breathe = (light: HTMLElement, low: number, high: number) => {
        // Mjuk i både topp och dal (lättning per segment), med toppen mitt i varvet som prickens.
        const a = light.animate(
          [
            { opacity: low, easing: 'ease-in-out' },
            { opacity: high, offset: 0.5, easing: 'ease-in-out' },
            { opacity: low },
          ],
          { duration: ms, iterations: Infinity, iterationStart: RIM_ITERATION_START },
        );
        a.playbackRate = RIM_RATE;
        a.startTime = BREATH_START;
        return a;
      };
      const [edge, glow] = this.rimLights;
      this.#rimBreath = [breathe(edge, 0.35, 1), breathe(glow, 0.08, 1)];
    }
  }

  /** Building är slut (turen klar, ett frågekort, fel eller stopp): kantljuset tonar ut på 160 ms. */
  #rimLeave(): void {
    if (this.#rimState !== 'on') return;
    if (this.#disposed || this.el.hidden) {
      this.#rimOff();
      return;
    }
    const from = parseFloat(getComputedStyle(this.rim).opacity);
    this.#rimFade?.cancel();
    this.#rimState = 'leaving';
    this.rim.classList.remove('is-on');
    const a = this.rim.animate([{ opacity: Number.isFinite(from) ? from : 1 }, { opacity: 0 }], { duration: ACTIVITY_FADE_MS, easing: 'ease-out' });
    this.#rimFade = a;
    a.finished.then(() => {
      if (this.#rimFade === a) this.#rimOff();
    }, () => {});
  }

  /** Kantljuset släckt direkt (HUD:en stängs eller byter app): inga animationer kvar. */
  #rimOff(): void {
    const fade = this.#rimFade;
    this.#rimFade = null;
    fade?.cancel();
    for (const a of this.#rimBreath) a.cancel();
    this.#rimBreath = [];
    this.#rimState = 'off';
    this.rim.classList.remove('is-on');
  }

  /** Turfelet i dämpad röd text, direkt efter turens meddelanden, tills en ny tur börjar. */
  #renderError(err: string | null): void {
    const text = err ?? '';
    if (text === (this.error.textContent ?? '') && this.error.hidden === !text) return;
    this.error.textContent = text;
    this.error.hidden = !text;
    if (text) this.#announce(text, 'line');
  }

  /**
   * Tillstånd som bara visas när de gäller: frånkopplad, kvoten och korta lokala rader. Frånkopplingen och kvoten
   * gäller alla appar och står bara i den aktiva HUD:en (inga upprepade rader).
   */
  #renderLines(): void {
    const rows: string[] = [];
    if (this.#active && !store.connected) rows.push('Ingen kontakt med servern');
    const lim = this.#active ? M.limitsSentence(store.limits) : null;
    if (lim) rows.push(lim);
    if (this.#transient) rows.push(this.#transient.text);
    const key = rows.join('\n');
    if (key === this.#linesKey) return;
    this.#linesKey = key;
    this.lines.replaceChildren(...rows.map((r) => el('div', 'wbh-line', r)));
  }

  /** En kort, lokal rad som försvinner av sig själv (t.ex. "Hörde inget"). */
  flash(text: string, ms = 3200): void {
    this.#clearTransient();
    this.#transient = { text, timer: setTimeout(() => this.#clearTransient(true), ms) };
    this.#announce(text, 'line');
    this.renderAll(true);
  }

  #clearTransient(render = false): void {
    if (!this.#transient) return;
    clearTimeout(this.#transient.timer);
    this.#transient = null;
    if (render) this.renderAll(true);
  }

  #announce(text: string, kind: 'reply' | 'card' | 'line'): void {
    if (text) this.#host.announce(this.appId, text, kind);
  }

  /* -------------------------------------- inmatningen -------------------------------------- */

  #wireComposer(): void {
    const ta = this.input;
    ta.addEventListener('keydown', (e) => {
      if (e.isComposing) return;
      if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        this.#submit();
        return;
      }
      if (e.key === ' ' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (this.#spaceHeld) {
          e.preventDefault();
          return;
        }
        if (!ta.value && !e.repeat) {
          e.preventDefault();
          this.spaceDown();
        }
      }
    });
    ta.addEventListener('keyup', (e) => {
      if (e.key === ' ' && this.#spaceHeld) {
        e.preventDefault();
        this.#spaceHeld = false;
        this.#host.voiceStop(this.appId);
      }
    });
    ta.addEventListener('blur', () => {
      if (this.#spaceHeld) {
        this.#spaceHeld = false;
        this.#host.voiceStop(this.appId);
      }
    });
    ta.addEventListener('input', () => this.#autosize());

    const mic = this.mic;
    mic.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      try {
        mic.setPointerCapture(e.pointerId);
      } catch {
        /* pekaren är redan borta */
      }
      this.#host.voiceStart(this.appId);
    });
    const up = () => this.#host.voiceStop(this.appId);
    mic.addEventListener('pointerup', up);
    mic.addEventListener('pointercancel', up);
    mic.addEventListener('keydown', (e) => {
      if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
        e.preventDefault();
        this.#host.voiceStart(this.appId);
      } else if (e.key === ' ' || e.key === 'Enter') e.preventDefault();
    });
    mic.addEventListener('keyup', (e) => {
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        this.#host.voiceStop(this.appId);
      }
    });
    mic.addEventListener('contextmenu', (e) => e.preventDefault());
    this.stopBtn.addEventListener('click', () => {
      if (!this.#disposed) store.send({ t: 'chat.stop', appId: this.appId });
      this.focusInput();
    });
    this.more.addEventListener('click', (e) => this.menu.toggle(e.detail === 0));
  }

  #autosize(): void {
    const ta = this.input;
    const pad = 14;
    ta.style.height = '0px';
    const max = LINE * MAX_LINES + pad;
    const h = Math.max(LINE + pad, Math.min(ta.scrollHeight, max));
    ta.style.height = `${h}px`;
    ta.style.overflowY = ta.scrollHeight > max + 1 ? 'auto' : 'hidden';
    if (!this.#disposed) this.#host.setDraft(this.appId, ta.value);
  }

  #submit(): void {
    const text = this.input.value.trim();
    if (!text || this.#disposed) return;
    if (!this.#send(text, 'text')) return;
    this.input.value = '';
    this.#autosize();
  }

  /** Skicka text som användarens meddelande (ett förslag, §10.8), som från inmatningen. Utkastet står kvar. */
  sendText(text: string): boolean {
    return this.#send(text, 'text');
  }

  #send(text: string, via: 'text' | 'voice'): boolean {
    const appId = this.appId;
    if (this.#disposed) return false;
    const ok = store.send({ t: 'chat.send', appId, text, via });
    if (!ok) {
      this.renderAll(true);
      return false;
    }
    this.sentSinceOpen = true;
    this.#stick = true;
    this.#host.noteSent(appId, via);
    return true;
  }

  /* Rösten ägs av hanteraren; den panel vars HUD spelade in får tillståndet, nivån och texten. */

  voiceLevel(l: number): void {
    this.mic.style.setProperty('--lvl', l.toFixed(3));
  }

  voiceFail(k: VoiceFailure): void {
    const t = FAIL_TEXT[k];
    if (t) this.flash(t);
  }

  voiceState(s: VoiceState): void {
    this.mic.classList.toggle('is-rec', s === 'recording' || s === 'arming');
    this.mic.classList.toggle('is-busy', s === 'checking' || s === 'transcribing');
    this.mic.setAttribute('aria-pressed', String(s === 'recording'));
    this.composer.classList.toggle('is-listening', s === 'recording');
  }

  voiceText(text: string): void {
    if (this.#disposed) return;
    if (this.#send(text, 'voice')) return;
    // Ingen kontakt: texten hamnar i inmatningen i stället för att försvinna.
    this.input.value = this.input.value ? `${this.input.value} ${text}` : text;
    this.#autosize();
    if (this.#host.isActive(this.appId)) this.focusInput();
  }

  /* ---------------------------------------- menyn ---------------------------------------- */

  async #undo(): Promise<void> {
    const appId = this.appId;
    if (this.#disposed) return;
    try {
      const ok = await store.undo(appId);
      if (!ok && !this.#disposed) this.flash('Det finns inget att ångra');
    } catch {
      if (!this.#disposed) this.flash(store.connected ? 'Claude arbetar just nu' : 'Ingen kontakt med servern');
    }
  }

  #openTab(): void {
    if (this.#disposed) return;
    const port = location.port ? `:${location.port}` : '';
    window.open(`${location.protocol}//${this.appId}.localhost${port}/`, '_blank', 'noopener,noreferrer');
  }

  #remove(): void {
    if (!this.#disposed) this.#host.remove(this.appId);
  }

  /* ---------------------------------------- placering ---------------------------------------- */

  #rect(appId: string): ScreenRect | null {
    try {
      const r = this.#world.screenRectOf(appId);
      return r && Number.isFinite(r.x) && Number.isFinite(r.y) && r.w > 0 && r.h > 0 ? r : null;
    } catch {
      return null;
    }
  }

  /** Målrektangeln (sluthöjd), som HUD:ar som öppnades efter den här undviker; null innan den placerats. */
  rect(): ScreenRect | null {
    return this.#disposed || this.el.hidden ? null : this.#target;
  }

  #overflowing = false;
  /** Panelens golv medan Claude arbetar (BUSY_STEP), annars null. */
  #floor: number | null = null;
  #busy = false;

  /** Naturlig höjd: inmatningen plus innehållet, högst min(40vh, 320 px). */
  #natural(): number {
    const cs = getComputedStyle(this.panel);
    const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const content = this.content.classList.contains('has') ? this.content.offsetHeight : 0;
    const max = Math.min(innerHeight * MAX_VH, MAX_H);
    const natural = Math.ceil(pad + content + this.composer.offsetHeight);
    this.#overflowing = natural > max;
    // Med toppen fast (höger, vänster, under) skulle varje ny rad flytta inmatningen. Över fönstret, ovanpå det
    // och dockad står botten redan fast.
    // Utan innehåll (historiken inte inläst än) är HUD:en bara kapseln, och då reserveras ingenting.
    const side = this.#placement?.side;
    const topAnchored = side !== 'above' && side !== 'overlay' && side !== 'dock';
    if (!this.#busy || !topAnchored || content === 0) {
      this.#floor = null;
      return Math.min(max, natural);
    }
    if (this.#floor === null || natural > this.#floor) this.#floor = Math.min(max, natural + BUSY_STEP);
    // Golvet får aldrig ta mer plats än det finns under toppen: då kläms panelen uppåt i vyn, och under fönstret
    // hamnade den över greppet eller på det egna fönstret och bytte sida mitt i turen (uppmätt vid 1024×700).
    // Toppen räknas från fönstret, inte från platsen: den är redan klämd i vyn när fönstret flyttats nedåt.
    const own = this.#rect(this.appId);
    const top = !own ? MARGIN : side === 'below' ? own.y + own.h + GAP_BELOW : Math.max(MARGIN, own.y);
    const room = innerHeight - MARGIN - top;
    return Math.min(max, Math.max(natural, Math.min(this.#floor, room)));
  }

  /** Följ botten bara när innehållet inte ryms; annars står listan i toppen även medan panelen växer. */
  #pin(): void {
    if (this.#overflowing) {
      if (this.#stick) this.scroll.scrollTop = this.scroll.scrollHeight;
    } else if (this.scroll.scrollTop !== 0) this.scroll.scrollTop = 0;
  }

  /** Vyn eller innehållet bytte storlek. */
  onResize(): void {
    this.#onResize();
  }

  #onResize(): void {
    if (this.#disposed) return;
    const h = this.#natural();
    if (Math.abs(h - this.#height.to) > 0.5) {
      this.#height.to = h;
      if (reducedMotion()) this.#height.snap(h);
      this.#kick();
    }
    this.#pin();
  }

  #kick(): void {
    if (!this.#raf) this.#raf = requestAnimationFrame((t) => this.#tick(t));
  }

  #tick(t: number): void {
    this.#raf = 0;
    if (this.#disposed) return;
    const dt = this.#lastT ? Math.min(0.05, (t - this.#lastT) / 1000) : 1 / 60;
    this.#lastT = t;
    const moving = this.#height.step(dt);
    this.panel.style.height = `${this.#height.x.toFixed(2)}px`;
    if (moving) this.#pin();
    const switching = this.place(t);
    if (moving || switching) this.#kick();
    else this.#lastT = 0;
  }

  /** Följ fönstret (anropas vid view:changed och varje bildruta medan något rör sig). */
  place(now = performance.now()): boolean {
    const appId = this.appId;
    if (this.#disposed) return false;
    const own = this.#rect(appId);
    const view = { w: innerWidth, h: innerHeight };
    const size = { w: this.#width, h: this.#height.x };
    const sizeFinal = { w: this.#width, h: Math.max(this.#height.x, this.#height.to) };
    const { windows, huds } = this.#host.obstacles(appId);
    const p = follow(this.#placement?.side ?? null, own, windows, sizeFinal, view, huds, this.#host.cameraMoving());
    const at = candidate(p.side, own, size, view);
    // Målet som senare HUD:ar undviker: sidan och sluthöjden. Ändras det placeras de om (hanteraren samlar det).
    const fin = candidate(p.side, own, sizeFinal, view);
    const prev = this.#target;
    const target = { x: fin.x, y: fin.y, w: sizeFinal.w, h: sizeFinal.h };
    this.#target = target;
    const sideChanged = p.side !== this.#placement?.side;
    if (!prev || sideChanged || Math.abs(prev.x - target.x) > 0.5 || Math.abs(prev.y - target.y) > 0.5 || Math.abs(prev.h - target.h) > 0.5) {
      this.#host.moved(appId, sideChanged);
    }
    if (this.#placement && p.side !== this.#placement.side && !reducedMotion()) {
      this.#switch = { from: { ...this.#pos }, t0: now };
    }
    this.#placement = { side: p.side, x: at.x, y: at.y };
    this.el.dataset.side = p.side;
    let { x, y } = at;
    let switching = false;
    if (this.#switch) {
      const k = (now - this.#switch.t0) / SWITCH_MS;
      if (k >= 1) this.#switch = null;
      else {
        const e = easeOutCubic(clamp01(k));
        x = lerp(this.#switch.from.x, x, e);
        y = lerp(this.#switch.from.y, y, e);
        switching = true;
      }
    }
    this.#pos = { x, y };
    if (!switching) {
      // I vila på hela enhetspixlar, så att texten är skarp.
      const d = devicePixelRatio || 1;
      x = Math.round(x * d) / d;
      y = Math.round(y * d) / d;
    }
    this.el.style.transform = `translate(${x}px, ${y}px)`;
    // Under utglidningen står klippet vid fönstrets kant även om panelen växer (ovanför fönstret beror kanten på höjden).
    if (this.#clipSide) this.el.style.clip = this.#edgeClip(this.#clipSide, this.#height.x) ?? '';
    this.#drawTether(x, y);
    if (switching) this.#kick();
    return switching;
  }

  /** Linjen mellan appens fönster och panelen, kant mot kant, i samma bildruta som panelen flyttas. */
  #drawTether(x: number, y: number): void {
    const own = this.#rect(this.appId);
    const s = own ? tetherBetween(own, this.#winRadius(own), { x, y, w: this.#width, h: this.#height.x }, this.#radius) : null;
    const l = this.#tetherLine;
    if (!s) {
      l.style.display = 'none';
      return;
    }
    l.style.display = '';
    l.setAttribute('x1', s.x1.toFixed(2));
    l.setAttribute('y1', s.y1.toFixed(2));
    l.setAttribute('x2', s.x2.toFixed(2));
    l.setAttribute('y2', s.y2.toFixed(2));
  }

  /** Vid view:changed: följ fönstret i samma bildruta. */
  onView(): void {
    if (this.#disposed) return;
    this.place();
    // Golvet (BUSY_STEP) får bara ta den plats som finns under toppen, och den ändras när fönstret rör sig.
    if (this.#floor !== null) this.#onResize();
  }

  get side(): Side | null {
    return this.#placement?.side ?? null;
  }

  /* ------------------------------------------ rörelser ------------------------------------------ */

  /**
   * Klippet vid fönstrets kant under utglidningen, som `clip: rect()` på föräldern (position: absolute), i px från
   * föräldens övre vänstra hörn. Bara sidan mot fönstret klipps; de andra ligger långt ut. Inte clip-path: en
   * förälder med clip-path blir backdrop root, och då ser glasets backdrop-filter inte sidan bakom. HUD:en var då
   * klar och ljus under utglidningen och frostades först när klippet släpptes (uppmätt i Chrome, en sekund vid
   * varje öppning). clip: rect() klipper utan att ändra det glaset ser.
   */
  #edgeClip(side: string, H: number): string | null {
    const W = this.#width;
    const F = 4000;
    switch (side) {
      case 'right':
        return `rect(${-F}px, ${W + F}px, ${H + F}px, ${-GAP}px)`;
      case 'left':
        return `rect(${-F}px, ${W + GAP}px, ${H + F}px, ${-F}px)`;
      case 'below':
        return `rect(${-GAP_BELOW}px, ${W + F}px, ${H + F}px, ${-F}px)`;
      case 'above':
        return `rect(${-F}px, ${W + F}px, ${H + GAP}px, ${-F}px)`;
      default:
        return null;
    }
  }

  /** Sidan vars kant klipper utglidningen just nu (null när ingen utglidning pågår). */
  #clipSide: string | null = null;

  /**
   * Glid ut under fönstrets kant, klippt i skärmkoordinater vid kanten (§14 steg 4).
   * Bara panelens transform animeras (kompositorn); klippet sitter stilla på föräldern vid fönstrets kant.
   * Att animera klippet och transformen var för sig gav glapp mellan dem (uppmätt), eftersom klippet
   * räknas på huvudtråden medan transformen går i kompositorn.
   */
  #slideOut(delay: number): void {
    const side = this.#placement?.side ?? 'dock';
    const W = this.#width;
    const H = this.#height.x;
    const soft = spring('soft');
    const from: Record<string, string> = {
      right: `translateX(${-(W + GAP)}px)`,
      left: `translateX(${W + GAP}px)`,
      below: `translateY(${-(H + GAP_BELOW)}px)`,
      above: `translateY(${H + GAP}px)`,
    };
    this.el.getAnimations().forEach((x) => x.cancel());
    let kf: Keyframe[];
    const clip = !reducedMotion() ? this.#edgeClip(side, H) : null;
    if (reducedMotion()) kf = [{ opacity: 0 }, { opacity: 1 }];
    else if (clip) kf = [{ transform: from[side] }, { transform: 'translate(0px, 0px)' }];
    else kf = [{ opacity: 0, transform: 'translateY(10px) scale(0.98)' }, { opacity: 1, transform: 'none' }];
    this.el.style.clip = clip ?? '';
    this.#clipSide = clip ? side : null;
    const a = this.panel.animate(kf, { duration: reducedMotion() ? 160 : soft.ms, easing: soft.easing, delay, fill: 'backwards' });
    this.#slide = a;
    a.finished.then(
      () => {
        if (this.#slide !== a) return;
        this.#slide = null;
        // Linjen tonar in när panelen står på sin plats, så att den aldrig pekar på en panel som glider.
        this.tether.classList.add('is-shown');
        const now = this.el.style.clip;
        this.#clipSide = null;
        if (!clip || !now) return;
        // Skuggan mot fönstret klipptes under utglidningen; släpp klippet mjukt när panelen står still.
        const F = 4000;
        const open = `rect(${-F}px, ${this.#width + F}px, ${this.#height.x + F}px, ${-F}px)`;
        const release = this.el.animate([{ clip: now }, { clip: open }], { duration: 220, easing: 'ease-out' });
        this.el.style.clip = '';
        void release.finished.catch(() => {});
      },
      () => {},
    );
  }

  /** En kopia av panelen som kan animeras medan den riktiga panelen redan är fri. */
  #ghost(): { g: HTMLElement; rect: DOMRect } | null {
    if (this.el.hidden) return null;
    const rect = this.panel.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return null;
    const g = this.panel.cloneNode(true) as HTMLElement;
    g.classList.add('wbh-ghost');
    g.setAttribute('aria-hidden', 'true');
    g.inert = true;
    for (const f of g.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea')) f.value = '';
    for (const n of g.querySelectorAll('[id]')) n.removeAttribute('id');
    // Animationer följer inte med en klon: kantljuset fryses i kopian där det var och tonar ut med innehållet.
    const rims = g.querySelectorAll<HTMLElement>('.wbh-rim, .wbh-rim > i');
    [this.rim, ...this.rimLights].forEach((n, i) => {
      if (rims[i]) rims[i].style.opacity = getComputedStyle(n).opacity;
    });
    g.style.position = 'absolute';
    g.style.left = '0';
    g.style.top = '0';
    g.style.margin = '0';
    g.style.width = `${rect.width}px`;
    g.style.height = `${rect.height}px`;
    g.style.transformOrigin = '0 0';
    g.style.transform = `translate(${rect.left}px, ${rect.top}px)`;
    g.style.clipPath = 'none';
    this.#host.root.append(g);
    const gs = g.querySelector<HTMLElement>('.wbh-scroll');
    if (gs) gs.scrollTop = this.scroll.scrollTop;
    return { g, rect };
  }

  /** Ihopfällning (§14): 370 ms, p^1,7, till en 11 px cirkel på pricken, innehållet tonar ut under första 30 %. */
  #collapseGhost(appId: string): void {
    const dot0 = this.#dot(appId);
    const made = this.#ghost();
    if (!made) return;
    const { g, rect } = made;
    if (!dot0 || reducedMotion()) {
      this.#fade(g);
      return;
    }
    // Varje del tonar från sin egen opacitet (kantljuset är fryst där det var, se #ghost).
    const parts = ([...g.children] as HTMLElement[]).map((el) => ({ el, o: el.style.opacity === '' ? 1 : Number(el.style.opacity) || 0 }));
    const W = rect.width;
    const H = rect.height;
    const c0 = { x: rect.left + W / 2, y: rect.top + H / 2 };
    const r0 = parseFloat(getComputedStyle(this.panel).borderTopLeftRadius) || 22;
    const t0 = performance.now();
    let dot = dot0;
    let raf = 0;
    const ghosts = this.#host.ghosts;
    const stop = () => {
      cancelAnimationFrame(raf);
      g.remove();
      if (ghosts.get(appId) === stop) ghosts.delete(appId);
    };
    ghosts.get(appId)?.();
    ghosts.set(appId, stop);
    const frame = (now: number) => {
      const p = clamp01((now - t0) / COLLAPSE_MS);
      const e = p ** 1.7;
      dot = this.#dot(appId) ?? dot;
      const cw = lerp(W, DOT, e);
      const ch = lerp(H, DOT, e);
      const cx = lerp(c0.x, dot.x, e);
      const cy = lerp(c0.y, dot.y, e);
      const sx = cw / W;
      const sy = ch / H;
      const r = Math.min(lerp(r0, DOT / 2, e), Math.min(cw, ch) / 2);
      g.style.transform = `translate(${cx - cw / 2}px, ${cy - ch / 2}px) scale(${sx}, ${sy})`;
      g.style.borderRadius = `${r / sx}px / ${r / sy}px`;
      const fade = 1 - clamp01(p / 0.3);
      for (const part of parts) part.el.style.opacity = String(part.o * fade);
      // Sista fjärdedelen smälter cirkeln in i pricken; världen låter pricken svälja (hud:state, §14).
      g.style.opacity = String(1 - clamp01((p - 0.75) / 0.25));
      if (p < 1) {
        raf = requestAnimationFrame(frame);
        return;
      }
      stop();
    };
    raf = requestAnimationFrame(frame);
  }

  /** Dra tillbaka in under fönstrets kant (Esc på en oanvänd app, eller stängning mitt i utglidningen). */
  #retractGhost(appId: string): void {
    const made = this.#ghost();
    if (!made) return;
    const { g, rect } = made;
    const side = this.#placement?.side;
    const own = this.#rect(appId);
    if (!own || reducedMotion() || !side || !['right', 'left', 'below', 'above'].includes(side)) {
      this.#fade(g);
      return;
    }
    const t0 = performance.now();
    const ms = 200;
    const from = { x: rect.left, y: rect.top };
    const to =
      side === 'right'
        ? { x: own.x + own.w - rect.width, y: rect.top }
        : side === 'left'
          ? { x: own.x, y: rect.top }
          : side === 'below'
            ? { x: rect.left, y: own.y + own.h - rect.height }
            : { x: rect.left, y: own.y };
    const apply = (p: number) => {
      const e = p * p * p;
      const x = lerp(from.x, to.x, e);
      const y = lerp(from.y, to.y, e);
      g.style.transform = `translate(${x}px, ${y}px)`;
      g.style.opacity = String(1 - clamp01((p - 0.6) / 0.4));
      const big = 96;
      g.style.clipPath =
        side === 'right'
          ? `inset(-${big}px -${big}px -${big}px ${Math.max(0, own.x + own.w - x)}px)`
          : side === 'left'
            ? `inset(-${big}px ${Math.max(0, x + rect.width - own.x)}px -${big}px -${big}px)`
            : side === 'below'
              ? `inset(${Math.max(0, own.y + own.h - y)}px -${big}px -${big}px -${big}px)`
              : `inset(-${big}px -${big}px ${Math.max(0, y + rect.height - own.y)}px -${big}px)`;
    };
    // Första läget sätts direkt, så att kopian aldrig syns oklippt över fönstret ens en bildruta.
    apply(0);
    const frame = (now: number) => {
      const p = clamp01((now - t0) / ms);
      apply(p);
      if (p < 1) requestAnimationFrame(frame);
      else g.remove();
    };
    requestAnimationFrame(frame);
  }

  #fadeGhost(): void {
    const made = this.#ghost();
    if (made) this.#fade(made.g);
  }

  #fade(g: HTMLElement): void {
    // Med reducerad rörelse tonar kopian bara ut, utan skala (§14).
    const still = reducedMotion();
    const kf = still
      ? [{ opacity: 1 }, { opacity: 0 }]
      : [{ opacity: 1, transform: g.style.transform }, { opacity: 0, transform: `${g.style.transform} scale(0.97)` }];
    g.animate(kf, { duration: still ? 160 : 180, easing: 'ease-in', fill: 'forwards' }).finished.then(() => g.remove(), () => g.remove());
  }

  /** Fönstrets hörnradie på skärmen: --wb-win-radius är i världsenheter och följer fönstrets skala på skärmen. */
  #winRadius(own: ScreenRect): number {
    const win = store.scene.windows.find((w) => w.appId === this.appId);
    const R = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--wb-win-radius')) || 16;
    return win ? (R * own.w) / Math.max(1, win.w * win.scale) : R;
  }

  #dot(appId: string): { x: number; y: number } | null {
    try {
      const d = this.#world.dotOf(appId);
      return d && Number.isFinite(d.x) && Number.isFinite(d.y) ? d : null;
    } catch {
      return null;
    }
  }
}
