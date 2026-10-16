// server/claude/policy.ts — Workbenchens policy för Claudes verktygsanrop (CONTRACT §8.5).
// Körs först i canUseTool. Nekandet går direkt till Claude (på engelska); inget ask skickas.
// Sökvägar prövas på realpath av närmaste befintliga förfader, så att symboliska länkar och
// skiftlägesvarianter (APFS) inte kan peka ut ur appens mapp.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PermissionResult, PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';

/** Fält som alltid är sökvägar och därför alltid prövas, även relativa. */
const PATH_FIELDS = new Set(['file_path', 'notebook_path', 'path']);
/** Fritextfält som aldrig är sökvägar (beskrivningar, filinnehåll). */
const FREE_TEXT_FIELDS = new Set(['description', 'prompt', 'content', 'old_string', 'new_string', 'new_source']);
/** Verktyg vars indata bara är text till användaren eller Claude själv. */
const TEXT_ONLY_TOOLS = new Set(['AskUserQuestion', 'TodoWrite']);
/** Verktyg som skriver filer: under .claude/ nekas de. */
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

const MAX_STRINGS = 500;
const MAX_PATH_LEN = 4096;

/** Hemligheterna (request_secret) i Bash-kommandon, i alla skiftlägen. */
const SECRETS_RE = /secrets\.json/i;
const SECRETS_DENIAL =
  'Blocked by Workbench: data/secrets.json holds the user\'s secrets. Never read, print or change it; the back end reads it at run time via DATA_DIR.';

/** git som eget ord, även som sökväg (/usr/bin/git) och git-underkommandon (git-lfs), men inte "digit" eller "github". */
const GIT_RE = /(?:^|[^\w.-])git(?:$|[^\w.])/i;

export interface PolicyCheck {
  /** Appens mapp, realpath. */
  appReal: string;
  toolName: string;
  input: Record<string, unknown>;
  /** canUseTool-optionen blockedPath, om Claude Code satt den. */
  blockedPath?: string;
  /** Om Claudes Bash körs i sandlådan. */
  sandbox: boolean;
}

