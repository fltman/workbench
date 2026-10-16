// server/claude/labels.ts — svenska etiketter för Claudes verktygsanrop i HUD:ens aktivitetsrad (CONTRACT §8.3).
// Högst 60 tecken. Sökvägar visas relativt appens mapp.
import path from 'node:path';

export const LABEL_MAX = 60;

const WB = 'mcp__workbench__';

/** Kortar text till högst max tecken (kodpunkter) med … i slutet. */
function cutEnd(text: string, max: number): string {
  const cps = Array.from(text);
  return cps.length <= max ? text : cps.slice(0, Math.max(0, max - 1)).join('') + '…';
}

/** Kortar en sökväg från vänster så att filnamnet syns: "…/del/fil.js". */
function cutStart(text: string, max: number): string {
  const cps = Array.from(text);
  return cps.length <= max ? text : '…' + cps.slice(cps.length - Math.max(0, max - 1)).join('');
}

/** Prefix + sökväg, kortad från vänster. */
function withPath(prefix: string, p: string): string {
  return prefix + cutStart(p, LABEL_MAX - Array.from(prefix).length);
}

/** Prefix + fri text, kortad i slutet. */
function withText(prefix: string, t: string): string {
  return prefix + cutEnd(t, LABEL_MAX - Array.from(prefix).length);
}

/** Sökvägen relativt appens mapp; utanför mappen visas den som den är. */
export function relPath(p: unknown, appDir: string): string {
  if (typeof p !== 'string' || p === '') return '';
  const abs = path.isAbsolute(p) ? path.normalize(p) : path.join(appDir, p);
  const rel = path.relative(appDir, abs);
  if (rel === '') return '.';
  if (rel.startsWith('..') || path.isAbsolute(rel)) return p;
  return rel;
}

function oneLine(s: unknown): string {
  return typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '';
}

function unquote(w: string): string {
  if (w.length >= 2 && ((w.startsWith('"') && w.endsWith('"')) || (w.startsWith("'") && w.endsWith("'")))) return w.slice(1, -1);
  return w;
}

/** "imapflow@1.2.3" -> "imapflow", "@scope/x@2" -> "@scope/x". */
function packageName(spec: string): string {
  const s = unquote(spec);
  const at = s.lastIndexOf('@');
  return at > 0 ? s.slice(0, at) : s;
}

/** Tar bort omdirigeringar ur orden: 2>&1, >fil, <fil, och 2> fil eller &> fil, där målet är nästa ord. */
function dropRedirects(words: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const m = /^(\d*|&)(>>?|<)(&?\d*)(.*)$/.exec(words[i]);
    if (!m) out.push(words[i]);
    else if (m[3] === '' && m[4] === '') i++;
  }
  return out;
}

/** Etikett för ett Bash-kommando: npm install, node eller första ordet. cd-steg och miljötilldelningar hoppas över. */
export function bashLabel(command: unknown): string {
  const cmd = typeof command === 'string' ? command : '';
  const segments = cmd.split(/&&|\|\||;|\||\n/).map((s) => s.trim()).filter(Boolean);
  for (const seg of segments) {
    const words = dropRedirects(seg.split(/\s+/).filter(Boolean).map(unquote));
    while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift();
    if (words.length === 0) continue;
    const first = path.basename(words[0]);
    if (first === 'cd') continue;
    if (first === 'npm' && ['install', 'i', 'ci', 'add'].includes(words[1] ?? '')) {
      const pkgs = words[1] === 'ci' ? [] : words.slice(2).filter((w) => !w.startsWith('-')).map(packageName).filter(Boolean);
      return pkgs.length ? withText('Installerar ', pkgs.join(', ')) : 'Installerar beroenden';
    }
    if (first === 'node') return 'Kör node';
    return withText('Kör ', first || 'kommando');
  }
  return 'Kör ett kommando';
}

function hostOf(url: unknown): string {
  if (typeof url !== 'string') return '';
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/**
 * Svensk etikett för ett verktygsanrop.
 * @param name verktygets namn som Claude Code rapporterar det (t.ex. "Write" eller "mcp__workbench__reload_app")
 * @param input verktygets indata
 * @param appDir appens mapp (realpath), för relativa sökvägar
 */
export function toolLabel(name: string, input: Record<string, unknown> | null | undefined, appDir: string): string {
  const i = input ?? {};
  let label: string;
  if (name.startsWith(WB)) {
    const t = name.slice(WB.length);
    switch (t) {
      case 'screenshot_app': label = 'Tittar på appen'; break;
      case 'try_app': label = 'Provar appen'; break;
      case 'get_app_logs': label = 'Läser loggarna'; break;
      case 'reload_app': label = 'Startar om appen'; break;
      case 'call_backend': label = withPath('Testar ', oneLine(i.path) || '/api/'); break;
      case 'request_secret': label = withText('Ber om ', oneLine(i.label) || oneLine(i.key) || 'en hemlighet'); break;
      default: label = withText('Använder ', t);
    }
    return cutEnd(label, LABEL_MAX);
  }
  switch (name) {
    case 'Write': label = withPath('Skriver ', relPath(i.file_path, appDir) || 'en fil'); break;
    case 'Edit':
    case 'MultiEdit': label = withPath('Ändrar ', relPath(i.file_path, appDir) || 'en fil'); break;
    case 'NotebookEdit': label = withPath('Ändrar ', relPath(i.notebook_path, appDir) || 'en fil'); break;
    case 'Read': label = withPath('Läser ', relPath(i.file_path, appDir) || 'en fil'); break;
    case 'Glob':
    case 'Grep': label = 'Letar i koden'; break;
    case 'Bash': label = bashLabel(i.command); break;
    case 'WebSearch': label = withText('Söker: ', oneLine(i.query)); break;
    case 'WebFetch': {
      const host = hostOf(i.url);
      label = host ? withText('Läser ', host) : 'Läser en webbsida';
      break;
    }
    case 'AskUserQuestion': label = 'Ställer en fråga'; break;
    case 'TodoWrite': label = 'Planerar'; break;
    default: label = withText('Använder ', name);
  }
  return cutEnd(label, LABEL_MAX);
}
