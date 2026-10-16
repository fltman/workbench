// hud-placement.test.ts — var HUD:en hamnar (CONTRACT §13): höger, vänster, under, över med 14 px mellanrum,
// fria platser före överlapp, ovanpå fönstrets högra del när allt annat täcker det egna fönstret.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { candidate, choosePlacement, coversOwn, follow, GAP, GAP_BELOW, MARGIN, overlapArea } from '../../web/src/hud/placement.ts';

const view = { w: 1440, h: 900 };
const hud = { w: 360, h: 200 };

test('höger först: 14 px till höger om fönstret, toppen i linje', () => {
  const own = { x: 200, y: 150, w: 500, h: 400 };
  assert.deepEqual(choosePlacement(own, [], hud, view), { side: 'right', x: 200 + 500 + GAP, y: 150 });
});

test('vänster när höger inte ryms (klämd in över fönstret räknas som att täcka det)', () => {
  const own = { x: 900, y: 150, w: 420, h: 400 };
  const p = choosePlacement(own, [], hud, view);
  assert.equal(p.side, 'left');
  assert.equal(p.x, 900 - GAP - 360);
  assert.equal(p.y, 150);
});

test('under och sedan över när varken höger eller vänster ryms', () => {
  const wide = { x: 100, y: 120, w: 1240, h: 300 };
  const below = choosePlacement(wide, [], hud, view);
  assert.deepEqual(below, { side: 'below', x: 100, y: 120 + 300 + GAP_BELOW });
  const low = { x: 100, y: 500, w: 1240, h: 300 };
  const above = choosePlacement(low, [], hud, view);
  assert.deepEqual(above, { side: 'above', x: 100, y: 500 - GAP - 200 });
});

test('ett annat fönster till höger: vänster väljs i stället', () => {
  const own = { x: 500, y: 200, w: 400, h: 300 };
  const other = { x: 930, y: 150, w: 400, h: 400 };
  const p = choosePlacement(own, [other], hud, view);
  assert.equal(p.side, 'left');
  assert.equal(overlapArea({ x: p.x, y: p.y, w: hud.w, h: hud.h }, other), 0);
});

test('överlappar alla: den med minst överlapp', () => {
  const own = { x: 500, y: 250, w: 400, h: 300 };
  const others = [
    { x: 920, y: 200, w: 400, h: 400 }, // stor bit av höger
    { x: 60, y: 260, w: 120, h: 60 }, // liten bit av vänster
    { x: 400, y: 560, w: 700, h: 300 }, // under
    { x: 400, y: 0, w: 700, h: 240 }, // över
  ];
  const p = choosePlacement(own, others, hud, view);
  assert.equal(p.side, 'left');
  const cost = (side: 'right' | 'left' | 'below' | 'above') => {
    const c = candidate(side, own, hud, view);
    return others.reduce((s, o) => s + overlapArea({ x: c.x, y: c.y, w: hud.w, h: hud.h }, o), 0);
  };
  assert.ok(cost('left') > 0 && cost('left') < cost('right') && cost('left') < cost('below') && cost('left') < cost('above'));
});

test('täcker alla kandidater det egna fönstret: ovanpå fönstrets högra del, nere i hörnet', () => {
  const huge = { x: 20, y: 20, w: 1400, h: 860 };
  const p = choosePlacement(huge, [], hud, view);
  assert.equal(p.side, 'overlay');
  assert.equal(p.x, 20 + 1400 - 360 - GAP);
  // Botten 14 px ovanför fönstrets nederkant, så att appens knappar uppe till höger syns.
  assert.equal(p.y, 20 + 860 - 200 - GAP);
  assert.equal(overlapArea({ x: p.x, y: p.y, w: hud.w, h: hud.h }, { x: 20 + 1400 - 360 - GAP, y: 20, w: 360 + GAP, h: 120 }), 0, 'övre högra hörnet är fritt');
  // Botten står still när HUD:en växer: bara toppen flyttar sig.
  const taller = candidate('overlay', huge, { w: 360, h: 320 }, view);
  assert.equal(taller.y + 320, p.y + hud.h);
  // Ett fönster som går utanför vyn: klämd i vyn som alla andra kandidater.
  const off = { x: 20, y: 20, w: 1400, h: 1400 };
  assert.equal(candidate('overlay', off, hud, view).y, view.h - hud.h - MARGIN);
});

test('klämd i vyn: toppen följer fönstret men HUD:en går aldrig utanför', () => {
  const high = { x: 100, y: -300, w: 400, h: 500 };
  assert.equal(choosePlacement(high, [], hud, view).y, MARGIN);
  const low = { x: 100, y: 820, w: 400, h: 300 };
  const p = choosePlacement(low, [], hud, view);
  assert.equal(p.side, 'right');
  assert.equal(p.y, view.h - hud.h - MARGIN);
});

test('utan fönster: dockad nere till höger', () => {
  assert.deepEqual(choosePlacement(null, [], hud, view), { side: 'dock', x: 1440 - 360 - MARGIN, y: 900 - 200 - MARGIN });
});

test('follow: samma sida så länge den inte täcker det egna fönstret, annars väljs om', () => {
  const own = { x: 200, y: 150, w: 500, h: 400 };
  // ett annat fönster flyttas dit HUD:en står: sidan behålls (bara det egna fönstret får välja om)
  const other = { x: 720, y: 140, w: 300, h: 300 };
  assert.equal(follow('right', own, [other], hud, view).side, 'right');
  // kameran panorerar så att höger klämmer in över fönstret: välj om
  const moved = { x: 950, y: 150, w: 440, h: 400 };
  assert.ok(coversOwn(candidate('right', moved, hud, view), hud, moved));
  assert.equal(follow('right', moved, [], hud, view).side, 'left');
  // nödläget prövas om varje gång
  assert.equal(follow('overlay', own, [], hud, view).side, 'right');
  assert.equal(follow('dock', null, [], hud, view).side, 'dock');
  assert.equal(follow('dock', own, [], hud, view).side, 'right');
});

