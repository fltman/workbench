// server/claude/options.ts — Options till Agent SDK:n för en apps session (CONTRACT §8.2, uppmätta och obligatoriska).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import type { CanUseTool, Options, SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { childEnv } from '../config.ts';
import type { Config } from '../types.ts';

export const TOOLS = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'AskUserQuestion', 'TodoWrite'];

export const NETWORK_DOMAINS = ['registry.npmjs.org', 'esm.sh', 'cdn.jsdelivr.net'];

/** Finns macOS-sandlådan? Saknas sandbox-exec körs allt osandlådat (§4.5). */
export function sandboxAvailable(): boolean {
  return process.platform === 'darwin' && fs.existsSync('/usr/bin/sandbox-exec');
}

/** Nodes installationsprefix (…/bin/node → …), om det ligger under hemkatalogen; annars undefined. */
export function nodePrefixUnderHome(execPath = process.execPath, home = os.homedir()): string | undefined {
  const prefix = path.resolve(path.dirname(execPath), '..');
  const rel = path.relative(home, prefix);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? prefix : undefined;
}

export interface OptionsInput {
  config: Config;
  /** realpath(apps/<id>) */
  appReal: string;
  /** <home>/apps */
  appsDir: string;
  /** Om Claudes Bash körs i sandlådan (config.sandbox och sandbox-exec finns). */
  sandbox: boolean;
  /** server/claude/app-rules.md */
  appRules: string;
  tools: SdkMcpToolDefinition<any>[];
  canUseTool: CanUseTool;
  resume?: string;
  stderr: (data: string) => void;
}

/** Appens hemligheter (request_secret, §8.7). Claude får aldrig läsa eller skriva filen (SEC-2). */
export function secretsFile(appReal: string): string {
  return path.join(appReal, 'data', 'secrets.json');
}

/** Appens egen TMPDIR, apps/<id>/data/tmp (SEC-3): samma katalog som backenden får (supervisor.ts). */
export function appTmpDir(appReal: string): string {
  return path.join(appReal, 'data', 'tmp');
}

/** Den delade TMPDIR:en (realpath), som Claudes sandlåda inte får läsa: där ligger andra appars och programs filer. */
function sharedTmp(): string[] {
  try {
    return [fs.realpathSync.native(os.tmpdir())];
  } catch {
    return [];
  }
}

/**
 * Behörighetsregler som nekar Claudes egna verktyg hemligheterna (SEC-2). Deny-regler går före allt annat,
 * även acceptEdits och läsningar inne i cwd, där canUseTool aldrig tillfrågas. Read täcker också Grep och Glob,
 * Edit täcker Write och Edit. "//" betyder absolut sökväg i Claude Codes regelsyntax.
 */
export function secretDenyRules(appReal: string): string[] {
  const abs = '/' + secretsFile(appReal);
  return [`Read(${abs})`, `Edit(${abs})`];
}

/** Miljön för Claude Code-processen: vitlistan från childEnv plus isoleringsväxlarna (§8.2). */
export function claudeEnv(appReal: string, appsDir: string): Record<string, string> {
  return childEnv({
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
    CLAUDE_AGENT_SDK_CLIENT_APP: 'workbench/0.1',
    GIT_CEILING_DIRECTORIES: appsDir,
    npm_config_cache: path.join(appReal, 'node_modules', '.cache', 'npm'),
    npm_config_update_notifier: 'false',
    TMPDIR: appTmpDir(appReal),
  });
}

/**
 * Det som är gemensamt för engångsfrågorna (förslagen §8.12, fältet §8.13): samma isolering som appens session, utan
 * verktyg, MCP-servrar och transkript, och canUseTool nekar allt. Körs frågan i en apps mapp (appReal) gäller också
 * deny-reglerna för hemligheterna, eftersom canUseTool aldrig tillfrågas om läsningar inne i cwd (§8.5). Inget
 * sandlådeblock: det gäller bara Bash, som frågorna inte har.
 */
export function oneShotOptions(o: { cwd: string; appsDir: string; appReal?: string }): Options {
  return {
    cwd: o.cwd,
    env: claudeEnv(o.cwd, o.appsDir),
    settingSources: [],
    strictMcpConfig: true,
    mcpServers: {},
    settings: { crossSessionInbound: 'refuse', disableAllHooks: true, ...(o.appReal ? { permissions: { deny: secretDenyRules(o.appReal) } } : {}) },
    tools: [],
    allowedTools: [],
    canUseTool: async () => ({ behavior: 'deny', message: 'Inga verktyg här.' }),
    permissionMode: 'default',
    persistSession: false,
    maxTurns: 3,
    stderr: () => {},
  };
}

export function buildOptions(o: OptionsInput): Options {
  const nodePrefix = nodePrefixUnderHome();
  const allowRead = [o.appReal, ...(nodePrefix ? [nodePrefix] : [])];
  // WORKBENCH_HOME nekas också (data/, andra appar) ifall den inte ligger under hemkatalogen.
  // Den delade TMPDIR:en nekas (SEC-3), och hemligheterna (SEC-2) står både här och som credentials.files.
  const denyRead = [
    os.homedir(),
    ...(isUnder(o.config.home, os.homedir()) ? [] : [o.config.home]),
    ...sharedTmp().filter((t) => !isUnder(o.appReal, t)),
    secretsFile(o.appReal),
  ];
  return {
    cwd: o.appReal,
    env: claudeEnv(o.appReal, o.appsDir),
    settingSources: [],
    strictMcpConfig: true,
    settings: { crossSessionInbound: 'refuse', disableAllHooks: true, permissions: { deny: secretDenyRules(o.appReal) } },
    tools: [...TOOLS],
    mcpServers: { workbench: createSdkMcpServer({ name: 'workbench', version: '0.1.0', tools: o.tools, alwaysLoad: true }) },
    allowedTools: ['mcp__workbench__*', 'WebSearch', ...(o.sandbox ? [] : ['Bash(npm install:*)', 'Bash(npm i:*)', 'Bash(npm ci:*)'])],
    sandbox: o.sandbox
      ? {
          enabled: true,
          failIfUnavailable: true,
          autoAllowBashIfSandboxed: true,
          allowUnsandboxedCommands: false,
          network: { allowedDomains: [...NETWORK_DOMAINS] },
          filesystem: {
            allowWrite: [o.appReal],
            denyWrite: [path.join(o.appReal, '.claude'), secretsFile(o.appReal)],
            denyRead,
            allowRead,
          },
          // allowRead (appens mapp) går före denyRead för matchande sökvägar; credentials.files deny är
          // sandlådans egen spärr för filer med hemligheter.
          credentials: { files: [{ path: secretsFile(o.appReal), mode: 'deny' }] },
        }
      : undefined,
    systemPrompt: { type: 'preset', preset: 'claude_code', append: o.appRules },
    permissionMode: 'acceptEdits',
    includePartialMessages: true,
    model: o.config.model,
    effort: o.config.effort,
    canUseTool: o.canUseTool,
    ...(o.resume ? { resume: o.resume } : {}),
    stderr: o.stderr,
  };
}

function isUnder(p: string, root: string): boolean {
  const rel = path.relative(root, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
