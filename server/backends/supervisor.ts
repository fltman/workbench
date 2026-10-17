// server/backends/supervisor.ts — en nodeprocess per app med backend, bakom proxyn på /api/* (CONTRACT §9).
//
// Start:   [sandbox-exec -f <profil>] node --import=<guard.mjs> -- <entry>, med argv och utan skal.
//          cwd = appens mapp, env = childEnv({ PORT, HOST, DATA_DIR, APP_ID, NODE_ENV, TMPDIR, NODE_OPTIONS }).
// Redo:    porten svarar på TCP inom 8 s. Sedan lsof, och igen var 30:e sekund medan den kör: lyssnar något
//          i processgruppen på annat än loopback stoppas backenden.
// Krasch:  omstart efter 1, 2 och 4 s, högst 3 gånger per 60 s; därefter 'crashed' till restart() eller tills koden ändras.
// Stopp:   SIGTERM till processgruppen, SIGKILL efter 2 s.
// Tomgång: ingen förfrågan på idleMs (standard 10 min) ger ett vanligt stopp, och nästa förfrågan startar backenden
//          igen. Pågående förfrågningar och uppgraderade socketar räknas (hold), så WebSocket och SSE håller den vid liv.
// Färskhet: har ingångsfilen, appens package.json eller entry i manifestet ändrats sedan start startar ensure() om
//          backenden innan porten lämnas ut, så att ingen provar gammal kod.
//
// Varje backend startas som ledare för en egen processgrupp (detached), så att stopp och lsof
// också når processer som backenden själv startat. Livscykeln per app körs i en kö, så att
// start, stopp och omstart aldrig går om varandra; stopp och omstart avbryter ändå en pågående
// start direkt i stället för att vänta ut den.
import { execFile, execFileSync, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import type { BackendState } from '../../shared/protocol.ts';
import { childEnv } from '../config.ts';
import type { AppLogs, AppRegistry, Backends, Config, Paths } from '../types.ts';
import { troubleLine } from '../store/registry.ts';
import { buildProfile, closedRoots, isWithin, nodeReadDir } from './sandbox.ts';

/** Inställningar som tester kan ändra. Standardvärdena är kontraktets. */
export interface BackendOptions {
  /** Första porten. Standard 18300. */
  portBase: number;
  /** Antal portar som provas; samma fönster nekas i andra backends sandlådor. Standard 200. */
  portSpan: number;
  /** Standard 8000. */
  readyTimeoutMs: number;
  /** Väntan före omstart nummer 1, 2, 3 inom fönstret. Standard [1000, 2000, 4000]. */
  restartDelaysMs: number[];
  /** Standard 60 000. */
  restartWindowMs: number;
  /**
   * Supervisorn har gett upp (§9): orsaken och backendens sista rader, en gång per uppgivande. main.ts gör det till
   * en not i HUD:en (sessions.note). Standard: ingenting.
   */
  onCrashed: (appId: string, text: string) => void;
  /** Tid mellan SIGTERM och SIGKILL. Standard 2000. */
  killGraceMs: number;
  sandboxExec: string;
  lsof: string;
  /** Node att köra backenden med. Standard process.execPath. */
  nodePath: string;
  /** lsof-kontrollen körs om med det här mellanrummet medan backenden kör; 0 = bara efter redo. Standard 30 000. */
  listenCheckMs: number;
  /** Så länge utan förfrågningar innan en backend stoppas; 0 = aldrig. Standard 600 000 (WORKBENCH_BACKEND_IDLE_MS). */
  idleMs: number;
  /** Högst så många rader per sekund och app till loggen; resten räknas och nämns. Standard 200. */
  logLinesPerSecond: number;
  /**
   * Pausa backendens stdout/stderr när sekundens rader är slut och fortsätt vid nästa sekund (ROB-5), så att
   * röret ger mottryck i stället för att servern läser och delar miljontals rader bara för att släppa dem.
   * Standard true; false bara i testernas kalibrering.
   */
  backpressure: boolean;
}

export const DEFAULT_OPTIONS: BackendOptions = {
  portBase: 18300,
  portSpan: 200,
  readyTimeoutMs: 8000,
  restartDelaysMs: [1000, 2000, 4000],
  restartWindowMs: 60_000,
  onCrashed: () => {},
  killGraceMs: 2000,
  sandboxExec: '/usr/bin/sandbox-exec',
  lsof: '/usr/sbin/lsof',
  nodePath: process.execPath,
  listenCheckMs: 30_000,
  idleMs: 600_000,
  logLinesPerSecond: 200,
  backpressure: true,
};

/** Det längsta setTimeout klarar; ett längre värde blir 1 ms i Node (TimeoutOverflowWarning). */
const MAX_TIMEOUT_MS = 2_147_483_647;

/** WORKBENCH_BACKEND_IDLE_MS (§3) som idleMs: ett heltal ≥ 0 (0 = aldrig, högst MAX_TIMEOUT_MS), annars standardvärdet. */
export function backendIdleMs(value: string | undefined): number {
  const n = value === undefined || value.trim() === '' ? Number.NaN : Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.min(Math.floor(n), MAX_TIMEOUT_MS) : DEFAULT_OPTIONS.idleMs;
}

/** Backends med räkningen som tomgångsstoppet behöver (§9); server-http anropar hold kring varje proxad förfrågan. */
export interface BackendsEx extends Backends {
  /** En förfrågan eller uppgraderad socket mot appens backend börjar; anropa det som returneras när den stängs. */
  hold(appId: string): () => void;
}

const MAX_LINE = 8000;
/** Så många gånger sekundens tak får släppas innan strömmen pausas resten av sekunden (ROB-5). */
const FLOOD_FACTOR = 10;
/** onCrashed (§9): så många rader sparas per start, så många skickas med, högst så långa. */
const RECENT_LINES = 40;
const CRASH_LINES = 3;
const CRASH_LINE_MAX = 200;
/** Så länge väntar onCrashed på att den kraschade processens stdout och stderr stängs. */
const DRAIN_WAIT_MS = 1000;
const noop = (): void => {};

type KillReason = 'stop' | 'timeout' | 'exposed' | 'foreign';

interface Proc {
  child: ChildProcess;
  pid: number;
  port: number;
  alive: boolean;
  exited: Promise<void>;
  markExited: () => void;
  reason: KillReason | null;
  killTimer: NodeJS.Timeout | null;
  /** Nästa lsof-kontroll medan processen kör. */
  listenTimer: NodeJS.Timeout | null;
  /** Koden processen startades med: ingångsfilen och package.json (codeStamp). */
  appReal: string;
  entryReal: string;
  stamp: string;
  /** Sista stderr-raden som börjar med ett felnamn: lämnas till registret om processen kraschar (felsignalen, §7.2). */
  lastError: string | null;
}

interface Entry {
  id: string;
  state: BackendState;
  port: number | null;
  proc: Proc | null;
  /** Kö för start, stopp och omstart. */
  queue: Promise<void>;
  /** Pågående eller köad start; ensure() ansluter till den. */
  starting: Promise<number | null> | null;
  /** Köad omstart som inte börjat; ett andra restart() ansluter till den. */
  restartQueued: Promise<number | null> | null;
  retry: { timer: NodeJS.Timeout; done: Promise<number | null>; resolve: (port: number | null) => void } | null;
  /** Tidpunkter för automatiska omstarter inom fönstret. */
  restarts: number[];
  /** Kraschat för ofta eller går inte att starta: 'crashed' tills restart(), eller tills koden ändras (tried). */
  gaveUp: boolean;
  /** Koden det senaste startförsöket gjordes med (sourceStamp): en uppgiven backend startas igen när den ändras. */
  tried: string | null;
  /** Raderna från den senaste starten (högst RECENT_LINES), för onCrashed. */
  recent: string[];
  /** Den senaste processens stdout och stderr är stängda (de sista raderna kan komma efter 'exit'). */
  drained: Promise<void>;
  /** Ska backenden köra? false efter stop(). */
  wanted: boolean;
  /** Pågående uttryckliga stop() (deleteApp): då startar ensure() ingen ny process. Tomgångsstoppet räknas inte. */
  stopping: number;
  lines: { windowStart: number; count: number; dropped: number; timer: NodeJS.Timeout | null; paused: Readable[] };
  lsofWarned: boolean;
  /** Pågående förfrågningar och uppgraderade socketar (hold). */
  inflight: number;
  idleTimer: NodeJS.Timeout | null;
}

type ListenCheck = { kind: 'ok' } | { kind: 'exposed'; names: string[] } | { kind: 'foreign' } | null;

/** Är adressen i en lsof-rad ("127.0.0.1:18300", "[::1]:18300", "*:18300") loopback? */
export function isLoopbackListener(name: string): boolean {
  const colon = name.lastIndexOf(':');
  let host = colon >= 0 ? name.slice(0, colon) : name;
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  return host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host) || /^::ffff:127\.\d+\.\d+\.\d+$/i.test(host);
}

