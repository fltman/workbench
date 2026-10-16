// Låtsas-Claude (CONTRACT §8.9) hela vägen genom createSessions: samma händelser, policy, §8.6 och verktyg,
// och apparna som skrivs fungerar på riktigt (backenden startas och svarar på GET /api/tid).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { createSessions } from '../../server/claude/sessions.ts';
import { fakeVariant, stripWorkbenchBlock } from '../../server/claude/fake.ts';
import { childEnv } from '../../server/config.ts';
import type { Sessions } from '../../server/types.ts';
import type { ChatEvent } from '../../shared/protocol.ts';
import { makeWorld, sleep, until } from './server-claude-kit.ts';
import type { World } from './server-claude-kit.ts';

const ID = 'afake01';
let w: World;
let s: Sessions;

function setup(speed = 25, over: Record<string, unknown> = {}): void {
  w = makeWorld({ fakeClaude: true, fakeSpeed: speed, ...over });
  w.addApp(ID);
  s = createSessions({ config: w.config, paths: w.paths, registry: w.registry, scene: w.scene, hub: w.hub, backends: w.backends, logs: w.logs, shots: w.shots, git: w.git });
}

afterEach(async () => {
  await s?.closeAll();
  w?.cleanup();
});

const chat = () => w.hub.chat(ID);
const ends = () => chat().filter((e) => e.k === 'turn' && e.phase === 'end').length;
const file = (p: string) => fs.readFileSync(path.join(w.paths.appDir(ID), p), 'utf8');
const labels = () => chat().filter((e): e is Extract<ChatEvent, { k: 'tool' }> => e.k === 'tool').map((e) => e.label);
const askOf = () => chat().filter((e): e is Extract<ChatEvent, { k: 'ask' }> => e.k === 'ask').at(-1);
const lastEnd = () => chat().filter((e): e is Extract<ChatEvent, { k: 'turn' }> => e.k === 'turn' && e.phase === 'end').at(-1);

async function turn(text: string, n = 1): Promise<void> {
  s.send(ID, text, 'text');
  await until(() => ends() >= n && !s.busy(ID), 10_000, 'turen');
}

