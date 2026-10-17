// tests/unit/server-store-logs.test.ts — loggar per app (AppLogs, CONTRACT §3).
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makePaths } from '../../server/paths.ts';
import { cleanLogText, createAppLogs, RING_SIZE, ROTATE_BYTES } from '../../server/store/logs.ts';
import type { Config, Paths } from '../../server/types.ts';

const roots: string[] = [];
const ID = 'a000001';
function setup(): Paths {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'wb-logs-')));
  roots.push(home);
  const paths = makePaths({ home } as Config);
  fs.mkdirSync(paths.appDir(ID), { recursive: true });
  return paths;
}
after(() => {
  for (const d of roots) fs.rmSync(d, { recursive: true, force: true });
});

const LINE_RE = /^(\d\d):(\d\d):(\d\d) \[(console|backend|workbench)\] (.*)$/s;

test('tail: "HH:MM:SS [källa] text" i lokal tid, äldst först', () => {
  const logs = createAppLogs(setup());
  const before = new Date();
  logs.append(ID, 'backend', 'lyssnar på 18300');
  logs.append(ID, 'console', 'Uncaught TypeError: x är inte en funktion');
  logs.append(ID, 'workbench', 'Backenden startades om');
  const lines = logs.tail(ID);
  assert.equal(lines.length, 3);
  const m = LINE_RE.exec(lines[0]);
  assert.ok(m, lines[0]);
  const stamp = new Date(before);
  stamp.setHours(Number(m[1]), Number(m[2]), Number(m[3]), 0);
  assert.ok(Math.abs(stamp.getTime() - before.getTime()) < 2000, 'klockslaget är nu, i lokal tid');
  assert.deepEqual(lines.map((l) => l.replace(/^\d\d:\d\d:\d\d /, '')), [
    '[backend] lyssnar på 18300',
    '[console] Uncaught TypeError: x är inte en funktion',
    '[workbench] Backenden startades om',
  ]);
});

test('tail: standard 80, gränser för n', () => {
  const logs = createAppLogs(setup());
  for (let i = 1; i <= 100; i++) logs.append(ID, 'backend', `rad ${i}`);
  const tail = logs.tail(ID);
  assert.equal(tail.length, 80);
  assert.match(tail[0], /rad 21$/);
  assert.match(tail[79], /rad 100$/);
  assert.deepEqual(logs.tail(ID, 3).map((l) => l.slice(-7)), ['rad 98', 'rad 99', 'rad 100'].map((s) => s.padStart(7)));
  assert.deepEqual(logs.tail(ID, 0), []);
  assert.deepEqual(logs.tail(ID, -5), []);
  assert.equal(logs.tail(ID, Number.NaN).length, 80);
  assert.equal(logs.tail(ID, 1e9).length, 100);
  assert.deepEqual(logs.tail('a999999'), []);
});

test(`ringen håller de senaste ${RING_SIZE} raderna (minst 2000)`, () => {
  assert.ok(RING_SIZE >= 2000);
  const logs = createAppLogs(setup());
  for (let i = 1; i <= 2600; i++) logs.append(ID, 'console', `rad ${i}`);
  const all = logs.tail(ID, 100_000);
  assert.equal(all.length, RING_SIZE);
  assert.match(all[0], new RegExp(`rad ${2600 - RING_SIZE + 1}$`));
  assert.match(all[all.length - 1], /rad 2600$/);
});

test('text tvättas: ANSI, styrtecken, CRLF, avslutande blanktecken, långa poster; tomma sparas inte', () => {
  assert.equal(cleanLogText('\x1b[31mröd\x1b[0m och \x1b[1;32mgrön\x1b[0m'), 'röd och grön');
  assert.equal(cleanLogText('\x1b]0;titel\x07kvar'), 'kvar');
  assert.equal(cleanLogText('a\r\nb\rc\n\n  '), 'a\nbc');
  assert.equal(cleanLogText('\tindrag\x00\x08\x7f\x9b'), '\tindrag');
  const long = cleanLogText('å'.repeat(5000));
  assert.equal(long.length, 4001);
  assert.ok(long.endsWith('…'));
  const emoji = cleanLogText('x'.repeat(3999) + '\u{1f600}');
  assert.equal(emoji, `${'x'.repeat(3999)}…`, 'ett surrogatpar delas aldrig');

  const logs = createAppLogs(setup());
  logs.append(ID, 'backend', '');
  logs.append(ID, 'backend', '\n\r\n  ');
  logs.append(ID, 'backend', '\x1b[0m');
  assert.deepEqual(logs.tail(ID), []);
});

test('okänd källa blir workbench; ogiltigt id ignoreras utan undantag', () => {
  const logs = createAppLogs(setup());
  logs.append(ID, 'skal' as 'console', 'hej');
  assert.match(logs.tail(ID)[0], /\[workbench\] hej$/);
  for (const bad of ['../x', 'A1', '', 'a/b']) {
    assert.doesNotThrow(() => logs.append(bad, 'console', 'x'));
    assert.deepEqual(logs.tail(bad), []);
  }
});

