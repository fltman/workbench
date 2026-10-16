// world-gate.test.ts — bryggans grind (SEC-1): en app styr skalet (tangenter, hjul, fokus) bara när
// användaren är hos just den appen.
//
// Kalibrering: varje "släpps inte igenom" körs också mot en planterad läcka, en grind som släpper igenom
// allt (som världen gjorde före fixen: onKey ignorerade fönstret och hjul/fokus kontrollerades aldrig).
// Läckan måste fällas av samma scenario, annars bevisar scenariot ingenting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BridgeGate, NEAR_PX, distToRect, inView, rectGap } from '../../web/src/world/gate.ts';
import type { GateKind } from '../../web/src/world/gate.ts';

/** Den planterade läckan. */
class OpenGate extends BridgeGate {
  override allows(_kind: GateKind, _appId: string, _active: boolean): boolean {
    return true;
  }
}

const A = { appId: 'aaaaaaa', rect: { x: 160, y: 250, w: 420, h: 300 } };
const B = { appId: 'bbbbbbb', rect: { x: 820, y: 320, w: 380, h: 260 } };

/**
 * Säkerhetsgranskningens scenario: användaren arbetar med B (HUD:en har fokus, pekaren i ett tomt hörn).
 * A förfalskar Esc, ⌘K, hjul och fokus. Ger det som släpptes igenom.
 */
function hijack(gate: BridgeGate): GateKind[] {
  gate.pointer(5, 895, [A, B]);
  const through: GateKind[] = [];
  for (const kind of ['key', 'wheel', 'focus'] as const) if (gate.allows(kind, A.appId, false, A.rect)) through.push(kind);
  return through;
}

test('kalibrering: den planterade läckan släpper igenom hela kapningen', () => {
  assert.deepEqual(hijack(new OpenGate()), ['key', 'wheel', 'focus']);
});

test('en app som användaren inte rör får varken tangenter, hjul eller fokus igenom', () => {
  assert.deepEqual(hijack(new BridgeGate()), []);
});

test('tangenter godtas bara från appen vars iframe har tangentbordsfokus', () => {
  const g = new BridgeGate();
  g.pointer(A.rect.x + 10, A.rect.y + 10, [A, B]); // pekaren intill A räcker inte för tangenter
  assert.equal(g.allows('key', A.appId, false), false);
  assert.equal(g.allows('key', A.appId, true), true);
  assert.equal(new OpenGate().allows('key', A.appId, false), true, 'kalibrering');
});

test('hjul godtas när skalet senast såg pekaren intill appens fönster eller appen har fokus, annars inte', () => {
  const g = new BridgeGate();
  // Pekaren på väg in i A: sista rörelsen skalet ser ligger strax utanför kanten.
  g.pointer(A.rect.x - 30, A.rect.y + 100, [A, B]);
  assert.equal(g.allows('wheel', A.appId, false), true);
  assert.equal(g.allows('wheel', B.appId, false), false);
  // Ett snabbt drag hinner längre per bildruta, men inte obegränsat.
  g.pointer(A.rect.x - NEAR_PX + 1, A.rect.y + 100, [A, B]);
  assert.equal(g.allows('wheel', A.appId, false), true);
  g.pointer(A.rect.x - NEAR_PX - 1, A.rect.y + 100, [A, B]);
  assert.equal(g.allows('wheel', A.appId, false), false);
  assert.equal(g.allows('wheel', A.appId, true), true, 'användaren har klickat i appen');
});

test('en gest som börjat över appen fortsätter när kameran flyttar fönstret (ingen ny pekarhändelse)', () => {
  const g = new BridgeGate();
  g.pointer(A.rect.x + 5, A.rect.y + 5, [A, B]);
  // Panoreringen flyttar A långt bort; pekaren står still inne i appen och skalet ser ingenting.
  for (let i = 0; i < 50; i++) assert.equal(g.allows('wheel', A.appId, false), true);
  // Pekaren kommer ut i skalet igen, långt från A: slut.
  g.pointer(1400, 40, [{ ...A, rect: { ...A.rect, x: -900 } }, B]);
  assert.equal(g.allows('wheel', A.appId, false), false);
});

test('fokus godtas med tangentbordsfokus eller pekaren intill fönstret', () => {
  const g = new BridgeGate();
  g.pointer(5, 895, [A, B]);
  assert.equal(g.allows('focus', A.appId, false), false);
  assert.equal(g.allows('focus', A.appId, true), true);
  g.pointer(A.rect.x + 1, A.rect.y + 1, [A, B]);
  assert.equal(g.allows('focus', A.appId, false), true);
});

test('en borttagen app får aldrig något mer igenom', () => {
  const g = new BridgeGate();
  g.pointer(A.rect.x + 5, A.rect.y + 5, [A, B]);
  g.forget(A.appId);
  assert.equal(g.allows('wheel', A.appId, false), false);
  assert.equal(g.near(A.appId), false);
});

