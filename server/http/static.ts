// server/http/static.ts — statiska filer med sökvägsreglerna i CONTRACT §4.6 och HTML-injektionen i §7.2.
// Används för appernas origins (apps/<id>/) och för skalets dist/ i produktion.
import fs from 'node:fs';
import path from 'node:path';
import type { ServerResponse } from 'node:http';

const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fs.constants;
/** O_NONBLOCK: en namngiven rörledning (mkfifo) i appen får aldrig låsa en tråd i libuv. */
const OPEN_FLAGS = O_RDONLY | O_NOFOLLOW | O_NONBLOCK;
/** HTML läses helt för injektionen; större sidor än så serveras inte. */
const MAX_HTML = 20 * 1024 * 1024;

export type Resolved = { ok: true; real: string; rel: string } | { ok: false; status: 400 | 404 };

/**
 * Avkodar URL-sökvägen EN gång. Ogiltiga escape-sekvenser och NUL (rått eller %00) ger null.
 */
export function decodeUrlPath(raw: string): string | null {
  if (raw.includes('\0')) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  return decoded.includes('\0') ? null : decoded;
}

/**
 * Löser en avkodad, relativ sökväg mot rootReal (som redan är realpath:ad):
 *  1. real = await fs.promises.realpath(join(rootReal, rel)) — inte realpathSync, som behåller förfrågans skiftläge
 *  2. 404 om real ligger utanför rootReal
 *  3. nekat (skiftlägesokänsligt, på path.relative(rootReal, real)): segment som börjar med '.', och första segment i denyFirst
 */
export async function resolveInside(rootReal: string, rel: string, denyFirst: readonly string[]): Promise<Resolved> {
  const joined = path.join(rootReal, rel);
  let real: string;
  try {
    real = await fs.promises.realpath(joined);
  } catch {
    return { ok: false, status: 404 };
  }
  const r = path.relative(rootReal, real);
  if (r === '' || r === '..' || r.startsWith(`..${path.sep}`) || path.isAbsolute(r)) return { ok: false, status: 404 };
  const segs = r.split(path.sep).map((s) => s.toLowerCase());
  if (segs.some((s) => s.startsWith('.'))) return { ok: false, status: 404 };
  if (denyFirst.includes(segs[0])) return { ok: false, status: 404 };
  return { ok: true, real, rel: r };
}

/** Kontrollen för en rå URL-sökväg (med inledande '/'). */
export async function resolveUrlPath(rootReal: string, rawPath: string, denyFirst: readonly string[]): Promise<Resolved> {
  const decoded = decodeUrlPath(rawPath);
  if (decoded === null) return { ok: false, status: 400 };
  return resolveInside(rootReal, decoded.replace(/^\/+/, ''), denyFirst);
}

/** Nekade första segment i en apps mapp (§4.6). */
export const APP_DENY_FIRST = ['data', 'node_modules'] as const;

/**
 * apps/<id> som realpath, men bara om den ligger direkt under apps/ (en utbytt mapp eller länk ger null).
 * Paths.appDir kastar för ogiltiga id; det blir också null.
 */
