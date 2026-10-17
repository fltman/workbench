// hud-model.test.ts — HUD:ens regler som rena funktioner (CONTRACT §12, §13): meddelanden, aktivitetsraden,
// frågekort, turfel, Esc-regeln, behörighetskortets mening, kvotraden och uppläsningens första mening, och
// kantljusets takt och utbredning (ur panel.ts och activity.css).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { ChatEvent } from '../../shared/protocol.ts';
import * as M from '../../web/src/hud/model.ts';

let t = 1_000;
const at = () => ++t;
const turn = (phase: 'start' | 'end', extra: Partial<Extract<ChatEvent, { k: 'turn' }>> = {}): ChatEvent => ({ k: 'turn', phase, at: at(), ...extra });

const history: ChatEvent[] = [
  { k: 'user', id: 'u1', text: 'Jag vill ha en klocka', via: 'voice', at: at() },
  turn('start'),
  { k: 'tool', id: 't1', name: 'Write', label: 'Skriver app.json', at: at() },
  { k: 'tool-done', id: 't1', ok: true },
  { k: 'text', id: 'x1', text: 'Jag börjar med tiden.', at: at() },
  { k: 'tool', id: 't2', name: 'Write', label: 'Skriver index.html', at: at() },
  { k: 'tool-done', id: 't2', ok: true },
  { k: 'text', id: 'x2', text: 'Klart. Klockan går varje sekund.', at: at() },
  turn('end', { ok: true }),
  { k: 'note', id: 'n1', text: 'Ångrade senaste ändringen.', at: at() },
];

test('meddelanden: användaren, turens sista text och notiser, inget mellanprat och ingen verktygshistorik', () => {
  assert.deepEqual(
    M.messages(history).map((m) => `${m.kind}:${m.text}`),
    ['user:Jag vill ha en klocka', 'reply:Klart. Klockan går varje sekund.', 'note:Ångrade senaste ändringen.'],
  );
  assert.equal(new Set(M.messages(history).map((m) => m.key)).size, 3);
});

test('meddelanden: i en pågående tur står den senaste texten kvar tills nästa börjar strömma in', () => {
  const open: ChatEvent[] = [
    ...history,
    { k: 'user', id: 'u2', text: 'Gör den mörk', via: 'text', at: at() },
    turn('start'),
    { k: 'text', id: 'x3', text: 'Jag byter färgerna.', at: at() },
    { k: 'tool', id: 't3', name: 'Edit', label: 'Ändrar index.html', at: at() },
  ];
  const tail = (streaming: boolean) => M.messages(open, streaming).slice(-2).map((m) => `${m.kind}:${m.text}`);
  assert.deepEqual(tail(false), ['user:Gör den mörk', 'reply:Jag byter färgerna.']);
  assert.deepEqual(tail(true), ['note:Ångrade senaste ändringen.', 'user:Gör den mörk'], 'nästa text strömmar: den förra viker undan');
  // Den förra turens svar rörs aldrig av en ny tur.
  assert.ok(M.messages(open, true).some((m) => m.text === 'Klart. Klockan går varje sekund.'));
});

test('aktivitetsraden: senaste verktyget i pågående tur, bara under building och waiting', () => {
  const live: ChatEvent[] = [...history, { k: 'user', id: 'u2', text: 'Gör den mörk', via: 'text', at: at() }, turn('start')];
  assert.equal(M.activityLabel(live, 'building'), null, 'inget verktyg ännu i den nya turen');
  live.push({ k: 'tool', id: 't3', name: 'Edit', label: 'Ändrar index.html', at: at() });
  assert.equal(M.activityLabel(live, 'building'), 'Ändrar index.html');
  assert.equal(M.activityLabel(live, 'waiting'), 'Ändrar index.html');
  assert.equal(M.activityLabel(live, 'idle'), null);
  assert.equal(M.activityLabel(live, 'error'), null);
});

test('aktivitetsraden: tyst medan ett frågekort väntar, tillbaka när frågan är besvarad', () => {
  const live: ChatEvent[] = [
    ...history,
    { k: 'user', id: 'u2', text: 'Hämta vädret', via: 'text', at: at() },
    turn('start'),
    { k: 'tool', id: 't4', name: 'WebFetch', label: 'Läser example.com', at: at() },
    { k: 'ask', id: 'a9', at: at(), ask: { kind: 'permission', tool: 'WebFetch', title: 'Hämta från nätet?', detail: 'https://example.com', canRemember: true, defaultNo: false } },
  ];
  // Kalibrering: utan kortet (status building) visas raden, så att testet kan fällas.
  assert.equal(M.activityLabel(live, 'building'), 'Läser example.com');
  assert.equal(M.pendingAsks(live, 'waiting').length, 1);
  assert.equal(M.activityLabel(live, 'waiting'), null, 'kortet säger redan vad som händer');
  live.push({ k: 'ask-done', id: 'a9', decision: 'allow' });
  assert.equal(M.activityLabel(live, 'waiting'), 'Läser example.com');
  assert.equal(M.activityLabel(live, 'building'), 'Läser example.com');
});

