// /ws (CONTRACT §7.1): Origin-kontrollen (kalibrerad mot en planterad läcka), hello → snapshot,
// scene.window till ANDRA flikar, och strikt validering av varje klientmeddelande.
import { after, afterEach, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { WebSocket } from 'ws';
import type { Ask, ChatEvent, ServerMsg } from '../../shared/protocol.ts';
import { validateClientMsg } from '../../server/http/ws.ts';
import type { ValidateCtx } from '../../server/http/ws.ts';
import { leakyGuard, rmDir, startRouter, tempDir } from './server-http-fakes.test.ts';
import type { Started } from './server-http-fakes.test.ts';

const APP = 'awsapp12';

/* ------------------------------ ren validering ------------------------------ */

const perm = (canRemember: boolean): Ask => ({ kind: 'permission', tool: 'WebFetch', title: 'Hämta från nätet?', detail: 'https://example.com', canRemember, defaultNo: false });
const HIST: Record<string, ChatEvent[]> = {
  [APP]: [
    { k: 'ask', id: 'p1', ask: perm(true), at: 1 },
    { k: 'ask', id: 'p2', ask: perm(false), at: 2 },
    { k: 'ask', id: 'q1', ask: { kind: 'question', questions: [{ question: 'Vilken leverantör?', multiSelect: false, options: [{ label: 'Gmail' }] }] }, at: 3 },
    { k: 'ask', id: 's1', ask: { kind: 'secret', key: 'imap_password', label: 'Lösenord' }, at: 4 },
    { k: 'ask', id: 'done', ask: perm(true), at: 5 },
    { k: 'ask-done', id: 'done', decision: 'allow' },
  ],
};
const ctx: ValidateCtx = {
  app: (id) => (id === APP ? { id, name: '', faces: [], permissions: [], built: false, status: 'waiting', backend: 'none', rev: 1 } : undefined),
  history: (id) => HIST[id] ?? [],
};
const win = { id: `w-${APP}`, appId: APP, x: 10.5, y: -3, w: 640, h: 480, scale: 1.5, face: 0, z: 3 };

describe('validateClientMsg', () => {
  const ok = (m: unknown) => {
    const v = validateClientMsg(m, ctx);
    assert.equal(v.ok, true, JSON.stringify(m) + (v.ok ? '' : ` -> ${v.error}`));
    return v.ok ? v.msg : null;
  };
  const bad = (m: unknown) => {
    const v = validateClientMsg(m, ctx);
    assert.equal(v.ok, false, `släpptes igenom: ${JSON.stringify(m)}`);
  };

  test('form och typ', () => {
    for (const m of [null, 1, 'hello', [], {}, { t: 1 }, { t: 'okänd' }, { t: 'hello' }, { t: 'hello', v: 2 }, { t: 'hello', v: '1' }]) bad(m);
    assert.deepEqual(ok({ t: 'hello', v: 1, extra: true }), { t: 'hello', v: 1 });
  });

  test('scene.window: heltal, gränser, appen finns, id = "w-" + appId; extra fält tas bort', () => {
    assert.deepEqual(ok({ t: 'scene.window', win: { ...win, hemligt: 'x' } }), { t: 'scene.window', win });
    for (const w of [
      { ...win, w: 640.5 }, { ...win, h: 159 }, { ...win, w: 2401 }, { ...win, scale: 0.04 }, { ...win, scale: 21 }, { ...win, x: '1' },
      { ...win, x: 2e9 }, { ...win, face: -1 }, { ...win, face: 6 }, { ...win, face: 0.5 }, { ...win, z: 1.5 }, { ...win, z: -1 }, { ...win, id: 'w-annan' },
      { ...win, appId: 'aokand12', id: 'w-aokand12' }, { ...win, appId: '../x' }, null, 'x',
      { ...win, minimized: -1 }, { ...win, minimized: 1.5 }, { ...win, minimized: '1' }, { ...win, minimized: null },
    ]) bad({ t: 'scene.window', win: w });
    // Ett minimerat fönster (§10.7) behåller fältet; utan fältet är fönstret inte minimerat.
    assert.deepEqual(ok({ t: 'scene.window', win: { ...win, minimized: 1792130000000 } }), { t: 'scene.window', win: { ...win, minimized: 1792130000000 } });
  });

  test('scene.camera: ändliga tal, zoom kläms till 0,05–8', () => {
    assert.deepEqual(ok({ t: 'scene.camera', camera: { cx: 1, cy: 2, zoom: 8.000000000000002 } }), { t: 'scene.camera', camera: { cx: 1, cy: 2, zoom: 8 } });
    assert.deepEqual(ok({ t: 'scene.camera', camera: { cx: 1, cy: 2, zoom: 0.5, x: 1 } }), { t: 'scene.camera', camera: { cx: 1, cy: 2, zoom: 0.5 } });
    for (const c of [{ cx: 1, cy: 2 }, { cx: 1, cy: 2, zoom: 0 }, { cx: 1, cy: 2, zoom: -1 }, { cx: 'a', cy: 2, zoom: 1 }, { cx: 1, cy: 2, zoom: null }, null]) {
      bad({ t: 'scene.camera', camera: c });
    }
  });

  test('chat.open/close/stop/send: appen finns, text och via', () => {
    for (const t of ['chat.open', 'chat.close', 'chat.stop']) {
      assert.deepEqual(ok({ t, appId: APP }), { t, appId: APP });
      bad({ t, appId: 'aokand12' });
      bad({ t, appId: '..' });
      bad({ t });
    }
    assert.deepEqual(ok({ t: 'chat.send', appId: APP, text: 'Jag vill ha en mejlklient', via: 'voice' }), { t: 'chat.send', appId: APP, text: 'Jag vill ha en mejlklient', via: 'voice' });
    for (const m of [
      { t: 'chat.send', appId: APP, text: '', via: 'text' }, { t: 'chat.send', appId: APP, text: '   ', via: 'text' },
      { t: 'chat.send', appId: APP, text: 'x', via: 'mejl' }, { t: 'chat.send', appId: APP, text: 5, via: 'text' },
      { t: 'chat.send', appId: APP, text: 'x'.repeat(100_001), via: 'text' }, { t: 'chat.send', appId: 'aokand12', text: 'x', via: 'text' },
    ]) bad(m);
  });

  test('chat.answer: askId finns och är obesvarat, beslutet passar frågan', () => {
    const a = (askId: string, decision: string, extra: Record<string, unknown> = {}) => ({ t: 'chat.answer', appId: APP, askId, decision, ...extra });
    assert.deepEqual(ok(a('p1', 'allow-always')), { t: 'chat.answer', appId: APP, askId: 'p1', decision: 'allow-always' });
    assert.deepEqual(ok(a('p2', 'deny', { secret: 'smuggel' })), { t: 'chat.answer', appId: APP, askId: 'p2', decision: 'deny' });
    assert.deepEqual(ok(a('q1', 'answered', { answers: { 'Vilken leverantör?': 'Gmail' } })), {
      t: 'chat.answer', appId: APP, askId: 'q1', decision: 'answered', answers: { 'Vilken leverantör?': 'Gmail' },
    });
    assert.deepEqual(ok(a('s1', 'answered', { secret: 'hunter2', answers: { x: 'y' } })), { t: 'chat.answer', appId: APP, askId: 's1', decision: 'answered', secret: 'hunter2' });
    bad(a('okänd', 'allow'));
    bad(a('done', 'allow'));
    bad(a('p2', 'allow-always'));
    bad(a('p1', 'answered'));
    bad(a('q1', 'allow'));
    bad(a('q1', 'answered'));
    bad(a('q1', 'answered', { answers: { x: 5 } }));
    bad(a('q1', 'answered', { answers: Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`f${i}`, 'x'])) }));
    bad(a('s1', 'answered'));
    bad(a('s1', 'answered', { secret: '' }));
    bad(a('s1', 'allow'));
    bad(a('p1', 'tillåt'));
    bad({ t: 'chat.answer', appId: APP, decision: 'allow' });
    bad({ t: 'chat.answer', appId: 'aokand12', askId: 'p1', decision: 'allow' });
  });

  test('felmeddelandet innehåller aldrig hemligheten', () => {
    const v = validateClientMsg({ t: 'chat.answer', appId: APP, askId: 'done', decision: 'answered', secret: 'HEMLIGT-123' }, ctx);
    assert.equal(v.ok, false);
    assert.ok(!JSON.stringify(v).includes('HEMLIGT-123'));
  });
});

