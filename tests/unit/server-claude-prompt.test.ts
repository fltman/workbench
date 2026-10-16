// <workbench>-blocket (CONTRACT §8.4), CLAUDE.md-läsningen och commit-raden.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { backendLine, commitLine, composeMessage, loadAppRules, NOTES_MAX_BYTES, readNotes, workbenchBlock } from '../../server/claude/prompt.ts';
import { rmrf, tmpHome } from './server-claude-kit.ts';
import type { WindowState } from '../../shared/protocol.ts';

const WIN: WindowState = { id: 'w-aapp001', appId: 'aapp001', x: 0, y: 0, w: 640, h: 480, scale: 1, face: 0, z: 1 };
const FACES = [{ id: 'main', page: 'index.html' }];

describe('<workbench>-blocket', () => {
  test('grundformen ur kontraktet', () => {
    const b = workbenchBlock({ win: WIN, faces: FACES, backend: 'none', backendPort: null, undone: false, notes: null });
    assert.equal(b, '<workbench>\nWindow: 640×480 CSS px (scale 1). Front face: main (1 of 1).\nBack end: none.\nWrite every message to the user in Swedish.\n</workbench>');
  });

  test('språkraden finns i varje block, före anteckningarna', () => {
    for (const undone of [false, true]) {
      for (const notes of [null, '', '# Mejl\n']) {
        const b = workbenchBlock({ win: WIN, faces: FACES, backend: 'running', backendPort: 18300, undone, notes });
        const lines = b.split('\n');
        const i = lines.indexOf('Write every message to the user in Swedish.');
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
    assert.match(backendLine('stopped', null), /^Back end: stopped/);
    assert.match(backendLine('starting', null), /^Back end: starting/);
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
    // Slutsvaret: svenska och högst två korta meningar, både bland reglerna för samtalet och sist i checklistan (AQ-1, AQ-2).
    assert.match(rules, /Write every message to the user in Swedish/);
    assert.match(rules, /Then write your closing message last: in Swedish, at most two short sentences\./);
    assert.match(rules, /## Show the app early/);
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
