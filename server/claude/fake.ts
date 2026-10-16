// server/claude/fake.ts — låtsas-Claude (WORKBENCH_FAKE_CLAUDE=1, CONTRACT §8.9).
// Ersätter bara modellen: motorn tar emot samma Options som riktiga Claude Code och sänder samma sorts
// SDK-meddelanden, så att händelser, policy, §8.6 och verktygen går samma väg i sessions.ts.
// Frågan ("fråga") går genom options.canUseTool och hemligheten ("hemlig") genom det riktiga verktyget request_secret.
// Inga nätverksanrop. WORKBENCH_FAKE_SPEED skalar alla pauser.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Options, PermissionResult, SDKMessage, SDKUserMessage, SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import type { Config } from '../types.ts';
import type { Engine, EngineQuery, EngineWarm } from './engine.ts';

type Variant = 'kub' | 'klocka' | 'backend' | 'anteckningar';

interface FakeFile {
  path: string;
  content: string;
}

class Aborted extends Error {}

/** Vilken app texten ber om (§8.9 punkt 4). */
export function fakeVariant(userText: string): Variant {
  const t = userText.toLowerCase();
  if (t.includes('kub') || t.includes('sidor')) return 'kub';
  if (t.includes('klocka')) return 'klocka';
  if (t.includes('backend')) return 'backend';
  return 'anteckningar';
}

/** Användarens egen text: allt efter <workbench>-blocket. */
export function stripWorkbenchBlock(text: string): string {
  const end = text.indexOf('</workbench>');
  return end >= 0 ? text.slice(end + '</workbench>'.length).replace(/^\n/, '') : text;
}

const STYLE_BASE = `html, body { height: 100%; margin: 0; }
body { font: 14px/1.45 var(--wb-font, -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif); color: #1d2433; background: #fff; }
button { font: inherit; border: 0; border-radius: 8px; padding: 8px 14px; background: var(--wb-accent, #2f6bff); color: #fff; cursor: pointer; }`;

function page(title: string, style: string, body: string, script: string): string {
  return `<!doctype html>
<html lang="sv">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
${STYLE_BASE}
${style}
</style>
</head>
<body>
${body}
<script type="module">
${script}
</script>
</body>
</html>
`;
}

function notesApp(): FakeFile[] {
  return [
    { path: 'app.json', content: JSON.stringify({ name: 'Anteckningar', faces: [{ id: 'main', page: 'index.html' }] }, null, 2) + '\n' },
    {
      path: 'index.html',
      content: page(
        'Anteckningar',
        `body { display: flex; flex-direction: column; }
form { display: flex; gap: 8px; padding: 14px; border-bottom: 1px solid #e6e9f0; }
textarea { flex: 1; resize: none; height: 2.6em; font: inherit; padding: 8px 10px; border: 1px solid #d6dbe6; border-radius: 8px; }
ul { list-style: none; margin: 0; padding: 0 14px; overflow: auto; flex: 1; }
li { display: flex; gap: 8px; align-items: flex-start; padding: 10px 0; border-bottom: 1px solid #f0f2f7; }
li p { margin: 0; flex: 1; white-space: pre-wrap; }
li button { background: none; color: #8a93a6; padding: 0 4px; }
.tom { color: #8a93a6; margin: 0; padding: 24px 14px; }`,
        `<form id="ny"><textarea id="text" aria-label="Ny anteckning"></textarea><button>Lägg till</button></form>
<ul id="lista"></ul>
<p class="tom" id="tom" hidden>Inga anteckningar ännu.</p>`,
        `const lista = document.getElementById('lista');
const tom = document.getElementById('tom');
const text = document.getElementById('text');
await wb.ready;
let anteckningar = (await wb.store.get('anteckningar')) ?? [];
function rita() {
  lista.replaceChildren(...anteckningar.map((a, i) => {
    const li = document.createElement('li');
    const p = document.createElement('p');
    p.textContent = a;
    const ta = document.createElement('button');
    ta.textContent = 'Ta bort';
    ta.addEventListener('click', async () => {
      anteckningar.splice(i, 1);
      await wb.store.set('anteckningar', anteckningar);
      rita();
    });
    li.append(p, ta);
    return li;
  }));
  tom.hidden = anteckningar.length > 0;
}
document.getElementById('ny').addEventListener('submit', async (e) => {
  e.preventDefault();
  const t = text.value.trim();
  if (!t) return;
  anteckningar.unshift(t);
  text.value = '';
  await wb.store.set('anteckningar', anteckningar);
  rita();
});
rita();`,
      ),
    },
  ];
}

