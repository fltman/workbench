// server/live/hub.ts — WebSocket-navet mot skalets flikar. Ägs av server-http.
// En flik får sändningar först när den sagt hello och fått sin snapshot (ready), så att snapshoten är
// utgångsläget och allt därefter är ändringar. Andra moduler ser bara Hub (broadcast, clients).
import type { WebSocket } from 'ws';
import type { ServerMsg } from '../../shared/protocol.ts';
import type { Hub } from '../types.ts';

const OPEN = 1;
/** En flik som inte hinner läsa (mer än så här i kö) kopplas bort i stället för att växa i minnet. */
const MAX_BUFFERED = 16 * 1024 * 1024;
const PING_MS = 30_000;

export interface HubEx extends Hub {
  /** Tar emot en ansluten flik. onMessage får varje meddelande som tolkad JSON. */
  attach(ws: WebSocket, onMessage: (msg: unknown) => void): void;
  /** Skicka till just den här fliken. */
  send(ws: WebSocket, msg: ServerMsg): void;
  /** Fliken har fått sin snapshot och får sändningar från och med nu. */
  ready(ws: WebSocket): void;
  /** Till alla redo flikar utom en (scene.window från en flik går till de andra). */
  broadcastExcept(except: WebSocket, msg: ServerMsg): void;
  closeAll(code?: number): void;
}

interface Client {
  ready: boolean;
  alive: boolean;
}

export function createHub(): HubEx {
  const clients = new Map<WebSocket, Client>();
  let timer: ReturnType<typeof setInterval> | null = null;

  function sendRaw(ws: WebSocket, data: string): void {
    if (ws.readyState !== OPEN) return;
    if (ws.bufferedAmount > MAX_BUFFERED) {
      ws.terminate();
      return;
    }
    ws.send(data, (err) => {
      if (err) ws.terminate();
    });
  }

  function heartbeat(): void {
    for (const [ws, c] of clients) {
      if (!c.alive) {
        ws.terminate();
        continue;
      }
      c.alive = false;
      try {
        ws.ping();
      } catch {
        ws.terminate();
      }
    }
  }

  function attach(ws: WebSocket, onMessage: (msg: unknown) => void): void {
    const c: Client = { ready: false, alive: true };
    clients.set(ws, c);
    if (!timer) {
      timer = setInterval(heartbeat, PING_MS);
      timer.unref();
    }
    ws.on('pong', () => {
      c.alive = true;
    });
    ws.on('error', () => {
      /* hanteras via close */
    });
    ws.on('close', () => {
      clients.delete(ws);
      if (clients.size === 0 && timer) {
        clearInterval(timer);
        timer = null;
      }
    });
    ws.on('message', (data, isBinary) => {
      c.alive = true;
      let msg: unknown;
      try {
        if (isBinary) throw new Error('binärt');
        msg = JSON.parse(String(data));
      } catch {
        send(ws, { t: 'error', message: 'Ogiltigt meddelande.' });
        return;
      }
      try {
        onMessage(msg);
      } catch (err) {
        console.error('[workbench] fel vid ett meddelande från skalet:', err);
        send(ws, { t: 'error', message: 'Meddelandet kunde inte hanteras.' });
      }
    });
  }

  function send(ws: WebSocket, msg: ServerMsg): void {
    sendRaw(ws, JSON.stringify(msg));
  }

  function broadcastExcept(except: WebSocket | null, msg: ServerMsg): void {
    const data = JSON.stringify(msg);
    for (const [ws, c] of clients) {
      if (c.ready && ws !== except) sendRaw(ws, data);
    }
  }

  return {
    attach,
    send,
    ready(ws) {
      const c = clients.get(ws);
      if (c) c.ready = true;
    },
    broadcast(msg) {
      broadcastExcept(null, msg);
    },
    broadcastExcept,
    clients() {
      let n = 0;
      for (const ws of clients.keys()) if (ws.readyState === OPEN) n++;
      return n;
    },
    closeAll(code = 1001) {
      for (const ws of clients.keys()) {
        try {
          ws.close(code);
        } catch {
          ws.terminate();
        }
      }
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
