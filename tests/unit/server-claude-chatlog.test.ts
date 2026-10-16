// chat.jsonl: historiken och lagningen vid start (CONTRACT §8.10).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { appendEvents, chatFile, deleteSessionFile, history, readEvents, readSessionId, repairChat, writeSessionId } from '../../server/claude/chatlog.ts';
import { rmrf, tmpHome } from './server-claude-kit.ts';
import type { ChatEvent } from '../../shared/protocol.ts';

let dir: string;
beforeEach(() => {
  dir = path.join(tmpHome('wb-chat'), 'data', 'apps', 'aapp001');
});
afterEach(() => rmrf(path.resolve(dir, '..', '..', '..')));

const user = (at: number): ChatEvent => ({ k: 'user', id: `u${at}`, text: 'hej', via: 'text', at });

describe('lagning vid start', () => {
  test('obesvarad ask får ask-done cancelled och öppen tur får turn slut med interrupted', () => {
    appendEvents(dir, [
      user(1),
      { k: 'turn', phase: 'start', at: 2 },
      { k: 'ask', id: 'q-1', ask: { kind: 'permission', tool: 'WebFetch', title: 'Hämta från nätet?', detail: 'https://example.com', canRemember: true, defaultNo: false }, at: 3 },
    ]);
    const fixes = repairChat(dir, 100);
    assert.deepEqual(fixes, [
      { k: 'ask-done', id: 'q-1', decision: 'cancelled' },
      { k: 'turn', phase: 'end', ok: false, interrupted: true, at: 100 },
    ]);
    const all = readEvents(dir);
    assert.deepEqual(all.slice(-2), fixes, 'lagningen sparas i filen');
    assert.deepEqual(repairChat(dir, 200), [], 'en andra lagning gör ingenting');
  });

  test('en avslutad tur och besvarad fråga lämnas orörda', () => {
    appendEvents(dir, [
      user(1),
      { k: 'turn', phase: 'start', at: 2 },
      { k: 'ask', id: 'q-1', ask: { kind: 'secret', key: 'k', label: 'Nyckel' }, at: 3 },
      { k: 'ask-done', id: 'q-1', decision: 'answered' },
      { k: 'turn', phase: 'end', ok: true, interrupted: false, at: 4 },
    ]);
    assert.deepEqual(repairChat(dir), []);
  });

  test('tidsstämpeln för turens slut kommer efter den sista händelsen', () => {
    appendEvents(dir, [{ k: 'turn', phase: 'start', at: 5000 }]);
    const [fix] = repairChat(dir, 10);
    assert.equal(fix.k === 'turn' ? fix.at : 0, 5001);
  });

  test('trasiga rader hoppas över', () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(chatFile(dir), `${JSON.stringify(user(1))}\n{trasig\n\n${JSON.stringify({ k: 'turn', phase: 'start', at: 2 })}\n`);
    assert.equal(readEvents(dir).length, 2);
    assert.equal(repairChat(dir, 9).length, 1);
  });

  test('ingen fil: ingenting', () => {
    assert.deepEqual(repairChat(dir), []);
    assert.deepEqual(history(dir), []);
  });
});

describe('historik och session.json', () => {
  test('de senaste n, äldst först, utan delta', () => {
    appendEvents(dir, Array.from({ length: 10 }, (_, i) => user(i)));
    fs.appendFileSync(chatFile(dir), JSON.stringify({ k: 'delta', text: 'x' }) + '\n');
    const h = history(dir, 3);
    assert.deepEqual(h.map((e) => (e.k === 'user' ? e.at : -1)), [7, 8, 9]);
  });

  test('session.json skrivs atomiskt och tas bort', () => {
    assert.equal(readSessionId(dir), undefined);
    writeSessionId(dir, 'abc-123');
    assert.equal(readSessionId(dir), 'abc-123');
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes('.tmp.')), [], 'inga tmp-filer kvar');
    deleteSessionFile(dir);
    assert.equal(readSessionId(dir), undefined);
  });
});
