// world-layout.test.ts — storlek från en ritad fyrkant (§10.4, §5), prickens plats, kantmarkörer och fönsteroperationer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CASCADE, DRAW_INSET, LIMITS, MIN_DRAW_H, MIN_DRAW_W, clampToView, dotPointLocal, edgeMarker, requestFromDrawn, resizeFrom, scaleAround, scaleFrom, screenRectOfWin, topmostAt, coveredPoint, coveredRect, freeStrip, fieldRect
} from '../../web/src/world/layout.ts';
import { HUD_WEIGHT, overlapArea } from '../../web/src/hud/placement.ts';
import { worldToScreen } from '../../web/src/world/camera.ts';
import type { Camera } from '../../shared/protocol.ts';

const VW = 1440;
const VH = 900;
const near = (a: number, b: number, eps = 1e-9, msg = ''): void => assert.ok(Math.abs(a - b) <= eps, `${msg} ${a} ≠ ${b} (±${eps})`);

test('för liten fyrkant (under 120×80 skärm-px) blir ingen app', () => {
  const cam: Camera = { cx: 0, cy: 0, zoom: 1 };
  assert.equal(MIN_DRAW_W, 120);
  assert.equal(MIN_DRAW_H, 80);
  assert.equal(requestFromDrawn({ x: 10, y: 10, w: 119.9, h: 300 }, cam, VW, VH), null);
  assert.equal(requestFromDrawn({ x: 10, y: 10, w: 300, h: 79 }, cam, VW, VH), null);
  assert.notEqual(requestFromDrawn({ x: 10, y: 10, w: 120, h: 80 }, cam, VW, VH), null);
});

test('det man ritar är det man får: layout = ritad storlek i skärm-px (heltal), världsrektangeln = den ritade', () => {
  for (const zoom of [1, 0.5, 2, 0.13, 7.5]) {
    const cam: Camera = { cx: 37, cy: -12, zoom };
    const r = { x: 300.4, y: 120.7, w: 640.6, h: 419.3 };
    const req = requestFromDrawn(r, cam, VW, VH);
    assert.ok(req);
    assert.ok(Number.isInteger(req.w) && Number.isInteger(req.h), 'heltal');
    assert.equal(req.w, 641);
    assert.equal(req.h, 419);
    // Världsbredden är exakt den ritade (§10.4: scale = världsbredd / w). Med en enda skala och heltal blir
    // höjden rätt inom en halv layout-px plus breddens avrundning: högst ungefär en skärm-px.
    const tl = worldToScreen(cam, VW, VH, req.x, req.y);
    near(tl.x, r.x, 1e-6, 'x');
    near(tl.y, r.y, 1e-6, 'y');
    near(req.w * req.scale * zoom, r.w, 1e-6, 'bredd');
    assert.ok(Math.abs(req.h * req.scale * zoom - r.h) <= 0.5 * req.scale * zoom + r.h * (0.5 / req.w) + 1e-9, 'höjd');
    assert.ok(Math.abs(req.h * req.scale * zoom - r.h) < 1, 'höjd inom en skärm-px');
    near(req.scale, r.w / zoom / 641, 1e-12);
  }
});

test('layout utanför 240–2400 × 160–1600: skalan justeras så att världsrektangeln blir den ritade', () => {
  const cam: Camera = { cx: 0, cy: 0, zoom: 1 };
  const small = requestFromDrawn({ x: 0, y: 0, w: 130, h: 90 }, cam, VW, VH);
  assert.ok(small);
  assert.ok(small.w >= LIMITS.wMin && small.h >= LIMITS.hMin, `${small.w}×${small.h}`);
  near(small.w * small.scale, 130, 1e-9);
  assert.ok(Math.abs(small.h * small.scale - 90) < small.scale, 'höjden följer med');
  assert.ok(Number.isInteger(small.w) && Number.isInteger(small.h));
  // Mycket stor fyrkant vid zoom 1 (till exempel på en stor skärm): layouten kläms, skalan växer.
  const big = requestFromDrawn({ x: 0, y: 0, w: 3000, h: 1800 }, cam, 4000, 2400);
  assert.ok(big);
  assert.ok(big.w <= LIMITS.wMax && big.h <= LIMITS.hMax, `${big.w}×${big.h}`);
  near(big.w * big.scale, 3000, 1e-9);
  assert.ok(big.scale > 1);
  // Skalan håller sig inom 0,05–20 även vid extrem zoom.
  const far = requestFromDrawn({ x: 0, y: 0, w: 600, h: 400 }, { cx: 0, cy: 0, zoom: 0.05 }, VW, VH);
  assert.ok(far && far.scale <= LIMITS.scaleMax && far.scale >= LIMITS.scaleMin);
});

