// tests/unit/server-store-git.test.ts — git-hjälparen (CONTRACT §6, §4.6, §15).
// Varje test som visar att något INTE körs har först en kontroll där samma fälla fäller en naiv implementation.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { commitMessage, createAppGit, removeStaleLocks } from '../../server/live/git.ts';
import { makePaths } from '../../server/paths.ts';
import type { Config, Paths } from '../../server/types.ts';

const execFileP = promisify(execFile);

const roots: string[] = [];
function tmpDir(prefix: string): string {
  const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  roots.push(d);
  return d;
}
after(() => {
  for (const d of roots) fs.rmSync(d, { recursive: true, force: true });
});

/** Miljö för testets egna git-anrop (granskning och naiva kontroller). */
const GIT_ENV = {
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@localhost',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@localhost',
};

interface App {
  home: string;
  paths: Paths;
  id: string;
  appDir: string;
  gitDir: string;
}

let counter = 0;
/** En app som registry.create lämnar den: frö-filer och data/apps/<id>/, men inget git än. */
function newApp(): App {
  const home = tmpDir('wb-git-');
  const paths = makePaths({ home } as Config);
  const id = `a${String(++counter).padStart(6, '0')}`;
  const appDir = paths.appDir(id);
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(path.join(appDir, '.gitignore'), '/data/\nnode_modules/\n.DS_Store\n');
  fs.writeFileSync(path.join(appDir, 'CLAUDE.md'), `# ${id}\n\nInga anteckningar ännu.\n`);
  fs.mkdirSync(paths.appDataDir(id), { recursive: true });
  return { home, paths, id, appDir, gitDir: paths.appGitDir(id) };
}

/** Läs appens repo (krokar avstängda även här). */
function look(a: App, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', `--git-dir=${a.gitDir}`, `--work-tree=${a.appDir}`, ...args],
    { cwd: a.appDir, env: GIT_ENV, encoding: 'utf8' },
  ).trim();
}

function findFiles(dir: string, name: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (e.name === name) out.push(path.join(e.parentPath, e.name));
  }
  return out;
}

/** Ett skript som bara skapar markören när det körs. */
function trap(dir: string, name: string, marker: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, `#!/bin/sh\ntouch '${marker}'\nexit 0\n`, { mode: 0o755 });
  return p;
}

/**
 * Krokar som add, commit och reset kan köra. --no-verify hoppar bara över pre-commit och commit-msg;
 * de övriga körs ändå, så bara core.hooksPath=/dev/null stänger dem.
 */
const HOOKS = ['pre-commit', 'commit-msg', 'prepare-commit-msg', 'post-commit', 'reference-transaction', 'post-index-change', 'post-checkout'];

function trapAll(dir: string, markers: string, prefix: string): void {
  for (const h of HOOKS) trap(dir, h, path.join(markers, `${prefix}-${h}`));
}

/* ------------------------------ grunderna ------------------------------ */

test('init: extern git-katalog, första commit "Ny app" med .gitignore och CLAUDE.md, idempotent', async () => {
  const a = newApp();
  const git = createAppGit(a.paths);
  await git.init(a.id);
  assert.ok(fs.existsSync(path.join(a.gitDir, 'HEAD')), 'git-katalogen ligger i data/apps/<id>/git');
  assert.equal(fs.existsSync(path.join(a.appDir, '.git')), false, 'ingen .git i arbetsträdet');
  assert.equal(look(a, 'log', '--format=%s'), 'Ny app');
  assert.equal(look(a, 'log', '--format=%an <%ae>|%cn <%ce>'), 'Workbench <workbench@localhost>|Workbench <workbench@localhost>');
  assert.deepEqual(look(a, 'ls-files').split('\n'), ['.gitignore', 'CLAUDE.md']);
  assert.equal(fs.existsSync(path.join(a.gitDir, 'hooks')), false, 'inga exempelkrokar (--template=)');
  await git.init(a.id);
  assert.equal(look(a, 'rev-list', '--count', 'HEAD'), '1', 'en andra init gör ingen ny commit');
});

