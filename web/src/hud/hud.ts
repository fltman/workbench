// hud.ts — HUD:arna (CONTRACT §12, §13, §14). Hanteraren: en panel (panel.ts) per öppen HUD, och det som delas
// mellan dem: vilken som är aktiv och Esc-ordningen (stack.ts), den enda Esc-hanteraren, rösten, utkasten,
// lagringen över en omladdning (persist.ts) och kopplingen till butiken och bussen: hud:open/hud:close/
// view:changed in, hud:state ut, automatiken som öppnar appens HUD när den väntar på svar, uppläsningen efter
// röstmeddelanden och "skriv var som helst".
import './hud.css';
import type { AppStatus, ChatEvent } from '../../../shared/protocol.ts';
import type { ScreenRect, World } from '../types.ts';
import { store } from '../store.ts';
import { bus } from '../bus.ts';
import { pushEscape } from '../escape.ts';
import { HudPanel, type CloseHow, type PanelHost, type Reason } from './panel.ts';
import * as M from './model.ts';
import * as S from './stack.ts';
import { el } from './asks.ts';
import { parseMarkdown, plainText } from './markdown.ts';
import { loadSaved, save } from './persist.ts';
import { createVoice } from './voice.ts';
import { speak } from './tts.ts';
import { createField } from './field.ts';

/** Utglidningen börjar 220 ms efter släppet (§14 Materialisering steg 4). */
const SLIDE_AFTER_RELEASE = 220;
/** En tur som slutade för länge sedan (t.ex. under ett avbrott) läses inte upp. */
const SPEAK_FRESH_MS = 20_000;
/** Så länge efter senaste view:changed räknas kameran som i rörelse (placement.follow prövar då inte äldre HUD:ar). */
const VIEW_SETTLE_MS = 150;