test('pricken sitter på 45°-punkten av det övre högra hörnets båge', () => {
  const p = dotPointLocal(640, 16);
  near(p.x, 640 - 16 * (1 - Math.SQRT1_2), 1e-12);
  near(p.y, 16 * (1 - Math.SQRT1_2), 1e-12);
});

test('skärmrektangeln för ett fönster', () => {
  const cam: Camera = { cx: 100, cy: 50, zoom: 2 };
  const r = screenRectOfWin({ x: 10, y: 20, w: 300, h: 200, scale: 1.5 }, cam, VW, VH);
  const tl = worldToScreen(cam, VW, VH, 10, 20);
  near(r.x, tl.x);
  near(r.y, tl.y);
  near(r.w, 300 * 1.5 * 2);
  near(r.h, 200 * 1.5 * 2);
});

test('kantmarkörer: null när fönstret syns, annars vid kanten i fönstrets riktning', () => {
  assert.equal(edgeMarker({ x: 100, y: 100, w: 200, h: 100 }, VW, VH), null);
  assert.equal(edgeMarker({ x: -150, y: 100, w: 200, h: 100 }, VW, VH), null, 'delvis synligt');
  const right = edgeMarker({ x: 2000, y: 400, w: 200, h: 100 }, VW, VH);
  assert.ok(right);
  near(right.x, VW - 14, 1e-9);
  assert.ok(right.y > 400 && right.y < 500);
  const up = edgeMarker({ x: 670, y: -900, w: 100, h: 100 }, VW, VH);
  assert.ok(up);
  near(up.y, 14, 1e-9);
  near(up.x, VW / 2, 1e-6);
});

test('topmostAt väljer högst z', () => {
  const a = { id: 'a', z: 1, rect: { x: 0, y: 0, w: 100, h: 100 } };
  const b = { id: 'b', z: 5, rect: { x: 50, y: 50, w: 100, h: 100 } };
  assert.equal(topmostAt([a, b], 75, 75)?.id, 'b');
  assert.equal(topmostAt([a, b], 10, 10)?.id, 'a');
  assert.equal(topmostAt([a, b], 500, 500), null);
});

test('ändra storlek: heltal, gränser, vänster/övre kant flyttar hörnet', () => {
  const start = { x: 100, y: 100, w: 640, h: 420, scale: 2 };
  const e = resizeFrom(start, 'e', 101, 0);
  assert.deepEqual(e, { x: 100, y: 100, w: 691, h: 420 }); // 101 världsenheter / skala 2 = 50,5 → 51 (avrundat)
  const nw = resizeFrom(start, 'nw', 40, 20);
  assert.equal(nw.w, 620);
  assert.equal(nw.h, 410);
  near(nw.x + nw.w * 2, 100 + 640 * 2, 1e-9, 'högerkanten står still');
  near(nw.y + nw.h * 2, 100 + 420 * 2, 1e-9, 'nederkanten står still');
  const tiny = resizeFrom(start, 'se', -5000, -5000);
  assert.equal(tiny.w, LIMITS.wMin);
  assert.equal(tiny.h, LIMITS.hMin);
});

test('⇧+hörn skalar utan omflödning; motsatta hörnet står still', () => {
  const start = { x: 0, y: 0, w: 600, h: 400, scale: 1 };
  const se = scaleFrom(start, 'se', 300, 10);
  near(se.scale, 1.5, 1e-12);
  assert.deepEqual([se.x, se.y], [0, 0]);
  const nw = scaleFrom(start, 'nw', 300, 0);
  near(nw.scale, 0.5, 1e-12);
  near(nw.x + 600 * nw.scale, 600, 1e-9);
  near(nw.y + 400 * nw.scale, 400, 1e-9);
});

