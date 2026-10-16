// store.ts — skalets tillstånd och kontakten med servern (WebSocket /ws + REST /api). FRUSET gränssnitt.
// Världen och HUD:en läser härifrån och lyssnar med store.on(...). Kameran ägs live av världen;
// hit skickas den bara för att sparas (debouncat).
import type {
  AppInfo, Camera, ChatEvent, ChatHistoryResponse, ClientMsg, CreateAppRequest, CreateAppResponse, OpenItem, RouteResponse, Scene, ServerMsg, WindowState,
} from '../../shared/protocol.ts';
import { PROTOCOL_VERSION } from '../../shared/protocol.ts';

export interface StoreEvents {
  connection: boolean;           // ansluten eller inte
  snapshot: Scene;               // ny helhetsbild från servern (vid varje (åter)anslutning)
  app: string;                   // appens id: ny eller ändrad AppInfo
  'app.removed': string;         // appens id
  window: WindowState;           // fönster ändrat utifrån (annan flik eller servern)
  'window.removed': string;      // fönstrets id
  chat: string;                  // appens id: chatten eller den levande texten ändrades
  limits: { fiveHour: number; sevenDay: number };
}

type Fn<T> = (v: T) => void;

class Store {
  connected = false;
  scene: Scene = { version: 1, camera: { cx: 0, cy: 0, zoom: 1 }, windows: [] };
  apps = new Map<string, AppInfo>();
  /** Chatthändelser per app, utan 'delta'. */
  chats = new Map<string, ChatEvent[]>();
  /** Text som strömmar in just nu (deltas sedan senaste färdiga textblock), per app. */
  live = new Map<string, string>();
  limits: { fiveHour: number; sevenDay: number } | null = null;

  #handlers = new Map<keyof StoreEvents, Set<Fn<never>>>();
  #ws: WebSocket | null = null;
  #retry = 0;
  #historyLoaded = new Set<string>();
  #winTimers = new Map<string, ReturnType<typeof setTimeout>>();
  #camTimer: ReturnType<typeof setTimeout> | null = null;
  /** Fönster och kamera som ännu inte nått servern (avbrott, omstart, omladdning). Läggs över nästa snapshot och skickas då. */
  #pendingWins = new Map<string, WindowState>();
  #pendingCam: Camera | null = null;
  #firstSnapshot = true;
  #hooked = false;

  on<K extends keyof StoreEvents>(type: K, fn: Fn<StoreEvents[K]>): () => void {
    let set = this.#handlers.get(type);
    if (!set) this.#handlers.set(type, (set = new Set()));
    set.add(fn as Fn<never>);
    return () => set.delete(fn as Fn<never>);
  }