test('coversOwn tål en halv pixel avrundning men inte mer', () => {
  const own = { x: 0, y: 0, w: 100, h: 100 };
  assert.equal(coversOwn({ x: 99.5, y: 0 }, hud, own), false);
  assert.equal(coversOwn({ x: 98, y: 0 }, hud, own), true, 'två pixlar in i fönstret räknas');
  assert.equal(coversOwn({ x: 90, y: 0 }, hud, own), true);
});

test('vänster som kläms två pixlar in över det egna fönstret räknas som att täcka det', () => {
  const own = { x: 370, y: 190, w: 420, h: 320 };
  const other = { x: 820, y: 150, w: 420, h: 420 };
  const p = choosePlacement(own, [other], { w: 360, h: 54 }, view);
  assert.equal(p.side, 'below');
  assert.equal(overlapArea({ x: p.x, y: p.y, w: 360, h: 54 }, own), 0);
  assert.equal(overlapArea({ x: p.x, y: p.y, w: 360, h: 54 }, other), 0);
});

/* ------------------------------ flera HUD:ar (§13): äldre HUD:ar väger dubbelt ------------------------------ */

test('en äldre HUD på högerplatsen: vänster väljs (kalibrerat: utan HUD:ar blir det höger, och höger möter HUD:en)', () => {
  const own = { x: 500, y: 200, w: 400, h: 300 };
  const right = candidate('right', own, hud, view);
  const older = { x: right.x, y: right.y + 40, w: 360, h: 240 };
  assert.equal(choosePlacement(own, [], hud, view).side, 'right', 'kalibrering: utan HUD:ar höger');
  assert.ok(overlapArea({ x: right.x, y: right.y, w: hud.w, h: hud.h }, older) > 0, 'kalibrering: höger möter den äldre HUD:en');
  assert.equal(choosePlacement(own, [], hud, view, [older]).side, 'left');
});

test('överlapp med en HUD väger dubbelt (kalibrerat: samma rektangel som fönster väger enkelt och höger vinner)', () => {
  const own = { x: 500, y: 200, w: 400, h: 300 };
  const r = candidate('right', own, hud, view);
  const l = candidate('left', own, hud, view);
  // Höger: en HUD täcker 100×100 = X. Vänster: ett fönster täcker 150×100 = 1,5X. Under och över blockeras helt.
  const hudOnRight = { x: r.x + hud.w - 100, y: r.y, w: 100, h: 100 };
  const winOnLeft = { x: l.x, y: l.y, w: 150, h: 100 };
  const block = [
    { x: 0, y: own.y + own.h, w: 1440, h: 900 - own.y - own.h },
    { x: 0, y: 0, w: 1440, h: own.y },
  ];
  const others = [winOnLeft, ...block];
  assert.equal(choosePlacement(own, [...others, hudOnRight], hud, view).side, 'right', 'kalibrering: som fönster vinner höger');
  assert.equal(choosePlacement(own, others, hud, view, [hudOnRight]).side, 'left');
});

test('follow: en äldre HUD som växt över högersidan ger ett nytt val, ett fönster gör det inte (kalibrerat)', () => {
  const own = { x: 500, y: 200, w: 400, h: 300 };
  const right = candidate('right', own, hud, view);
  const grown = { x: right.x, y: right.y + 20, w: 360, h: 300 };
  assert.equal(follow('right', own, [grown], hud, view).side, 'right', 'kalibrering: som fönster står HUD:en kvar');
  assert.equal(follow('right', own, [], hud, view).side, 'right', 'kalibrering: utan HUD:ar står den kvar');
  assert.equal(follow('right', own, [], hud, view, [grown]).side, 'left');
});

test('lika kostnad: den nuvarande sidan står kvar (kalibrerat: utan prefer vinner ordningen)', () => {
  const own = { x: 500, y: 200, w: 400, h: 300 };
  const r = candidate('right', own, hud, view);
  const l = candidate('left', own, hud, view);
  const block = [
    { x: 0, y: own.y + own.h, w: 1440, h: 900 - own.y - own.h },
    { x: 0, y: 0, w: 1440, h: own.y },
  ];
  const same = [{ x: r.x, y: r.y, w: 50, h: 50 }, { x: l.x, y: l.y, w: 50, h: 50 }, ...block];
  assert.equal(choosePlacement(own, same, hud, view).side, 'right', 'kalibrering: ordningen');
  assert.equal(choosePlacement(own, same, hud, view, [], 'left').side, 'left');
});

test('hysteres: ett litet överlapp med en äldre HUD, eller en kamera i rörelse, ger inget byte (kalibrerat: större överlapp i vila byter)', () => {
  const own = { x: 500, y: 200, w: 400, h: 300 };
  const right = candidate('right', own, hud, view);
  const sliver = { x: right.x - 360 + 4, y: right.y, w: 360, h: 200 }; // 4 px in i högerplatsen
  const big = { x: right.x, y: right.y, w: 360, h: 200 };
  assert.equal(follow('right', own, [], hud, view, [big]).side !== 'right', true, 'kalibrering: ett stort överlapp i vila byter');
  assert.equal(follow('right', own, [], hud, view, [sliver]).side, 'right');
  assert.equal(follow('right', own, [], hud, view, [big], true).side, 'right', 'medan kameran rör sig');
});