function cubeApp(): FakeFile[] {
  const faces = [
    { id: 'main', page: 'index.html', label: 'Första', rubrik: 'Första sidan' },
    { id: 'sida2', page: 'sida2.html', label: 'Andra', rubrik: 'Andra sidan' },
    { id: 'sida3', page: 'sida3.html', label: 'Tredje', rubrik: 'Tredje sidan' },
  ];
  const files: FakeFile[] = [
    { path: 'app.json', content: JSON.stringify({ name: 'Kub', faces: faces.map(({ id, page: p, label }) => ({ id, page: p, label })) }, null, 2) + '\n' },
  ];
  for (const f of faces) {
    const knappar = faces
      .filter((o) => o.id !== f.id)
      .map((o) => `<button data-sida="${o.id}">Gå till ${o.rubrik.toLowerCase()}</button>`)
      .join('\n  ');
    files.push({
      path: f.page,
      content: page(
        `Kub – ${f.rubrik}`,
        `body { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 18px; }
h1 { margin: 0; font-size: 22px; font-weight: 600; }
nav { display: flex; gap: 10px; }`,
        `<h1>${f.rubrik}</h1>
<nav>
  ${knappar}
</nav>`,
        `for (const b of document.querySelectorAll('button[data-sida]')) {
  b.addEventListener('click', () => wb.face.show(b.dataset.sida));
}`,
      ),
    });
  }
  return files;
}

function clockApp(): FakeFile[] {
  return [
    { path: 'app.json', content: JSON.stringify({ name: 'Klocka', faces: [{ id: 'main', page: 'index.html' }] }, null, 2) + '\n' },
    {
      path: 'index.html',
      content: page(
        'Klocka',
        `body { display: flex; flex-direction: column; align-items: center; justify-content: center; }
#tid { font-size: min(22vw, 30vh); font-weight: 300; font-variant-numeric: tabular-nums; letter-spacing: -0.02em; }
#datum { color: #5b6478; font-size: 15px; }`,
        `<div id="tid"></div>
<div id="datum"></div>`,
        `const tid = document.getElementById('tid');
const datum = document.getElementById('datum');
function tick() {
  const nu = new Date();
  tid.textContent = nu.toLocaleTimeString('sv-SE');
  datum.textContent = nu.toLocaleDateString('sv-SE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}
tick();
setInterval(tick, 1000);`,
      ),
    },
  ];
}

function backendApp(): FakeFile[] {
  return [
    { path: 'app.json', content: JSON.stringify({ name: 'Servertid', faces: [{ id: 'main', page: 'index.html' }], backend: { entry: 'server.mjs' } }, null, 2) + '\n' },
    {
      path: 'server.mjs',
      content: `// Backend: GET /api/tid svarar med serverns tid.
import http from 'node:http';

const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || '127.0.0.1';

http
  .createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/api/tid') {
      const nu = new Date();
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ tid: nu.toISOString(), text: nu.toLocaleTimeString('sv-SE') }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ fel: 'Hittades inte' }));
  })
  .listen(port, host);
`,
    },
    {
      path: 'index.html',
      content: page(
        'Servertid',
        `body { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; }
#tid { font-size: min(16vw, 22vh); font-weight: 300; font-variant-numeric: tabular-nums; }
#fel { color: #b4462b; }`,
        `<div id="tid"></div>
<div id="fel" hidden>Servern svarar inte.</div>
<button id="uppdatera">Uppdatera</button>`,
        `const tid = document.getElementById('tid');
const fel = document.getElementById('fel');
async function hämta() {
  try {
    const r = await fetch('/api/tid', { cache: 'no-store' });
    if (!r.ok) throw new Error(String(r.status));
    const data = await r.json();
    tid.textContent = data.text;
    fel.hidden = true;
  } catch {
    fel.hidden = false;
  }
}
document.getElementById('uppdatera').addEventListener('click', hämta);
hämta();
setInterval(hämta, 5000);`,
      ),
    },
  ];
}