test('⌥+nyp skalar fönstret kring markören', () => {
  const win = { x: 100, y: 100, scale: 1 };
  const p = { x: 400, y: 250 };
  const r = scaleAround(win, p.x, p.y, 1.5);
  near(r.scale, 1.5);
  // Punkten i fönstrets egna koordinater är densamma före och efter.
  near((p.x - win.x) / win.scale, (p.x - r.x) / r.scale, 1e-9);
  near((p.y - win.y) / win.scale, (p.y - r.y) / r.scale, 1e-9);
  assert.equal(scaleAround(win, 0, 0, 1e9).scale, LIMITS.scaleMax);
});

test('FE-10: en fyrkant som dras förbi vyns kant kläms till vyn minus DRAW_INSET (prick och grepp syns)', () => {
  assert.equal(DRAW_INSET, 24);
  // Granskningens fall: drag (60,60) → (1520,980) i en vy på 1440×900.
  const r = clampToView({ x: 60, y: 60, w: 1460, h: 920 }, VW, VH);
  assert.deepEqual(r, { x: 60, y: 60, w: VW - DRAW_INSET - 60, h: VH - DRAW_INSET - 60 });
  // Kalibrering: utan klämning hamnar högerkanten (pricken) och nederkanten (greppet) utanför vyn.
  const raw = { x: 60, y: 60, w: 1460, h: 920 };
  assert.ok(raw.x + raw.w > VW && raw.y + raw.h > VH);
  // En fyrkant helt inne i vyn ändras inte.
  assert.deepEqual(clampToView({ x: 300.5, y: 120.25, w: 640, h: 420 }, VW, VH), { x: 300.5, y: 120.25, w: 640, h: 420 });
  // Uppåt-vänster förbi kanten.
  assert.deepEqual(clampToView({ x: -50, y: -10, w: 400, h: 300 }, VW, VH), { x: DRAW_INSET, y: DRAW_INSET, w: 350 - DRAW_INSET, h: 290 - DRAW_INSET });
  // Helt utanför: tom, och blir ingen app.
  const out = clampToView({ x: VW + 10, y: 10, w: 300, h: 300 }, VW, VH);
  assert.equal(out.w, 0);
  assert.equal(requestFromDrawn(out, { cx: 0, cy: 0, zoom: 1 }, VW, VH), null);
});

test('kromens zoner under ett fönster ovanför (§10.5): den största fria delen av en kant, hörn och knappar döljs', () => {
  const strip = { x: 100, y: 90, w: 400, h: 10 }; // övre kanten på ett fönster
  assert.deepEqual(freeStrip(strip, [], 'x'), strip, 'inget ovanför: hela kanten');
  // Ett fönster ovanför täcker kantens mitt: den största delen, till höger, står kvar.
  assert.deepEqual(freeStrip(strip, [{ x: 150, y: 0, w: 100, h: 300 }], 'x'), { x: 250, y: 90, w: 250, h: 10 });
  // Två fönster täcker allt utom 6 px: mindre än 8 px ger ingen zon.
  assert.equal(freeStrip(strip, [{ x: 80, y: 50, w: 200, h: 100 }, { x: 286, y: 50, w: 300, h: 100 }], 'x'), null);
  // Ett fönster som inte når remsan på tvären påverkar den inte.
  assert.deepEqual(freeStrip(strip, [{ x: 150, y: 101, w: 100, h: 50 }], 'x'), strip);
  // Lodrätt: titt-zonen vid högerkanten, delvis under ett fönster nedtill.
  assert.deepEqual(freeStrip({ x: 500, y: 100, w: 24, h: 300 }, [{ x: 480, y: 320, w: 300, h: 200 }], 'y', 20), { x: 500, y: 100, w: 24, h: 220 });
  assert.equal(coveredRect({ x: 0, y: 0, w: 14, h: 14 }, [{ x: 10, y: 10, w: 50, h: 50 }]), true);
  assert.equal(coveredRect({ x: 0, y: 0, w: 10, h: 10 }, [{ x: 10, y: 10, w: 50, h: 50 }]), false, 'kanter som bara möts täcker inte');
  assert.equal(coveredPoint(20, 20, [{ x: 10, y: 10, w: 50, h: 50 }]), true);
  assert.equal(coveredPoint(5, 20, [{ x: 10, y: 10, w: 50, h: 50 }]), false);
});

