// server/claude/engine.ts — det som skiljer riktiga Claude från låtsas-Claude (§8.9): hur processen startas.
// Allt annat (händelser, policy, §8.6, verktygen) är detsamma i sessions.ts.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deleteSession, listSessions, startup } from '@anthropic-ai/claude-agent-sdk';
import type { ListSessionsOptions, Options, SDKMessage, SDKSessionInfo, SDKUserMessage, SdkMcpToolDefinition, SessionMutationOptions } from '@anthropic-ai/claude-agent-sdk';

/** Den del av SDK:ns Query som sessionerna använder. */
export interface EngineQuery extends AsyncIterable<SDKMessage> {
  interrupt(): Promise<unknown>;
  close(): void;
  mcpServerStatus(): Promise<{ name: string; status: string }[]>;
  getContextUsage(opts?: { detail?: 'summary' | 'full' }): Promise<{ memoryFiles: { path: string }[] }>;
}

/** Som SDK:ns WarmQuery: en startad process som tar emot en prompt (en gång). */
export interface EngineWarm {
  query(prompt: AsyncIterable<SDKUserMessage>): EngineQuery;
  close(): void;
}

export interface Engine {
  /** Startar en process med options. tools är samma verktyg som i options.mcpServers.workbench (låtsas-Claude anropar dem direkt). */
  startup(options: Options, tools: SdkMcpToolDefinition<any>[]): Promise<EngineWarm>;
  /**
   * Raderar appens transkript (§8.1 forget): alla sessioner vars cwd är appens mapp. Returnerar antalet.
   * Saknas metoden finns inga transkript att radera (låtsas-Claude).
   */
  deleteTranscripts?(appDir: string): Promise<number>;
}

/** De två SDK-funktionerna som transkriptrensningen använder (utbytbara i tester). */
export interface TranscriptApi {
  listSessions(options?: ListSessionsOptions): Promise<SDKSessionInfo[]>;
  deleteSession(sessionId: string, options?: SessionMutationOptions): Promise<void>;
}

/**
 * Raderar Claude Code-transkripten för en app med SDK:ns listSessions({ dir }) och deleteSession (§8.1).
 * De ligger annars kvar i användarens ~/.claude/projects/. Två spärrar gör att inget annat raderas:
 * - includeWorktrees: false, så att sessioner i andra arbetsträd av ett git-repo som omger mappen aldrig listas;
 * - bara sessioner vars cwd är just appens mapp (realpath) raderas. Saknas cwd raderas sessionen inte.
 */
export async function deleteTranscripts(appDir: string, api: TranscriptApi = { listSessions, deleteSession }): Promise<number> {
  const real = await fs.promises.realpath(appDir).catch(() => path.resolve(appDir));
  const own = new Set([path.resolve(appDir), real]);
  const seen = new Set<string>();
  let n = 0;
  for (const dir of own) {
    let list: SDKSessionInfo[];
    try {
      // includeProgrammatic: appens sessioner startas från SDK:n (entrypoint sdk-ts).
      list = await api.listSessions({ dir, includeWorktrees: false, includeProgrammatic: true });
    } catch {
      continue;
    }
    for (const s of list) {
      if (seen.has(s.sessionId) || typeof s.cwd !== 'string' || !own.has(path.resolve(s.cwd))) continue;
      seen.add(s.sessionId);
      try {
        await api.deleteSession(s.sessionId, { dir });
        n++;
      } catch {
        /* redan borta */
      }
    }
  }
  await removeEmptyProjectDirs(own);
  return n;
}

/** Katalogen där Claude Code och SDK:ns listSessions/deleteSession lägger transkripten. */
export function claudeConfigDir(): string {
  const v = process.env.CLAUDE_CONFIG_DIR?.trim();
  return v ? v : path.join(os.homedir(), '.claude');
}

/**
 * Claude Codes namn på projektkatalogen för en cwd, som SDK:n räknar det: allt utom [a-zA-Z0-9] blir '-',
 * och namn över 200 tecken kortas och får cwd:ns strängkod (base 36) som svans.
 */
export function projectDirName(cwd: string): string {
  const s = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  if (s.length <= 200) return s;
  let h = 0;
  for (let i = 0; i < cwd.length; i++) h = ((h << 5) - h + cwd.charCodeAt(i)) | 0;
  return `${s.slice(0, 200)}-${Math.abs(h).toString(36)}`;
}

/**
 * Tar bort appens projektkataloger under <config>/projects när transkripten är raderade (K7).
 * Bara rmdir, aldrig rekursivt: ligger något kvar (en annan cwd med samma namn, en fil vi inte känner)
 * får katalogen stå. rm är utbytbar i tester, så att en planterad rekursiv rensning kan fälla testet.
 * Kortade namn (över 200 tecken) matchas på prefixet, som SDK:n själv gör: CLI:t kan räkna hashen annorlunda.
 */
export async function removeEmptyProjectDirs(
  dirs: Iterable<string>,
  rm: (p: string) => Promise<unknown> = (p) => fs.promises.rmdir(p),
): Promise<number> {
  const projects = path.join(claudeConfigDir(), 'projects');
  const names = new Set<string>();
  for (const dir of new Set(dirs)) {
    const name = projectDirName(dir);
    if (name.length <= 200) {
      names.add(name);
      continue;
    }
    const prefix = name.slice(0, 201);
    for (const e of await fs.promises.readdir(projects).catch(() => [] as string[])) if (e.startsWith(prefix)) names.add(e);
  }
  let n = 0;
  for (const name of names) {
    try {
      await rm(path.join(projects, name));
      n++;
    } catch {
      /* finns inte, eller inte tom */
    }
  }
  return n;
}

/** Riktiga Claude Code via Agent SDK:ns startup() (§8.1). */
export const sdkEngine: Engine = {
  async startup(options) {
    return await startup({ options });
  },
  deleteTranscripts: (appDir) => deleteTranscripts(appDir),
};

/**
 * Kön av användarmeddelanden som är promptens AsyncIterable i strömmande läge.
 * Meddelanden som läggs i kön innan processen startat levereras när den läser kön.
 */
export class InputQueue implements AsyncIterable<SDKUserMessage> {
  #buf: SDKUserMessage[] = [];
  #wake: (() => void) | null = null;
  #ended = false;

  get ended(): boolean {
    return this.#ended;
  }

  /** Antal meddelanden som ännu inte lämnats till processen. */
  get pending(): number {
    return this.#buf.length;
  }

  push(text: string): string {
    const uuid = crypto.randomUUID();
    if (this.#ended) return uuid;
    this.#buf.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, uuid });
    this.#wake?.();
    return uuid;
  }

  /** Tar bort de k senaste meddelandena som ännu inte lämnats till processen; returnerar hur många. */
  dropLast(k: number): number {
    const n = Math.max(0, Math.min(k, this.#buf.length));
    this.#buf.splice(this.#buf.length - n, n);
    return n;
  }

  /** Tar bort meddelanden som ännu inte lämnats till processen. */
  drain(): number {
    const n = this.#buf.length;
    this.#buf.length = 0;
    return n;
  }

  end(): void {
    this.#ended = true;
    this.#wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.#buf.length > 0) yield this.#buf.shift() as SDKUserMessage;
      if (this.#ended) return;
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
      this.#wake = null;
    }
  }
}