test('commitAll: false utan ändringar, true med; data/ och node_modules/ committas aldrig', async () => {
  const a = newApp();
  const git = createAppGit(a.paths);
  await git.init(a.id);
  assert.equal(await git.commitAll(a.id, 'inget'), false);
  fs.writeFileSync(path.join(a.appDir, 'index.html'), '<p>Hej</p>');
  assert.equal(await git.commitAll(a.id, 'Gör en anteckningsapp'), true);
  assert.equal(look(a, 'log', '-1', '--format=%s'), 'Gör en anteckningsapp');
  assert.equal(await git.commitAll(a.id, 'igen'), false);
  fs.mkdirSync(path.join(a.appDir, 'data'));
  fs.writeFileSync(path.join(a.appDir, 'data', 'store.json'), '{"a":1}');
  fs.mkdirSync(path.join(a.appDir, 'node_modules', 'p'), { recursive: true });
  fs.writeFileSync(path.join(a.appDir, 'node_modules', 'p', 'index.js'), '1');
  assert.equal(await git.commitAll(a.id, 'bara data'), false, 'ändringar i data/ och node_modules/ räknas inte');
  assert.deepEqual(look(a, 'ls-files').split('\n'), ['.gitignore', 'CLAUDE.md', 'index.html']);
});

test('fröets /data/ är förankrad: src/data/ versioneras och kan ångras, data/ aldrig (kalibrerat mot data/ utan snedstreck)', async () => {
  const a = newApp(); // fröet: '/data/\nnode_modules/\n.DS_Store\n'
  const git = createAppGit(a.paths);
  await git.init(a.id);
  fs.mkdirSync(path.join(a.appDir, 'src', 'data'), { recursive: true });
  fs.writeFileSync(path.join(a.appDir, 'src', 'data', 'ord.js'), 'export const ord = 1;');
  fs.mkdirSync(path.join(a.appDir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(a.appDir, 'data', 'store.json'), '{}');
  assert.equal(await git.commitAll(a.id, 'ordlista'), true);
  assert.deepEqual(look(a, 'ls-files').split('\n'), ['.gitignore', 'CLAUDE.md', 'src/data/ord.js']);
  fs.writeFileSync(path.join(a.appDir, 'src', 'data', 'ord.js'), 'export const ord = 2;');
  assert.equal(await git.commitAll(a.id, 'ändrad'), true);
  assert.equal(await git.undo(a.id), true);
  assert.equal(fs.readFileSync(path.join(a.appDir, 'src', 'data', 'ord.js'), 'utf8'), 'export const ord = 1;');
  // Kalibrering: med den gamla, oförankrade raden "data/" hade src/data/ aldrig versionerats.
  const b = newApp();
  fs.writeFileSync(path.join(b.appDir, '.gitignore'), 'data/\nnode_modules/\n.DS_Store\n');
  const gitB = createAppGit(b.paths);
  await gitB.init(b.id);
  fs.mkdirSync(path.join(b.appDir, 'src', 'data'), { recursive: true });
  fs.writeFileSync(path.join(b.appDir, 'src', 'data', 'ord.js'), 'export const ord = 1;');
  assert.equal(await gitB.commitAll(b.id, 'ordlista'), false, 'kalibrering: data/ utan snedstreck döljer src/data/');
});

test('undo: false med bara första commit; annars reset --hard HEAD~1, data/ orörd', async () => {
  const a = newApp();
  const git = createAppGit(a.paths);
  await git.init(a.id);
  assert.equal(await git.undo(a.id), false, 'första commiten ångras aldrig');
  const index = path.join(a.appDir, 'index.html');
  fs.writeFileSync(index, 'v1');
  assert.equal(await git.commitAll(a.id, 'ett'), true);
  fs.writeFileSync(index, 'v2');
  fs.writeFileSync(path.join(a.appDir, 'ny.js'), 'x');
  assert.equal(await git.commitAll(a.id, 'två'), true);
  fs.mkdirSync(path.join(a.appDir, 'data'));
  fs.writeFileSync(path.join(a.appDir, 'data', 'store.json'), '{"kvar":true}');

  assert.equal(await git.undo(a.id), true);
  assert.equal(fs.readFileSync(index, 'utf8'), 'v1');
  assert.equal(fs.existsSync(path.join(a.appDir, 'ny.js')), false, 'fil som tillkom i turen tas bort');
  assert.equal(fs.readFileSync(path.join(a.appDir, 'data', 'store.json'), 'utf8'), '{"kvar":true}');
  assert.equal(await git.undo(a.id), true);
  assert.equal(fs.existsSync(index), false);
  assert.equal(await git.undo(a.id), false);
  assert.equal(look(a, 'log', '--format=%s'), 'Ny app');
});

/** Finns gör om-referensen? (rev-parse --verify -q fäller look() när den saknas.) */
function hasRedoRef(a: App): boolean {
  try {
    look(a, 'rev-parse', '-q', '--verify', 'refs/wb/redo^{commit}');
    return true;
  } catch {
    return false;
  }
}

test('gör om: tre commits, två ångra och två gör om ger filerna byte för byte; data/ orörd (§6)', async () => {
  const a = newApp();
  const git = createAppGit(a.paths);
  await git.init(a.id);
  const index = path.join(a.appDir, 'index.html');
  const extra = path.join(a.appDir, 'ny.js');
  const snap = () => ({ index: fs.readFileSync(index), extra: fs.existsSync(extra) ? fs.readFileSync(extra) : null });
  // Byte som inte är ren text (NUL, 0xff, CRLF, flerbytestecken), så att jämförelsen verkligen gäller byten.
  fs.writeFileSync(index, Buffer.from('<p>A</p>\n'));
  assert.equal(await git.commitAll(a.id, 'A'), true);
  const sA = snap();
  fs.writeFileSync(index, Buffer.from([0x3c, 0x70, 0x3e, 0xc3, 0xa5, 0x00, 0xff, 0x0d, 0x0a]));
  fs.writeFileSync(extra, 'export const b = 1;\n');
  assert.equal(await git.commitAll(a.id, 'B'), true);
  const sB = snap();
  fs.writeFileSync(index, Buffer.from('<p>C – åäö</p>\r\n'));
  fs.rmSync(extra);
  assert.equal(await git.commitAll(a.id, 'C'), true);
  const sC = snap();
  const top = look(a, 'rev-parse', 'HEAD');
  // Appens data ändras efter sista commiten: varken ångra eller gör om rör den.
  fs.mkdirSync(path.join(a.appDir, 'data'));
  fs.writeFileSync(path.join(a.appDir, 'data', 'store.json'), '{"form":3}');

  assert.equal(await git.canRedo(a.id), false, 'inget är ångrat än');
  assert.equal(await git.redo(a.id), false);
  assert.equal(await git.undo(a.id), true);
  assert.equal(await git.canRedo(a.id), true);
  assert.equal(await git.undo(a.id), true);
  assert.deepEqual(snap(), sA, 'två ångra: filerna som efter A');
  assert.equal(look(a, 'rev-parse', 'refs/wb/redo'), top, 'referensen pekar fortfarande på den översta commiten');

  assert.equal(await git.redo(a.id), true);
  assert.deepEqual(snap(), sB, 'ett gör om: B byte för byte, ny.js tillbaka');
  assert.equal(await git.canRedo(a.id), true);
  assert.equal(await git.redo(a.id), true);
  assert.deepEqual(snap(), sC, 'två gör om: C byte för byte, ny.js borta igen');
  assert.equal(look(a, 'rev-parse', 'HEAD'), top);
  assert.equal(look(a, 'log', '--format=%s'), 'C\nB\nA\nNy app');
  assert.equal(await git.canRedo(a.id), false, 'framme: inget mer att göra om');
  assert.equal(await git.redo(a.id), false);
  assert.equal(hasRedoRef(a), false, 'referensen tas bort när HEAD når den');
  assert.equal(fs.readFileSync(path.join(a.appDir, 'data', 'store.json'), 'utf8'), '{"form":3}', 'data/ orörd genom alla steg');
});

test('gör om försvinner när historien går isär; en tur utan commit behåller det (§6)', async () => {
  const a = newApp();
  const git = createAppGit(a.paths);
  await git.init(a.id);
  const index = path.join(a.appDir, 'index.html');
  fs.writeFileSync(index, 'B');
  assert.equal(await git.commitAll(a.id, 'B'), true);
  fs.writeFileSync(index, 'C');
  assert.equal(await git.commitAll(a.id, 'C'), true);
  assert.equal(await git.undo(a.id), true);
  assert.equal(await git.canRedo(a.id), true, 'kalibrering: efter ångra går det att göra om');

  fs.writeFileSync(index, 'D');
  assert.equal(await git.commitAll(a.id, 'D'), true);
  assert.equal(await git.canRedo(a.id), false);
  assert.equal(await git.redo(a.id), false);
  assert.equal(fs.readFileSync(index, 'utf8'), 'D', 'gör om rör inte filerna');
  assert.equal(look(a, 'log', '--format=%s'), 'D\nB\nNy app');
  assert.equal(hasRedoRef(a), false, 'den nya commiten tog bort referensen');

  assert.equal(await git.undo(a.id), true);
  assert.equal(await git.commitAll(a.id, 'inget att committa'), false);
  assert.equal(await git.canRedo(a.id), true, 'en tur utan commit behåller gör om');
  assert.equal(await git.redo(a.id), true);
  assert.equal(fs.readFileSync(index, 'utf8'), 'D');
});

test('en gör om-referens som inte kunde tas bort efter en ny commit ger varken canRedo eller gör om (kalibrerat)', async () => {
  const a = newApp();
  const git = createAppGit(a.paths);
  await git.init(a.id);
  const index = path.join(a.appDir, 'index.html');
  fs.writeFileSync(index, 'B');
  assert.equal(await git.commitAll(a.id, 'B'), true);
  fs.writeFileSync(index, 'C');
  assert.equal(await git.commitAll(a.id, 'C'), true);
  assert.equal(await git.undo(a.id), true);
  // Ett färskt lås på referensen: committen går igenom, men städningen (update-ref -d) misslyckas.
  const lock = path.join(a.gitDir, 'refs', 'wb', 'redo.lock');
  fs.writeFileSync(lock, '');
  fs.writeFileSync(index, 'D');
  assert.equal(await git.commitAll(a.id, 'D'), true, 'städningen fäller aldrig en commit som gått igenom');
  const d = look(a, 'rev-parse', 'HEAD');
  fs.rmSync(lock);
  assert.equal(hasRedoRef(a), true, 'kalibrering: referensen till C står kvar');

  // Vägen prövas varje gång: D ligger inte på vägen till C, så gör om skulle annars ta bort D ur historien.
  assert.equal(await git.canRedo(a.id), false, 'canRedo prövar vägen, inte bara referensen');
  assert.equal(await git.redo(a.id), false, 'gör om går aldrig över till den gamla grenen');
  assert.equal(fs.readFileSync(index, 'utf8'), 'D');
  assert.equal(look(a, 'log', '--format=%s'), 'D\nB\nNy app');
  // Nästa ångra sparar D i referensen, så gör om tar tillbaka D och inte C.
  assert.equal(await git.undo(a.id), true);
  assert.equal(look(a, 'rev-parse', 'refs/wb/redo'), d, 'referensen pekar på D');
  assert.equal(await git.redo(a.id), true);
  assert.equal(fs.readFileSync(index, 'utf8'), 'D');
  assert.equal(hasRedoRef(a), false);
});

test('filer som heter HEAD och HEAD~1 i appen stoppar varken ångra eller gör om (kalibrerat mot anropen utan --)', async () => {
  const a = newApp();
  const git = createAppGit(a.paths);
  await git.init(a.id);
  fs.writeFileSync(path.join(a.appDir, 'index.html'), 'v1');
  assert.equal(await git.commitAll(a.id, 'ett'), true);
  for (const f of ['HEAD', 'HEAD~1']) fs.writeFileSync(path.join(a.appDir, f), f);
  assert.equal(await git.commitAll(a.id, 'två'), true);
  const ambiguous = (e: unknown) => /ambiguous argument/.test(String((e as { stderr?: unknown }).stderr));
  assert.throws(() => look(a, 'rev-list', '--count', 'HEAD'), ambiguous, 'kalibrering: utan -- är HEAD tvetydigt');
  assert.throws(() => look(a, 'reset', '-q', '--hard', 'HEAD~1'), ambiguous, 'kalibrering: utan -- är HEAD~1 tvetydigt');

  assert.equal(await git.undo(a.id), true);
  assert.equal(fs.existsSync(path.join(a.appDir, 'HEAD')), false);
  assert.equal(await git.canRedo(a.id), true);
  assert.equal(await git.redo(a.id), true);
  assert.equal(fs.readFileSync(path.join(a.appDir, 'HEAD~1'), 'utf8'), 'HEAD~1');
});

test('data/ och node_modules/ versioneras aldrig, inte ens när Claude tagit bort dem ur .gitignore — kalibrerat', async () => {
  const files = ['data/store.json', 'node_modules/p/i.js', 'sub/node_modules/q/j.js', 'sub/data/kod.js', 'data.json', 'index.html'];
  const plant = (dir: string) => {
    fs.writeFileSync(path.join(dir, '.gitignore'), '# Claude tog bort reglerna\n');
    for (const f of files) {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.writeFileSync(path.join(dir, f), `{"v":1,"f":"${f}"}`);
    }
  };
  // Kalibrering: ett vanligt git add -A med den ändrade .gitignore tar med data/ och node_modules/.
  const control = tmpDir('wb-control-');
  execFileSync('git', ['init', '-q', '--template='], { cwd: control, env: GIT_ENV });
  plant(control);
  execFileSync('git', ['add', '-A'], { cwd: control, env: GIT_ENV });
  const naive = execFileSync('git', ['ls-files'], { cwd: control, env: GIT_ENV, encoding: 'utf8' });
  assert.ok(naive.includes('data/store.json') && naive.includes('node_modules/p/i.js'), 'kalibrering: .gitignore skyddar inte längre');

  const a = newApp();
  const git = createAppGit(a.paths);
  await git.init(a.id);
  plant(a.appDir);
  assert.equal(await git.commitAll(a.id, 'tur'), true);
  assert.deepEqual(look(a, 'ls-files').split('\n'), ['.gitignore', 'CLAUDE.md', 'data.json', 'index.html', 'sub/data/kod.js']);

  // Ångra rör aldrig appens data, även när det som ångras ändrade data.
  fs.writeFileSync(path.join(a.appDir, 'data', 'store.json'), '{"v":2}');
  fs.writeFileSync(path.join(a.appDir, 'index.html'), 'v2');
  assert.equal(await git.commitAll(a.id, 'tur två'), true);
  assert.equal(await git.undo(a.id), true);
  assert.equal(fs.readFileSync(path.join(a.appDir, 'data', 'store.json'), 'utf8'), '{"v":2}');

  // Versaler på disken (APFS är skiftlägesokänsligt): Data/ räknas som data/.
  fs.renameSync(path.join(a.appDir, 'data'), path.join(a.appDir, 'Data'));
  fs.writeFileSync(path.join(a.appDir, 'Data', 'secrets.json'), '{"nyckel":"hemligt"}');
  assert.equal(await git.commitAll(a.id, 'versaler'), false, 'inget att committa');
  assert.ok(!look(a, 'ls-files').toLowerCase().includes('secrets'));
});

test('commitMessage: första raden med innehåll, utan kontrolltecken, högst 72 kodpunkter', () => {
  assert.equal(commitMessage('Gör en klocka\nmed sekunder'), 'Gör en klocka');
  assert.equal(commitMessage('\n\n  Andra\traden  \r\ntredje'), 'Andra raden');
  assert.equal(commitMessage('Rad ett\u{2028}rad två'), 'Rad ett');
  assert.equal(commitMessage('a\x07b\x1b[31mc\x7fd\x9be'), 'ab[31mcde', 'C0, DEL och C1 tas bort');
  assert.equal(commitMessage('ett\x85två'), 'ett', 'NEL (U+0085) är en radbrytning');
  assert.equal(commitMessage('\u{202e}spegel\u{202c} text'), 'spegel text');
  assert.equal(commitMessage('x'.repeat(100)), 'x'.repeat(72));
  assert.equal(Array.from(commitMessage('å'.repeat(80))).length, 72);
  assert.equal(Array.from(commitMessage('\u{1f600}'.repeat(80))).length, 72, 'räknas i kodpunkter, inte UTF-16');
  assert.equal(commitMessage(''), 'Ändring');
  assert.equal(commitMessage(' \x00\x01 \n\t'), 'Ändring');
  assert.equal(commitMessage('--amend'), '--amend', 'ett meddelande som ser ut som en flagga är bara text');
});

test('ogiltiga id avvisas som löften och rör ingenting', async () => {
  const a = newApp();
  const git = createAppGit(a.paths);
  for (const bad of ['../x', 'A..', '', 'a/b', '..%2Fx']) {
    await assert.rejects(git.init(bad));
    await assert.rejects(git.commitAll(bad, 'x'));
    await assert.rejects(git.undo(bad));
    await assert.rejects(git.redo(bad));
    await assert.rejects(git.canRedo(bad));
  }
  assert.deepEqual(fs.readdirSync(path.join(a.home, 'data', 'apps')), [a.id]);
});

test('serialiseras per app: samtidiga anrop körs i anropsordning utan index.lock-fel', async () => {
  const a = newApp();
  const git = createAppGit(a.paths);
  await git.init(a.id);
  fs.writeFileSync(path.join(a.appDir, 'index.html'), 'x');
  const results = await Promise.all([
    git.commitAll(a.id, 'ett'),
    git.commitAll(a.id, 'två'),
    git.undo(a.id),
    git.commitAll(a.id, 'tre'),
  ]);
  assert.deepEqual(results, [true, false, true, false]);
  assert.equal(look(a, 'log', '--format=%s'), 'Ny app');
});

test('commitAll självläker: saknas git-katalogen läggs den upp och allt blir första commiten', async () => {
  const a = newApp();
  const git = createAppGit(a.paths);
  fs.writeFileSync(path.join(a.appDir, 'index.html'), 'x');
  assert.equal(await git.commitAll(a.id, 'tur'), false);
  assert.equal(look(a, 'log', '--format=%s'), 'Ny app');
  assert.equal(await git.undo(a.id), false, 'inget att ångra: appens filer finns kvar');
  assert.ok(fs.existsSync(path.join(a.appDir, 'index.html')));
});

test('en kvarlämnad index.lock (äldre än 10 s) tas bort före nästa commit och ångra; en färsk rörs inte (§6)', async () => {
  const a = newApp();
  const git = createAppGit(a.paths);
  await git.init(a.id);
  const lock = path.join(a.gitDir, 'index.lock');
  const old = (Date.now() - 20_000) / 1000;

  // Kalibrering: låset stoppar verkligen git (annars bevisar testet ingenting).
  fs.writeFileSync(lock, '');
  fs.writeFileSync(path.join(a.appDir, 'index.html'), '<p>1</p>');
  await assert.rejects(git.commitAll(a.id, 'färskt lås'), /index\.lock/);
  assert.ok(fs.existsSync(lock), 'ett färskt lås (någon kan hålla det) tas aldrig bort');

  // Samma lås, men kvarlämnat sedan 20 s: tas bort, och committen går igenom.
  fs.utimesSync(lock, old, old);
  assert.equal(await git.commitAll(a.id, 'efter kraschen'), true);
  assert.equal(fs.existsSync(lock), false);
  assert.equal(look(a, 'log', '-1', '--format=%s'), 'efter kraschen');

  // Ångra efter en krasch: samma regel.
  fs.writeFileSync(lock, '');
  fs.utimesSync(lock, old, old);
  assert.equal(await git.undo(a.id), true);
  assert.equal(fs.existsSync(lock), false);
  assert.equal(fs.existsSync(path.join(a.appDir, 'index.html')), false);

  // Grenlåset som en avbruten commit kan lämna kvar.
  fs.writeFileSync(path.join(a.appDir, 'index.html'), '<p>2</p>');
  const refLock = path.join(a.gitDir, 'refs', 'heads', 'main.lock');
  fs.writeFileSync(refLock, '');
  fs.utimesSync(refLock, old, old);
  assert.equal(await git.commitAll(a.id, 'grenlåset'), true);
  assert.equal(fs.existsSync(refLock), false);
});

test('ett kvarlämnat refs/wb/redo.lock stoppar inte ångra; ett färskt rörs inte (kalibrerat)', async () => {
  const a = newApp();
  const git = createAppGit(a.paths);
  await git.init(a.id);
  fs.writeFileSync(path.join(a.appDir, 'index.html'), 'x');
  assert.equal(await git.commitAll(a.id, 'tur'), true);
  const lock = path.join(a.gitDir, 'refs', 'wb', 'redo.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, '');
  // Kalibrering: låset stoppar verkligen referensen som ångra sparar.
  await assert.rejects(git.undo(a.id), /redo\.lock/);
  assert.ok(fs.existsSync(lock), 'ett färskt lås tas aldrig bort');
  assert.ok(fs.existsSync(path.join(a.appDir, 'index.html')), 'inget återställdes');
  const old = (Date.now() - 20_000) / 1000;
  fs.utimesSync(lock, old, old);
  assert.equal(await git.undo(a.id), true);
  assert.equal(fs.existsSync(lock), false);
  assert.equal(await git.redo(a.id), true);
  // packed-refs.lock tas som de andra låsen (update-ref -d tar det en kort stund).
  const packed = path.join(a.gitDir, 'packed-refs.lock');
  fs.writeFileSync(packed, '');
  fs.utimesSync(packed, old, old);
  assert.deepEqual(await removeStaleLocks(a.gitDir), ['packed-refs.lock']);
});

/* ------------------------------ skalinjektion (§15) ------------------------------ */

const PAYLOADS = [
  '`touch pwned` $(touch pwned) "; touch pwned', // kontraktets meddelande (§15)
  '$(touch pwned)',
  '`touch pwned`',
  '"; touch pwned; echo "',
];

/** Naiva implementationer som bygger en skalrad. Används bara som planterad läcka i en egen katalog. */
const NAIVE: Record<string, (m: string) => string> = {
  'git commit -m "<text>"': (m) => `git commit -q --allow-empty -m "${m}"`,
  'git commit -m "<text med escapade citattecken>"': (m) => `git commit -q --allow-empty -m "${m.replace(/"/g, '\\"')}"`,
};
const SANDBOX = fs.existsSync('/usr/bin/sandbox-exec');

/** Kör de naiva varianterna i varsin tillfällig katalog (i sandbox-exec som bara får skriva där). Vilka skapade pwned? */
async function plantedLeaks(payload: string): Promise<string[]> {
  const fired: string[] = [];
  for (const [name, line] of Object.entries(NAIVE)) {
    const dir = tmpDir('wb-planted-');
    execFileSync('git', ['init', '-q', '--template='], { cwd: dir, env: GIT_ENV });
    const profile = `(version 1)(allow default)(deny file-write* (subpath "/"))`
      + `(allow file-write* (subpath "${dir}") (literal "/dev/null") (literal "/dev/dtracehelper"))`;
    const [cmd, argv] = SANDBOX ? ['/usr/bin/sandbox-exec', ['-p', profile, '/bin/sh', '-c', line(payload)]] : ['/bin/sh', ['-c', line(payload)]];
    await execFileP(cmd as string, argv as string[], { cwd: dir, env: GIT_ENV }).catch(() => {});
    if (fs.existsSync(path.join(dir, 'pwned'))) fired.push(name);
  }
  return fired;
}

for (const payload of PAYLOADS) {
  test(`commit-meddelandet ${JSON.stringify(payload)} kör ingenting (kalibrerat mot en planterad läcka)`, async () => {
    const fired = await plantedLeaks(payload);
    assert.ok(fired.length > 0, 'kalibrering: minst en naiv skalvariant ska fällas av nyttolasten');

    const a = newApp();
    const git = createAppGit(a.paths);
    await git.init(a.id);
    fs.writeFileSync(path.join(a.appDir, 'index.html'), '<p>Hej</p>');
    assert.equal(await git.commitAll(a.id, payload), true);
    assert.deepEqual(findFiles(a.home, 'pwned'), [], 'ingen pwned någonstans i WORKBENCH_HOME');
    assert.equal(fs.existsSync(path.join(process.cwd(), 'pwned')), false, 'ingen pwned i processens katalog');
    assert.equal(look(a, 'log', '-1', '--format=%B'), commitMessage(payload), 'meddelandet sparas ordagrant');
  });
}

/* ------------------------------ krokar och konfiguration (§4.6) ------------------------------ */

test('en ond .git i arbetsträdet (krokar, core.hooksPath) körs aldrig — kalibrerat', async () => {
  const a = newApp();
  const git = createAppGit(a.paths);
  await git.init(a.id);
  const markers = tmpDir('wb-markers-');
  const naiveCommit = () => execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'naiv'], { cwd: a.appDir, env: GIT_ENV, stdio: 'ignore' });

  // Planterat: Claude lägger ett eget repo i appens mapp, med krokar.
  execFileSync('git', ['init', '-q', '--template='], { cwd: a.appDir, env: GIT_ENV });
  trapAll(path.join(a.appDir, '.git', 'hooks'), markers, 'hooks');
  naiveCommit(); // kalibrering: en naiv commit i mappen (git upptäcker .git) kör krokarna
  assert.ok(fs.existsSync(path.join(markers, 'hooks-pre-commit')), 'kalibrering: .git/hooks körs av naiv git');

  // Planterat: core.hooksPath i arbetsträdets .git/config.
  const evilHooks = path.join(a.appDir, 'krokar');
  trapAll(evilHooks, markers, 'hookspath');
  execFileSync('git', ['config', 'core.hooksPath', evilHooks], { cwd: a.appDir, env: GIT_ENV });
  naiveCommit();
  assert.ok(fs.existsSync(path.join(markers, 'hookspath-pre-commit')), 'kalibrering: core.hooksPath körs av naiv git');

  for (const f of fs.readdirSync(markers)) fs.unlinkSync(path.join(markers, f));
  fs.writeFileSync(path.join(a.appDir, 'index.html'), '<p>Hej</p>');
  assert.equal(await git.commitAll(a.id, 'efter planteringen'), true);
  fs.writeFileSync(path.join(a.appDir, 'index.html'), '<p>Hej igen</p>');
  assert.equal(await git.commitAll(a.id, 'en till'), true);
  assert.equal(await git.undo(a.id), true);
  assert.equal(await git.redo(a.id), true);
  assert.deepEqual(fs.readdirSync(markers), [], 'ingen krok kördes');
  assert.ok(!look(a, 'ls-files').split('\n').some((f) => f.startsWith('.git/')), 'arbetsträdets .git committas aldrig');
});

