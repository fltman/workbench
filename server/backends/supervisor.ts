// server/backends/supervisor.ts — en nodeprocess per app med backend, bakom proxyn på /api/* (CONTRACT §9).
//
// Start:   [sandbox-exec -f <profil>] node --import=<guard.mjs> -- <entry>, med argv och utan skal.
//          cwd = appens mapp, env = childEnv({ PORT, HOST, DATA_DIR, APP_ID, NODE_ENV }).
// Redo:    porten svarar på TCP inom 8 s. Sedan lsof: lyssnar något i processgruppen på annat än
//          loopback stoppas backenden.
// Krasch:  omstart efter 1, 2 och 4 s, högst 3 gånger per 60 s; därefter 'crashed' till restart().
// Stopp:   SIGTERM till processgruppen, SIGKILL efter 2 s.
//
// Varje backend startas som ledare för en egen processgrupp (detached), så att stopp och lsof
// också når processer som backenden själv startat. Livscykeln per app körs i en kö, så att
// start, stopp och omstart aldrig går om varandra; stopp och omstart avbryter ändå en pågående
// start direkt i stället för att vänta ut den.
import { execFile, spawn } from 'node:child_process';
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
  /** Tid mellan SIGTERM och SIGKILL. Standard 2000. */
  killGraceMs: number;
  sandboxExec: string;
  lsof: string;
  /** Node att köra backenden med. Standard process.execPath. */
  nodePath: string;
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
  killGraceMs: 2000,
  sandboxExec: '/usr/bin/sandbox-exec',
  lsof: '/usr/sbin/lsof',
  nodePath: process.execPath,
  logLinesPerSecond: 200,
  backpressure: true,
};

const MAX_LINE = 8000;
/** Så många gånger sekundens tak får släppas innan strömmen pausas resten av sekunden (ROB-5). */
const FLOOD_FACTOR = 10;
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
  /** Kraschat för ofta eller går inte att starta: 'crashed' tills restart(). */
  gaveUp: boolean;
  /** Ska backenden köra? false efter stop(). */
  wanted: boolean;
  lines: { windowStart: number; count: number; dropped: number; timer: NodeJS.Timeout | null; paused: Readable[] };
  lsofWarned: boolean;
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

