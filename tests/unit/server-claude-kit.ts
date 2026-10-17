// tests/unit/server-claude-kit.ts — testhjälp för server-claude: låtsade beroenden och en skriptad SDK-motor.
// Ingen testfil i sig (heter inte *.test.ts); importeras av tests/unit/server-claude-*.test.ts.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Options, SDKMessage, SDKUserMessage, SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { loadConfig } from '../../server/config.ts';
import { makePaths } from '../../server/paths.ts';
import type { AppGit, AppLogs, AppRegistry, Backends, Config, Hub, Paths, SceneStore, Shots } from '../../server/types.ts';
import type { Engine, EngineQuery, EngineWarm } from '../../server/claude/engine.ts';
import { DEFAULT_FACES } from '../../shared/protocol.ts';
import type { AppInfo, AppManifest, AppStatus, BackendState, ChatEvent, ServerMsg, WindowState } from '../../shared/protocol.ts';

export function tmpHome(tag = 'wb-claude'): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `${tag}-`)));
}

export function rmrf(p: string): void {
  fs.rmSync(p, { recursive: true, force: true });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Väntar tills cond() är sann (eller kastar efter timeout). */
export async function until(cond: () => boolean, timeoutMs = 5000, what = 'villkoret'): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout: ${what}`);
    await sleep(5);
  }
}

export function testConfig(home: string, over: Partial<Config> = {}): Config {
  const c = loadConfig({ WORKBENCH_HOME: home, WORKBENCH_PORT: '8241', WORKBENCH_HMR_PORT: '8242' } as NodeJS.ProcessEnv);
  return { ...c, idleCloseMs: 60_000, ...over };
}

export interface Recorder {
  /** Ordnad logg över anrop till registry, git och backends. */
  calls: string[];
}

export function makeHub(): Hub & { msgs: ServerMsg[]; chat(appId?: string): ChatEvent[] } {
  const msgs: ServerMsg[] = [];
  return {
    msgs,
    broadcast(m) {
      msgs.push(JSON.parse(JSON.stringify(m)) as ServerMsg);
    },
    clients: () => 1,
    chat(appId?: string) {
      const out: ChatEvent[] = [];
      for (const m of msgs) if (m.t === 'chat' && (!appId || m.appId === appId)) out.push(m.ev);
      return out;
    },
  };
}

export function makeLogs(): AppLogs & { all: Map<string, string[]> } {
  const all = new Map<string, string[]>();
  return {
    all,
    append(appId, source, line) {
      const t = new Date().toTimeString().slice(0, 8);
      const list = all.get(appId) ?? [];
      list.push(`${t} [${source}] ${line}`);
      all.set(appId, list);
    },
    tail(appId, n = 80) {
      const list = all.get(appId) ?? [];
      return list.slice(Math.max(0, list.length - n));
    },
    clear(appId) {
      all.delete(appId);
    },
  };
}

export function makeRegistry(paths: Paths, rec: Recorder): AppRegistry & { apps: Map<string, AppInfo>; manifests: Map<string, AppManifest> } {
  const apps = new Map<string, AppInfo>();
  const manifests = new Map<string, AppManifest>();
  return {
    apps,
    manifests,
    list: () => [...apps.values()],
    get: (id) => apps.get(id),
    manifest(id) {
      const m = manifests.get(id) ?? {};
      return { ...m, faces: m.faces && m.faces.length ? m.faces : DEFAULT_FACES, permissions: m.permissions ?? [] };
    },
    async create() {
      throw new Error('not used');
    },
    async remove(id) {
      apps.delete(id);
    },
    setStatus(id, status: AppStatus) {
      rec.calls.push(`setStatus:${id}:${status}`);
      const a = apps.get(id);
      if (a) a.status = status;
    },
    setBackend(id, state: BackendState) {
      const a = apps.get(id);
      if (a) a.backend = state;
    },
    bumpRev(id) {
      rec.calls.push(`bumpRev:${id}`);
      const a = apps.get(id);
      if (a) a.rev++;
    },
    refresh(id) {
      rec.calls.push(`refresh:${id}`);
      // läs app.json på riktigt, som registret gör
      try {
        const m = JSON.parse(fs.readFileSync(path.join(paths.appDir(id), 'app.json'), 'utf8')) as AppManifest;
        manifests.set(id, m);
        const a = apps.get(id);
        if (a) {
          a.name = m.name ?? '';
          a.faces = m.faces && m.faces.length ? m.faces : DEFAULT_FACES;
          a.built = fs.existsSync(path.join(paths.appDir(id), a.faces[0].page));
        }
      } catch {
        /* inget manifest */
      }
    },
    noteLog() {},
    troubles: () => [],
  };
}

export function makeScene(): SceneStore & { wins: Map<string, WindowState> } {
  const wins = new Map<string, WindowState>();
  return {
    wins,
    get: () => ({ version: 1, camera: { cx: 0, cy: 0, zoom: 1 }, windows: [...wins.values()] }),
    window: (appId) => wins.get(appId),
    upsertWindow: (w) => {
      wins.set(w.appId, w);
    },
    removeWindowForApp: (appId) => {
      const w = wins.get(appId);
      wins.delete(appId);
      return w;
    },
    setCamera: () => {},
    flush: async () => {},
  };
}

export function makeGit(rec: Recorder, delayMs = 0): AppGit & { commits: { appId: string; message: string }[] } {
  const commits: { appId: string; message: string }[] = [];
  return {
    commits,
    async init() {},
    async commitAll(appId, message) {
      rec.calls.push(`commit:${appId}:${message}`);
      if (delayMs) await sleep(delayMs);
      commits.push({ appId, message });
      return true;
    },
    async undo() {
      return true;
    },
    async redo() {
      return true;
    },
    async canRedo() {
      return false;
    },
  };
}

export function makeBackends(rec: Recorder): Backends & { st: Map<string, BackendState>; ports: Map<string, number> } {
  const st = new Map<string, BackendState>();
  const ports = new Map<string, number>();
  return {
    st,
    ports,
    async ensure(id) {
      rec.calls.push(`ensure:${id}`);
      return ports.get(id) ?? null;
    },
    async restart(id) {
      rec.calls.push(`restart:${id}`);
      return ports.get(id) ?? null;
    },
    async stop() {},
    async stopAll() {},
    state: (id) => st.get(id) ?? 'none',
    port: (id) => ports.get(id) ?? null,
  };
}

/** 1×1 PNG. */
export const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

export function makeShots(): Shots & { calls: { appId: string; face?: string }[]; fail?: string } {
  const o: Shots & { calls: { appId: string; face?: string }[]; fail?: string } = {
    calls: [],
    async screenshot(appId, face) {
      o.calls.push({ appId, face });
      if (o.fail) throw new Error(o.fail);
      return { png: TINY_PNG, w: 640, h: 480, face: face ?? 'main' };
    },
    async close() {},
  };
  return o;
}

export interface World {
  home: string;
  config: Config;
  paths: Paths;
  rec: Recorder;
  hub: ReturnType<typeof makeHub>;
  logs: ReturnType<typeof makeLogs>;
  registry: ReturnType<typeof makeRegistry>;
  scene: ReturnType<typeof makeScene>;
  git: ReturnType<typeof makeGit>;
  backends: ReturnType<typeof makeBackends>;
  shots: ReturnType<typeof makeShots>;
  addApp(id: string, opts?: { notes?: string; win?: Partial<WindowState> }): string;
  cleanup(): void;
}

export function makeWorld(over: Partial<Config> = {}, gitDelayMs = 0): World {
  const home = tmpHome();
  const config = testConfig(home, over);
  const paths = makePaths(config);
  const rec: Recorder = { calls: [] };
  const registry = makeRegistry(paths, rec);
  const scene = makeScene();
  const w: World = {
    home,
    config,
    paths,
    rec,
    hub: makeHub(),
    logs: makeLogs(),
    registry,
    scene,
    git: makeGit(rec, gitDelayMs),
    backends: makeBackends(rec),
    shots: makeShots(),
    addApp(id, opts = {}) {
      const dir = paths.appDir(id);
      fs.mkdirSync(dir, { recursive: true });
      fs.mkdirSync(paths.appDataDir(id), { recursive: true });
      fs.writeFileSync(path.join(dir, 'CLAUDE.md'), opts.notes ?? `# ${id}\n\nInga anteckningar ännu.\n`);
      registry.apps.set(id, { id, name: '', faces: DEFAULT_FACES, permissions: [], built: false, status: 'idle', backend: 'none', rev: 1 });
      scene.wins.set(id, { id: `w-${id}`, appId: id, x: 0, y: 0, w: 640, h: 480, scale: 1, face: 0, z: 1, ...(opts.win ?? {}) });
      return dir;
    },
    cleanup() {
      rmrf(home);
    },
  };
  return w;
}

