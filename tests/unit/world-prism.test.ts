// world-prism.test.ts — prismornas matematik (CONTRACT §10.5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PEEK_DEG, SwipeRotor, angleForFace, angleToFace, apothem, cameraMatrix, faceToScreen, frontFace, peekDeg, perspectiveFor, rotTransform, faceTransform,
} from '../../web/src/world/prism.ts';
import type { PrismPose } from '../../web/src/world/prism.ts';
import { chain, perspective, project, rotateX, rotateY, translate3 } from '../../web/src/world/math.ts';

const near = (a: number, b: number, eps = 1e-9, msg = ''): void => assert.ok(Math.abs(a - b) <= eps, `${msg} ${a} ≠ ${b} (±${eps})`);

test('apotemet a = W/(2·tan(π/n)); kort med baksida har 0', () => {
  assert.equal(apothem(640, 2), 0);
  near(apothem(640, 4), 320, 1e-9);
  near(apothem(600, 3), 600 / (2 * Math.tan(Math.PI / 3)), 1e-12);
  near(apothem(600, 6), 600 * Math.sqrt(3) / 2, 1e-9);
});

test('CSS-matriserna: rotateY(90°) skickar högerkanten bort från betraktaren, perspektivet förminskar det som är längre bort', () => {
  const p = project(rotateY(90), 1, 0, 0);
  near(p.x, 0, 1e-12);
  const m = rotateY(90);
  // z' = −x·sin = −1 (bort).
  near(m[8] * 1 + m[9] * 0 + m[10] * 0 + m[11], -1, 1e-12);
  const far = project(perspective(1000), 100, 0, -1000);
  near(far.x, 50, 1e-9);
  const xr = rotateX(90);
  // rotateX(90°): en punkt nedåt (y = 1) går mot betraktaren (z = +1) i CSS.
  near(xr[8] * 0 + xr[9] * 1 + xr[10] * 0, 1, 1e-12);
});

function pose(over: Partial<PrismPose> = {}): PrismPose {
  return { x: 100, y: 50, W: 640, H: 420, scale: 1, n: 3, theta: 0, flat: false, ...over };
}

test('i 3D men i vila hamnar framsidan exakt där den platta sidan ligger (tillplattningen är pixelidentisk)', () => {
  const cam = cameraMatrix(1.7, -40, 33);
  for (const n of [2, 3, 4, 6]) {
    for (let i = 0; i < n; i++) {
      const p3 = pose({ n, theta: angleForFace(i, n), W: 640 * 1.25, H: 420 * 1.25, scale: 1.25 });
      const flat = { ...p3, flat: true };
      for (const [lx, ly] of [[0, 0], [640, 0], [320, 210], [640, 420], [12.5, 400.25]]) {
        const a = faceToScreen(cam, p3, i, lx, ly);
        const b = faceToScreen(cam, flat, i, lx, ly);
        near(a.x, b.x, 1e-6, `n=${n} i=${i} (${lx},${ly}) x`);
        near(a.y, b.y, 1e-6, `n=${n} i=${i} (${lx},${ly}) y`);
      }
    }
  }
});

test('flat projektion = fönstrets 2D-transform och kameran', () => {
  const cam = cameraMatrix(2, 10, 20);
  const p = faceToScreen(cam, pose({ flat: true, scale: 1.5, W: 960, H: 630 }), 0, 100, 40);
  near(p.x, (100 + 100 * 1.5) * 2 + 10, 1e-9);
  near(p.y, (50 + 40 * 1.5) * 2 + 20, 1e-9);
});

test('mitt i en vridning: framsidans kant räknas exakt som CSS-kedjan (oberoende uträkning)', () => {
  // Kort (n = 2, a = 0), vridet 30°: punkten (W, H/2) på sida 0, utan kamera.
  const W = 640;
  const H = 420;
  const P = perspectiveFor(W);
  const p = faceToScreen(cameraMatrix(1, 0, 0), pose({ x: 0, y: 0, n: 2, theta: 30, W, H }), 0, W, H / 2);
  // Oberoende: punkten relativt mitten (W/2, 0, 0) vrids 30° kring y, z = −(W/2)·sin 30°, och projiceras.
  const rx = (W / 2) * Math.cos(Math.PI / 6);
  const rz = -(W / 2) * Math.sin(Math.PI / 6);
  const k = 1 / (1 - rz / P);
  near(p.x, W / 2 + rx * k, 1e-6);
  near(p.y, H / 2, 1e-6);
  // Och kedjan är densamma som en hand-komponerad matris.
  const m = chain(translate3(W / 2, H / 2), perspective(P), translate3(-W / 2, -H / 2), translate3(W / 2, H / 2), rotateY(30), translate3(-W / 2, -H / 2));
  const q = project(m, W, H / 2);
  near(p.x, q.x, 1e-9);
});

