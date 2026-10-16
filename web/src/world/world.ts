// world.ts — världen (CONTRACT §10): kamera, input, WebGL-ytan, fönstren, prismorna, ritandet och kromen.
// Pratar med HUD:en bara via bus.ts (hud:open/hud:close/view:changed/app:focus/window:created ut, hud:state och
// grants:changed in), med servern via store.ts och med apparna via bryggan (bridge.ts).
import type { AppInfo, Camera, CreateAppRequest, OpenItem, Rect, Scene, WindowState } from '../../../shared/protocol.ts';
import { bus } from '../bus.ts';
import { createParentBridge, sendFace, sendOpen } from '../bridge.ts';
import { pushEscape, runEscape } from '../escape.ts';
import { store } from '../store.ts';
import type { BridgeWindow, ScreenRect, World } from '../types.ts';
import type { Surface } from './bg.ts';
import { createSurface } from './bg.ts';
import { boundsOf, fitRect, lerpCamera, panBy, sanitizeCamera, screenToWorld, xform, zoomAround, ZOOM_MAX } from './camera.ts';
import type { ChromeHandlers, Edge } from './chrome.ts';
import { ChromeView, Markers } from './chrome.ts';
import type { KeyAction } from './gestures.ts';
import { classifyKey, normDelta, zoomFactor } from './gestures.ts';
import type { GateKind } from './gate.ts';
import { BridgeGate, inView } from './gate.ts';
import type { Pt } from './geom.ts';
import { InkStroke } from './ink.ts';
import { attachKeys, attachWheel } from './input.ts';
import { dotPointLocal, edgeMarker, OVERVIEW_DOT_W, requestFromDrawn, resizeFrom, scaleAround, scaleFrom, screenRectOfWin, topmostAt } from './layout.ts';
import { clamp, easeOutCubic, project, smoothstep } from './math.ts';
import { DOT_SLIDE_FROM, DOT_SLIDE_TO, cameraMatrix } from './prism.ts';
import { toolsInLastTurn } from './seed.ts';
import type { Box } from './shelf.ts';
import { FLIGHT_MS, flight, shelfSlots, tileSize } from './shelf.ts';
import { readTokens, reducedMotion } from './tokens.ts';
import type { ViewHost } from './windows.ts';
import { WindowView } from './windows.ts';
import { IDEAS_FACE } from './ideas.ts';

/** Det testerna kan läsa i dev (window.__wb.world.debug). Inte en del av World-gränssnittet. */
export interface WorldDebug {
  camera(): Camera;
  setCamera(c: Camera): void;
  views(): Array<{ id: string; appId: string; win: WindowState; is3d: boolean; front: number; n: number; theta: number; tools: number; dot: { x: number; y: number } | null; minimized: boolean; flying: boolean; tile: Box | null }>;
  focused(): string | null;
  /** Den aktiva HUD:ens app (null när ingen HUD är öppen). */
  hudApp(): string | null;
  /** Alla öppna HUD:ar i den ordning de öppnades, och den aktiva (enligt senaste hud:state). */
  huds(): { open: string[]; active: string | null };
  breathRate(appId: string): number | null;
  toScreen(appId: string, face: number, x: number, y: number): { x: number; y: number } | null;
}

interface FrameRec {
  iframe: HTMLIFrameElement;
  view: WindowView;
  faceId: string;
  hello: boolean;
  waiters: Array<() => void>;
  bw: BridgeWindow;
}