  #emit<K extends keyof StoreEvents>(type: K, v: StoreEvents[K]): void {
    for (const fn of [...(this.#handlers.get(type) ?? [])]) {
      try {
        (fn as Fn<StoreEvents[K]>)(v);
      } catch (err) {
        console.error(`[store] ${type}`, err);
      }
    }
  }

  /* ----------------------------- anslutning ----------------------------- */

  connect(): void {
    if (!this.#hooked && typeof window !== 'undefined') {
      // Vid omladdning (⌘R, eller Vites omladdning efter en omstart i dev) skickas det som väntar direkt, och det
      // som inte kom fram sparas i sessionStorage till första snapshoten efter omladdningen.
      this.#hooked = true;
      window.addEventListener('pagehide', () => this.#flushPending(true));
    }
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    this.#ws = ws;
    ws.onopen = () => {
      this.#retry = 0;
      ws.send(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION } satisfies ClientMsg));
    };
    ws.onmessage = (e) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(String(e.data)) as ServerMsg;
      } catch {
        return;
      }
      this.receive(msg);
    };
    ws.onclose = () => {
      if (this.#ws !== ws) return;
      this.#ws = null;
      if (this.connected) {
        this.connected = false;
        this.#emit('connection', false);
      }
      const delay = Math.min(5000, 400 * 2 ** this.#retry++);
      setTimeout(() => this.connect(), delay);
    };
  }

  send(msg: ClientMsg): boolean {
    if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) return false;
    this.#ws.send(JSON.stringify(msg));
    return true;
  }

  /** Tar emot ett meddelande från servern. Exporterad för tester. */
  receive(msg: ServerMsg): void {
    switch (msg.t) {
      case 'snapshot': {
        // Ny helhetsbild (första anslutning eller efter avbrott): allt chattillstånd läses om på begäran.
        // Det som flyttades medan servern inte hörde (eller före en omladdning) läggs över, så att fönstren
        // står kvar där användaren lämnade dem, och skickas sedan.
        // Det som väntar gäller bara samma scen. Fönster-id:n slumpas per app, så en server med ett annat hem
        // (WORKBENCH_HOME) delar inget fönster med den förra scenen: då kastas allt som väntar, även kameran.
        let known = this.scene.windows.map((w) => w.id);
        if (this.#firstSnapshot) {
          this.#firstSnapshot = false;
          known = this.#restorePending() ?? known;
        }
        if (!msg.scene.windows.some((w) => known.includes(w.id))) {
          this.#pendingWins.clear();
          this.#pendingCam = null;
        }
        for (const [id, w] of this.#pendingWins) {
          const i = msg.scene.windows.findIndex((x) => x.id === id);
          if (i >= 0) msg.scene.windows[i] = { ...msg.scene.windows[i], x: w.x, y: w.y, w: w.w, h: w.h, scale: w.scale, z: w.z, face: w.face };
          else this.#pendingWins.delete(id);
        }
        if (this.#pendingCam) msg.scene.camera = this.#pendingCam;
        this.scene = msg.scene;
        this.apps = new Map(msg.apps.map((a) => [a.id, a]));
        this.chats.clear();
        this.live.clear();
        this.#historyLoaded.clear();
        if (!this.connected) {
          this.connected = true;
          this.#emit('connection', true);
        }
        this.#emit('snapshot', msg.scene);
        this.#flushPending(false);
        break;
      }
      case 'app':
        this.apps.set(msg.app.id, msg.app);
        this.#emit('app', msg.app.id);
        break;
      case 'app.removed':
        this.apps.delete(msg.appId);
        this.chats.delete(msg.appId);
        this.live.delete(msg.appId);
        this.#historyLoaded.delete(msg.appId);
        this.#emit('app.removed', msg.appId);
        break;
      case 'scene.window': {
        const i = this.scene.windows.findIndex((w) => w.id === msg.win.id);
        if (i >= 0) this.scene.windows[i] = msg.win;
        else this.scene.windows.push(msg.win);
        this.#emit('window', msg.win);
        break;
      }
      case 'scene.windowRemoved':
        this.scene.windows = this.scene.windows.filter((w) => w.id !== msg.id);
        this.#emit('window.removed', msg.id);
        break;
      case 'chat':
        this.#addChat(msg.appId, msg.ev);
        break;
      case 'limits':
        this.limits = { fiveHour: msg.fiveHour, sevenDay: msg.sevenDay };
        this.#emit('limits', this.limits);
        break;
      case 'error':
        console.warn('[server]', msg.message);
        break;
    }
  }

  #addChat(appId: string, ev: ChatEvent): void {
    if (ev.k === 'delta') {
      this.live.set(appId, (this.live.get(appId) ?? '') + ev.text);
    } else {
      if (ev.k === 'text' || ev.k === 'turn') this.live.set(appId, '');
      let list = this.chats.get(appId);
      if (!list) this.chats.set(appId, (list = []));
      list.push(ev);
    }
    this.#emit('chat', appId);
  }

  /* ----------------------------- scen ----------------------------- */

  windowOf(appId: string): WindowState | undefined {
    return this.scene.windows.find((w) => w.appId === appId);
  }

  /** Uppdatera ett fönster lokalt och skicka det (debouncat per fönster) för att sparas. */
  updateWindow(win: WindowState): void {
    const i = this.scene.windows.findIndex((w) => w.id === win.id);
    if (i >= 0) this.scene.windows[i] = win;
    else this.scene.windows.push(win);
    this.#pendingWins.set(win.id, win);
    clearTimeout(this.#winTimers.get(win.id));
    this.#winTimers.set(win.id, setTimeout(() => {
      this.#winTimers.delete(win.id);
      this.#sendWindow(win.id);
    }, 120));
  }

  /** Spara kameran (debouncat). Världen äger den levande kameran. */
  setCamera(camera: Camera): void {
    this.scene.camera = camera;
    this.#pendingCam = camera;
    if (this.#camTimer) clearTimeout(this.#camTimer);
    this.#camTimer = setTimeout(() => {
      this.#camTimer = null;
      this.#sendCamera();
    }, 400);
  }

  /** Skickar fönstret om det väntar; går det inte (ingen kontakt) väntar det kvar till nästa snapshot. */
  #sendWindow(id: string): void {
    const cur = this.scene.windows.find((w) => w.id === id);
    if (!cur || !this.#pendingWins.has(id)) {
      this.#pendingWins.delete(id);
      return;
    }
    if (this.send({ t: 'scene.window', win: cur })) this.#pendingWins.delete(id);
  }

  #sendCamera(): void {
    if (this.#pendingCam && this.send({ t: 'scene.camera', camera: this.scene.camera })) this.#pendingCam = null;
  }

  /** Skicka allt som väntar nu (debouncen hoppas över). Vid pagehide sparas resten i sessionStorage. */
  #flushPending(persist: boolean): void {
    for (const t of this.#winTimers.values()) clearTimeout(t);
    this.#winTimers.clear();
    if (this.#camTimer) clearTimeout(this.#camTimer);
    this.#camTimer = null;
    for (const id of [...this.#pendingWins.keys()]) this.#sendWindow(id);
    this.#sendCamera();
    if (!persist) return;
    try {
      if (this.#pendingWins.size || this.#pendingCam) {
        const ids = this.scene.windows.map((w) => w.id);
        sessionStorage.setItem(PENDING_KEY, JSON.stringify({ at: Date.now(), ids, wins: [...this.#pendingWins.values()], cam: this.#pendingCam }));
      } else sessionStorage.removeItem(PENDING_KEY);
    } catch {
      /* ingen lagring: det som väntar går förlorat, som förut */
    }
  }

  /**
   * Läser det som sparades vid förra pagehide (bara vid första snapshoten efter en omladdning). Ger fönster-id:n i
   * scenen då, så att det som väntar bara läggs över samma scen, eller null. En gammal post (flik som öppnats igen
   * långt senare) kastas: då kan en annan flik ha flyttat fönstren sedan dess.
   */
  #restorePending(): string[] | null {
    let raw: string | null = null;
    try {
      raw = sessionStorage.getItem(PENDING_KEY);
      sessionStorage.removeItem(PENDING_KEY);
    } catch {
      return null;
    }
    if (!raw) return null;
    try {
      const v = JSON.parse(raw) as { at?: unknown; ids?: unknown; wins?: unknown; cam?: unknown };
      const age = Date.now() - Number(v.at);
      if (!(age >= 0 && age < PENDING_MAX_AGE) || !Array.isArray(v.ids)) return null;
      const ids = v.ids.filter((x): x is string => typeof x === 'string');
      if (Array.isArray(v.wins)) {
        for (const w of v.wins as WindowState[]) {
          if (w && typeof w.id === 'string' && ids.includes(w.id) && [w.x, w.y, w.w, w.h, w.scale, w.z, w.face].every(Number.isFinite) && !this.#pendingWins.has(w.id)) this.#pendingWins.set(w.id, w);
        }
      }
      const c = v.cam as Camera | null | undefined;
      if (c && [c.cx, c.cy, c.zoom].every(Number.isFinite) && c.zoom > 0 && !this.#pendingCam) this.#pendingCam = { cx: c.cx, cy: c.cy, zoom: c.zoom };
      return ids;
    } catch {
      return null; /* trasig post: ignoreras */
    }
  }

  /* ----------------------------- REST ----------------------------- */

  /** Skapa en app från en ritad fyrkant. Servern sänder också 'app' och 'scene.window'; båda vägarna är idempotenta. */
  async createApp(req: CreateAppRequest): Promise<CreateAppResponse> {
    const res = await api<CreateAppResponse>('POST', '/api/apps', req);
    this.apps.set(res.app.id, res.app);
    const i = this.scene.windows.findIndex((w) => w.id === res.win.id);
    if (i >= 0) this.scene.windows[i] = res.win;
    else this.scene.windows.push(res.win);
    this.#emit('app', res.app.id);
    this.#emit('window', res.win);
    return res;
  }

  async deleteApp(appId: string): Promise<void> {
    await api('DELETE', `/api/apps/${encodeURIComponent(appId)}`);
  }

  /** Ångra Claudes senaste tur. false = inget att ångra. Kastar om Claude arbetar (409). */
  async undo(appId: string): Promise<boolean> {
    const res = await api<{ ok: boolean }>('POST', `/api/apps/${encodeURIComponent(appId)}/undo`);
    return res.ok;
  }

  /** Förslag på förbättringar av appen (§8.12): sparade per rev, annars en fråga till Claude (kan ta några sekunder). */
  async ideas(appId: string): Promise<{ rev: number; items: string[] }> {
    return api<{ rev: number; items: string[] }>('POST', `/api/apps/${encodeURIComponent(appId)}/ideas`);
  }

  /** Vart det som skrivs i fältet ska (§8.13): en app att öppna i, eller ett förslag att bygga. */
  async route(text: string, known: OpenItem | null): Promise<RouteResponse> {
    return api<RouteResponse>('POST', '/api/route', { text, known });
  }

  /** Skicka inspelat tal och få tillbaka text. */
  async transcribe(audio: Blob): Promise<string> {
    const res = await fetch('/api/stt', { method: 'POST', headers: { 'content-type': audio.type || 'audio/webm' }, body: audio });
    if (!res.ok) throw new Error(`stt ${res.status}`);
    return ((await res.json()) as { text: string }).text;
  }

  /** Läs in sparad chatthistorik en gång per app; händelser som redan kommit live behålls. */
  async loadHistory(appId: string): Promise<void> {
    if (this.#historyLoaded.has(appId)) return;
    this.#historyLoaded.add(appId);
    try {
      const { events } = await api<ChatHistoryResponse>('GET', `/api/apps/${encodeURIComponent(appId)}/chat`);
      const seen = new Set(events.map(key));
      const liveOnly = (this.chats.get(appId) ?? []).filter((e) => !seen.has(key(e)));
      this.chats.set(appId, [...events, ...liveOnly]);
      this.#emit('chat', appId);
    } catch (err) {
      this.#historyLoaded.delete(appId);
      throw err;
    }
  }
}

/** sessionStorage-nyckeln för fönster och kamera som inte hann sparas före en omladdning ('wb.hud' är HUD:ens). */
const PENDING_KEY = 'wb.pending';
/** Äldre poster än så läggs inte över (omladdningen efter en omstart tar några sekunder). */
const PENDING_MAX_AGE = 60_000;

function key(e: ChatEvent): string {
  return 'id' in e ? `${e.k}:${e.id}` : `${e.k}:${'at' in e ? e.at : ''}`;
}

async function api<T = unknown>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${url}: ${res.status} ${await res.text().catch(() => '')}`);
  return (await res.json()) as T;
}

export const store = new Store();