test('krokar, core.hooksPath och core.fsmonitor i appens egen git-katalog körs aldrig — kalibrerat', async () => {
  const a = newApp();
  const git = createAppGit(a.paths);
  await git.init(a.id);
  const markers = tmpDir('wb-markers-');
  const naive = (...args: string[]) =>
    execFileSync('git', [`--git-dir=${a.gitDir}`, `--work-tree=${a.appDir}`, ...args], { cwd: a.appDir, env: GIT_ENV, stdio: 'ignore' });

  trapAll(path.join(a.gitDir, 'hooks'), markers, 'gitdir-hooks');
  naive('commit', '-q', '--allow-empty', '-m', 'naiv');
  assert.ok(fs.existsSync(path.join(markers, 'gitdir-hooks-pre-commit')), 'kalibrering: $GIT_DIR/hooks körs utan -c core.hooksPath');
  naive('commit', '-q', '--no-verify', '--allow-empty', '-m', 'naiv');
  assert.ok(fs.existsSync(path.join(markers, 'gitdir-hooks-reference-transaction')), 'kalibrering: --no-verify räcker inte');

  const other = path.join(markers, 'annan');
  trapAll(other, markers, 'gitdir-hookspath');
  naive('config', 'core.hooksPath', other);
  naive('commit', '-q', '--allow-empty', '-m', 'naiv');
  assert.ok(fs.existsSync(path.join(markers, 'gitdir-hookspath-post-commit')), 'kalibrering: core.hooksPath i git-katalogens config körs');

  const monitor = trap(path.join(markers, 'fsmonitor'), 'monitor', path.join(markers, 'gitdir-fsmonitor'));
  naive('config', 'core.fsmonitor', monitor);
  fs.writeFileSync(path.join(a.appDir, 'f.txt'), '1');
  naive('status', '--porcelain');
  assert.ok(fs.existsSync(path.join(markers, 'gitdir-fsmonitor')), 'kalibrering: core.fsmonitor körs av naiv git status');

  for (const f of fs.readdirSync(markers)) if (fs.statSync(path.join(markers, f)).isFile()) fs.unlinkSync(path.join(markers, f));
  fs.writeFileSync(path.join(a.appDir, 'index.html'), '<p>Hej</p>');
  assert.equal(await git.commitAll(a.id, 'med manipulerad config'), true);
  assert.equal(await git.undo(a.id), true);
  assert.equal(await git.redo(a.id), true);
  const left = fs.readdirSync(markers).filter((f) => fs.statSync(path.join(markers, f)).isFile());
  assert.deepEqual(left, [], 'varken krok, hooksPath eller fsmonitor kördes');
});