/* ------------------------------ skriptad motor ------------------------------ */

let seq = 0;
const base = (sid: string) => ({ uuid: crypto.randomUUID(), session_id: sid });

export const sdk = {
  init(sid: string, tools: string[] = [], servers = [{ name: 'workbench', status: 'connected', source: 'sdk' }]): SDKMessage {
    return { type: 'system', subtype: 'init', ...base(sid), apiKeySource: 'none', claude_code_version: 'test', cwd: '/', tools, mcp_servers: servers, model: 'm', permissionMode: 'acceptEdits', slash_commands: [], output_style: 'default', skills: [], plugins: [] } as unknown as SDKMessage;
  },
  delta(text: string, parent: string | null = null): SDKMessage {
    return { type: 'stream_event', ...base('s'), parent_tool_use_id: parent, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } } as unknown as SDKMessage;
  },
  text(text: string, parent: string | null = null): SDKMessage {
    return { type: 'assistant', ...base('s'), parent_tool_use_id: parent, message: { id: `m${++seq}`, type: 'message', role: 'assistant', content: [{ type: 'text', text }] } } as unknown as SDKMessage;
  },
  toolUse(id: string, name: string, input: Record<string, unknown>, parent: string | null = null): SDKMessage {
    return { type: 'assistant', ...base('s'), parent_tool_use_id: parent, message: { id: `m${++seq}`, type: 'message', role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } } as unknown as SDKMessage;
  },
  toolResult(id: string, isError = false): SDKMessage {
    return { type: 'user', ...base('s'), parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok', ...(isError ? { is_error: true } : {}) }] } } as unknown as SDKMessage;
  },
  result(o: { subtype?: string; is_error?: boolean; terminal_reason?: string; queued?: number; result?: string; errors?: string[] } = {}): SDKMessage {
    const subtype = o.subtype ?? 'success';
    return {
      type: 'result', ...base('s'), subtype, is_error: o.is_error ?? false,
      ...(subtype === 'success' ? { result: o.result ?? 'klart' } : { errors: o.errors ?? [] }),
      terminal_reason: o.terminal_reason ?? 'completed', queued_turn_count: o.queued ?? 0,
      duration_ms: 1, duration_api_ms: 1, num_turns: 1, stop_reason: null, total_cost_usd: 0, usage: {}, modelUsage: {}, permission_denials: [],
    } as unknown as SDKMessage;
  },
  rateLimit(info: Record<string, unknown>): SDKMessage {
    return { type: 'rate_limit_event', ...base('s'), rate_limit_info: info } as unknown as SDKMessage;
  },
};