/* ------------------------------ över en riktig anslutning ------------------------------ */

interface Client {
  ws: WebSocket;
  msgs: ServerMsg[];
  next(pred?: (m: ServerMsg) => boolean, ms?: number): Promise<ServerMsg>;
}

function connect(port: number, headers: Record<string, string>): Promise<Client | { status: number }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
    const msgs: ServerMsg[] = [];
    const waiters: { pred: (m: ServerMsg) => boolean; resolve: (m: ServerMsg) => void }[] = [];
    ws.on('message', (d) => {
      const m = JSON.parse(String(d)) as ServerMsg;
      msgs.push(m);
      for (const w of [...waiters]) {
        if (w.pred(m)) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve(m);
        }
      }
    });
    ws.on('unexpected-response', (_req, res) => {
      resolve({ status: res.statusCode ?? 0 });
      ws.terminate();
    });
    ws.on('error', (e) => {
      if (ws.readyState !== WebSocket.CLOSED) reject(e);
    });
    ws.on('open', () =>
      resolve({
        ws,
        msgs,
        next(pred = () => true, ms = 1000) {
          const seen = msgs.find(pred);
          if (seen) {
            msgs.splice(msgs.indexOf(seen), 1);
            return Promise.resolve(seen);
          }
          return new Promise((res, rej) => {
            const t = setTimeout(() => rej(new Error('inget meddelande')), ms);
            waiters.push({
              pred,
              resolve: (m) => {
                clearTimeout(t);
                msgs.splice(msgs.indexOf(m), 1);
                res(m);
              },
            });
          });
        },
      }),
    );
  });
}

