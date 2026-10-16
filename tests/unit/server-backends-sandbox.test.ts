// tests/unit/server-backends-sandbox.test.ts — SBPL-profilen (server/backends/sandbox.ts).
// Rena tester av generatorn, plus två körningar under riktiga sandbox-exec som visar att
// avvikelserna från kontraktets profil behövs (planterade fel som först ska fällas).
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { buildProfile, closedRoots, isWithin, nodeReadDir, sbplString } from '../../server/backends/sandbox.ts';
import type { ProfileInput } from '../../server/backends/sandbox.ts';
import { ROOT, SCRATCH } from './server-backends-harness.test.ts';

const BASE: ProfileInput = {
  home: '/Users/test',
  workbenchHome: '/Users/test/Projekt/workbench',
  appDir: '/Users/test/Projekt/workbench/apps/aabc123',
  tmpDir: '/private/var/folders/xy/T',
  guardFile: '/Users/test/Projekt/workbench/server/backends/guard.mjs',
  nodeDir: '/opt/homebrew/Cellar/node/25.9.0_1',
  deniedPorts: [8220, 8229, 18301],
};

const lines = (p: string): string[] => p.split('\n').filter((l) => l && !l.startsWith(';'));
const indexOf = (ls: string[], start: string): number => {
  const i = ls.findIndex((l) => l.startsWith(start));
  assert.ok(i >= 0, `saknar regeln ${start}`);
  return i;
};