describe('låtsas-Claude', () => {
  test('anteckningsappen: händelserna i manusets ordning och en riktig app med wb.store', async () => {
    setup();
    s.open(ID);
    await turn('Jag vill ha en app för anteckningar');
    const k = chat().map((e) => (e.k === 'turn' ? `turn:${e.phase}` : e.k));
    assert.deepEqual(k.slice(0, 2), ['user', 'turn:start']);
    assert.ok(k.indexOf('delta') === 2, 'delta efter turn start');
    const rest = k.filter((x) => x !== 'delta');
    assert.deepEqual(rest, ['user', 'turn:start', 'tool', 'tool-done', 'tool', 'tool-done', 'text', 'turn:end']);
    assert.deepEqual(labels(), ['Skriver app.json', 'Skriver index.html']);
    const text = chat().find((e) => e.k === 'text');
    assert.ok(text && text.k === 'text' && text.text.startsWith('Klart.'));
    assert.equal(lastEnd()?.ok, true);
    // appen
    const manifest = JSON.parse(file('app.json'));
    assert.equal(manifest.name, 'Anteckningar');
    const html = file('index.html');
    assert.match(html, /wb\.store\.get\('anteckningar'\)/);
    assert.match(html, /wb\.store\.set\('anteckningar'/);
    assert.match(html, /Lägg till/);
    assert.match(html, /Inga anteckningar ännu\./);
    assert.match(html, /<html lang="sv">/);
    // §8.6: commit → refresh → restart (villkorslöst, även utan backend) → bumpRev → idle
    assert.deepEqual(w.rec.calls, [`setStatus:${ID}:building`, `commit:${ID}:Jag vill ha en app för anteckningar`, `refresh:${ID}`, `restart:${ID}`, `bumpRev:${ID}`, `setStatus:${ID}:idle`]);
    assert.equal(w.registry.get(ID)?.built, true);
    // låtsasmotorn sparade ett sessions-id som nästa process återupptar
    assert.match(fs.readFileSync(path.join(w.paths.appDataDir(ID), 'session.json'), 'utf8'), /sessionId/);
  });

  test('kuben: tre sidor med knappar som anropar wb.face.show', async () => {
    setup();
    await turn('Gör en kub med tre sidor');
    const m = JSON.parse(file('app.json'));
    assert.deepEqual(m.faces.map((f: { id: string }) => f.id), ['main', 'sida2', 'sida3']);
    for (const f of m.faces as { id: string; page: string }[]) {
      const html = file(f.page);
      const others = (m.faces as { id: string }[]).filter((o) => o.id !== f.id).map((o) => o.id);
      for (const o of others) assert.match(html, new RegExp(`data-sida="${o}"`), `${f.page} → ${o}`);
      assert.match(html, /wb\.face\.show\(b\.dataset\.sida\)/);
      assert.match(html, /Gå till/);
    }
    assert.match(file('index.html'), /Första sidan/);
    assert.deepEqual(labels(), ['Skriver app.json', 'Skriver sida2.html', 'Skriver sida3.html', 'Skriver index.html']);
  });

  test('klockan', async () => {
    setup();
    await turn('En klocka tack');
    assert.match(file('index.html'), /toLocaleTimeString\('sv-SE'\)/);
    assert.equal(JSON.parse(file('app.json')).name, 'Klocka');
  });

  test('backend: server.mjs svarar på GET /api/tid, och §8.6 startar om backenden', async () => {
    setup();
    await turn('Gör en app med backend');
    const m = JSON.parse(file('app.json'));
    assert.deepEqual(m.backend, { entry: 'server.mjs' });
    assert.ok(w.rec.calls.includes(`restart:${ID}`), 'backenden startades om i §8.6');
    assert.match(file('index.html'), /fetch\('\/api\/tid'/);
    // starta backenden på riktigt (port 8244 hör till server-claude)
    const child = spawn(process.execPath, ['--', 'server.mjs'], { cwd: w.paths.appDir(ID), env: childEnv({ PORT: '8244', HOST: '127.0.0.1' }), stdio: 'ignore' });
    let res: { status: number; body: string } | null = null;
    for (let i = 0; i < 100 && !res; i++) {
      res = await new Promise((resolve) => {
        const req = http.get({ host: '127.0.0.1', port: 8244, path: '/api/tid' }, (r) => {
          let b = '';
          r.on('data', (c) => (b += c));
          r.on('end', () => resolve({ status: r.statusCode ?? 0, body: b }));
        });
        req.on('error', () => resolve(null));
      });
      if (!res) await sleep(50);
    }
    child.kill('SIGTERM');
    assert.ok(res, 'backenden svarade');
    assert.equal(res.status, 200);
    const j = JSON.parse(res.body);
    assert.match(j.tid, /^\d{4}-\d\d-\d\dT/);
    assert.match(j.text, /^\d{2}:\d{2}:\d{2}$/);
  });

  test('"fråga": ett frågekort för WebFetch via canUseTool och policyn', async () => {
    setup();
    s.send(ID, 'Gör en app och fråga först', 'text');
    await until(() => !!askOf(), 10_000, 'frågan');
    assert.deepEqual(askOf()!.ask, { kind: 'permission', tool: 'WebFetch', title: 'Hämta från nätet?', detail: 'https://example.com', canRemember: true, defaultNo: false });
    assert.equal(w.registry.get(ID)?.status, 'waiting');
    assert.equal(s.busy(ID), true);
    s.answer(ID, askOf()!.id, 'allow');
    await until(() => ends() === 1 && !s.busy(ID), 10_000);
    assert.ok(labels().includes('Läser example.com'));
    const done = chat().filter((e) => e.k === 'tool-done') as Extract<ChatEvent, { k: 'tool-done' }>[];
    assert.ok(done.every((d) => d.ok));
    assert.equal(w.registry.get(ID)?.status, 'idle');
  });

  test('"fråga" nekad: verktyget misslyckas men turen blir klar', async () => {
    setup();
    s.send(ID, 'fråga', 'text');
    await until(() => !!askOf(), 10_000);
    s.answer(ID, askOf()!.id, 'deny');
    await until(() => ends() === 1 && !s.busy(ID), 10_000);
    const done = chat().filter((e) => e.k === 'tool-done') as Extract<ChatEvent, { k: 'tool-done' }>[];
    assert.equal(done.at(-1)?.ok, false);
    assert.equal(lastEnd()?.ok, true);
  });

  test('"hemlig": request_secret lagrar värdet bara i data/secrets.json', async () => {
    setup();
    const SECRET = 'fake-hemlis-55aa';
    s.send(ID, 'Den här appen behöver en hemlig nyckel', 'text');
    await until(() => askOf()?.ask.kind === 'secret', 10_000);
    assert.deepEqual(askOf()!.ask, { kind: 'secret', key: 'api_nyckel', label: 'API-nyckel' });
    assert.ok(labels().includes('Ber om API-nyckel'));
    s.answer(ID, askOf()!.id, 'answered', undefined, SECRET);
    await until(() => ends() === 1 && !s.busy(ID), 10_000);
    assert.equal(JSON.parse(file('data/secrets.json')).api_nyckel, SECRET);
    const elsewhere = [fs.readFileSync(path.join(w.paths.appDataDir(ID), 'chat.jsonl'), 'utf8'), JSON.stringify(w.hub.msgs), JSON.stringify([...w.logs.all.values()])];
    assert.equal(elsewhere.some((x) => x.includes(SECRET)), false);
  });

  test('stopp under en låtsastur: avbruten och status idle', async () => {
    setup(1);
    s.send(ID, 'anteckningar', 'text');
    await until(() => chat().some((e) => e.k === 'delta'), 5000);
    await s.stop(ID);
    await until(() => ends() === 1 && !s.busy(ID), 5000);
    assert.deepEqual(lastEnd(), { ...lastEnd(), ok: false, interrupted: true });
    assert.equal(w.registry.get(ID)?.status, 'idle');
  });

  test('WORKBENCH_FAKE_SPEED skalar pauserna', async () => {
    setup(1);
    let t0 = Date.now();
    await turn('anteckningar');
    const slow = Date.now() - t0;
    await s.closeAll();
    w.cleanup();
    setup(50);
    t0 = Date.now();
    await turn('anteckningar');
    const fast = Date.now() - t0;
    assert.ok(slow >= 1000, `hastighet 1: ungefär 1 s med delta plus verktyg (${slow} ms)`);
    assert.ok(fast < slow / 4, `hastighet 50 (${fast} ms) mot 1 (${slow} ms)`);
  });

  test('köade meddelanden under en låtsastur blir en commit', async () => {
    setup(5);
    s.send(ID, 'anteckningar', 'text');
    await until(() => chat().some((e) => e.k === 'delta'), 5000);
    s.send(ID, 'och en klocka', 'text');
    await until(() => ends() === 1 && !s.busy(ID), 10_000);
    assert.equal(chat().filter((e) => e.k === 'turn' && e.phase === 'start').length, 1);
    assert.deepEqual(w.git.commits.map((c) => c.message), ['anteckningar']);
    assert.equal(JSON.parse(file('app.json')).name, 'Klocka', 'det andra meddelandet kördes också');
  });
});

describe('manusets hjälpare', () => {
  test('variant ur texten', () => {
    assert.equal(fakeVariant('Gör en KUB'), 'kub');
    assert.equal(fakeVariant('flera sidor'), 'kub');
    assert.equal(fakeVariant('en klocka'), 'klocka');
    assert.equal(fakeVariant('med backend'), 'backend');
    assert.equal(fakeVariant('mejl'), 'anteckningar');
  });
  test('användarens text efter blocket', () => {
    assert.equal(stripWorkbenchBlock('<workbench>\nWindow: x\n</workbench>\nhej\nhopp'), 'hej\nhopp');
    assert.equal(stripWorkbenchBlock('bara text'), 'bara text');
  });
});
