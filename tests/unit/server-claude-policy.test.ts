// Policyn (CONTRACT §8.5 punkt 1): sökvägar prövas på realpath av närmaste befintliga förfader.
// Varje "läcker inte"-fall fälls först av en planterad läcka (en naiv lexikal policy som släpper igenom det).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { checkPolicy, isInside, resolveReal } from '../../server/claude/policy.ts';
import { rmrf, tmpHome } from './server-claude-kit.ts';

let root: string;
let app: string;
let outside: string;

before(() => {
  root = tmpHome('wb-policy');
  app = path.join(root, 'apps', 'aapp001');
  outside = path.join(root, 'outside');
  fs.mkdirSync(path.join(app, 'sub'), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'hemligt');
  fs.symlinkSync(outside, path.join(app, 'link')); // länk ut ur appen
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(app, 'leak.txt'));
});

after(() => rmrf(root));

const deny = async (toolName: string, input: Record<string, unknown>, extra: { blockedPath?: string; sandbox?: boolean } = {}) =>
  checkPolicy({ appReal: app, toolName, input, blockedPath: extra.blockedPath, sandbox: extra.sandbox ?? true });

/** Den planterade läckan: spikens lexikala policy (path.resolve + path.relative, ingen realpath). */
function naivePolicy(appDir: string, input: Record<string, unknown>): string | null {
  for (const k of ['file_path', 'notebook_path', 'path']) {
    if (typeof input[k] !== 'string') continue;
    const abs = path.resolve(appDir, input[k] as string);
    const rel = path.relative(appDir, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return 'outside';
  }
  return null;
}

describe('resolveReal och isInside', () => {
  test('befintlig fil inne i appen', async () => {
    assert.equal(await resolveReal('sub', app), path.join(app, 'sub'));
  });
  test('ny fil under befintlig mapp behåller resten', async () => {
    assert.equal(await resolveReal('sub/ny/fil.txt', app), path.join(app, 'sub', 'ny', 'fil.txt'));
  });
  test('symbolisk länk följs som kärnan gör', async () => {
    assert.equal(await resolveReal('link/x.txt', app), path.join(outside, 'x.txt'));
  });
  test('"länk/.." löses efter länken, inte lexikalt', async () => {
    // lexikalt vore detta app/x, men kärnan går link → outside → .. → root
    assert.equal(await resolveReal('link/../x', app), path.join(root, 'x'));
  });
  test('~ betyder hemkatalogen', async () => {
    assert.ok((await resolveReal('~/.ssh/known_hosts', app)).startsWith(fs.realpathSync(os.homedir())));
  });
  test('isInside', () => {
    assert.equal(isInside('/a/b', '/a/b'), true);
    assert.equal(isInside('/a/b', '/a/b/c'), true);
    assert.equal(isInside('/a/b', '/a/bc'), false);
    assert.equal(isInside('/a/b', '/a'), false);
  });
});

describe('policyn nekar det som pekar ut ur appen', () => {
  test('relativ fil i appen godtas', async () => {
    assert.equal(await deny('Write', { file_path: 'index.html', content: 'x' }), null);
    assert.equal(await deny('Write', { file_path: path.join(app, 'sub', 'a.js'), content: 'x' }), null);
  });

  test('absolut sökväg utanför nekas, med engelskt meddelande', async () => {
    const m = await deny('Read', { file_path: '/etc/passwd' });
    assert.match(m ?? '', /outside this app's folder/);
  });

  test('.. ut ur appen nekas', async () => {
    assert.ok(await deny('Write', { file_path: '../x', content: '' }));
    assert.ok(await deny('Glob', { pattern: '../../**/*' }));
  });

  test('~/.ssh nekas', async () => {
    assert.ok(await deny('Read', { file_path: '~/.ssh/known_hosts' }));
  });

  test('blockedPath utanför nekas', async () => {
    assert.ok(await deny('Bash', { command: 'cat x' }, { blockedPath: path.join(outside, 'secret.txt') }));
    assert.equal(await deny('Bash', { command: 'cat x' }, { blockedPath: path.join(app, 'x') }), null);
  });

  test('Glob med absolut mönster utanför nekas, relativt mönster godtas', async () => {
    assert.ok(await deny('Glob', { pattern: `${os.homedir()}/**/*.pem` }));
    assert.ok(await deny('Grep', { pattern: 'x', path: '/Users' }));
    assert.equal(await deny('Glob', { pattern: 'src/**/*.js' }), null);
  });

  test('symbolisk länk ut ur appen nekas (planterad läcka: den lexikala policyn släpper igenom)', async () => {
    const input = { file_path: 'link/secret.txt' };
    assert.equal(naivePolicy(app, input), null, 'kalibrering: den naiva policyn ska läcka här');
    assert.ok(await deny('Read', input));
    const input2 = { file_path: 'leak.txt' };
    assert.equal(naivePolicy(app, input2), null, 'kalibrering: den naiva policyn ska läcka här');
    assert.ok(await deny('Read', input2));
  });

  test('"länk/../x" nekas (planterad läcka: lexikal normalisering stannar i appen)', async () => {
    const input = { file_path: 'link/../x' };
    assert.equal(naivePolicy(app, input), null, 'kalibrering');
    assert.ok(await deny('Write', { ...input, content: '' }));
  });

  test('skiftlägesvariant av appens egen sökväg är inne i appen (APFS)', async () => {
    const upper = app.replace('aapp001', 'AAPP001');
    // Bara meningsfullt på ett skiftlägesokänsligt filsystem.
    if (!fs.existsSync(upper)) return;
    assert.equal(await deny('Write', { file_path: path.join(upper, 'x.txt'), content: '' }), null);
  });

  test('nästlade strängar prövas också', async () => {
    assert.ok(await deny('MultiEdit', { file_path: 'a.txt', edits: [{ old_string: 'a', new_string: 'b', extra: '/etc/hosts' }] }));
  });

  test('fritext och filinnehåll räknas inte som sökvägar', async () => {
    assert.equal(await deny('Bash', { command: 'npm test', description: 'Kör ../../.. tester /tmp' }), null);
    assert.equal(await deny('Write', { file_path: 'a.css', content: '/* kommentar */ body{}' }), null);
    assert.equal(await deny('WebFetch', { url: 'https://example.com/a/../b', prompt: '/sammanfatta' }), null);
    assert.equal(await deny('AskUserQuestion', { questions: [{ question: '/api eller /v1?', header: 'x', multiSelect: false, options: [{ label: '/etc' }] }] }), null);
  });

  test('en sträng med NUL nekas', async () => {
    assert.ok(await deny('Read', { file_path: '/tmp/x\0y' }));
  });
});

describe('.claude/ är skrivskyddat', () => {
  test('Write, Edit och NotebookEdit under .claude/ nekas', async () => {
    assert.match((await deny('Write', { file_path: '.claude/settings.json', content: '{}' })) ?? '', /\.claude/);
    assert.ok(await deny('Edit', { file_path: path.join(app, '.claude', 'settings.local.json'), old_string: 'a', new_string: 'b' }));
    assert.ok(await deny('NotebookEdit', { notebook_path: '.claude/x.ipynb', new_source: '' }));
  });
  test('skiftlägesvarianten .CLAUDE nekas också', async () => {
    assert.ok(await deny('Write', { file_path: '.CLAUDE/settings.json', content: '{}' }));
  });
  test('läsning av .claude/ nekas inte av policyn', async () => {
    assert.equal(await deny('Read', { file_path: '.claude/settings.json' }), null);
  });
});

describe('git utan sandlåda', () => {
  test('Bash med git nekas bara utan sandlåda', async () => {
    assert.ok(await deny('Bash', { command: 'git status' }, { sandbox: false }));
    assert.ok(await deny('Bash', { command: 'cd sub && /usr/bin/git log' }, { sandbox: false }));
    assert.ok(await deny('Bash', { command: 'GIT_DIR=x git-upload-pack .' }, { sandbox: false }));
    assert.ok(await deny('Bash', { command: 'GIT status' }, { sandbox: false }));
    assert.equal(await deny('Bash', { command: 'git status' }, { sandbox: true }), null);
  });
  test('ord som bara innehåller git godtas', async () => {
    assert.equal(await deny('Bash', { command: 'node -e "console.log(/\\d/.test(digit))"' }, { sandbox: false }), null);
    assert.equal(await deny('Bash', { command: 'curl https://github.com/x' }, { sandbox: false }), null);
    assert.equal(await deny('Bash', { command: 'echo legit' }, { sandbox: false }), null);
  });
});

describe('Bash-kommandot och blockedPath', () => {
  // Claude Code sätter blockedPath när ett Bash-kommando når en sökväg utanför tillåtna mappar (uppmätt i
  // spike M-perm-confine/M-perm-default). Det är signalen policyn litar på för Bash-sökvägar.
  test('en sökväg i blockedPath utanför appen nekas, även med sandlåda', async () => {
    assert.ok(await deny('Bash', { command: 'cat ~/.ssh/known_hosts' }, { blockedPath: `${os.homedir()}/.ssh/known_hosts` }));
  });
  test('ett kommando som textuellt klättrar ut ur appen nekas', async () => {
    assert.ok(await deny('Bash', { command: 'cat ../../../etc/passwd' }));
  });
  test('vanliga kommandon med .. som inte lämnar appen godtas (ingen falsklarm)', async () => {
    assert.equal(await deny('Bash', { command: 'cd ../' + path.basename(app) + ' && npm test' }), null);
    assert.equal(await deny('Bash', { command: 'node build.js && cd dist' }), null);
    assert.equal(await deny('Bash', { command: 'npm run build' }), null);
    assert.equal(await deny('Bash', { command: 'curl -s https://esm.sh/x@1/../y' }), null);
  });
});

describe('hemligheterna i data/secrets.json (SEC-2)', () => {
  before(() => {
    fs.mkdirSync(path.join(app, 'data'), { recursive: true });
    fs.writeFileSync(path.join(app, 'data', 'secrets.json'), '{"api_key":"MARKOR-HEMLIG"}');
    fs.writeFileSync(path.join(app, 'data', 'store.json'), '{}');
  });

  test('kalibrering: samma anrop mot en annan fil i data/ godtas, så nekandet beror på filen', async () => {
    assert.equal(await deny('Read', { file_path: 'data/store.json' }), null);
    assert.equal(await deny('Bash', { command: 'cat data/store.json' }, { sandbox: false }), null);
    assert.equal(naivePolicy(app, { file_path: 'data/secrets.json' }), null, 'den gamla policyn släppte igenom filen');
  });

  test('Read, Edit och Write på filen nekas, relativt, absolut och i annat skiftläge', async () => {
    for (const file_path of ['data/secrets.json', path.join(app, 'data', 'secrets.json'), 'Data/Secrets.JSON', 'sub/../data/secrets.json']) {
      for (const tool of ['Read', 'Edit', 'Write']) {
        const m = await deny(tool, { file_path });
        assert.match(m ?? '', /secrets\.json holds the user's secrets/, `${tool} ${file_path}`);
      }
    }
  });

  test('Bash som nämner filen nekas, med och utan sandlåda', async () => {
    for (const sandbox of [true, false]) {
      assert.ok(await deny('Bash', { command: 'cat data/secrets.json' }, { sandbox }));
      assert.ok(await deny('Bash', { command: 'grep -r . data/SECRETS.json' }, { sandbox }));
    }
  });
});
