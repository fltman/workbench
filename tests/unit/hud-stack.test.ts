// hud-stack.test.ts — ordningen mellan öppna HUD:ar (web/src/hud/stack.ts, CONTRACT §13): den aktiva, Esc-ordningen
// och automatiken bakom den aktiva. Kalibrerad i samma fil: två planterade modeller (en enda HUD som byter app, och
// en automatik som lägger sig överst) måste fällas av de två första scenarierna.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as S from '../../web/src/hud/stack.ts';

type Model = Pick<typeof S, 'open' | 'close' | 'activate' | 'activeOf'> & { EMPTY: S.Stack };

const real: Model = S;

// Planterad 1: en HUD åt gången (att öppna ersätter den förra), som före flera HUD:ar.
const single: Model = {
  EMPTY: S.EMPTY,
  activeOf: S.activeOf,
  open: (_s, id) => ({ opened: [id], recent: [id] }),
  close: S.close,
  activate: S.activate,
};

// Planterad 2: automatiken lägger sig överst (tar fokus från den man skriver i).
const autoOnTop: Model = {
  ...real,
  open: (s, id) => S.open(s, id, true),
};

function scenarioTwo(m: Model): void {
  let s = m.open(m.EMPTY, 'aaaaaaa', true);
  s = m.open(s, 'bbbbbbb', true);
  assert.deepEqual(s.opened, ['aaaaaaa', 'bbbbbbb']);
  assert.equal(m.activeOf(s), 'bbbbbbb');
}

function scenarioAuto(m: Model): void {
  let s = m.open(m.EMPTY, 'aaaaaaa', true);
  s = m.open(s, 'bbbbbbb', true);
  s = m.open(s, 'ccccccc', false);
  assert.deepEqual(s.recent, ['aaaaaaa', 'ccccccc', 'bbbbbbb']);
  assert.equal(m.activeOf(s), 'bbbbbbb');
  s = m.close(s, 'bbbbbbb');
  assert.equal(m.activeOf(s), 'ccccccc');
}

test('kalibrering: en planterad enkel-HUD och en automatik som lägger sig överst fälls', () => {
  assert.throws(() => scenarioTwo(single), 'enkel-HUD:en fälls av "två öppna"');
  assert.throws(() => scenarioAuto(single), 'enkel-HUD:en fälls av automatiken');
  assert.doesNotThrow(() => scenarioTwo(autoOnTop));
  assert.throws(() => scenarioAuto(autoOnTop), 'automatiken överst fälls');
});

test('A sedan B: båda öppna i den ordningen, B aktiv', () => scenarioTwo(real));

test('automatiken bakom den aktiva: näst sist, och aktiv när den aktiva stängs', () => scenarioAuto(real));

test('activate flyttar bara i recent; opened står kvar', () => {
  let s = S.open(S.EMPTY, 'aaaaaaa', true);
  s = S.open(s, 'bbbbbbb', true);
  s = S.open(s, 'ccccccc', true);
  s = S.activate(s, 'aaaaaaa');
  assert.deepEqual(s.opened, ['aaaaaaa', 'bbbbbbb', 'ccccccc']);
  assert.deepEqual(s.recent, ['bbbbbbb', 'ccccccc', 'aaaaaaa']);
  assert.equal(S.activeOf(s), 'aaaaaaa');
  assert.equal(S.activate(s, 'zzzzzzz'), s, 'okänd: oförändrad');
});

test('att stänga en som inte är aktiv behåller den aktiva', () => {
  let s = S.open(S.EMPTY, 'aaaaaaa', true);
  s = S.open(s, 'bbbbbbb', true);
  s = S.close(s, 'aaaaaaa');
  assert.equal(S.activeOf(s), 'bbbbbbb');
  assert.deepEqual(s.opened, ['bbbbbbb']);
});

test('redan öppen: open(…, true) gör den aktiv utan dubblett; open(…, false) ändrar inget', () => {
  let s = S.open(S.EMPTY, 'aaaaaaa', true);
  s = S.open(s, 'bbbbbbb', true);
  const again = S.open(s, 'aaaaaaa', true);
  assert.deepEqual(again.opened, ['aaaaaaa', 'bbbbbbb']);
  assert.equal(S.activeOf(again), 'aaaaaaa');
  assert.equal(S.open(s, 'aaaaaaa', false), s);
});

test('automatiken när ingen är öppen: den blir aktiv', () => {
  const s = S.open(S.EMPTY, 'xxxxxxx', false);
  assert.equal(S.activeOf(s), 'xxxxxxx');
});

test('Esc-ordningen: varje stängning av den aktiva ger den som senast var aktiv', () => {
  let s = S.open(S.EMPTY, 'aaaaaaa', true);
  s = S.open(s, 'bbbbbbb', true);
  s = S.open(s, 'ccccccc', true);
  s = S.activate(s, 'aaaaaaa');
  const order: Array<string | null> = [];
  while (S.activeOf(s)) {
    const a = S.activeOf(s) as string;
    order.push(a);
    s = S.close(s, a);
  }
  assert.deepEqual(order, ['aaaaaaa', 'ccccccc', 'bbbbbbb']);
  assert.equal(S.activeOf(s), null);
});

test('restore: den aktiva sist, den sparade Esc-ordningen behålls; en försvunnen aktiv ger den sista', () => {
  assert.deepEqual(S.restore(['aaaaaaa', 'bbbbbbb', 'ccccccc'], 'bbbbbbb').recent, ['aaaaaaa', 'ccccccc', 'bbbbbbb']);
  const r = S.restore(['aaaaaaa', 'bbbbbbb', 'ccccccc'], 'ccccccc', ['bbbbbbb', 'aaaaaaa', 'ccccccc']);
  assert.deepEqual(r.opened, ['aaaaaaa', 'bbbbbbb', 'ccccccc']);
  assert.deepEqual(r.recent, ['bbbbbbb', 'aaaaaaa', 'ccccccc']);
  assert.equal(S.activeOf(S.restore(['aaaaaaa', 'bbbbbbb'], 'zzzzzzz')), 'bbbbbbb');
  assert.equal(S.activeOf(S.restore([], null)), null);
});
