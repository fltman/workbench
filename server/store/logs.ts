// server/store/logs.ts — loggar per app: konsolen, backenden och workbenchens egna notiser (CONTRACT §3, AppLogs).
//
// - En ring i minnet per app med de senaste 2000 posterna; tail(n) formaterar "HH:MM:SS [källa] text" (lokal tid).
//   Första gången en app nämns (append eller tail) i en ny process läses ringen in ur logs.txt.1 och logs.txt, så att
//   get_app_logs och HUD:ens Visa loggen ser det som hände före en omstart (npm run dev startar om vid varje ändring).
// - Varje post läggs också till i data/apps/<id>/logs.txt ("YYYY-MM-DD HH:MM:SS [källa] text"). Skrivningarna buntas
//   (50 ms) så att en pratig backend aldrig blockerar servern. Filen roteras vid 1 MB: logs.txt blir logs.txt.1
//   (en enda tidigare fil sparas).
// - Text tvättas: ANSI-sekvenser och styrtecken (utom tabb och radbrytning) tas bort, avslutande blanktecken
//   likaså, och en post kortas till 4000 tecken. Tomma poster sparas inte.
// - Inget skrivs för en app vars mapp apps/<id> inte finns (borttagen): då skapas inga kataloger på nytt.
import fs from 'node:fs';
import path from 'node:path';
import { APP_ID_RE } from '../../shared/protocol.ts';
import type { AppLogs, Paths } from '../types.ts';

type Source = 'console' | 'backend' | 'workbench';

interface Entry {
  at: number;
  source: Source;
  text: string;
}

export const RING_SIZE = 2000;
export const ROTATE_BYTES = 1024 * 1024;
const MAX_TEXT = 4000;
const FLUSH_MS = 50;
const SOURCES: readonly Source[] = ['console', 'backend', 'workbench'];