const FILES: Record<Variant, () => FakeFile[]> = { anteckningar: notesApp, kub: cubeApp, klocka: clockApp, backend: backendApp };

const INTRO: Record<Variant, string> = {
  anteckningar: 'Jag bygger en anteckningsapp åt dig.',
  kub: 'Jag bygger en kub med tre sidor.',
  klocka: 'Jag bygger en klocka.',
  backend: 'Jag bygger en app med en egen backend.',
};

const DONE: Record<Variant, string> = {
  anteckningar: 'Klart. Anteckningarna sparas och finns kvar när du öppnar appen igen.',
  kub: 'Klart. Kuben har tre sidor, och knapparna vrider fram de andra.',
  klocka: 'Klart. Klockan visar tid och datum och går varje sekund.',
  backend: 'Klart. Appen hämtar tiden från sin egen backend på /api/tid.',
};

/** Låtsasmotorn. Samma Engine-gränssnitt som SDK:n. */
export function createFakeEngine(config: Pick<Config, 'fakeSpeed' | 'model'>): Engine {
  const speed = config.fakeSpeed > 0 ? config.fakeSpeed : 1;
  return {
    async startup(options, tools) {
      await new Promise((r) => setTimeout(r, Math.round(40 / speed)));
      return new FakeWarm(options, tools, speed);
    },
  };
}

class FakeWarm implements EngineWarm {
  #options: Options;
  #tools: SdkMcpToolDefinition<any>[];
  #speed: number;
  #used = false;

  constructor(options: Options, tools: SdkMcpToolDefinition<any>[], speed: number) {
    this.#options = options;
    this.#tools = tools;
    this.#speed = speed;
  }