test('framsidan: den vars normal pekar mest mot betraktaren', () => {
  assert.equal(frontFace(0, 3), 0);
  assert.equal(frontFace(-120, 3), 1);
  assert.equal(frontFace(-240, 3), 2);
  assert.equal(frontFace(-50, 3), 0);
  assert.equal(frontFace(-70, 3), 1);
  assert.equal(frontFace(-180, 2), 1);
});

test('vinkeln till en sida: kortaste vägen, och ⌃⌥←/→ alltid ett steg åt rätt håll, även runt varvet', () => {
  near(angleToFace(0, 1, 3, 0), -120);
  near(angleToFace(0, 2, 3, 0), 120, 1e-9); // −240 ≡ 120, kortare
  // Nästa sida (⌃⌥→): minskande vinkel.
  near(angleToFace(-240, 0, 3, -1), -360);
  near(angleToFace(0, 1, 3, -1), -120);
  // Föregående (⌃⌥←): ökande vinkel.
  near(angleToFace(0, 2, 3, 1), 120);
  near(angleToFace(-120, 0, 3, 1), 0);
  // Kort med baksida.
  near(angleToFace(0, 1, 2, -1), -180);
  near(angleToFace(-180, 0, 2, -1), -360);
  near(angleToFace(0, 1, 2, 1), 180);
});

test('DOM-transformerna använder samma tal', () => {
  assert.equal(faceTransform(640, 4, 1), 'rotateY(90.0000deg) translateZ(320.000px)');
  assert.equal(rotTransform({ W: 640, n: 4, theta: -90 }), 'translateZ(-320.000px) rotateY(-90.0000deg)');
});

test('⌥-svepet: litet svep går tillbaka, långt går en sida, snabb flick går en sida, högst en sida per gest', () => {
  const st = 120;
  const slow = new SwipeRotor(3);
  slow.begin(0);
  for (let t = 0; t < 200; t += 16) slow.move(4, t); // 0,35°/px · 4 px = 1,4° per steg, långsamt
  assert.equal(slow.release(), slow.angle < -st / 2 ? -st : 0);

  const short = new SwipeRotor(3);
  short.begin(0);
  for (let t = 0; t < 160; t += 40) short.move(2, t);
  assert.equal(short.release(), 0);

  const long = new SwipeRotor(3);
  long.begin(0);
  for (let t = 0; t < 2000; t += 50) long.move(12, t);
  assert.equal(long.angle, -st, 'kläms till en sida');
  assert.equal(long.release(), -st);

  const flick = new SwipeRotor(3);
  flick.begin(0);
  flick.move(20, 0);
  flick.move(30, 8);
  flick.move(40, 16);
  assert.ok(Math.abs(flick.angle) < st / 2, 'kort men snabbt');
  assert.equal(flick.release(), -st);

  const back = new SwipeRotor(3);
  back.begin(-120);
  for (let t = 0; t < 2000; t += 50) back.move(-12, t);
  assert.equal(back.release(), 0, 'åt andra hållet från sida 1');
});

test('K3: titten mot höger kant visar nästa sida, även på en tresidig prisma', () => {
  // Vänd mot betraktaren = positiv area för hörnen (0,0), (w,0), (0,h) på skärmen (samma test som pricken).
  const facing = (n: number, theta: number, i: number): boolean => {
    const W = 420;
    const H = 300;
    const p: PrismPose = { x: 0, y: 0, W, H, scale: 1, n, theta, flat: false };
    const cam = cameraMatrix(1, 720, 450);
    const a = faceToScreen(cam, p, i, 0, 0);
    const b = faceToScreen(cam, p, i, W, 0);
    const c = faceToScreen(cam, p, i, 0, H);
    return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x) > 0;
  };
  // Kalibrering: kontraktets 16° räcker på en kub men aldrig på en tresidig prisma (grannsidan vid 120°).
  assert.equal(facing(4, -PEEK_DEG, 1), true);
  assert.equal(facing(3, -PEEK_DEG, 1), false);
  // Med peekDeg vetter grannsidan mot betraktaren för alla n ≥ 3.
  for (const n of [3, 4, 5, 6, 8]) assert.equal(facing(n, -peekDeg(n), 1), true, `n = ${n}`);
  assert.equal(peekDeg(4), PEEK_DEG);
  assert.equal(peekDeg(2), PEEK_DEG);
});