describe('buildProfile', { timeout: 60_000 }, () => {
  test('följer kontraktets ordning: senaste matchande regel vinner', () => {
    const ls = lines(buildProfile(BASE));
    assert.equal(ls[0], '(version 1)');
    assert.equal(ls[1], '(allow default)');
    const order = [
      indexOf(ls, '(deny file-write* (subpath "/Users/test"))'),
      indexOf(ls, '(allow file-write* (subpath "/private/var/folders/xy/T"))'),
      indexOf(ls, '(allow file-write* (subpath "/Users/test/Projekt/workbench/apps/aabc123/data"))'),
      indexOf(ls, '(deny file-read* (subpath "/Users/test"))'),
      indexOf(ls, '(allow file-read* (subpath "/Users/test/Projekt/workbench/apps/aabc123")'),
      indexOf(ls, '(allow file-read-metadata'),
      indexOf(ls, '(deny network-outbound (remote ip'),
      indexOf(ls, '(deny network-outbound (remote unix-socket))'),
      indexOf(ls, '(allow network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))'),
      indexOf(ls, '(deny mach-lookup (global-name "com.apple.coreservices.launchservicesd"))'),
      indexOf(ls, '(deny mach-lookup (global-name-regex #"^com\\.apple\\.lsd\\.") (global-name "com.apple.coreservices.quarantine-resolver"))'),
      indexOf(ls, '(deny appleevent-send)'),
    ];
    assert.deepEqual(order, [...order].sort((a, b) => a - b));
    // appens egen kod är inte skrivbar: bara data/ öppnas för skrivning
    assert.ok(!ls.some((l) => l.startsWith('(allow file-write*') && l.includes('"/Users/test/Projekt/workbench/apps/aabc123")')));
    // mDNSResponder är den enda unix-socket som släpps igenom (DNS); inget öppnas efteråt.
    assert.equal(ls.filter((l) => l.startsWith('(allow network-outbound (remote unix-socket')).length, 1);
    assert.ok(!ls.some((l) => l.includes('cc-socks')), 'cc-socks-regeln är borttagen: alla unix-socketar nekas');
  });

  test('guard.mjs öppnas som enskild fil, och bara förfäderna får metadata', () => {
    const ls = lines(buildProfile(BASE));
    const read = ls[indexOf(ls, '(allow file-read* ')];
    assert.match(read, /\(literal "\/Users\/test\/Projekt\/workbench\/server\/backends\/guard\.mjs"\)/);
    const meta = ls[indexOf(ls, '(allow file-read-metadata')];
    const listed = [...meta.matchAll(/\(literal "([^"]+)"\)/g)].map((m) => m[1]).sort();
    assert.deepEqual(listed, [
      '/Users/test',
      '/Users/test/Projekt',
      '/Users/test/Projekt/workbench',
      '/Users/test/Projekt/workbench/apps',
      '/Users/test/Projekt/workbench/server',
      '/Users/test/Projekt/workbench/server/backends',
    ]);
    assert.ok(!meta.includes('(subpath'), 'metadata får aldrig öppnas för ett helt träd');
  });

  test('Node utanför hemkatalogen nämns inte; under hemkatalogen blir prefixet läsbart', () => {
    assert.ok(!buildProfile(BASE).includes('Cellar'));
    const nvm = '/Users/test/.nvm/versions/node/v25.9.0';
    const ls = lines(buildProfile({ ...BASE, nodeDir: nvm }));
    assert.match(ls[indexOf(ls, '(allow file-read* ')], /\(subpath "\/Users\/test\/\.nvm\/versions\/node\/v25\.9\.0"\)/);
    const meta = ls[indexOf(ls, '(allow file-read-metadata')];
    for (const d of ['/Users/test/.nvm', '/Users/test/.nvm/versions', '/Users/test/.nvm/versions/node']) {
      assert.ok(meta.includes(`(literal "${d}")`), d);
    }
    assert.throws(() => buildProfile({ ...BASE, nodeDir: '/Users' }), /stängt område/);
  });

  test('portarna nekas på alla adresser (inte localhost-formen), utan dubbletter', () => {
    const p = buildProfile({ ...BASE, deniedPorts: [8220, 8229, 8220] });
    const rule = lines(p).find((l) => l.startsWith('(deny network-outbound (remote ip'));
    assert.equal(rule, '(deny network-outbound (remote ip "*:8220") (remote ip "*:8229"))');
    assert.ok(!p.includes('(remote ip "localhost:'));
    for (const bad of [0, 70000, 1.5, Number.NaN]) assert.throws(() => buildProfile({ ...BASE, deniedPorts: [bad] }), /ogiltig port/);
  });

  test('workbenchens hem utanför hemkatalogen stängs, och stängs igen om det ligger under TMPDIR', () => {
    const wb = '/private/var/folders/xy/T/wb-e2e';
    const ls = lines(buildProfile({ ...BASE, workbenchHome: wb, appDir: wb + '/apps/aabc123' }));
    const denyWrite = indexOf(ls, '(deny file-write* (subpath "/Users/test") (subpath "/private/var/folders/xy/T/wb-e2e"))');
    const allowTmp = indexOf(ls, '(allow file-write* (subpath "/private/var/folders/xy/T"))');
    const redeny = indexOf(ls, '(deny file-write* (subpath "/private/var/folders/xy/T/wb-e2e"))');
    const allowData = indexOf(ls, '(allow file-write* (subpath "/private/var/folders/xy/T/wb-e2e/apps/aabc123/data"))');
    assert.ok(denyWrite < allowTmp && allowTmp < redeny && redeny < allowData);
    indexOf(ls, '(deny file-read* (subpath "/Users/test") (subpath "/private/var/folders/xy/T/wb-e2e"))');
    assert.deepEqual(closedRoots('/Users/test', '/Users/test/x'), ['/Users/test']);
    assert.deepEqual(closedRoots('/Users/test', '/tmp/x'), ['/Users/test', '/tmp/x']);
  });

  test('strängar citeras; kontrolltecken och relativa sökvägar vägras', () => {
    assert.equal(sbplString('/a "b" \\c å'), '"/a \\"b\\" \\\\c å"');
    assert.throws(() => sbplString('/a\nb'), /kontrolltecken/);
    assert.throws(() => sbplString(''), /tom/);
    assert.throws(() => buildProfile({ ...BASE, appDir: BASE.appDir + '\n(allow default)' }), /kontrolltecken/);
    assert.throws(() => buildProfile({ ...BASE, appDir: 'apps/aabc123' }), /absolut/);
    assert.throws(() => buildProfile({ ...BASE, appDir: BASE.appDir + '/../x' }), /normaliserad/);
    assert.ok(isWithin('/a/b', '/a') && isWithin('/a', '/a') && !isWithin('/ab', '/a'));
  });
});

describe('nodeReadDir', { timeout: 60_000 }, () => {
  const dir = path.join(SCRATCH, 'sandbox-nodedir');
  before(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    for (const p of ['home/bin/node', 'home/.nvm/versions/node/v25/bin/node']) {
      fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
      fs.writeFileSync(path.join(dir, p), '');
    }
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('prefixet ovanför bin/, men aldrig hela hemkatalogen', () => {
    const home = fs.realpathSync(path.join(dir, 'home'));
    assert.equal(nodeReadDir(path.join(home, '.nvm/versions/node/v25/bin/node'), [home]), path.join(home, '.nvm/versions/node/v25'));
    assert.equal(nodeReadDir(path.join(home, 'bin/node'), [home]), path.join(home, 'bin'));
  });
});

/* ------------------- riktiga sandbox-exec: avvikelserna behövs ------------------- */

function run(cmd: string, args: string[], cwd: string): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout: 20_000 }, (err, stdout, stderr) => {
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: String(stdout) + String(stderr) });
    });
  });
}

