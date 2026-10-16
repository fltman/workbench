// bridge.ts — skalets sida av appbryggan (CONTRACT §11). Meddelanden från appar är otillförlitlig indata:
// avsändaren identifieras via event.source (opts.resolve) och exakt origin, aldrig via innehållet. Bara den
// fasta vokabulären i BridgeFromApp godtas, alla tal kläms och varje fönster får högst 400 meddelanden/s.
import type { BridgeFromApp, BridgeToApp, OpenItem } from '../../shared/protocol.ts';
import { normalizeItem } from '../../shared/open.ts';
import type { BridgeWindow, ParentBridgeOptions } from './types.ts';

/** Meddelanden per sekund och fönster (en hink som fylls på med samma takt). */
export const BRIDGE_RATE = 400;

/** deltaMode 0, 1, 2 → px. Samma faktorer som skalets hjulrouter (§10.3). */
const MODE_PX = [1, 16, 400] as const;
/** Största förflyttning i px som ett enskilt hjulmeddelande får bära. */
const MAX_DELTA_PX = 5000;
const MAX_COORD = 100_000;
const MAX_SIZE = 10_000;
const FACE_RE = /^[a-z0-9-]{1,32}$/;
const KEY_CODES = ['KeyK', 'Digit0', 'ArrowLeft', 'ArrowRight', 'Escape'] as const;
type KeyCode = (typeof KEY_CODES)[number];

/** Det bryggan läser av en MessageEvent. */
export interface BridgeMessageEvent {
  source: MessageEventSource | null;
  origin: string;
  data: unknown;
}

function num(v: unknown, lo: number, hi: number): number | null {
  if (typeof v !== 'number' || Number.isNaN(v)) return null;
  return Math.min(hi, Math.max(lo, v));
}

function isKeyCode(v: unknown): v is KeyCode {
  return typeof v === 'string' && (KEY_CODES as readonly string[]).includes(v);
}

/**
 * Tolkar ett meddelande från en app. Ger null för allt utanför vokabulären. Talen kläms, flaggor blir
 * booleska och tangenter godtas bara som ⌘K, ⌘0, ⌃⌥←/→ och Esc.
 */
export function parseFromApp(data: unknown): BridgeFromApp | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Record<string, unknown>;
  if (d.wb !== 1) return null;
  switch (d.type) {
    case 'hello': {
      const w = num(d.w, 0, MAX_SIZE);
      const h = num(d.h, 0, MAX_SIZE);
      if (typeof d.face !== 'string' || (d.face !== '' && !FACE_RE.test(d.face)) || w === null || h === null) return null;
      return { wb: 1, type: 'hello', face: d.face, w, h };
    }
    case 'wheel': {
      const action = d.action;
      if (action !== 'zoom' && action !== 'pan' && action !== 'alt') return null;
      const m = num(d.mode, 0, 2);
      if (m === null) return null;
      const mode = Math.round(m);
      const lim = MAX_DELTA_PX / MODE_PX[mode];
      const dx = num(d.dx, -lim, lim);
      const dy = num(d.dy, -lim, lim);
      const x = num(d.x, -MAX_COORD, MAX_COORD);
      const y = num(d.y, -MAX_COORD, MAX_COORD);
      if (dx === null || dy === null || x === null || y === null) return null;
      // Smart zoom (tvåfingers dubbeltryck) har alltid nollor; en app kan inte göra ett nyp till en flygning.
      const smart = action === 'zoom' && d.smart === true && dx === 0 && dy === 0;
      return { wb: 1, type: 'wheel', action, dx, dy, mode, x, y, momentum: d.momentum === true, alt: d.alt === true, smart };
    }
    case 'key': {
      const code = d.code;
      const meta = d.meta === true;
      const ctrl = d.ctrl === true;
      const alt = d.alt === true;
      const shift = d.shift === true;
      if (!isKeyCode(code)) return null;
      if ((code === 'KeyK' || code === 'Digit0') && !meta) return null;
      if ((code === 'ArrowLeft' || code === 'ArrowRight') && !(ctrl && alt)) return null;
      return { wb: 1, type: 'key', code, meta, ctrl, alt, shift };
    }
    case 'focus':
      return { wb: 1, type: 'focus' };
    case 'face':
      return typeof d.show === 'string' && FACE_RE.test(d.show) ? { wb: 1, type: 'face', show: d.show } : null;
    default:
      return null;
  }
}

