// server/backends/proxy.ts — /api/* på appens origin vidare till appens backend (CONTRACT §9, §7.2).
//
// HTTP: http.request mot 127.0.0.1:<port> med samma metod, sökväg och huvuden. Host skrivs om till
// 127.0.0.1:<port> (guard.mjs svarar annars 421) och X-Forwarded-Host/-Proto sätts. Kropparna
// strömmas i båda riktningarna; inget buffras.
// WebSocket: net.connect, den råa uppgraderingen skrivs vidare (med samma Host-omskrivning) och
// socketarna pipas.
//
// Node 25 kastar ett ohanterat 'error' (t.ex. EPIPE, ECONNRESET) och tar ner hela servern, så
// varje socket, förfrågan och svar här har en felhanterare. Fel ger 502 {"error":"backend"}.
import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';

const ERROR_BODY = '{"error":"backend"}';
const RAW_502 =
  'HTTP/1.1 502 Bad Gateway\r\n' +
  'Content-Type: application/json; charset=utf-8\r\n' +
  `Content-Length: ${ERROR_BODY.length}\r\n` +
  'Cache-Control: no-store\r\n' +
  'Connection: close\r\n\r\n' +
  ERROR_BODY;

/** Huvuden som bara gäller en förbindelse (RFC 9110 §7.6.1) och aldrig skickas vidare. */
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'upgrade']);
/** Huvuden som proxyn själv sätter. */
const REWRITTEN = new Set(['host', 'x-forwarded-host', 'x-forwarded-proto']);
// Förfrågan: transfer-encoding och content-length behålls, eftersom kroppen strömmas vidare oförändrad.
// Expect hanteras redan av workbenchens server (100 Continue), så det skickas inte vidare.
const REQUEST_DROP = new Set([...HOP_BY_HOP, ...REWRITTEN, 'expect']);
// Svaret: Node väljer själv inramning (content-length eller chunked) mot webbläsaren.
const RESPONSE_DROP = new Set([...HOP_BY_HOP, 'transfer-encoding']);

const noop = (): void => {};

/** Namnen som Connection-huvudet pekar ut; de är också förbindelsespecifika. */
function connectionTokens(value: string | string[] | undefined): Set<string> {
  const out = new Set<string>();
  for (const part of ([] as string[]).concat(value ?? [])) {
    for (const token of part.split(',')) {
      const t = token.trim().toLowerCase();
      if (t) out.add(t);
    }
  }
  return out;
}

function forwardedProto(req: IncomingMessage): string {
  return (req.socket as { encrypted?: boolean } | null)?.encrypted ? 'https' : 'http';
}

/** Förfrågans huvuden som rawHeaders-lista (behåller ordning, skiftläge och dubbletter). */
function requestHeaders(req: IncomingMessage, port: number, keepUpgrade: boolean): string[] {
  const listed = keepUpgrade ? new Set<string>() : connectionTokens(req.headers.connection);
  const raw = req.rawHeaders;
  const out: string[] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const lower = raw[i].toLowerCase();
    if (keepUpgrade ? REWRITTEN.has(lower) : REQUEST_DROP.has(lower) || listed.has(lower)) continue;
    out.push(raw[i], raw[i + 1]);
  }
  out.push('Host', `127.0.0.1:${port}`);
  if (typeof req.headers.host === 'string') out.push('X-Forwarded-Host', req.headers.host);
  out.push('X-Forwarded-Proto', forwardedProto(req));
  return out;
}

function responseHeaders(res: IncomingMessage): string[] {
  const listed = connectionTokens(res.headers.connection);
  const raw = res.rawHeaders;
  const out: string[] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const lower = raw[i].toLowerCase();
    if (RESPONSE_DROP.has(lower) || listed.has(lower)) continue;
    out.push(raw[i], raw[i + 1]);
  }
  return out;
}

export function proxyHttp(req: IncomingMessage, res: ServerResponse, port: number): void {
  req.on('error', noop);
  res.on('error', noop);
  /** Något gick fel mot backenden: 502 om inget svar påbörjats, annars avbryts svaret. */
  const fail = (): void => {
    if (res.writableFinished) return;
    if (res.headersSent || res.destroyed) {
      res.destroy();
      return;
    }
    res.writeHead(502, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(ERROR_BODY.length),
      'cache-control': 'no-store',
    });
    res.end(ERROR_BODY);
  };
  if (req.destroyed || res.destroyed) return;

  let upstream: http.ClientRequest;
  try {
    upstream = http.request({
      host: '127.0.0.1',
      port,
      method: req.method,
      path: req.url,
      headers: requestHeaders(req, port, false),
      agent: false, // en förbindelse per förfrågan: inga gamla socketar mot en omstartad backend
    });
  } catch {
    fail();
    return;
  }
  upstream.on('error', fail);
  upstream.on('response', (up) => {
    up.on('error', fail);
    if (res.headersSent || res.destroyed) {
      up.destroy();
      return;
    }
    try {
      const headers = responseHeaders(up);
      const status = up.statusCode ?? 502;
      if (up.statusMessage) res.writeHead(status, up.statusMessage, headers);
      else res.writeHead(status, headers);
    } catch {
      // ogiltigt huvud eller ogiltig statusrad från backenden
      up.destroy();
      fail();
      return;
    }
    up.pipe(res);
  });
  // Webbläsaren försvann innan svaret var klart: riv förbindelsen mot backenden.
  res.on('close', () => {
    if (!res.writableFinished) upstream.destroy();
  });
  req.pipe(upstream);
}

/** Den råa uppgraderingen, med Host omskriven. null om något ser ut att kunna dela upp förfrågan. */
function rawUpgrade(req: IncomingMessage, port: number): string | null {
  const headers = requestHeaders(req, port, true);
  const parts = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
  for (let i = 0; i + 1 < headers.length; i += 2) parts.push(`${headers[i]}: ${headers[i + 1]}`);
  // Nodes parser släpper aldrig igenom CR eller LF, men proxyn litar inte på det.
  if (parts.some((p) => /[\r\n]/.test(p))) return null;
  return parts.join('\r\n') + '\r\n\r\n';
}

export function proxyUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, port: number): void {
  // Node tar bort serverns egen felhanterare från socketen vid en uppgradering.
  socket.on('error', noop);
  req.on('error', noop);
  let connected = false;
  let refused = false;
  const refuse = (): void => {
    if (refused || connected) return;
    refused = true;
    if (!socket.destroyed && socket.writable) socket.end(RAW_502);
    setTimeout(() => socket.destroy(), 1000).unref();
  };
  if (socket.destroyed) return;
  const raw = rawUpgrade(req, port);
  if (raw === null) {
    refuse();
    return;
  }

  const upstream = net.connect({ host: '127.0.0.1', port });
  upstream.on('error', () => {
    if (connected) socket.destroy();
    else refuse();
  });
  socket.on('error', () => upstream.destroy());
  // När ena sidan stängs stängs den andra snällt (så att sista ramen hinner fram) och rivs sedan.
  const closeLater = (s: Duplex): void => {
    if (s.destroyed) return;
    s.end();
    setTimeout(() => s.destroy(), 2000).unref();
  };
  socket.on('close', () => closeLater(upstream));
  upstream.on('close', () => {
    if (connected) closeLater(socket);
  });
  upstream.on('connect', () => {
    if (socket.destroyed) {
      upstream.destroy();
      return;
    }
    connected = true;
    upstream.setNoDelay(true);
    (socket as Partial<net.Socket>).setNoDelay?.(true);
    upstream.write(raw);
    if (head && head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
}
