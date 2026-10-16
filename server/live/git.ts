// server/live/git.ts — git per app med extern git-katalog (CONTRACT §6, §4.6; AppGit i server/types.ts).
//
// Arbetsträdet apps/<id> skrivs av Claude och av appens backend, så git får aldrig läsa något därifrån som kan köra kod:
// - git-katalogen ligger utanför Claudes räckvidd (Paths.appGitDir = data/apps/<id>/git) och anges alltid explicit,
//   så att en .git i arbetsträdet aldrig upptäcks;
// - krokar, fsmonitor och signering är avstängda med -c, som går före all konfiguration i filer;
// - användarens och systemets git-konfiguration läses inte (GIT_CONFIG_GLOBAL=/dev/null, GIT_CONFIG_NOSYSTEM=1),
//   och inte heller ~/.config/git/attributes eller ~/.config/git/ignore;
// - varje anrop är execFile('git', argv) utan skal, med miljön från childEnv(). Commit-meddelandet är ett eget argv-element.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { childEnv } from '../config.ts';
import type { AppGit, Paths } from '../types.ts';

/** -c-flaggor före varje underkommando. De tre första kräver kontraktet; resten håller git förutsägbart och tyst. */
const SAFE_CONFIG = [
  'core.hooksPath=/dev/null', // inga krokar, var de än ligger
  'core.fsmonitor=false', // ingen fsmonitor-krok vid add och status
  'commit.gpgsign=false',
  'core.attributesFile=/dev/null', // inte ~/.config/git/attributes
  'core.excludesFile=/dev/null', // inte ~/.config/git/ignore: bara appens egen .gitignore gäller
  'init.defaultBranch=main',
  'gc.auto=0', // inget underhåll som startar bakgrundsprocesser
  'maintenance.auto=false',
] as const;

const FIRST_COMMIT = 'Ny app';
/**
 * Låsfiler som en hårt avbruten git-process lämnar kvar (index.lock enligt §6, plus HEAD- och grenlåset som
 * en commit tar). Anrop för samma app körs i tur och ordning och tar 10–50 ms, så ett lås som är äldre än
 * 10 s hålls inte av någon: utan det här skulle appen aldrig kunna committas eller ångras igen.
 */
const STALE_LOCK_MS = 10_000;
const LOCK_FILES = ['index.lock', 'HEAD.lock', path.join('refs', 'heads', 'main.lock')];
const FALLBACK_MESSAGE = 'Ändring';
const MAX_MESSAGE = 72;

/**
 * add -A för hela arbetsträdet utom data/ (första segmentet, skiftlägesokänsligt) och node_modules/ (var som helst).
 * .gitignore säger samma sak men skrivs av Claude: tar den bort data/ skulle appens data och secrets.json annars
 * hamna i historiken, och varje ångra (reset --hard) skulle skriva tillbaka gammal data. Pathspec gäller alltid.
 * "[d]ata/**" och inte "data": git 2.50 räknar ett undantag vars bokstavliga början är en ignorerad sökväg som att
 * man lagt till den uttryckligen ("paths are ignored", utgångskod 1). Med ett jokertecken först händer det inte (uppmätt).
 */
const ADD_ALL = ['add', '-A', '--', '.', ':(exclude,glob,icase)[d]ata/**', ':(exclude,glob,icase)**/node_modules/**'];

/**
 * Arbetsträd som git själv skriver om just nu (ångra = reset --hard), med när det senast slutade.
 * Bevakaren (watcher.ts) läser det: git:s egna ändringar är inga manuella ändringar (§7.3), och ångra-flödet
 * laddar om appen själv (§7.4), efter en eventuell omstart av backenden. Nyckeln är arbetsträdets sökväg.
 */
const rewrites = new Map<string, { active: number; endedAt: number }>();
const REWRITE_GRACE_MS = 500; // FSEvents levererar inom 5–25 ms (uppmätt); god marginal

/** Har git skrivit om arbetsträdet nyss (eller gör det just nu)? */
export function gitRewritingWorkTree(workTree: string): boolean {
  const s = rewrites.get(workTree);
  return !!s && (s.active > 0 || Date.now() - s.endedAt < REWRITE_GRACE_MS);
}

async function asRewrite<T>(workTree: string, fn: () => Promise<T>): Promise<T> {
  const s = rewrites.get(workTree) ?? { active: 0, endedAt: 0 };
  rewrites.set(workTree, s);
  s.active++;
  try {
    return await fn();
  } finally {
    s.active--;
    s.endedAt = Date.now();
  }
}

function gitEnv(): Record<string, string> {
  return childEnv({
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Workbench',
    GIT_AUTHOR_EMAIL: 'workbench@localhost',
    GIT_COMMITTER_NAME: 'Workbench',
    GIT_COMMITTER_EMAIL: 'workbench@localhost',
  });
}

/**
 * Commit-meddelandet: första raden med innehåll, utan kontrolltecken (och utan riktningsstyrande tecken),
 * högst 72 kodpunkter. Tomt blir "Ändring", eftersom git vägrar tomma meddelanden.
 */