function dispatch(opts: ParentBridgeOptions, w: BridgeWindow, m: BridgeFromApp): void {
  switch (m.type) {
    case 'hello':
      opts.onHello?.(w, { face: m.face, w: m.w, h: m.h });
      break;
    case 'wheel':
      if (m.action === 'zoom') {
        if (!opts.onZoom) break;
        const p = w.toScreen(m.x, m.y);
        opts.onZoom(w, m.dy, p.x, p.y, { alt: m.alt, smart: m.smart, mode: m.mode });
      } else if (m.action === 'pan') {
        opts.onPan?.(w, m.dx, m.dy, m.mode, m.momentum);
      } else {
        // onAltWheel saknar deltaMode, så den får px direkt.
        const f = MODE_PX[m.mode] ?? 1;
        opts.onAltWheel?.(w, m.dx * f, m.dy * f, m.momentum);
      }
      break;
    case 'key':
      opts.onKey?.(w, { code: m.code, meta: m.meta, ctrl: m.ctrl, alt: m.alt, shift: m.shift });
      break;
    case 'focus':
      opts.onFocus?.(w);
      break;
    case 'face':
      opts.onFaceRequest?.(w, m.show);
      break;
  }
}

/**
 * Hanteraren bakom createParentBridge, utan koppling till window (exporterad för tester).
 * now: klockan i ms för hastighetsbegränsningen.
 */
export function createBridgeHandler(opts: ParentBridgeOptions, now: () => number = () => performance.now()): (e: BridgeMessageEvent) => void {
  const buckets = new Map<string, { tokens: number; t: number }>();

  function take(appId: string): boolean {
    const t = now();
    let b = buckets.get(appId);
    if (!b) {
      if (buckets.size >= 256) for (const [id, old] of buckets) if (t - old.t > 10_000) buckets.delete(id);
      b = { tokens: BRIDGE_RATE, t };
      buckets.set(appId, b);
    } else {
      b.tokens = Math.min(BRIDGE_RATE, b.tokens + (Math.max(0, t - b.t) / 1000) * BRIDGE_RATE);
      b.t = t;
    }
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  return (e) => {
    let w: BridgeWindow | null;
    let origin: string;
    try {
      w = opts.resolve(e.source);
      if (!w) return; // okänt fönster: skalet självt, en främmande flik, en iframe som världen inte känner
      origin = opts.appOrigin(w.appId);
    } catch {
      return;
    }
    if (e.origin !== origin) return; // iframen har navigerat till en annan origin
    if (!take(w.appId)) return;
    const m = parseFromApp(e.data);
    if (!m) return;
    try {
      dispatch(opts, w, m);
    } catch (err) {
      console.error('[bridge]', err);
    }
  };
}

/** Lyssnar på appbryggans meddelanden på skalets window. Returnerar en avregistreringsfunktion. */
export function createParentBridge(opts: ParentBridgeOptions): () => void {
  const handle = createBridgeHandler(opts);
  const onMessage = (e: MessageEvent): void => handle(e);
  window.addEventListener('message', onMessage);
  return () => window.removeEventListener('message', onMessage);
}

/**
 * Skickar { wb: 1, type: 'face', current } till en apps iframe, bara till appens exakta origin.
 * Världen svarar så på varje hello och när den främre sidan ändras (§10.5).
 */
/** Något från fältet till appen (§10.9). Bara giltiga adresser, datum och texter går iväg. */
export function sendOpen(target: Window | null | undefined, appOrigin: string, item: OpenItem): void {
  if (!target || !/^https?:\/\/[^/*]+$/.test(appOrigin)) return;
  const ok = normalizeItem(item.kind, item.kind === 'url' ? item.url : item.kind === 'date' ? item.date : item.text);
  if (!ok) return;
  const msg: BridgeToApp = { wb: 1, type: 'open', item: ok };
  target.postMessage(msg, appOrigin);
}

export function sendFace(target: Window | null | undefined, appOrigin: string, current: string): void {
  if (!target || !FACE_RE.test(current) || !/^https?:\/\/[^/*]+$/.test(appOrigin)) return;
  const msg: BridgeToApp = { wb: 1, type: 'face', current };
  target.postMessage(msg, appOrigin);
}