const isClient = (c: Client | { status: number }): c is Client => 'ws' in c;
const quiet = (ms = 150) => new Promise((r) => setTimeout(r, ms));

describe('/ws över en riktig anslutning', () => {
  let s: Started;
  let leaky: Started;
  let root: string;
  const clients: Client[] = [];
  const own = (): Record<string, string> => ({ origin: `http://localhost:${s.port}`, host: `localhost:${s.port}` });

  before(async () => {
    root = tempDir('ws');
    s = await startRouter({ home: path.join(root, 'real') });
    leaky = await startRouter({ home: path.join(root, 'leaky'), guardFn: leakyGuard });
    for (const x of [s, leaky]) x.registry.add(APP, { name: 'Kanariefågel' });
  }, { timeout: 30_000 });
  afterEach(() => {
    for (const c of clients.splice(0)) c.ws.terminate();
    s.calls.length = 0;
  });
  after(async () => {
    await s?.close();
    await leaky?.close();
    rmDir(root);
  }, { timeout: 30_000 });

  async function open(headers: Record<string, string>, server = s): Promise<Client> {
    const c = await connect(server.port, headers);
    assert.ok(isClient(c), `uppgraderingen avvisades: ${JSON.stringify(c)}`);
    clients.push(c);
    return c;
  }

  test('kalibrering: med den planterade läckan får en främmande Origin en snapshot', async () => {
    const c = await connect(leaky.port, { origin: 'http://evil.example', host: `localhost:${leaky.port}` });
    assert.ok(isClient(c), 'detektorn larmar inte: den planterade läckan släppte inte in');
    clients.push(c);
    c.ws.send(JSON.stringify({ t: 'hello', v: 1 }));
    const snap = await c.next((m) => m.t === 'snapshot');
    assert.ok(JSON.stringify(snap).includes('Kanariefågel'));
  });

  test('främmande, saknad eller appens Origin, eller fel Host: uppgraderingen avvisas', async () => {
    const cases: [Record<string, string>, number][] = [
      [{ origin: 'http://evil.example', host: `localhost:${s.port}` }, 403],
      [{ host: `localhost:${s.port}` }, 403],
      [{ origin: `http://${APP}.localhost:${s.port}`, host: `localhost:${s.port}` }, 403],
      [{ origin: 'null', host: `localhost:${s.port}` }, 403],
      [{ origin: `http://localhost:${s.port}`, host: `evil.example:${s.port}` }, 421],
      [{ origin: `http://localhost:${s.port}`, host: `127.0.0.1:${s.port}` }, 308],
    ];
    for (const [headers, status] of cases) {
      const c = await connect(s.port, headers);
      assert.ok(!isClient(c), `släpptes in: ${JSON.stringify(headers)}`);
      assert.equal(c.status, status, JSON.stringify(headers));
    }
    assert.equal(s.hub.clients(), 0);
  });

  test('hello ger snapshot; utan hello kommer inga sändningar', async () => {
    const a = await open(own());
    const b = await open(own());
    a.ws.send(JSON.stringify({ t: 'hello', v: 1 }));
    const snap = await a.next((m) => m.t === 'snapshot');
    assert.deepEqual(snap, { t: 'snapshot', scene: s.scene.get(), apps: s.registry.list() });
    s.hub.broadcast({ t: 'app.removed', appId: 'axxxxxx1' });
    assert.deepEqual(await a.next((m) => m.t === 'app.removed'), { t: 'app.removed', appId: 'axxxxxx1' });
    await quiet();
    assert.deepEqual(b.msgs, [], 'en flik utan hello fick en sändning');
    assert.equal(s.hub.clients(), 2);
  });

  test('scene.window sparas och går till ANDRA flikar; scene.camera sparas', async () => {
    const a = await open(own());
    const b = await open(own());
    for (const c of [a, b]) {
      c.ws.send(JSON.stringify({ t: 'hello', v: 1 }));
      await c.next((m) => m.t === 'snapshot');
    }
    a.ws.send(JSON.stringify({ t: 'scene.window', win }));
    assert.deepEqual(await b.next((m) => m.t === 'scene.window'), { t: 'scene.window', win });
    await quiet();
    assert.ok(!a.msgs.some((m) => m.t === 'scene.window'), 'avsändaren fick sitt eget fönster tillbaka');
    assert.ok(s.calls.includes(`scene.upsertWindow w-${APP}`));
    a.ws.send(JSON.stringify({ t: 'scene.camera', camera: { cx: 5, cy: 6, zoom: 2 } }));
    await quiet(50);
    assert.ok(s.calls.includes('scene.setCamera 5 6 2'));
    assert.ok(!b.msgs.some((m) => (m as { t: string }).t === 'scene.camera'));
  });

  test('chat.* går till sessions med exakt de validerade värdena', async () => {
    const a = await open(own());
    s.sessions.hist.set(APP, [{ k: 'ask', id: 's9', ask: { kind: 'secret', key: 'k', label: 'Lösenord' }, at: 1 }]);
    a.ws.send(JSON.stringify({ t: 'chat.open', appId: APP }));
    a.ws.send(JSON.stringify({ t: 'chat.send', appId: APP, text: 'Bygg en klocka', via: 'text' }));
    a.ws.send(JSON.stringify({ t: 'chat.stop', appId: APP }));
    a.ws.send(JSON.stringify({ t: 'chat.answer', appId: APP, askId: 's9', decision: 'answered', secret: 'hunter2' }));
    a.ws.send(JSON.stringify({ t: 'chat.close', appId: APP }));
    await quiet();
    const chat = s.calls.filter((c) => !c.startsWith('sessions.history'));
    assert.deepEqual(chat, [
      `sessions.open ${APP}`, `sessions.send ${APP} text Bygg en klocka`, `sessions.stop ${APP}`, `sessions.answer ${APP} s9 answered`, `sessions.close ${APP}`,
    ]);
    assert.deepEqual(s.sessions.answerCalls.at(-1), { appId: APP, askId: 's9', decision: 'answered', answers: undefined, secret: 'hunter2' });
  });

  // HUD:en per flik (§8.1): en flik som stängs med HUD:en öppen skickar aldrig chat.close. Utan spårning per
  // flik blir hudOpen kvar för alltid, så processen stängs aldrig och hoppas över när taket trimmas.
  test('HUD:en per flik: en stängd flik stänger sessionen, men först när ingen annan flik har den öppen', async () => {
    const closes = () => s.calls.filter((c) => c === `sessions.close ${APP}`).length;
    const hud = async () => {
      const c = await open(own());
      c.ws.send(JSON.stringify({ t: 'chat.open', appId: APP }));
      return c;
    };
    const gone = async (c: Client) => {
      const closed = new Promise((r) => c.ws.once('close', r));
      c.ws.terminate(); // som att stänga fliken: inget chat.close
      await closed;
      await quiet();
    };
    // En flik: stängs den utan chat.close ska sessionen ändå stängas.
    const a = await hud();
    await quiet(50);
    assert.ok(s.calls.includes(`sessions.open ${APP}`));
    await gone(a);
    assert.equal(closes(), 1, 'en flik som stängdes med HUD:en öppen lämnade sessionen öppen');
    // Två flikar: sessionen stängs först när båda är borta.
    const b = await hud();
    const c = await hud();
    await quiet(50);
    await gone(b);
    assert.equal(closes(), 1, 'sessionen stängdes fast en annan flik har HUD:en öppen');
    await gone(c);
    assert.equal(closes(), 2);
    // chat.close från en av två flikar behåller HUD:en öppen; den sista stänger.
    const d = await hud();
    const e = await hud();
    await quiet(50);
    d.ws.send(JSON.stringify({ t: 'chat.close', appId: APP }));
    await quiet();
    assert.equal(closes(), 2, 'chat.close i en flik stängde HUD:en för den andra');
    e.ws.send(JSON.stringify({ t: 'chat.close', appId: APP }));
    await quiet();
    assert.equal(closes(), 3);
    // Redan stängd i båda: att flikarna sedan stängs ger inga fler anrop.
    await gone(d);
    await gone(e);
    assert.equal(closes(), 3);
  });

  test('ogiltiga meddelanden ignoreras och ger { t: "error" }', async () => {
    const a = await open(own());
    const sends: (string | Buffer)[] = [
      'inte json', Buffer.from([1, 2, 3]), JSON.stringify({ t: 'okänd' }), JSON.stringify({ t: 'scene.window', win: { ...win, w: 640.5 } }),
      JSON.stringify({ t: 'chat.send', appId: 'aokand12', text: 'x', via: 'text' }), JSON.stringify({ t: 'chat.answer', appId: APP, askId: 'saknas', decision: 'allow' }),
    ];
    for (const d of sends) {
      a.ws.send(d);
      const m = await a.next((x) => x.t === 'error');
      assert.equal(m.t, 'error');
    }
    assert.ok(!s.calls.some((c) => c.startsWith('scene.') || c.startsWith('sessions.send') || c.startsWith('sessions.answer')));
    assert.equal(a.ws.readyState, WebSocket.OPEN, 'ett ogiltigt meddelande stänger inte anslutningen');
  });

  test('för stora meddelanden stänger anslutningen (maxPayload)', async () => {
    const a = await open(own());
    const closed = new Promise<number>((r) => a.ws.on('close', (code) => r(code)));
    a.ws.send(JSON.stringify({ t: 'chat.send', appId: APP, text: 'x'.repeat(1024 * 1024 + 10), via: 'text' }));
    assert.equal(await closed, 1009);
    assert.ok(!s.calls.some((c) => c.startsWith('sessions.send')));
  });
});
