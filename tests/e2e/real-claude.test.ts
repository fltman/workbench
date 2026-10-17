// tests/e2e/real-claude.test.ts — den första riktiga end-to-end-byggnaden (CONTRACT §15, §8.2).
// Körs BARA med WORKBENCH_REAL=1 (förbrukar riktig Claude-kvot via nyckelringsinloggningen). Lediga portar
// (eller WB_E2E_PORT, HMR = porten + 9) och en tillfällig WORKBENCH_HOME under .scratch. Bygger en enkel klocka och verifierar:
// index.html + app.json finns, built=true, en commit bortom fröet, tool-händelser med svenska etiketter
// (bl.a. "Tittar på appen" och "Läser loggarna"), inga oväntade policy-/sandlådeavslag, status idle och att
// §8.2-självtestet gick igenom. Den sista skärmbilden kopieras till .scratch/integrator/real-claude-clock.png.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { WebSocket } from 'ws';
import { createShots } from '../../server/claude/shots.ts';
import type { AppInfo, ChatEvent, Scene, ServerMsg, WindowState } from '../../shared/protocol.ts';
import type { AppRegistry, SceneStore, Shots } from '../../server/types.ts';
import { testPort } from '../ports.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = await testPort('WB_E2E_PORT');
const HMR = process.env.WB_E2E_PORT ? PORT + 9 : await testPort();
const SHELL = `http://localhost:${PORT}`;
const execFileP = promisify(execFile);
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';
const PROMPT = 'Bygg en enkel klocka som visar tid och datum på svenska, stora siffror, lugn design.';
const TURN_TIMEOUT_MS = 15 * 60_000;

interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
}
function req(opts: { method?: string; path: string; host?: string; headers?: Record<string, string>; body?: string }): Promise<Res> {
  return new Promise((resolve, reject) => {
    const payload = opts.body === undefined ? undefined : Buffer.from(opts.body);
    const r = http.request(
      {
        host: '127.0.0.1',
        port: PORT,
        method: opts.method ?? 'GET',
        path: opts.path,
        headers: {
          host: opts.host ?? `localhost:${PORT}`,
          'user-agent': UA,
          accept: '*/*',
          ...(payload ? { 'content-length': String(payload.length) } : {}),
          ...(opts.headers ?? {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}
const sameOrigin = (origin: string) => ({ origin, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' });

test('riktig Claude bygger en klocka end to end', { skip: process.env.WORKBENCH_REAL === '1' ? false : 'kräver WORKBENCH_REAL=1', timeout: TURN_TIMEOUT_MS + 120_000 }, async () => {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(ROOT, '.scratch', 'integrator', 'real-home-')));
  const logFile = path.join(home, 'server.log');
  const server: ChildProcess = spawn('node', [path.join(ROOT, 'server', 'main.ts')], {
    env: { ...process.env, WORKBENCH_PORT: String(PORT), WORKBENCH_HMR_PORT: String(HMR), WORKBENCH_HOME: home, NODE_ENV: 'development' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout?.on('data', (d: Buffer) => fs.appendFileSync(logFile, d));
  server.stderr?.on('data', (d: Buffer) => fs.appendFileSync(logFile, d));

  const msgs: ServerMsg[] = [];
  let ws: WebSocket | null = null;
  const chat = (id: string): ChatEvent[] => msgs.filter((m): m is Extract<ServerMsg, { t: 'chat' }> => m.t === 'chat' && m.appId === id).map((m) => m.ev);
  const waitFor = async (pred: () => boolean | Promise<boolean>, ms: number, what: string): Promise<void> => {
    const end = Date.now() + ms;
    while (!(await pred())) {
      if (Date.now() > end) throw new Error(`timeout: ${what}`);
      await new Promise((r) => setTimeout(r, 500));
    }
  };
  const snapshotApp = async (id: string): Promise<AppInfo | undefined> => {
    const r = await req({ path: '/api/snapshot', headers: sameOrigin(SHELL) });
    return (JSON.parse(r.text) as { apps: AppInfo[] }).apps.find((a) => a.id === id);
  };

  const started = Date.now();
  const result: Record<string, unknown> = {};
  try {
    // Vänta tills skalet svarar.
    await waitFor(async () => {
      try {
        return (await req({ path: '/api/snapshot', headers: sameOrigin(SHELL) })).status === 200;
      } catch {
        return false;
      }
    }, 30_000, 'servern uppe');

    ws = new WebSocket(`ws://localhost:${PORT}/ws`, { origin: SHELL, headers: { 'user-agent': UA } });
    ws.on('message', (d) => {
      try {
        msgs.push(JSON.parse(String(d)) as ServerMsg);
      } catch {
        /* strunta */
      }
    });
    await new Promise<void>((resolve, reject) => {
      ws!.once('open', () => {
        ws!.send(JSON.stringify({ t: 'hello', v: 1 }));
        resolve();
      });
      ws!.once('error', reject);
    });
    await waitFor(() => msgs.some((m) => m.t === 'snapshot'), 5000, 'snapshot');

    // Skapa appen och skicka prompten.
    const created = await req({
      method: 'POST',
      path: '/api/apps',
      headers: { ...sameOrigin(SHELL), 'content-type': 'application/json' },
      body: JSON.stringify({ x: 0, y: 0, w: 520, h: 400, scale: 1 }),
    });
    assert.equal(created.status, 200, created.text);
    const { app, win } = JSON.parse(created.text) as { app: AppInfo; win: WindowState };
    const id = app.id;
    result.appId = id;
    ws.send(JSON.stringify({ t: 'chat.open', appId: id }));
    ws.send(JSON.stringify({ t: 'chat.send', appId: id, text: PROMPT, via: 'text' }));

    // Besvara eventuella frågor så att turen kan gå klart (loggas).
    const answered: string[] = [];
    const answerPending = (): void => {
      const done = new Set(chat(id).filter((e) => e.k === 'ask-done').map((e) => (e as { id: string }).id));
      for (const e of chat(id)) {
        if (e.k !== 'ask' || done.has(e.id) || answered.includes(e.id)) continue;
        answered.push(e.id);
        const ask = e.ask;
        if (ask.kind === 'permission') ws!.send(JSON.stringify({ t: 'chat.answer', appId: id, askId: e.id, decision: 'allow' }));
        else if (ask.kind === 'question') ws!.send(JSON.stringify({ t: 'chat.answer', appId: id, askId: e.id, decision: 'answered', answers: Object.fromEntries(ask.questions.map((q) => [q.question, q.options[0]?.label ?? ''])) }));
        else ws!.send(JSON.stringify({ t: 'chat.answer', appId: id, askId: e.id, decision: 'deny' }));
      }
    };
    const poll = setInterval(answerPending, 500);

    try {
      await waitFor(() => chat(id).some((e) => e.k === 'turn' && e.phase === 'end'), TURN_TIMEOUT_MS, 'turslut');
    } finally {
      clearInterval(poll);
    }
    result.durationMs = Date.now() - started;
    result.asksAnswered = answered.length;

    const events = chat(id);
    const end = events.filter((e): e is Extract<ChatEvent, { k: 'turn' }> => e.k === 'turn' && e.phase === 'end').at(-1)!;
    result.turnChains = events.filter((e) => e.k === 'turn' && e.phase === 'start').length;
    result.toolLabels = events.filter((e): e is Extract<ChatEvent, { k: 'tool' }> => e.k === 'tool').map((e) => e.label);

    // 1. Resultatet: ok, status idle.
    assert.equal(end.ok, true, `turen gick inte bra: ${JSON.stringify(end)}`);
    await waitFor(async () => (await snapshotApp(id))?.status === 'idle', 15_000, 'status idle');

    // 2. Filer och built.
    const appDir = path.join(home, 'apps', id);
    assert.ok(fs.existsSync(path.join(appDir, 'app.json')), 'app.json saknas');
    assert.ok(fs.existsSync(path.join(appDir, 'index.html')), 'index.html saknas');
    assert.equal((await snapshotApp(id))?.built, true, 'appen är inte byggd');

    // 3. En commit bortom fröet.
    const { stdout } = await execFileP(
      'git',
      ['-c', 'core.hooksPath=/dev/null', `--git-dir=${path.join(home, 'data', 'apps', id, 'git')}`, `--work-tree=${appDir}`, 'log', '--format=%s'],
      { env: { PATH: process.env.PATH ?? '', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }, encoding: 'utf8' },
    );
    const commits = stdout.split('\n').filter(Boolean);
    result.commits = commits;
    assert.ok(commits.length >= 2, `förväntade en commit bortom fröet: ${JSON.stringify(commits)}`);

    // 4. Svenska etiketter, inkl. skärmbild och loggar (eller förklara varför inte).
    const labels = result.toolLabels as string[];
    assert.ok(labels.some((l) => /^Skriver /.test(l)), `ingen skriv-etikett: ${JSON.stringify(labels)}`);
    result.sawScreenshot = labels.includes('Tittar på appen');
    result.sawLogs = labels.includes('Läser loggarna');
    assert.ok(result.sawScreenshot, `Claude tittade aldrig på appen (screenshot_app). Etiketter: ${JSON.stringify(labels)}`);
    if (!result.sawLogs) result.logsNote = 'Claude anropade inte get_app_logs ("Läser loggarna"); app-rules uppmanar till det men kräver det inte.';

    // 5. §8.2-självtestet: pass-raden i serverns konsol, inga självtest-varningar i appens logg.
    const serverLog = fs.readFileSync(logFile, 'utf8');
    result.selfTestPassed = new RegExp(`självtest ${id}: inga minnesfiler, bara MCP-servern workbench`).test(serverLog);
    assert.ok(result.selfTestPassed, 'självtestet (§8.2) loggade ingen pass-rad');
    const appLog = fs.existsSync(path.join(home, 'data', 'apps', id, 'logs.txt')) ? fs.readFileSync(path.join(home, 'data', 'apps', id, 'logs.txt'), 'utf8') : '';
    const selfTestWarnings = appLog.split('\n').filter((l) => /självtest/.test(l));
    assert.deepEqual(selfTestWarnings, [], `självtest-varningar: ${JSON.stringify(selfTestWarnings)}`);

    // 6. Inga oväntade policy-/sandlådeavslag i loggarna.
    const violations = (appLog + '\n' + serverLog)
      .split('\n')
      .filter((l) => /Operation not permitted|sandbox|Blocked by Workbench|lyssnade på|policy/i.test(l) && !/självtest|WORKBENCH_SANDBOX=0|sandbox-exec saknas/.test(l));
    result.violations = violations;
    assert.deepEqual(violations, [], `oväntade avslag/överträdelser: ${JSON.stringify(violations)}`);

    // 7. Sista skärmbilden genom shots.ts, kopierad till det begärda stället.
    const live = (await snapshotApp(id))!;
    const faces = live.faces;
    const registry = { get: (x: string) => (x === id ? live : undefined), manifest: () => ({ name: live.name, faces, permissions: live.permissions }) } as unknown as AppRegistry;
    const scene = { window: (x: string) => (x === id ? win : undefined) } as unknown as SceneStore;
    const shots: Shots = createShots({ config: { port: PORT } as never, registry, scene, logs: { append() {} } as never });
    try {
      const shot = await shots.screenshot(id);
      const dest = path.join(ROOT, '.scratch', 'integrator', 'real-claude-clock.png');
      fs.writeFileSync(dest, shot.png);
      result.screenshot = dest;
      result.screenshotSize = { w: shot.w, h: shot.h };
    } finally {
      await shots.close();
    }

    // Rapporten sparas bredvid skärmbilden.
    fs.writeFileSync(path.join(ROOT, '.scratch', 'integrator', 'real-claude-result.json'), JSON.stringify(result, null, 2));
    console.log('[real-claude]', JSON.stringify(result, null, 2));
  } catch (err) {
    try {
      fs.copyFileSync(logFile, path.join(ROOT, '.scratch', 'integrator', 'real-claude-server.log'));
    } catch {
      /* ingen logg */
    }
    fs.writeFileSync(path.join(ROOT, '.scratch', 'integrator', 'real-claude-result.json'), JSON.stringify({ ...result, error: String((err as Error).stack ?? err) }, null, 2));
    throw err;
  } finally {
    try {
      ws?.close();
    } catch {
      /* redan stängd */
    }
    if (server.pid) {
      try {
        process.kill(server.pid, 'SIGTERM');
      } catch {
        /* borta */
      }
      await new Promise((r) => setTimeout(r, 2000));
      try {
        process.kill(server.pid, 'SIGKILL');
      } catch {
        /* avslutad */
      }
    }
    // WORKBENCH_HOME sparas INTE: real-claude-clock.png och real-claude-result.json ligger kvar i scratch.
    fs.rmSync(home, { recursive: true, force: true });
  }
});
