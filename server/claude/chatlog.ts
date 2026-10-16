// server/claude/chatlog.ts — data/apps/<id>/chat.jsonl och session.json (CONTRACT §3, §8.1, §8.10).
// chat.jsonl: en ChatEvent per rad, aldrig 'delta'. Skrivs synkront så att ordningen alltid stämmer
// och så att history() direkt ser en ny fråga (vakten i /ws kontrollerar att askId finns och är obesvarat).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ChatEvent } from '../../shared/protocol.ts';

/** Så mycket av slutet på chat.jsonl som läses för historiken. */
const TAIL_BYTES = 4 * 1024 * 1024;

export function chatFile(appDataDir: string): string {
  return path.join(appDataDir, 'chat.jsonl');
}

export function sessionFile(appDataDir: string): string {
  return path.join(appDataDir, 'session.json');
}

/** Lägger till händelser i chat.jsonl (skapar katalogen vid behov). */
export function appendEvents(appDataDir: string, events: ChatEvent[]): void {
  if (events.length === 0) return;
  fs.mkdirSync(appDataDir, { recursive: true });
  fs.appendFileSync(chatFile(appDataDir), events.map((e) => JSON.stringify(e) + '\n').join(''));
}

function isEvent(v: unknown): v is ChatEvent {
  return !!v && typeof v === 'object' && typeof (v as { k?: unknown }).k === 'string';
}

/** Alla sparade händelser (eller de senaste ~4 MB), äldst först. Trasiga rader hoppas över. */
export function readEvents(appDataDir: string): ChatEvent[] {
  const file = chatFile(appDataDir);
  let text: string;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const start = Math.max(0, size - TAIL_BYTES);
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      text = buf.toString('utf8');
      if (start > 0) text = text.slice(text.indexOf('\n') + 1);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
  const out: ChatEvent[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line) as unknown;
      if (isEvent(ev) && ev.k !== 'delta') out.push(ev);
    } catch {
      /* trasig rad */
    }
  }
  return out;
}

/** De senaste limit händelserna, äldst först. */
export function history(appDataDir: string, limit = 300): ChatEvent[] {
  const all = readEvents(appDataDir);
  const n = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 300;
  return all.length > n ? all.slice(all.length - n) : all;
}

/**
 * §8.10 Omstart mitt i en tur: obesvarad ask → ask-done 'cancelled'; öppen tur → turn slut med interrupted.
 * Returnerar händelserna som lades till.
 */
export function repairChat(appDataDir: string, now = Date.now()): ChatEvent[] {
  const events = readEvents(appDataDir);
  if (events.length === 0) return [];
  const openAsks: string[] = [];
  const done = new Set<string>();
  let turnOpen = false;
  let lastAt = 0;
  for (const ev of events) {
    if ('at' in ev && typeof ev.at === 'number') lastAt = Math.max(lastAt, ev.at);
    if (ev.k === 'ask') openAsks.push(ev.id);
    else if (ev.k === 'ask-done') done.add(ev.id);
    else if (ev.k === 'turn') turnOpen = ev.phase === 'start';
  }
  const fixes: ChatEvent[] = [];
  for (const id of openAsks) if (!done.has(id)) fixes.push({ k: 'ask-done', id, decision: 'cancelled' });
  if (turnOpen) fixes.push({ k: 'turn', phase: 'end', ok: false, interrupted: true, at: Math.max(now, lastAt + 1) });
  appendEvents(appDataDir, fixes);
  return fixes;
}

/** Sparat sessions-id, eller undefined. */
export function readSessionId(appDataDir: string): string | undefined {
  try {
    const v = JSON.parse(fs.readFileSync(sessionFile(appDataDir), 'utf8')) as { sessionId?: unknown };
    return typeof v.sessionId === 'string' && v.sessionId ? v.sessionId : undefined;
  } catch {
    return undefined;
  }
}

/** Skriver fil atomiskt (tmp + rename). */
export function writeFileAtomic(file: string, data: string, mode = 0o644): void {
  const tmp = `${file}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
  const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, mode);
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* finns inte */ }
    throw err;
  }
}

export function writeSessionId(appDataDir: string, sessionId: string): void {
  fs.mkdirSync(appDataDir, { recursive: true });
  writeFileAtomic(sessionFile(appDataDir), JSON.stringify({ sessionId }) + '\n');
}

export function deleteSessionFile(appDataDir: string): void {
  try {
    fs.unlinkSync(sessionFile(appDataDir));
  } catch {
    /* fanns inte */
  }
}