interface Creating {
  view: WindowView;
  chrome: ChromeView;
  stroke: InkStroke;
  camAt: Camera;
  t0: number;
  queue: WindowState[];
  buffer: string;
  appId: string | null;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function createWorld(stage: HTMLElement): World & { debug: WorldDebug } {
  const q = <T extends Element>(sel: string): T => {
    const e = stage.querySelector(sel) ?? document.querySelector(sel);
    if (!e) throw new Error(`index.html saknar ${sel}`);
    return e as T;
  };
  const bgCanvas = q<HTMLCanvasElement>('#bg');
  const worldEl = q<HTMLElement>('#world');
  const inkSvg = q<SVGSVGElement>('#ink');
  const chromeEl = q<HTMLElement>('#chrome');
  const hudLayer = document.getElementById('hud-layer');
  const tokens = readTokens();
  const port = location.port;
  const appOrigin = (id: string): string => `http://${id}.localhost:${port}`;

  let cam: Camera = { cx: 0, cy: 0, zoom: 1 };
  let vw = window.innerWidth;
  let vh = window.innerHeight;
  let haveSnapshot = false;
  const views = new Map<string, WindowView>(); // per fönster-id
  const chromes = new Map<WindowView, ChromeView>();
  const dissolving = new Map<string, Promise<void>>(); // per app-id
  const frames = new Map<MessageEventSource, FrameRec>();
  const recByIframe = new Map<HTMLIFrameElement, FrameRec>();
  const recByBw = new WeakMap<BridgeWindow, FrameRec>();
  const gate = new BridgeGate();
  let focused: string | null = null;
  /** Kopia av HUD:arnas läge (senaste hud:state): öppna appar och den aktiva. HUD:en ensam avgör det. */
  let huds = { open: new Set<string>(), active: null as string | null };
  let creating: Creating | null = null;
  let dragView: WindowView | null = null;

  /* ------------------------------ minimerade appar (§10.7) ------------------------------ */

  interface Mini {
    /** Läget som senast visades: minimerad eller på sin plats. */
    on: boolean;
    /** Pågående flykt: ned i raden (1) eller tillbaka (−1). from: rutan som syntes när flykten tillbaka började. */
    anim: { dir: 1 | -1; t0: number; from: Box | null } | null;
    /** Rutan som syns just nu på skärmen (följer raden mjukt när andra kommer och går, och flykten). */
    last: Box | null;
  }
  const minis = new Map<WindowView, Mini>();
  /** Stapelordningen för raden: över alla fönster (z är heltal från 1 och uppåt i scenen). */
  const MINI_Z = 1_000_000;
  let lastPose = 0;

  /* ------------------------------ ytan ------------------------------ */

  let surface: Surface | null = null;
  try {
    surface = createSurface(bgCanvas, tokens);
  } catch (err) {
    console.warn('[world] ytan kunde inte startas', err);
  }
  if (!surface) bgCanvas.classList.add('wb-off');

  /* ------------------------------ bildrutor ------------------------------ */

  let raf = 0;
  let camDirty = true;
  let geomDirty = true;
  let settleTimer: ReturnType<typeof setTimeout> | null = null;

  const schedule = (): void => {
    if (!raf) raf = requestAnimationFrame(frame);
  };
  const changed = (): void => {
    geomDirty = true;
    schedule();
  };

  function viewOf(appId: string): WindowView | undefined {
    for (const v of views.values()) if (v.appId === appId && !v.dissolving) return v;
    return undefined;
  }

  function liveViews(): WindowView[] {
    return [...views.values()].filter((v) => !v.dissolving);
  }

  function miniOf(v: WindowView): Mini {
    let m = minis.get(v);
    if (!m) {
      m = { on: !!v.win.minimized, anim: null, last: null };
      minis.set(v, m);
    }
    return m;
  }

  /** Fönstret står inte på sin plats i världen: minimerat, eller på väg ned i raden eller tillbaka. */
  function away(v: WindowView): boolean {
    return !!v.win.minimized || !!minis.get(v)?.anim;
  }

  /** Fönstren som står på sin plats i världen (de minimerade räknas inte: de syns bara i raden). */
  function placedViews(): WindowView[] {
    return liveViews().filter((v) => !away(v));
  }

  function applyCamera(): void {
    const { s, tx, ty } = xform(cam, vw, vh);
    worldEl.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
    worldEl.style.setProperty('--wb-inv', String(1 / s));
    surface?.render(cam, vw, vh);
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      settleTimer = null;
      if (haveSnapshot) store.setCamera({ ...cam });
    }, 160);
  }

  /**
   * Pricken sitter på 45°-punkten av den främre sidans övre högra hörnbåge, även under vridning (§10.5).
   * Under en vridning följer den kroppens övre högra hörn: av sidorna som vetter mot betraktaren den vars
   * hörnpunkt ligger längst till höger. När en sida närmar sig kanten (55–85° vriden) glider dess punkt
   * längs överkanten mot det vänstra hörnet, som den delar med grannsidan; där tar grannsidan över. Så
   * hoppar pricken aldrig, varken i sidled (som den skulle göra efter den främsta sidan, en halv fönsterbredd
   * mitt i vridningen) eller i höjdled (två hörn på olika djup som råkar stå i linje).
   */
  function dotScreen(v: WindowView): { x: number; y: number } {
    const { s, tx, ty } = xform(cam, vw, vh);
    const R = tokens.winRadius;
    if (!v.is3d) {
      const p = dotPointLocal(v.W, R);
      return { x: (v.win.x + p.x) * s + tx, y: (v.win.y + p.y) * s + ty };
    }
    const cm = cameraMatrix(s, tx, ty);
    const p = dotPointLocal(v.win.w, R / v.win.scale);
    const { w, h } = v.win;
    let best: { x: number; y: number } | null = null;
    for (let f = 0; f < v.n; f++) {
      const m = v.faceMatrix(cm, f);
      const a = project(m, 0, 0);
      const b = project(m, w, 0);
      const c = project(m, 0, h);
      if ((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x) <= 0) continue; // vänd bort
      const k = smoothstep(DOT_SLIDE_FROM, DOT_SLIDE_TO, Math.abs(v.yawOf(f)));
      // Från övre högra hörnbågens 45°-punkt (k = 0) längs överkanten till den övre vänstra (k = 1).
      const q = project(m, p.x + (w - 2 * p.x) * k, p.y);
      if (!best || q.x > best.x) best = q;
    }
    return best ?? v.toScreen(cm, v.front, p.x, p.y);
  }

  /** Nederkanten av prismans silhuett på skärmen (sidorna som vetter mot betraktaren). */
  function silhouetteBottom(v: WindowView): number {
    const { s, tx, ty } = xform(cam, vw, vh);
    const cm = cameraMatrix(s, tx, ty);
    const { w, h } = v.win;
    let y = -Infinity;
    for (let f = 0; f < v.n; f++) {
      const m = v.faceMatrix(cm, f);
      const a = project(m, 0, 0);
      const b = project(m, w, 0);
      const c = project(m, 0, h);
      if ((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x) <= 0) continue;
      y = Math.max(y, c.y, project(m, w, h).y);
    }
    return y;
  }

  function covered(v: WindowView, x: number, y: number): boolean {
    for (const u of views.values()) {
      if (u === v || u.dissolving || u.win.z <= v.win.z || away(u)) continue;
      const r = screenRectOfWin(u.win, cam, vw, vh);
      if (x > r.x + 2 && x < r.x + r.w - 2 && y > r.y + 2 && y < r.y + r.h - 2) return true;
    }
    return false;
  }

  const markers = new Markers(chromeEl, (appId) => flyToApp(appId, true));

  function layoutChrome(): void {
    const all = [...views.values()];
    if (creating && views.get(creating.view.id) !== creating.view) all.push(creating.view); // ännu inte bunden
    const marks = new Map<string, { x: number; y: number } | null>();
    for (const v of all) {
      const c = chromes.get(v);
      if (!c || v.dissolving) continue;
      if (away(v)) {
        // I raden: bara pricken, liten och utan halo, i miniatyrens övre högra hörn. Under flykten ingenting.
        const m = minis.get(v);
        const box = m?.last;
        if (!box) continue;
        c.layout({ rect: box, dot: tileDot(v, box), small: true, dotHidden: !!m?.anim, gripHidden: true, prism: false, interactive: false });
        continue;
      }
      const rect = screenRectOfWin(v.win, cam, vw, vh);
      const dot = dotScreen(v);
      const bottom = v.is3d ? silhouetteBottom(v) : undefined;
      c.layout({
        rect,
        dot,
        small: rect.w < OVERVIEW_DOT_W,
        dotHidden: covered(v, dot.x, dot.y),
        gripHidden: covered(v, rect.x + rect.w / 2, Math.max(rect.y + rect.h, bottom ?? -Infinity) + 12),
        prism: v.appFaces > 1,
        bottom,
        interactive: v.appId !== '',
      });
      c.setFaces(v.n, v.front, chromeHandlers(v), v.faces.map((f) => f.def.label ?? ''));
      if (v.appId) marks.set(v.appId, edgeMarker(rect, vw, vh));
    }
    markers.update(marks);
  }

  function frame(now: number): void {
    raf = 0;
    let active = false;
    if (fly) {
      const p = clamp((now - fly.t0) / fly.ms, 0, 1);
      cam = lerpCamera(fly.from, fly.to, easeOutCubic(p));
      camDirty = true;
      if (p >= 1) {
        cam = { ...fly.to };
        fly = null;
      } else active = true;
    }
    for (const v of views.values()) if (!v.dissolving && v.tick(now)) active = true;
    if (camDirty) applyCamera();
    // I samma bildruta som kameran, så att raden står still på skärmen medan världen rör sig.
    if (poseMinis(now)) active = true;
    if (camDirty || geomDirty || active) {
      layoutChrome();
      if (creating) {
        const a = xform(creating.camAt, vw, vh);
        const b = xform(cam, vw, vh);
        const k = b.s / a.s;
        creating.stroke.follow(k, b.tx - a.tx * k, b.ty - a.ty * k);
      }
      bus.emit('view:changed', {});
    }
    camDirty = false;
    geomDirty = false;
    if (active) schedule();
  }

  /* ------------------------------ kameran ------------------------------ */

  let fly: { from: Camera; to: Camera; t0: number; ms: number } | null = null;
  const backStack: Array<{ cam: Camera; unEsc: () => void }> = [];
  let flownTo: string | null = null;

  function setCamera(c: Camera): void {
    fly = null;
    flownTo = null;
    cam = c;
    camDirty = true;
    schedule();
  }

  function zoomAt(factor: number, sx: number, sy: number): void {
    setCamera(zoomAround(cam, vw, vh, sx, sy, factor));
  }

  function pan(dx: number, dy: number): void {
    if (dx === 0 && dy === 0) return;
    setCamera(panBy(cam, dx, dy));
  }

  function startFly(to: Camera, ms = 380): void {
    if (reducedMotion()) {
      // Minskad rörelse: kameran hoppar dit (tillbaka-stacken fungerar likadant).
      fly = null;
      cam = { ...to };
      camDirty = true;
      schedule();
      return;
    }
    fly = { from: { ...cam }, to, t0: performance.now(), ms };
    schedule();
  }

  function pushBack(): void {
    const entry = { cam: { ...cam }, unEsc: () => {} };
    entry.unEsc = pushEscape(() => {
      const i = backStack.indexOf(entry);
      if (i >= 0) backStack.splice(i, 1);
      flownTo = null;
      startFly(entry.cam);
    });
    backStack.push(entry);
  }

  function flyBack(): boolean {
    const entry = backStack.pop();
    if (!entry) return false;
    entry.unEsc();
    flownTo = null;
    startFly(entry.cam);
    return true;
  }

  function winRect(v: WindowView): Rect {
    return { x: v.win.x, y: v.win.y, w: v.W, h: v.H };
  }

  /** Flyg så att fönstret fyller vyn med marginal; samma igen flyger tillbaka. */
  function flyToApp(appId: string, alwaysThere = false): void {
    if (!alwaysThere && flownTo === appId && backStack.length) {
      flyBack();
      return;
    }
    const v = viewOf(appId);
    if (!v) return;
    if (v.win.minimized) {
      restore(appId);
      return;
    }
    pushBack();
    const reserve = huds.open.has(appId) ? 360 + 28 : 0;
    startFly(fitRect(winRect(v), vw, vh, 48, ZOOM_MAX, reserve));
    flownTo = appId;
  }

  function fitAll(): void {
    const b = boundsOf(placedViews().map(winRect));
    if (!b) return; // utan fönster står kameran still
    pushBack();
    startFly(fitRect(b, vw, vh, 72, 1));
    flownTo = null;
  }

  function viewAt(sx: number, sy: number): WindowView | null {
    const items = placedViews().map((v) => ({ v, z: v.win.z, rect: screenRectOfWin(v.win, cam, vw, vh) }));
    return topmostAt(items, sx, sy)?.v ?? null;
  }

  function smartZoom(sx: number, sy: number): void {
    const v = viewAt(sx, sy);
    if (v && flownTo !== v.appId) flyToApp(v.appId, true);
    else flyBack();
  }

  /* ------------------------------ fönster ------------------------------ */

  function maxZ(): number {
    let m = 0;
    for (const v of views.values()) if (!v.dissolving) m = Math.max(m, v.win.z);
    return m;
  }

  function persist(v: WindowView): void {
    if (v.appId && views.get(v.id) === v) store.updateWindow({ ...v.win });
  }

  function focus(appId: string): void {
    const v = viewOf(appId);
    if (!v) return;
    const top = maxZ();
    const tied = liveViews().filter((u) => u.win.z === top).length > 1;
    if (v.win.z < top || (v.win.z === top && tied)) {
      v.win = { ...v.win, z: top + 1 };
      v.applyGeometry();
      persist(v);
      changed();
    }
    focused = appId;
    bus.emit('app:focus', { appId });
  }

  const host: ViewHost = {
    port,
    tokens,
    registerFrame(iframe, view, faceId) {
      const src = iframe.contentWindow;
      if (!src) return;
      const rec: FrameRec = {
        iframe,
        view,
        faceId,
        hello: false,
        waiters: [],
        bw: {
          get appId() {
            return view.appId;
          },
          face: faceId,
          toScreen: (x, y) => frameToScreen(view, faceId, x, y),
        },
      };
      frames.set(src, rec);
      recByIframe.set(iframe, rec);
      recByBw.set(rec.bw, rec);
    },
    unregisterFrame(iframe) {
      const rec = recByIframe.get(iframe);
      if (!rec) return;
      recByIframe.delete(iframe);
      for (const [k, r] of frames) if (r === rec) frames.delete(k);
      for (const w of rec.waiters) w();
    },
    helloOf(iframe) {
      const rec = recByIframe.get(iframe);
      if (!rec) return Promise.resolve();
      if (rec.hello) return Promise.resolve();
      return new Promise((resolve) => rec.waiters.push(resolve));
    },
    frontChanged(view) {
      // Sidan Förslag sparas aldrig som fönstrets sida, och apparna får inte höra om den (§10.8).
      if (view.ideasInFront) {
        changed();
        return;
      }
      if (view.win.face !== view.front) {
        view.win = { ...view.win, face: view.front };
        persist(view);
      }
      const id = view.faces[view.front]?.def.id;
      if (id && view.appId) for (const fr of view.iframes()) sendFace(fr.contentWindow, appOrigin(view.appId), id);
      changed();
    },
    changed,
    pickIdea(view, text) {
      if (!view.appId) return;
      // Appen vrids fram, så att bygget syns, och förslaget går till dess HUD som ett meddelande från användaren.
      view.rotateTo(0, 0);
      bus.emit('hud:send', { appId: view.appId, text });
    },
  };

  function frameToScreen(view: WindowView, faceId: string, x: number, y: number): { x: number; y: number } {
    const { s, tx, ty } = xform(cam, vw, vh);
    const i = view.faces.findIndex((f) => f.def.id === faceId);
    if (!view.is3d || i < 0) return { x: (view.win.x + x * view.win.scale) * s + tx, y: (view.win.y + y * view.win.scale) * s + ty };
    return view.toScreen(cameraMatrix(s, tx, ty), i, x, y);
  }

  function chromeHandlers(v: WindowView): ChromeHandlers {
    let h = handlerCache.get(v);
    if (h) return h;
    h = {
      dot: () => {
        if (!v.appId) return;
        if (huds.open.has(v.appId)) bus.emit('hud:close', { appId: v.appId });
        else bus.emit('hud:open', { appId: v.appId, reason: 'dot' });
      },
      gripDown: (e) => moveDrag(v, e),
      gripDouble: () => {
        if (v.appId) flyToApp(v.appId);
      },
      zoneDown: (e, edge) => resizeDrag(v, e, edge),
      faceDot: (i) => {
        if (v.appId) focus(v.appId);
        v.rotateTo(i, 0);
      },
      peek: (dir) => {
        if (dragView === v) return;
        v.setPeek(dir);
      },
      peekClick: (dir) => {
        if (v.appId) focus(v.appId);
        v.rotateBy(dir);
      },
      focus: () => {
        if (v.appId) focus(v.appId);
      },
      minimize: () => {
        if (v.appId) minimize(v.appId);
      },
      remove: () => {
        if (!v.appId) return;
        // Som Ta bort i HUD:ens ⋯-meny (§7.4): löses upp, servern tar bort appen och HUD:en stängs vid app.removed.
        const id = v.appId;
        void dissolveApp(id);
        store.deleteApp(id).catch((err) => console.warn('[world] appen kunde inte tas bort', err));
      },
    };
    handlerCache.set(v, h);
    return h;
  }
  const handlerCache = new WeakMap<WindowView, ChromeHandlers>();

  function addChrome(v: WindowView): ChromeView {
    const c = new ChromeView(chromeEl, tokens, chromeHandlers(v));
    chromes.set(v, c);
    return c;
  }

  function applyApp(v: WindowView, app: AppInfo): void {
    v.setApp(app);
    chromes.get(v)?.setStatus(app.status, app.backend);
    if (v.seed) v.setTools(toolsInLastTurn(store.chats.get(app.id) ?? []));
    changed();
  }

  function upsertWindow(win: WindowState): void {
    const v = views.get(win.id);
    if (v) {
      if (v.dissolving) return;
      if (dragView !== v) v.setWin(win);
      changed();
      return;
    }
    if (creating && !creating.appId) {
      creating.queue.push(win); // kanske vårt eget fönster: avgörs när createApp svarat
      return;
    }
    if (dissolving.has(win.appId)) return;
    const nv = new WindowView(host, worldEl, win);
    views.set(win.id, nv);
    miniOf(nv); // ett fönster som redan är minimerat (omladdning, annan flik) står i raden direkt, utan flykt
    addChrome(nv);
    const app = store.apps.get(win.appId);
    if (app) applyApp(nv, app);
    changed();
  }

  function dissolveApp(appId: string): Promise<void> {
    const existing = dissolving.get(appId);
    if (existing) return existing;
    const v = viewOf(appId);
    if (!v) return Promise.resolve();
    if (focused === appId) focused = null;
    if (flownTo === appId) flownTo = null;
    gate.forget(appId);
    chromes.get(v)?.dissolve();
    const p = v.dissolve().then(() => {
      views.delete(v.id);
      chromes.delete(v);
      minis.delete(v);
      dissolving.delete(appId);
      changed();
    });
    dissolving.set(appId, p);
    changed();
    return p;
  }

  function reconcile(scene: Scene): void {
    if (!haveSnapshot) {
      haveSnapshot = true;
      cam = sanitizeCamera(scene.camera);
      camDirty = true;
    }
    const ids = new Set(scene.windows.map((w) => w.id));
    for (const v of [...views.values()]) if (!ids.has(v.id) && !v.dissolving) void dissolveApp(v.appId);
    for (const w of scene.windows) upsertWindow(w);
    for (const v of views.values()) {
      const app = store.apps.get(v.appId);
      if (app) applyApp(v, app);
    }
    changed();
  }

  /* ------------------------------ minimera och ta fram (§10.7) ------------------------------ */

  /** Minimera: fönstret vrids ett varv och glider ned i raden i nedre vänstra hörnet. Appens HUD stängs. */
  function minimize(appId: string): void {
    const v = viewOf(appId);
    if (!v || !v.appId || v.win.minimized) return;
    if (huds.open.has(appId)) bus.emit('hud:close', { appId });
    if (focused === appId) focused = null;
    if (flownTo === appId) flownTo = null;
    v.win = { ...v.win, minimized: Date.now() };
    persist(v);
    changed();
  }

  /** Ta fram: tillbaka till sin plats, överst och i fokus. Ligger platsen utanför vyn flyger kameran dit samtidigt. */
  function restore(appId: string): void {
    const v = viewOf(appId);
    if (!v || !v.win.minimized) return;
    const { minimized: _gone, ...rest } = v.win;
    v.win = { ...rest, z: maxZ() + 1 };
    v.applyGeometry();
    persist(v);
    const r = screenRectOfWin(v.win, cam, vw, vh);
    const ix = Math.max(0, Math.min(r.x + r.w, vw) - Math.max(r.x, 0));
    const iy = Math.max(0, Math.min(r.y + r.h, vh) - Math.max(r.y, 0));
    if (ix * iy < 0.5 * r.w * r.h) {
      pushBack();
      const reserve = huds.open.has(appId) ? 360 + 28 : 0;
      startFly(fitRect(winRect(v), vw, vh, 48, ZOOM_MAX, reserve));
      flownTo = appId;
    }
    changed();
  }

  /* ------------------------------ fältet (§10.9) ------------------------------ */

  /** Flyg till appen och visa dess första sida; en minimerad app tas fram först. Appen blir den i fokus. */
  function showApp(appId: string): void {
    const v = viewOf(appId);
    if (!v) return;
    if (v.win.minimized) restore(appId);
    if (v.front !== 0) v.rotateTo(0, 0);
    flyToApp(appId, true);
    focus(appId);
  }

  /**
   * Lämna något från fältet till appens första sida, när den sagt hej (efter en ny version: den nya sidan, som
   * fortfarande laddas). Bara om appen anger slaget i opens.
   */
  function deliver(appId: string, item: OpenItem): boolean {
    const v = viewOf(appId);
    const app = store.apps.get(appId);
    if (!v || !app?.built || !app.opens?.includes(item.kind)) return false;
    // Ett varv i händelseslingan: en ny version (rev) som kom i samma händelse har då fått sin nya iframe.
    setTimeout(() => {
      const f = v.faces[0];
      const fr = f?.incoming ?? f?.iframe;
      if (!fr || v.dissolving) return;
      void host.helloOf(fr).then(() => sendOpen(fr.contentWindow, appOrigin(appId), item));
    }, 0);
    return true;
  }

  /** En ny app mitt i vyn åt fältet (§10.9): som en ritad fyrkant, utan strecket. */
  async function createFromField(): Promise<string | null> {
    const w = Math.max(320, Math.min(720, vw - 200));
    const h = Math.max(220, Math.min(460, vh - 260));
    const req = requestFromDrawn({ x: (vw - w) / 2, y: (vh - h) / 2 + 30, w, h }, cam, vw, vh);
    if (!req || creating) return null;
    let res: Awaited<ReturnType<typeof store.createApp>>;
    try {
      res = await store.createApp(req);
    } catch (err) {
      console.warn('[world] appen kunde inte skapas', err);
      return null;
    }
    upsertWindow(res.win);
    const v = views.get(res.win.id);
    if (v) {
      v.layDown(0);
      chromes.get(v)?.ignite(80);
    }
    focus(res.app.id);
    changed();
    await sleep(220);
    bus.emit('window:created', { appId: res.app.id });
    bus.emit('hud:open', { appId: res.app.id, reason: 'created' });
    return res.app.id;
  }

  /** Pricken på en miniatyr: 45°-punkten av dess övre högra hörnbåge, som på fönstret. */
  function tileDot(v: WindowView, box: Box): { x: number; y: number } {
    const p = dotPointLocal(box.w, (tokens.winRadius * box.w) / Math.max(1e-6, v.W));
    return { x: box.x + p.x, y: box.y + p.y };
  }

  /** Transformen (kring fönstrets mitt) som visar fönstret med mitten i (cx, cy), bredden w och vridningen (grader). */
  function miniTransform(v: WindowView, cx: number, cy: number, w: number, yaw = 0, pitch = 0, roll = 0): string {
    const { s, tx, ty } = xform(cam, vw, vh);
    const nw = v.W * s;
    const k = w / Math.max(1e-6, nw);
    const dx = (cx - (v.win.x * s + tx + nw / 2)) / s;
    const dy = (cy - (v.win.y * s + ty + (v.H * s) / 2)) / s;
    // Perspektivet i fönstrets egna enheter efter skalningen: djupet ser likadant ut vid alla zoomnivåer.
    const turning = Math.abs(yaw) > 0.01 || Math.abs(pitch) > 0.01 || Math.abs(roll) > 0.01;
    const rot = turning ? ` perspective(${(v.W * k * 2.6).toFixed(2)}px) rotateX(${pitch.toFixed(3)}deg) rotateY(${yaw.toFixed(3)}deg) rotateZ(${roll.toFixed(3)}deg)` : '';
    return `translate(${dx.toFixed(3)}px, ${dy.toFixed(3)}px)${rot} scale(${k.toFixed(6)})`;
  }

  /**
   * Ställ alla minimerade fönster i raden och stega flykterna ned och tillbaka. Ett byte av win.minimized (härifrån,
   * från en annan flik eller från servern) startar flykten; ett fönster som redan är minimerat när det dyker upp står
   * i raden direkt. Ger true medan något rör sig.
   */
  function poseMinis(now: number): boolean {
    let active = false;
    const dt = lastPose ? Math.min(64, now - lastPose) : 16;
    lastPose = now;
    const shelf = liveViews()
      .filter((v) => v.win.minimized)
      .sort((a, b) => (a.win.minimized ?? 0) - (b.win.minimized ?? 0) || (a.id < b.id ? -1 : 1));
    const slots = shelfSlots(shelf.map((v) => tileSize(v.W, v.H)), vw, vh);
    const slotOf = new Map(shelf.map((v, i) => [v, { box: slots[i], i }]));
    const { s, tx, ty } = xform(cam, vw, vh);
    for (const v of liveViews()) {
      const m = miniOf(v);
      const want = !!v.win.minimized;
      if (want !== m.on) {
        m.on = want;
        // Flykten börjar där fönstret syns just nu: på sin plats (from null: följer kameran), i raden eller mitt i en
        // flykt åt andra hållet.
        if (reducedMotion()) m.anim = null;
        else m.anim = { dir: want ? 1 : -1, t0: now, from: m.last };
        if (want) {
          v.setPeek(0);
          for (const fr of v.iframes()) if (document.activeElement === fr) fr.blur();
        }
      }
      const here: Box = { x: v.win.x * s + tx, y: v.win.y * s + ty, w: v.W * s, h: v.H * s };
      const slot = slotOf.get(v);
      if (m.anim) {
        const p = clamp((now - m.anim.t0) / FLIGHT_MS, 0, 1);
        const down = m.anim.dir === 1;
        const a = m.anim.from ?? here;
        const b = down ? (slot?.box ?? here) : here;
        const f = flight(a, b, p, down ? 1 : -1);
        // Oskärpan anges i skärm-px och räknas om till fönstrets egna enheter (filtret skalas med transformen).
        v.setMiniPose(miniTransform(v, f.cx, f.cy, f.w, f.yaw, f.pitch, f.roll), MINI_Z + 10_000, (f.blur * v.W) / Math.max(1e-6, f.w));
        const h = f.w * (v.H / Math.max(1e-6, v.W));
        m.last = { x: f.cx - f.w / 2, y: f.cy - h / 2, w: f.w, h };
        // Också den sista bildrutan räknas som rörelse: då läggs kromen ut igen (pricken visas i raden).
        active = true;
        if (p >= 1) {
          m.anim = null;
          if (!down) {
            m.last = null;
            v.setMiniPose(null);
            if (v.appId) focus(v.appId);
          }
        }
      } else if (want && slot) {
        // I raden: följ platsen mjukt när en annan ruta kommer eller går, och när vyn byter storlek.
        const t = slot.box;
        let cur = m.last ?? t;
        const k = 1 - Math.exp(-dt / 70);
        cur = { x: cur.x + (t.x - cur.x) * k, y: cur.y + (t.y - cur.y) * k, w: cur.w + (t.w - cur.w) * k, h: cur.h + (t.h - cur.h) * k };
        if (Math.abs(cur.x - t.x) < 0.3 && Math.abs(cur.y - t.y) < 0.3 && Math.abs(cur.w - t.w) < 0.3) cur = { ...t };
        else active = true;
        m.last = cur;
        v.setMiniPose(miniTransform(v, cur.x + cur.w / 2, cur.y + cur.h / 2, cur.w), MINI_Z + slot.i);
      } else if (!want) {
        m.last = null;
        v.setMiniPose(null);
      }
    }
    return active;
  }

  /* ------------------------------ drag: flytta, ändra storlek, skala ------------------------------ */

  interface DragHandlers {
    start?(): void;
    move(dx: number, dy: number, ev: PointerEvent): void;
    end(moved: boolean, cancelled: boolean): void;
  }

  /** Drag som skalet äger: pointer capture, skölden över iframes, 4 px tröskel och Esc avbryter. */
  function startDrag(e: PointerEvent, target: Element, h: DragHandlers): void {
    try {
      target.setPointerCapture(e.pointerId);
    } catch {
      /* pekaren finns inte längre */
    }
    const root = document.documentElement;
    root.classList.add('wb-dragging');
    const x0 = e.clientX;
    const y0 = e.clientY;
    let moved = false;
    let done = false;
    const unEsc = pushEscape(() => finish(true));
    const move = (ev: Event): void => {
      const pe = ev as PointerEvent;
      if (pe.pointerId !== e.pointerId) return;
      if (!moved && Math.hypot(pe.clientX - x0, pe.clientY - y0) < 4) return;
      if (!moved) {
        moved = true;
        h.start?.();
      }
      h.move(pe.clientX - x0, pe.clientY - y0, pe);
    };
    const up = (ev: Event): void => {
      const pe = ev as PointerEvent;
      if (pe.pointerId !== e.pointerId) return;
      finish(ev.type === 'pointercancel');
    };
    function finish(cancelled: boolean): void {
      if (done) return;
      done = true;
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', up);
      try {
        target.releasePointerCapture(e.pointerId);
      } catch {
        /* redan släppt */
      }
      root.classList.remove('wb-dragging');
      unEsc();
      h.end(moved, cancelled);
    }
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
  }

  function moveDrag(v: WindowView, e: PointerEvent): void {
    if (!v.appId || v.dissolving) return;
    const start = { ...v.win };
    const c = chromes.get(v);
    startDrag(e, e.currentTarget as Element, {
      start: () => {
        dragView = v;
        v.setLifted(true);
        c?.setActive(true);
      },
      move: (dx, dy) => {
        v.win = { ...v.win, x: start.x + dx / cam.zoom, y: start.y + dy / cam.zoom };
        v.applyGeometry();
        changed();
      },
      end: (moved, cancelled) => {
        dragView = null;
        v.setLifted(false);
        c?.setActive(false);
        if (!moved) return;
        if (cancelled) {
          v.win = { ...v.win, x: start.x, y: start.y };
          v.applyGeometry();
        }
        persist(v);
        changed();
      },
    });
  }

  function resizeDrag(v: WindowView, e: PointerEvent, edge: Edge): void {
    if (!v.appId || v.dissolving) return;
    const start = { ...v.win };
    const corner = edge.length === 2;
    startDrag(e, e.currentTarget as Element, {
      start: () => {
        dragView = v;
        v.setPeek(0);
      },
      move: (dx, dy, ev) => {
        const wx = dx / cam.zoom;
        const wy = dy / cam.zoom;
        if (corner && ev.shiftKey) {
          // ⇧+hörn: skala (ingen omflödning)
          const r = scaleFrom(start, edge, wx, wy);
          v.win = { ...v.win, x: r.x, y: r.y, w: start.w, h: start.h, scale: r.scale };
        } else {
          const r = resizeFrom(start, edge, wx, wy);
          v.win = { ...v.win, ...r, scale: start.scale };
        }
        v.applyGeometry();
        changed();
      },
      end: (moved, cancelled) => {
        dragView = null;
        if (!moved) return;
        if (cancelled) {
          v.win = { ...start, z: v.win.z, face: v.win.face };
          v.applyGeometry();
        }
        persist(v);
        changed();
      },
    });
  }

  function scaleWindowAt(v: WindowView, factor: number, sx: number, sy: number): void {
    if (!v.appId || v.dissolving) return;
    const p = screenToWorld(cam, vw, vh, sx, sy);
    const r = scaleAround(v.win, p.x, p.y, factor);
    v.win = { ...v.win, ...r };
    v.applyGeometry();
    persist(v);
    changed();
  }

  /* ------------------------------ rita en ny app (§10.4) ------------------------------ */

  const isEmpty = (t: EventTarget | null): boolean => t === stage || t === bgCanvas || t === worldEl;

  stage.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
    if (!isEmpty(e.target)) return;
    fly = null;
    const p0: Pt = { x: e.clientX, y: e.clientY };
    let stroke: InkStroke | null = null;
    startDrag(e, stage, {
      start: () => {
        stroke = new InkStroke(inkSvg, p0, tokens.winRadius * cam.zoom, { w: vw, h: vh });
      },
      move: (_dx, _dy, ev) => {
        const list = typeof ev.getCoalescedEvents === 'function' ? ev.getCoalescedEvents() : [];
        const pts = list.length ? list.map((c) => ({ x: c.clientX, y: c.clientY })) : [{ x: ev.clientX, y: ev.clientY }];
        stroke?.add(pts);
      },
      end: (moved, cancelled) => {
        const s = stroke as InkStroke | null;
        // Ett tryck (släpp utan att pekaren rört sig 4 px) stänger den aktiva HUD:en. Ett drag ritar och stänger ingen.
        if (!moved) {
          if (!cancelled && huds.active) bus.emit('hud:close', { appId: huds.active });
          return;
        }
        if (!s) return;
        if (cancelled || !s.valid) s.cancel();
        else materialize(s);
      },
    });
  });

  function materialize(stroke: InkStroke): void {
    const r = stroke.rect;
    const req: CreateAppRequest | null = requestFromDrawn(r, cam, vw, vh);
    if (!req) {
      stroke.cancel();
      return;
    }
    if (creating) {
      // Bara en åt gången: den förra hinner nästan alltid bli klar på de 40–60 ms servern behöver.
      stroke.cancel();
      return;
    }
    const t0 = performance.now();
    const win: WindowState = { id: `w-pending-${Math.round(t0)}`, appId: '', x: req.x, y: req.y, w: req.w, h: req.h, scale: req.scale, face: 0, z: maxZ() + 1 };
    const view = new WindowView(host, worldEl, win);
    const chrome = addChrome(view);
    view.layDown(120); // 120 ms: arket läggs ned
    chrome.ignite(200); // 200 ms: pricken tänds och greppet växer fram
    // 0 ms: strecket snäpper till den exakta rundade rektangeln; det tonar bort från 120 ms på 300 ms.
    const target = screenRectOfWin(win, cam, vw, vh);
    if (reducedMotion()) stroke.fade(0, 160); // ingen morf, strecket tonar bara bort
    else {
      void stroke.snap({ ...target, r: Math.min(tokens.winRadius * cam.zoom, target.w / 2, target.h / 2) }, 270);
      stroke.fade(120, 300);
    }
    const c: Creating = { view, chrome, stroke, camAt: { ...cam }, t0, queue: [], buffer: '', appId: null };
    creating = c;
    changed();

    store.createApp(req).then(
      async (res) => {
        c.appId = res.app.id;
        view.bind(res.win);
        views.set(res.win.id, view);
        const queued = c.queue.splice(0);
        const app = store.apps.get(res.app.id) ?? res.app;
        applyApp(view, app);
        for (const w of queued) upsertWindow(w);
        focus(res.app.id);
        changed();
        await sleep(Math.max(0, 220 - (performance.now() - t0)));
        if (view.dissolving) {
          if (creating === c) creating = null;
          return;
        }
        // 220 ms: HUD:en glider ut. Först window:created, sedan hud:open.
        bus.emit('window:created', { appId: res.app.id });
        bus.emit('hud:open', { appId: res.app.id, reason: 'created' });
        await flushBuffer(c);
        if (creating === c) creating = null;
        changed();
      },
      (err: unknown) => {
        console.warn('[world] appen kunde inte skapas', err);
        if (creating === c) creating = null;
        stroke.cancel();
        chrome.dissolve();
        void view.dissolve();
        for (const w of c.queue.splice(0)) upsertWindow(w);
        changed();
      },
    );
  }

  /**
   * Tangenttryck mellan släppet och att HUD:ens inmatning fått fokus samlas här och skrivs in i den
   * inmatning som har fokus i #hud-layer, så att inget tappas (§14: inmatningen får fokus redan vid släppet).
   */
  function bufferKey(e: KeyboardEvent): void {
    if (!creating) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (t instanceof HTMLElement && (t.isContentEditable || t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement)) return;
    if (e.key.length === 1) {
      creating.buffer += e.key;
      e.preventDefault();
    } else if (e.key === 'Backspace' && creating.buffer) {
      creating.buffer = creating.buffer.slice(0, -1);
      e.preventDefault();
    }
  }

  async function flushBuffer(c: Creating): Promise<void> {
    const t0 = performance.now();
    while (performance.now() - t0 < 1200) {
      const a = document.activeElement;
      const editable = a instanceof HTMLTextAreaElement || a instanceof HTMLInputElement || (a instanceof HTMLElement && a.isContentEditable);
      if (editable && hudLayer?.contains(a)) {
        if (c.buffer) {
          const text = c.buffer;
          c.buffer = '';
          if (!document.execCommand('insertText', false, text) && (a instanceof HTMLTextAreaElement || a instanceof HTMLInputElement)) {
            a.setRangeText(text, a.selectionStart ?? a.value.length, a.selectionEnd ?? a.value.length, 'end');
            a.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
          }
        }
        return;
      }
      await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    }
    c.buffer = '';
  }

  /* ------------------------------ hjul, tangenter och bryggan ------------------------------ */

  // Pekare ned i ett fönster anropar World.focus (§10.5). En byggd app säger det själv via bryggan, men
  // fröytan och arket är skalets egna: utan det här fick en obyggd fyrkant aldrig fokus (FE-2).
  worldEl.addEventListener(
    'pointerdown',
    (e) => {
      const el = e.target instanceof Element ? e.target.closest('.wb-win') : null;
      const v = el ? liveViews().find((u) => u.el === el) : undefined;
      if (v?.appId && !away(v)) focus(v.appId);
    },
    true,
  );

  // Ett klick på en miniatyr i raden tar fram appen (§10.7).
  worldEl.addEventListener('click', (e) => {
    const el = e.target instanceof Element ? e.target.closest('.wb-win') : null;
    const v = el ? liveViews().find((u) => u.el === el) : undefined;
    if (v?.appId && v.win.minimized) restore(v.appId);
  });

  // Grinden (gate.ts) behöver veta var skalet senast såg pekaren. Bara betrodda händelser; hjulet räknas
  // också, eftersom en panorering över tom yta kan föra ett fönster in under en pekare som står still.
  const notePointer = (e: PointerEvent | WheelEvent): void => {
    if (!e.isTrusted) return;
    gate.pointer(
      e.clientX,
      e.clientY,
      placedViews().map((v) => ({ appId: v.appId, rect: screenRectOfWin(v.win, cam, vw, vh) })),
    );
  };
  window.addEventListener('pointermove', notePointer, { capture: true, passive: true });
  window.addEventListener('pointerdown', notePointer, { capture: true, passive: true });
  window.addEventListener('wheel', notePointer, { capture: true, passive: true });
  // Pekaren lämnar sidan vid vyns kant (ut ur webbläsarfönstret): kommer den tillbaka rakt ned i ett fönster
  // ser skalet den aldrig, så grinden glömmer platsen (som efter en omladdning).
  document.documentElement.addEventListener('pointerleave', (e) => {
    if (!e.isTrusted || e.relatedTarget) return;
    if (e.clientX > 0 && e.clientY > 0 && e.clientX < vw - 1 && e.clientY < vh - 1) return;
    gate.lost();
  });

  /** Får appen bakom w använda den här delen av bryggan just nu (SEC-1)? at: hjulets punkt på skärmen. */
  function admitted(w: BridgeWindow, kind: GateKind, at?: { x: number; y: number }): boolean {
    const rec = recByBw.get(w);
    if (!rec || rec.view.dissolving || away(rec.view)) return false;
    const active = document.hasFocus() && document.activeElement === rec.iframe;
    const rect = screenRectOfWin(rec.view.win, cam, vw, vh);
    // När skalet inte vet var pekaren är (omladdning medan den vilar över appen, eller sedan den lämnat
    // sidan): fönstret ska synas, och har hjulet en punkt ska den ligga i vyn med appens fönster överst.
    const plausible = (): boolean =>
      inView(rect, vw, vh) && (!at || (at.x >= 0 && at.y >= 0 && at.x < vw && at.y < vh && viewAt(at.x, at.y) === rec.view));
    return gate.allows(kind, w.appId, active, rect, plausible);
  }

  attachWheel(stage, hudLayer, {
    zoom: (f, sx, sy) => zoomAt(f, sx, sy),
    smart: (sx, sy) => smartZoom(sx, sy),
    pan: (dx, dy) => pan(dx, dy),
    scaleWindow: (f, sx, sy) => {
      const v = viewAt(sx, sy);
      if (v) scaleWindowAt(v, f, sx, sy);
    },
    rotate: (dx, sx, sy, momentum, t) => {
      const v = viewAt(sx, sy);
      if (v) v.swipe(dx, t, momentum);
    },
    pinchEnd: () => {},
  });

  function rotateFocused(steps: 1 | -1): boolean {
    const v = focused ? viewOf(focused) : undefined;
    if (!v || v.n <= 1) return false;
    v.rotateBy(steps);
    return true;
  }

  function handleKey(a: KeyAction): boolean {
    switch (a) {
      case 'toggle-hud': {
        if (!focused || !viewOf(focused)) return false;
        if (huds.open.has(focused)) bus.emit('hud:close', { appId: focused });
        else bus.emit('hud:open', { appId: focused, reason: 'key' });
        return true;
      }
      case 'fit':
        fitAll();
        return true;
      case 'next-face':
        return rotateFocused(1);
      case 'prev-face':
        return rotateFocused(-1);
      case 'escape':
        return runEscape();
    }
  }

  attachKeys(handleKey, bufferKey);

  createParentBridge({
    resolve: (src) => (src ? (frames.get(src)?.bw ?? null) : null),
    appOrigin,
    onHello: (w) => {
      const rec = recByBw.get(w);
      if (!rec) return;
      rec.hello = true;
      for (const fn of rec.waiters.splice(0)) fn();
      const id = rec.view.faces[rec.view.front]?.def.id;
      if (id) sendFace(rec.iframe.contentWindow, appOrigin(rec.view.appId), id);
    },
    onZoom: (w, dy, sx, sy, o) => {
      if (!admitted(w, 'wheel', { x: sx, y: sy })) return;
      const v = viewOf(w.appId);
      if (o.smart) return smartZoom(sx, sy);
      const f = zoomFactor(normDelta(dy, o.mode));
      if (o.alt) {
        if (v) scaleWindowAt(v, f, sx, sy);
        return;
      }
      zoomAt(f, sx, sy);
    },
    onPan: (w, dx, dy, mode) => {
      if (admitted(w, 'wheel')) pan(-normDelta(dx, mode), -normDelta(dy, mode));
    },
    onAltWheel: (w, dx, dy, momentum) => {
      if (!admitted(w, 'wheel')) return;
      const v = viewOf(w.appId);
      if (v && Math.abs(dx) >= Math.abs(dy) && dx !== 0) v.swipe(dx, performance.now(), momentum);
    },
    onKey: (w, k) => {
      if (!admitted(w, 'key')) return;
      const a = classifyKey({ code: k.code, key: k.code === 'Escape' ? 'Escape' : '', metaKey: k.meta, ctrlKey: k.ctrl, altKey: k.alt, shiftKey: k.shift, repeat: false });
      if (a) handleKey(a);
    },
    onFocus: (w) => {
      if (admitted(w, 'focus')) focus(w.appId);
    },
    onFaceRequest: (w, faceId) => {
      const v = viewOf(w.appId);
      // En app vrider aldrig fram sidan Förslag själv (den kostar en fråga till Claude, §8.12).
      if (!v || faceId === IDEAS_FACE) return;
      const i = v.faces.findIndex((f) => f.def.id === faceId);
      if (i >= 0) v.rotateTo(i, 0);
    },
  });

  /* ------------------------------ butiken och bussen ------------------------------ */

  store.on('snapshot', (scene) => reconcile(scene));
  store.on('app', (appId) => {
    const app = store.apps.get(appId);
    const v = viewOf(appId);
    if (app && v) applyApp(v, app);
  });
  store.on('app.removed', (appId) => void dissolveApp(appId));
  store.on('window', (win) => upsertWindow(win));
  store.on('window.removed', (id) => {
    const v = views.get(id);
    if (v) void dissolveApp(v.appId);
  });
  store.on('chat', (appId) => {
    const v = viewOf(appId);
    if (v?.seed) v.setTools(toolsInLastTurn(store.chats.get(appId) ?? []));
  });

  bus.on('hud:state', ({ open, active }) => {
    const prev = huds.open;
    huds = { open: new Set(open), active };
    // En HUD som stängs sjunker in i pricken (370 ms); pricken sväljer den mot slutet. Ett byte av aktiv gör det inte.
    for (const id of prev) {
      if (huds.open.has(id)) continue;
      const v = viewOf(id);
      const c = v ? chromes.get(v) : undefined;
      if (c) setTimeout(() => c.gulp(), 300);
    }
  });
  bus.on('grants:changed', ({ appId }) => viewOf(appId)?.reloadFrames());

  window.addEventListener('resize', () => {
    vw = window.innerWidth;
    vh = window.innerHeight;
    camDirty = true;
    schedule();
  });

  // Fönster som redan finns i butiken (om världen startas efter första snapshot).
  if (store.connected) reconcile(store.scene);
  schedule();

  /* ------------------------------ World ------------------------------ */

  const debug: WorldDebug = {
    camera: () => ({ ...cam }),
    setCamera: (c) => setCamera(sanitizeCamera(c)),
    views: () =>
      liveViews().map((v) => ({
        id: v.id,
        appId: v.appId,
        win: { ...v.win },
        is3d: v.is3d,
        front: v.front,
        n: v.n,
        theta: v.theta,
        tools: v.tools,
        dot: v.appId ? dotScreen(v) : null,
        minimized: !!v.win.minimized,
        flying: !!minis.get(v)?.anim,
        tile: minis.get(v)?.last ?? null,
      })),
    focused: () => focused,
    hudApp: () => huds.active,
    huds: () => ({ open: [...huds.open], active: huds.active }),
    breathRate: (appId) => {
      const v = viewOf(appId);
      const c = v ? chromes.get(v) : undefined;
      return c ? c.breathRate : null;
    },
    toScreen: (appId, face, x, y) => {
      const v = viewOf(appId);
      const id = v?.faces[face]?.def.id;
      return v && id ? frameToScreen(v, id, x, y) : null;
    },
  };

  return {
    screenRectOf(appId: string): ScreenRect | null {
      const v = viewOf(appId);
      if (!v) return null;
      const box = v.win.minimized ? minis.get(v)?.last : null;
      return box ? { ...box } : screenRectOfWin(v.win, cam, vw, vh);
    },
    dotOf(appId: string): { x: number; y: number } | null {
      const v = viewOf(appId);
      if (!v) return null;
      const box = v.win.minimized ? minis.get(v)?.last : null;
      return box ? tileDot(v, box) : dotScreen(v);
    },
    flyTo(appId: string): void {
      flyToApp(appId);
    },
    focus,
    dissolve: dissolveApp,
    minimize,
    restore,
    isMinimized: (appId: string) => !!viewOf(appId)?.win.minimized,
    show: showApp,
    deliver,
    createApp: createFromField,
    debug,
  };
}
