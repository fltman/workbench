// server/claude/tools.ts — de sex MCP-verktygen i servern "workbench", bundna till sessionens app (CONTRACT §8.7).
// En ny uppsättning skapas för varje process (createSdkMcpServer kan bara ha en transport).
import http from 'node:http';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { AskDecision } from '../../shared/protocol.ts';
import type { AppLogs, AppRegistry, Backends, Paths, Shots } from '../types.ts';
import { SAMPLE_KINDS } from './samples.ts';
import type { SampleKind } from './samples.ts';
import { SECRET_KEY_RE, SecretStoreError, storeSecret } from './secrets.ts';
import { apiKey, dragProblem, openItem } from './shots.ts';
import type { TryInput, TryShots, TryStep } from './shots.ts';

export const LOG_LINES_DEFAULT = 80;
export const LOG_LINES_MAX = 400;
export const BACKEND_TIMEOUT_MS = 15_000;
export const BACKEND_BODY_MAX = 20 * 1024;
/** call_backend:s body_base64, avkodad. */
export const BACKEND_BINARY_MAX = 256 * 1024;

type ToolResult = { content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[]; isError?: boolean };

function text(t: string): ToolResult {
  return { content: [{ type: 'text', text: t }] };
}

function fail(t: string): ToolResult {
  return { content: [{ type: 'text', text: t }], isError: true };
}

/** Konsolrader som tillkommit sedan förra omladdningen; överlever processbyten. */
export interface ReloadMemory {
  prev: string[];
}

export interface ToolDeps {
  appId: string;
  paths: Paths;
  registry: AppRegistry;
  backends: Backends;
  logs: AppLogs;
  shots: Shots;
  /** Visar ett lösenordsfält i HUD:en och väntar på svaret. Värdet går bara hit och vidare till secrets.json. */
  askSecret(key: string, label: string, signal?: AbortSignal): Promise<{ decision: AskDecision; value?: string }>;
  reload: ReloadMemory;
}

/**
 * Minnet för reload_app i en ny session börjar vid loggens nuvarande slut. Då rapporterar den första omladdningen
 * bara fel som kommit sedan sessionen startade, inte gamla rader (loggen fylls från logs.txt efter en omstart).
 */
export function reloadMemory(logs: AppLogs, appId: string): ReloadMemory {
  return { prev: logs.tail(appId, LOG_LINES_MAX) };
}

/** Raderna i cur som kommit efter de rader som fanns i prev (loggens slut jämförs, tidsstämplar gör raderna unika nog). */
export function linesSince(prev: string[], cur: string[]): string[] {
  if (prev.length === 0) return cur;
  const k = Math.min(prev.length, 8);
  const anchor = prev.slice(prev.length - k);
  for (let end = cur.length - 1; end >= k - 1; end--) {
    let match = true;
    for (let j = 0; j < k; j++) {
      if (cur[end - k + 1 + j] !== anchor[j]) {
        match = false;
        break;
      }
    }
    if (match) return cur.slice(end + 1);
  }
  return cur;
}

const SOURCE_RE = (src: string) => new RegExp(`^\\S+ \\[${src}\\] `);

/**
 * De senaste n raderna från backenden och från workbenchen. Supervisorn skriver orsaken till att en start
 * vägrades eller en backend stoppades med källan workbench, så båda behövs för att Claude ska se varför (§8.7).
 */
export function backendTail(logs: Pick<AppLogs, 'tail'>, appId: string, n: number): string[] {
  const re = /^\S+ \[(?:backend|workbench)\] /;
  return logs.tail(appId, LOG_LINES_MAX).filter((l) => re.test(l)).slice(-n);
}