test('fönster utan app (den provisoriska vyn medan createApp pågår) räknas aldrig', () => {
  const g = new BridgeGate();
  g.pointer(A.rect.x + 5, A.rect.y + 5, [{ appId: '', rect: A.rect }]);
  assert.equal(g.near(''), false);
});

test('distToRect: 0 inuti och på kanten, euklidiskt utanför hörnen', () => {
  const r = { x: 0, y: 0, w: 100, h: 50 };
  assert.equal(distToRect(r, 50, 25), 0);
  assert.equal(distToRect(r, 100, 50), 0);
  assert.equal(distToRect(r, -3, 25), 3);
  assert.equal(distToRect(r, 50, 60), 10);
  assert.equal(distToRect(r, 103, 54), 5);
});

test('ett fönster som kameran för in under en stilla pekare får nästa gest (panorering över tom yta)', () => {
  const g = new BridgeGate();
  // Pekaren står i ett tomt område; A ligger långt bort när skalet senast såg den.
  g.pointer(1000, 700, [A, B]);
  const far = A.rect;
  assert.equal(g.allows('wheel', A.appId, false, far), false);
  // Panoreringen har fört A in under pekaren: platsen nu räknas.
  const under = { x: 900, y: 600, w: 420, h: 300 };
  assert.equal(g.allows('wheel', A.appId, false, under), true);
  // Kapningen är fortfarande stängd med fönstrens plats nu (pekaren i hörnet, A långt därifrån).
  g.pointer(5, 895, [A, B]);
  assert.equal(g.allows('wheel', A.appId, false, A.rect), false);
  assert.equal(g.allows('focus', A.appId, false, A.rect), false);
  assert.equal(g.allows('key', A.appId, false, under), false, 'tangenter kräver alltid fokus');
});

/** Våg 3:s grind, utan blindläget: efter en omladdning gick varken nyp eller hjul igenom över appen. */
class Wave3Gate extends BridgeGate {
  override allows(kind: GateKind, appId: string, active: boolean, rect?: { x: number; y: number; w: number; h: number }): boolean {
    if (kind === 'key') return active;
    return active || this.near(appId, rect);
  }
}

/** Planterad läcka: blindläget gäller även sedan skalet sett pekaren. */
class AlwaysBlind extends BridgeGate {
  override allows(kind: GateKind, appId: string, active: boolean, rect?: { x: number; y: number; w: number; h: number }, plausible?: () => boolean): boolean {
    if (kind === 'key') return active;
    return active || this.near(appId, rect) || (kind === 'wheel' && !!plausible?.());
  }
}

test('omladdning medan pekaren vilar över appen: hjulet godtas innan skalet sett pekaren', () => {
  const yes = () => true;
  assert.equal(new BridgeGate().allows('wheel', A.appId, false, A.rect, yes), true);
  const wave3: BridgeGate = new Wave3Gate();
  assert.equal(wave3.allows('wheel', A.appId, false, A.rect, yes), false, 'kalibrering: våg 3 släppte inte igenom');
});

test('blindläget: bara hjul, bara när det är rimligt, och bara tills skalet sett pekaren', () => {
  const g = new BridgeGate();
  const yes = () => true;
  assert.equal(g.allows('wheel', A.appId, false, A.rect, () => false), false, 'fönstret syns inte eller ligger inte överst');
  assert.equal(g.allows('wheel', A.appId, false, A.rect), false, 'ingen rimlighetsprövning');
  assert.equal(g.allows('focus', A.appId, false, A.rect, yes), false);
  assert.equal(g.allows('key', A.appId, false, A.rect, yes), false);
  assert.equal(new OpenGate().allows('focus', A.appId, false), true, 'kalibrering');
  // Skalet ser pekaren i ett tomt hörn: blindläget är slut, kapningen stängd igen.
  g.pointer(5, 895, [A, B]);
  assert.equal(g.allows('wheel', A.appId, false, A.rect, yes), false);
  const leak = new AlwaysBlind();
  leak.pointer(5, 895, [A, B]);
  assert.equal(leak.allows('wheel', A.appId, false, A.rect, yes), true, 'kalibrering: läckan fälls av samma scenario');
});

test('inView: syns rektangeln i vyn', () => {
  assert.equal(inView({ x: 0, y: 0, w: 10, h: 10 }, 1440, 900), true);
  assert.equal(inView({ x: -2000, y: 0, w: 3000, h: 10 }, 1440, 900), true, 'större än vyn');
  assert.equal(inView({ x: 1440, y: 0, w: 10, h: 10 }, 1440, 900), false);
  assert.equal(inView({ x: -10, y: 0, w: 10, h: 10 }, 1440, 900), false);
  assert.equal(inView({ x: 3000, y: -250, w: 420, h: 300 }, 1440, 900), false);
  assert.equal(inView({ x: 10, y: 10, w: 0, h: 10 }, 1440, 900), false);
});