test('aktivitetsraden: pricken redan innan första verktyget, bara under building, aldrig medan ett kort väntar', () => {
  const live: ChatEvent[] = [...history, { k: 'user', id: 'u5', text: 'Gör den mörk', via: 'text', at: at() }, turn('start'), { k: 'delta', text: 'Jag' }];
  assert.deepEqual(M.activity(live, 'building'), { label: null }, 'Claude tänker: bara pricken');
  live.push({ k: 'tool', id: 't5', name: 'Write', label: 'Skriver index.html', at: at() });
  assert.deepEqual(M.activity(live, 'building'), { label: 'Skriver index.html' });
  live.push({ k: 'ask', id: 'a5', at: at(), ask: { kind: 'permission', tool: 'WebFetch', title: 'Hämta från nätet?', detail: 'https://example.com', canRemember: true, defaultNo: false } });
  assert.equal(M.activity(live, 'waiting'), null, 'kortet säger redan vad som händer');
  live.push({ k: 'ask-done', id: 'a5', decision: 'allow' });
  assert.deepEqual(M.activity(live, 'building'), { label: 'Skriver index.html' });
  for (const st of ['idle', 'error', 'waiting', undefined] as const) assert.equal(M.activity(live, st), null, String(st));
  // En ny tur i samma kedja (köat meddelande): etiketten från förra turen följer inte med.
  live.push(turn('end'), turn('start'));
  assert.deepEqual(M.activity(live, 'building'), { label: null });
  // Status building innan turens start har kommit fram: förra turens verktyg räknas inte.
  const before: ChatEvent[] = [...history, turn('start'), { k: 'tool', id: 't6', name: 'Read', label: 'Läser a.ts', at: at() }, turn('end')];
  assert.deepEqual(M.activity(before, 'building'), { label: null });
});

test('frågekort: bara obesvarade frågor, och bara när status är waiting', () => {
  const evs: ChatEvent[] = [
    turn('start'),
    { k: 'ask', id: 'a1', at: at(), ask: { kind: 'secret', key: 'k', label: 'Nyckel' } },
    { k: 'ask-done', id: 'a1', decision: 'answered' },
    { k: 'ask', id: 'a2', at: at(), ask: { kind: 'permission', tool: 'WebFetch', title: 'Hämta från nätet?', detail: 'https://example.com', canRemember: true, defaultNo: false } },
  ];
  assert.deepEqual(M.pendingAsks(evs, 'waiting').map((a) => a.id), ['a2']);
  assert.deepEqual(M.pendingAsks(evs, 'building'), []);
  evs.push({ k: 'ask-done', id: 'a2', decision: 'timeout' });
  assert.deepEqual(M.pendingAsks(evs, 'waiting'), []);
});

test('turfel: visas efter en misslyckad tur tills nästa tur börjar, aldrig för en avbruten', () => {
  const evs: ChatEvent[] = [turn('start'), turn('end', { ok: false, error: 'API Error: 529 Overloaded' })];
  assert.equal(M.turnError(evs), 'API Error: 529 Overloaded');
  assert.equal(M.turnError([...evs, turn('start')]), null);
  assert.equal(M.turnError([turn('start'), turn('end', { ok: false, interrupted: true, error: 'x' })]), null);
  assert.equal(M.turnError(history), null);
});

test('avslutande text: sista textblocket i senaste turen', () => {
  assert.equal(M.closingText(history), 'Klart. Klockan går varje sekund.');
  assert.equal(M.closingText([...history, turn('start'), turn('end', { ok: true })]), null);
});