test('logs.txt får "YYYY-MM-DD HH:MM:SS [källa] text", läge 0600', async () => {
  const paths = setup();
  const logs = createAppLogs(paths);
  logs.append(ID, 'console', 'första');
  logs.append(ID, 'backend', 'andra\nmed fortsättning');
  await logs.flush();
  const file = path.join(paths.appDataDir(ID), 'logs.txt');
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d \[console\] första\n\d{4}-\d\d-\d\d \d\d:\d\d:\d\d \[backend\] andra\nmed fortsättning\n$/);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('rotation vid 1 MB: logs.txt blir logs.txt.1, bara en gammal fil sparas, ingen fil över 1 MB', async () => {
  const paths = setup();
  const logs = createAppLogs(paths);
  const file = path.join(paths.appDataDir(ID), 'logs.txt');
  const body = 'x'.repeat(970);
  let written = 0;
  for (let i = 0; i < 1500; i++) logs.append(ID, 'backend', `${String(i).padStart(5, '0')} ${body}`);
  await logs.flush(); // en enda bunt på ~1,5 MB
  written += 1500;
  const s1 = fs.statSync(file).size;
  const s2 = fs.statSync(`${file}.1`).size;
  assert.ok(s1 <= ROTATE_BYTES && s2 <= ROTATE_BYTES, `${s1} ${s2}`);
  const lines = (f: string) => fs.readFileSync(f, 'utf8').trimEnd().split('\n');
  assert.equal(lines(file).length + lines(`${file}.1`).length, written, 'inga rader tappades vid rotationen');

  for (let i = 1500; i < 3000; i++) {
    logs.append(ID, 'backend', `${String(i).padStart(5, '0')} ${body}`);
    if (i % 100 === 0) await logs.flush(); // många små buntar
  }
  await logs.flush();
  assert.equal(fs.existsSync(`${file}.2`), false);
  assert.deepEqual(fs.readdirSync(paths.appDataDir(ID)).sort(), ['logs.txt', 'logs.txt.1']);
  assert.ok(fs.statSync(file).size <= ROTATE_BYTES);
  assert.ok(fs.statSync(`${file}.1`).size <= ROTATE_BYTES);
  const current = lines(file);
  const previous = lines(`${file}.1`);
  assert.match(current[current.length - 1], /\[backend\] 02999 x+$/, 'senaste raden sist i logs.txt');
  const firstNow = Number(/\] (\d{5}) /.exec(current[0])?.[1]);
  const lastBefore = Number(/\] (\d{5}) /.exec(previous[previous.length - 1])?.[1]);
  assert.equal(firstNow, lastBefore + 1, 'logs.txt.1 slutar raden före logs.txt börjar');
});

test('efter en omstart läser tail de senaste posterna ur logs.txt, också flerradiga, och nya poster kommer efter dem (Visa loggen var tom efter varje omstart)', async () => {
  const paths = setup();
  const before = createAppLogs(paths);
  before.append(ID, 'console', 'error: Uncaught Error: före omstarten');
  before.append(ID, 'backend', 'TypeError: x\n    at server.mjs:3\n\n    at y');
  before.append(ID, 'workbench', 'Backenden startades om');
  const lines = before.tail(ID, 100);
  await before.flush();
  // En ny process: samma rader, i samma format och lokal tid.
  const after = createAppLogs(paths);
  assert.deepEqual(after.tail(ID, 100), lines);
  assert.deepEqual(after.tail(ID, 1), lines.slice(-1));
  after.append(ID, 'console', 'error: efter omstarten');
  const now = after.tail(ID, 100);
  assert.deepEqual(now.slice(0, 3), lines);
  assert.match(now[3], /\[console\] error: efter omstarten$/);
  // En app som aldrig loggat, och ett ogiltigt id: inget att läsa, inget undantag.
  assert.deepEqual(after.tail('a999999'), []);
  assert.deepEqual(after.tail('../x'), []);
});

test('efter en omstart: logs.txt.1 fyller på när logs.txt har färre poster än det som efterfrågas; clear läser inte in filen igen', async () => {
  const paths = setup();
  const file = path.join(paths.appDataDir(ID), 'logs.txt');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.1`, '2026-10-16 23:59:58 [backend] rad 1\n2026-10-16 23:59:59 [backend] rad 2\n');
  fs.writeFileSync(file, '2026-10-17 00:00:01 [console] rad 3\nmed fortsättning\n2026-10-17 07:39:09 [workbench] rad 4\n');
  const logs = createAppLogs(paths);
  assert.deepEqual(logs.tail(ID, 10), ['23:59:58 [backend] rad 1', '23:59:59 [backend] rad 2', '00:00:01 [console] rad 3\nmed fortsättning', '07:39:09 [workbench] rad 4']);
  logs.clear(ID);
  assert.deepEqual(logs.tail(ID), [], 'en borttagen app får inte tillbaka loggen ur filen');
});

test('clear tömmer minnet; en borttagen app får ingen ny katalog', async () => {
  const paths = setup();
  const logs = createAppLogs(paths);
  logs.append(ID, 'backend', 'före');
  await logs.flush();
  logs.clear(ID);
  assert.deepEqual(logs.tail(ID), []);

  // Som registry.remove: båda katalogerna flyttas bort.
  fs.renameSync(paths.appDir(ID), path.join(paths.trashDir, 'app'));
  fs.renameSync(paths.appDataDir(ID), path.join(paths.trashDir, 'data'));
  logs.append(ID, 'backend', 'sen rad från en backend som stängs');
  await logs.flush();
  assert.equal(fs.existsSync(paths.appDataDir(ID)), false);
});
