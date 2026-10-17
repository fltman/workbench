// <workbench>-blocket (CONTRACT §8.4), CLAUDE.md-läsningen och commit-raden.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { backendLine, commitLine, composeMessage, loadAppRules, NOTES_MAX_BYTES, readNotes, workbenchBlock } from '../../server/claude/prompt.ts';
import { askToOpen } from '../../web/src/hud/field.ts';
import { rmrf, tmpHome } from './server-claude-kit.ts';
import type { WindowState } from '../../shared/protocol.ts';

const WIN: WindowState = { id: 'w-aapp001', appId: 'aapp001', x: 0, y: 0, w: 640, h: 480, scale: 1, face: 0, z: 1 };
const FACES = [{ id: 'main', page: 'index.html' }];

describe('<workbench>-blocket', () => {
  test('grundformen ur kontraktet', () => {
    const b = workbenchBlock({ win: WIN, faces: FACES, backend: 'none', backendPort: null, undone: false, notes: null });
    assert.equal(b, '<workbench>\nWindow: 640×480 CSS px (scale 1). Front face: main (1 of 1).\nBack end: none.\nWrite every text block in Swedish, including notes between tool calls: the user reads them all in the HUD.\n</workbench>');
  });

  test('språkraden finns i varje block, före anteckningarna', () => {
    for (const undone of [false, true]) {
      for (const notes of [null, '', '# Mejl\n']) {
        const b = workbenchBlock({ win: WIN, faces: FACES, backend: 'running', backendPort: 18300, undone, notes });
        const lines = b.split('\n');
        const i = lines.indexOf('Write every text block in Swedish, including notes between tool calls: the user reads them all in the HUD.');
        assert.ok(i > 0, 'språkraden saknas');
        const n = lines.indexOf('Your notes (CLAUDE.md):');
        if (notes !== null) assert.ok(i < n, 'språkraden ska stå före anteckningarna');
      }
    }
  });

  test('backendens tre lägen ur kontraktet', () => {
    assert.equal(backendLine('none', null), 'Back end: none.');
    assert.equal(backendLine('running', 18300), 'Back end: running on port 18300');
    assert.equal(backendLine('crashed', null), 'Back end: crashed – see get_app_logs');
    // Stoppad (aldrig startad, eller efter tomgångsstoppet, §9): nästa förfrågan startar den, utan reload_app.
    assert.equal(backendLine('stopped', null), 'Back end: stopped (the next request or call_backend starts it).');
    assert.match(backendLine('starting', null), /^Back end: starting/);
  });

  test('reglerna om backendens tomgång och package.json före npm install (§8.11)', () => {
    const rules = loadAppRules(path.resolve(import.meta.dirname, '..', '..'));
    assert.match(rules, /stops a back end that has had no requests for 10 minutes/);
    assert.match(rules, /Create `package\.json` before the first `npm install`/);
  });

  test('flera sidor, skala och främre sidan', () => {
    const faces = [{ id: 'main', page: 'index.html' }, { id: 'baksida', page: 'b.html' }, { id: 'sida3', page: 'c.html' }];
    const b = workbenchBlock({ win: { ...WIN, w: 800, h: 600, scale: 0.5, face: 1 }, faces, backend: 'running', backendPort: 18301, undone: false, notes: null });
    assert.match(b, /^Window: 800×600 CSS px \(scale 0\.5\)\. Front face: baksida \(2 of 3\)\.$/m);
    assert.match(b, /^Back end: running on port 18301$/m);
  });

  test('ångra-raden bara när det hänt', () => {
    const b = workbenchBlock({ win: WIN, faces: FACES, backend: 'none', backendPort: null, undone: true, notes: null });
    assert.match(b, /^Since your last turn: the user undid your last change; files are restored to the previous version\.$/m);
    assert.doesNotMatch(workbenchBlock({ win: WIN, faces: FACES, backend: 'none', backendPort: null, undone: false, notes: null }), /undid/);
  });

  test('ångra-raden räknar netto efter gör om och påstår aldrig mer än som hänt (§8.4)', () => {
    const line = (steps: number) =>
      workbenchBlock({ win: WIN, faces: FACES, backend: 'none', backendPort: null, undone: true, steps, notes: null }).split('\n').filter((l) => l.startsWith('Since your last turn:'));
    assert.deepEqual(line(1), ['Since your last turn: the user undid your last change; files are restored to the previous version.']);
    assert.deepEqual(line(2), ['Since your last turn: the user undid your last 2 changes; files are restored to an earlier version.']);
    assert.deepEqual(line(0), ['Since your last turn: the user undid and then redid your changes; the files are as you left them.']);
    assert.deepEqual(line(-1), ['Since your last turn: the user redid a change that had been undone earlier; the files now include it again.']);
    assert.deepEqual(line(-3), ['Since your last turn: the user redid 3 changes that had been undone earlier; the files now include them again.']);
  });

  test('anteckningarna sist i blocket', () => {
    const b = workbenchBlock({ win: WIN, faces: FACES, backend: 'none', backendPort: null, undone: false, notes: '# Mejl\n\nIMAP via imapflow.\n' });
    assert.ok(b.endsWith('Your notes (CLAUDE.md):\n# Mejl\n\nIMAP via imapflow.\n</workbench>'));
    const empty = workbenchBlock({ win: WIN, faces: FACES, backend: 'none', backendPort: null, undone: false, notes: '' });
    assert.match(empty, /Your notes \(CLAUDE\.md\):\n\(empty\)\n<\/workbench>$/);
  });

  test('utan fönster', () => {
    assert.match(workbenchBlock({ win: undefined, faces: FACES, backend: 'none', backendPort: null, undone: false, notes: null }), /^Window: none/m);
  });

  test('blocket först, sedan användarens text', () => {
    assert.equal(composeMessage('<workbench>\n</workbench>', 'Gör en mejlklient'), '<workbench>\n</workbench>\nGör en mejlklient');
  });

  test('app-rules.md laddas som systemprompt', () => {
    const rules = loadAppRules(path.resolve(import.meta.dirname, '..', '..'));
    assert.match(rules, /^# You are building one app inside Workbench/);
    // Allt Claude skriver syns i HUD:en, även noter mellan verktygsanropen: allt på svenska (två engelska noter mitt i
    // en tur nådde HUD:en när regeln sa "message to the user"). En kort lägesrad per fas i stället för förbudet mot
    // text mitt i turen, som aldrig hölls. Slutsvaret: två eller tre korta meningar, både bland reglerna för samtalet
    // och sist i checklistan, och de två uppmätta felen som dåliga exempel (granskningen 17 oktober).
    assert.match(rules, /the HUD shows every text block you write, including notes between tool calls\. Write all of them in Swedish/);
    assert.match(rules, /Between tool calls, write at most one short progress line per phase, about 8 words/);
    assert.match(rules, /End the turn with one short message, two or three short sentences at most\./);
    assert.match(rules, /Not: "Jag har inte kunnat testa/);
    assert.match(rules, /Not: "Vissa sidor kan sakna ikoner/);
    assert.match(rules, /Then write your closing message last: in Swedish, two or three short sentences at most\./);
    for (const gone of [/Write no text between tool calls/, /about 20 words/, /message to the user/, /at most two short sentences/]) assert.doesNotMatch(rules, gone);
    // Typsnittet är wb.js:s --wb-font (§11): stacken utskriven i reglerna stod utskriven i tio appfiler.
    assert.match(rules, /`font: 13px var\(--wb-font\)`/);
    assert.doesNotMatch(rules, /-apple-system/);
    assert.match(rules, /## Show the app early/);
  });

  // Fältets snabba väg (§10.9) utlöstes aldrig: ingen av sex appar angav opens, för reglerna sa bara att en app
  // "kan", och den enda riktiga körningen av önskemålet lade till en egen backend-route i stället (granskningen 17 oktober).
  test('reglerna: opens i första bygget, bara opens och wb.onOpen når fram, och try_app kan prova det', () => {
    const rules = loadAppRules(path.resolve(import.meta.dirname, '..', '..'));
    assert.match(rules, /In the first build, without being asked, declare each kind the app can take and show/);
    assert.match(rules, /Only `opens` plus `wb\.onOpen` works\. A route of your own/);
    assert.match(rules, /\{"open":\{"kind":"url","url":"https:\/\/example\.com\/"\}\}/);
    assert.doesNotMatch(rules, /If the app can show such things/);
  });

  // try_app och call_backend läser om app.json (registry.refresh, §8.7), och ensure() startar om en backend vars
  // ingångsfil ändrats (§9), så reload_app behövs inte för att prova något.
  test('reglerna: try_app och call_backend ser den senaste app.json och server.mjs, och reload_app är till för användaren (§8.11)', () => {
    const rules = loadAppRules(path.resolve(import.meta.dirname, '..', '..'));
    assert.match(rules, /`try_app` and `call_backend` always see the latest `app\.json` and `server\.mjs`/);
    assert.match(rules, /so test without `reload_app`; it is for showing the user/);
  });

  test('fältets önskemål till en app namnger samma mekanism som reglerna', () => {
    for (const item of [{ kind: 'url', url: 'https://dn.se/' }, { kind: 'date', date: '2026-10-20' }, { kind: 'text', text: 'Köp mjölk' }] as const) {
      const ask = askToOpen(item);
      assert.match(ask, new RegExp(`lägg till ${item.kind} i opens i app\\.json`), ask);
      assert.match(ask, /wb\.onOpen/, ask);
      assert.match(ask, /En egen backend-route räcker inte\./, ask);
    }
    assert.match(askToOpen({ kind: 'url', url: 'https://dn.se/' }), /^Öppna https:\/\/dn\.se\/ här/);
  });
});

describe('readNotes', () => {
  let root: string;
  let app: string;
  before(() => {
    root = tmpHome('wb-notes');
    app = path.join(root, 'app');
    fs.mkdirSync(app);
  });
  after(() => rmrf(root));

  test('saknad fil blir tom', () => {
    assert.equal(readNotes(app), '');
  });

  test('vanlig fil läses', () => {
    fs.writeFileSync(path.join(app, 'CLAUDE.md'), '# app\n\nAnteckningar på svenska: åäö.\n');
    assert.equal(readNotes(app), '# app\n\nAnteckningar på svenska: åäö.\n');
  });

  test('högst 8 kB, och ett flerbytestecken delas aldrig', () => {
    // 8191 ASCII-byte + "ö" (2 byte) korsar gränsen mitt i tecknet.
    fs.writeFileSync(path.join(app, 'CLAUDE.md'), 'a'.repeat(NOTES_MAX_BYTES - 1) + 'ö' + 'b'.repeat(100));
    const n = readNotes(app);
    assert.ok(n.startsWith('a'.repeat(NOTES_MAX_BYTES - 1)));
    assert.ok(!n.includes('�'), 'inget trasigt tecken');
    assert.ok(!n.includes('b'), 'inget efter gränsen');
    assert.match(n, /truncated/);
  });

  test('symbolisk länk följs inte (planterad läcka: readFileSync följer den)', () => {
    const canary = path.join(root, 'kanariefagel.txt');
    fs.writeFileSync(canary, 'KANARIE-7f3a');
    fs.rmSync(path.join(app, 'CLAUDE.md'));
    fs.symlinkSync(canary, path.join(app, 'CLAUDE.md'));
    assert.match(fs.readFileSync(path.join(app, 'CLAUDE.md'), 'utf8'), /KANARIE-7f3a/, 'kalibrering: den naiva läsningen läcker');
    assert.doesNotMatch(readNotes(app), /KANARIE-7f3a/);
    fs.rmSync(path.join(app, 'CLAUDE.md'));
  });

  test('en katalog läses inte', () => {
    fs.mkdirSync(path.join(app, 'CLAUDE.md'));
    assert.match(readNotes(app), /could not be read/);
    fs.rmdirSync(path.join(app, 'CLAUDE.md'));
  });
});

describe('commit-raden', () => {
  test('första icke-tomma raden, utan kontrolltecken, högst 72 tecken', () => {
    assert.equal(commitLine('Gör en mejlklient\nmed IMAP'), 'Gör en mejlklient');
    assert.equal(commitLine('\n\n  Byt färg  \nx'), 'Byt färg');
    assert.equal(commitLine('a\u0007b\u001bc'), 'abc');
    assert.equal(Array.from(commitLine('å'.repeat(100))).length, 72);
    assert.equal(commitLine('   '), 'Ändring');
  });
});

describe('reglerna om märket och kanalen (§8.11)', () => {
  test('wb.badge, wb.faces och wb.store.onChange står i reglerna, och inget eget BroadcastChannel-protokoll', () => {
    const rules = loadAppRules(path.resolve(import.meta.dirname, '..', '..'));
    assert.match(rules, /`wb\.badge\('3'\)`.*up to three characters beside the dot/);
    assert.match(rules, /`wb\.badge\(null\)` clears it\. Workbench doesn't keep it, so set it again whenever the page loads\./);
    assert.match(rules, /`wb\.store\.onChange\(\(\{ key \}\) => …\)`/);
    assert.match(rules, /read it when the page loads, and follow later changes with `wb\.store\.onChange`/);
    assert.match(rules, /`wb\.faces\.post\(msg\)` and receive it in the other faces with `wb\.faces\.onMessage\(fn\)`/);
    assert.doesNotMatch(rules, /Share live state with `BroadcastChannel`/);
  });
});
