// shell.ts — en minimal "värld" för bryggans webbläsartester. Den placerar app-iframes med en transform,
// kopplar createParentBridge (eller en planterad läcka av den) och sparar varje anrop i window.__harness.calls.
// Konfigurationen kommer som JSON i ?cfg=…, läckan som ?leak=<namn>.
import type { BridgeWindow } from '../../web/src/types.ts';

type BridgeModule = typeof import('../../web/src/bridge.ts');

interface Placement {
  appId: string;
  page: string; // sökväg + query i appen, t.ex. "index.html?leak=precise"
  face: string; // sidan som världen tror att iframen visar
  x: number;
  y: number;
  s: number;
  w: number;
  h: number;
  registered: boolean; // false: en iframe som världen inte känner till
}

interface Call {
  kind: string;
  appId: string;
  face: string;
  args: unknown[];
  at: number;
}

const q = new URLSearchParams(location.search);
const leak = q.get('leak');
const placements: Placement[] = JSON.parse(q.get('cfg') ?? '[]') as Placement[];
const appOrigin = (id: string): string => `http://${id}.localhost:${location.port}`;
const calls: Call[] = [];
const byWindow = new Map<MessageEventSource, BridgeWindow>();
const windowOf = new Map<BridgeWindow, Window>();
const iframes: HTMLIFrameElement[] = [];
let topWheel = 0;
addEventListener('wheel', () => topWheel++, { passive: true });

const mod = (await import(`/web/src/bridge.ts${leak ? `?leak=${encodeURIComponent(leak)}` : ''}`)) as BridgeModule;

for (const p of placements) {
  const wrap = document.createElement('div');
  wrap.className = 'win';
  wrap.style.width = `${p.w}px`;
  wrap.style.height = `${p.h}px`;
  wrap.style.transform = `translate(${p.x}px, ${p.y}px) scale(${p.s})`;
  const iframe = document.createElement('iframe');
  iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads');
  iframe.setAttribute('allow', 'fullscreen; clipboard-write');
  iframe.src = `${appOrigin(p.appId)}/${p.page}`;
  wrap.append(iframe);
  document.body.append(wrap);
  iframes.push(iframe);
  const win = iframe.contentWindow;
  if (!win || !p.registered) continue;
  const bw: BridgeWindow = {
    appId: p.appId,
    face: p.face,
    toScreen(x, y) {
      const pt = new DOMMatrix(getComputedStyle(wrap).transform).transformPoint(new DOMPoint(x, y));
      return { x: pt.x, y: pt.y };
    },
  };
  byWindow.set(win, bw);
  windowOf.set(bw, win);
}

// Bara för läckan "by-origin": en brygga som litar på origin i stället för på event.source.
(globalThis as unknown as { __resolveByOrigin: (o: string) => BridgeWindow | null }).__resolveByOrigin = (o) =>
  [...byWindow.values()].find((w) => appOrigin(w.appId) === o) ?? null;

const record = (kind: string, w: BridgeWindow, ...args: unknown[]): void => {
  calls.push({ kind, appId: w.appId, face: w.face, args, at: performance.now() });
};

let replyFace: string | null = null;
const unsubscribe = mod.createParentBridge({
  resolve: (source) => (source ? byWindow.get(source) ?? null : null),
  appOrigin,
  onHello(w, info) {
    record('hello', w, info);
    mod.sendFace(windowOf.get(w), appOrigin(w.appId), replyFace ?? w.face);
  },
  onZoom: (w, dy, sx, sy, opts) => record('zoom', w, dy, sx, sy, opts),
  onPan: (w, dx, dy, mode, momentum) => record('pan', w, dx, dy, mode, momentum),
  onAltWheel: (w, dx, dy, momentum) => record('alt', w, dx, dy, momentum),
  onKey: (w, key) => record('key', w, key),
  onFocus: (w) => record('focus', w),
  onFaceRequest: (w, face) => record('face', w, face),
});

Object.assign(window, {
  __harness: {
    calls,
    placements,
    topWheel: () => topWheel,
    /** Svara på kommande hello med en annan sida än placeringens. */
    setReplyFace(face: string | null) {
      replyFace = face;
    },
    /** Skicka face till iframe nr i, till appens exakta origin. */
    sendFace(i: number, current: string) {
      mod.sendFace(iframes[i].contentWindow, appOrigin(placements[i].appId), current);
    },
    /** Ett välformat meddelande från skalet självt (ska ignoreras). */
    selfPost(msg: unknown) {
      window.postMessage(msg, '*');
    },
    unsubscribe,
    ready: true,
  },
});
