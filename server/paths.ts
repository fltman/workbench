// server/paths.ts — alla sökvägar på ett ställe. FRUSET (CONTRACT §3, §4.6).
// Funktionerna per app KASTAR för ogiltiga id, så att ett id aldrig kan peka ut ur apps/ eller data/apps/.
import fs from 'node:fs';
import path from 'node:path';
import { APP_ID_RE } from '../shared/protocol.ts';
import type { Config, Paths } from './types.ts';

function checkId(appId: string): string {
  if (typeof appId !== 'string' || !APP_ID_RE.test(appId)) throw new Error(`ogiltigt app-id: ${JSON.stringify(appId)}`);
  return appId;
}

export function makePaths(config: Config): Paths {
  const appsDir = path.join(config.home, 'apps');
  const dataDir = path.join(config.home, 'data');
  const trashDir = path.join(dataDir, 'trash');
  for (const d of [appsDir, dataDir, trashDir, path.join(dataDir, 'apps')]) fs.mkdirSync(d, { recursive: true });
  return {
    appsDir,
    dataDir,
    trashDir,
    sceneFile: path.join(dataDir, 'workbench.json'),
    appDir: (appId) => path.join(appsDir, checkId(appId)),
    appDataDir: (appId) => path.join(dataDir, 'apps', checkId(appId)),
    appGitDir: (appId) => path.join(dataDir, 'apps', checkId(appId), 'git'),
  };
}