/** Tolkar `lsof -F pn`: en rad per fält, p = pid, n = namn. */
export function parseLsof(out: string): { pid: number; name: string }[] {
  const rows: { pid: number; name: string }[] = [];
  let pid = 0;
  for (const line of out.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n')) rows.push({ pid, name: line.slice(1) });
  }
  return rows;
}

function seconds(ms: number): string {
  return String(ms / 1000).replace('.', ',') + ' s';
}

/** Som seconds, men i minuter från en minut ("10 min" i stället för "600 s"). */
export function duration(ms: number): string {
  return ms < 60_000 ? seconds(ms) : String(Math.round(ms / 6000) / 10).replace('.', ',') + ' min';
}

/** backend.entry enligt sökvägsreglerna i §4.6. Returnerar den absoluta realpathen eller kastar med orsaken. */
export async function resolveEntry(appReal: string, entry: unknown): Promise<string> {
  const shown = JSON.stringify(entry);
  if (typeof entry !== 'string' || entry === '' || entry.includes('\0')) throw new Error(`ogiltig backend.entry ${shown}`);
  if (entry.startsWith('-')) throw new Error(`backend.entry får inte börja med "-": ${shown}`);
  if (path.isAbsolute(entry)) throw new Error(`backend.entry ska vara relativ till appens mapp: ${shown}`);
  let real: string;
  try {
    real = await fs.promises.realpath(path.join(appReal, entry));
  } catch {
    throw new Error(`backend.entry finns inte: ${shown}`);
  }
  const rel = path.relative(appReal, real);
  if (rel === '' || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
    throw new Error(`backend.entry pekar ut ur appens mapp: ${shown}`);
  }
  const segments = rel.split(path.sep).map((s) => s.toLowerCase());
  if (segments.some((s) => s.startsWith('.')) || segments[0] === 'data' || segments[0] === 'node_modules') {
    throw new Error(`backend.entry får inte ligga i en dold mapp, data/ eller node_modules/: ${shown}`);
  }
  const st = await fs.promises.stat(real);
  if (!st.isFile()) throw new Error(`backend.entry är ingen fil: ${shown}`);
  return real;
}

