// server/claude/prompt.ts — systemprompten (app-rules.md) och <workbench>-blocket före varje användarmeddelande (CONTRACT §8.4).
// Blocket är på engelska. Till HUD:en och chat.jsonl går bara användarens egen text.
import fs from 'node:fs';
import path from 'node:path';
import type { BackendState, FaceDef, WindowState } from '../../shared/protocol.ts';

/** Högst så här mycket av appens CLAUDE.md följer med (8 kB). */
export const NOTES_MAX_BYTES = 8 * 1024;

/**
 * Språkraden i varje block. Allt annat Claude läser är engelska, och utan raden kom två av tre
 * slutsvar på engelska i en mätning med riktiga Claude (våg 3, AQ-1).
 */
export const LANGUAGE_LINE = 'Write every message to the user in Swedish.';

/** server/claude/app-rules.md, som läggs till Claude Codes förinställda systemprompt. */
export function loadAppRules(root: string): string {
  return fs.readFileSync(path.join(root, 'server', 'claude', 'app-rules.md'), 'utf8');
}

export interface BlockInput {
  /** Fönstret i scenen, om det finns. */
  win: WindowState | undefined;
  /** Appens normaliserade sidor. */
  faces: FaceDef[];
  backend: BackendState;
  backendPort: number | null;
  /** Användaren har ångrat Claudes senaste ändring sedan förra meddelandet. */
  undone: boolean;
  /** Innehållet i CLAUDE.md, bara i första meddelandet i varje ny process; null = utelämnas. */
  notes: string | null;
}

function fmtScale(s: number): string {
  if (!Number.isFinite(s)) return '1';
  return String(Math.round(s * 100) / 100);
}

export function backendLine(state: BackendState, port: number | null): string {
  switch (state) {
    case 'none': return 'Back end: none.';
    case 'running': return port ? `Back end: running on port ${port}` : 'Back end: running.';
    case 'crashed': return 'Back end: crashed – see get_app_logs';
    case 'starting': return 'Back end: starting.';
    case 'stopped': return 'Back end: stopped (reload_app starts it).';
  }
}

/** Bygger <workbench>-blocket (utan användarens text). */
export function workbenchBlock(b: BlockInput): string {
  const lines: string[] = ['<workbench>'];
  if (b.win) {
    const n = Math.max(1, b.faces.length);
    const idx = Math.min(Math.max(0, Math.floor(b.win.face) || 0), n - 1);
    const face = b.faces[idx]?.id ?? 'main';
    lines.push(`Window: ${Math.round(b.win.w)}×${Math.round(b.win.h)} CSS px (scale ${fmtScale(b.win.scale)}). Front face: ${face} (${idx + 1} of ${n}).`);
  } else {
    lines.push('Window: none (the app has no window right now).');
  }
  lines.push(backendLine(b.backend, b.backendPort));
  if (b.undone) lines.push('Since your last turn: the user undid your last change; files are restored to the previous version.');
  lines.push(LANGUAGE_LINE);
  if (b.notes !== null) {
    lines.push('Your notes (CLAUDE.md):');
    lines.push(b.notes === '' ? '(empty)' : b.notes.replace(/\s+$/, ''));
  }
  lines.push('</workbench>');
  return lines.join('\n');
}

/** Hela meddelandet till Claude: blocket först, sedan användarens text. */
export function composeMessage(block: string, userText: string): string {
  return `${block}\n${userText}`;
}

/** Tar bort ett avslutande ofullständigt UTF-8-tecken ur en buffert som kapats mitt i. */
function trimPartialUtf8(buf: Buffer): Buffer {
  let end = buf.length;
  let i = end - 1;
  let back = 0;
  while (i >= 0 && back < 4 && (buf[i] & 0xc0) === 0x80) {
    i--;
    back++;
  }
  if (i < 0) return buf;
  const lead = buf[i];
  const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  if (need > 1 && back + 1 < need) end = i;
  return buf.subarray(0, end);
}

/**
 * Läser apps/<id>/CLAUDE.md säkert: ingen symbolisk länk (O_NOFOLLOW), bara en vanlig fil, högst 8 kB.
 * Saknas den blir det '' (blocket visar "(empty)").
 */
export function readNotes(appDir: string): string {
  const file = path.join(appDir, 'CLAUDE.md');
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') return '';
    return '(CLAUDE.md could not be read; it must be a regular file in the app folder.)';
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return '(CLAUDE.md could not be read; it must be a regular file in the app folder.)';
    const buf = Buffer.alloc(NOTES_MAX_BYTES + 1);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    if (n <= NOTES_MAX_BYTES) return buf.subarray(0, n).toString('utf8');
    return trimPartialUtf8(buf.subarray(0, NOTES_MAX_BYTES)).toString('utf8') + '\n… (truncated: only the first 8 kB are shown; keep CLAUDE.md short)';
  } finally {
    fs.closeSync(fd);
  }
}

/** Första icke-tomma raden i användarens text, utan kontrolltecken, högst 72 tecken: commit-meddelandet (§6). */
export function commitLine(text: string): string {
  const line = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  const clean = Array.from(line.replace(/[\u0000-\u001f\u007f-\u009f]/g, '')).slice(0, 72).join('').trim();
  return clean || 'Ändring';
}