test('Esc-regeln: bara created, inget skickat, inte byggd och tom inmatning tar bort appen', () => {
  const base = { reason: 'created', sentSinceOpen: false, built: false, draft: false } as const;
  assert.equal(M.deleteOnEsc(base), true);
  assert.equal(M.deleteOnEsc({ ...base, sentSinceOpen: true }), false);
  assert.equal(M.deleteOnEsc({ ...base, built: true }), false);
  assert.equal(M.deleteOnEsc({ ...base, reason: 'dot' }), false);
  assert.equal(M.deleteOnEsc({ ...base, reason: 'key' }), false);
  assert.equal(M.deleteOnEsc({ ...base, reason: 'auto' }), false);
  // okänd app (redan borta): ta aldrig bort på chans
  assert.equal(M.deleteOnEsc({ ...base, built: undefined }), false);
  // en halvskriven beskrivning är användarens arbete: Esc stänger bara HUD:en
  assert.equal(M.deleteOnEsc({ ...base, draft: true }), false);
});

test('behörigheter: bara de som varken getts eller nekats, en gång var', () => {
  assert.deepEqual(M.pendingPermissions(['microphone', 'camera', 'microphone'], ['camera'], []), ['microphone']);
  assert.deepEqual(M.pendingPermissions(['microphone', 'geolocation'], [], ['geolocation']), ['microphone']);
  assert.deepEqual(M.pendingPermissions([], [], []), []);
});

test('behörighetskortets mening på svenska', () => {
  assert.equal(M.permissionSentence('Klocka', ['microphone']), 'Klocka vill använda mikrofonen');
  assert.equal(M.permissionSentence('Mejl', ['microphone', 'camera']), 'Mejl vill använda mikrofonen och kameran');
  assert.equal(M.permissionSentence('', ['clipboard-read', 'geolocation', 'camera']), 'Appen vill använda urklippet, platsen och kameran');
});

test('kvotraden: från 0,8 i något av fönstren, avrundat nedåt', () => {
  assert.equal(M.limitsSentence(null), null);
  assert.equal(M.limitsSentence({ fiveHour: 0.79, sevenDay: 0.5 }), null);
  assert.equal(M.limitsSentence({ fiveHour: 0.8, sevenDay: 0.2 }), 'Du har använt 80\u{a0}% av din Claude-kvot');
  assert.equal(M.limitsSentence({ fiveHour: 0.3, sevenDay: 0.917 }), 'Du har använt 91\u{a0}% av din Claude-kvot');
  assert.equal(M.limitsSentence({ fiveHour: 1.4, sevenDay: 0 }), 'Du har använt 100\u{a0}% av din Claude-kvot');
});

test('uppläsning: första meningen, högst 200 tecken, svenska förkortningar bryter inte', () => {
  assert.equal(M.firstSentence('Klart. Klockan går varje sekund.'), 'Klart.');
  assert.equal(M.firstSentence('Jag har lagt till t.ex. en sökruta och en lista. Sedan något mer.'), 'Jag har lagt till t.ex. en sökruta och en lista.');
  assert.equal(M.firstSentence('Är det klart?  Ja.'), 'Är det klart?');
  const long = 'Inkorgen ' + 'visar mejl från många olika avsändare '.repeat(8) + 'och mer.';
  const s = M.firstSentence(long);
  assert.ok([...s].length <= 201, `${[...s].length}`);
  assert.ok(s.endsWith('…'));
  assert.ok(!/\s…$/.test(s));
  assert.equal(M.firstSentence('   '), '');
});

test('maxAt: största tidsstämpeln (skiljer live från historik)', () => {
  assert.equal(M.maxAt(history), Math.max(...history.map((e) => ('at' in e ? e.at : 0))));
  assert.equal(M.maxAt([]), 0);
});

/* OBS-1: ett meddelande som köas medan turen pågår hamnar under turens text, inte ovanför den levande texten. */

const building = (): ChatEvent[] => [
  { k: 'user', id: 'q1', text: 'en anteckningsapp', via: 'text', at: at() },
  turn('start'),
  { k: 'tool', id: 'qt1', name: 'Write', label: 'Skriver app.json', at: at() },
  { k: 'tool-done', id: 'qt1', ok: true },
  { k: 'text', id: 'qx1', text: 'Jag börjar med listan.', at: at() },
  { k: 'tool', id: 'qt2', name: 'Write', label: 'Skriver index.html', at: at() },
  { k: 'user', id: 'q2', text: 'och en rubrik', via: 'text', at: at() },
];
const view = (ev: readonly ChatEvent[], streaming = false) => M.messages(ev, streaming).map((m) => `${m.kind}:${m.text}`);

test('köat under turen: står under turens text, och den levande texten visas ovanför det (queued)', () => {
  const ev = building();
  assert.deepEqual(view(ev), ['user:en anteckningsapp', 'reply:Jag börjar med listan.', 'user:och en rubrik']);
  // Medan nästa text strömmar in viker turens förra text undan för den levande texten, som står ovanför det köade.
  const streaming = M.messages(ev, true);
  assert.deepEqual(streaming.map((m) => m.text), ['en anteckningsapp', 'och en rubrik']);
  assert.equal(streaming.queued, 1, 'det köade står sist, under den levande texten');
  assert.equal(M.messages(ev).queued, 1);
});