/** Koden en backend startas med: entry i manifestet, ingångsfilen och appens package.json (mtime och storlek). */
async function codeStamp(appReal: string, entry: unknown, entryReal: string): Promise<string> {
  const stat = async (p: string): Promise<string> => {
    try {
      const st = await fs.promises.stat(p);
      return `${st.mtimeMs}:${st.size}`;
    } catch {
      return '-';
    }
  };
  return JSON.stringify([entry, entryReal, await stat(entryReal), await stat(path.join(appReal, 'package.json'))]);
}

/** apps/<id>/data: skapas om den saknas, och vägras om den är en symbolisk länk eller ingen katalog. */
export async function prepareDataDir(appReal: string): Promise<string> {
  const dir = path.join(appReal, 'data');
  const check = async (): Promise<void> => {
    const st = await fs.promises.lstat(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('data/ är en symbolisk länk eller ingen katalog');
  };
  try {
    await check();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    try {
      await fs.promises.mkdir(dir, { mode: 0o700 });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    await check();
  }
  return dir;
}

/**
 * Backendens egen TMPDIR, apps/<id>/data/tmp (0700, SEC-3): den delade TMPDIR:en är stängd i profilen.
 * Ligger i data/, så den serveras aldrig, versioneras aldrig och följer med appen till papperskorgen.
 */
export async function prepareTmpDir(dataDir: string): Promise<string> {
  const dir = path.join(dataDir, 'tmp');
  try {
    await fs.promises.mkdir(dir, { mode: 0o700 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
  const st = await fs.promises.lstat(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('data/tmp är en symbolisk länk eller ingen katalog');
  return dir;
}

/** Innehållet i apps/package.json: inget "type", så appar utan egen package.json tolkas som om ingen fanns. */
const PACKAGE_SCOPE = '{ "description": "Workbench: gränsen för Nodes paketuppslag, så att apparna inte tolkas efter workbenchens package.json (CONTRACT §9)." }\n';

/**
 * apps/package.json, gränsen för Nodes paketuppslag (§9): skapas om den saknas och lämnas annars orörd. Utan den letar
 * Node uppåt från appens mapp till workbenchens package.json. Under sandlådan nekas läsningen, vilket Node 24 inte tål,
 * och utan sandlåda skulle workbenchens "type": "module" avgöra apparnas modulformat. Ett fel här stoppar ingen start.
 */
export async function preparePackageScope(appsReal: string): Promise<string> {
  const file = path.join(appsReal, 'package.json');
  try {
    await fs.promises.writeFile(file, PACKAGE_SCOPE, { flag: 'wx', mode: 0o644 });
  } catch {
    // finns redan, eller apps/ är inte skrivbar: Node 25 klarar sig utan
  }
  return file;
}

/**
 * Användarens katalog under /private/var/folders/<a>/<b> (realpath), eller null: föräldern till TMPDIR (T) och dess
 * grannar C (DARWIN_USER_CACHE_DIR, andra programs cacher) och 0 (DARWIN_USER_DIR). Ur getconf, som inte går efter
 * miljöns TMPDIR; annars föräldern till en TMPDIR som heter T. Bara en katalog med just den formen godtas.
 */
export function darwinUserRoot(): string | null {
  let dir = '';
  try {
    dir = execFileSync('/usr/bin/getconf', ['DARWIN_USER_DIR'], { encoding: 'utf8', env: childEnv(), timeout: 2000 }).trim();
  } catch {
    /* inte macOS, eller ingen getconf */
  }
  try {
    const real = fs.realpathSync.native(dir ? dir.replace(/\/+$/, '') : os.tmpdir());
    const parent = path.dirname(real);
    if (!dir && path.basename(real) !== 'T') return null;
    return /^\/private\/var\/folders\/[^/]+\/[^/]+$/.test(parent) ? parent : null;
  } catch {
    return null;
  }
}

/**
 * De delade tillfälliga katalogerna som stängs i profilen (realpath, de som finns): användarens katalog under
 * /private/var/folders (darwinUserRoot, med TMPDIR, cacherna och DARWIN_USER_DIR), TMPDIR om den ligger någon annanstans,
 * /tmp och /var/tmp.
 */
export function sharedTmpDirs(): string[] {
  const out = new Set<string>();
  const user = darwinUserRoot();
  if (user) out.add(user);
  for (const p of [os.tmpdir(), '/tmp', '/var/tmp']) {
    try {
      const real = fs.realpathSync.native(p);
      if (!user || !isWithin(real, user)) out.add(real);
    } catch {
      /* finns inte */
    }
  }
  return [...out];
}

/**
 * Det som profilen spärrar för skrivning men inte läsning (realpath, det som finns): Node-prefixet (nodeReadDir), katalogen
 * som nodePath ligger i (för Homebrew /opt/homebrew/bin med länken som npm run dev kör), workbenchens repo (server/,
 * node_modules/ och guard.mjs körs osandlådat, också när repot ligger utanför $HOME), Homebrew, /Users/Shared, /Volumes,
 * /Applications, /Library och /cores. De tre sista har kataloger som admin-gruppen eller alla kan skriva i: ett typsnitt i
 * /Library/Fonts laddas av alla program, och /Library/Caches och /cores överlever appen.
 */
export function writeDeniedDirs(nodePath: string, nodeDir: string, root: string): string[] {
  const out = new Set<string>([nodeDir]);
  for (const p of [path.dirname(nodePath), root, '/opt/homebrew', '/usr/local', '/Users/Shared', '/Volumes', '/Applications', '/Library', '/cores']) {
    try {
      out.add(fs.realpathSync.native(p));
    } catch {
      /* finns inte */
    }
  }
  return [...out];
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

function realHome(): string {
  let home: string;
  try {
    home = os.userInfo().homedir; // passwd-posten: HOME i miljön kan vara ändrad
  } catch {
    home = os.homedir();
  }
  return fs.realpathSync.native(home);
}

export function createBackends(
  deps: { config: Config; paths: Paths; registry: AppRegistry; logs: AppLogs },
  options: Partial<BackendOptions> = {},
): BackendsEx {
  const { config, paths, registry, logs } = deps;
  const opt: BackendOptions = { ...DEFAULT_OPTIONS, ...options };
  const guardFile = path.join(config.root, 'server', 'backends', 'guard.mjs');
  const entries = new Map<string, Entry>();
  let allocating: Promise<unknown> = Promise.resolve();
  let closed = false;
  // Beräknas vid första sandlådade start.
  let sandboxBase: { home: string; sharedTmp: string[]; guardReal: string; nodeDir: string; writeDenied: string[] } | null = null;

  /* ---------------------------- hjälpare ---------------------------- */

  function note(e: Entry, text: string): void {
    try {
      logs.append(e.id, 'workbench', text);
    } catch {
      // appen kan ha tagits bort
    }
  }

  function setState(e: Entry, state: BackendState): void {
    if (e.state === state) return;
    e.state = state;
    try {
      registry.setBackend(e.id, state);
    } catch {
      // appen kan ha tagits bort
    }
  }

  /** backend.entry ur manifestet; null om appen saknar backend (eller inte finns). */
  function manifestEntry(id: string): unknown | null {
    try {
      const backend = registry.manifest(id)?.backend;
      if (!backend) return null;
      return (backend as { entry?: unknown }).entry ?? '';
    } catch {
      return null;
    }
  }

  function entryFor(id: string): Entry {
    let e = entries.get(id);
    if (!e) {
      paths.appDir(id); // kastar för ogiltiga id
      e = {
        id,
        state: manifestEntry(id) === null ? 'none' : 'stopped',
        port: null,
        proc: null,
        queue: Promise.resolve(),
        starting: null,
        restartQueued: null,
        retry: null,
        restarts: [],
        gaveUp: false,
        tried: null,
        recent: [],
        drained: Promise.resolve(),
        wanted: false,
        stopping: 0,
        lines: { windowStart: 0, count: 0, dropped: 0, timer: null, paused: [] },
        lsofWarned: false,
        inflight: 0,
        idleTimer: null,
      };
      entries.set(id, e);
    }
    return e;
  }

  function enqueue<T>(e: Entry, fn: () => Promise<T>): Promise<T> {
    const run = e.queue.then(fn);
    e.queue = run.then(noop, noop);
    return run;
  }

  function flushDropped(e: Entry): void {
    const l = e.lines;
    if (l.timer) {
      clearTimeout(l.timer);
      l.timer = null;
    }
    // En ny sekund: pausade strömmar läses igen (ROB-5).
    for (const st of l.paused.splice(0)) st.resume();
    if (l.dropped > 0) {
      note(e, `${l.dropped} rader från backenden hoppades över (högst ${opt.logLinesPerSecond} per sekund).`);
      l.dropped = 0;
    }
  }

  function logLine(e: Entry, raw: string): void {
    // Kontrolltecken (även CR) bort; tabbar behålls. Tomma rader bär ingen information.
    const line = raw.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
    if (!line) return;
    const l = e.lines;
    const now = Date.now();
    if (now - l.windowStart >= 1000) {
      flushDropped(e);
      l.windowStart = now;
      l.count = 0;
    }
    if (l.count < opt.logLinesPerSecond) {
      l.count++;
      e.recent.push(line);
      if (e.recent.length > RECENT_LINES) e.recent.shift();
      try {
        logs.append(e.id, 'backend', line);
      } catch {
        // appen kan ha tagits bort
      }
      return;
    }
    l.dropped++;
    if (!l.timer) {
      l.timer = setTimeout(() => {
        l.timer = null;
        flushDropped(e);
      }, 1000);
      l.timer.unref();
    }
  }

  /** stdout/stderr radvis till loggen; rader längre än MAX_LINE delas. Med proc (stderr) minns den sista felraden. */
  function readLines(e: Entry, stream: Readable | null, proc?: Proc): void {
    if (!stream) return;
    stream.setEncoding('utf8');
    let buf = '';
    const emit = (line: string): void => {
      if (proc && troubleLine('stderr', line)) proc.lastError = line;
      for (let i = 0; i < line.length; i += MAX_LINE) logLine(e, line.slice(i, i + MAX_LINE));
    };
    stream.on('data', (chunk: string) => {
      buf += chunk;
      const parts = buf.split('\n');
      buf = parts.pop() ?? '';
      for (const p of parts) emit(p);
      // en rad utan slut växer inte obegränsat
      while (buf.length > MAX_LINE) {
        logLine(e, buf.slice(0, MAX_LINE));
        buf = buf.slice(MAX_LINE);
      }
      // En flod (tio gånger sekundens tak redan släppt): pausa tills nästa sekund, så att röret bromsar
      // backenden (ROB-5). Vanliga skurar släpps som förut, så att loggen inte släpar efter.
      const l = e.lines;
      if (opt.backpressure && l.dropped >= opt.logLinesPerSecond * FLOOD_FACTOR && !stream.isPaused()) {
        stream.pause();
        l.paused.push(stream);
        if (!l.timer) {
          l.timer = setTimeout(() => {
            l.timer = null;
            flushDropped(e);
          }, Math.max(1, l.windowStart + 1000 - Date.now()));
          l.timer.unref();
        }
      }
    });
    stream.on('end', () => {
      emit(buf);
      buf = '';
    });
    stream.on('error', noop);
  }

  function signalGroup(proc: Proc, signal: NodeJS.Signals): void {
    try {
      process.kill(-proc.pid, signal);
    } catch {
      try {
        if (proc.alive) proc.child.kill(signal);
      } catch {
        // redan borta
      }
    }
  }

  /** SIGTERM till hela gruppen nu, SIGKILL efter grace. Väntar inte. */
  function terminate(proc: Proc, reason: KillReason, graceMs = opt.killGraceMs): void {
    if (!proc.alive) return;
    proc.reason ??= reason;
    if (proc.killTimer) return;
    if (graceMs <= 0) {
      signalGroup(proc, 'SIGKILL');
      return;
    }
    signalGroup(proc, 'SIGTERM');
    proc.killTimer = setTimeout(() => signalGroup(proc, 'SIGKILL'), graceMs);
  }

  function cancelRetry(e: Entry): void {
    if (!e.retry) return;
    clearTimeout(e.retry.timer);
    e.retry.resolve(null);
    e.retry = null;
  }

  /** Stoppa det som kör, och en pågående start, direkt (utanför kön). */
  function preempt(e: Entry): void {
    e.wanted = false;
    cancelRetry(e);
    clearIdle(e);
    if (e.proc) terminate(e.proc, 'stop');
  }

  function clearIdle(e: Entry): void {
    if (!e.idleTimer) return;
    clearTimeout(e.idleTimer);
    e.idleTimer = null;
  }

  /** Tomgångsstoppet: körs backenden utan pågående förfrågningar stoppas den efter idleMs, på vanligt sätt. */
  function armIdle(e: Entry): void {
    clearIdle(e);
    const proc = e.proc;
    if (opt.idleMs <= 0 || closed || e.inflight > 0 || !e.wanted || e.state !== 'running' || !proc?.alive) return;
    e.idleTimer = setTimeout(() => {
      e.idleTimer = null;
      if (closed || e.inflight > 0 || e.proc !== proc || !proc.alive || !e.wanted || e.state !== 'running' || e.starting) return;
      note(e, `Backenden stoppades efter ${duration(opt.idleMs)} utan förfrågningar; nästa förfrågan startar den igen.`);
      void stopEntry(e);
    }, opt.idleMs);
    e.idleTimer.unref();
  }

  async function stopRunning(e: Entry): Promise<void> {
    const proc = e.proc;
    if (!proc) return;
    terminate(proc, 'stop');
    await proc.exited;
  }

  /* ---------------------------- start ---------------------------- */

  function allocatePort(e: Entry): Promise<number | null> {
    const run = allocating.then(async () => {
      const taken = new Set<number>();
      for (const other of entries.values()) {
        if (other !== e && other.port !== null && (other.proc || other.starting || other.retry)) taken.add(other.port);
      }
      const end = opt.portBase + opt.portSpan;
      const candidates: number[] = [];
      if (e.port !== null && e.port >= opt.portBase && e.port < end) candidates.push(e.port);
      for (let p = opt.portBase; p < end; p++) if (p !== e.port) candidates.push(p);
      for (const p of candidates) {
        if (taken.has(p) || p === config.port || p === config.hmrPort) continue;
        if (await portFree(p)) {
          e.port = p;
          return p;
        }
      }
      return null;
    });
    allocating = run.then(noop, noop);
    return run;
  }

  async function writeProfile(e: Entry, appReal: string, port: number, tmpDir: string, packageScope: string): Promise<string> {
    if (!sandboxBase) {
      const home = realHome();
      const nodeDir = nodeReadDir(opt.nodePath, closedRoots(home, config.home));
      sandboxBase = {
        home,
        sharedTmp: sharedTmpDirs(),
        guardReal: fs.realpathSync.native(guardFile),
        nodeDir,
        writeDenied: writeDeniedDirs(opt.nodePath, nodeDir, config.root),
      };
    }
    const others: number[] = [];
    for (let p = opt.portBase; p < opt.portBase + opt.portSpan; p++) if (p !== port) others.push(p);
    const profile = buildProfile({
      home: sandboxBase.home,
      workbenchHome: config.home,
      appDir: appReal,
      tmpDir,
      sharedTmp: sandboxBase.sharedTmp,
      guardFile: sandboxBase.guardReal,
      nodeDir: sandboxBase.nodeDir,
      writeDenied: sandboxBase.writeDenied,
      packageScope,
      deniedPorts: [config.port, config.hmrPort, ...others],
    });
    const dir = paths.appDataDir(e.id);
    await fs.promises.mkdir(dir, { recursive: true });
    const file = path.join(dir, 'backend.sb');
    await fs.promises.writeFile(file, profile, { mode: 0o600 });
    return file;
  }

  function waitReady(proc: Proc): Promise<'ready' | 'exited' | 'timeout'> {
    return new Promise((resolve) => {
      let done = false;
      const finish = (r: 'ready' | 'exited' | 'timeout'): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(r);
      };
      const timer = setTimeout(() => finish('timeout'), opt.readyTimeoutMs);
      void proc.exited.then(() => finish('exited'));
      const attempt = (): void => {
        if (done) return;
        const s = net.connect({ host: '127.0.0.1', port: proc.port });
        s.on('connect', () => {
          s.destroy();
          finish(proc.alive ? 'ready' : 'exited');
        });
        s.on('error', () => {
          s.destroy();
          if (!done) setTimeout(attempt, 100);
        });
      };
      attempt();
    });
  }

  /** lsof på hela processgruppen. null om lsof inte gick att köra. */
  function checkListeners(proc: Proc): Promise<ListenCheck> {
    return new Promise((resolve) => {
      execFile(
        opt.lsof,
        ['-a', '-g', String(proc.pid), '-iTCP', '-sTCP:LISTEN', '-nP', '-Fpn'],
        { env: childEnv(), timeout: 5000 },
        (err, stdout) => {
          // lsof avslutar med 1 när inget matchar
          if (err && !(err.code === 1 && !String(stdout).trim())) {
            resolve(null);
            return;
          }
          const rows = parseLsof(String(stdout));
          const exposed = rows.filter((r) => !isLoopbackListener(r.name)).map((r) => r.name);
          if (exposed.length) resolve({ kind: 'exposed', names: [...new Set(exposed)] });
          else if (!rows.some((r) => r.name === `127.0.0.1:${proc.port}`)) resolve({ kind: 'foreign' });
          else resolve({ kind: 'ok' });
        },
      );
    });
  }

  /** lsof igen medan backenden kör, så att en lyssnare som öppnas senare (till exempel av ett barn utan vakten) också fångas. */
  function watchListeners(e: Entry, proc: Proc): void {
    if (opt.listenCheckMs <= 0) return;
    proc.listenTimer = setTimeout(() => {
      proc.listenTimer = null;
      const current = (): boolean => proc.alive && e.proc === proc && e.wanted && e.state === 'running';
      if (!current()) return;
      void checkListeners(proc).then((check) => {
        if (!current()) return;
        if (check?.kind === 'exposed') {
          // Samma uppgivna läge som efter redo, så användaren får samma not (onCrashed, §9).
          const reason = `Backenden lyssnade på ${check.names.join(', ')}, inte bara på 127.0.0.1, och stoppades.`;
          note(e, reason);
          e.gaveUp = true;
          terminate(proc, 'exposed', 0);
          setState(e, 'crashed');
          announce(e, reason);
          return;
        }
        watchListeners(e, proc);
      });
    }, opt.listenCheckMs);
    proc.listenTimer.unref();
  }

  function onExit(e: Entry, proc: Proc, code: number | null, signal: NodeJS.Signals | null): void {
    if (!proc.alive) return;
    proc.alive = false;
    if (proc.killTimer) clearTimeout(proc.killTimer);
    if (proc.listenTimer) clearTimeout(proc.listenTimer);
    signalGroup(proc, 'SIGKILL'); // barn som blev kvar i gruppen
    proc.markExited();
    flushDropped(e);
    if (e.proc !== proc) return;
    e.proc = null;
    clearIdle(e);
    if (proc.reason === 'stop' || proc.reason === 'exposed') return; // tillståndet sätts av den som stoppade
    if (proc.reason === null) {
      note(e, code !== null ? `Backenden avslutades med kod ${code}.` : `Backenden avslutades av signalen ${signal}.`);
    }
    if (!e.wanted || closed) return;
    scheduleRestart(e);
  }

  /**
   * Supervisorn har gett upp (§9): orsaken och backendens sista rader från den senaste starten (utan stackrader, Nodes
   * markering ^ under källraden och versionsraden, och med sökvägar relativa appens mapp) till onCrashed, när processens
   * stdout och stderr stängts, eftersom de sista raderna kan komma efter 'exit'. Hann en restart() före görs ingenting.
   */
  function announce(e: Entry, reason: string): void {
    const waited = new Promise<void>((r) => setTimeout(r, DRAIN_WAIT_MS).unref());
    void Promise.race([e.drained, waited]).then(() => {
      if (!e.gaveUp || closed) return;
      let dir = '';
      try {
        dir = fs.realpathSync.native(paths.appDir(e.id));
      } catch {
        // appen kan ha tagits bort
      }
      const relative = (l: string): string => (dir ? l.split(`${pathToFileURL(dir).href}/`).join('').split(`${dir}/`).join('') : l);
      const cut = (l: string): string => {
        const cps = Array.from(l);
        return cps.length > CRASH_LINE_MAX ? cps.slice(0, CRASH_LINE_MAX - 1).join('') + '…' : l;
      };
      const lines = e.recent
        .map((l) => relative(l.trim()))
        .filter((l) => l && !/^at /.test(l) && !/^\^+$/.test(l) && !/^Node\.js v\d/.test(l))
        .slice(-CRASH_LINES)
        .map(cut);
      try {
        opt.onCrashed(e.id, [reason, ...lines].join('\n'));
      } catch {
        // mottagaren får aldrig stoppa supervisorn
      }
    });
  }

  function scheduleRestart(e: Entry): void {
    const now = Date.now();
    e.restarts = e.restarts.filter((t) => now - t < opt.restartWindowMs);
    if (e.restarts.length >= opt.restartDelaysMs.length) {
      e.gaveUp = true;
      setState(e, 'crashed');
      // Användaren läser orsaken i HUD:en (onCrashed, §8.1), så den säger vad som startar backenden igen: Claudes ändring
      // (koden ändras, eller turen slutar) eller Ångra. Förut "förrän appen laddas om", och ingen omladdning gjorde det.
      const reason = `Backenden kraschade ${e.restarts.length + 1} gånger på ${seconds(opt.restartWindowMs)}. Den startar igen när Claude ändrar appen eller när du ångrar.`;
      note(e, reason);
      announce(e, reason);
      return;
    }
    const delay = opt.restartDelaysMs[e.restarts.length];
    e.restarts.push(now);
    setState(e, 'crashed');
    note(e, `Startar om backenden om ${seconds(delay)}.`);
    let resolve: (port: number | null) => void = noop;
    const done = new Promise<number | null>((r) => (resolve = r));
    const timer = setTimeout(() => {
      if (e.retry?.timer !== timer) return;
      e.retry = null;
      startQueued(e).then(resolve, () => resolve(null));
    }, delay);
    e.retry = { timer, done, resolve };
  }

  function giveUp(e: Entry, text: string): null {
    note(e, text);
    e.gaveUp = true;
    setState(e, 'crashed');
    announce(e, text);
    return null;
  }

  /**
   * Koden ett startförsök görs med (§9): entry i manifestet, ingångsfilen och appens package.json (mtime och storlek), utan
   * realpath, så att den går att räkna också när entry är ogiltig eller filen saknas.
   */
  function sourceStamp(id: string, entry: unknown): Promise<string> {
    const dir = paths.appDir(id);
    return codeStamp(dir, entry, typeof entry === 'string' && entry ? path.join(dir, entry) : '');
  }

  /** Själva starten; körs alltid i appens kö. */
  async function start(e: Entry): Promise<number | null> {
    if (closed || !e.wanted) return null;
    e.recent = [];
    const entry = manifestEntry(e.id);
    if (entry === null) {
      setState(e, 'none');
      return null;
    }
    e.tried = await sourceStamp(e.id, entry);
    let appReal: string;
    let appsReal: string;
    let entryReal: string;
    let dataDir: string;
    let tmpDir: string;
    try {
      appReal = await fs.promises.realpath(paths.appDir(e.id));
      appsReal = await fs.promises.realpath(paths.appsDir);
      if (!isWithin(appReal, appsReal)) throw new Error('appens mapp ligger utanför apps/');
      entryReal = await resolveEntry(appReal, entry);
      dataDir = await prepareDataDir(appReal);
      tmpDir = await prepareTmpDir(dataDir);
    } catch (err) {
      return giveUp(e, `Backenden kan inte startas: ${(err as Error).message}.`);
    }
    const stamp = await codeStamp(appReal, entry, entryReal);
    const packageScope = await preparePackageScope(appsReal);
    if (closed || !e.wanted) return null;
    const port = await allocatePort(e);
    if (port === null) return giveUp(e, `Ingen ledig port mellan ${opt.portBase} och ${opt.portBase + opt.portSpan - 1}.`);

    const guardImport = `--import=${pathToFileURL(guardFile).href}`;
    const nodeArgs = [guardImport, '--', entryReal];
    let command = opt.nodePath;
    let args = nodeArgs;
    if (!config.sandbox) {
      note(e, 'Sandlådan är avstängd (WORKBENCH_SANDBOX=0): backenden körs utan sandlåda.');
    } else if (!fs.existsSync(opt.sandboxExec)) {
      note(e, `${opt.sandboxExec} saknas: backenden körs utan sandlåda.`);
    } else {
      try {
        const profile = await writeProfile(e, appReal, port, tmpDir, packageScope);
        command = opt.sandboxExec;
        args = ['-f', profile, opt.nodePath, ...nodeArgs];
      } catch (err) {
        return giveUp(e, `Sandlådeprofilen gick inte att skapa: ${(err as Error).message}.`);
      }
    }
    if (closed || !e.wanted) return null;

    setState(e, 'starting');
    let child: ChildProcess;
    try {
      // NODE_OPTIONS: Node-processer som backenden startar med en bar spawn(node, …) laddar också vakten (fork och
      // worker_threads ärver redan --import). En file:-URL har inga mellanslag, citattecken eller omvända snedstreck
      // (de procentkodas), så den behöver ingen citering, och vakten körs bara en gång fast den importeras två gånger.
      // Varningen för en package.json utan "type" gäller apps/package.json, som appen inte äger (preparePackageScope).
      child = spawn(command, args, {
        cwd: appReal,
        env: childEnv({
          PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, APP_ID: e.id, NODE_ENV: 'development', TMPDIR: tmpDir,
          NODE_OPTIONS: `${guardImport} --disable-warning=MODULE_TYPELESS_PACKAGE_JSON`,
        }),
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });
    } catch (err) {
      return giveUp(e, `Backenden gick inte att starta: ${(err as Error).message}.`);
    }
    if (child.pid === undefined) {
      child.on('error', noop);
      return giveUp(e, `Backenden gick inte att starta (${command}).`);
    }
    let markExited: () => void = noop;
    const exited = new Promise<void>((r) => (markExited = r));
    const proc: Proc = {
      child, pid: child.pid, port, alive: true, exited, markExited, reason: null, killTimer: null, listenTimer: null, appReal, entryReal, stamp,
      lastError: null,
    };
    e.proc = proc;
    e.drained = new Promise<void>((r) => child.once('close', () => r()));
    readLines(e, child.stdout);
    readLines(e, child.stderr, proc);
    child.on('error', (err: NodeJS.ErrnoException) => {
      note(e, `Backendprocessen: ${err.message}`);
      // 'error' kommer också när en signal inte gick fram; bara ett misslyckat spawn betyder att processen är borta.
      if (err.syscall?.startsWith('spawn')) onExit(e, proc, null, null);
    });
    child.on('exit', (code, signal) => onExit(e, proc, code, signal));
    // Felsignalen (§7.2): en backend som avslutas utan att någon bett om det har fått ett ohanterat fel. Ett hanterat fel
    // som loggas med console.error ser likadant ut på stderr och räknas inte. 'close' kommer efter 'exit' och efter
    // strömmarna, så att kraschens felrad hunnit läsas.
    child.on('close', () => {
      if (proc.reason !== null || !proc.lastError) return;
      try {
        registry.noteLog(e.id, 'stderr', proc.lastError);
      } catch {
        // appen kan ha tagits bort
      }
    });

    const ready = await waitReady(proc);
    if (ready === 'exited') return null; // onExit har loggat och vid behov schemalagt en omstart
    if (ready === 'timeout') {
      note(e, `Backenden svarade inte på port ${port} inom ${seconds(opt.readyTimeoutMs)}.`);
      terminate(proc, 'timeout');
      await proc.exited;
      return null;
    }

    const check = await checkListeners(proc);
    if (!proc.alive) return null;
    if (check === null) {
      if (!e.lsofWarned) note(e, `${opt.lsof} gick inte att köra: backendens adresser kontrolleras inte.`);
      e.lsofWarned = true;
    } else if (check.kind === 'exposed') {
      const reason = `Backenden lyssnade på ${check.names.join(', ')}, inte bara på 127.0.0.1, och stoppades.`;
      note(e, reason);
      e.gaveUp = true;
      terminate(proc, 'exposed', 0);
      await proc.exited;
      setState(e, 'crashed');
      announce(e, reason);
      return null;
    } else if (check.kind === 'foreign') {
      note(e, `Port ${port} användes av en annan process.`);
      e.port = null;
      terminate(proc, 'foreign');
      await proc.exited;
      return null;
    }
    if (closed || !e.wanted || !proc.alive) return null;
    setState(e, 'running');
    watchListeners(e, proc);
    armIdle(e);
    return port;
  }

  function startQueued(e: Entry): Promise<number | null> {
    if (e.starting) return e.starting;
    e.wanted = true;
    const run = enqueue(e, () => start(e)).catch((err: unknown) => {
      note(e, `Backenden gick inte att starta: ${(err as Error)?.message ?? String(err)}.`);
      setState(e, 'crashed');
      return null;
    });
    e.starting = run;
    void run.then(() => {
      if (e.starting === run) e.starting = null;
    });
    return run;
  }

  async function stopEntry(e: Entry): Promise<void> {
    preempt(e);
    await enqueue(e, async () => {
      await stopRunning(e);
      e.restarts = [];
      e.gaveUp = false;
      setState(e, manifestEntry(e.id) === null ? 'none' : 'stopped');
    });
  }

  /* ---------------------------- gränssnittet ---------------------------- */

  const api: BackendsEx = {
    async ensure(appId) {
      if (closed) return null;
      const e = entryFor(appId);
      if (manifestEntry(appId) === null) {
        if (e.proc || e.starting || e.retry) await stopEntry(e);
        setState(e, 'none');
        return null;
      }
      const proc = e.proc;
      // wanted: en process som håller på att stoppas (stopp, omstart, tomgång) lämnas inte ut.
      if (proc?.alive && e.state === 'running' && e.wanted) {
        const stale = (await codeStamp(proc.appReal, manifestEntry(appId), proc.entryReal)) !== proc.stamp;
        if (proc.alive && e.proc === proc && e.state === 'running' && e.wanted) {
          if (!stale) {
            armIdle(e); // en förfrågan är aktivitet, även call_backend som inte går genom routern
            return proc.port;
          }
          note(e, 'Backendens kod har ändrats sedan start: startar om.');
          return api.restart(appId);
        }
        if (closed) return null;
      }
      if (e.starting) return e.starting;
      if (e.retry) return e.retry.done;
      if (e.gaveUp) {
        // Uppgiven: startas igen först när koden ändrats sedan det senaste försöket (en rättning för hand eller av Claude
        // mitt i en tur), och då av appens nästa förfrågan eller call_backend. Annars bara av restart().
        const tried = e.tried;
        const now = await sourceStamp(appId, manifestEntry(appId));
        if (closed) return null;
        // Har något hänt under väntan (restart(), ett nytt försök) avgör ensure() på nytt.
        if (e.gaveUp && e.tried === tried) {
          if (tried === null || now === tried) return null;
          e.gaveUp = false;
          e.restarts = [];
          note(e, 'Backendens kod har ändrats sedan den gavs upp: startar igen.');
        }
        return api.ensure(appId);
      }
      // Under ett uttryckligt stopp (deleteApp tar bort appen direkt efter) köas ingen ny start. Under tomgångsstoppet
      // sätts ingen sådan flagga, så där köas en ny start direkt efter stoppet.
      if (e.stopping > 0) return null;
      return startQueued(e);
    },

    async restart(appId) {
      if (closed) return null;
      const e = entryFor(appId);
      if (e.restartQueued) return e.restartQueued;
      preempt(e);
      const run = enqueue(e, async () => {
        e.restartQueued = null;
        await stopRunning(e);
        e.restarts = [];
        e.gaveUp = false;
        if (closed) return null;
        if (manifestEntry(appId) === null) {
          setState(e, 'none');
          return null;
        }
        e.wanted = true;
        return start(e);
      }).catch((err: unknown) => {
        note(e, `Backenden gick inte att starta om: ${(err as Error)?.message ?? String(err)}.`);
        setState(e, 'crashed');
        return null;
      });
      e.restartQueued = run;
      e.starting = run;
      void run.then(() => {
        if (e.starting === run) e.starting = null;
        if (e.restartQueued === run) e.restartQueued = null;
      });
      return run;
    },

    async stop(appId) {
      const e = entries.get(appId);
      if (!e) return;
      e.stopping++;
      try {
        await stopEntry(e);
      } finally {
        e.stopping--;
      }
    },

    async stopAll() {
      closed = true;
      await Promise.all([...entries.values()].map((e) => stopEntry(e)));
    },

    state(appId) {
      const e = entries.get(appId);
      if (e) return e.state;
      return manifestEntry(appId) === null ? 'none' : 'stopped';
    },

    port(appId) {
      const e = entries.get(appId);
      return e && e.state === 'running' && e.proc?.alive ? e.proc.port : null;
    },

    hold(appId) {
      let e: Entry;
      try {
        e = entryFor(appId);
      } catch {
        return noop;
      }
      e.inflight++;
      clearIdle(e);
      let held = true;
      return () => {
        if (!held) return;
        held = false;
        e.inflight--;
        if (e.inflight === 0) armIdle(e);
      };
    },
  };
  return api;
}
