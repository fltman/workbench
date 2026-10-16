// tests/unit/server-store-manifest.test.ts — manifestnormalisering (CONTRACT §6, §4.6, §15).
// Fallen "sidan pekar ut ur appen" kalibreras: en rent lexikal kontroll (den planterade läckan) släpper igenom
// dem, och målet ligger verkligen utanför. Först därefter visas att normaliseringen tar bort dem.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_FACES } from '../../shared/protocol.ts';
import { checkAppPath, normalizeManifest, readManifest } from '../../server/store/registry.ts';

const roots: string[] = [];
/** En app i <tmp>/apps/a000001 med en hemlighet bredvid, i <tmp>/outside. */
function setup(): { app: string; outside: string } {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'wb-manifest-')));
  roots.push(root);
  const app = path.join(root, 'apps', 'a000001');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(app, { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.html'), 'HEMLIGT');
  return { app, outside };
}
after(() => {
  for (const d of roots) fs.rmSync(d, { recursive: true, force: true });
});

function write(app: string, rel: string, text = 'x'): void {
  fs.mkdirSync(path.dirname(path.join(app, rel)), { recursive: true });
  fs.writeFileSync(path.join(app, rel), text);
}

function manifestOf(app: string, raw: unknown) {
  return normalizeManifest(raw, app);
}

/** Den planterade läckan: en naiv, rent lexikal kontroll av en relativ sökväg. */
function lexicalOnly(p: string): boolean {
  const norm = path.posix.normalize(p);
  return !norm.startsWith('../') && norm !== '..' && !path.posix.isAbsolute(norm);
}

/** Sant om sökvägen (efter alla länkar) leder ut ur appen. */
function reallyOutside(app: string, rel: string): boolean {
  const real = fs.realpathSync.native(path.join(app, rel));
  return path.relative(app, real).startsWith('..');
}

test('saknat manifest: standardvärden, built följer index.html', () => {
  const { app } = setup();
  assert.deepEqual(readManifest(app), { raw: undefined });
  const empty = manifestOf(app, undefined);
  assert.deepEqual(empty.manifest, { name: '', faces: DEFAULT_FACES, permissions: [] });
  assert.equal(empty.built, false);
  write(app, 'index.html', '<p>Hej</p>');
  assert.equal(manifestOf(app, undefined).built, true);
  assert.equal(normalizeManifest({ faces: [{ id: 'main', page: 'index.html' }] }, null).built, false, 'saknad appmapp: aldrig byggd');
});

test('ogiltig JSON: problemet rapporteras och standardvärden gäller', () => {
  const { app } = setup();
  write(app, 'app.json', '{ "name": "Mejl", ');
  const r = readManifest(app);
  assert.equal(r.raw, undefined);
  assert.match(r.problem ?? '', /inte giltig JSON/);
  assert.deepEqual(manifestOf(app, r.raw).manifest.faces, DEFAULT_FACES);
  write(app, 'app.json', '\u{feff}{ "name": "Mejl" }');
  assert.deepEqual(readManifest(app), { raw: { name: 'Mejl' } }, 'BOM i början tolereras');
  write(app, 'app.json', '[1, 2]');
  assert.deepEqual(manifestOf(app, readManifest(app).raw).manifest.faces, DEFAULT_FACES, 'en array är inget manifest');
  write(app, 'app.json', 'null');
  assert.equal(manifestOf(app, readManifest(app).raw).manifest.name, '');
});

test('app.json som pekar ut ur appen läses inte', () => {
  const { app, outside } = setup();
  fs.writeFileSync(path.join(outside, 'm.json'), JSON.stringify({ name: 'Läckt namn' }));
  fs.symlinkSync(path.join(outside, 'm.json'), path.join(app, 'app.json'));
  assert.ok(reallyOutside(app, 'app.json'), 'kalibrering: länken leder ut');
  const r = readManifest(app);
  assert.equal(r.raw, undefined);
  assert.match(r.problem ?? '', /pekar ut/);
});

test('sidornas id: [a-z0-9-]{1,32}, unika; felaktiga tas bort', () => {
  const { app } = setup();
  for (const f of ['ok-1.html', 'b.html', 'c.html']) write(app, f);
  const { manifest } = manifestOf(app, {
    faces: [
      { id: 'Main', page: 'b.html' },
      { id: '', page: 'b.html' },
      { id: 'a'.repeat(33), page: 'b.html' },
      { id: 'med_understreck', page: 'b.html' },
      { id: 'mellan slag', page: 'b.html' },
      { id: 5, page: 'b.html' },
      null,
      'main',
      { id: 'ok-1', page: 'ok-1.html', label: 'Inställningar' },
      { id: 'ok-1', page: 'c.html' },
      { id: 'a'.repeat(32), page: 'b.html' },
    ],
  });
  assert.deepEqual(manifest.faces, [
    { id: 'ok-1', page: 'ok-1.html', label: 'Inställningar' },
    { id: 'a'.repeat(32), page: 'b.html' },
  ]);
});

test('högst 6 sidor; tom eller helt ogiltig lista ger DEFAULT_FACES', () => {
  const { app } = setup();
  const faces = Array.from({ length: 8 }, (_, i) => ({ id: `s${i}`, page: `s${i}.html` }));
  assert.deepEqual(manifestOf(app, { faces }).manifest.faces.map((f) => f.id), ['s0', 's1', 's2', 's3', 's4', 's5']);
  const withBad = [{ id: 'BAD', page: 'x.html' }, ...faces];
  assert.equal(manifestOf(app, { faces: withBad }).manifest.faces.length, 6, 'ogiltiga räknas inte');
  assert.deepEqual(manifestOf(app, { faces: [] }).manifest.faces, DEFAULT_FACES);
  assert.deepEqual(manifestOf(app, { faces: [{ id: 'X', page: '../x.html' }] }).manifest.faces, DEFAULT_FACES);
  assert.deepEqual(manifestOf(app, { faces: 'index.html' }).manifest.faces, DEFAULT_FACES);
});

test('sida utanför mappen via ../ eller absolut sökväg tas bort', () => {
  const { app } = setup();
  for (const page of ['../outside/secret.html', 'sub/../../outside/secret.html', '..', '/etc/passwd', `${app}/index.html`]) {
    assert.equal(checkAppPath(app, page), null, page);
    assert.deepEqual(manifestOf(app, { faces: [{ id: 'main', page }] }).manifest.faces, DEFAULT_FACES, page);
  }
});

test('sida utanför mappen via symbolisk länk tas bort (kalibrerat mot en lexikal kontroll)', () => {
  const { app, outside } = setup();
  fs.symlinkSync(path.join(outside, 'secret.html'), path.join(app, 'link.html'));
  fs.symlinkSync(outside, path.join(app, 'pages'));
  fs.symlinkSync(path.join(outside, 'finns-inte.html'), path.join(app, 'dinglar.html'));
  write(app, 'index.html');
  fs.symlinkSync(path.join(app, 'index.html'), path.join(app, 'alias.html'));

  for (const page of ['link.html', 'pages/secret.html']) {
    assert.ok(lexicalOnly(page), `kalibrering: en lexikal kontroll släpper igenom ${page}`);
    assert.ok(reallyOutside(app, page), `kalibrering: ${page} leder verkligen ut`);
    assert.equal(checkAppPath(app, page), null, page);
  }
  assert.ok(lexicalOnly('pages/ny.html'));
  assert.equal(checkAppPath(app, 'pages/ny.html'), null, 'en sida som inte finns än, i en länkad katalog utanför');
  assert.ok(lexicalOnly('dinglar.html'));
  assert.equal(checkAppPath(app, 'dinglar.html'), null, 'en dinglande länk kan peka vart som helst');
  assert.deepEqual(checkAppPath(app, 'alias.html'), { rel: 'alias.html', isFile: true }, 'en länk inom appen är tillåten');

  const { manifest, built } = manifestOf(app, {
    faces: [{ id: 'main', page: 'link.html' }, { id: 'b', page: 'pages/secret.html' }, { id: 'c', page: 'alias.html' }],
  });
  assert.deepEqual(manifest.faces, [{ id: 'c', page: 'alias.html' }]);
  assert.equal(built, true);
});

test('dolda segment, data/ och node_modules/ (skiftlägesokänsligt), även via länk, tas bort', () => {
  const { app } = setup();
  write(app, 'data/x.html');
  write(app, 'node_modules/p/index.html');
  write(app, '.hidden/x.html');
  write(app, 'sub/.dold.html');
  write(app, 'sub/ok.html');
  fs.symlinkSync(path.join(app, 'data', 'x.html'), path.join(app, 'publik.html'));
  const bad = ['data/x.html', 'Data/x.html', 'DATA/x.html', 'node_modules/p/index.html', 'Node_Modules/p/index.html',
    '.hidden/x.html', 'sub/.dold.html', '.', './.hidden/x.html', 'publik.html'];
  for (const page of bad) assert.equal(checkAppPath(app, page), null, page);
  assert.ok(lexicalOnly('publik.html'), 'kalibrering: publik.html ser oskyldig ut');
  assert.deepEqual(checkAppPath(app, 'sub/ok.html'), { rel: 'sub/ok.html', isFile: true });
  assert.deepEqual(checkAppPath(app, 'sub/data/x.html'), { rel: 'sub/data/x.html', isFile: false }, 'bara första segmentet');
});

test('Data/ och Node_Modules/ med versaler på disken nekas också (APFS är skiftlägesokänsligt)', () => {
  const { app } = setup();
  write(app, 'Data/secrets.json', '{"imap_password":"hemligt"}');
  write(app, 'Node_Modules/p/index.html');
  for (const page of ['Data/secrets.json', 'data/secrets.json', 'DATA/secrets.json', 'Node_Modules/p/index.html', 'node_modules/p/index.html']) {
    assert.ok(lexicalOnly(page), `kalibrering: ${page} är lexikalt inne i appen`);
    assert.equal(checkAppPath(app, page), null, page);
  }
  assert.equal(path.basename(path.dirname(fs.realpathSync.native(path.join(app, 'data', 'secrets.json')))), 'Data',
    'kalibrering: realpath ger diskens skiftläge, Data, så en skiftlägeskänslig jämförelse med "data" skulle missa');
});

test('tecken som har betydelse i en URL, styrtecken och inledande - avvisas; mellanslag och å/ä/ö går bra', () => {
  const { app } = setup();
  for (const page of ['a?b.html', 'a#b.html', 'a%20b.html', 'a\\b.html', 'a\nb.html', 'a\x00b.html', '-index.html',
    '--inspect.html', 'sida/', '', 'x'.repeat(513)]) {
    assert.equal(checkAppPath(app, page), null, JSON.stringify(page));
  }
  write(app, 'min sida.html');
  write(app, 'inställningar.html');
  assert.deepEqual(checkAppPath(app, 'min sida.html'), { rel: 'min sida.html', isFile: true });
  assert.deepEqual(checkAppPath(app, './inställningar.html'), { rel: 'inställningar.html', isFile: true });
  assert.deepEqual(checkAppPath(app, 'sub/../ny.html'), { rel: 'ny.html', isFile: false }, 'normaliserad, får finnas senare');
  for (const notString of [5, null, undefined, {}, ['index.html']]) assert.equal(checkAppPath(app, notString), null);
});

test('backend.entry: inne i appen och börjar inte med -', () => {
  const { app, outside } = setup();
  write(app, 'server.mjs');
  fs.writeFileSync(path.join(outside, 'evil.mjs'), '');
  fs.symlinkSync(path.join(outside, 'evil.mjs'), path.join(app, 'start.mjs'));
  const entryOf = (backend: unknown) => manifestOf(app, { backend }).manifest.backend;
  assert.deepEqual(entryOf({ entry: 'server.mjs' }), { entry: 'server.mjs' });
  assert.deepEqual(entryOf({ entry: './server.mjs' }), { entry: 'server.mjs' });
  assert.deepEqual(entryOf({ entry: 'api/server.mjs' }), { entry: 'api/server.mjs' }, 'får finnas senare');
  for (const entry of ['-x', '--inspect=0.0.0.0:9229', '-e', '../server.mjs', '/tmp/x.mjs', 'data/server.mjs',
    'node_modules/.bin/x', '.server.mjs', 'start.mjs', 5, '']) {
    assert.equal(entryOf({ entry }), undefined, JSON.stringify(entry));
  }
  assert.ok(lexicalOnly('start.mjs') && reallyOutside(app, 'start.mjs'), 'kalibrering: start.mjs leder ut via länk');
  assert.equal(entryOf('server.mjs'), undefined, 'backend måste vara ett objekt');
  assert.equal(manifestOf(app, {}).manifest.backend, undefined);
});

test('permissions: bara de fyra kända, utan dubbletter, i ordning', () => {
  const { app } = setup();
  const { manifest } = manifestOf(app, {
    permissions: ['microphone', 'camera', 'camera', 'root', 'clipboard-read', 'clipboard-write', 'geolocation', 5, 'Microphone'],
  });
  assert.deepEqual(manifest.permissions, ['microphone', 'camera', 'clipboard-read', 'geolocation']);
  assert.deepEqual(manifestOf(app, { permissions: 'microphone' }).manifest.permissions, []);
});

test('namn och etiketter: bara strängar, utan styrtecken, kortade', () => {
  const { app } = setup();
  write(app, 'b.html');
  assert.equal(manifestOf(app, { name: 42 }).manifest.name, '');
  assert.equal(manifestOf(app, { name: '  Mejl\n\tklient \u{202e}x ' }).manifest.name, 'Mejl klient x');
  assert.equal(Array.from(manifestOf(app, { name: 'ö'.repeat(100) }).manifest.name).length, 64);
  const { manifest } = manifestOf(app, { faces: [{ id: 'b', page: 'b.html', label: 7 }, { id: 'c', page: 'b.html', label: '  ' }] });
  assert.deepEqual(manifest.faces, [{ id: 'b', page: 'b.html' }, { id: 'c', page: 'b.html' }]);
});

test('built = filen för den första giltiga sidan finns (en vanlig fil)', () => {
  const { app } = setup();
  write(app, 'index.html');
  write(app, 'two.html');
  fs.mkdirSync(path.join(app, 'katalog.html'));
  assert.equal(manifestOf(app, { faces: [{ id: 'a', page: 'saknas.html' }, { id: 'b', page: 'two.html' }] }).built, false);
  assert.equal(manifestOf(app, { faces: [{ id: 'a', page: '../x' }, { id: 'b', page: 'two.html' }] }).built, true);
  assert.equal(manifestOf(app, { faces: [{ id: 'a', page: 'katalog.html' }] }).built, false, 'en katalog är ingen sida');
});

test('opens (§10.9): bara url, date och text, i fast ordning, utan dubbletter; saknas när inget gäller', () => {
  const { app } = setup();
  assert.deepEqual(normalizeManifest({ opens: ['text', 'url', 'url', 'fil', 7, null] }, app).manifest.opens, ['url', 'text']);
  assert.equal('opens' in normalizeManifest({ opens: ['fil'] }, app).manifest, false);
  assert.equal('opens' in normalizeManifest({ opens: 'url' }, app).manifest, false, 'en sträng är ingen lista');
  assert.equal('opens' in normalizeManifest({}, app).manifest, false);
});
