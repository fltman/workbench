// server/http/ws.ts — /ws på skalets origin (CONTRACT §7.1). Vakten har redan krävt Origin = skalets.
// Varje klientmeddelande valideras strikt (form, typer, appen finns, askId finns och är obesvarat);
// ogiltiga ignoreras och { t: 'error' } skickas. Okända extra fält tas bort, de skickas aldrig vidare.
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { APP_ID_RE, PROTOCOL_VERSION } from '../../shared/protocol.ts';
import type { AppInfo, Ask, ChatEvent, ClientMsg, WindowState } from '../../shared/protocol.ts';
import type { AppRegistry, SceneStore, Sessions } from '../types.ts';
import type { HubEx } from '../live/hub.ts';
import { isPlainObject } from './util.ts';

export const WS_MAX_PAYLOAD = 1024 * 1024;
const TEXT_MAX = 100_000;
const ASK_ID_MAX = 200;
const ANSWERS_MAX = 50;
const ANSWER_KEY_MAX = 4000;
const ANSWER_VALUE_MAX = 10_000;
const SECRET_MAX = 64 * 1024;
const COORD_MAX = 1e9;
/** Så långt bakåt i historiken letas en obesvarad fråga. Medan en fråga väntar står turen still. */
const ASK_LOOKBACK = 2000;

export type Validated = { ok: true; msg: ClientMsg } | { ok: false; error: string };

export interface ValidateCtx {
  app(appId: string): AppInfo | undefined;
  /** Sparad historik, de senaste händelserna, äldst först. */
  history(appId: string, limit: number): ChatEvent[];
}

const fail = (error: string): Validated => ({ ok: false, error });
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const intIn = (v: unknown, lo: number, hi: number): v is number => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;

function validWindow(raw: unknown, ctx: ValidateCtx): WindowState | string {
  if (!isPlainObject(raw)) return 'Ogiltigt fönster.';
  const { id, appId, x, y, w, h, scale, face, z, minimized } = raw;
  if (typeof appId !== 'string' || !APP_ID_RE.test(appId) || !ctx.app(appId)) return 'Okänd app.';
  if (id !== `w-${appId}`) return 'Ogiltigt fönster-id.';
  if (!finite(x) || !finite(y) || Math.abs(x) > COORD_MAX || Math.abs(y) > COORD_MAX) return 'Ogiltig position.';
  if (!intIn(w, 240, 2400) || !intIn(h, 160, 1600)) return 'Ogiltig storlek.';
  if (!finite(scale) || scale < 0.05 || scale > 20) return 'Ogiltig skala.';
  if (!intIn(face, 0, 5)) return 'Ogiltig sida.';
  if (!Number.isSafeInteger(z) || (z as number) < 0) return 'Ogiltig stapelordning.';
  if (minimized !== undefined && (!Number.isSafeInteger(minimized) || (minimized as number) < 0)) return 'Ogiltig minimering.';
  const win: WindowState = { id, appId, x, y, w, h, scale, face, z: z as number };
  if (minimized !== undefined) win.minimized = minimized as number;
  return win;
}

function validAnswers(raw: unknown): Record<string, string> | null {
  if (!isPlainObject(raw)) return null;
  const entries = Object.entries(raw);
  if (entries.length > ANSWERS_MAX) return null;
  for (const [k, v] of entries) {
    if (k.length > ANSWER_KEY_MAX || typeof v !== 'string' || v.length > ANSWER_VALUE_MAX) return null;
  }
  // fromEntries skapar egna egenskaper (även "__proto__"), så inget prototypbyte kan smyga in.
  return Object.fromEntries(entries) as Record<string, string>;
}

/** Den obesvarade frågan med detta id, eller ett felmeddelande. */
function pendingAsk(ctx: ValidateCtx, appId: string, askId: string): Ask | string {
  let ask: Ask | null = null;
  for (const ev of ctx.history(appId, ASK_LOOKBACK)) {
    if (ev.k === 'ask' && ev.id === askId) ask = ev.ask;
    else if (ev.k === 'ask-done' && ev.id === askId) return 'Frågan är redan besvarad.';
  }
  return ask ?? 'Okänd fråga.';
}