test('köat under turen: turens svar ersätter den levande texten på samma plats, det köade följer med sin egen tur', () => {
  const ev = [...building(), { k: 'text', id: 'qx2', text: 'Klart. Anteckningar.', at: at() } as ChatEvent];
  assert.deepEqual(view(ev), ['user:en anteckningsapp', 'reply:Klart. Anteckningar.', 'user:och en rubrik']);
  assert.equal(M.messages(ev).queued, 0, 'turen har fått sin text: det köade står i listan');
  // Den köade frågans egen tur: text under frågan, en text per tur, och turens förra svar rörs inte.
  ev.push({ k: 'tool', id: 'qt3', name: 'Edit', label: 'Ändrar index.html', at: at() });
  assert.deepEqual(view(ev, true), ['user:en anteckningsapp', 'reply:Klart. Anteckningar.', 'user:och en rubrik']);
  assert.equal(M.messages(ev, true).queued, 0, 'den levande texten är nu den köade frågans och står sist');
  ev.push({ k: 'text', id: 'qx3', text: 'Jag lägger till en rubrik.', at: at() });
  ev.push({ k: 'text', id: 'qx4', text: 'Klart. Rubriken står överst.', at: at() });
  ev.push(turn('end', { ok: true }));
  assert.deepEqual(view(ev), ['user:en anteckningsapp', 'reply:Klart. Anteckningar.', 'user:och en rubrik', 'reply:Klart. Rubriken står överst.']);
  assert.equal(new Set(M.messages(ev).map((m) => m.key)).size, 4);
});

test('köat under turen: slutar turen utan mer text följer det köade efter turen, med notisen under sig', () => {
  const ev = [...building(), { k: 'note', id: 'qn1', text: 'Meddelandet kördes inte.', at: at() } as ChatEvent, turn('end', { ok: false, interrupted: true })];
  assert.deepEqual(view(ev), ['user:en anteckningsapp', 'reply:Jag börjar med listan.', 'user:och en rubrik', 'note:Meddelandet kördes inte.']);
  assert.equal(M.messages(ev).queued, 0);
});

test('en användarrad vars meddelande aldrig kördes är dämpad när en not pekar ut den (dropped, §13)', () => {
  const ev = building();
  const before = M.messages(ev).find((m) => m.kind === 'user' && m.text === 'och en rubrik');
  assert.deepEqual(before, { key: 'u:q2', kind: 'user', text: 'och en rubrik', via: 'text', dropped: false }, 'innan noten kommit är raden som vanligt');
  ev.push({ k: 'note', id: 'qn9', text: 'Stoppad – ”och en rubrik” skickades inte', dropped: 'q2', at: at() }, turn('end', { ok: false, interrupted: true }));
  const users = M.messages(ev).filter((m) => m.kind === 'user').map((m) => [m.text, (m as { dropped?: boolean }).dropped]);
  assert.deepEqual(users, [['en anteckningsapp', false], ['och en rubrik', true]]);
  // En not utan dropped (Avbröts, ångra) dämpar ingenting, och ett okänt id gör inget.
  const other: ChatEvent[] = [...building(), { k: 'note', id: 'qn8', text: 'Avbröts', at: at() }, { k: 'note', id: 'qn7', text: 'x', dropped: 'finns-inte', at: at() }];
  assert.ok(M.messages(other).every((m) => m.kind !== 'user' || m.dropped === false));
});

test('svar på ett frågekort köas inte: texten hör till turen och står i ordning (§8.5 punkt 5)', () => {
  const ev: ChatEvent[] = [
    { k: 'user', id: 'k1', text: 'hämta vädret', via: 'text', at: at() },
    turn('start'),
    { k: 'text', id: 'kx1', text: 'Jag behöver nätet.', at: at() },
    { k: 'ask', id: 'ka1', ask: { kind: 'permission', tool: 'WebFetch', title: 'Hämta från nätet?', detail: 'https://example.com', canRemember: true, defaultNo: false }, at: at() },
    { k: 'user', id: 'k2', text: 'nej, hitta på något', via: 'text', at: at() },
    { k: 'ask-done', id: 'ka1', decision: 'deny' },
    { k: 'text', id: 'kx2', text: 'Då gör jag en låtsasprognos.', at: at() },
  ];
  assert.deepEqual(view(ev), ['user:hämta vädret', 'reply:Jag behöver nätet.', 'user:nej, hitta på något', 'reply:Då gör jag en låtsasprognos.']);
  assert.equal(M.messages(ev).queued, 0);
});