/** En skriptad process: testet styr vilka SDK-meddelanden som kommer och ser vilka användarmeddelanden som gick in. */
export class ScriptProc implements EngineQuery {
  options: Options;
  tools: SdkMcpToolDefinition<any>[];
  received: string[] = [];
  interrupts = 0;
  closed = false;
  warmClosed = false;
  inputEnded = false;
  /** Anropas för varje användarmeddelande som processen läser. */
  onMessage: ((text: string, proc: ScriptProc) => void) | null = null;
  /** Anropas vid interrupt(). */
  onInterrupt: ((proc: ScriptProc) => void) | null = null;
  /** Så länge dröjer processen efter att kön stängts (som CLI:t, ungefär 0,6 s i verkligheten). */
  endDelayMs = 5;
  /** Vad självtestet får svar om. */
  statusReply: { name: string; status: string }[] = [{ name: 'workbench', status: 'connected' }];
  memoryReply: { path: string }[] = [];
  #out: SDKMessage[] = [];
  #wake: (() => void) | null = null;
  #done = false;

  constructor(options: Options, tools: SdkMcpToolDefinition<any>[]) {
    this.options = options;
    this.tools = tools;
  }

  attach(prompt: AsyncIterable<SDKUserMessage>): void {
    void (async () => {
      for await (const m of prompt) {
        const c = m.message.content;
        const text = typeof c === 'string' ? c : '';
        this.received.push(text);
        this.onMessage?.(text, this);
      }
      this.inputEnded = true;
      // som CLI:t: avsluta strax efter att kön stängts
      setTimeout(() => this.end(), this.endDelayMs);
    })();
  }