export function validateClientMsg(raw: unknown, ctx: ValidateCtx): Validated {
  if (!isPlainObject(raw) || typeof raw.t !== 'string') return fail('Ogiltigt meddelande.');
  const appOk = (v: unknown): v is string => typeof v === 'string' && APP_ID_RE.test(v) && !!ctx.app(v);

  switch (raw.t) {
    case 'hello':
      if (raw.v !== PROTOCOL_VERSION) return fail('Fel protokollversion.');
      return { ok: true, msg: { t: 'hello', v: PROTOCOL_VERSION } };

    case 'scene.window': {
      const win = validWindow(raw.win, ctx);
      if (typeof win === 'string') return fail(win);
      return { ok: true, msg: { t: 'scene.window', win } };
    }

    case 'scene.camera': {
      const c = raw.camera;
      if (!isPlainObject(c)) return fail('Ogiltig kamera.');
      const { cx, cy, zoom } = c;
      if (!finite(cx) || !finite(cy) || Math.abs(cx) > COORD_MAX || Math.abs(cy) > COORD_MAX) return fail('Ogiltig kamera.');
      if (!finite(zoom) || zoom <= 0) return fail('Ogiltig zoom.');
      // Zoomgränserna 0,05–8 (§10.2); flyttalsbrus vid gränsen kläms i stället för att kastas.
      return { ok: true, msg: { t: 'scene.camera', camera: { cx, cy, zoom: Math.min(8, Math.max(0.05, zoom)) } } };
    }

    case 'chat.open':
    case 'chat.close':
    case 'chat.stop':
      if (!appOk(raw.appId)) return fail('Okänd app.');
      return { ok: true, msg: { t: raw.t, appId: raw.appId } };

    case 'chat.send': {
      if (!appOk(raw.appId)) return fail('Okänd app.');
      const { text, via } = raw;
      if (typeof text !== 'string' || text.trim() === '' || text.length > TEXT_MAX) return fail('Ogiltig text.');
      if (via !== 'text' && via !== 'voice') return fail('Ogiltigt via.');
      return { ok: true, msg: { t: 'chat.send', appId: raw.appId, text, via } };
    }

    case 'chat.answer': {
      if (!appOk(raw.appId)) return fail('Okänd app.');
      const { askId, decision } = raw;
      if (typeof askId !== 'string' || askId.length === 0 || askId.length > ASK_ID_MAX) return fail('Ogiltigt askId.');
      if (decision !== 'allow' && decision !== 'allow-always' && decision !== 'deny' && decision !== 'answered') {
        return fail('Ogiltigt beslut.');
      }
      const ask = pendingAsk(ctx, raw.appId, askId);
      if (typeof ask === 'string') return fail(ask);
      const base = { t: 'chat.answer' as const, appId: raw.appId, askId };
      if (ask.kind === 'permission') {
        if (decision === 'answered') return fail('Ogiltigt beslut.');
        if (decision === 'allow-always' && !ask.canRemember) return fail('Ogiltigt beslut.');
        return { ok: true, msg: { ...base, decision } };
      }
      if (decision === 'allow' || decision === 'allow-always') return fail('Ogiltigt beslut.');
      if (decision === 'deny') return { ok: true, msg: { ...base, decision } };
      if (ask.kind === 'question') {
        const answers = validAnswers(raw.answers);
        if (!answers) return fail('Ogiltiga svar.');
        return { ok: true, msg: { ...base, decision, answers } };
      }
      // secret: värdet följer bara med här och skrivs aldrig i något felmeddelande.
      const secret = raw.secret;
      if (typeof secret !== 'string' || secret.length === 0 || secret.length > SECRET_MAX) return fail('Ogiltig hemlighet.');
      return { ok: true, msg: { ...base, decision, secret } };
    }

    default:
      return fail('Okänd meddelandetyp.');
  }
}

export interface WsDeps {
  hub: HubEx;
  scene: Pick<SceneStore, 'get' | 'upsertWindow' | 'setCamera' | 'window'>;
  registry: Pick<AppRegistry, 'list' | 'get'>;
  sessions: Pick<Sessions, 'open' | 'close' | 'send' | 'stop' | 'answer' | 'history'>;
}

export interface WsEndpoint {
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
  close(): void;
}

export function createWsEndpoint(deps: WsDeps): WsEndpoint {
  const { hub, scene, registry, sessions } = deps;
  const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD, perMessageDeflate: false, clientTracking: false });
  const ctx: ValidateCtx = {
    app: (id) => registry.get(id),
    history: (id, limit) => sessions.history(id, limit),
  };
  // Vilka appars HUD varje flik har öppen (§8.1). En flik som stängs med HUD:en öppen skickar aldrig
  // chat.close; utan detta blev hudOpen kvar för alltid och processen stängdes aldrig.
  const huds = new Map<WebSocket, Set<string>>();

  /** HUD:en stängd i en flik: sessionen stängs bara om ingen annan flik fortfarande har den öppen. */
  function hudClosed(ws: WebSocket, appId: string): void {
    huds.get(ws)?.delete(appId);
    for (const [other, set] of huds) if (other !== ws && set.has(appId)) return;
    sessions.close(appId);
  }

  function onMessage(ws: WebSocket, raw: unknown): void {
    const v = validateClientMsg(raw, ctx);
    if (!v.ok) {
      hub.send(ws, { t: 'error', message: v.error });
      return;
    }
    const msg = v.msg;
    switch (msg.t) {
      case 'hello':
        hub.send(ws, { t: 'snapshot', scene: scene.get(), apps: registry.list() });
        hub.ready(ws);
        return;
      case 'scene.window': {
        scene.upsertWindow(msg.win);
        hub.broadcastExcept(ws, { t: 'scene.window', win: scene.window(msg.win.appId) ?? msg.win });
        return;
      }
      case 'scene.camera':
        scene.setCamera(msg.camera);
        return;
      case 'chat.open': {
        const set = huds.get(ws) ?? new Set<string>();
        huds.set(ws, set.add(msg.appId));
        sessions.open(msg.appId);
        return;
      }
      case 'chat.close':
        hudClosed(ws, msg.appId);
        return;
      case 'chat.send':
        sessions.send(msg.appId, msg.text, msg.via);
        return;
      case 'chat.stop':
        sessions.stop(msg.appId).catch((err: unknown) => {
          console.error('[workbench] stopp misslyckades:', err);
          hub.send(ws, { t: 'error', message: 'Turen kunde inte avbrytas.' });
        });
        return;
      case 'chat.answer':
        sessions.answer(msg.appId, msg.askId, msg.decision, msg.answers, msg.secret);
        return;
    }
  }

  return {
    handleUpgrade(req, socket, head) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        hub.attach(ws, (raw) => onMessage(ws, raw));
        ws.on('close', () => {
          try {
            for (const appId of [...(huds.get(ws) ?? [])]) hudClosed(ws, appId);
          } catch (err) {
            console.error('[workbench] HUD:en kunde inte stängas för en stängd flik:', err);
          } finally {
            huds.delete(ws);
          }
        });
      });
    },
    close() {
      wss.close();
    },
  };
}