/** Ta bort ANSI-sekvenser och styrtecken (utom \t och \n), normalisera radbrytningar och korta långa poster. */
export function cleanLogText(text: unknown): string {
  let s = (typeof text === 'string' ? text : String(text))
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '') // CSI: färger, markörrörelser
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC: fönstertitlar, länkar
    .replace(/\r\n/g, '\n')
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '')
    .replace(/\s+$/u, '');
  if (s.length > MAX_TEXT) {
    let cut = MAX_TEXT;
    const c = s.charCodeAt(cut - 1);
    if (c >= 0xd800 && c <= 0xdbff) cut--; // dela aldrig ett surrogatpar
    s = `${s.slice(0, cut)}…`;
  }
  return s;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function clock(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** "HH:MM:SS [källa] text" — formatet i tail() och get_app_logs. */
export function formatLogLine(e: Entry): string {
  return `${clock(new Date(e.at))} [${e.source}] ${e.text}`;
}

function fileLine(e: Entry): string {
  const d = new Date(e.at);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${clock(d)} [${e.source}] ${e.text}\n`;
}

const FILE_LINE_RE = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d) \[(console|backend|workbench)\] (.*)$/;

/** Posterna i en loggfil (fileLine): en rad som inte börjar med datum och källa fortsätter posten före. */
function parseLogFile(text: string): Entry[] {
  const out: Entry[] = [];
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  for (const line of lines) {
    const m = FILE_LINE_RE.exec(line);
    if (m) {
      const [, y, mo, d, h, mi, sec, source, rest] = m;
      out.push({ at: new Date(+y, +mo - 1, +d, +h, +mi, +sec).getTime(), source: source as Source, text: rest });
    } else if (out.length) out[out.length - 1].text += `\n${line}`;
  }
  return out;
}

export function createAppLogs(paths: Paths): AppLogs & { flush(): Promise<void> } {
  const rings = new Map<string, Entry[]>();
  let pending = new Map<string, string[]>();
  const sizes = new Map<string, number>(); // känd storlek på logs.txt per app
  let timer: ReturnType<typeof setTimeout> | null = null;
  let chain: Promise<void> = Promise.resolve();

  /**
   * Appens ring; första gången i processen inläst ur logs.txt.1 och logs.txt (de senaste RING_SIZE posterna, den äldre
   * filen bara när den nyare inte räcker). Ett ogiltigt id ger undefined.
   */
  function ringOf(appId: string): Entry[] | undefined {
    if (typeof appId !== 'string' || !APP_ID_RE.test(appId)) return undefined;
    let ring = rings.get(appId);
    if (ring) return ring;
    ring = [];
    try {
      const file = path.join(paths.appDataDir(appId), 'logs.txt');
      for (const f of [file, `${file}.1`]) {
        if (ring.length >= RING_SIZE) break;
        let text: string;
        try {
          text = fs.readFileSync(f, 'utf8');
        } catch {
          continue; // finns inte (ingen logg ännu, eller aldrig roterad)
        }
        ring.unshift(...parseLogFile(text).slice(-(RING_SIZE - ring.length)));
      }
    } catch (err) {
      console.warn(`[logs] kunde inte läsa loggen för ${appId}: ${String(err)}`);
    }
    rings.set(appId, ring);
    return ring;
  }

  /** Lägg till raderna i logs.txt. Filen blir aldrig större än 1 MB: den roteras mellan två rader. */
  async function writeLines(appId: string, lines: string[]): Promise<void> {
    if (!fs.existsSync(paths.appDir(appId))) return; // borttagen app: skapa ingenting på nytt
    const dir = paths.appDataDir(appId);
    const file = path.join(dir, 'logs.txt');
    await fs.promises.mkdir(dir, { recursive: true });
    let size = sizes.get(appId);
    if (size === undefined) size = await fs.promises.stat(file).then((s) => s.size, () => 0);
    let buf = '';
    let bufBytes = 0;
    for (const line of lines) {
      const bytes = Buffer.byteLength(line);
      if (size + bufBytes > 0 && size + bufBytes + bytes > ROTATE_BYTES) {
        if (buf) await fs.promises.appendFile(file, buf, { mode: 0o600 });
        await fs.promises.rename(file, `${file}.1`).catch(() => {});
        size = 0;
        buf = '';
        bufBytes = 0;
      }
      buf += line;
      bufBytes += bytes;
    }
    if (buf) await fs.promises.appendFile(file, buf, { mode: 0o600 });
    sizes.set(appId, size + bufBytes);
  }

  function flushAll(): Promise<void> {
    const batch = pending;
    pending = new Map();
    chain = chain.then(async () => {
      for (const [appId, lines] of batch) {
        try {
          await writeLines(appId, lines);
        } catch (err) {
          sizes.delete(appId); // läs om storleken nästa gång
          console.warn(`[logs] kunde inte skriva loggen för ${appId}: ${String(err)}`);
        }
      }
    });
    return chain;
  }

  function schedule(): void {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      void flushAll();
    }, FLUSH_MS);
    timer.unref();
  }

  return {
    append(appId, source, line) {
      if (typeof appId !== 'string' || !APP_ID_RE.test(appId)) return;
      const text = cleanLogText(line);
      if (!text) return;
      const e: Entry = { at: Date.now(), source: SOURCES.includes(source) ? source : 'workbench', text };
      const ring = ringOf(appId) ?? [];
      ring.push(e);
      if (ring.length > RING_SIZE + RING_SIZE / 4) ring.splice(0, ring.length - RING_SIZE); // trimma i klump
      let lines = pending.get(appId);
      if (!lines) pending.set(appId, (lines = []));
      lines.push(fileLine(e));
      schedule();
    },

    tail(appId, n = 80) {
      const ring = ringOf(appId);
      if (!ring) return [];
      const k = Math.min(RING_SIZE, Math.max(0, Number.isFinite(n) ? Math.floor(n) : 80));
      if (k === 0) return [];
      return ring.slice(-k).map(formatLogLine);
    },

    clear(appId) {
      // En tom ring, inte ingen: annars läste nästa tail in den borttagna appens fil igen.
      if (typeof appId === 'string' && APP_ID_RE.test(appId)) rings.set(appId, []);
      pending.delete(appId);
      sizes.delete(appId);
    },

    /** Skriv det som väntar till disk nu (för avslut och tester). */
    flush() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      return flushAll();
    },
  };
}
