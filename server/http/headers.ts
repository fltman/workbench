// server/http/headers.ts — svarshuvuden för skalet och för appernas HTML (CONTRACT §4.2).
import type { Config } from '../types.ts';

/** Skalets CSP. I produktion faller HMR-delarna (Vites websocket på hmrPort, och den SharedWorker från en
 *  blob:-URL som Vites klient pingar servern med efter en omstart) bort. */
export function shellCsp(config: Pick<Config, 'port' | 'hmrPort' | 'dev'>): string {
  const connect = ["'self'", `ws://localhost:${config.port}`];
  if (config.dev) connect.push(`ws://127.0.0.1:${config.hmrPort}`, `ws://localhost:${config.hmrPort}`);
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    `connect-src ${connect.join(' ')}`,
    `frame-src http://*.localhost:${config.port}`,
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    ...(config.dev ? ["worker-src 'self' blob:"] : []),
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/** Sätts på varje svar från skalets origin (även REST, Vite och dist/). */
export function shellHeaders(config: Pick<Config, 'port' | 'hmrPort' | 'dev'>): Record<string, string> {
  return {
    'content-security-policy': shellCsp(config),
    'x-frame-options': 'DENY',
    'referrer-policy': 'same-origin',
  };
}

/** Sätts på varje HTML-svar från en apps origin: bara skalet får rama in appen. */
export function appHtmlHeaders(port: number): Record<string, string> {
  return {
    'content-security-policy': `frame-ancestors http://localhost:${port}`,
    'referrer-policy': 'same-origin',
  };
}