export async function appRealDir(appsDir: string, appDir: (id: string) => string, appId: string): Promise<string | null> {
  try {
    const appsReal = await fs.promises.realpath(appsDir);
    const real = await fs.promises.realpath(appDir(appId));
    return path.dirname(real) === appsReal && path.basename(real) === appId ? real : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Innehållstyper                                                      */
/* ------------------------------------------------------------------ */

const TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.cjs': 'text/javascript',
  '.json': 'application/json',
  '.map': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.xml': 'application/xml',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.pdf': 'application/pdf',
  '.wasm': 'application/wasm',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.zip': 'application/zip',
};

const TEXTUAL = new Set([
  'text/html', 'text/css', 'text/javascript', 'application/json', 'application/manifest+json',
  'text/plain', 'text/markdown', 'text/csv', 'application/xml', 'image/svg+xml', 'model/gltf+json',
]);

/** Content-Type efter filändelse; text får "; charset=utf-8" (§7.2). */
export function contentTypeFor(file: string): string {
  const t = TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
  return TEXTUAL.has(t) ? `${t}; charset=utf-8` : t;
}

export function isHtmlFile(file: string): boolean {
  const ext = path.extname(file).toLowerCase();
  return ext === '.html' || ext === '.htm';
}

/* ------------------------------------------------------------------ */
/* HTML-injektionen (§7.2)                                             */
/* ------------------------------------------------------------------ */

export const WB_SCRIPT = '<script src="/__wb/wb.js"></script>';

function isSpace(c: string | undefined): boolean {
  return c === ' ' || c === '\n' || c === '\t' || c === '\r' || c === '\f';
}

/** Hoppa över blanktecken och kommentarer. Returnerar index efter dem. */
function skipWsAndComments(s: string, i: number): number {
  for (;;) {
    while (i < s.length && isSpace(s[i])) i++;
    if (s.startsWith('<!--', i)) {
      const end = s.indexOf('-->', i + 4);
      if (end < 0) return s.length;
      i = end + 3;
      continue;
    }
    return i;
  }
}

/** Är det en start-tagg <name …> på plats i (inte <header>, <html-x>)? */
function isStartTag(s: string, i: number, name: string): boolean {
  if (s[i] !== '<') return false;
  if (s.slice(i + 1, i + 1 + name.length).toLowerCase() !== name) return false;
  const c = s[i + 1 + name.length];
  return c === '>' || c === '/' || isSpace(c);
}

/** Index efter taggens avslutande '>' med hänsyn till citerade attributvärden, eller -1. */
function tagEnd(s: string, i: number): number {
  let j = i + 1;
  while (j < s.length) {
    const c = s[j];
    if (c === '>') return j + 1;
    if (c === '=') {
      j++;
      while (j < s.length && isSpace(s[j])) j++;
      const q = s[j];
      if (q === '"' || q === "'") {
        const close = s.indexOf(q, j + 1);
        if (close < 0) return -1;
        j = close + 1;
        continue;
      }
      continue;
    }
    j++;
  }
  return -1;
}

/**
 * Var skriptet ska in: direkt efter <head…>. Saknas den, efter <html…>. Saknas också den, efter <!doctype …>
 * (med inledande kommentarer och blanktecken). Annars först (efter en eventuell BOM).
 * Bara dokumentets inledning läses, så ett "<head>" i en sträng längre ner flyttar aldrig skriptet.
 */
export function injectionPoint(s: string): number {
  const start = s.startsWith('\xEF\xBB\xBF') ? 3 : s.startsWith('﻿') ? 1 : 0;
  let i = skipWsAndComments(s, start);
  let afterDoctype = -1;
  if (s.slice(i, i + 9).toLowerCase() === '<!doctype') {
    const end = tagEnd(s, i);
    if (end < 0) return start;
    afterDoctype = end;
    i = skipWsAndComments(s, end);
  }
  let afterHtml = -1;
  if (isStartTag(s, i, 'html')) {
    const end = tagEnd(s, i);
    if (end > 0) {
      afterHtml = end;
      i = skipWsAndComments(s, end);
    }
  }
  if (isStartTag(s, i, 'head')) {
    const end = tagEnd(s, i);
    if (end > 0) return end;
  }
  if (afterHtml >= 0) return afterHtml;
  if (afterDoctype >= 0) return afterDoctype;
  return start;
}

/**
 * Lägger in <script src="/__wb/wb.js"></script> i HTML-bytes, alltid först (§7.2), även om sidan själv har
 * en tagg längre ner: wb.js är idempotent, och annars hinner appens egna lyssnare före bryggan.
 * Står taggen redan exakt på injektionsplatsen läggs ingen till, så att omvandlingen är idempotent.
 */
export function injectWb(html: Buffer): Buffer {
  // latin1: en byte blir ett tecken, så index i strängen är index i bufferten (taggarna är ASCII).
  const s = html.toString('latin1');
  const at = injectionPoint(s);
  if (s.startsWith(WB_SCRIPT, at)) return html;
  return Buffer.concat([html.subarray(0, at), Buffer.from(WB_SCRIPT, 'latin1'), html.subarray(at)]);
}

/* ------------------------------------------------------------------ */
/* Servera en fil                                                      */
/* ------------------------------------------------------------------ */

export interface ServeOptions {
  /** Huvuden för alla svar (t.ex. skalets CSP). */
  headers?: Record<string, string>;
  /** Extra huvuden bara för HTML (appernas frame-ancestors). */
  htmlHeaders?: Record<string, string>;
  /** Injicera wb.js i HTML. */
  inject?: boolean;
  cacheControl?: string;
  /**
   * Vägra filer med fler än en hård länk (appernas filer, SEC-5). realpath() av en hård länk är länken själv,
   * så en hård länk i appens rot till data/secrets.json skulle annars serveras. Bara den som skriver appens
   * rot (Claude, inte den sandlådade backenden) kan skapa en; det här är försvar på djupet.
   */
  refuseHardLinks?: boolean;
}

/**
 * Öppnar `real` (redan kontrollerad med resolveInside) med O_NOFOLLOW och serverar den.
 * Efter öppningen kontrolleras att sökvägen fortfarande löser till samma fil inne i roten, så att ett
 * utbyte mot en symbolisk länk mellan kontroll och öppning inte går igenom. Returnerar false om filen
 * inte kunde serveras (anroparen svarar 404).
 */
export async function serveFile(
  res: ServerResponse,
  method: string,
  rootReal: string,
  resolved: { real: string; rel: string },
  denyFirst: readonly string[],
  opts: ServeOptions = {},
): Promise<boolean> {
  let fh: fs.promises.FileHandle;
  try {
    fh = await fs.promises.open(resolved.real, OPEN_FLAGS);
  } catch {
    return false;
  }
  let handedOff = false;
  try {
    const st = await fh.stat();
    if (!st.isFile()) return false;
    if (opts.refuseHardLinks && st.nlink > 1) return false;
    // Samma fil, fortfarande inne i roten och inte nekad?
    const again = await resolveInside(rootReal, resolved.rel, denyFirst);
    if (!again.ok || again.real !== resolved.real) return false;
    const st2 = await fs.promises.stat(again.real);
    if (st2.ino !== st.ino || st2.dev !== st.dev) return false;

    const type = contentTypeFor(resolved.real);
    const html = isHtmlFile(resolved.real);
    const headers: Record<string, string> = {
      ...(opts.headers ?? {}),
      ...(html ? (opts.htmlHeaders ?? {}) : {}),
      'content-type': type,
      'cache-control': opts.cacheControl ?? 'no-store',
      'x-content-type-options': 'nosniff',
    };
    if (html) {
      if (st.size > MAX_HTML) return false;
      const raw: Buffer = await fh.readFile();
      const body = opts.inject ? injectWb(raw) : raw;
      headers['content-length'] = String(body.length);
      res.writeHead(200, headers);
      res.end(method === 'HEAD' ? undefined : body);
      return true;
    }
    headers['content-length'] = String(st.size);
    res.writeHead(200, headers);
    if (method === 'HEAD') {
      res.end();
      return true;
    }
    const stream = fh.createReadStream({ start: 0, end: Math.max(0, st.size - 1), autoClose: true });
    handedOff = true;
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    if (st.size === 0) {
      stream.destroy();
      res.end();
    } else {
      stream.pipe(res);
    }
    return true;
  } catch {
    return false;
  } finally {
    if (!handedOff) await fh.close().catch(() => {});
  }
}

/** 404 med en tom sida (§7.2). */
export function sendEmptyPage(res: ServerResponse, status: number, headers: Record<string, string> = {}): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, {
    ...headers,
    'content-type': 'text/html; charset=utf-8',
    'content-length': '0',
    'cache-control': 'no-store',
  });
  res.end();
}