/* Noterna efter turslutet (§8.6, §13): de hör till turen som slutade och står under dess innehåll, ovanför ett meddelande
   som skickades under §8.6 eller efter Stopp. Serverns ordning (server-claude-sessions.test.ts): meddelandets rad före
   turslutet, turens noter direkt efter det, och sedan meddelandets egen tur. */

test('noten efter turslutet står under den stoppade turen, ovanför meddelandet som skickades efter Stopp (§13)', () => {
  const ev: ChatEvent[] = [
    { k: 'user', id: 'p1', text: 'en klocka', via: 'text', at: at() },
    turn('start'),
    { k: 'user', id: 'p2', text: 'gör en väckarklocka i stället', via: 'text', at: at() },
    { k: 'text', id: 'px1', text: 'Jag bygger en klocka', at: at() },
    turn('end', { ok: false, interrupted: true }),
    { k: 'note', id: 'pn1', text: 'Avbröts – ändringarna finns kvar', at: at() },
  ];
  assert.deepEqual(view(ev), ['user:en klocka', 'reply:Jag bygger en klocka', 'note:Avbröts – ändringarna finns kvar', 'user:gör en väckarklocka i stället']);
  ev.push(turn('start'), { k: 'text', id: 'px2', text: 'Klart. Väckarklockan finns.', at: at() }, turn('end', { ok: true }));
  assert.deepEqual(view(ev), [
    'user:en klocka', 'reply:Jag bygger en klocka', 'note:Avbröts – ändringarna finns kvar', 'user:gör en väckarklocka i stället', 'reply:Klart. Väckarklockan finns.',
  ]);
});

test('noterna efter turslutet står ovanför ett meddelande som skickades under §8.6, i sin ordning (§13)', () => {
  const ev: ChatEvent[] = [
    { k: 'user', id: 'r1', text: 'en klocka', via: 'text', at: at() },
    turn('start'),
    { k: 'text', id: 'rx1', text: 'Klart. Klockan går.', at: at() },
    { k: 'user', id: 'r2', text: 'gör den större', via: 'text', at: at() },
    turn('end', { ok: true }),
    { k: 'note', id: 'rn1', text: 'Ändringen kunde inte sparas separat, så Ångra tar nu två ändringar på en gång.', at: at() },
    { k: 'note', id: 'rn2', text: 'Backenden kraschade 4 gånger på 60 s. Den startar igen när Claude ändrar appen eller när du ångrar.', at: at() },
    turn('start'),
    { k: 'text', id: 'rx2', text: 'Klart. Den är större.', at: at() },
  ];
  assert.deepEqual(view(ev), [
    'user:en klocka', 'reply:Klart. Klockan går.',
    'note:Ändringen kunde inte sparas separat, så Ångra tar nu två ändringar på en gång.',
    'note:Backenden kraschade 4 gånger på 60 s. Den startar igen när Claude ändrar appen eller när du ångrar.',
    'user:gör den större', 'reply:Klart. Den är större.',
  ]);
  assert.equal(new Set(M.messages(ev).map((m) => m.key)).size, 6);
});

test('noterna efter turslutet: en not med dropped står kvar under sin rad, och det som kommer senare står sist (§13)', () => {
  // Stopp under §8.6: det hållna meddelandet kördes aldrig (dropped, före turslutet); commiten misslyckades (efter det).
  const ev: ChatEvent[] = [
    { k: 'user', id: 's1', text: 'en klocka', via: 'text', at: at() },
    turn('start'),
    { k: 'text', id: 'sx1', text: 'Klart. Klockan går.', at: at() },
    { k: 'user', id: 's2', text: 'och ett alarm', via: 'text', at: at() },
    { k: 'note', id: 'sn1', text: 'Stoppad – ”och ett alarm” skickades inte', dropped: 's2', at: at() },
    turn('end', { ok: true }),
    { k: 'note', id: 'sn2', text: 'Ändringen kunde inte sparas separat, så Ångra tar nu två ändringar på en gång.', at: at() },
  ];
  assert.deepEqual(view(ev), [
    'user:en klocka', 'reply:Klart. Klockan går.', 'note:Ändringen kunde inte sparas separat, så Ångra tar nu två ändringar på en gång.',
    'user:och ett alarm', 'note:Stoppad – ”och ett alarm” skickades inte',
  ]);
  // Ett nytt meddelande efter turen och en not efter det står i tidsordning, sist.
  ev.push({ k: 'user', id: 's3', text: 'gör den röd', via: 'text', at: at() }, { k: 'note', id: 'sn3', text: 'Ångrade senaste ändringen.', at: at() });
  assert.deepEqual(view(ev).slice(-2), ['user:gör den röd', 'note:Ångrade senaste ändringen.']);
  // En tur utan köat meddelande: noten står sist, som förut.
  assert.deepEqual(view(history).at(-1), 'note:Ångrade senaste ändringen.');
});

