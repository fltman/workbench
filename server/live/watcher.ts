// server/live/watcher.ts — bevakaren (CONTRACT §7.3): manuella ändringar i en app laddar om den.
//
// - fs.watch(apps/<id>, { recursive: true }) per app, debouncat 200 ms per app.
// - Ignorerar node_modules/ (var som helst), data/ (första segmentet), .git/, .DS_Store och tillfälliga filer från
//   atomiska skrivningar (<namn>.tmp.<pid>.<hex>). På macOS är händelsetypen alltid 'rename', så den används inte.
// - Gör ingenting medan sessions.busy(appId): varken när händelsen kommer eller när debouncen löser ut. Claudes egna
//   ändringar laddas om när turen är klar (§8.6), inte här.
// - Annars registry.refresh(appId) och sedan registry.bumpRev(appId).
// - Vilka appar som bevakas följer registry.list(), som läses om varje sekund: appar som skapas under körningen
//   börjar bevakas inom en sekund och borttagna slutar bevakas. (Registret är källan; nya mappar under apps/
//   registreras bara vid start, §7.3.) En bevakning som får fel stängs och startas om vid nästa avläsning.
// - Händelser om appmappen själv (Node rapporterar dem med mappens eget namn, t.ex. när den skapas eller flyttas
//   till papperskorgen) ignoreras; det är registrets sak. FSEvents levererar också händelser från strax före
//   start (uppmätt: mappens skapande och filerna som create() nyss skrev, ~12 ms efter start). Under bevakningens
//   första sekund ignoreras därför händelser för filer vars mtime och ctime båda är äldre än starten.
// - Ändringar som git självt gör (ångra = reset --hard, se gitRewritingWorkTree i git.ts) är inga manuella
//   ändringar: ångra-flödet (§7.4) laddar om appen själv, efter en eventuell omstart av backenden. Utan det här
//   skulle bevakaren ladda om en gång till, och för en app med backend medan backenden startar om.
// - Inga handtag håller processen vid liv (persistent: false och unref), och funktionen som returneras stänger allt.
import fs from 'node:fs';
import path from 'node:path';
import type { AppRegistry, Paths, Sessions } from '../types.ts';
import { gitRewritingWorkTree } from './git.ts';

const DEBOUNCE_MS = 200;
const SYNC_MS = 1000;
const STALE_WINDOW_MS = 1000;
const TMP_FILE_RE = /\.tmp\.\d+\.[0-9a-f]+$/i;

/** Ska en händelse för den här sökvägen (relativ appens mapp) ignoreras? */
export function isIgnoredPath(rel: string): boolean {
  const segs = rel.split(/[\\/]+/).filter(Boolean);
  if (segs.length === 0) return false;
  const lower = segs.map((s) => s.toLowerCase());
  if (lower[0] === 'data') return true;
  if (lower.includes('node_modules') || lower.includes('.git')) return true;
  const base = segs[segs.length - 1];
  return base === '.DS_Store' || TMP_FILE_RE.test(base);
}

interface Watch {
  watcher: fs.FSWatcher;
  dir: string;
  startedAt: number;
  timer: ReturnType<typeof setTimeout> | null;
}

/** En händelse om den bevakade mappen själv: Node ger då mappens eget namn, och det finns ingen sådan fil i den. */
function isRootEvent(w: Watch, rel: string): boolean {
  return rel === path.basename(w.dir) && !fs.existsSync(path.join(w.dir, rel));
}

/** En händelse från före starten, levererad i efterhand av FSEvents. Försvunna filer räknas alltid som riktiga. */
function isStale(w: Watch, rel: string): boolean {
  if (Date.now() - w.startedAt > STALE_WINDOW_MS) return false;
  // Date.now() avrundar nedåt till hela ms medan mtimeMs har bråkdelar: den verkliga starten ligger i
  // [startedAt, startedAt + 1), så en fil som skrevs samma millisekund före starten jämförs mot startedAt + 1.
  const start = w.startedAt + 1;
  try {
    const st = fs.lstatSync(path.join(w.dir, rel));
    return st.mtimeMs < start && st.ctimeMs < start;
  } catch {
    return false;
  }
}

export function watchApps(deps: { paths: Paths; registry: AppRegistry; sessions: Pick<Sessions, 'busy'> }): () => void {
  const { paths, registry, sessions } = deps;
  const watches = new Map<string, Watch>();
  let stopped = false;

  function busy(appId: string): boolean {
    try {
      return sessions.busy(appId);
    } catch {
      return true; // osäkert läge: rör inget
    }
  }

  function fire(appId: string): void {
    const w = watches.get(appId);
    if (w) w.timer = null;
    if (stopped || !registry.get(appId) || busy(appId)) return;
    try {
      registry.refresh(appId);
      registry.bumpRev(appId);
    } catch (err) {
      console.warn(`[watcher] ${appId}: ${String(err)}`);
    }
  }

  function onEvent(appId: string, name: string | Buffer | null): void {
    if (stopped) return;
    const w = watches.get(appId);
    if (!w) return;
    if (name !== null) {
      const rel = String(name);
      if (isIgnoredPath(rel) || isRootEvent(w, rel) || isStale(w, rel)) return;
    }
    if (gitRewritingWorkTree(w.dir) || busy(appId)) return;
    if (w.timer) clearTimeout(w.timer);
    w.timer = setTimeout(() => fire(appId), DEBOUNCE_MS);
    w.timer.unref();
  }

  function close(appId: string): void {
    const w = watches.get(appId);
    if (!w) return;
    watches.delete(appId);
    if (w.timer) clearTimeout(w.timer);
    try {
      w.watcher.close();
    } catch {
      // redan stängd
    }
  }

  function open(appId: string): void {
    let dir: string;
    try {
      dir = paths.appDir(appId);
      if (!fs.lstatSync(dir).isDirectory()) return;
    } catch {
      return; // ogiltigt id eller ingen mapp (än): försöks igen vid nästa avläsning
    }
    const startedAt = Date.now();
    let watcher: fs.FSWatcher;
    try {
      watcher = fs.watch(dir, { recursive: true, persistent: false }, (_type, name) => onEvent(appId, name));
    } catch (err) {
      console.warn(`[watcher] kunde inte bevaka ${appId}: ${String(err)}`);
      return;
    }
    watcher.on('error', () => close(appId));
    watches.set(appId, { watcher, dir, startedAt, timer: null });
  }

  function sync(): void {
    if (stopped) return;
    let ids: Set<string>;
    try {
      ids = new Set(registry.list().map((a) => a.id));
    } catch (err) {
      console.warn(`[watcher] kunde inte läsa registret: ${String(err)}`);
      return;
    }
    for (const appId of [...watches.keys()]) if (!ids.has(appId)) close(appId);
    for (const appId of ids) if (!watches.has(appId)) open(appId);
  }

  sync();
  const interval = setInterval(sync, SYNC_MS);
  interval.unref();

  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(interval);
    for (const appId of [...watches.keys()]) close(appId);
  };
}
