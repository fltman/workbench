// server/http/util.ts — små hjälpare för svar, kroppar och lås. Ägs av server-http.
import { STATUS_CODES } from 'node:http';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';

/** Ett fel som blir ett HTTP-svar med just den statusen. */
export class HttpError extends Error {
  status: number;
  headers: Record<string, string>;
  constructor(status: number, message?: string, headers: Record<string, string> = {}) {
    super(message ?? STATUS_CODES[status] ?? String(status));
    this.status = status;
    this.headers = headers;
  }
}

/** 405 med Allow-huvudet. */
export function methodNotAllowed(allow: string): HttpError {
  return new HttpError(405, 'metoden stöds inte', { allow });
}

/** Första värdet av ett huvud (Node slår ihop dubbletter till en lista för vissa huvuden). */
export function header(headers: IncomingHttpHeaders, name: string): string | undefined {
  const v = headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/** Delar req.url i den råa sökvägen (oavkodad) och frågesträngen. */
export function splitUrl(raw: string | undefined): { path: string; query: string } {
  const url = raw ?? '/';
  const q = url.indexOf('?');
  return q < 0 ? { path: url, query: '' } : { path: url.slice(0, q), query: url.slice(q + 1) };
}

/** Mediatypen före ';', gemener och utan blanktecken ("audio/webm;codecs=opus" -> "audio/webm"). */
export function mediaType(v: string | string[] | undefined): string {
  const s = Array.isArray(v) ? v[0] : v;
  return (s ?? '').split(';')[0].trim().toLowerCase();
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const data = Buffer.from(JSON.stringify(body));
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, {
    ...headers,
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(data.length),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(res.req?.method === 'HEAD' ? undefined : data);
}

export function sendEmpty(res: ServerResponse, status: number, headers: Record<string, string> = {}): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, { ...headers, 'content-length': '0', 'cache-control': 'no-store' });
  res.end();
}

/** Så mycket oläst kropp slängs innan ett felsvar skickas; mer än så ger svaret direkt. */
export const DRAIN_MAX = 64 * 1024 * 1024;

/**
 * Läser och slänger resten av en kropp (högst `max` byte). Utan det stänger Node anslutningen direkt efter
 * ett tidigt felsvar när klienten bett om "connection: close", och klienten får en RST mitt i uppladdningen
 * i stället för statusen (413, 415 …).
 */
export function discardBody(req: IncomingMessage, max = DRAIN_MAX): Promise<void> {
  return new Promise((resolve) => {
    if (req.complete || req.readableEnded || req.destroyed) {
      resolve();
      return;
    }
    let n = 0;
    const done = (): void => {
      req.off('data', onData);
      req.off('end', done);
      req.off('close', done);
      req.off('error', done);
      resolve();
    };
    const onData = (c: Buffer): void => {
      n += c.length;
      if (n > max) done();
    };
    req.on('data', onData);
    req.on('end', done);
    req.on('close', done);
    req.on('error', done);
    req.resume();
  });
}

/** Svarar på ett fel: HttpError ger sin status, allt annat 500 (utan detaljer till klienten). */
export async function sendError(res: ServerResponse, err: unknown, json = true): Promise<void> {
  const status = err instanceof HttpError ? err.status : 500;
  if (!(err instanceof HttpError)) console.error('[workbench] fel i en förfrågan:', err);
  if (res.req) await discardBody(res.req);
  const headers = err instanceof HttpError ? err.headers : {};
  if (json) sendJson(res, status, { error: err instanceof HttpError ? err.message : 'internt fel' }, headers);
  else sendEmpty(res, status, headers);
}

/**
 * Läser hela kroppen, högst `limit` byte. Större kroppar ger HttpError(413) direkt (Content-Length)
 * eller så snart gränsen passeras; resten slängs oläst.
 */
export function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(header(req.headers, 'content-length'));
    if (Number.isFinite(declared) && declared > limit) {
      reject(new HttpError(413, 'för stor kropp'));
      return;
    }
    const chunks: Buffer[] = [];
    let n = 0;
    let done = false;
    const finish = (err?: Error): void => {
      if (done) return;
      done = true;
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('close', onClose);
      if (err) {
        // Resten av kroppen slängs, så att svaret når fram och anslutningen kan återanvändas.
        req.resume();
        reject(err);
      } else {
        resolve(Buffer.concat(chunks, n));
      }
    };
    const onData = (c: Buffer): void => {
      n += c.length;
      if (n > limit) finish(new HttpError(413, 'för stor kropp'));
      else chunks.push(c);
    };
    const onEnd = (): void => finish();
    const onError = (e: Error): void => finish(new HttpError(400, e.message));
    const onClose = (): void => finish(new HttpError(400, 'avbruten'));
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('close', onClose);
  });
}

/** Läser en JSON-kropp. Ogiltig JSON ger 400. */
export async function readJson(req: IncomingMessage, limit: number): Promise<unknown> {
  const buf = await readBody(req, limit);
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw new HttpError(400, 'ogiltig JSON');
  }
}

/** Avvisar en uppgradering: skriver ett rått HTTP-svar på socketen och stänger den. */
export function rejectUpgrade(socket: Duplex, status: number, opts: { location?: string; json?: unknown } = {}): void {
  if (socket.destroyed) return;
  const body = opts.json === undefined ? '' : JSON.stringify(opts.json);
  const lines = [
    `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ''}`,
    'connection: close',
    'cache-control: no-store',
    `content-length: ${Buffer.byteLength(body)}`,
  ];
  if (opts.json !== undefined) lines.push('content-type: application/json; charset=utf-8');
  if (opts.location) lines.push(`location: ${opts.location}`);
  socket.end(`${lines.join('\r\n')}\r\n\r\n${body}`);
  setTimeout(() => socket.destroy(), 1000).unref();
}

/** Lås per nyckel: anrop med samma nyckel körs efter varandra, i den ordning de kom. */
export function createLocks(): <T>(key: string, fn: () => Promise<T>) => Promise<T> {
  const tails = new Map<string, Promise<unknown>>();
  return <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const prev = tails.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    tails.set(key, tail);
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return run;
  };
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}
