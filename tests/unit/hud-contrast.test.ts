// hud-contrast.test.ts — §14: all text i HUD:en ska ha minst 4,5:1, mätt mot grå yta, vit app och mörk app
// bakom glaset. Räknas här ur de riktiga CSS-filerna (tokens.css + hud.css) med WCAG-formeln, vid gradientens
// ljusaste och mörkaste punkt. Glaset släpper igenom bakgrunden, så varje term i --wb-hud-blur som ändrar färgen
// (saturate(), brightness()) läggs på bakgrunden i CSS-ordning innan tonen läggs ovanpå; blur() ändrar inte en
// jämn yta. Formeln kalibreras mot kända par och brightness() mot pixlar uppmätta i Chrome. Två planterade läckor
// måste fällas: den första, ljusare gradienten och dagens ton utan brightness(). Sist kantmarkörerna, som ligger på ytan.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

type RGBA = [number, number, number, number];
type RGB = [number, number, number];

const root = path.resolve(import.meta.dirname, '../..');
const tokensCss = fs.readFileSync(path.join(root, 'web/src/styles/tokens.css'), 'utf8');
const hudCss = fs.readFileSync(path.join(root, 'web/src/hud/hud.css'), 'utf8');

function cssVar(css: string, name: string): string {
  const m = new RegExp(`${name}\\s*:\\s*([^;]+);`).exec(css);
  if (!m) throw new Error(`saknar ${name}`);
  return m[1].trim();
}

/** #rrggbb, rgb(r g b / a), rgb(r, g, b), rgba(r, g, b, a). */
function color(s: string): RGBA {
  s = s.trim();
  const hex = /^#([0-9a-f]{6})$/i.exec(s);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  const m = /^rgba?\(([^)]+)\)$/i.exec(s);
  if (!m) throw new Error(`okänd färg ${s}`);
  const parts = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
  return [parts[0], parts[1], parts[2], parts.length > 3 ? parts[3] : 1];
}