/** De delade tillfälliga katalogerna som stängs i profilen: TMPDIR, /tmp och /var/tmp (realpath, de som finns). */
export function sharedTmpDirs(): string[] {
  const out = new Set<string>();
  for (const p of [os.tmpdir(), '/tmp', '/var/tmp']) {
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
): Backends {
  const { config, paths, registry, logs } = deps;
  const opt: BackendOptions = { ...DEFAULT_OPTIONS, ...options };
  const guardFile = path.join(config.root, 'server', 'backends', 'guard.mjs');
  const entries = new Map<string, Entry>();
  let allocating: Promise<unknown> = Promise.resolve();
  let closed = false;
  // Beräknas vid första sandlådade start.
  let sandboxBase: { home: string; sharedTmp: string[]; guardReal: string; nodeDir: string } | null = null;

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
        wanted: false,
        lines: { windowStart: 0, count: 0, dropped: 0, timer: null, paused: [] },
        lsofWarned: false,
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

  /** stdout/stderr radvis till loggen; rader längre än MAX_LINE delas. */
  function readLines(e: Entry, stream: Readable | null): void {
    if (!stream) return;
    stream.setEncoding('utf8');
    let buf = '';
    const emit = (line: string): void => {
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
    if (e.proc) terminate(e.proc, 'stop');
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

  async function writeProfile(e: Entry, appReal: string, port: number, tmpDir: string): Promise<string> {
    if (!sandboxBase) {
      const home = realHome();
      sandboxBase = {
        home,
        sharedTmp: sharedTmpDirs(),
        guardReal: fs.realpathSync.native(guardFile),
        nodeDir: nodeReadDir(opt.nodePath, closedRoots(home, config.home)),
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

  function onExit(e: Entry, proc: Proc, code: number | null, signal: NodeJS.Signals | null): void {
    if (!proc.alive) return;
    proc.alive = false;
    if (proc.killTimer) clearTimeout(proc.killTimer);
    signalGroup(proc, 'SIGKILL'); // barn som blev kvar i gruppen
    proc.markExited();
    flushDropped(e);
    if (e.proc !== proc) return;
    e.proc = null;
    if (proc.reason === 'stop' || proc.reason === 'exposed') return; // tillståndet sätts av den som stoppade
    if (proc.reason === null) {
      note(e, code !== null ? `Backenden avslutades med kod ${code}.` : `Backenden avslutades av signalen ${signal}.`);
    }
    if (!e.wanted || closed) return;
    scheduleRestart(e);
  }

  function scheduleRestart(e: Entry): void {
    const now = Date.now();
    e.restarts = e.restarts.filter((t) => now - t < opt.restartWindowMs);
    if (e.restarts.length >= opt.restartDelaysMs.length) {
      e.gaveUp = true;
      setState(e, 'crashed');
      note(
        e,
        `Backenden har kraschat ${e.restarts.length + 1} gånger på ${seconds(opt.restartWindowMs)} och startas inte om förrän appen laddas om.`,
      );
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
    return null;
  }

  /** Själva starten; körs alltid i appens kö. */
  async function start(e: Entry): Promise<number | null> {
    if (closed || !e.wanted) return null;
    const entry = manifestEntry(e.id);
    if (entry === null) {
      setState(e, 'none');
      return null;
    }
    let appReal: string;
    let entryReal: string;
    let dataDir: string;
    let tmpDir: string;
    try {
      appReal = await fs.promises.realpath(paths.appDir(e.id));
      if (!isWithin(appReal, await fs.promises.realpath(paths.appsDir))) throw new Error('appens mapp ligger utanför apps/');
      entryReal = await resolveEntry(appReal, entry);
      dataDir = await prepareDataDir(appReal);
      tmpDir = await prepareTmpDir(dataDir);
    } catch (err) {
      return giveUp(e, `Backenden kan inte startas: ${(err as Error).message}.`);
    }
    if (closed || !e.wanted) return null;
    const port = await allocatePort(e);
    if (port === null) return giveUp(e, `Ingen ledig port mellan ${opt.portBase} och ${opt.portBase + opt.portSpan - 1}.`);

    const nodeArgs = [`--import=${pathToFileURL(guardFile).href}`, '--', entryReal];
    let command = opt.nodePath;
    let args = nodeArgs;
    if (!config.sandbox) {
      note(e, 'Sandlådan är avstängd (WORKBENCH_SANDBOX=0): backenden körs utan sandlåda.');
    } else if (!fs.existsSync(opt.sandboxExec)) {
      note(e, `${opt.sandboxExec} saknas: backenden körs utan sandlåda.`);
    } else {
      try {
        const profile = await writeProfile(e, appReal, port, tmpDir);
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
      child = spawn(command, args, {
        cwd: appReal,
        env: childEnv({ PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, APP_ID: e.id, NODE_ENV: 'development', TMPDIR: tmpDir }),
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
    const proc: Proc = { child, pid: child.pid, port, alive: true, exited, markExited, reason: null, killTimer: null };
    e.proc = proc;
    readLines(e, child.stdout);
    readLines(e, child.stderr);
    child.on('error', (err: NodeJS.ErrnoException) => {
      note(e, `Backendprocessen: ${err.message}`);
      // 'error' kommer också när en signal inte gick fram; bara ett misslyckat spawn betyder att processen är borta.
      if (err.syscall?.startsWith('spawn')) onExit(e, proc, null, null);
    });
    child.on('exit', (code, signal) => onExit(e, proc, code, signal));

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
      note(e, `Backenden lyssnade på ${check.names.join(', ')}, inte bara på 127.0.0.1, och stoppades.`);
      e.gaveUp = true;
      terminate(proc, 'exposed', 0);
      await proc.exited;
      setState(e, 'crashed');
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

  return {
    async ensure(appId) {
      if (closed) return null;
      const e = entryFor(appId);
      if (manifestEntry(appId) === null) {
        if (e.proc || e.starting || e.retry) await stopEntry(e);
        setState(e, 'none');
        return null;
      }
      if (e.proc?.alive && e.state === 'running') return e.proc.port;
      if (e.starting) return e.starting;
      if (e.retry) return e.retry.done;
      if (e.gaveUp) return null;
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
      if (e) await stopEntry(e);
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
  };
}
