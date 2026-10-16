// hud-markdown.test.ts — HUD:ens markdown-tolkare (web/src/hud/markdown.ts). Tolkningen ger ett rent
// dataträd; ingen sträng från Claude blir HTML. XSS-fallen ska komma ut som bokstavlig text (§15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInline, parseMarkdown, plainText, type Block, type Inline } from '../../web/src/hud/markdown.ts';

const text = (t: string): Inline => ({ t: 'text', text: t });

/** Alla textsträngar i trädet, i ordning (det enda som kan nå DOM:en, och då via textContent). */
function strings(blocks: Block[]): string[] {
  const out: string[] = [];
  const inl = (xs: Inline[]) => {
    for (const x of xs) {
      if (x.t === 'text' || x.t === 'code') out.push(x.text);
      else if (x.t === 'strong' || x.t === 'em') inl(x.children);
    }
  };
  for (const b of blocks) {
    if (b.t === 'p') inl(b.children);
    else if (b.t === 'pre') out.push(b.text);
    else b.items.forEach(inl);
  }
  return out;
}

/** Trädets nodtyper: bara de som DOM-byggaren känner till. */
function kinds(blocks: Block[]): Set<string> {
  const s = new Set<string>();
  const inl = (xs: Inline[]) => {
    for (const x of xs) {
      s.add(x.t);
      if (x.t === 'strong' || x.t === 'em') inl(x.children);
    }
  };
  for (const b of blocks) {
    s.add(b.t);
    if (b.t === 'p') inl(b.children);
    else if (b.t !== 'pre') b.items.forEach(inl);
  }
  return s;
}

test('stycken delas vid tomrad, rader inom ett stycke blir radbrytningar', () => {
  assert.deepEqual(parseMarkdown('Första stycket.\nSamma stycke.\n\nAndra.'), [
    { t: 'p', children: [text('Första stycket.'), { t: 'br' }, text('Samma stycke.')] },
    { t: 'p', children: [text('Andra.')] },
  ]);
});

test('**fet**, `kod` och *kursiv*', () => {
  assert.deepEqual(parseInline('Klart. **Inkorgen** visar `server.mjs` och *nya* mejl.'), [
    text('Klart. '),
    { t: 'strong', children: [text('Inkorgen')] },
    text(' visar '),
    { t: 'code', text: 'server.mjs' },
    text(' och '),
    { t: 'em', children: [text('nya')] },
    text(' mejl.'),
  ]);
});

test('kod tolkas inte inuti: avgränsare i `…` är bokstavliga', () => {
  assert.deepEqual(parseInline('`**inte fet**` och **fet `kod`**'), [
    { t: 'code', text: '**inte fet**' },
    text(' och '),
    { t: 'strong', children: [text('fet '), { t: 'code', text: 'kod' }] },
  ]);
  assert.deepEqual(parseInline('``en ` backtick``'), [{ t: 'code', text: 'en ` backtick' }]);
});

test('listor: punkter och numrerade, med fortsättningsrader', () => {
  assert.deepEqual(parseMarkdown('Gjort:\n- Inkorg\n- Läsruta\n  med svar\n\n3. tre\n4. fyra'), [
    { t: 'p', children: [text('Gjort:')] },
    { t: 'ul', items: [[text('Inkorg')], [text('Läsruta'), { t: 'br' }, text('med svar')]] },
    { t: 'ol', start: 3, items: [[text('tre')], [text('fyra')]] },
  ]);
});

test('ofullständig markdown under strömning blir text, inte trasigt träd', () => {
  assert.deepEqual(parseInline('Jag bygger **en'), [text('Jag bygger **en')]);
  assert.deepEqual(parseInline('`halv'), [text('`halv')]);
  assert.deepEqual(parseMarkdown('```js\nconst a = 1'), [{ t: 'pre', text: 'const a = 1' }]);
});

test('inget kursivt mitt i ord eller kring blanksteg (snake_case, 2 * 3 * 4)', () => {
  assert.deepEqual(parseInline('min_app_namn'), [text('min_app_namn')]);
  assert.deepEqual(parseInline('2 * 3 * 4'), [text('2 * 3 * 4')]);
});

test('rubriker blir feta stycken, citat och linjer blir vanlig text', () => {
  assert.deepEqual(parseMarkdown('## Översikt\n> citat\n\n---\nslut'), [
    { t: 'p', children: [{ t: 'strong', children: [text('Översikt')] }] },
    { t: 'p', children: [text('citat')] },
    { t: 'p', children: [text('slut')] },
  ]);
});

test('å, ä, ö och tecken utanför ASCII passerar oförändrade', () => {
  assert.deepEqual(plainText(parseMarkdown('Hämtar **väder** för Malmö – “nu”')), 'Hämtar väder för Malmö – “nu”');
});

test('XSS: HTML i Claudes text blir bokstavlig text i trädet', () => {
  const payloads = [
    '<img src=x onerror=alert(1)>',
    '</code><script>alert(1)</script>',
    '`</code><script>alert(2)</script>`',
    '**<svg onload=alert(3)>**',
    '- <iframe src="javascript:alert(4)"></iframe>',
    '[länk](javascript:alert(5)) ![bild](x" onerror="alert(6))',
    '```\n</pre><img src=x onerror=alert(7)>\n```',
    '&lt;b&gt; &amp; <b>fet?</b>',
  ];
  for (const p of payloads) {
    const tree = parseMarkdown(p);
    // Bara de nodtyper DOM-byggaren känner till; inga element med attribut, inga länkar eller bilder.
    for (const k of kinds(tree)) assert.ok(['p', 'ul', 'ol', 'pre', 'text', 'code', 'strong', 'em', 'br'].includes(k), `oväntad nod ${k}`);
    // Allt innehåll finns kvar som text, tecken för tecken (inget tolkas, inget försvinner utom markdown-avgränsare).
    const joined = strings(tree).join('');
    for (const needle of ['<', 'onerror', 'alert', 'script', 'javascript'].filter((n) => p.includes(n))) {
      assert.ok(joined.includes(needle), `${JSON.stringify(p)} tappade ${needle}`);
    }
  }
  // Exakt: en img-tagg blir sina egna tecken.
  assert.deepEqual(parseMarkdown('<img src=x onerror=alert(1)>'), [{ t: 'p', children: [text('<img src=x onerror=alert(1)>')] }]);
  assert.deepEqual(parseInline('`</code><script>`'), [{ t: 'code', text: '</code><script>' }]);
  // HTML-entiteter avkodas inte (de är text, inte markup).
  assert.deepEqual(parseInline('&lt;b&gt;'), [text('&lt;b&gt;')]);
});

test('plainText: ren text för uppläsning och skärmläsare', () => {
  assert.equal(plainText(parseMarkdown('Klart. **Kuben** har `tre` sidor.\n\n- en\n- två')), 'Klart. Kuben har tre sidor.\n\nen\ntvå');
});