/** reload_app: refresh → backends.restart (villkorslöst) → bumpRev (§8.7). */
export async function reloadApp(d: ToolDeps): Promise<ToolResult> {
  d.registry.refresh(d.appId);
  // Villkorslöst: utan backend i manifestet stoppar restart en kvarvarande process och sätter 'none'.
  let port: number | null = null;
  try {
    port = await d.backends.restart(d.appId);
  } catch {
    port = null;
  }
  let backend = 'none';
  if (d.registry.manifest(d.appId).backend) {
    const state = d.backends.state(d.appId);
    if (port && state === 'running') backend = `running on port ${port}`;
    else {
      const tail = backendTail(d.logs, d.appId, 20);
      backend = 'crashed' + (tail.length ? `\nLast back end log lines:\n${tail.join('\n')}` : '');
    }
  }
  d.registry.bumpRev(d.appId);
  const cur = d.logs.tail(d.appId, LOG_LINES_MAX);
  const re = SOURCE_RE('console');
  const errors = linesSince(d.reload.prev, cur).filter((l) => re.test(l)).slice(-40);
  d.reload.prev = cur;
  const lines = [`Reloaded. Back end: ${backend}`];
  lines.push(errors.length ? `Console errors since the last reload:\n${errors.join('\n')}` : 'No console errors since the last reload.');
  return text(lines.join('\n'));
}

export async function screenshotApp(d: ToolDeps, face: string | undefined): Promise<ToolResult> {
  // manifest() är en ögonblicksbild till nästa refresh: en sida som lagts till under turen ska gå att se.
  d.registry.refresh(d.appId);
  try {
    const shot = await d.shots.screenshot(d.appId, face);
    return {
      content: [
        { type: 'image', data: shot.png.toString('base64'), mimeType: 'image/png' },
        { type: 'text', text: `${shot.w}×${shot.h}, face ${shot.face}` },
      ],
    };
  } catch (err) {
    return fail(`Screenshot failed: ${(err as Error)?.message ?? String(err)}`);
  }
}

export function getAppLogs(d: ToolDeps, lines: number | undefined): ToolResult {
  const n = Math.min(LOG_LINES_MAX, Math.max(1, Math.floor(Number.isFinite(lines) ? (lines as number) : LOG_LINES_DEFAULT)));
  const out = d.logs.tail(d.appId, n);
  return text(out.length ? out.join('\n') : 'No log lines yet.');
}

const HOP_BY_HOP = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive', 'upgrade', 'proxy-connection', 'te', 'trailer', 'expect']);
const TOKEN_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;

/** Huvudena som skickas vidare: giltiga namn, inga radbrytningar, inga hopp-för-hopp-huvuden; namnen med gemener. */
function cleanHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const h: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers ?? {})) {
    const lk = k.toLowerCase();
    if (HOP_BY_HOP.has(lk) || !TOKEN_RE.test(k) || typeof v !== 'string' || /[\r\n\0]/.test(v)) continue;
    h[lk] = v;
  }
  return h;
}

