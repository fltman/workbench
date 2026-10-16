// server/claude/sessions.ts — en Claude Code-session per app (CONTRACT §8.1–§8.6, §8.10).
// Den enda modulen som anropar registry.setStatus.
//
// Livscykel: en levande query() i strömmande läge per app (InputQueue som prompt). open() förvärmer med
// startup() och kopplar direkt warm.query(kön). Aldrig två processer på samma session: en ny process väntar
// in den som stängs. Högst fyra levande processer; den som varit stilla längst stängs först, men aldrig en
// med pågående tur eller obesvarad fråga.
//
// En "tur" här är en kedja: första meddelandet öppnar den (turn start, building), meddelanden under turen
// köas av Claude Code själv, och kedjan slutar vid ett result med queued_turn_count === 0. Då körs §8.6
// (commit, refresh, backend, bumpRev, status). Meddelanden som kommer under §8.6 hålls här och läggs i kön efter steg 5.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { CanUseTool, SDKMessage, SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { APP_ID_RE, DEFAULT_FACES } from '../../shared/protocol.ts';
import type { Ask, AskDecision, AskQuestion, AppStatus, ChatEvent } from '../../shared/protocol.ts';
import type { AppGit, AppLogs, AppRegistry, Backends, Config, Hub, Paths, SceneStore, Sessions, Shots } from '../types.ts';
import { prepareDataDir, prepareTmpDir } from '../backends/supervisor.ts';
import { appendEvents, deleteSessionFile, history as readHistory, readSessionId, repairChat, writeSessionId } from './chatlog.ts';
import { InputQueue, sdkEngine } from './engine.ts';
import type { Engine, EngineQuery, EngineWarm } from './engine.ts';
import { interpretResult, LimitsTracker, queuedAfter } from './events.ts';
import type { RateLimitInfoExt, TurnOutcome } from './events.ts';
import { createFakeEngine } from './fake.ts';
import { toolLabel } from './labels.ts';
import { buildOptions, sandboxAvailable } from './options.ts';
import { checkPolicy, permissionCard, permissionResult } from './policy.ts';
import { commitLine, composeMessage, loadAppRules, readNotes, workbenchBlock } from './prompt.ts';
import { makeWorkbenchTools } from './tools.ts';
import type { ReloadMemory } from './tools.ts';

/** Högst så många levande Claude-processer. */
export const MAX_LIVE = 4;
/** Efter inputQueue.end() får processen så här lång tid på sig innan q.close(). */
export const CLOSE_GRACE_MS = 5_000;
const STDERR_LINES = 40;
const SELFTEST_TIMEOUT_MS = 20_000;
export const MCP_TOOL_NAMES = ['reload_app', 'screenshot_app', 'get_app_logs', 'call_backend', 'request_secret', 'try_app'].map((t) => `mcp__workbench__${t}`);

export interface SessionDeps {
  config: Config;
  paths: Paths;
  registry: AppRegistry;
  scene: SceneStore;
  hub: Hub;
  backends: Backends;
  logs: AppLogs;
  shots: Shots;
  git: AppGit;
}

export interface SessionsOptions {
  /** Om Claudes Bash körs i sandlådan; standard config.sandbox && sandbox-exec finns. */
  sandbox?: boolean;
}

interface AskReply {
  decision: AskDecision;
  answers?: Record<string, string>;
  secret?: string;
  /** Text som användaren skrev i stället för att svara på kortet (ROB-4). */
  typed?: string;
}

interface PendingAsk {
  id: string;
  kind: Ask['kind'];
  ask: Ask;
  finish(decision: AskDecision, extra?: { answers?: Record<string, string>; secret?: string; typed?: string }, silent?: boolean): void;
}

interface Proc {
  input: InputQueue;
  appReal: string;
  warm: EngineWarm | null;
  q: EngineQuery | null;
  started: Promise<void>;
  exited: Promise<void>;
  markExited: () => void;
  ended: boolean;
  closing: Promise<void> | null;
  closingStarted: boolean;
  prevClosings: Promise<void>[];
  notesSent: boolean;
  pendingInterrupt: boolean;
  initChecked: boolean;
  sessionId?: string;
  stderr: string[];
  error?: unknown;
}

interface Chain {
  firstLine: string;
  /** Stopp gäller hela kedjan (FE-4): köade turer avbryts när de börjar. */
  stopRequested: boolean;
  /** Ett avbrott är redan skickat för den tur som pågår. */
  interruptSent: boolean;
  proc: Proc | null;
  /** Antal meddelanden som lagts i kön under kedjan. */
  delivered: number;
  /** Meddelanden efter det första, i ordning: köade bakom turen som pågår. */
  late: string[];
}

interface Session {
  appId: string;
  proc: Proc | null;
  closings: Set<Promise<void>>;
  chain: Chain | null;
  finishing: boolean;
  held: string[];
  implicitPending: boolean;
  implicitOutcome: TurnOutcome | null;
  lastLine: string;
  asks: Map<string, PendingAsk>;
  hudOpen: boolean;
  idleTimer: ReturnType<typeof setTimeout> | null;
  lastActive: number;
  undone: boolean;
  lastAt: number;
  forgotten: boolean;
  emittedTools: Set<string>;
  reload: ReloadMemory;
  warnedSandbox: boolean;
}