/** De två färgstoppen i en linear-gradient(…). */
function stops(gradient: string): [RGBA, RGBA] {
  const cs = [...gradient.matchAll(/rgba?\([^)]+\)|#[0-9a-f]{6}/gi)].map((m) => color(m[0]));
  assert.equal(cs.length, 2, gradient);
  return [cs[0], cs[1]];
}

const lin = (c: number) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const enc = (v: number) => 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
const lum = ([r, g, b]: RGB) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const ratio = (a: RGB, b: RGB) => {
  const x = lum(a);
  const y = lum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
const over = ([r, g, b, a]: RGBA, [R, G, B]: RGB): RGB => [r * a + R * (1 - a), g * a + G * (1 - a), b * a + B * (1 - a)];
const clamp = (v: number) => Math.max(0, Math.min(255, v));

/** CSS saturate() (Filter Effects, sRGB). Grå påverkas inte, färgade appar kan bli mättare bakom glaset. */
function saturate([r, g, b]: RGB, s: number): RGB {
  return [
    clamp((0.213 + 0.787 * s) * r + (0.715 - 0.715 * s) * g + (0.072 - 0.072 * s) * b),
    clamp((0.213 - 0.213 * s) * r + (0.715 + 0.285 * s) * g + (0.072 - 0.072 * s) * b),
    clamp((0.213 - 0.213 * s) * r + (0.715 - 0.715 * s) * g + (0.072 + 0.928 * s) * b),
  ];
}

/** CSS brightness() som Chrome räknar den: de gammakodade sRGB-värdena gånger k (uppmätt, se kalibreringen). */
function brightness([r, g, b]: RGB, k: number): RGB {
  return [clamp(r * k), clamp(g * k), clamp(b * k)];
}

/** Samma i linjärt ljus: hypotesen som kalibreringen mot Chrome ska utesluta. */
function brightnessLinear([r, g, b]: RGB, k: number): RGB {
  return [clamp(enc(lin(r) * k)), clamp(enc(lin(g) * k)), clamp(enc(lin(b) * k))];
}

type Filter = ['saturate' | 'brightness', number];

/** Termerna i ett backdrop-filter som ändrar färgen, i CSS-ordning. En okänd term fäller testet: modellera den först. */
function colourFilters(filter: string): Filter[] {
  const out: Filter[] = [];
  for (const [, fn, arg] of filter.matchAll(/([a-z-]+)\(\s*([^)]*?)\s*\)/gi)) {
    if (fn === 'blur') continue;
    if (fn !== 'saturate' && fn !== 'brightness') throw new Error(`${fn}() i --wb-hud-blur ändrar färgen men modelleras inte här`);
    out.push([fn, arg.endsWith('%') ? parseFloat(arg) / 100 : parseFloat(arg)]);
  }
  return out;
}

/** Glaset vid gradientens läge t (0 = topp, 1 = botten): bakgrunden genom filtret, tonen ovanpå. CSS interpolerar
    gradienten med förmultiplicerad alfa (vid t = 0 och 1 är det bara stoppen). */
function glass(back: RGB, t: number, gradient: string, filter: string, bright = brightness): RGB {
  const [top, bottom] = stops(gradient);
  const a = top[3] + (bottom[3] - top[3]) * t;
  const f = colourFilters(filter).reduce<RGB>((c, [fn, v]) => (fn === 'saturate' ? saturate(c, v) : bright(c, v)), back);
  return [0, 1, 2].map((i) => top[i] * top[3] + (bottom[i] * bottom[3] - top[i] * top[3]) * t + (1 - a) * f[i]) as RGB;
}

const HUD_BG = cssVar(tokensCss, '--wb-hud-bg');
const HUD_BLUR = cssVar(tokensCss, '--wb-hud-blur');
const BACKDROPS: Record<string, RGB> = {
  'grå yta (mitt)': color(cssVar(tokensCss, '--wb-canvas-center')).slice(0, 3) as RGB,
  'grå yta (kant)': color(cssVar(tokensCss, '--wb-canvas-edge')).slice(0, 3) as RGB,
  'vit app': [255, 255, 255],
  'mörk app': [22, 24, 29],
};

/** Varje textfärg på sin yta, för en given panelbakgrund och ett givet filter, vid gradientens topp och botten. */
function pairs(bgGradient: string, filter = HUD_BLUR): Array<{ name: string; backdrop: string; t: number; ratio: number }> {
  const text = color(cssVar(tokensCss, '--wb-hud-text'));
  const user = color(cssVar(tokensCss, '--wb-hud-user'));
  const muted = color(cssVar(tokensCss, '--wb-hud-muted'));
  const error = color(cssVar(tokensCss, '--wb-hud-error'));
  const card = color(cssVar(tokensCss, '--wb-hud-card'));
  const composer = color(cssVar(tokensCss, '--wb-hud-composer'));
  const detail = color(cssVar(hudCss, '--wbh-detail'));
  const out: Array<{ name: string; backdrop: string; t: number; ratio: number }> = [];
  for (const [bname, back] of Object.entries(BACKDROPS)) {
    for (const t of [0, 1]) {
      const bg = glass(back, t, bgGradient, filter);
      const cardBg = over(card, bg);
      const capsule = over(composer, bg);
      const add = (name: string, fg: RGBA, under: RGB) => out.push({ name, backdrop: bname, t, ratio: ratio(over(fg, under), under) });
      add('Claudes svar (vit)', text, bg);
      add('användarens rader', user, bg);
      add('aktivitetsraden, notiser', muted, bg);
      add('turfel', error, bg);
      add('kortets titel och knappar', text, cardBg);
      add('kortets detalj', detail, cardBg);
      add('inmatningens text', text, capsule);
    }
  }
  return out;
}

test('kalibrering: WCAG-formeln ger de kända värdena', () => {
  assert.equal(ratio([118, 118, 118], [255, 255, 255]).toFixed(2), '4.54');
  assert.equal(ratio([0, 0, 0], [255, 255, 255]).toFixed(0), '21');
  assert.equal(ratio([255, 255, 255], [0, 0, 255]).toFixed(2), '8.59');
  assert.deepEqual(saturate([176, 176, 176], 1.6).map(Math.round), [176, 176, 176], 'grått ändras inte av saturate');
  assert.deepEqual(colourFilters('blur(28px) saturate(2) brightness(45%)'), [['saturate', 2], ['brightness', 0.45]]);
  assert.throws(() => colourFilters('blur(28px) contrast(1.2)'), /contrast/, 'en omodellerad färgterm ska fälla testet');
});

// Uppmätt i riktig Chrome (playwright-core, channel 'chrome', DSF 2): HUD:en
// öppen över en app, all text genomskinlig, medianen av 12 × 12 enhetspixlar i panelens mitt (t = 0,5 på
// gradientlinjen). Tokens står med eftersom kalibreringen gäller funktionerna, inte dagens tokens.
const CHROME = {
  bg: 'linear-gradient(170deg, rgba(14, 64, 236, 0.46) 0%, rgba(10, 46, 200, 0.5) 100%)',
  blur: 'blur(28px) saturate(2) brightness(0.45)',
  samples: [
    { backdrop: 'helt vit app', back: [255, 255, 255] as RGB, t: 0.502, px: [66, 86, 164] as RGB },
    { backdrop: 'planterad #16181d', back: [22, 24, 29] as RGB, t: 0.502, px: [11, 32, 112] as RGB },
  ],
};

test('kalibrering: brightness() räknas som i Chrome (uppmätta pixlar bakom glaset)', () => {
  for (const s of CHROME.samples) {
    const model = glass(s.back, s.t, CHROME.bg, CHROME.blur);
    const off = Math.max(...model.map((v, i) => Math.abs(v - s.px[i])));
    assert.ok(off <= 3, `${s.backdrop}: modellen ${model.map((v) => v.toFixed(1))} mot uppmätt ${s.px}`);
  }
  // Samma pixel utesluter brightness() i linjärt ljus: den hypotesen ger en mycket ljusare panel över vitt.
  const white = CHROME.samples[0];
  const linear = glass(white.back, white.t, CHROME.bg, CHROME.blur, brightnessLinear);
  assert.ok(Math.min(...linear.map((v, i) => v - white.px[i])) > 15, `linjärt ljus gav ${linear.map((v) => v.toFixed(1))}`);
});

test('all HUD-text har minst 4,5:1 över grå yta, vit app och mörk app (tokens.css)', () => {
  const all = pairs(HUD_BG);
  const failing = all.filter((p) => p.ratio < 4.5);
  assert.deepEqual(failing, [], JSON.stringify(failing, null, 1));
  const worst = all.reduce((a, b) => (b.ratio < a.ratio ? b : a));
  assert.ok(worst.ratio >= 4.5, `${worst.name} ${worst.ratio}`);
});

/* Användarens rad för ett meddelande som aldrig kördes (§13, §14): dämpad, men den ska fortfarande läsas. Minst 4,5:1
   över grå yta och mörk app, och minst 3:1 över en vit app (WCAG:s golv för stor text och kontroller), även i en lugn HUD. */

/** Den dämpade radens kontrast för en given färg: värsta fallet över vit app, och utan vit app. */
function droppedRatios(c: RGBA): { white: number; others: number } {
  let white = Infinity;
  let others = Infinity;
  for (const [bname, back] of Object.entries(BACKDROPS)) {
    for (const t of [0, 1]) {
      for (const bg of [glass(back, t, HUD_BG, HUD_BLUR), calmGlass(back, t)]) {
        const r = ratio(over(c, bg), bg);
        if (bname === 'vit app') white = Math.min(white, r);
        else others = Math.min(others, r);
      }
    }
  }
  return { white, others };
}

/** Läsbar men synligt dämpad: minst 3:1 respektive 4,5:1, och minst 0,12 svagare än användarens vanliga rader. */
function droppedOk(c: RGBA): boolean {
  const r = droppedRatios(c);
  return r.white >= 3 && r.others >= 4.5 && color(cssVar(tokensCss, '--wb-hud-user'))[3] - c[3] >= 0.12;
}

test('en användarrad som aldrig kördes är dämpad men läsbar: minst 3:1 över en vit app, 4,5:1 annars (kalibrerat åt båda hållen)', () => {
  const dropped = color(cssVar(hudCss, '--wbh-dropped'));
  assert.match(hudCss, /\.wbh-user\.is-dropped\s*\{[^}]*color:\s*var\(--wbh-dropped\)/, 'raden använder färgen');
  const r = droppedRatios(dropped);
  assert.ok(droppedOk(dropped), `vit app ${r.white.toFixed(2)}, annars ${r.others.toFixed(2)}`);
  // Kalibrering: för svag (45 % vitt) fälls av läsbarheten, och odämpad (radernas egen färg) av dämpningen.
  assert.ok(!droppedOk([255, 255, 255, 0.45]), 'för svag ska fällas');
  assert.ok(droppedRatios([255, 255, 255, 0.45]).white < 3);
  assert.ok(!droppedOk(color(cssVar(tokensCss, '--wb-hud-user'))), 'en odämpad rad ska fällas');
});

test('text på vitt (primärknappar, valda alternativ, Ta bort) har minst 4,5:1', () => {
  for (const name of ['--wbh-ink', '--wbh-danger']) {
    const c = color(cssVar(hudCss, name));
    assert.ok(ratio(over(c, [255, 255, 255]), [255, 255, 255]) >= 4.5, name);
  }
});

// Den första, ljusare gradienten (före kontrastmätningen). Testet ovan måste kunna fällas av den.
const FIRST_HUD_BG = 'linear-gradient(170deg, rgba(36, 86, 240, 0.96) 0%, rgba(26, 63, 208, 0.97) 100%)';

test('planterad läcka: med den första, ljusare gradienten fälls de dämpade färgerna', () => {
  const failing = pairs(FIRST_HUD_BG).filter((p) => p.ratio < 4.5);
  const names = new Set(failing.map((f) => f.name));
  assert.ok(names.has('användarens rader'), 'testet måste kunna fällas');
  assert.ok(names.has('aktivitetsraden, notiser'));
  // Värsta fallet, för rapporten: gradientens topp över en vit app.
  const worst = failing.filter((f) => f.backdrop === 'vit app' && f.t === 0).map((f) => `${f.name} ${f.ratio.toFixed(2)}`);
  assert.ok(worst.length >= 3, worst.join(', '));
});

test('planterad läcka: dagens ton utan brightness() fälls över en vit app', () => {
  const unlit = HUD_BLUR.replace(/\s*brightness\([^)]*\)/, '');
  assert.notEqual(unlit, HUD_BLUR, '--wb-hud-blur ska mörka bakgrunden med brightness()');
  const failing = pairs(HUD_BG, unlit).filter((p) => p.ratio < 4.5 && p.backdrop === 'vit app');
  const names = new Set(failing.map((f) => f.name));
  for (const name of ['Claudes svar (vit)', 'användarens rader', 'aktivitetsraden, notiser', 'kortets detalj', 'inmatningens text']) {
    assert.ok(names.has(name), `${name} ska fällas utan brightness()`);
  }
});