export function createHud(layer: HTMLElement, world: World): void {
  const root = el('div', 'wbh-root');
  const sr = el('div', 'wbh-sr');
  sr.setAttribute('aria-live', 'polite');
  root.append(sr);
  layer.append(root);

  const panels = new Map<string, HudPanel>();
  let stack: S.Stack = S.EMPTY;
  const drafts = new Map<string, string>();
  const via = new Map<string, 'text' | 'voice'>();
  const ghosts = new Map<string, () => void>();
  let saved = loadSaved();
  for (const [id, d] of Object.entries(saved?.drafts ?? {})) drafts.set(id, d);
  const prevStatus = new Map<string, AppStatus>();
  const highWater = new Map<string, number>();
  let lastRelease = Number.NEGATIVE_INFINITY;
  let lastView = Number.NEGATIVE_INFINITY;
  let settleTimer: ReturnType<typeof setTimeout> | null = null;
  let popEsc: (() => void) | null = null;
  /** Appen i fokus enligt världen (bus 'app:focus'). */
  let focusedApp: string | null = null;
  /** Appen vars HUD spelar in (en inspelning åt gången, §12). */
  let owner: string | null = null;

  const activeId = (): string | null => S.activeOf(stack);
  const activePanel = (): HudPanel | undefined => {
    const a = activeId();
    return a ? panels.get(a) : undefined;
  };

  const voice = createVoice({
    onState: (s) => (owner ? panels.get(owner)?.voiceState(s) : undefined),
    onLevel: (l) => (owner ? panels.get(owner)?.voiceLevel(l) : undefined),
    // Texten går till appen vars HUD spelade in, även om en annan HUD blivit aktiv under tiden.
    onText: (text) => (owner ? panels.get(owner)?.voiceText(text) : undefined),
    onFail: (k) => (owner ? panels.get(owner)?.voiceFail(k) : undefined),
    transcribe: (blob) => store.transcribe(blob),
  });

  /* ------------------------------ panelernas värd ------------------------------ */

  const host: PanelHost = {
    world,
    root,
    ghosts,
    draft: (id) => drafts.get(id) ?? '',
    setDraft: (id, text) => {
      const prev = drafts.get(id) ?? '';
      if (text) drafts.set(id, text);
      else drafts.delete(id);
      if (prev !== text) persist();
    },
    noteSent: (id, v) => {
      via.set(id, v);
      persist();
    },
    isActive: (id) => activeId() === id,
    activate: (id, from) => activate(id, from),
    remove: (id) => {
      close(id, 'deleted');
      void world.dissolve(id);
      store.deleteApp(id).catch((err) => console.warn('[hud] kunde inte ta bort appen', err));
    },
    obstacles,
    moved,
    cameraMoving: () => performance.now() - lastView < VIEW_SETTLE_MS,
    voiceStart: (id) => {
      // Bara en inspelning åt gången: medan en kontrolleras eller tolkas börjar ingen ny.
      if (voice.state !== 'idle' && owner !== id) return;
      if (!panels.has(id)) return;
      if (activeId() !== id) activate(id, 'pointer');
      owner = id;
      voice.start();
    },
    voiceStop: (id) => {
      if (owner === id) voice.stop();
    },
    announce: (id, text, kind) => {
      // Svar läses bara från den aktiva HUD:en; frågekort och fel från alla.
      if (!text || (kind === 'reply' && activeId() !== id)) return;
      sr.textContent = '';
      requestAnimationFrame(() => {
        sr.textContent = text;
      });
    },
  };

  function safeRect(appId: string): ScreenRect | null {
    try {
      const r = world.screenRectOf(appId);
      return r && Number.isFinite(r.x) && Number.isFinite(r.y) && r.w > 0 && r.h > 0 ? r : null;
    } catch {
      return null;
    }
  }

  /** Andra fönster, och målen för HUD:ar som öppnades före den här (§13 Placering). */
  function obstacles(appId: string): { windows: ScreenRect[]; huds: ScreenRect[] } {
    const windows: ScreenRect[] = [];
    for (const w of store.scene.windows) {
      if (w.appId === appId) continue;
      const r = safeRect(w.appId);
      if (r) windows.push(r);
    }
    const huds: ScreenRect[] = [];
    for (const id of stack.opened) {
      if (id === appId) break;
      const r = panels.get(id)?.rect();
      if (r) huds.push(r);
    }
    return { windows, huds };
  }

  /* ------------------------------ placeringen i öppningsordning ------------------------------ */

  let inPass = false;
  let passQueued = false;

  /** Alla paneler i den ordning de öppnades: senare HUD:ar ser de tidigares nya mål i samma pass. */
  function placeAll(): void {
    inPass = true;
    try {
      for (const id of stack.opened) panels.get(id)?.onView();
    } finally {
      inPass = false;
    }
  }

  /**
   * En panels mål ändrades. Under ett ordnat pass placeras de senare ändå efter den. Utanför ett pass (höjdfjädern,
   * ett sidbyte, golvet) samlas det till ett enda pass i nästa bildruta, så att kostnaden aldrig växer med antalet.
   */
  function moved(_appId: string, sideChanged: boolean): void {
    if (sideChanged) schedulePersist();
    if (inPass || passQueued || panels.size < 2) return;
    passQueued = true;
    requestAnimationFrame(() => {
      passQueued = false;
      placeAll();
    });
  }

  /* ------------------------------ aktiv, Esc och läget ------------------------------ */

  /** Klasserna och staplingen: den aktiva överst, de andra i den ordning de senast var aktiva. */
  function refreshActive(): void {
    const a = activeId();
    stack.recent.forEach((id, i) => {
      const p = panels.get(id);
      if (!p) return;
      p.el.style.zIndex = String(i + 1);
      p.setActive(id === a);
    });
  }

  function armEscape(): void {
    popEsc?.();
    popEsc = pushEscape(() => {
      popEsc = null;
      const a = activeId();
      if (a) close(a, 'esc');
      if (panels.size && !popEsc) armEscape();
    });
  }

  function disarmEscape(): void {
    popEsc?.();
    popEsc = null;
  }

  function emitState(): void {
    bus.emit('hud:state', { open: [...stack.opened], active: activeId() });
  }

  /** chat.open håller appens process varm; den aktiva sist, så att taket (§8.1) stänger den sist. */
  function sendOpen(appId: string): void {
    store.send({ t: 'chat.open', appId });
  }

  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  /** En HUD bytte sida: sparas strax (samlat), så att den står kvar på samma sida efter en omladdning. */
  function schedulePersist(): void {
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      persist();
    }, 250);
  }

  function persist(): void {
    save({
      open: stack.opened.flatMap((id) => {
        const p = panels.get(id);
        return p ? [{ app: id, reason: p.reason, sent: p.sentSinceOpen, side: p.side }] : [];
      }),
      active: activeId(),
      recent: stack.recent.filter((id) => panels.has(id)),
      drafts: Object.fromEntries(drafts),
    });
  }

  function open(appId: string, reason: Reason, o: { slideDelay?: number; activate: boolean; focus?: boolean }): void {
    const existing = panels.get(appId);
    if (existing) {
      if (!o.activate) return;
      activate(appId, 'open');
      existing.focusInput();
      existing.place();
      return;
    }
    ghosts.get(appId)?.();
    const p = new HudPanel(host, appId, reason, false);
    panels.set(appId, p);
    stack = S.open(stack, appId, o.activate);
    const became = activeId() === appId;
    refreshActive();
    p.show(o.slideDelay ?? 0, became && o.focus !== false);
    sendOpen(appId);
    if (became) armEscape();
    persist();
    emitState();
  }

  /**
   * Gör en öppen HUD aktiv. from: pekaren eller fokus i panelen, eller en öppning av en redan öppen HUD. Pekare och
   * fokus anropar world.focus när appen inte redan är den i fokus, även om HUD:en redan är aktiv, så att ⌘K och
   * ⌃⌥←/→ gäller den HUD man skriver i. Ett byte där fokus inte hamnar i HUD:en anropar aldrig world.focus.
   */
  function activate(appId: string, from: 'pointer' | 'focus' | 'open'): void {
    const p = panels.get(appId);
    if (!p) return;
    if (from !== 'open' && focusedApp !== appId) world.focus(appId);
    if (activeId() === appId) return;
    const prev = activePanel();
    stack = S.activate(stack, appId);
    refreshActive();
    armEscape();
    sendOpen(appId);
    persist();
    emitState();
    // Klick på knappar som inte tar fokus (mikrofonen, ⋯, stopp): låg fokus kvar i den förra HUD:en flyttas det hit,
    // så att tangentbordsfokus aldrig ligger i en HUD som inte är aktiv.
    if (from === 'pointer' && prev) {
      setTimeout(() => {
        const a = document.activeElement;
        if (!p.disposed && activeId() === appId && a instanceof Node && prev.el.contains(a)) p.focusInput();
      }, 0);
    }
  }

  function close(appId: string, how: CloseHow): void {
    const p = panels.get(appId);
    if (!p) return;
    const wasActive = activeId() === appId;
    const hadFocus = p.el.contains(document.activeElement);
    if (owner === appId) {
      voice.cancel();
      owner = null;
    }
    const { del } = p.close(how);
    panels.delete(appId);
    stack = S.close(stack, appId);
    if (!panels.size) {
      voice.release();
      disarmEscape();
    }
    refreshActive();
    const next = activePanel();
    if (wasActive && next) {
      // Låg fokus i den stängda HUD:en, på skalet eller på en knapp i kromen (pricken) får den nya aktiva HUD:ens
      // inmatning fokus, aldrig ett frågekort.
      const a = document.activeElement;
      const free = hadFocus || a === null || a === document.body || (a instanceof HTMLElement && !!a.closest('#chrome'));
      if (free) next.focusInput();
    }
    persist();
    emitState();
    if (del) {
      void world.dissolve(appId);
      store.deleteApp(appId).catch((err) => console.warn('[hud] kunde inte ta bort appen', err));
    }
  }

  /**
   * Efter en omladdning av sidan (första snapshoten): HUD:arna öppnas igen i samma ordning för de appar som finns
   * kvar, på samma sida och med samma Esc-ordning. Den aktiva blir aktiv igen och får fokus. Utkast för appar som
   * försvunnit kastas. Ger true om någon HUD öppnades.
   */
  function restore(): boolean {
    const s = saved;
    saved = null;
    if (!s) return false;
    for (const id of [...drafts.keys()]) if (!store.apps.has(id)) drafts.delete(id);
    const keep = s.open.filter((e) => store.apps.has(e.app) && !panels.has(e.app));
    if (!keep.length) {
      persist();
      return false;
    }
    // Ordningen först, så att varje panel placeras med de tidigare som hinder.
    stack = S.restore(keep.map((e) => e.app), s.active, s.recent);
    for (const e of keep) panels.set(e.app, new HudPanel(host, e.app, e.reason, e.sent, e.side));
    refreshActive();
    for (const id of stack.opened) panels.get(id)?.show(0, false);
    armEscape();
    for (const id of stack.recent) sendOpen(id);
    activePanel()?.focusInput();
    persist();
    emitState();
    return true;
  }

  /* ------------------------------ bussen ------------------------------ */

  // Släppet mäts här, så att utglidningen hamnar 220 ms efter det oavsett när världen sänder hud:open.
  document.addEventListener('pointerup', () => (lastRelease = performance.now()), true);

  bus.on('app:focus', ({ appId }) => (focusedApp = appId));

  bus.on('hud:open', ({ appId, reason }) => {
    const delay = reason === 'created' ? SLIDE_AFTER_RELEASE - (performance.now() - lastRelease) : 0;
    open(appId, reason, { slideDelay: delay, activate: true });
  });
  bus.on('hud:close', ({ appId }) => close(appId, 'close'));
  bus.on('hud:send', ({ appId, text }) => {
    if (!store.apps.has(appId) || !text.trim()) return;
    open(appId, 'dot', { activate: true });
    panels.get(appId)?.sendText(text);
  });
  bus.on('view:changed', () => {
    lastView = performance.now();
    placeAll();
    // När kameran lagt sig prövas äldre HUD:ar igen (placement.follow).
    if (panels.size > 1) {
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        settleTimer = null;
        placeAll();
      }, VIEW_SETTLE_MS + 10);
    }
  });

  addEventListener('resize', () => {
    for (const id of stack.opened) panels.get(id)?.onResize();
  });

  /* ------------------------------ butiken ------------------------------ */

  store.on('chat', (appId) => {
    liveEvents(appId);
    panels.get(appId)?.renderAll(true);
  });

  store.on('app', (appId) => {
    const app = store.apps.get(appId);
    const prev = prevStatus.get(appId);
    if (app) prevStatus.set(appId, app.status);
    panels.get(appId)?.renderAll(true);
    // Automatik (§13): vid övergången till waiting öppnas appens HUD. Är en annan öppen blir den inte aktiv.
    if (app?.status === 'waiting' && prev !== 'waiting' && !panels.has(appId)) open(appId, 'auto', { activate: false });
  });

  store.on('app.removed', (appId) => {
    prevStatus.delete(appId);
    highWater.delete(appId);
    close(appId, 'removed');
    drafts.delete(appId);
    via.delete(appId);
    persist();
  });

  let firstSnapshot = true;
  store.on('snapshot', () => {
    for (const id of [...panels.keys()]) if (!store.apps.has(id)) close(id, 'removed');
    const before = new Map(prevStatus);
    for (const app of store.apps.values()) prevStatus.set(app.id, app.status);
    // Efter en omladdning av sidan (Vites omstart i dev, ⌘R): HUD:arna och utkasten kommer tillbaka (persist.ts).
    const first = firstSnapshot;
    const restored = first ? restore() : false;
    firstSnapshot = false;
    if (!restored) for (const id of stack.opened) panels.get(id)?.renderAll(true);
    // Automatik vid en snapshot där appen redan väntar: vid sidans första snapshot, och annars bara för appar som
    // börjat vänta sedan förra (ett avbrott i nätet öppnar inte HUD:ar som användaren stängt).
    for (const app of store.apps.values()) {
      if (app.status !== 'waiting' || panels.has(app.id)) continue;
      if (first || before.get(app.id) !== 'waiting') open(app.id, 'auto', { activate: false });
    }
  });

  store.on('connection', (ok) => {
    if (!panels.size) return;
    if (ok) {
      // I den ordning HUD:arna senast var aktiva, den aktiva sist (§13).
      for (const id of stack.recent) {
        sendOpen(id);
        store.loadHistory(id).catch(() => {});
      }
    }
    for (const id of stack.opened) panels.get(id)?.renderAll(true);
  });

  store.on('limits', () => {
    for (const id of stack.opened) panels.get(id)?.renderAll(true);
  });

  /* ------------------------------ uppläsningen (§12) ------------------------------ */

  // Nya händelser skiljs från historik med tidsstämplarna: allt efter högvattenmärket har kommit live.
  function liveEvents(appId: string): void {
    const events = store.chats.get(appId) ?? [];
    const max = M.maxAt(events);
    const hw = highWater.get(appId);
    if (hw === undefined) {
      highWater.set(appId, max);
      return;
    }
    if (max <= hw) return;
    highWater.set(appId, max);
    events.forEach((e, i) => {
      if (e.k === 'turn' && e.phase === 'end' && e.at > hw) turnEnded(appId, events.slice(0, i + 1), e);
    });
  }

  function turnEnded(appId: string, upTo: ChatEvent[], e: Extract<ChatEvent, { k: 'turn' }>): void {
    if (via.get(appId) !== 'voice') return;
    via.delete(appId);
    if (!e.ok || Date.now() - e.at > SPEAK_FRESH_MS) return;
    // Spelar en annan HUD in just nu skulle mikrofonen höra uppläsningen.
    if (voice.state !== 'idle') return;
    const text = M.closingText(upTo);
    if (!text) return;
    const sentence = M.firstSentence(plainText(parseMarkdown(text)));
    if (sentence) void speak(sentence);
  }

  /* ------------------------------ skriv var som helst (§13) ------------------------------ */

  // Fältet (§10.9): när ingen HUD är öppen öppnar det första tecknet på tom yta fältet.
  const field = createField(root, world, () => focusedApp);

  // Den enda tangentlyssnaren HUD:arna har utanför sina egna inmatningar (bubbelfasen, efter världens).
  document.addEventListener('keydown', (e) => {
    const p = activePanel();
    if (e.defaultPrevented || e.isComposing) return;
    // Under ett drag (rita, flytta) hör tecknen till appen som ritas (världen samlar dem, §10.4), aldrig till en öppen HUD.
    if (document.documentElement.classList.contains('wb-dragging')) return;
    if (e.metaKey || e.ctrlKey || e.altKey || e.key.length !== 1) return;
    const a = document.activeElement;
    if (a instanceof HTMLIFrameElement) return; // fokus i en app
    if (a instanceof HTMLElement && (a.isContentEditable || a instanceof HTMLInputElement || a instanceof HTMLTextAreaElement || a instanceof HTMLSelectElement)) {
      return; // ett annat fält (eller en HUD:s inmatning, eller fältet)
    }
    const isButton = a instanceof HTMLButtonElement || (a instanceof HTMLElement && /^(button|menuitem|checkbox|radio)$/.test(a.getAttribute('role') ?? ''));
    if (e.key === ' ' && isButton) return; // knappar behåller mellanslaget
    if (!p) {
      // Ingen HUD öppen: fältet, med tecknet (mellanslag öppnar det inte).
      if (e.key === ' ' || field.open) return;
      e.preventDefault();
      field.start(e.key);
      return;
    }
    if (p.menu.open) p.menu.close(false);
    if (e.key === ' ' && !p.input.value) {
      e.preventDefault();
      p.focusInput();
      p.spaceDown();
      return;
    }
    // Fokus flyttas innan tecknet skrivs, så tecknet hamnar i inmatningen.
    p.focusInput();
  });
}