type Box = { x: number; y: number; w: number; h: number };
/** Ligger rektangeln minst DRAW_INSET in från vyns kanter, som en ritad fyrkant (§10.4)? */
const insideView = (r: Box, view: { w: number; h: number }): boolean =>
  r.x >= DRAW_INSET - 1e-9 && r.y >= DRAW_INSET - 1e-9 && r.x + r.w <= view.w - DRAW_INSET + 1e-9 && r.y + r.h <= view.h - DRAW_INSET + 1e-9;

test('en ny app från fältet (§10.9): mitten när den är fri, annars bredvid appen i fokus eller ett annat fönster utan överlapp, krympt när den inte ryms, och mitten när inget går', () => {
  const view = { w: VW, h: VH };
  const size = { w: 720, h: 460 };
  const centre = { x: 360, y: 250, w: 720, h: 460 };
  const inside = (r: Box, msg: string) => assert.ok(insideView(r, view), `${msg} närmare vyns kant än ${DRAW_INSET} px: ${JSON.stringify(r)}`);
  // Tom yta, eller fönster som inte når mitten: mitten, som förut.
  assert.deepEqual(fieldRect(size, view, null, []), centre);
  assert.deepEqual(fieldRect(size, view, { x: 20, y: 20, w: 300, h: 200 }, [{ x: 1120, y: 600, w: 300, h: 200 }]), centre);

  // Granskningens fall (1440 × 900): det äldre fönstret 157–810 × 233–666 i fokus. Förut hamnade den nya helt över det.
  const old = { x: 157, y: 233, w: 653, h: 433 };
  const r = fieldRect(size, view, old, []);
  assert.equal(overlapArea(r, old), 0, `över det äldre fönstret: ${JSON.stringify(r)}`);
  inside(r, 'granskningens fall');
  assert.deepEqual(r, { x: 157 + 653 + 14, y: 233, w: VW - DRAW_INSET - (157 + 653 + 14), h: 460 }, 'till höger, krympt till platsen');
  // Utan fokus: bredvid fönstret som ligger i mitten.
  assert.deepEqual(fieldRect(size, view, null, [old]), r);

  // Två fältbyggen i rad på tom yta: den första i mitten, den andra bredvid den (krympt, minst 320 × 220).
  const second = fieldRect(size, view, centre, []);
  assert.equal(overlapArea(second, centre), 0, `andra bygget över det första: ${JSON.stringify(second)}`);
  assert.ok(second.w >= 320 && second.h >= 220, JSON.stringify(second));
  inside(second, 'andra bygget');

  // Plats i full storlek bredvid fönstret i fokus: ingen krympning (höger först, som HUD:en, §13).
  const own = { x: 40, y: 220, w: 500, h: 400 };
  assert.deepEqual(fieldRect(size, view, own, []), { x: 40 + 500 + 14, y: 220, w: 720, h: 460 });
  // Fönstret i fokus i nedre halvan (granskningen av rättelsen): bredvid det, men kromen under den nya appen syns.
  // Med HUD:ens 12 px marginal hamnade nederkanten på 888 och knapparna under den utanför bild.
  const low = { x: 40, y: 500, w: 500, h: 300 };
  const lowR = fieldRect(size, view, low, []);
  inside(lowR, 'fönstret i fokus i nedre halvan');
  assert.deepEqual(lowR, { x: 40 + 500 + 14, y: VH - DRAW_INSET - 460, w: 720, h: 460 });
  // Ett annat fönster till höger: bredvid det i full storlek (under det, så långt ned som vyn tillåter) hellre än krympt
  // bredvid appen i fokus.
  const other = { x: 600, y: 100, w: 400, h: 300 };
  const beside = fieldRect(size, view, own, [other]);
  inside(beside, 'under det andra fönstret');
  assert.deepEqual(beside, { x: 600, y: VH - DRAW_INSET - 460, w: 720, h: 460 });
  assert.equal(overlapArea(beside, other) + overlapArea(beside, own), 0);
  // Fullt bredvid appen i fokus och i full storlek överallt (shell-flow-scenen): krympt bredvid ett annat fönster.
  const top = { x: 48, y: 12, w: 720, h: 244 };
  const cube = { x: 48, y: 270, w: 332, h: 300 };
  const notes = { x: 440, y: 260, w: 560, h: 380 };
  const crowded = fieldRect(size, view, top, [cube, notes]);
  assert.deepEqual(crowded, { x: 440 + 560 + 14, y: 260, w: VW - DRAW_INSET - (440 + 560 + 14), h: 460 });
  for (const o of [top, cube, notes]) assert.equal(overlapArea(crowded, o), 0, JSON.stringify(o));
  // En öppen HUD till höger om fönstret räknas som ett hinder.
  const hud = { x: 540, y: 220, w: 388, h: 320 };
  const notHud = fieldRect(size, view, own, [], [hud]);
  assert.equal(overlapArea(notHud, hud) + overlapArea(notHud, own), 0, JSON.stringify(notHud));
  inside(notHud, 'bredvid HUD:en');
  // Utan fokus, och bara en HUD över mitten (fönstret till vänster om den når inte dit): bredvid fönstret närmast mitten.
  // Förut blev det mitten, över HUD:en.
  const lone = { x: 20, y: 300, w: 300, h: 200 };
  const loneHud = { x: 320, y: 300, w: 388, h: 320 };
  const noFocus = fieldRect(size, view, null, [lone], [loneHud]);
  assert.equal(overlapArea(noFocus, loneHud) + overlapArea(noFocus, lone), 0, `över HUD:en eller fönstret: ${JSON.stringify(noFocus)}`);
  inside(noFocus, 'utan fokus');

  // Ingen plats någonstans (litet fönster i vyn nästan helt täckt): mitten, som förut.
  const small = { w: 800, h: 600 };
  const sz = { w: 600, h: 340 };
  assert.deepEqual(fieldRect(sz, small, { x: 50, y: 50, w: 700, h: 500 }, []), { x: 100, y: 160, w: 600, h: 340 });
});