/* ⋯-knappen i vila: en kontroll, så WCAG 1.4.11 kräver minst 3:1 mot kapseln den sitter i. */

function moreRestAlpha(css: string): number {
  const m = /\.wbh:not\(:hover\) \.wbh-more[^{]*\{\s*color:\s*(rgb\([^)]+\))/.exec(css);
  if (!m) throw new Error('saknar ⋯-knappens vilofärg');
  return color(m[1])[3];
}

/** ⋯-glyfens kontrast i vila, mot kapseln och (tom panel) direkt mot glaset, för en given alfa. */
function moreRatios(alpha: number): Array<{ backdrop: string; t: number; on: string; ratio: number }> {
  const composer = color(cssVar(tokensCss, '--wb-hud-composer'));
  const glyph: RGBA = [255, 255, 255, alpha];
  const out: Array<{ backdrop: string; t: number; on: string; ratio: number }> = [];
  for (const [bname, back] of Object.entries(BACKDROPS)) {
    for (const t of [0, 1]) {
      const bg = glass(back, t, HUD_BG, HUD_BLUR);
      const capsule = over(composer, bg);
      out.push({ backdrop: bname, t, on: 'kapseln', ratio: ratio(over(glyph, capsule), capsule) });
      out.push({ backdrop: bname, t, on: 'glaset', ratio: ratio(over(glyph, bg), bg) });
    }
  }
  return out;
}

test('⋯-knappen i vila har minst 3:1 (kalibrerat: den förra vilofärgen 0,42 fälls)', () => {
  const failing = moreRatios(moreRestAlpha(hudCss)).filter((p) => p.ratio < 3);
  assert.deepEqual(failing, [], JSON.stringify(failing, null, 1));
  // Planterad läcka: den förra vilofärgen gav uppmätt 2,65:1 i Chrome (pixlar på kapseln).
  const old = moreRatios(0.42).filter((p) => p.on === 'kapseln');
  const worstOld = Math.min(...old.map((p) => p.ratio));
  assert.ok(worstOld < 3, `0,42 ska fällas, gav ${worstOld.toFixed(2)}`);
  // Mätt pixel ur skärmbilden (139,154,208) på kapseln (55,79,172): formeln ger samma 2,65 som rapporten.
  assert.equal(ratio([139, 154, 208], [55, 79, 172]).toFixed(2), '2.65');
});

/* En HUD som inte är aktiv (§14): en mörk slöja (--wbh-calm-veil i hud.css) över glaset, inmatningen utan kapsel och
   mikrofonen och stoppknappen i ⋯-knappens vilofärg. Textens färger ändras aldrig, så kontrasten får bara bli bättre.
   Planterad läcka: den naiva lösningen, opacity 0,86 på hela panelen, släpper igenom appen ofiltrerad och fälls. */

const CALM_VEIL = color(cssVar(hudCss, '--wbh-calm-veil'));

/** Den lugna panelens yta: slöjan över glaset. */
const calmGlass = (back: RGB, t: number): RGB => over(CALM_VEIL, glass(back, t, HUD_BG, HUD_BLUR));

/** Varje textfärg i en lugn HUD (inmatningen utan kapsel), eller med en planterad dämpning. */
function calmPairs(plant: 'none' | 'panel-opacity' = 'none'): Array<{ name: string; backdrop: string; t: number; ratio: number }> {
  const text = color(cssVar(tokensCss, '--wb-hud-text'));
  const user = color(cssVar(tokensCss, '--wb-hud-user'));
  const muted = color(cssVar(tokensCss, '--wb-hud-muted'));
  const error = color(cssVar(tokensCss, '--wb-hud-error'));
  const card = color(cssVar(tokensCss, '--wb-hud-card'));
  const detail = color(cssVar(hudCss, '--wbh-detail'));
  const out: Array<{ name: string; backdrop: string; t: number; ratio: number }> = [];
  for (const [bname, back] of Object.entries(BACKDROPS)) {
    for (const t of [0, 1]) {
      // Planterat: opacity på panelen i stället för slöjan. Panelen (glas och text) blandas då med appen bakom.
      const k = plant === 'panel-opacity' ? 0.86 : 1;
      const bg0 = plant === 'panel-opacity' ? glass(back, t, HUD_BG, HUD_BLUR) : calmGlass(back, t);
      const mix = (c: RGB): RGB => [0, 1, 2].map((i) => c[i] * k + back[i] * (1 - k)) as RGB;
      const add = (name: string, fg: RGBA, under: RGB) => out.push({ name, backdrop: bname, t, ratio: ratio(mix(over(fg, under)), mix(under)) });
      const cardBg = over(card, bg0);
      add('Claudes svar (vit)', text, bg0);
      add('användarens rader', user, bg0);
      add('aktivitetsraden, notiser', muted, bg0);
      add('turfel', error, bg0);
      add('kortets titel och knappar', text, cardBg);
      add('kortets detalj', detail, cardBg);
      add('inmatningens text', text, bg0);
    }
  }
  return out;
}

test('en HUD som inte är aktiv: all text har minst 4,5:1 (slöjan gör bara bakgrunden mörkare)', () => {
  const all = calmPairs();
  const failing = all.filter((p) => p.ratio < 4.5);
  assert.deepEqual(failing, [], JSON.stringify(failing, null, 1));
  // Slöjan mörkar: varje par är minst lika bra som i den aktiva panelen.
  const active = pairs(HUD_BG).filter((p) => p.name !== 'inmatningens text');
  for (const a of active) {
    const c = all.find((p) => p.name === a.name && p.backdrop === a.backdrop && p.t === a.t)!;
    assert.ok(c.ratio >= a.ratio - 1e-9, `${a.name} över ${a.backdrop}: ${c.ratio.toFixed(2)} < ${a.ratio.toFixed(2)}`);
  }
});

test('planterad läcka: opacity 0,86 på en lugn panel fäller användarens rader över en vit app', () => {
  const failing = calmPairs('panel-opacity').filter((p) => p.ratio < 4.5 && p.backdrop === 'vit app');
  const names = new Set(failing.map((f) => f.name));
  assert.ok(names.has('användarens rader'), `ska fällas: ${JSON.stringify(failing.map((f) => `${f.name} ${f.ratio.toFixed(2)}`))}`);
});

test('en HUD som inte är aktiv: mikrofonen och stoppknappen i vila har minst 3:1 mot glaset (kalibrerat: 0,42 fälls)', () => {
  const m = /\.wbh-panel\.is-calm \.wbh-mic[^{]*\{\s*color:\s*(rgb\([^)]+\))/.exec(hudCss);
  assert.ok(m, 'saknar vilofärgen för mikrofonen i en lugn HUD');
  const alpha = color(m[1])[3];
  const worst = (a: number) =>
    Math.min(
      ...Object.values(BACKDROPS).flatMap((back) =>
        [0, 1].map((t) => {
          const bg = calmGlass(back, t);
          return ratio(over([255, 255, 255, a], bg), bg);
        }),
      ),
    );
  assert.ok(worst(alpha) >= 3, `vilofärgen ${alpha} gav ${worst(alpha).toFixed(2)}`);
  assert.ok(worst(0.42) < 3, 'kalibrering: den förra ⋯-färgen 0,42 fälls');
});

/* Kantmarkörerna (§14) ligger direkt på ytan vid vyns kant. De är kontroller, så WCAG 1.4.11 kräver minst 3:1 mot ytan
   där de kan sitta. Ytan räknas som shadern i bg.ts gör den: ett gaussiskt ljusfall från --wb-canvas-center (50 %/36 %)
   mot --wb-canvas-edge, blandat i sRGB. Modellen kalibreras mot pixlar från Chrome, och två planterade fel ska fällas:
   den förra färgen --wb-grip (som prickgridden, bara större) och ren --wb-accent (blå, men lika ljus som ytan). */

const baseCss = fs.readFileSync(path.join(root, 'web/src/styles/base.css'), 'utf8');

/** Ytan i skärmpunkten (x, y) i en vy vw × vh, som shadern i bg.ts (utan dither och prickgrid). */
function surface(x: number, y: number, vw: number, vh: number): RGB {
  const c = color(cssVar(tokensCss, '--wb-canvas-center'));
  const e = color(cssVar(tokensCss, '--wb-canvas-edge'));
  const d = Math.hypot(vw, vh);
  const qx = (x - 0.5 * vw) / d;
  const qy = (y - 0.36 * vh) / d;
  const light = Math.exp(-(qx * qx + qy * qy) * 3.4);
  return [0, 1, 2].map((i) => e[i] + (c[i] - e[i]) * light) as RGB;
}

/** Ett CSS-färgvärde: en färg, var(--token) eller color-mix(in srgb, <färg> N%, <färg>). Annat fäller testet. */
function cssColour(v: string): RGBA {
  v = v.trim();
  const ref = /^var\((--[\w-]+)\)$/.exec(v);
  if (ref) return cssColour(cssVar(tokensCss, ref[1]));
  const mix = /^color-mix\(in srgb,\s*(.+?)\s+(\d+(?:\.\d+)?)%,\s*(.+)\)$/.exec(v);
  if (mix) {
    const named = (s: string): RGBA => (s === 'black' ? [0, 0, 0, 1] : s === 'white' ? [255, 255, 255, 1] : cssColour(s));
    const [a, k, b] = [named(mix[1]), Number(mix[2]) / 100, named(mix[3])];
    assert.ok(a[3] === 1 && b[3] === 1, `color-mix med genomskinliga färger modelleras inte: ${v}`);
    return [0, 1, 2].map((i) => a[i] * k + b[i] * (1 - k)).concat(1) as RGBA;
  }
  return color(v);
}

/** Kantmarkörens fyllning i base.css (regeln .wb-marker i). */
function markerFill(css: string): string {
  const m = /\.wb-marker i \{[^}]*?\n\s*background:\s*([^;]+);/.exec(css);
  if (!m) throw new Error('saknar kantmarkörens färg i base.css');
  return m[1];
}

/** Sämsta kontrasten mot ytan för en fyllning, längs hela vyns kant (14 px in, där layout.edgeMarker sätter dem). */
function worstAtEdge(fill: RGBA, vw: number, vh: number): { ratio: number; x: number; y: number } {
  let worst = { ratio: Infinity, x: 0, y: 0 };
  const inset = 14;
  const pts: Array<[number, number]> = [];
  for (let x = inset; x <= vw - inset; x += 8) pts.push([x, inset], [x, vh - inset]);
  for (let y = inset; y <= vh - inset; y += 8) pts.push([inset, y], [vw - inset, y]);
  pts.push([vw - inset, vh - inset]);
  for (const [x, y] of pts) {
    const back = surface(x, y, vw, vh);
    const r = ratio(over(fill, back), back);
    if (r < worst.ratio) worst = { ratio: r, x, y };
  }
  return worst;
}

const VIEWS: Array<[number, number]> = [[1440, 900], [1280, 800], [1920, 1080], [2560, 1440], [1024, 700], [3440, 1440], [800, 1280]];

// Uppmätt i riktig Chrome (playwright-core, channel 'chrome', DSF 2, 1440 × 900, låtsas-Claude, tom yta; medianen av
// 12 × 12 enhetspixlar, som tar bort prickgridden och dithern). Kantmarkören i 55 % mörkad accent mättes till (26, 59, 140).
const SURFACE_SAMPLES: Array<{ at: [number, number]; px: RGB }> = [
  { at: [720, 324], px: [176, 179, 184] },
  { at: [720, 20], px: [172, 175, 180] },
  { at: [20, 450], px: [157, 160, 165] },
  { at: [1420, 450], px: [157, 160, 165] },
  { at: [720, 880], px: [163, 166, 171] },
  { at: [20, 20], px: [155, 158, 163] },
  { at: [1420, 880], px: [150, 153, 158] },
  { at: [300, 700], px: [163, 166, 171] },
];

test('kalibrering: ytan räknas som i Chrome (uppmätta pixlar), och color-mix som Chrome blandar den', () => {
  for (const s of SURFACE_SAMPLES) {
    const model = surface(s.at[0], s.at[1], 1440, 900);
    const off = Math.max(...model.map((v, i) => Math.abs(v - s.px[i])));
    assert.ok(off <= 1, `(${s.at}): modellen ${model.map((v) => v.toFixed(1))} mot uppmätt ${s.px}`);
  }
  const mixed = cssColour('color-mix(in srgb, var(--wb-accent) 55%, black)');
  assert.deepEqual(mixed.slice(0, 3).map(Math.round), [26, 59, 140]);
  assert.throws(() => markerFill('.wb-marker i { color: red; }'), /saknar/);
});

test('kantmarkörerna har minst 3:1 mot ytan längs hela vyns kant (base.css)', () => {
  const fill = cssColour(markerFill(baseCss));
  for (const [vw, vh] of VIEWS) {
    const w = worstAtEdge(fill, vw, vh);
    assert.ok(w.ratio >= 3, `${vw}×${vh}: ${w.ratio.toFixed(2)} vid (${w.x}, ${w.y})`);
  }
});

test('planterade fel: kantmarkören i --wb-grip (den förra färgen) och i ren --wb-accent fälls', () => {
  for (const name of ['--wb-grip', '--wb-accent']) {
    const worst = Math.min(...VIEWS.map(([vw, vh]) => worstAtEdge(cssColour(`var(${name})`), vw, vh).ratio));
    assert.ok(worst < 2, `${name} ska fällas, gav ${worst.toFixed(2)}`);
  }
});