export function commitMessage(text: string): string {
  const lines = String(text ?? '').split(/\r\n|[\n\r\u{85}\u{2028}\u{2029}]/u);
  for (const raw of lines) {
    const line = raw
      .replace(/\t/g, ' ')
      .replace(/[\p{Cc}\u{200e}\u{200f}\u{202a}-\u{202e}\u{2066}-\u{2069}]/gu, '')
      .trim();
    if (line) return Array.from(line).slice(0, MAX_MESSAGE).join('').trimEnd();
  }
  return FALLBACK_MESSAGE;
}

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Kör git för en app. Löser för de utgångskoder som räknas som svar (standard 0), annars ett fel. */
function runGit(gitDir: string, workTree: string, args: string[], okCodes: number[] = [0]): Promise<GitResult> {
  const argv = [...SAFE_CONFIG.flatMap((c) => ['-c', c]), `--git-dir=${gitDir}`, `--work-tree=${workTree}`, ...args];
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      argv,
      { cwd: workTree, env: gitEnv(), timeout: 120_000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : -1) : 0;
        if (okCodes.includes(code)) {
          resolve({ code, stdout, stderr });
          return;
        }
        const why = String(stderr || err?.message || '').trim();
        reject(new Error(`git ${args[0]} misslyckades (${err?.code ?? err?.signal ?? code}): ${why}`));
      },
    );
  });
}

/** Tar bort kvarlämnade lås (äldre än 10 s) i git-katalogen. Returnerar de borttagna. */
export async function removeStaleLocks(gitDir: string, now = Date.now()): Promise<string[]> {
  const removed: string[] = [];
  for (const rel of LOCK_FILES) {
    const file = path.join(gitDir, rel);
    let st: fs.Stats;
    try {
      st = await fs.promises.lstat(file);
    } catch {
      continue;
    }
    if (!st.isFile() || now - st.mtimeMs < STALE_LOCK_MS) continue;
    try {
      await fs.promises.unlink(file);
      removed.push(rel);
    } catch {
      /* redan borta */
    }
  }
  if (removed.length) console.warn(`[git] tog bort kvarlämnade lås i ${gitDir}: ${removed.join(', ')}`);
  return removed;
}

export function createAppGit(paths: Paths): AppGit {
  // En app i taget: commit efter en tur och ångra får aldrig köra samtidigt mot samma index.
  const queues = new Map<string, Promise<unknown>>();

  function serial<T>(appId: string, fn: () => Promise<T>): Promise<T> {
    const prev = queues.get(appId) ?? Promise.resolve();
    const next = prev.then(fn);
    const tail = next.catch(() => {});
    queues.set(appId, tail);
    void tail.then(() => {
      if (queues.get(appId) === tail) queues.delete(appId);
    });
    return next;
  }

  /** Sökvägarna kastar för ogiltiga id (Paths), innan något körs. */
  function dirs(appId: string): { gitDir: string; workTree: string } {
    return { gitDir: paths.appGitDir(appId), workTree: paths.appDir(appId) };
  }

  async function initUnlocked(gitDir: string, workTree: string): Promise<void> {
    await fs.promises.mkdir(path.dirname(gitDir), { recursive: true });
    // --template= ger en tom git-katalog: inga exempelkrokar, ingen info/exclude.
    await runGit(gitDir, workTree, ['init', '-q', '--template=']);
    const head = await runGit(gitDir, workTree, ['rev-parse', '-q', '--verify', 'HEAD'], [0, 1]);
    if (head.code === 0) return; // redan initierad
    await runGit(gitDir, workTree, ADD_ALL);
    await runGit(gitDir, workTree, ['commit', '-q', '--no-verify', '--allow-empty', '-m', FIRST_COMMIT]);
  }

  return {
    // async: ett ogiltigt id blir ett avvisat löfte, aldrig ett synkront undantag.
    async init(appId) {
      const { gitDir, workTree } = dirs(appId);
      return serial(appId, () => initUnlocked(gitDir, workTree));
    },

    async commitAll(appId, message) {
      const { gitDir, workTree } = dirs(appId);
      const msg = commitMessage(message);
      return serial(appId, async () => {
        // Saknas git-katalogen (t.ex. data/ rensad) läggs den upp igen; då blir allt som finns den första commiten.
        if (!fs.existsSync(path.join(gitDir, 'HEAD'))) await initUnlocked(gitDir, workTree);
        await removeStaleLocks(gitDir);
        await runGit(gitDir, workTree, ADD_ALL);
        const diff = await runGit(gitDir, workTree, ['diff', '--cached', '--quiet'], [0, 1]);
        if (diff.code === 0) return false;
        await runGit(gitDir, workTree, ['commit', '-q', '--no-verify', '-m', msg]);
        return true;
      });
    },

    async undo(appId) {
      const { gitDir, workTree } = dirs(appId);
      return serial(appId, async () => {
        if (!fs.existsSync(path.join(gitDir, 'HEAD'))) return false;
        const count = await runGit(gitDir, workTree, ['rev-list', '--count', 'HEAD'], [0, 128]);
        if (count.code !== 0 || Number(count.stdout.trim()) <= 1) return false;
        await removeStaleLocks(gitDir);
        await asRewrite(workTree, () => runGit(gitDir, workTree, ['reset', '-q', '--hard', 'HEAD~1']));
        return true;
      });
    },
  };
}