/** Ligger p (absolut, normaliserad) i root eller under root? */
export function isInside(root: string, p: string): boolean {
  const rel = path.relative(root, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Realpath av närmaste befintliga förfader, med den icke-existerande resten tillagd.
 * Relativa sökvägar tolkas mot base; "~" och "~/" mot hemkatalogen.
 * Ingen lexikal normalisering före realpath: "länk/../x" löses som kärnan gör det.
 */
export async function resolveReal(p: string, base: string): Promise<string> {
  let s = p;
  if (s === '~' || s.startsWith('~/')) s = os.homedir() + s.slice(1);
  if (!s.startsWith('/')) s = base + '/' + s;
  const tail: string[] = [];
  let cur = s;
  for (let i = 0; i < 4096; i++) {
    try {
      const real = await fs.promises.realpath(cur);
      return path.join(real, ...tail.reverse());
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'ELOOP') throw err; // symbolisk länk i en slinga: neka
      const parent = path.dirname(cur);
      if (parent === cur) return path.join('/', ...tail.reverse());
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
  throw new Error('path too deep');
}

/** Alla strängar i input (rekursivt) som ska prövas, med fältnamnet de låg i. */
function candidates(toolName: string, input: unknown): { value: string; field: string }[] {
  const out: { value: string; field: string }[] = [];
  if (TEXT_ONLY_TOOLS.has(toolName)) return out;
  const walk = (v: unknown, field: string, depth: number): void => {
    if (out.length >= MAX_STRINGS || depth > 8) return;
    if (typeof v === 'string') {
      if (FREE_TEXT_FIELDS.has(field)) return;
      if (v.length === 0 || v.length > MAX_PATH_LEN || /[\r\n]/.test(v)) return;
      if (PATH_FIELDS.has(field) || v.startsWith('/') || v.startsWith('~') || v.includes('..')) out.push({ value: v, field });
    } else if (Array.isArray(v)) {
      for (const x of v) walk(x, field, depth + 1);
    } else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, k, depth + 1);
    }
  };
  walk(input, '', 0);
  return out;
}

/**
 * Policyn (§8.5 punkt 1). Returnerar ett meddelande till Claude om anropet nekas, annars null.
 */
export async function checkPolicy(c: PolicyCheck): Promise<string | null> {
  const list = candidates(c.toolName, c.input);
  if (typeof c.blockedPath === 'string' && c.blockedPath) list.push({ value: c.blockedPath, field: 'blockedPath' });
  for (const { value, field } of list) {
    let real: string;
    try {
      if (value.includes('\0')) throw new Error('NUL');
      real = await resolveReal(value, c.appReal);
    } catch {
      return `Blocked by Workbench: the path ${JSON.stringify(value)} cannot be resolved safely. Work only inside this app's folder.`;
    }
    if (!isInside(c.appReal, real)) {
      return `Blocked by Workbench: ${JSON.stringify(value)} is outside this app's folder. Work only inside the app folder (your current working directory).`;
    }
    // Hemligheterna (SEC-2): deny-reglerna i options.ts är huvudspärren; det här fångar resten (t.ex. Bash utan sandlåda).
    if (path.relative(c.appReal, real).toLowerCase() === path.join('data', 'secrets.json')) return SECRETS_DENIAL;
    if (WRITE_TOOLS.has(c.toolName) && PATH_FIELDS.has(field)) {
      const segs = path.relative(c.appReal, real).split(path.sep);
      if (segs.some((s) => s.toLowerCase() === '.claude')) {
        return 'Blocked by Workbench: .claude/ holds Claude Code configuration (hooks and permissions) and must not be changed in an app.';
      }
    }
  }
  if (c.toolName === 'Bash' && SECRETS_RE.test(String(c.input.command ?? ''))) return SECRETS_DENIAL;
  if (!c.sandbox && c.toolName === 'Bash' && GIT_RE.test(String(c.input.command ?? ''))) {
    return 'Blocked by Workbench: git is not available here. Workbench commits the app folder after every turn, and the user can undo a turn.';
  }
  return null;
}

/* ------------------------- frågekortet (§8.5 punkt 3) ------------------------- */

export interface PermissionOpts {
  suggestions?: PermissionUpdate[];
  defaultToNo?: boolean;
  suppressAlwaysAllowRule?: boolean;
}

export interface PermissionCard {
  title: string;
  detail: string;
  /** Regler som "Alltid" ger, alltid med destination 'session'. */
  remember: PermissionUpdate[];
  canRemember: boolean;
  defaultNo: boolean;
}

/** Bara addRules med behavior allow, omskrivna till processens livstid. Aldrig setMode, addDirectories eller en fil. */
export function rememberFrom(suggestions: PermissionUpdate[] | undefined): PermissionUpdate[] {
  const out: PermissionUpdate[] = [];
  for (const s of suggestions ?? []) {
    if (s.type === 'addRules' && s.behavior === 'allow') out.push({ ...s, destination: 'session' });
  }
  return out;
}

function shortJson(v: unknown, max = 300): string {
  let s: string;
  try {
    s = JSON.stringify(v) ?? '';
  } catch {
    s = String(v);
  }
  const cps = Array.from(s);
  return cps.length > max ? cps.slice(0, max - 1).join('') + '…' : s;
}

/** Titel och detalj för frågekortet. Titlarna är svenska; detaljen är adressen, värdnamnet, kommandot eller kort JSON. */
export function permissionCard(toolName: string, input: Record<string, unknown>, opts: PermissionOpts): PermissionCard {
  let title: string;
  let detail: string;
  if (toolName === 'WebFetch') {
    title = 'Hämta från nätet?';
    detail = typeof input.url === 'string' ? input.url : shortJson(input);
  } else if (toolName === 'SandboxNetworkAccess') {
    title = 'Hämta från nätet?';
    detail = typeof input.host === 'string' ? input.host : shortJson(input);
  } else if (toolName === 'Bash') {
    title = 'Köra ett kommando?';
    detail = typeof input.command === 'string' ? input.command : shortJson(input);
  } else {
    title = `Använda ${toolName}?`;
    detail = shortJson(input);
  }
  const cps = Array.from(detail);
  if (cps.length > 2000) detail = cps.slice(0, 1999).join('') + '…';
  const remember = rememberFrom(opts.suggestions);
  return {
    title,
    detail,
    remember,
    canRemember: remember.length > 0 && !opts.suppressAlwaysAllowRule,
    defaultNo: !!opts.defaultToNo,
  };
}

/** Användarens svar på frågekortet som PermissionResult till Claude Code. */
export function permissionResult(
  decision: 'allow' | 'allow-always' | 'deny' | 'answered' | 'timeout' | 'cancelled',
  input: Record<string, unknown>,
  card: Pick<PermissionCard, 'remember' | 'canRemember'>,
): PermissionResult {
  if (decision === 'allow') return { behavior: 'allow', updatedInput: input };
  if (decision === 'allow-always') {
    return card.canRemember
      ? { behavior: 'allow', updatedInput: input, updatedPermissions: card.remember }
      : { behavior: 'allow', updatedInput: input };
  }
  if (decision === 'timeout') return { behavior: 'deny', message: 'The user did not answer in time, so this was not allowed.' };
  if (decision === 'cancelled') return { behavior: 'deny', message: 'The turn was stopped.' };
  return { behavior: 'deny', message: 'The user said no.' };
}