test('noten efter turslutet står under ett köat meddelande vars tur hann börja med verktyg, utan text (§13)', () => {
  // Kedjan: turens svar, sedan arbetar Claude med det köade meddelandet (verktyg, ingen text mellan dem) tills Stopp.
  const ev: ChatEvent[] = [
    { k: 'user', id: 'b1', text: 'en anteckningsapp', via: 'text', at: at() },
    turn('start'),
    { k: 'user', id: 'b2', text: 'och en rubrik', via: 'text', at: at() },
    { k: 'text', id: 'bx1', text: 'Klart. Anteckningar.', at: at() },
    { k: 'tool', id: 'bt1', name: 'Edit', label: 'Ändrar index.html', at: at() },
    turn('end', { ok: false, interrupted: true }),
    { k: 'note', id: 'bn1', text: 'Avbröts – ändringarna finns kvar', at: at() },
  ];
  assert.deepEqual(view(ev), ['user:en anteckningsapp', 'reply:Klart. Anteckningar.', 'user:och en rubrik', 'note:Avbröts – ändringarna finns kvar']);
  // Ett frågekort i den köade turen är också arbete på den.
  const asked: ChatEvent[] = [
    ...ev.slice(0, 4),
    { k: 'ask', id: 'ba1', ask: { kind: 'permission', tool: 'WebFetch', title: 'Hämta från nätet?', detail: 'https://example.com', canRemember: true, defaultNo: false }, at: at() },
    { k: 'ask-done', id: 'ba1', decision: 'cancelled' },
    ...ev.slice(5),
  ];
  assert.deepEqual(view(asked).slice(-2), ['user:och en rubrik', 'note:Avbröts – ändringarna finns kvar']);
});

/* Uppläsningen (§12) när en tur slutar. Fliken som skickade minns att det senaste meddelandet kom med röst (hud.ts);
   spokenReply avgör vid varje turslut om det meddelandet har fått sitt svar. */

/** Vad fliken läser upp, turslut för turslut, med regeln rule. sent = fliken skickade meddelandet med det id:t. */
function spoken(events: readonly ChatEvent[], rule: (upTo: ChatEvent[]) => ReturnType<typeof M.spokenReply>, sent: string[]): string[] {
  const out: string[] = [];
  let voice = false; // hud.ts: via.get(appId) === 'voice'
  events.forEach((e, i) => {
    if (e.k === 'user' && sent.includes(e.id)) voice = e.via === 'voice';
    if (e.k !== 'turn' || e.phase !== 'end' || !voice) return;
    const r = rule(events.slice(0, i + 1));
    if (r === 'wait' || r.via !== 'voice') return;
    voice = false;
    if (r.text && e.ok) out.push(r.text);
  });
  return out;
}

/** Regeln före rättelsen: varje turslut svarade på det senaste meddelandet, och turens sista text lästes upp. */
const oldRule = (upTo: ChatEvent[]): ReturnType<typeof M.spokenReply> => ({ via: 'voice', text: M.closingText(upTo) });

test('uppläsning: ett röstmeddelande under §8.6 läses upp när dess egen tur slutar, inte den förra turens svar (§12)', () => {
  const ev: ChatEvent[] = [
    { k: 'user', id: 'v1', text: 'en klocka', via: 'text', at: at() },
    turn('start'),
    { k: 'text', id: 'vx1', text: 'Klart. Klockan går.', at: at() },
    { k: 'user', id: 'v2', text: 'gör en väckarklocka', via: 'voice', at: at() },
    turn('end', { ok: true }),
    turn('start'),
    { k: 'text', id: 'vx2', text: 'Klart. Väckarklockan ringer.', at: at() },
    turn('end', { ok: true }),
  ];
  assert.equal(M.spokenReply(ev.slice(0, 5)), 'wait', 'turen före röstmeddelandet svarade inte på det');
  assert.deepEqual(M.spokenReply(ev), { via: 'voice', text: 'Klart. Väckarklockan ringer.' });
  assert.deepEqual(spoken(ev, M.spokenReply, ['v1', 'v2']), ['Klart. Väckarklockan ringer.']);
  // Kalibrering: den gamla regeln läste den förra turens svar (ett skrivet meddelande) och sedan inget.
  assert.deepEqual(spoken(ev, oldRule, ['v1', 'v2']), ['Klart. Klockan går.']);
});

