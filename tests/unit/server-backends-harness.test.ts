// tests/unit/server-backends-harness.test.ts — gemensamt för server-backends-testerna.
// Riktiga appmappar under $HOME (.scratch/server-backends/<namn>/apps/<id>), eftersom sandlådan
// stänger hemkatalogen och flykttester under /tmp inte säger något. Låtsasregister och -loggar
// i stället för server-store, som byggs parallellt.
// Filen heter .test.ts för att ligga inom delens filmönster; dess eget test körs bara när den
// körs direkt (import.meta.main), inte när andra testfiler importerar den.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../../server/config.ts';
import { makePaths } from '../../server/paths.ts';
import type { AppLogs, AppRegistry, Config, Paths } from '../../server/types.ts';
import { DEFAULT_FACES } from '../../shared/protocol.ts';
import type { AppManifest, BackendState } from '../../shared/protocol.ts';

export const ROOT = path.resolve(import.meta.dirname, '..', '..');
export const SCRATCH = path.join(ROOT, '.scratch', 'server-backends');
/** Kanarieporten som står för workbenchens port i flykttesterna. */
export const CANARY_PORT = 8243;

export interface TestHome {
  config: Config;
  paths: Paths;
  home: string;
}

/** En tom WORKBENCH_HOME under $HOME. Porten 8243 står för workbenchens port. */
export function makeHome(name: string, env: Record<string, string> = {}): TestHome {
  // Processens pid i namnet: flera körningar samtidigt (andra agenter) får aldrig radera varandras hem.
  const dir = path.join(SCRATCH, `${name}-${process.pid}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const config = loadConfig({
    WORKBENCH_HOME: dir,
    WORKBENCH_PORT: String(CANARY_PORT),
    WORKBENCH_HMR_PORT: '18499',
    ...env,
  });
  return { config, paths: makePaths(config), home: config.home };
}

export interface FakeRegistry extends AppRegistry {
  manifests: Map<string, AppManifest>;
  /** Alla setBackend-anrop i ordning. */
  backendLog: { appId: string; state: BackendState; at: number }[];
  statesOf(appId: string): BackendState[];
}

export function fakeRegistry(): FakeRegistry {
  const manifests = new Map<string, AppManifest>();
  const backendLog: FakeRegistry['backendLog'] = [];
  return {
    manifests,
    backendLog,
    statesOf: (appId) => backendLog.filter((b) => b.appId === appId).map((b) => b.state),
    list: () => [],
    get: () => undefined,
    manifest(appId) {
      const m = manifests.get(appId);
      if (!m) throw new Error(`okänd app ${appId}`);
      return { ...m, faces: m.faces ?? DEFAULT_FACES, permissions: m.permissions ?? [] };
    },
    async create() {
      throw new Error('används inte i testerna');
    },
    async remove() {},
    setStatus() {},
    setBackend(appId, state) {
      backendLog.push({ appId, state, at: Date.now() });
    },
    bumpRev() {},
    refresh() {},
  };
}

export interface FakeLogs extends AppLogs {
  lines: { appId: string; source: 'console' | 'backend' | 'workbench'; line: string; at: number }[];
  of(appId: string, source?: 'console' | 'backend' | 'workbench'): string[];
}

export function fakeLogs(): FakeLogs {
  const lines: FakeLogs['lines'] = [];
  const of: FakeLogs['of'] = (appId, source) =>
    lines.filter((l) => l.appId === appId && (!source || l.source === source)).map((l) => l.line);
  return {
    lines,
    of,
    append(appId, source, line) {
      lines.push({ appId, source, line, at: Date.now() });
    },
    tail(appId, n = 80) {
      return of(appId).slice(-n);
    },
    clear(appId) {
      for (let i = lines.length - 1; i >= 0; i--) if (lines[i].appId === appId) lines.splice(i, 1);
    },
  };
}

/** Skriver apps/<id>/… och registrerar manifestet. */
export function makeApp(
  t: TestHome,
  registry: FakeRegistry,
  appId: string,
  files: Record<string, string>,
  manifest: AppManifest = { name: appId, backend: { entry: 'server.mjs' } },
): string {
  const dir = t.paths.appDir(appId);
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  fs.mkdirSync(t.paths.appDataDir(appId), { recursive: true });
  registry.manifests.set(appId, manifest);
  return dir;
}

/** Kopierar ws-paketet in i appens node_modules (sandlådan låter inte backenden läsa repots). */
export function installWs(appDir: string): void {
  fs.cpSync(path.join(ROOT, 'node_modules', 'ws'), path.join(appDir, 'node_modules', 'ws'), { recursive: true });
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 10_000, label = 'villkoret'): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`väntade förgäves på ${label} (${timeoutMs} ms)`);
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** TCP-lyssnare (lsof -F pn) för en pid eller en port; [] om inga. */
export function listeners(select: { pid?: number; pgid?: number; port?: number }): Promise<{ pid: number; name: string }[]> {
  const args = ['-nP', '-sTCP:LISTEN', '-Fpn'];
  if (select.pid !== undefined) args.push('-a', '-p', String(select.pid), '-iTCP');
  else if (select.pgid !== undefined) args.push('-a', '-g', String(select.pgid), '-iTCP');
  else args.push(`-iTCP:${select.port}`);
  return new Promise((resolve) => {
    execFile('/usr/sbin/lsof', args, (_err, stdout) => {
      const rows: { pid: number; name: string }[] = [];
      let pid = 0;
      for (const line of String(stdout).split('\n')) {
        if (line.startsWith('p')) pid = Number(line.slice(1));
        else if (line.startsWith('n')) rows.push({ pid, name: line.slice(1) });
      }
      resolve(rows);
    });
  });
}

/** En "workbench"-server i testet som anropar proxyn, som server-http gör. */
export async function frontServer(
  onRequest: (req: http.IncomingMessage, res: http.ServerResponse) => void,
  onUpgrade?: (req: http.IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) => void,
): Promise<{ server: http.Server; port: number; close: () => Promise<void> }> {
  const server = http.createServer(onRequest);
  if (onUpgrade) {
    server.on('upgrade', (req, socket, head) => {
      socket.on('error', () => {}); // som server-http måste göra före varje await
      onUpgrade(req, socket, head);
    });
  }
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    server,
    port,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

/** En enkel HTTP-förfrågan; kroppen som text. */
export function request(
  port: number,
  opts: { method?: string; path: string; headers?: Record<string, string>; body?: string | Buffer },
): Promise<{ status: number; headers: http.IncomingHttpHeaders; rawHeaders: string[]; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method: opts.method ?? 'GET', path: opts.path, headers: opts.headers, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, rawHeaders: res.rawHeaders, body: Buffer.concat(chunks).toString('utf8') }),
        );
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(opts.body);
  });
}

if (import.meta.main) {
  test('låtsasregistret och låtsasloggarna beter sig som gränssnitten', () => {
    const reg = fakeRegistry();
    reg.manifests.set('aharness', { backend: { entry: 'server.mjs' } });
    assert.deepEqual(reg.manifest('aharness').faces, DEFAULT_FACES);
    reg.setBackend('aharness', 'starting');
    reg.setBackend('aharness', 'running');
    assert.deepEqual(reg.statesOf('aharness'), ['starting', 'running']);
    assert.throws(() => reg.manifest('aokand'));
    const logs = fakeLogs();
    logs.append('aharness', 'backend', 'ett');
    logs.append('aharness', 'workbench', 'två');
    assert.deepEqual(logs.tail('aharness'), ['ett', 'två']);
    assert.deepEqual(logs.of('aharness', 'backend'), ['ett']);
    logs.clear('aharness');
    assert.deepEqual(logs.tail('aharness'), []);
  });
}