/** En förfrågan till appens egen backend på 127.0.0.1 med Host 127.0.0.1:<port>, högst 15 s, svaret högst 20 kB. */
export function requestBackend(
  port: number,
  method: string,
  reqPath: string,
  body: string | Buffer | undefined,
  headers: Record<string, string> | undefined,
  timeoutMs = BACKEND_TIMEOUT_MS,
): Promise<ToolResult> {
  return new Promise((resolve) => {
    const h = cleanHeaders(headers);
    h.host = `127.0.0.1:${port}`;
    const payload = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
    if (payload) {
      h['content-length'] = String(payload.length);
      if (!h['content-type']) h['content-type'] = typeof body !== 'string' ? 'application/octet-stream' : /^\s*[[{]/.test(body) ? 'application/json' : 'text/plain; charset=utf-8';
    }
    let settled = false;
    const finish = (r: ToolResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const req = http.request({ host: '127.0.0.1', port, method, path: reqPath, headers: h }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let truncated = false;
      const done = () => {
        const buf = Buffer.concat(chunks).subarray(0, BACKEND_BODY_MAX);
        const bodyText = new TextDecoder('utf-8', { fatal: false }).decode(buf);
        const ct = res.headers['content-type'] ?? '(none)';
        finish(text(`HTTP ${res.statusCode}\ncontent-type: ${ct}\n\n${bodyText}${truncated ? '\n… (truncated at 20 kB)' : ''}`));
      };
      res.on('data', (c: Buffer) => {
        if (size >= BACKEND_BODY_MAX) {
          truncated = true;
          res.destroy();
          done();
          return;
        }
        chunks.push(c);
        size += c.length;
        if (size > BACKEND_BODY_MAX) truncated = true;
      });
      res.on('end', done);
      res.on('error', () => done());
    });
    const timer = setTimeout(() => {
      req.destroy();
      finish(fail(`The request to ${reqPath} timed out after ${Math.round(timeoutMs / 1000)} s.`));
    }, timeoutMs);
    req.on('error', (err) => finish(fail(`The request to ${reqPath} failed: ${(err as NodeJS.ErrnoException).code ?? err.message}`)));
    req.end(payload);
  });
}

const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** body_base64 avkodad, eller ett fel till Claude: standard-base64, högst 256 kB, och en uttrycklig content-type. */
export function binaryBody(b64: unknown, headers: Record<string, string> | undefined): Buffer | string {
  const s = String(b64 ?? '').replace(/\s+/g, '');
  if (!BASE64_RE.test(s)) return 'body_base64 must be standard base64 (A–Z, a–z, 0–9, + and /, padded with =).';
  if (s.length > Math.ceil(BACKEND_BINARY_MAX / 3) * 4 + 4) return 'body_base64 is at most 256 kB decoded.';
  const bytes = Buffer.from(s, 'base64');
  if (bytes.length > BACKEND_BINARY_MAX) return 'body_base64 is at most 256 kB decoded.';
  if (!cleanHeaders(headers)['content-type']?.trim()) return 'body_base64 needs an explicit content-type header, for example { "content-type": "image/png" }.';
  return bytes;
}

export async function callBackend(
  d: ToolDeps,
  args: { method: string; path: string; body?: string; body_base64?: string; headers?: Record<string, string> },
): Promise<ToolResult> {
  const method = String(args.method ?? '').toUpperCase();
  if (!(METHODS as readonly string[]).includes(method)) return fail(`Unsupported method ${JSON.stringify(args.method)}. Use one of ${METHODS.join(', ')}.`);
  const p = String(args.path ?? '');
  if (!p.startsWith('/api/') || /[\s\0\\#]/.test(p) || p.length > 2048) return fail('path must start with /api/ and contain no spaces, backslashes or fragments.');
  let body: string | Buffer | undefined = args.body;
  if (args.body_base64 !== undefined) {
    if (args.body !== undefined) return fail('Pass either body or body_base64, not both.');
    const bin = binaryBody(args.body_base64, args.headers);
    if (typeof bin === 'string') return fail(bin);
    body = bin;
  }
  d.registry.refresh(d.appId); // en backend som lagts till i app.json under turen
  if (!d.registry.manifest(d.appId).backend) return fail('This app has no back end. Add "backend": { "entry": "server.mjs" } to app.json, then call reload_app.');
  let port: number | null = null;
  try {
    port = await d.backends.ensure(d.appId);
  } catch {
    port = null;
  }
  if (!port) {
    const tail = backendTail(d.logs, d.appId, 20);
    return fail(`The back end is not running.${tail.length ? `\nLast back end log lines:\n${tail.join('\n')}` : ' See get_app_logs.'}`);
  }
  return requestBackend(port, method, p, body, args.headers);
}

export async function requestSecret(d: ToolDeps, key: string, label: string, signal?: AbortSignal): Promise<ToolResult> {
  if (!SECRET_KEY_RE.test(key)) return fail('key must match [a-z0-9_]{1,64}.');
  const lbl = Array.from(String(label ?? '').replace(/\s+/g, ' ').trim()).slice(0, 120).join('') || key;
  const r = await d.askSecret(key, lbl, signal);
  if (r.decision === 'answered' && typeof r.value === 'string') {
    try {
      storeSecret(d.paths.appDir(d.appId), key, r.value);
    } catch (err) {
      return fail(err instanceof SecretStoreError ? err.message : 'The secret could not be stored.');
    }
    return text(`Stored in data/secrets.json as "${key}".`);
  }
  if (r.decision === 'timeout') return fail('The user did not answer in time. Nothing was stored.');
  if (r.decision === 'cancelled') return fail('The turn was stopped. Nothing was stored.');
  return fail('The user declined. Nothing was stored.');
}

/** try_app: gränserna för indata (K8). */
export const TRY_MAX_STEPS = 20;
export const TRY_MAX_INPUT = 16 * 1024;
export const TRY_MAX_SEED = 64 * 1024;
export const TRY_MAX_API = 64 * 1024;
export const TRY_MAX_API_KEYS = 20;
const TRY_KEY_RE = /^[A-Za-z0-9._-]{1,100}$/;
const ACTIONS = ['click', 'hover', 'fill', 'type', 'press', 'wait', 'shot', 'drag', 'upload', 'drop', 'paste', 'open'] as const;

type TryArgs = { steps: TryStep[]; store?: TryInput['store']; api?: TryInput['api']; face?: string };

/** Validerar try_app-indata; returnerar ett felmeddelande till Claude eller null. */
export function checkTryInput(input: TryArgs): string | null {
  let size = 0;
  try {
    // store och api har egna tak (64 kB var); resten (stegen) högst TRY_MAX_INPUT.
    size = JSON.stringify({ ...input, store: undefined, api: undefined }).length;
  } catch {
    return 'The input could not be read.';
  }
  if (size > TRY_MAX_INPUT) return `The input is too large (at most ${TRY_MAX_INPUT} characters).`;
  if (!Array.isArray(input.steps) || input.steps.length < 1 || input.steps.length > TRY_MAX_STEPS) return `steps must have 1–${TRY_MAX_STEPS} entries.`;
  let shots = 0;
  for (const [i, st] of input.steps.entries()) {
    const n = i + 1;
    const acts = ACTIONS.filter((a) => (st as Record<string, unknown>)[a] !== undefined && (a !== 'shot' || st.shot === true));
    if (acts.length !== 1) return `Step ${n} must have exactly one of ${ACTIONS.join(', ')}.`;
    const sel = st.click ?? st.hover ?? st.fill ?? st.upload ?? st.drop ?? st.paste ?? (typeof st.wait === 'string' ? st.wait : undefined);
    if (sel !== undefined && (typeof sel !== 'string' || sel.length === 0 || sel.length > 200)) return `Step ${n}: the selector must be 1–200 characters.`;
    const filing = st.upload !== undefined || st.drop !== undefined || st.paste !== undefined;
    if (filing && !SAMPLE_KINDS.includes(st.sample as SampleKind)) return `Step ${n}: sample must be one of ${SAMPLE_KINDS.join(', ')}.`;
    if (!filing && st.sample !== undefined) return `Step ${n}: sample goes with upload, drop or paste.`;
    if (st.open !== undefined && !openItem(st.open)) {
      return `Step ${n}: open must be {"kind":"url","url":"https://…"}, {"kind":"date","date":"YYYY-MM-DD"} or {"kind":"text","text":"…"} (at most 2000 characters).`;
    }
    if (st.text !== undefined && (typeof st.text !== 'string' || st.text.length > 500)) return `Step ${n}: text is at most 500 characters.`;
    if (st.type !== undefined && (typeof st.type !== 'string' || st.type.length > 500)) return `Step ${n}: type is at most 500 characters.`;
    if (st.press !== undefined && (typeof st.press !== 'string' || st.press.length === 0 || st.press.length > 32)) return `Step ${n}: press is 1–32 characters.`;
    if (typeof st.wait === 'number' && !(st.wait >= 0 && st.wait <= 3000)) return `Step ${n}: wait in ms is 0–3000.`;
    if (st.shot === true && ++shots > 2) return 'At most 2 shot steps.';
    // Fönstrets storlek är inte känd här; tryRun prövar punkterna mot den och ger en FAIL-rad.
    const dragBad = st.drag !== undefined ? dragProblem(st.drag) : null;
    if (dragBad) return `Step ${n}: ${dragBad}`;
  }
  const store = input.store;
  if (store !== undefined && store !== 'copy' && store !== 'empty') {
    if (!store || typeof store !== 'object' || Array.isArray(store)) return 'store must be "copy", "empty" or an object of sample values.';
    if (JSON.stringify(store).length > TRY_MAX_SEED) return `The store seed is at most ${TRY_MAX_SEED} characters.`;
    for (const k of Object.keys(store)) if (!TRY_KEY_RE.test(k) || k === '.' || k === '..') return `Invalid store key ${JSON.stringify(k)}.`;
  }
  const api = input.api;
  if (api !== undefined) {
    if (!api || typeof api !== 'object' || Array.isArray(api)) return 'api must be an object of paths and JSON responses.';
    const keys = Object.keys(api);
    if (keys.length > TRY_MAX_API_KEYS) return `api has at most ${TRY_MAX_API_KEYS} paths.`;
    if (JSON.stringify(api).length > TRY_MAX_API) return `api is at most ${TRY_MAX_API} characters.`;
    for (const k of keys) if (apiKey(k) === null) return `Invalid api path ${JSON.stringify(k)}: it must start with /api/ and contain no #.`;
  }
  return null;
}

export async function tryApp(d: ToolDeps, input: TryArgs, signal?: AbortSignal): Promise<ToolResult> {
  const bad = checkTryInput(input);
  if (bad) return fail(bad);
  const run = (d.shots as Partial<TryShots>).tryRun;
  if (typeof run !== 'function') return fail('try_app is not available here.');
  d.registry.refresh(d.appId); // sidor, opens och behörigheter som ändrats i app.json under turen
  try {
    const r = await run.call(d.shots, d.appId, { steps: input.steps, store: input.store, api: input.api, face: input.face, signal });
    return {
      content: [
        { type: 'text', text: r.lines.join('\n') },
        ...r.pngs.map((png) => ({ type: 'image' as const, data: png.toString('base64'), mimeType: 'image/png' })),
      ],
    };
  } catch (err) {
    return fail(`try_app failed: ${(err as Error)?.message ?? String(err)}`);
  }
}

function signalOf(extra: unknown): AbortSignal | undefined {
  const s = (extra as { signal?: unknown } | null)?.signal;
  return s instanceof AbortSignal ? s : undefined;
}

/** Verktygen för en process. Namnen blir mcp__workbench__<namn> hos Claude. */
export function makeWorkbenchTools(d: ToolDeps): SdkMcpToolDefinition<any>[] {
  return [
    tool(
      'reload_app',
      'Reload this app in the Workbench: re-read app.json, restart the back end if the app has one, and make the canvas reload the app. Returns the back end state and console errors since the last reload.',
      {},
      async () => reloadApp(d),
    ),
    tool(
      'screenshot_app',
      'Take a PNG screenshot of this app at its real window size (device scale factor 1), exactly as the user sees it. Optionally pass the id of the face to show; default is the face in front.',
      { face: z.string().optional().describe('Face id from app.json, e.g. "main"') },
      async (args) => screenshotApp(d, args.face),
      { annotations: { readOnlyHint: true } },
    ),
    tool(
      'get_app_logs',
      'Read the latest log lines of this app: browser console errors and warnings, back end output, and Workbench notices. One line per entry, oldest first.',
      { lines: z.number().optional().describe('How many lines (default 80, at most 400)') },
      async (args) => getAppLogs(d, args.lines),
      { annotations: { readOnlyHint: true } },
    ),
    tool(
      'call_backend',
      "Send an HTTP request to this app's own back end (the routes in server.mjs) and return the status, content type and body (at most 20 kB). Starts the back end if needed. path must start with /api/. A binary body (an image, a file) goes in body_base64.",
      {
        method: z.string().describe('GET, POST, PUT, PATCH, DELETE, HEAD or OPTIONS'),
        path: z.string().describe('Request path, starting with /api/'),
        body: z.string().optional().describe('Request body; JSON is sent as application/json'),
        body_base64: z
          .string()
          .optional()
          .describe('Binary request body as base64, at most 256 kB decoded, instead of body. Needs a content-type header, e.g. { "content-type": "image/png" }'),
        headers: z.record(z.string(), z.string()).optional().describe('Extra request headers'),
      },
      async (args) => callBackend(d, args),
    ),
    tool(
      'try_app',
      "Run this app in a hidden browser at its real window size and perform steps, like a user would. It never touches the user's data: wb.store writes go to a throwaway copy (reads see the copy first, then the real store), back-end requests other than GET/HEAD are refused with 409, other sites get only GET, and WebSockets are closed. Note: a back end that changes state on GET is still reached. Pass api to fake GET responses from the app's own back end (for example a mail list without an account): the faked responses never touch the back end, and the result says how often each path was requested. upload, drop and paste use built-in sample files; the camera and the microphone are fake devices, granted when app.json lists the permission; open hands the app something from the Workbench field (wb.onOpen) the way Workbench does. Returns one line per step (ok/FAIL), discarded store writes, faked responses, blocked requests, console errors, the visible text and a final screenshot. Steps run in order and stop at the first failure; at most 5 s per step and 30 s in total.",
      {
        steps: z
          .array(
            z.object({
              click: z.string().optional().describe('Playwright locator to click, e.g. "text=7", "role=button[name=\\"Spara\\"]" or a CSS selector'),
              hover: z.string().optional().describe('Locator to hover'),
              fill: z.string().optional().describe('Locator of an input to fill with text'),
              text: z.string().optional().describe('Text for fill'),
              type: z.string().optional().describe('Text to type with the keyboard into the focused element'),
              press: z.string().optional().describe('Key to press, e.g. "Enter" or "ArrowDown"'),
              wait: z.union([z.string(), z.number()]).optional().describe('Locator to wait for (visible), or milliseconds (at most 3000)'),
              shot: z.boolean().optional().describe('true: take a screenshot at this point (at most 2)'),
              drag: z
                .array(z.array(z.number()))
                .optional()
                .describe('2–50 points [x, y] in CSS px of the window, e.g. [[40, 40], [200, 120]]: press at the first, move through the others, release at the last'),
              upload: z.string().optional().describe('Locator of an <input type="file"> (it may be hidden): choose the sample file in it'),
              drop: z.string().optional().describe('Locator of a drop zone: drop the sample file on it (dragenter, dragover, drop)'),
              paste: z.string().optional().describe('Locator to paste the sample file into (a paste event), e.g. "body"'),
              sample: z
                .enum(SAMPLE_KINDS)
                .optional()
                .describe('Sample file for upload, drop and paste: "png" (sample.png, 64×64), "jpeg" (sample.jpg, 64×64) or "txt" (sample.txt, a short Swedish text)'),
              open: z
                .object({ kind: z.enum(['url', 'date', 'text']), url: z.string().optional(), date: z.string().optional(), text: z.string().optional() })
                .optional()
                .describe('Hand the app something from the Workbench field, e.g. {"kind":"url","url":"https://example.com/"}, {"kind":"date","date":"2026-10-20"} or {"kind":"text","text":"Köp mjölk"}. The kind must be in "opens" in app.json; it goes to the first face, received by wb.onOpen'),
            }),
          )
          .describe('1–20 steps, each with exactly one action'),
        store: z
          .union([z.enum(['copy', 'empty']), z.record(z.string(), z.unknown())])
          .optional()
          .describe('"copy" (default): start from the real store; "empty": start empty; or an object of sample values to start from'),
        api: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('Faked GET/HEAD responses from the back end, path → JSON, e.g. { "/api/messages": [...] }. A key with ?query matches exactly; a key without matches any query. At most 20 paths and 64 kB. Never reaches the back end.'),
        face: z.string().optional().describe('Face id to start on; default is the face in front'),
      },
      async (args, extra) => tryApp(d, args as TryArgs, signalOf(extra)),
    ),
    tool(
      'request_secret',
      "Ask the user for a password, token or API key. The user types it into a password field in the HUD, and Workbench stores it in data/secrets.json under the given key. You never see the value. The back end reads it from DATA_DIR/secrets.json.",
      {
        key: z.string().describe('Key in secrets.json, [a-z0-9_]{1,64}, e.g. "imap_password"'),
        label: z.string().describe("Short label in the user's language, e.g. \"Lösenord för mejlkontot\""),
      },
      async (args, extra) => requestSecret(d, args.key, args.label, signalOf(extra)),
    ),
  ];
}