/**
 * Syns det äldre fönstret o som ett eget fönster bredvid en ny app på r? Dess prick (4 px in från det övre högra hörnet)
 * ligger inte under appen, eller dess grepp (12,5 px under nederkanten, mitt under) varken ligger under appen eller under
 * appens eget grepp (träffytan 72 × 24 px).
 */
const stillSeen = (r: Box, o: Box): boolean => {
  const under = (x: number, y: number) => x > r.x && x < r.x + r.w && y > r.y && y < r.y + r.h;
  if (!under(o.x + o.w - 4, o.y + 4)) return true;
  const g = { x: o.x + o.w / 2, y: o.y + o.h + 12.5 };
  return !under(g.x, g.y) && !(Math.abs(r.x + r.w / 2 - g.x) < 72 && Math.abs(r.y + r.h + 12.5 - g.y) < 24);
};

test('en ny app från fältet när vyn är full: aldrig ovanpå ett äldre fönster, utan ett trappsteg upp åt vänster, så att dess prick och grepp syns (QA 17 oktober: det fjärde bygget fick det första fönstrets rektangel)', () => {
  const view = { w: VW, h: VH };
  const size = { w: 720, h: 460 };
  // Fältbyggen i rad på tom yta, som QA:s körning: den nya appen är i fokus, inga HUD:ar är öppna.
  const wins: Box[] = [];
  for (let i = 0; i < 10; i++) {
    const r = fieldRect(size, view, wins.at(-1) ?? null, wins.slice(0, -1));
    assert.ok(insideView(r, view), `bygge ${i + 1} närmare vyns kant än ${DRAW_INSET} px: ${JSON.stringify(r)}`);
    for (const o of wins) assert.ok(stillSeen(r, o), `bygge ${i + 1} ${JSON.stringify(r)} döljer ${JSON.stringify(o)}`);
    wins.push(r);
  }
  // De tre första som förut: mitten, och krympta till höger och vänster om den. Den fjärde ett steg upp åt vänster
  // från mitten (förut exakt mitten, alltså det första fönstret).
  assert.deepEqual(wins.slice(0, 4), [
    { x: 360, y: 250, w: 720, h: 460 },
    { x: 1094, y: 250, w: VW - DRAW_INSET - 1094, h: 460 },
    { x: DRAW_INSET, y: 250, w: 360 - 14 - DRAW_INSET, h: 460 },
    { x: 360 - CASCADE, y: 250 - CASCADE, w: 720, h: 460 },
  ]);
  // Ett fönster med en annan storlek på samma plats, helt inne i den nya appen: inte heller det döljs.
  const small = { x: 400, y: 300, w: 300, h: 200 };
  const over = fieldRect(size, view, small, [{ x: 20, y: 20, w: 1400, h: 200 }, { x: 20, y: 640, w: 1400, h: 240 }]);
  assert.ok(stillSeen(over, small), JSON.stringify(over));
});

