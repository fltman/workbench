// server/http/vite.ts — Vite som middleware i dev, med exakt optionerna i CONTRACT §4.3.
// HMR-websocketen får en egen port bunden till 127.0.0.1; fs.allow släpper bara web/, shared/ och node_modules/,
// så apps/, data/ och vault/ kan aldrig serveras, inte ens till skalets egen origin.
import path from 'node:path';
import type { InlineConfig, ViteDevServer } from 'vite';
import type { Config } from '../types.ts';

export function shellViteOptions(config: Pick<Config, 'root' | 'hmrPort' | 'port'>): InlineConfig {
  const root = config.root;
  return {
    configFile: path.join(root, 'vite.config.ts'),
    root: path.join(root, 'web'),
    appType: 'spa',
    // En egen förbundlingscache per instans (ROB-8): Vites configHash innehåller root och läge, så servrar
    // som delade node_modules/.vite förbundlade om varandras cache (och laddade om varandras skal).
    // Inne i node_modules/, som fs.allow redan släpper. three förbundlas direkt vid start, inte vid första sidan.
    cacheDir: path.join(root, 'node_modules', `.vite-${config.port}`),
    optimizeDeps: { include: ['three'] },
    server: {
      middlewareMode: true,
      ws: { port: config.hmrPort, host: '127.0.0.1' },
      cors: false,
      fs: { strict: true, allow: [path.join(root, 'web'), path.join(root, 'shared'), path.join(root, 'node_modules')] },
    },
  };
}

/**
 * Startar Vite. `testOverrides` finns bara för testerna (egen cacheDir, tyst logg, eller en planterad läcka);
 * servern anropar alltid utan.
 */
export async function createShellVite(config: Pick<Config, 'root' | 'hmrPort' | 'port'>, testOverrides: InlineConfig = {}): Promise<ViteDevServer> {
  // Dynamisk import: i produktion (npm start) behövs Vite inte.
  const { createServer } = await import('vite');
  const base = shellViteOptions(config);
  return createServer({ ...base, ...testOverrides, server: { ...base.server, ...testOverrides.server } });
}