describe('profilen under sandbox-exec', { skip: !fs.existsSync('/usr/bin/sandbox-exec'), timeout: 60_000 }, () => {
  const dir = path.join(SCRATCH, 'sandbox-real');
  let app = '';
  let input: ProfileInput;
  const guard = path.join(ROOT, 'server', 'backends', 'guard.mjs');
  const write = (name: string, profile: string): string => {
    const f = path.join(dir, name);
    fs.writeFileSync(f, profile);
    return f;
  };
  const sandboxed = (profile: string, node: string): Promise<{ code: number | null; out: string }> =>
    run('/usr/bin/sandbox-exec', ['-f', profile, node, `--import=${pathToFileURL(guard).href}`, '--', 'main.mjs'], app);

  before(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    app = path.join(dir, 'apps', 'asbreal1');
    fs.mkdirSync(path.join(app, 'data'), { recursive: true });
    fs.writeFileSync(path.join(app, 'main.mjs'), 'console.log("NODE KÖR");\n');
    const home = fs.realpathSync.native(os.userInfo().homedir);
    input = {
      home,
      workbenchHome: fs.realpathSync.native(dir),
      appDir: fs.realpathSync.native(app),
      tmpDir: fs.realpathSync.native(os.tmpdir()),
      guardFile: fs.realpathSync.native(guard),
      nodeDir: nodeReadDir(process.execPath, closedRoots(home, fs.realpathSync.native(dir))),
      deniedPorts: [8243],
    };
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('Node startar under profilen, men inte utan förfädernas metadata (kontraktets profil ordagrant)', async () => {
    const ok = await sandboxed(write('ok.sb', buildProfile(input)), process.execPath);
    assert.equal(ok.code, 0, ok.out);
    assert.match(ok.out, /NODE KÖR/);
    // Planterat fel: utan metadata-raden, som i kontraktets profil, kommer Node inte ens igång.
    const bare = buildProfile(input).split('\n').filter((l) => !l.startsWith('(allow file-read-metadata')).join('\n');
    const fail = await sandboxed(write('bare.sb', bare), process.execPath);
    assert.notEqual(fail.code, 0);
    assert.match(fail.out, /EPERM|ERR_MODULE_NOT_FOUND/);
    assert.doesNotMatch(fail.out, /NODE KÖR/);
  });

  test('en Node under hemkatalogen kräver att prefixet är läsbart', async () => {
    // En APFS-klon (cp -c) av Node-installationen under $HOME, som med nvm eller volta.
    const src = path.dirname(path.dirname(fs.realpathSync.native(process.execPath)));
    const prefix = path.join(dir, 'nodeprefix');
    fs.mkdirSync(prefix, { recursive: true });
    try {
      execFileSync('/bin/cp', ['-c', '-R', path.join(src, 'bin'), path.join(src, 'lib'), prefix + '/']);
    } catch {
      execFileSync('/bin/cp', ['-R', path.join(src, 'bin'), path.join(src, 'lib'), prefix + '/']);
    }
    const node = path.join(prefix, 'bin', 'node');
    const nodeDir = nodeReadDir(node, closedRoots(input.home, input.workbenchHome));
    assert.equal(nodeDir, fs.realpathSync.native(prefix));
    const ok = await sandboxed(write('home-node.sb', buildProfile({ ...input, nodeDir })), node);
    assert.equal(ok.code, 0, ok.out);
    assert.match(ok.out, /NODE KÖR/);
    // Planterat fel: samma Node utan prefixet i profilen.
    const fail = await sandboxed(write('home-node-bare.sb', buildProfile({ ...input, nodeDir: null })), node);
    assert.notEqual(fail.code, 0);
    assert.match(fail.out, /blocked by sandbox|Operation not permitted|EPERM/);
  });

  // §9: en backend får inte kunna starta ett program via LaunchServices (open). Kalibrerat: utanför sandlådan
  // startar `open -g -j -a Calculator` appen dolt; den avslutas direkt. Inne i profilen ska samma open misslyckas.
  const calcRunning = (): boolean => {
    try {
      return execFileSync('/usr/bin/pgrep', ['-x', 'Calculator'], { encoding: 'utf8' }).trim() !== '';
    } catch {
      return false; // pgrep avslutar 1 när inget matchar
    }
  };
  const quitCalc = (): void => {
    for (let i = 0; i < 10 && calcRunning(); i++) {
      try {
        execFileSync('/usr/bin/pkill', ['-x', 'Calculator']);
      } catch {
        /* redan borta */
      }
      execFileSync('/bin/sleep', ['0.3']);
    }
  };
  const openCalc = (profile: string | null): Promise<{ code: number | null; out: string }> =>
    profile === null
      ? run('/usr/bin/open', ['-g', '-j', '-a', 'Calculator'], app)
      : run('/usr/bin/sandbox-exec', ['-f', profile, '/usr/bin/open', '-g', '-j', '-a', 'Calculator'], app);

  test('open via LaunchServices startar inget program i sandlådan (kalibrerat mot en planterad läcka)', { skip: fs.existsSync('/System/Applications/Calculator.app') ? false : 'Calculator saknas' }, async () => {
    assert.equal(calcRunning(), false, 'Calculator kör redan: avbryter för att inte störa');
    try {
      // Kalibrering (planterad läcka): utanför sandlådan startar open appen dolt.
      const outside = await openCalc(null);
      assert.equal(outside.code, 0, outside.out);
      let launched = false;
      for (let i = 0; i < 12 && !(launched = calcRunning()); i++) execFileSync('/bin/sleep', ['0.3']);
      assert.equal(launched, true, 'kalibreringen fälldes inte: open startade inte Calculator');
    } finally {
      quitCalc();
    }
    assert.equal(calcRunning(), false, 'Calculator skulle vara avslutad efter kalibreringen');
    try {
      // Inne i profilen misslyckas samma open, och inget program startar.
      const inside = await openCalc(write('open-calc.sb', buildProfile(input)));
      assert.notEqual(inside.code, 0, `open lyckades i sandlådan: ${inside.out}`);
      let launched = false;
      for (let i = 0; i < 8 && !(launched = calcRunning()); i++) execFileSync('/bin/sleep', ['0.3']);
      assert.equal(launched, false, 'Calculator startade trots sandlådan');
    } finally {
      quitCalc();
    }
  });
});