  query(prompt: AsyncIterable<SDKUserMessage>): EngineQuery {
    if (this.#used) throw new Error('WarmQuery.query() can only be called once');
    this.#used = true;
    return new FakeQuery(this.#options, this.#tools, this.#speed, prompt);
  }

  close(): void {
    this.#used = true;
  }
}

class FakeQuery implements EngineQuery {
  #options: Options;
  #tools: SdkMcpToolDefinition<any>[];
  #speed: number;
  #sessionId: string;
  #cwd: string;
  #out: SDKMessage[] = [];
  #wake: (() => void) | null = null;
  #done = false;
  #inbox: string[] = [];
  #inputEnded = false;
  #running = false;
  #abort: AbortController | null = null;
  #latched = false;
  #started = false;
  #n = 0;

  constructor(options: Options, tools: SdkMcpToolDefinition<any>[], speed: number, prompt: AsyncIterable<SDKUserMessage>) {
    this.#options = options;
    this.#tools = tools;
    this.#speed = speed;
    this.#sessionId = options.resume ?? crypto.randomUUID();
    this.#cwd = options.cwd ?? process.cwd();
    void this.#readInput(prompt);
  }

  async #readInput(prompt: AsyncIterable<SDKUserMessage>): Promise<void> {
    try {
      for await (const m of prompt) {
        if (this.#done) break;
        const c = m.message.content;
        this.#inbox.push(typeof c === 'string' ? c : c.map((b) => (b.type === 'text' ? b.text : '')).join(''));
        this.#kick();
      }
    } catch {
      /* kön stängdes */
    }
    this.#inputEnded = true;
    this.#kick();
  }

  #kick(): void {
    if (!this.#running) void this.#loop();
  }

  async #loop(): Promise<void> {
    this.#running = true;
    try {
      while (this.#inbox.length > 0 && !this.#done) {
        const text = this.#inbox.shift() as string;
        await this.#turn(text);
      }
    } finally {
      this.#running = false;
    }
    if (this.#inputEnded && this.#inbox.length === 0) this.#finish();
  }

  #push(m: unknown): void {
    if (this.#done) return;
    this.#out.push(m as SDKMessage);
    this.#wake?.();
  }

  #finish(): void {
    if (this.#done) return;
    this.#done = true;
    this.#wake?.();
  }

  async #pause(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new Aborted();
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, Math.max(1, Math.round(ms / this.#speed)));
      const onAbort = () => {
        clearTimeout(t);
        reject(new Aborted());
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  #base(): { uuid: string; session_id: string } {
    return { uuid: crypto.randomUUID(), session_id: this.#sessionId };
  }

  #init(): void {
    const mcp = this.#tools.map((t) => `mcp__workbench__${t.name}`);
    this.#push({
      type: 'system', subtype: 'init', ...this.#base(),
      apiKeySource: 'none', claude_code_version: 'fake', cwd: this.#cwd,
      tools: [...(Array.isArray(this.#options.tools) ? this.#options.tools : []), ...mcp],
      mcp_servers: [{ name: 'workbench', status: 'connected', source: 'sdk' }],
      model: this.#options.model ?? 'fake', permissionMode: this.#options.permissionMode ?? 'acceptEdits',
      slash_commands: [], output_style: 'default', skills: [], plugins: [],
    });
  }

  #delta(text: string): void {
    this.#push({
      type: 'stream_event', ...this.#base(), parent_tool_use_id: null,
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    });
  }

  #assistant(content: unknown[]): void {
    this.#push({
      type: 'assistant', ...this.#base(), parent_tool_use_id: null,
      message: { id: `msg_fake_${this.#n}`, type: 'message', role: 'assistant', model: 'fake', content, stop_reason: null, stop_sequence: null, usage: {} },
    });
  }

  #toolResult(id: string, text: string, isError: boolean): void {
    this.#push({
      type: 'user', ...this.#base(), parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }], ...(isError ? { is_error: true } : {}) }] },
    });
  }

  #result(ok: boolean, text: string, terminal: string): void {
    this.#push({
      type: 'result', ...this.#base(),
      subtype: ok ? 'success' : 'error_during_execution',
      is_error: !ok,
      ...(ok ? { result: text } : { errors: [`[fake] ${terminal}`] }),
      duration_ms: 0, duration_api_ms: 0, num_turns: 1, stop_reason: ok ? 'end_turn' : null,
      total_cost_usd: 0, usage: {}, modelUsage: {}, permission_denials: [],
      queued_turn_count: this.#inbox.length,
      terminal_reason: terminal,
    });
  }

  #toolId(): string {
    return `toolu_fake_${crypto.randomBytes(6).toString('hex')}`;
  }

  async #write(file: FakeFile, signal: AbortSignal): Promise<void> {
    const id = this.#toolId();
    const abs = path.join(this.#cwd, file.path);
    this.#assistant([{ type: 'tool_use', id, name: 'Write', input: { file_path: abs, content: file.content } }]);
    await this.#pause(150, signal);
    // acceptEdits godkänner skrivningar i appens mapp utan canUseTool, precis som Claude Code.
    await fs.promises.mkdir(path.dirname(abs), { recursive: true });
    await fs.promises.writeFile(abs, file.content);
    this.#toolResult(id, `File created successfully at: ${abs}`, false);
  }

  async #webFetch(signal: AbortSignal): Promise<void> {
    const id = this.#toolId();
    const input = { url: 'https://example.com', prompt: 'Sammanfatta sidan.' };
    this.#assistant([{ type: 'tool_use', id, name: 'WebFetch', input }]);
    const canUseTool = this.#options.canUseTool;
    let r: PermissionResult | null = { behavior: 'deny', message: 'No permission callback.' };
    if (canUseTool) {
      r = await canUseTool('WebFetch', input, {
        signal,
        suggestions: [{ type: 'addRules', rules: [{ toolName: 'WebFetch', ruleContent: 'domain:example.com' }], behavior: 'allow', destination: 'session' }],
        toolUseID: id,
        requestId: crypto.randomUUID(),
        displayName: 'Fetch',
      });
    }
    if (signal.aborted) throw new Aborted();
    if (r?.behavior === 'allow') this.#toolResult(id, 'Example Domain. This domain is for use in documentation examples.', false);
    else this.#toolResult(id, r?.message ?? 'Denied.', true);
  }

  async #secret(signal: AbortSignal): Promise<void> {
    const id = this.#toolId();
    const input = { key: 'api_nyckel', label: 'API-nyckel' };
    this.#assistant([{ type: 'tool_use', id, name: 'mcp__workbench__request_secret', input }]);
    const def = this.#tools.find((t) => t.name === 'request_secret');
    if (!def) {
      this.#toolResult(id, 'No such tool.', true);
      return;
    }
    const res = await def.handler(input, { signal });
    if (signal.aborted) throw new Aborted();
    const text = (res.content ?? []).map((c) => (c.type === 'text' ? c.text : '')).join('\n');
    this.#toolResult(id, text, !!res.isError);
  }

  async #turn(raw: string): Promise<void> {
    this.#n++;
    const ac = new AbortController();
    this.#abort = ac;
    if (this.#latched) {
      this.#latched = false;
      ac.abort();
    }
    this.#started = true;
    const userText = stripWorkbenchBlock(raw);
    const variant = fakeVariant(userText);
    let phase: 'streaming' | 'tools' = 'streaming';
    this.#init();
    try {
      if (ac.signal.aborted) throw new Aborted();
      // ungefär 1 s med delta
      const words = INTRO[variant].split(/(?<= )/);
      const per = Math.max(1, Math.floor(1000 / Math.max(1, words.length)));
      for (const w of words) {
        await this.#pause(per, ac.signal);
        this.#delta(w);
      }
      phase = 'tools';
      const files = FILES[variant]();
      const manifest = files.find((f) => f.path === 'app.json') as FakeFile;
      await this.#write(manifest, ac.signal);
      // index.html sist, så att appen räknas som byggd först när allt finns
      const rest = files.filter((f) => f.path !== 'app.json' && f.path !== 'index.html');
      for (const f of rest) await this.#write(f, ac.signal);
      await this.#write(files.find((f) => f.path === 'index.html') as FakeFile, ac.signal);
      const lower = userText.toLowerCase();
      if (lower.includes('fråga')) await this.#webFetch(ac.signal);
      if (lower.includes('hemlig')) await this.#secret(ac.signal);
      await this.#pause(100, ac.signal);
      phase = 'streaming';
      this.#assistant([{ type: 'text', text: DONE[variant] }]);
      this.#result(true, DONE[variant], 'completed');
    } catch (err) {
      if (!(err instanceof Aborted) && !ac.signal.aborted) {
        this.#assistant([{ type: 'text', text: `Något gick fel: ${(err as Error)?.message ?? String(err)}` }]);
        this.#result(false, '', 'model_error');
      } else {
        this.#push({ type: 'user', ...this.#base(), parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } });
        this.#result(false, '', phase === 'tools' ? 'aborted_tools' : 'aborted_streaming');
      }
    } finally {
      this.#abort = null;
    }
  }

  /* ------------------------------ EngineQuery ------------------------------ */

  async interrupt(): Promise<unknown> {
    if (this.#abort) this.#abort.abort();
    else if (!this.#started || this.#inbox.length > 0) this.#latched = true;
    return { still_queued: [] };
  }

  close(): void {
    this.#abort?.abort();
    this.#finish();
  }

  async mcpServerStatus(): Promise<{ name: string; status: string }[]> {
    return [{ name: 'workbench', status: 'connected' }];
  }

  async getContextUsage(): Promise<{ memoryFiles: { path: string }[] }> {
    return { memoryFiles: [] };
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage> {
    while (true) {
      while (this.#out.length > 0) yield this.#out.shift() as SDKMessage;
      if (this.#done) return;
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
      this.#wake = null;
    }
  }
}