test('en ny app från fältet i slumpade scener: alltid DRAW_INSET in från vyns kanter, mer överlapp än den gamla platsen mitt i vyn bara för att inte dölja ett fönster som mitten döljer, och aldrig ett fönster dolt som mitten inte döljer', () => {
  let seed = 7;
  let hidden = 0;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  for (let i = 0; i < 2000; i++) {
    const view = { w: 900 + Math.round(rnd() * 900), h: 620 + Math.round(rnd() * 500) };
    const size = { w: Math.max(320, Math.min(720, view.w - 200)), h: Math.max(220, Math.min(460, view.h - 260)) };
    const wins: Box[] = [];
    for (let k = Math.floor(rnd() * 4); k > 0; k--) {
      const w = 200 + Math.round(rnd() * 600);
      const h = 150 + Math.round(rnd() * 400);
      wins.push({ x: Math.round(rnd() * (view.w - w)), y: Math.round(rnd() * (view.h - h)), w, h });
    }
    const focused = wins.length && rnd() < 0.7 ? wins[0] : null;
    // Öppna HUD:ar som createFromField räknar dem: en remsa till höger om fönstret.
    const huds = wins.filter(() => rnd() < 0.3).map((o) => ({ x: o.x + o.w, y: o.y, w: 388, h: Math.min(320, 0.4 * view.h) }));
    const r = fieldRect(size, view, focused, focused ? wins.slice(1) : wins, huds);
    // Kostnaden som fieldRect väger: överlapp med fönster, och med HUD:ar dubbelt (§13).
    const cost = (q: Box) => wins.reduce((c, o) => c + overlapArea(q, o), 0) + huds.reduce((c, o) => c + HUD_WEIGHT * overlapArea(q, o), 0);
    const centre = { x: (view.w - size.w) / 2, y: (view.h - size.h) / 2 + 30, ...size };
    const scene = JSON.stringify({ view, focused, wins, huds, r });
    const hides = (q: Box) => !wins.every((o) => stillSeen(q, o));
    assert.ok(insideView(r, view), `närmare vyns kant än ${DRAW_INSET} px: ${scene}`);
    assert.ok(cost(r) <= cost(centre) + 1e-6 || (hides(centre) && !hides(r)), `mer överlapp än mitten (${cost(r)} mot ${cost(centre)}): ${scene}`);
    assert.ok(!hides(r) || hides(centre), `döljer ett fönster som mitten inte döljer: ${scene}`);
    assert.ok(r.w >= 320 && r.h >= 220 && r.w <= size.w && r.h <= size.h, scene);
    if (hides(r)) hidden++;
  }
  // Bara där inget trappsteg och inte heller mitten låter alla fönster synas (4 av 2 000). Fälldes av platsen före
  // trappsteget, som dolde ett fönster i 139 scener, i 17 av dem ett som mitten inte döljer.
  assert.ok(hidden <= 10, `ett fönster doldes i ${hidden} scener`);
});
