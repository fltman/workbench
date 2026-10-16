// shared-open.test.ts — fältets igenkänning av adresser och datum, och kontrollen av det som lämnas till en app (§10.9).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyInput, looksLikeUrl, normalUrl, normalizeItem, parseDate, validDate } from '../../shared/open.ts';

// Fredag 16 oktober 2026 (vecka 42).
const TODAY = new Date(2026, 9, 16, 10, 30);

test('adresser: värdnamn med toppdomän eller http(s); inte tal, mejladresser eller meningar', () => {
  for (const s of ['dn.se', 'www.svt.se/nyheter', 'https://example.com/a?b=1', 'http://localhost:8220', 'localhost:3000/x', 'sub.domain.co.uk']) {
    assert.equal(looksLikeUrl(s), true, s);
  }
  for (const s of ['3.14', 'namn@example.com', 'köp mjölk', 'javascript:alert(1)', 'ftp://x.se', 'dn', 'hej.', 'a b.se', '']) {
    assert.equal(looksLikeUrl(s), false, s);
  }
  assert.equal(normalUrl('dn.se'), 'https://dn.se/');
  assert.equal(normalUrl('javascript:alert(1)'), null);
  assert.equal(normalUrl('https://user:pw@x.se'), null, 'inga inloggningsuppgifter i adressen');
});

test('datum: siffror, månadsnamn, relativa dagar, veckodagar och veckor (fredag 16 oktober 2026)', () => {
  const cases: Array<[string, string | null]> = [
    ['2026-10-20', '2026-10-20'], ['20/10', '2026-10-20'], ['20/10/2027', '2027-10-20'], ['20 okt', '2026-10-20'],
    ['den 20 oktober', '2026-10-20'], ['3 maj 2027', '2027-05-03'], ['1 sept', '2026-09-01'], ['24 Dec.', '2026-12-24'],
    ['idag', '2026-10-16'], ['i morgon', '2026-10-17'], ['imorgon', '2026-10-17'], ['i övermorgon', '2026-10-18'], ['igår', '2026-10-15'],
    ['fredag', '2026-10-16'], ['måndag', '2026-10-19'], ['söndag', '2026-10-18'], ['nästa fredag', '2026-10-23'], ['nästa måndag', '2026-10-19'],
    ['vecka 43', '2026-10-19'], ['v. 1', '2025-12-29'], ['v 53', '2026-12-28'],
    ['31/2', null], ['30 februari', null], ['vecka 0', null], ['20 oktobrr', null], ['köp mjölk', null], ['mars', null],
  ];
  for (const [s, want] of cases) assert.equal(parseDate(s, TODAY), want, s);
});

test('classifyInput: adress, datum, eller null när Claude får avgöra', () => {
  assert.deepEqual(classifyInput('dn.se', TODAY), { kind: 'url', url: 'https://dn.se/' });
  assert.deepEqual(classifyInput('20 okt', TODAY), { kind: 'date', date: '2026-10-20' });
  assert.equal(classifyInput('köp mjölk och bröd', TODAY), null);
  assert.equal(classifyInput('gör kalendern mörk', TODAY), null);
});

test('normalizeItem: bara giltiga adresser, datum och text', () => {
  assert.deepEqual(normalizeItem('url', 'svt.se'), { kind: 'url', url: 'https://svt.se/' });
  assert.equal(normalizeItem('url', 'javascript:alert(1)'), null);
  assert.deepEqual(normalizeItem('date', '2026-10-20'), { kind: 'date', date: '2026-10-20' });
  assert.equal(normalizeItem('date', '2026-02-30'), null);
  assert.deepEqual(normalizeItem('text', '  köp\n mjölk '), { kind: 'text', text: 'köp mjölk' });
  assert.equal(normalizeItem('text', 'x'.repeat(2001)), null);
  assert.equal(normalizeItem('fil', 'x'), null);
  assert.equal(normalizeItem('url', 5), null);
  assert.equal(validDate('2024-02-29'), true);
  assert.equal(validDate('2026-02-29'), false);
});