test('användarens globala git-konfig (HOME/.gitconfig, ~/.config/git/*) läses aldrig — kalibrerat', async () => {
  const a = newApp();
  const git = createAppGit(a.paths);
  await git.init(a.id);
  const markers = tmpDir('wb-markers-');
  const fakeHome = tmpDir('wb-home-');
  const hook = trap(path.join(fakeHome, 'krokar'), 'pre-commit', path.join(markers, 'global-hookspath'));
  const clean = trap(path.join(fakeHome, 'filter'), 'clean', path.join(markers, 'global-filter'));
  fs.writeFileSync(
    path.join(fakeHome, '.gitconfig'),
    `[core]\n\thooksPath = ${path.dirname(hook)}\n[filter "ond"]\n\tclean = ${clean}\n`,
  );
  fs.mkdirSync(path.join(fakeHome, '.config', 'git'), { recursive: true });
  fs.writeFileSync(path.join(fakeHome, '.config', 'git', 'attributes'), '* filter=ond\n');
  // Claude kan själv skriva en .gitattributes i appen som pekar ut ett filter ur användarens globala konfig
  // (t.ex. git-lfs). Bara GIT_CONFIG_GLOBAL=/dev/null hindrar det: -c core.attributesFile gäller inte arbetsträdet.
  fs.writeFileSync(path.join(a.appDir, '.gitattributes'), '*.html filter=ond\n');

  // Kalibrering: naiv git med HOME satt och utan GIT_CONFIG_GLOBAL läser den globala konfigurationen.
  const { GIT_CONFIG_GLOBAL: _g, ...withoutGlobal } = GIT_ENV;
  fs.writeFileSync(path.join(a.appDir, 'kalibrering.txt'), '1');
  const naiveEnv = { ...withoutGlobal, HOME: fakeHome };
  execFileSync('git', [`--git-dir=${a.gitDir}`, `--work-tree=${a.appDir}`, 'add', '-A'], { cwd: a.appDir, env: naiveEnv });
  execFileSync('git', [`--git-dir=${a.gitDir}`, `--work-tree=${a.appDir}`, 'commit', '-q', '-m', 'naiv'], { cwd: a.appDir, env: naiveEnv });
  assert.ok(fs.existsSync(path.join(markers, 'global-filter')), 'kalibrering: filter från ~/.config/git/attributes + ~/.gitconfig körs');
  assert.ok(fs.existsSync(path.join(markers, 'global-hookspath')), 'kalibrering: core.hooksPath i ~/.gitconfig körs');

  for (const f of ['global-filter', 'global-hookspath']) fs.unlinkSync(path.join(markers, f));
  const savedHome = process.env.HOME;
  process.env.HOME = fakeHome; // childEnv() skickar HOME vidare till git
  try {
    fs.writeFileSync(path.join(a.appDir, 'index.html'), '<p>Hej</p>');
    assert.equal(await git.commitAll(a.id, 'med ond HOME'), true);
    assert.equal(await git.undo(a.id), true);
    assert.equal(await git.redo(a.id), true);
  } finally {
    process.env.HOME = savedHome;
  }
  assert.deepEqual(fs.readdirSync(markers), [], 'varken globala krokar eller filter kördes');
});