  emit(...msgs: SDKMessage[]): void {
    if (this.#done) return;
    this.#out.push(...msgs);
    this.#wake?.();
  }

  end(): void {
    this.#done = true;
    this.#wake?.();
  }

  /** Simulerar att processen dör med ett fel. */
  crash(err = new Error('process died')): void {
    this.#crash = err;
    this.end();
  }
  #crash: Error | null = null;

  async interrupt(): Promise<unknown> {
    this.interrupts++;
    this.onInterrupt?.(this);
    return { still_queued: [] };
  }

  close(): void {
    this.closed = true;
    this.end();
  }

  async mcpServerStatus() {
    return this.statusReply;
  }

  async getContextUsage() {
    return { memoryFiles: this.memoryReply };
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage> {
    while (true) {
      while (this.#out.length > 0) yield this.#out.shift() as SDKMessage;
      if (this.#done) {
        if (this.#crash) throw this.#crash;
        return;
      }
      await new Promise<void>((r) => {
        this.#wake = r;
      });
      this.#wake = null;
    }
  }
}

export class ScriptEngine implements Engine {
  procs: ScriptProc[] = [];
  startOptions: Options[] = [];
  /** Så många av de kommande startup()-anropen kastar. */
  failNext = 0;
  /** Fördröjning i startup(). */
  startDelayMs = 0;
  /** Körs för varje ny process innan query(). */
  onProc: ((p: ScriptProc) => void) | null = null;
  /** Hur många processer som lever samtidigt (startade och inte avslutade). */
  maxConcurrent = 0;
  /** Transkriptrensningen vid forget (§8.1); saknas den finns inga transkript. */
  deleteTranscripts?: (appDir: string) => Promise<number>;
  #alive = 0;

  async startup(options: Options, tools: SdkMcpToolDefinition<any>[]): Promise<EngineWarm> {
    this.startOptions.push(options);
    if (this.startDelayMs) await sleep(this.startDelayMs);
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('startup failed');
    }
    const proc = new ScriptProc(options, tools);
    this.procs.push(proc);
    this.#alive++;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.#alive);
    const self = this;
    let ended = false;
    const markEnd = () => {
      if (!ended) {
        ended = true;
        self.#alive--;
      }
    };
    const origEnd = proc.end.bind(proc);
    proc.end = () => {
      markEnd();
      origEnd();
    };
    this.onProc?.(proc);
    return {
      query(prompt) {
        proc.attach(prompt);
        return proc;
      },
      close() {
        proc.warmClosed = true;
        proc.end();
      },
    };
  }

  get alive(): number {
    return this.#alive;
  }
}

/** Svarar på varje meddelande med en enkel lyckad tur. */
export function autoReply(proc: ScriptProc, sid = 'sess-1'): void {
  proc.onMessage = (_text, p) => {
    p.emit(sdk.init(sid), sdk.delta('Hej'), sdk.text('Hej!'), sdk.result());
  };
}

export function chatFile(w: World, appId: string): string {
  return path.join(w.paths.appDataDir(appId), 'chat.jsonl');
}

export function readChat(w: World, appId: string): ChatEvent[] {
  try {
    return fs.readFileSync(chatFile(w, appId), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as ChatEvent);
  } catch {
    return [];
  }
}