test('uppläsning: ett röstmeddelande efter Stopp läses upp när dess egen tur slutar (§12)', () => {
  const ev: ChatEvent[] = [
    { k: 'user', id: 'w1', text: 'en klocka', via: 'text', at: at() },
    turn('start'),
    { k: 'user', id: 'w2', text: 'gör en väckarklocka i stället', via: 'voice', at: at() },
    { k: 'text', id: 'wx1', text: 'Jag bygger en klocka', at: at() },
    turn('end', { ok: false, interrupted: true }),
    { k: 'note', id: 'wn1', text: 'Avbröts – ändringarna finns kvar', at: at() },
    turn('start'),
    { k: 'text', id: 'wx2', text: 'Klart. Väckarklockan ringer.', at: at() },
    turn('end', { ok: true }),
  ];
  assert.deepEqual(spoken(ev, M.spokenReply, ['w1', 'w2']), ['Klart. Väckarklockan ringer.']);
  assert.deepEqual(spoken(ev, oldRule, ['w1', 'w2']), [], 'kalibrering: den gamla regeln förbrukade rösten vid den avbrutna turen');
});

test('uppläsning: ett köat röstmeddelande i kedjan läses upp; skrivet, aldrig kört och en annan fliks meddelande läses inte (§12)', () => {
  const chain: ChatEvent[] = [
    { k: 'user', id: 'c1', text: 'en klocka', via: 'text', at: at() },
    turn('start'),
    { k: 'text', id: 'cx1', text: 'Jag bygger klockan.', at: at() },
    { k: 'user', id: 'c2', text: 'och ett alarm', via: 'voice', at: at() },
    { k: 'text', id: 'cx2', text: 'Klart. Klockan går.', at: at() },
    { k: 'text', id: 'cx3', text: 'Klart. Alarmet ringer sju.', at: at() },
    turn('end', { ok: true }),
  ];
  assert.deepEqual(spoken(chain, M.spokenReply, ['c1', 'c2']), ['Klart. Alarmet ringer sju.']);
  // Samma kedja med ett skrivet köat meddelande: inget läses.
  const typed = chain.map((e) => (e.k === 'user' && e.id === 'c2' ? { ...e, via: 'text' as const } : e));
  assert.deepEqual(spoken(typed, M.spokenReply, ['c1', 'c2']), []);
  // Stoppat i kön (dropped): det får inget svar, och rösten förbrukas utan uppläsning.
  const stopped: ChatEvent[] = [
    ...chain.slice(0, 4),
    { k: 'note', id: 'cn1', text: 'Stoppad – ”och ett alarm” avbröts', dropped: 'c2', at: at() },
    { k: 'text', id: 'cx4', text: 'Jag bygger klockan och', at: at() },
    turn('end', { ok: false, interrupted: true }),
  ];
  assert.deepEqual(M.spokenReply(stopped), { via: 'voice', text: null });
  // Röstmeddelandet kom från en annan flik: den här fliken skickade bara det skrivna och läser ingenting.
  assert.deepEqual(spoken(chain, M.spokenReply, ['c1']), []);
});

/* Kantljuset (§13 punkt 3, §14): panelens innerkant andas medan Claude arbetar, i fas med aktivitetsradens LED.
   Läses ur panel.ts och activity.css (som kontrasttestet läser CSS:en), eftersom panelen inte går att ladda i node.
   Webbläsarmätningen (per bildruta, kontrast ur pixlar) finns i rapporten; här låses reglerna. */

const hudSrc = (f: string) => fs.readFileSync(path.join(import.meta.dirname, '../../web/src/hud', f), 'utf8');

function rimTiming(src: string): { led: number; rim: number; iterStart: number; sameStart: boolean } {
  const num = (name: string) => {
    const m = new RegExp(`const ${name} = ([^;]+);`).exec(src);
    if (!m) throw new Error(`saknar ${name}`);
    return m[1].trim();
  };
  const led = Number(num('BUILDING_RATE'));
  const rimExpr = num('RIM_RATE');
  const div = /^BUILDING_RATE(?:\s*\/\s*([\d.]+))?$/.exec(rimExpr);
  const rim = div ? led / Number(div[1] ?? 1) : Number(rimExpr);
  const iterStart = Number(num('RIM_ITERATION_START'));
  // Pricken och båda ljusen sätter samma startTime (dokumentets tidslinje), annars slår de mot varandra.
  const sameStart = (src.match(/\.startTime = BREATH_START;/g) ?? []).length >= 2 && /a\.playbackRate = RIM_RATE;\s*a\.startTime = BREATH_START;/.test(src);
  return { led, rim, iterStart, sameStart };
}