test('från A rakt in i ett överlappande B (snabbt drag över storlekszonerna): hjul över B godtas', () => {
  // Skalet såg pekaren sist när den gick in i A vid vänsterkanten; B överlappar A:s högra kant med 20 px.
  const Bo = { appId: 'bbbbbbb', rect: { x: A.rect.x + A.rect.w - 20, y: A.rect.y, w: 420, h: 300 } };
  const g = new BridgeGate();
  g.pointer(A.rect.x - 30, A.rect.y + 100, [A, Bo]);
  assert.equal(g.allows('wheel', Bo.appId, false, Bo.rect), true);
  const w3 = new Wave3Gate();
  w3.pointer(A.rect.x - 30, A.rect.y + 100, [A, Bo]);
  assert.equal(w3.allows('wheel', Bo.appId, false, Bo.rect), false, 'kalibrering: våg 3 släppte inte igenom (uppmätt i r4-sec.mjs)');
  // Fokus och tangenter kräver mer: ett klick i B ger B tangentbordsfokus.
  assert.equal(g.allows('focus', Bo.appId, false, Bo.rect), false);
  assert.equal(g.allows('key', Bo.appId, false, Bo.rect), false);
  assert.equal(g.allows('focus', Bo.appId, true, Bo.rect), true);
});

test('kedjan av fönster: inom NEAR_PX från ett fönster pekaren kan vara i, transitivt, men inte längre', () => {
  const at = { x: A.rect.x - 10, y: A.rect.y + 10 };
  const right = (r: { x: number; y: number; w: number; h: number }, gap: number) => ({ x: r.x + r.w + gap, y: r.y, w: 300, h: 200 });
  const B1 = { appId: 'b1b1b1b', rect: right(A.rect, NEAR_PX) };
  const C1 = { appId: 'c1c1c1c', rect: right(B1.rect, 40) };
  const D1 = { appId: 'd1d1d1d', rect: right(C1.rect, NEAR_PX + 1) };
  const g = new BridgeGate();
  g.pointer(at.x, at.y, [A, B1, C1, D1]);
  assert.equal(g.allows('wheel', B1.appId, false, B1.rect), true);
  assert.equal(g.allows('wheel', C1.appId, false, C1.rect), true, 'via B1');
  assert.equal(g.allows('wheel', D1.appId, false, D1.rect), false, 'en lucka större än NEAR_PX passeras inte osedd');
  assert.equal(new OpenGate().allows('wheel', D1.appId, false), true, 'kalibrering');
  // Pekaren syns i ett tomt hörn: kedjan är borta.
  g.pointer(5, 895, [A, B1, C1, D1]);
  assert.equal(g.allows('wheel', C1.appId, false, C1.rect), false);
  // Appen försvinner: inget mer igenom.
  g.pointer(at.x, at.y, [A, B1, C1, D1]);
  g.forget(C1.appId);
  assert.equal(g.allows('wheel', C1.appId, false, C1.rect), false);
});

test('rectGap: 0 när rektanglarna rör eller överlappar varandra, annars euklidiskt', () => {
  const r = { x: 0, y: 0, w: 100, h: 50 };
  assert.equal(rectGap(r, { x: 90, y: 10, w: 50, h: 50 }), 0);
  assert.equal(rectGap(r, { x: 100, y: 0, w: 50, h: 50 }), 0);
  assert.equal(rectGap(r, { x: 130, y: 0, w: 50, h: 50 }), 30);
  assert.equal(rectGap(r, { x: 103, y: 54, w: 10, h: 10 }), 5);
  assert.equal(rectGap({ x: 103, y: 54, w: 10, h: 10 }, r), 5);
});

test('pekaren lämnar sidan och kommer tillbaka utifrån rakt ned i appen: hjulet godtas, fokus och tangenter inte', () => {
  const yes = () => true;
  const g = new BridgeGate();
  g.pointer(5, 120, [A, B]); // sist sedd över tom yta vid vänsterkanten, långt från B
  assert.equal(g.allows('wheel', B.appId, false, B.rect, yes), false);
  g.lost();
  assert.equal(g.allows('wheel', B.appId, false, B.rect, yes), true);
  assert.equal(g.allows('wheel', B.appId, false, B.rect, () => false), false, 'fönstret syns inte eller ligger inte överst');
  assert.equal(g.allows('focus', B.appId, false, B.rect, yes), false);
  assert.equal(g.allows('key', B.appId, false, B.rect, yes), false);
  const w3: BridgeGate = new Wave3Gate();
  w3.pointer(5, 120, [A, B]);
  w3.lost();
  assert.equal(w3.allows('wheel', B.appId, false, B.rect, yes), false, 'kalibrering: våg 3 släppte inte igenom (uppmätt i r4-sec.mjs)');
  // Pekaren syns i skalet igen, i ett tomt hörn: kapningen stängd.
  g.pointer(5, 895, [A, B]);
  assert.equal(g.allows('wheel', B.appId, false, B.rect, yes), false);
});
