// server/main.ts — kopplar ihop servern (CONTRACT §7), i ordningen
//   config → paths → hub → scene → git → registry → logs → backends → shots → sessions → watcher → http.
// Startstegen (läs scenen, registrera apps/, ta bort fönster utan app, status idle och rev = Date.now(),
// laga chat.jsonl) sker i fabrikerna. Vid SIGINT/SIGTERM: sessions.closeAll → backends.stopAll →
// shots.close → scene.flush och logs.flush → avsluta.
import type http from 'node:http';
import type { ViteDevServer } from 'vite';
import { loadConfig } from './config.ts';
import { makePaths } from './paths.ts';
import { createHub } from './live/hub.ts';
import { createSceneStore } from './store/scene.ts';
import { createAppGit } from './live/git.ts';
import { createRegistry } from './store/registry.ts';
import { createAppLogs } from './store/logs.ts';
import { createBackends } from './backends/supervisor.ts';
import { proxyHttp, proxyUpgrade } from './backends/proxy.ts';
import { createShots } from './claude/shots.ts';
import { createSessions } from './claude/sessions.ts';
import { watchApps } from './live/watcher.ts';
import { transcribe } from './stt.ts';
import { createShellVite } from './http/vite.ts';
import { createRouter, listenBoth } from './http/router.ts';
import { createIdeas } from './claude/ideas.ts';
import { createRoute } from './claude/route.ts';
import type { Router } from './http/router.ts';

let stopping = false;
let servers: http.Server[] = [];
let vite: ViteDevServer | null = null;
let router: Router | null = null;

const config = loadConfig();
const paths = makePaths(config);
const hub = createHub();
const scene = createSceneStore(paths);
const git = createAppGit(paths);
const registry = createRegistry({ paths, scene, hub, git });
const logs = createAppLogs(paths);
const backends = createBackends({ config, paths, registry, logs });
const shots = createShots({ config, registry, scene, logs });
const sessions = createSessions({ config, paths, registry, scene, hub, backends, logs, shots, git });
const stopWatching = watchApps({ paths, registry, sessions });

async function step(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    console.error(`[workbench] ${name} misslyckades:`, err);
  }
}

async function shutdown(code = 0): Promise<never> {
  stopping = true;
  // Fastnar något avslutas processen ändå.
  setTimeout(() => process.exit(code || 1), 15_000).unref();
  stopWatching();
  for (const s of servers) {
    s.close();
    s.closeIdleConnections();
  }
  hub.closeAll(1001);
  router?.close();
  await step('sessions.closeAll', () => sessions.closeAll());
  await step('backends.stopAll', () => backends.stopAll());
  await step('shots.close', () => shots.close());
  // Scenen och de sista loggraderna (buntade i 50 ms) skrivs innan processen avslutas (§7).
  await step('scene.flush', () => scene.flush());
  await step('logs.flush', () => logs.flush());
  if (vite) {
    const v = vite;
    await step('vite.close', () => v.close());
  }
  process.exit(code);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (stopping) process.exit(1); // en andra signal avslutar direkt
    console.log(`[workbench] ${signal}: stänger`);
    void shutdown(0);
  });
}

try {
  vite = config.dev ? await createShellVite(config) : null;
  router = createRouter({
    config, paths, hub, scene, registry, logs, git, backends, sessions,
    proxy: { proxyHttp, proxyUpgrade },
    transcribe,
    ideas: createIdeas({ config, paths, registry, history: (id, n) => sessions.history(id, n) }),
    route: createRoute({ config, paths, registry }),
    vite,
  });
  servers = await listenBoth(config.port, router);
} catch (err) {
  console.error(`[workbench] start misslyckades (port ${config.port}):`, err instanceof Error ? err.message : err);
  await shutdown(1);
}

// Först när servern är uppe: ett enskilt fel i en förfrågan eller socket loggas i stället för att ta ner
// skrivbordet. (Före start skulle samma hanterare svälja ett misslyckat await och lämna en halvstartad process.)
process.on('uncaughtException', (err) => console.error('[workbench] ofångat fel:', err));
process.on('unhandledRejection', (err) => console.error('[workbench] ohanterat löfte:', err));

console.log(
  `[workbench] http://localhost:${config.port}` +
    (config.dev ? ` (dev, HMR på 127.0.0.1:${config.hmrPort})` : '') +
    (config.fakeClaude ? ' med låtsas-Claude' : '') +
    ` · hem ${config.home}`,
);