/** Topparnas tider (ms) över `span` för en andning med toppen mitt i varvet, given takt och iterationStart. */
function peakTimes(rate: number, iterStart: number, span: number, D = 3200): number[] {
  const out: number[] = [];
  for (let m = 0; ; m++) {
    const t = ((0.5 - iterStart + m + (iterStart > 0.5 ? 1 : 0)) * D) / rate;
    if (t > span) return out;
    if (t >= 0) out.push(t);
  }
}

/** Ligger varje topp i kantljuset på en topp hos pricken, och (vid halv takt) på varannan? */
function rimInPhase(t: { led: number; rim: number; iterStart: number }): { ok: boolean; worst: number } {
  const span = 60_000;
  const leds = peakTimes(t.led, 0, span);
  const rims = peakTimes(t.rim, t.iterStart, span);
  let worst = 0;
  for (const r of rims) worst = Math.max(worst, Math.min(...leds.map((l) => Math.abs(l - r))));
  const ratioOk = Math.abs(t.rim - t.led) < 1e-9 || Math.abs(t.rim - t.led / 2) < 1e-9;
  return { ok: ratioOk && rims.length > 10 && worst < 1e-6, worst };
}

test('kantljuset: samma tidslinje som pricken, halva takten, toppen på varannan av prickens toppar', () => {
  const t = rimTiming(hudSrc('panel.ts'));
  assert.ok(t.sameStart, 'pricken och kantljuset ska ha samma startTime');
  assert.equal(t.rim, t.led / 2, 'kantljuset andas med halva prickens takt (cirka 1,94 s)');
  const r = rimInPhase(t);
  assert.ok(r.ok, `topparna ska sammanfalla, värsta avstånd ${r.worst.toFixed(1)} ms`);
  // Kalibrering: utan förskjutningen hamnar kantljusets toppar i prickens dalar, och en annan takt glider isär.
  assert.ok(!rimInPhase({ ...t, iterStart: 0 }).ok, 'iterationStart 0 ska fällas');
  assert.ok(rimInPhase({ ...t, iterStart: 0 }).worst > 400);
  assert.ok(!rimInPhase({ ...t, rim: t.led / 1.9 }).ok, 'en annan takt ska fällas');
  assert.ok(!rimTiming(hudSrc('panel.ts').replace('a.startTime = BREATH_START;', 'a.startTime = 120;')).sameStart, 'en egen startTime ska fällas');
});

/** Hur långt in (px) varje lager i kantljuset når: spridningen plus oskärpan (två standardavvikelser, cirka 2 %). */
function rimReach(css: string): number {
  let worst = 0;
  for (const sel of ['.wbh-rim-edge', '.wbh-rim-glow']) {
    const block = new RegExp(`\\n${sel.replace('.', '\\.')} \\{([^}]*)\\}`).exec(css);
    if (!block) throw new Error(`saknar ${sel}`);
    const layers = [...block[1].matchAll(/inset 0 0 ([\d.]+)px(?: ([\d.]+)px)?/g)];
    assert.ok(layers.length > 0, sel);
    for (const l of layers) worst = Math.max(worst, Number(l[1]) + Number(l[2] ?? 0));
  }
  return worst;
}

test('kantljuset håller sig inom de yttersta 14 px (texten börjar 18 px in) och står stilla med minskad rörelse', () => {
  const css = hudSrc('activity.css');
  assert.ok(rimReach(css) <= 14, `når ${rimReach(css)} px`);
  // Kalibrering: ett bredare sken fälls.
  assert.ok(rimReach(css.replace('inset 0 0 12px 1px', 'inset 0 0 20px 2px')) > 14);
  const reduce = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*)\}\s*$/.exec(css)?.[1] ?? '';
  for (const sel of ['.wbh-rim-edge', '.wbh-rim-glow']) assert.match(reduce, new RegExp(`\\${sel} \\{\\s*opacity: [\\d.]+;`), sel);
  // Bara opacitet animeras: inga övergångar eller nyckelbilder på skuggorna.
  assert.doesNotMatch(css, /transition:[^;]*box-shadow|@keyframes wbh-rim/);
});