function newId(prefix: string): string {
  return `${prefix}-${crypto.randomBytes(6).toString('hex')}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => {
    const t = setTimeout(r, ms);
    t.unref?.();
  });
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    t.unref?.();
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** Till Claude när användaren skrev i stället för att svara på kortet (ROB-4). */
function typedMessage(text: string): string {
  return `The user said no and wrote instead: ${JSON.stringify(text.slice(0, 4000))}`;
}

function errText(err: unknown): string {
  const m = (err as Error)?.message ?? String(err);
  return m.split('\n')[0].slice(0, 500);
}

/** AskUserQuestion-indata → protokollets AskQuestion[]; null om formen är fel. */
export function normalizeQuestions(v: unknown): AskQuestion[] | null {
  if (!Array.isArray(v) || v.length === 0 || v.length > 4) return null;
  const out: AskQuestion[] = [];
  for (const q of v) {
    if (!q || typeof q !== 'object') return null;
    const r = q as Record<string, unknown>;
    if (typeof r.question !== 'string' || !Array.isArray(r.options) || r.options.length === 0 || r.options.length > 8) return null;
    const options: AskQuestion['options'] = [];
    for (const o of r.options) {
      if (!o || typeof o !== 'object' || typeof (o as Record<string, unknown>).label !== 'string') return null;
      const oo = o as Record<string, unknown>;
      options.push({ label: oo.label as string, ...(typeof oo.description === 'string' ? { description: oo.description } : {}) });
    }
    out.push({
      question: r.question,
      ...(typeof r.header === 'string' ? { header: r.header } : {}),
      multiSelect: r.multiSelect === true,
      options,
    });
  }
  return out;
}

function sanitizeAnswers(v: unknown): Record<string, string> | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const out: Record<string, string> = {};
  let n = 0;
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (typeof x !== 'string' || ++n > 16) continue;
    out[k] = x.slice(0, 4000);
  }
  return out;
}

export function createSessions(deps: SessionDeps): Sessions {
  return createSessionsWith(deps, deps.config.fakeClaude ? createFakeEngine(deps.config) : sdkEngine);
}

/** Som createSessions, med en utbytbar motor (tester och låtsas-Claude). */
export function createSessionsWith(deps: SessionDeps, engine: Engine, opts: SessionsOptions = {}): Sessions {
  const { config, paths, registry, scene, hub, backends, logs, shots, git } = deps;
  const sandbox = opts.sandbox ?? (config.sandbox && sandboxAvailable());
  const appRules = loadAppRules(config.root);
  const sessions = new Map<string, Session>();
  const limits = new LimitsTracker();
  let shuttingDown = false;

  /* ------------------------------ start: §8.10 ------------------------------ */

  try {
    const root = path.join(paths.dataDir, 'apps');
    for (const name of fs.readdirSync(root)) {
      if (!APP_ID_RE.test(name)) continue;
      try {
        repairChat(paths.appDataDir(name));
      } catch (err) {
        console.warn(`[sessions] kunde inte laga chat.jsonl för ${name}: ${errText(err)}`);
      }
    }
  } catch {
    /* ingen data/apps ännu */
  }

  /* ------------------------------ hjälpare ------------------------------ */

  function warn(appId: string, line: string): void {
    try {
      logs.append(appId, 'workbench', line);
    } catch {
      /* loggen får aldrig stoppa sessionen */
    }
  }

  function sess(appId: string, create = true): Session | undefined {
    let s = sessions.get(appId);
    if (s || !create) return s;
    if (typeof appId !== 'string' || !APP_ID_RE.test(appId) || !registry.get(appId)) return undefined;
    s = {
      appId,
      proc: null,
      closings: new Set(),
      chain: null,
      finishing: false,
      held: [],
      implicitPending: false,
      implicitOutcome: null,
      lastLine: 'Ändring',
      asks: new Map(),
      hudOpen: false,
      idleTimer: null,
      lastActive: Date.now(),
      undone: false,
      lastAt: 0,
      forgotten: false,
      emittedTools: new Set(),
      reload: { prev: [] },
      warnedSandbox: false,
    };
    sessions.set(appId, s);
    return s;
  }

  function nextAt(s: Session): number {
    const t = Math.max(Date.now(), s.lastAt + 1);
    s.lastAt = t;
    return t;
  }

  /** Sänder en händelse till HUD:en och sparar den (utom delta) i chat.jsonl. */
  function emit(s: Session, ev: ChatEvent): void {
    if (s.forgotten || shuttingDown) return;
    if (ev.k !== 'delta') {
      try {
        appendEvents(paths.appDataDir(s.appId), [ev]);
      } catch (err) {
        console.warn(`[sessions] kunde inte spara chatthändelse för ${s.appId}: ${errText(err)}`);
      }
    }
    hub.broadcast({ t: 'chat', appId: s.appId, ev });
  }

  function setStatus(s: Session, status: AppStatus): void {
    if (s.forgotten || shuttingDown) return;
    try {
      if (registry.get(s.appId)?.status === status) return;
      registry.setStatus(s.appId, status);
    } catch (err) {
      console.warn(`[sessions] setStatus ${s.appId}: ${errText(err)}`);
    }
  }

  function isBusy(s: Session): boolean {
    return !!s.chain || s.asks.size > 0 || s.finishing || s.held.length > 0;
  }

  function clearIdle(s: Session): void {
    if (s.idleTimer) clearTimeout(s.idleTimer);
    s.idleTimer = null;
  }

  function scheduleIdle(s: Session): void {
    clearIdle(s);
    if (!s.proc) return;
    s.idleTimer = setTimeout(() => {
      s.idleTimer = null;
      if (s.proc && !isBusy(s) && !s.hudOpen) void closeProc(s, s.proc);
    }, config.idleCloseMs);
    s.idleTimer.unref?.();
  }

  function logStderr(s: Session, p: Proc): void {
    for (const line of p.stderr.slice(-STDERR_LINES)) warn(s.appId, `claude: ${line}`);
  }

  /* ------------------------------ frågor ------------------------------ */

  function startAsk(s: Session, ask: Ask, signal?: AbortSignal): Promise<AskReply> {
    return new Promise<AskReply>((resolve) => {
      if (s.forgotten || shuttingDown || signal?.aborted) {
        resolve({ decision: 'cancelled' });
        return;
      }
      const id = newId('q');
      let timer: ReturnType<typeof setTimeout> | null = null;
      const onAbort = () => entry.finish('cancelled');
      const entry: PendingAsk = {
        id,
        kind: ask.kind,
        ask,
        finish(decision, extra, silent) {
          if (!s.asks.has(id)) return;
          s.asks.delete(id);
          if (timer) clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          if (!silent) {
            emit(s, { k: 'ask-done', id, decision });
            if (s.chain) setStatus(s, s.asks.size > 0 ? 'waiting' : 'building');
          }
          resolve({ decision, ...(extra ?? {}) });
        },
      };
      s.asks.set(id, entry);
      emit(s, { k: 'ask', id, ask, at: nextAt(s) });
      setStatus(s, 'waiting');
      timer = setTimeout(() => entry.finish('timeout'), config.permissionTimeoutMs);
      timer.unref?.();
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  function cancelAsks(s: Session, silent: boolean): void {
    for (const a of [...s.asks.values()]) a.finish('cancelled', undefined, silent);
  }

  /** canUseTool för en process (§8.5): policyn först, sedan sandlådad Bash, AskUserQuestion och sist frågekortet. */
  function makeCanUseTool(s: Session, appReal: string): CanUseTool {
    return async (toolName, input, o) => {
      try {
        const denial = await checkPolicy({ appReal, toolName, input, blockedPath: o.blockedPath, sandbox });
        if (denial) return { behavior: 'deny', message: denial };
        // I sandlådan körs varje Bash-kommando instängt (allowUnsandboxedCommands: false). Claude Codes egna
        // heuristiker frågar ändå ibland, t.ex. "brace with quote character (expansion obfuscation)" för JSON i en
        // heredoc. Sandlådan är gränsen, så Workbench godkänner dem (Anders beslut 16 oktober 2026, §8.5).
        // En ask-regel (matchedAskRule) betyder att någon uttryckligen vill ha en människa; den följs alltid.
        if (toolName === 'Bash' && sandbox && !o.matchedAskRule) return { behavior: 'allow', updatedInput: input };
        if (toolName === 'AskUserQuestion') {
          const questions = normalizeQuestions(input.questions);
          if (!questions) return { behavior: 'deny', message: 'Workbench could not show these questions (invalid input).' };
          const r = await startAsk(s, { kind: 'question', questions }, o.signal);
          if (r.decision === 'answered' && r.answers) return { behavior: 'allow', updatedInput: { questions: input.questions, answers: r.answers } };
          if (r.decision === 'deny' && r.typed !== undefined) return { behavior: 'deny', message: typedMessage(r.typed) };
          return permissionResult(r.decision === 'answered' ? 'deny' : r.decision, input, { remember: [], canRemember: false });
        }
        const card = permissionCard(toolName, input, o);
        const r = await startAsk(
          s,
          { kind: 'permission', tool: toolName, title: card.title, detail: card.detail, canRemember: card.canRemember, defaultNo: card.defaultNo },
          o.signal,
        );
        if (r.decision === 'deny' && r.typed !== undefined) return { behavior: 'deny', message: typedMessage(r.typed) };
        return permissionResult(r.decision, input, card);
      } catch (err) {
        console.warn(`[sessions] canUseTool ${s.appId}: ${errText(err)}`);
        return { behavior: 'deny', message: 'Workbench could not ask the user, so this was not allowed.' };
      }
    };
  }

  /* ------------------------------ turer ------------------------------ */

  function openChain(s: Session, firstLine: string): Chain {
    const c: Chain = { firstLine, stopRequested: false, interruptSent: false, proc: null, delivered: 0, late: [] };
    s.chain = c;
    s.emittedTools.clear();
    clearIdle(s);
    emit(s, { k: 'turn', phase: 'start', at: nextAt(s) });
    setStatus(s, 'building');
    return c;
  }

  function endChain(s: Session, o: TurnOutcome): void {
    const c = s.chain;
    if (!c) return;
    s.chain = null;
    cancelAsks(s, false);
    emit(s, { k: 'turn', phase: 'end', ok: o.ok, interrupted: o.interrupted, ...(o.error ? { error: o.error } : {}), at: nextAt(s) });
    s.finishing = true;
    void finishTurn(s, c, o);
  }

  /** §8.6 i ordning. Under tiden hålls nya meddelanden i s.held. */
  async function finishTurn(s: Session, c: Chain, o: TurnOutcome): Promise<void> {
    const id = s.appId;
    try {
      try {
        await git.commitAll(id, c.firstLine);
      } catch (err) {
        warn(id, `varning: commit misslyckades: ${errText(err)}`);
      }
      if (s.forgotten || shuttingDown) return;
      try {
        registry.refresh(id);
      } catch (err) {
        console.warn(`[sessions] refresh ${id}: ${errText(err)}`);
      }
      try {
        // Villkorslöst (§8.6 steg 3): har Claude tagit bort backenden ur app.json stoppar restart den gamla processen.
        if (!shuttingDown) await backends.restart(id);
      } catch (err) {
        warn(id, `varning: backenden kunde inte startas om: ${errText(err)}`);
      }
      if (s.forgotten || shuttingDown) return;
      try {
        registry.bumpRev(id);
      } catch (err) {
        console.warn(`[sessions] bumpRev ${id}: ${errText(err)}`);
      }
      setStatus(s, o.ok || o.interrupted ? 'idle' : 'error');
    } finally {
      s.finishing = false;
    }
    if (s.forgotten || shuttingDown) return;
    if (s.held.length > 0) {
      const held = s.held.splice(0);
      s.implicitPending = false;
      s.implicitOutcome = null;
      openChain(s, commitLine(held[0]));
      for (const t of held) deliver(s, t);
    } else if (s.implicitPending) {
      // Claude Code började en tur som vi inte öppnat (meddelandet kom fram precis när förra turen tog slut).
      s.implicitPending = false;
      const io = s.implicitOutcome;
      s.implicitOutcome = null;
      const nc = openChain(s, s.lastLine);
      nc.proc = s.proc;
      if (io) endChain(s, io);
    } else if (!s.hudOpen) {
      scheduleIdle(s);
    }
    // Fler än MAX_LIVE levande processer (ROB-6): stäng de stilla nu när den här inte längre arbetar.
    enforceCap(null);
  }

  /** En not per meddelande som stoppet hindrade (FE-4), så att användarens rad i HUD:en inte vilseleder. */
  function noteDropped(s: Session, texts: string[], verb: string): void {
    for (const t of texts) {
      const one = t.replace(/\s+/g, ' ').trim();
      const cps = Array.from(one);
      const shown = cps.length > 60 ? cps.slice(0, 59).join('') + '…' : one;
      emit(s, { k: 'note', id: newId('n'), text: `Stoppad – ”${shown}” ${verb}`, at: nextAt(s) });
    }
  }

  /** Lägger ett meddelande (med <workbench>-blocket) i processens kö; startar processen vid behov. */
  function deliver(s: Session, text: string): void {
    const p = ensureProc(s);
    let backend: ReturnType<Backends['state']> = 'none';
    let port: number | null = null;
    try {
      backend = backends.state(s.appId);
      port = backends.port(s.appId);
    } catch {
      /* okänt läge */
    }
    const block = workbenchBlock({
      win: scene.window(s.appId),
      faces: registry.get(s.appId)?.faces ?? DEFAULT_FACES,
      backend,
      backendPort: port,
      undone: s.undone,
      notes: p.notesSent ? null : readNotes(paths.appDir(s.appId)),
    });
    s.undone = false;
    p.notesSent = true;
    s.lastLine = commitLine(text);
    p.input.push(composeMessage(block, text));
    if (s.chain) {
      s.chain.proc = p;
      if (s.chain.delivered++ > 0) s.chain.late.push(text);
    }
    s.lastActive = Date.now();
  }

  /* ------------------------------ processer ------------------------------ */

  function makeProc(s: Session): Proc {
    let markExited!: () => void;
    const exited = new Promise<void>((r) => {
      markExited = r;
    });
    return {
      input: new InputQueue(),
      appReal: paths.appDir(s.appId),
      warm: null,
      q: null,
      started: Promise.resolve(),
      exited,
      markExited,
      ended: false,
      closing: null,
      closingStarted: false,
      prevClosings: [...s.closings],
      notesSent: false,
      pendingInterrupt: false,
      initChecked: false,
      stderr: [],
    };
  }

  function ensureProc(s: Session): Proc {
    if (s.proc && !s.proc.closingStarted && !s.proc.ended) return s.proc;
    const p = makeProc(s);
    s.proc = p;
    enforceCap(s);
    p.started = startProc(s, p).catch((err) => onStartFailed(s, p, err));
    return p;
  }

  function enforceCap(current: Session | null): void {
    const live = () => [...sessions.values()].filter((x) => x.proc && !x.proc.closingStarted && !x.proc.ended);
    let list = live();
    while (list.length > MAX_LIVE) {
      // Aldrig en som arbetar eller väntar på ett kort, och i första hand appar utan öppen HUD. Trimningen efter en
      // tur (current null) tar en process bakom en öppen HUD först när ingen process längre arbetar: där skriver
      // användaren härnäst, men fler HUD:ar än taket kan vara öppna samtidigt. Då går den som varit stilla längst.
      const idle = list.filter((x) => x !== current && !isBusy(x));
      const anyBusy = list.some((x) => isBusy(x));
      const victim = idle
        .filter((x) => current !== null || !x.hudOpen || !anyBusy)
        .sort((a, b) => (a.hudOpen ? 1 : 0) - (b.hudOpen ? 1 : 0) || a.lastActive - b.lastActive)[0];
      if (!victim || !victim.proc) {
        if (!idle.length) console.warn(`[sessions] fler än ${MAX_LIVE} levande Claude-processer: alla andra arbetar`);
        break;
      }
      void closeProc(victim, victim.proc);
      list = live();
    }
  }

  function toolsFor(s: Session): SdkMcpToolDefinition<any>[] {
    return makeWorkbenchTools({
      appId: s.appId,
      paths,
      registry,
      backends,
      logs,
      shots,
      reload: s.reload,
      askSecret: async (key, label, signal) => {
        const r = await startAsk(s, { kind: 'secret', key, label }, signal);
        return { decision: r.decision, value: r.secret };
      },
    });
  }

  async function startProc(s: Session, p: Proc): Promise<void> {
    if (p.prevClosings.length) await Promise.allSettled(p.prevClosings); // aldrig två processer på samma session
    if (p.closingStarted || s.forgotten || shuttingDown) {
      p.ended = true;
      p.markExited();
      return;
    }
    p.appReal = await fs.promises.realpath(paths.appDir(s.appId));
    // Claudes egen TMPDIR i appens data/ (SEC-3); den delade är stängd i sandlådan.
    try {
      await prepareTmpDir(await prepareDataDir(p.appReal));
    } catch (err) {
      warn(s.appId, `varning: data/tmp kunde inte skapas: ${errText(err)}`);
    }
    if (!sandbox && !s.warnedSandbox) {
      s.warnedSandbox = true;
      warn(s.appId, config.sandbox ? 'varning: sandbox-exec saknas, så Claudes Bash körs utan sandlåda.' : 'varning: WORKBENCH_SANDBOX=0, så Claudes Bash körs utan sandlåda.');
    }
    const appDataDir = paths.appDataDir(s.appId);
    const resume = readSessionId(appDataDir);
    const start = async (resumeId: string | undefined): Promise<EngineWarm> => {
      const tools = toolsFor(s);
      const options = buildOptions({
        config,
        appReal: p.appReal,
        appsDir: paths.appsDir,
        sandbox,
        appRules,
        tools,
        canUseTool: makeCanUseTool(s, p.appReal),
        resume: resumeId,
        stderr: (d: string) => {
          for (const line of d.split('\n')) {
            if (!line.trim()) continue;
            p.stderr.push(line.slice(0, 1000));
            if (p.stderr.length > STDERR_LINES) p.stderr.shift();
          }
        },
      });
      return engine.startup(options, tools);
    };
    let warm: EngineWarm;
    try {
      warm = await start(resume);
    } catch (err) {
      if (!resume || p.closingStarted || s.forgotten || shuttingDown) throw err;
      warn(s.appId, `varning: sessionen kunde inte återupptas (${errText(err)}); en ny startas.`);
      logStderr(s, p);
      p.stderr.length = 0;
      warm = await start(undefined);
    }
    if (p.closingStarted || s.forgotten || shuttingDown) {
      try {
        warm.close();
      } catch {
        /* redan stängd */
      }
      p.ended = true;
      p.markExited();
      return;
    }
    p.warm = warm;
    const q = warm.query(p.input);
    p.q = q;
    if (p.pendingInterrupt) void q.interrupt().catch(() => {});
    void selfTest(s, p, q);
    void pump(s, p, q);
  }

  function onStartFailed(s: Session, p: Proc, err: unknown): void {
    p.ended = true;
    p.error = err;
    p.markExited();
    p.input.end();
    if (s.proc === p) s.proc = null;
    if (s.forgotten || shuttingDown) return;
    console.error(`[sessions] Claude Code kunde inte starta för ${s.appId}: ${errText(err)}`);
    warn(s.appId, `fel: Claude Code kunde inte starta: ${errText(err)}`);
    logStderr(s, p);
    if (s.chain && s.chain.proc === p) {
      const stopped = s.chain.stopRequested;
      s.chain = null;
      cancelAsks(s, false);
      emit(s, {
        k: 'turn', phase: 'end', ok: false, interrupted: stopped,
        ...(stopped ? {} : { error: `Claude Code kunde inte starta: ${errText(err)}` }),
        at: nextAt(s),
      });
      setStatus(s, stopped ? 'idle' : 'error');
      if (!s.hudOpen) scheduleIdle(s);
    }
  }

  async function pump(s: Session, p: Proc, q: EngineQuery): Promise<void> {
    try {
      for await (const msg of q) {
        if (s.forgotten || shuttingDown) continue;
        try {
          handle(s, p, msg);
        } catch (err) {
          console.error(`[sessions] händelse för ${s.appId}: ${errText(err)}`);
        }
      }
    } catch (err) {
      p.error = err;
    } finally {
      p.ended = true;
      p.markExited();
      onProcEnded(s, p);
    }
  }

  function onProcEnded(s: Session, p: Proc): void {
    if (s.proc === p) s.proc = null;
    if (s.forgotten || shuttingDown) return;
    const unexpected = !p.closingStarted;
    if (unexpected && p.error) {
      console.error(`[sessions] Claude Code avslutades med fel för ${s.appId}: ${errText(p.error)}`);
      warn(s.appId, `fel: Claude Code avslutades: ${errText(p.error)}`);
    }
    if (s.chain && s.chain.proc === p) {
      if (unexpected) logStderr(s, p);
      const stopped = s.chain.stopRequested;
      endChain(s, { ok: false, interrupted: stopped, ...(stopped ? {} : { error: 'Claude Code avslutades oväntat.' }) });
    } else if (unexpected && p.error) {
      logStderr(s, p);
    }
  }

  function closeProc(s: Session, p: Proc, force = false): Promise<void> {
    if (p.closing) {
      if (force && p.q && !p.ended) {
        try {
          p.q.close();
        } catch {
          /* redan stängd */
        }
      }
      return p.closing;
    }
    p.closingStarted = true;
    if (s.proc === p) {
      s.proc = null;
      clearIdle(s);
    }
    const closing = (async () => {
      await p.started.catch(() => {});
      p.input.end();
      if (p.q) {
        if (!p.ended && !force) await Promise.race([p.exited, sleep(CLOSE_GRACE_MS)]);
        if (!p.ended) {
          try {
            p.q.close();
          } catch {
            /* redan stängd */
          }
          await Promise.race([p.exited, sleep(3_000)]);
        }
      } else if (p.warm) {
        try {
          p.warm.close();
        } catch {
          /* redan stängd */
        }
      }
    })();
    p.closing = closing;
    s.closings.add(closing);
    void closing.finally(() => s.closings.delete(closing));
    return closing;
  }

  /** §8.2 självtest, loggat. Avvikelser blir varningar med källan workbench. */
  async function selfTest(s: Session, p: Proc, q: EngineQuery): Promise<void> {
    const problems: string[] = [];
    try {
      const st = await withTimeout(q.mcpServerStatus(), SELFTEST_TIMEOUT_MS);
      const names = st.map((x) => x.name);
      if (names.length !== 1 || names[0] !== 'workbench') problems.push(`MCP-servrar: ${names.join(', ') || 'inga'} (bara workbench väntades)`);
      else if (st[0].status !== 'connected') problems.push(`MCP-servern workbench har status ${st[0].status}`);
    } catch (err) {
      problems.push(`mcpServerStatus misslyckades: ${errText(err)}`);
    }
    try {
      const cu = await withTimeout(q.getContextUsage({ detail: 'summary' }), SELFTEST_TIMEOUT_MS);
      if (cu.memoryFiles.length > 0) problems.push(`minnesfiler lästes in: ${cu.memoryFiles.map((f) => f.path).join(', ')}`);
    } catch (err) {
      problems.push(`getContextUsage misslyckades: ${errText(err)}`);
    }
    if (p.closingStarted || p.ended || s.forgotten || shuttingDown) return;
    if (problems.length === 0) {
      console.log(`[sessions] självtest ${s.appId}: inga minnesfiler, bara MCP-servern workbench`);
      return;
    }
    for (const pr of problems) warn(s.appId, `varning: självtest: ${pr}`);
  }

  /* ------------------------------ SDK-meddelanden ------------------------------ */

  /** Claude Code arbetar utan att vi öppnat en tur: öppna en (eller efter §8.6). */
  function activity(s: Session, p: Proc): void {
    const cur = s.chain;
    if (cur) {
      // Efter stopp avbryts varje köad tur så fort den syns (FE-4); en gång per tur.
      if (cur.stopRequested && !cur.interruptSent && p.q && !p.ended) {
        cur.interruptSent = true;
        void p.q.interrupt().catch(() => {});
      }
      return;
    }
    if (s.finishing) {
      s.implicitPending = true;
      return;
    }
    const c = openChain(s, s.lastLine);
    c.proc = p;
  }

  function handle(s: Session, p: Proc, msg: SDKMessage): void {
    switch (msg.type) {
      case 'system': {
        if (msg.subtype !== 'init') return;
        if (msg.session_id && msg.session_id !== p.sessionId) {
          p.sessionId = msg.session_id;
          try {
            writeSessionId(paths.appDataDir(s.appId), msg.session_id);
          } catch (err) {
            console.warn(`[sessions] kunde inte spara session.json för ${s.appId}: ${errText(err)}`);
          }
        }
        if (!p.initChecked) {
          p.initChecked = true;
          const tools = Array.isArray(msg.tools) ? msg.tools : [];
          const missing = MCP_TOOL_NAMES.filter((t) => !tools.includes(t));
          if (missing.length) warn(s.appId, `varning: självtest: verktyg saknas i system/init: ${missing.join(', ')}`);
          const servers = (msg.mcp_servers ?? []).map((m) => m.name);
          if (servers.length !== 1 || servers[0] !== 'workbench') warn(s.appId, `varning: självtest: MCP-servrar i system/init: ${servers.join(', ') || 'inga'}`);
        }
        return;
      }
      case 'stream_event': {
        if (msg.parent_tool_use_id) return;
        activity(s, p);
        const ev = msg.event;
        if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta' && ev.delta.text) emit(s, { k: 'delta', text: ev.delta.text });
        return;
      }
      case 'assistant': {
        if (msg.parent_tool_use_id) return;
        activity(s, p);
        for (const b of msg.message.content) {
          if (b.type === 'text') {
            if (b.text.trim()) emit(s, { k: 'text', id: newId('t'), text: b.text, at: nextAt(s) });
          } else if (b.type === 'tool_use') {
            if (b.name === 'TodoWrite') continue;
            s.emittedTools.add(b.id);
            const input = b.input && typeof b.input === 'object' ? (b.input as Record<string, unknown>) : {};
            emit(s, { k: 'tool', id: b.id, name: b.name, label: toolLabel(b.name, input, p.appReal), at: nextAt(s) });
          }
        }
        return;
      }
      case 'user': {
        if (msg.parent_tool_use_id) return;
        const content = msg.message.content;
        if (!Array.isArray(content)) return;
        for (const b of content) {
          if (b && typeof b === 'object' && b.type === 'tool_result' && s.emittedTools.has(b.tool_use_id)) {
            s.emittedTools.delete(b.tool_use_id);
            emit(s, { k: 'tool-done', id: b.tool_use_id, ok: !b.is_error });
          }
        }
        return;
      }
      case 'result': {
        const outcome = interpretResult(msg, s.chain?.stopRequested ?? false);
        const queued = queuedAfter(msg);
        if (!s.chain) {
          if (s.finishing && s.implicitPending && queued === 0) s.implicitOutcome = outcome;
          return;
        }
        if (queued > 0) {
          // Fler köade turer följer: samma kedja, en commit. Efter stopp avbryts nästa tur direkt (FE-4);
          // syns den ändå arbeta avbryts den igen i activity().
          if (s.chain.stopRequested) {
            s.chain.interruptSent = false;
            if (p.q && !p.ended) void p.q.interrupt().catch(() => {});
          }
          return;
        }
        endChain(s, outcome);
        return;
      }
      case 'rate_limit_event': {
        const r = limits.update(msg.rate_limit_info as RateLimitInfoExt);
        if (r) hub.broadcast({ t: 'limits', fiveHour: r.fiveHour, sevenDay: r.sevenDay });
        return;
      }
      default:
        return;
    }
  }

  /* ------------------------------ gränssnittet ------------------------------ */

  return {
    open(appId) {
      const s = sess(appId);
      if (!s || s.forgotten || shuttingDown) return;
      s.hudOpen = true;
      s.lastActive = Date.now();
      clearIdle(s);
      ensureProc(s);
    },

    close(appId) {
      const s = sess(appId, false);
      if (!s) return;
      s.hudOpen = false;
      if (!isBusy(s)) scheduleIdle(s);
    },

    send(appId, text, via) {
      const s = sess(appId);
      if (!s || s.forgotten || shuttingDown) return;
      if (typeof text !== 'string' || !text.trim()) return;
      s.lastActive = Date.now();
      emit(s, { k: 'user', id: newId('u'), text, via: via === 'voice' ? 'voice' : 'text', at: nextAt(s) });
      // Ett obesvarat kort besvaras med texten (ROB-4), som i Claude Code: tillstånd blir nej med användarens
      // ord, en fråga får texten som fritt svar ("Annat"). Texten skickas då inte som ett eget meddelande.
      // En hemlighet får aldrig skriven text: kortet avböjs och texten går fram som vanligt.
      const card = [...s.asks.values()].find((a) => a.kind !== 'secret');
      if (card) {
        if (card.ask.kind === 'question') {
          const answers: Record<string, string> = {};
          for (const q of card.ask.questions) answers[q.question] = text.slice(0, 4000);
          card.finish('answered', { answers });
        } else {
          card.finish('deny', { typed: text });
        }
        return;
      }
      for (const a of [...s.asks.values()]) if (a.kind === 'secret') a.finish('deny');
      // En stoppad kedja avbryter varje tur som kommer in i den (FE-4), så ett nytt meddelande väntar som
      // under §8.6 och blir en egen kedja när den stoppade har slutat.
      if (s.finishing || s.chain?.stopRequested) {
        s.held.push(text);
        return;
      }
      if (!s.chain) openChain(s, commitLine(text));
      deliver(s, text);
    },

    async stop(appId) {
      const s = sess(appId, false);
      if (!s || s.forgotten) return;
      if (!s.chain) {
        // Under §8.6 finns ingen kedja, men hållna meddelanden väntar på nästa: de skickas aldrig (FE-4).
        if (s.finishing && s.held.length > 0) noteDropped(s, s.held.splice(0), 'skickades inte');
        return;
      }
      const c = s.chain;
      c.stopRequested = true;
      c.interruptSent = true;
      const p = c.proc ?? s.proc;
      // Köade meddelanden körs inte (FE-4). De som processen inte läst ännu tas ur kön; de som redan ligger
      // i Claude Codes egen kö avbryts när deras tur börjar (handle/activity).
      const late = c.late.splice(0);
      const unread = p ? p.input.dropLast(late.length) : 0;
      noteDropped(s, late.slice(0, late.length - unread), 'avbröts');
      noteDropped(s, late.slice(late.length - unread), 'skickades inte');
      // Meddelanden som väntar på att den redan stoppade kedjan ska sluta (ett andra stopp).
      if (s.held.length > 0) noteDropped(s, s.held.splice(0), 'skickades inte');
      let interrupting: Promise<unknown> | undefined;
      if (p && !p.ended) {
        if (p.q) interrupting = p.q.interrupt().catch((err) => console.warn(`[sessions] interrupt ${appId}: ${errText(err)}`));
        else p.pendingInterrupt = true;
      }
      cancelAsks(s, false);
      await interrupting;
    },

    answer(appId, askId, decision, answers, secret) {
      const s = sess(appId, false);
      const a = s?.asks.get(askId);
      if (!s || !a) return;
      if (a.kind === 'permission') {
        if (decision === 'allow' || decision === 'allow-always' || decision === 'deny') a.finish(decision);
        return;
      }
      if (a.kind === 'question') {
        if (decision === 'deny') a.finish('deny');
        else if (decision === 'answered') {
          const clean = sanitizeAnswers(answers);
          if (clean) a.finish('answered', { answers: clean });
        }
        return;
      }
      // secret: värdet går bara vidare till request_secret, som skriver data/secrets.json.
      if (decision === 'deny') a.finish('deny');
      else if (decision === 'answered') {
        if (typeof secret === 'string' && secret.length > 0) a.finish('answered', { secret });
        else a.finish('deny');
      }
    },

    history(appId, limit = 300) {
      if (typeof appId !== 'string' || !APP_ID_RE.test(appId)) return [];
      try {
        return readHistory(paths.appDataDir(appId), limit);
      } catch {
        return [];
      }
    },

    noteUndo(appId) {
      const s = sess(appId);
      if (!s || s.forgotten) return;
      s.undone = true;
      emit(s, { k: 'note', id: newId('n'), text: 'Ångrade senaste ändringen.', at: nextAt(s) });
    },

    busy(appId) {
      const s = sessions.get(appId);
      return !!s && isBusy(s);
    },

    async forget(appId) {
      const s = sessions.get(appId);
      if (s) {
        s.forgotten = true;
        clearIdle(s);
        cancelAsks(s, true);
        s.held.length = 0;
        s.chain = null;
        const p = s.proc;
        if (p) {
          if (p.q && !p.ended) await withTimeout(p.q.interrupt(), 1_000).catch(() => {});
          void closeProc(s, p, true);
        }
        await Promise.allSettled([...s.closings]);
        sessions.delete(appId);
      }
      if (typeof appId !== 'string' || !APP_ID_RE.test(appId)) return;
      deleteSessionFile(paths.appDataDir(appId));
      // Transkripten raderas först när processen är stängd, så att inget skrivs efteråt (§8.1).
      if (engine.deleteTranscripts) {
        try {
          const n = await engine.deleteTranscripts(paths.appDir(appId));
          if (n > 0) console.log(`[sessions] ${appId}: ${n} transkript raderade`);
        } catch (err) {
          console.warn(`[sessions] kunde inte radera transkripten för ${appId}: ${errText(err)}`);
        }
      }
    },

    async closeAll() {
      shuttingDown = true;
      const all = [...sessions.values()];
      for (const s of all) {
        clearIdle(s);
        cancelAsks(s, true);
      }
      await Promise.allSettled(
        all.map(async (s) => {
          const p = s.proc;
          if (p) {
            if (s.chain && p.q && !p.ended) await withTimeout(p.q.interrupt(), 1_000).catch(() => {});
            void closeProc(s, p);
          }
          await Promise.allSettled([...s.closings]);
        }),
      );
    },
  };
}
