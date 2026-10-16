// server/config.ts — konfiguration och miljön för barnprocesser. FRUSET (CONTRACT §3, §4.6).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChildEnv, Config } from './types.ts';

/** Repo-roten: katalogen ovanför server/. */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function int(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const homeRaw = path.resolve(env.WORKBENCH_HOME || ROOT);
  fs.mkdirSync(homeRaw, { recursive: true });
  const home = fs.realpathSync.native(homeRaw);
  const efforts = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
  const stts = ['auto', 'whisper', 'openai', 'off'] as const;
  return {
    port: int(env.WORKBENCH_PORT, 8220),
    hmrPort: int(env.WORKBENCH_HMR_PORT, 8229),
    dev: env.NODE_ENV !== 'production',
    root: ROOT,
    home,
    model: env.WORKBENCH_MODEL || 'claude-opus-5-5',
    effort: efforts.find((e) => e === env.WORKBENCH_EFFORT) ?? 'high',
    fakeClaude: env.WORKBENCH_FAKE_CLAUDE === '1',
    fakeSpeed: Number(env.WORKBENCH_FAKE_SPEED) > 0 ? Number(env.WORKBENCH_FAKE_SPEED) : 1,
    sandbox: env.WORKBENCH_SANDBOX !== '0',
    stt: stts.find((s) => s === env.WORKBENCH_STT) ?? 'auto',
    whisperUrl: env.WHISPER_URL || 'http://127.0.0.1:54205',
    openaiKey: env.OPENAI_API_KEY || undefined,
    idleCloseMs: int(env.WORKBENCH_IDLE_MS, 600_000),
    permissionTimeoutMs: 300_000,
  };
}

/** Variabler som får följa med till barnprocesser. Allt annat (nycklar, CLAUDE_CODE_*, …) stannar i servern. */
const PASS = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TERM'] as const;

export const childEnv: ChildEnv = (extra = {}) => {
  const out: Record<string, string> = {};
  for (const k of PASS) {
    const v = process.env[k];
    if (v !== undefined) out[k] = v;
  }
  return { ...out, ...extra };
};
