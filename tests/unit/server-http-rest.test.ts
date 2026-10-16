// REST på skalets origin (CONTRACT §7.1) och flödena i §7.4: validering, id-kontroll och anropsordning.
import { after, afterEach, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import type { SttResponse } from '../../shared/protocol.ts';
import type { Config } from '../../server/types.ts';
import { parseCreateApp } from '../../server/http/rest.ts';
import { HttpError } from '../../server/http/util.ts';
import { request, rmDir, sameOrigin, startRouter, tempDir } from './server-http-fakes.test.ts';
import type { Started } from './server-http-fakes.test.ts';

const APP = 'arest123';

describe('parseCreateApp (§5)', () => {
  const ok = { x: 10.5, y: -20, w: 640, h: 480, scale: 1.25 };
  test('giltig begäran, extra fält tas bort', () => {
    assert.deepEqual(parseCreateApp({ ...ok, extra: 'bort', z: 99 }), ok);
    assert.deepEqual(parseCreateApp({ x: 0, y: 0, w: 240, h: 160, scale: 0.05 }), { x: 0, y: 0, w: 240, h: 160, scale: 0.05 });
    assert.deepEqual(parseCreateApp({ x: 0, y: 0, w: 2400, h: 1600, scale: 20 }), { x: 0, y: 0, w: 2400, h: 1600, scale: 20 });
  });
  test('icke-heltal och värden utanför gränserna avvisas', () => {
    const bad: unknown[] = [
      null, [], 'x', { ...ok, w: 640.5 }, { ...ok, h: 480.25 }, { ...ok, w: 239 }, { ...ok, w: 2401 }, { ...ok, h: 159 }, { ...ok, h: 1601 },
      { ...ok, scale: 0.049 }, { ...ok, scale: 20.01 }, { ...ok, x: '1' }, { ...ok, y: null }, { ...ok, w: '640' },
      { ...ok, x: 1e10 }, { x: 0, y: 0, w: 640, h: 480 }, { ...ok, scale: Infinity },
    ];
    for (const b of bad) assert.throws(() => parseCreateApp(b), (e: unknown) => e instanceof HttpError && e.status === 400, JSON.stringify(b));
  });
});

describe('REST', () => {
  let s: Started;
  let root: string;
  const stt: { calls: { mime: string; bytes: number; hints: string[] }[]; result: SttResponse | Error } = { calls: [], result: { text: 'Jag vill ha en mejlklient', provider: 'whisper' } };
  const origin = (): string => `http://localhost:${s.port}`;
  const post = (p: string, body?: string, headers: Record<string, string> = {}) =>
    request(s.port, { method: 'POST', path: p, headers: { ...sameOrigin(origin()), ...headers }, body });
  const json = (p: string, body: unknown) => post(p, JSON.stringify(body), { 'content-type': 'application/json' });

  const routes: Array<{ text: string; known: unknown }> = [];
  const ideas: { calls: string[]; result: { rev: number; items: string[] } | Error } = { calls: [], result: { rev: 1, items: ['Lägg till ett mörkt läge'] } };

  before(async () => {
    root = tempDir('rest');
    s = await startRouter({
      home: path.join(root, 'home'),
      route: async (text: string, known: unknown) => {
        routes.push({ text, known });
        return { action: 'build', name: 'Ny app', prompt: text };
      },
      ideas: async (id: string) => {
        ideas.calls.push(id);
        if (ideas.result instanceof Error) throw ideas.result;
        return ideas.result;
      },
      transcribe: async (_config: Config, audio: Buffer, mime: string, hints: string[]) => {
        stt.calls.push({ mime, bytes: audio.length, hints });
        if (stt.result instanceof Error) throw stt.result;
        return stt.result;
      },
    });
  });
  afterEach(() => {
    s.calls.length = 0;
    s.sessions.busySet.clear();
  });
  after(async () => {
    await s.close();
    rmDir(root);
  });

  test('POST /api/apps/:id/ideas (§8.12): förslagen för en byggd app; GET 405, obyggd 409, fel 503, okänd 404', async () => {
    s.registry.add('aidea123', { name: 'Kalender', index: '<p>hej</p>' });
    s.registry.add('aidea456', { name: 'Fröet' });
    ideas.calls.length = 0;
    const r = await post('/api/apps/aidea123/ideas');
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.text), { rev: 1, items: ['Lägg till ett mörkt läge'] });
    assert.deepEqual(ideas.calls, ['aidea123']);
    // En GET får aldrig kosta en fråga till Claude.
    assert.equal((await request(s.port, { path: '/api/apps/aidea123/ideas', headers: sameOrigin() })).status, 405);
    assert.equal((await post('/api/apps/aidea456/ideas')).status, 409, 'obyggd');
    assert.equal((await post('/api/apps/aokand99/ideas')).status, 404);
    ideas.result = new Error('ingen kontakt');
    const fail = await post('/api/apps/aidea123/ideas');
    assert.equal(fail.status, 503);
    assert.ok(!fail.text.includes('ingen kontakt'), 'felet läcker inte till skalet');
    ideas.result = { rev: 1, items: ['Lägg till ett mörkt läge'] };
    assert.deepEqual(ideas.calls, ['aidea123', 'aidea123'], 'GET, obyggd och okänd frågade aldrig');
  });

  test('POST /api/route (§8.13): text krävs, det skalet känt igen kontrolleras igen, bara POST', async () => {
    routes.length = 0;
    const r = await json('/api/route', { text: 'köp mjölk', known: null });
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.text), { action: 'build', name: 'Ny app', prompt: 'köp mjölk' });
    await json('/api/route', { text: 'dn.se', known: { kind: 'url', url: 'dn.se' } });
    await json('/api/route', { text: 'x', known: { kind: 'url', url: 'javascript:alert(1)' } });
    assert.deepEqual(routes.map((x) => x.known), [null, { kind: 'url', url: 'https://dn.se/' }, null]);
    for (const body of [{}, { text: '' }, { text: '  ' }, { text: 5 }, { text: 'x'.repeat(2001) }]) assert.equal((await json('/api/route', body)).status, 400, JSON.stringify(body));
    assert.equal((await request(s.port, { path: '/api/route', headers: sameOrigin() })).status, 405);
    assert.equal((await post('/api/route', 'köp', { 'content-type': 'text/plain' })).status, 415);
    assert.equal(routes.length, 3, 'felaktiga förfrågningar frågade aldrig');
  });

  test('GET /api/snapshot: { scene, apps } och skalets huvuden', async () => {
    s.registry.add(APP, { name: 'Mejl' });
    const r = await request(s.port, { path: '/api/snapshot', headers: sameOrigin() });
    assert.equal(r.status, 200);
    const body = JSON.parse(r.text) as { scene: unknown; apps: { id: string }[] };
    assert.deepEqual(body.scene, s.scene.get());
    assert.ok(body.apps.some((a) => a.id === APP));
    assert.equal(r.headers['x-frame-options'], 'DENY');
    assert.equal(r.headers['referrer-policy'], 'same-origin');
    assert.match(String(r.headers['content-security-policy']), /^default-src 'self'; /);
    assert.equal(r.headers['cache-control'], 'no-store');
  });

  test('POST /api/apps: validerad begäran till registry.create, svar { app, win }', async () => {
    const r = await json('/api/apps', { x: 1, y: 2, w: 640, h: 480, scale: 1, smuggla: true });
    assert.equal(r.status, 200);
    const body = JSON.parse(r.text) as { app: { id: string }; win: { id: string; appId: string } };
    assert.equal(body.win.id, `w-${body.app.id}`);
    assert.deepEqual(s.registry.created.at(-1), { x: 1, y: 2, w: 640, h: 480, scale: 1 });
  });

  test('POST /api/apps: fel ger 400/413/415 och registry.create anropas aldrig', async () => {
    assert.equal((await json('/api/apps', { x: 1, y: 2, w: 640.5, h: 480, scale: 1 })).status, 400);
    assert.equal((await json('/api/apps', { x: 1, y: 2, w: 640, h: 480, scale: 0 })).status, 400);
    assert.equal((await post('/api/apps', '{inte json', { 'content-type': 'application/json' })).status, 400);
    assert.equal((await post('/api/apps', JSON.stringify({ x: 1, y: 2, w: 640, h: 480, scale: 1 }), { 'content-type': 'text/plain' })).status, 415);
    assert.equal((await post('/api/apps', JSON.stringify({ pad: 'x'.repeat(70_000) }), { 'content-type': 'application/json' })).status, 413);
    assert.equal((await request(s.port, { path: '/api/apps', headers: sameOrigin() })).status, 405);
    assert.ok(!s.calls.includes('registry.create'));
  });

  test('id-kontroll: ..%2F..%2Fx och andra ogiltiga id ger 404 utan ett enda anrop', async () => {
    for (const id of ['..%2F..%2Fx', '..', 'A..', '%2e%2e', 'aokand99', 'a%00bc', 'ABC123', '%zz', 'a', `${APP}%2F..`]) {
      for (const [method, suffix] of [['DELETE', ''], ['POST', '/undo'], ['GET', '/chat']] as const) {
        const r = await request(s.port, { method, path: `/api/apps/${id}${suffix}`, headers: sameOrigin(origin()) });
        assert.equal(r.status, 404, `${method} ${id}${suffix}`);
      }
    }
    assert.deepEqual(s.calls, []);
    assert.equal((await request(s.port, { path: '/api/okand', headers: sameOrigin() })).status, 404);
    assert.equal((await request(s.port, { path: `/api/apps/${APP}/x`, headers: sameOrigin() })).status, 404);
  });

  test('DELETE: forget → stop → remove → logs.clear → { ok: true }', async () => {
    s.registry.add('adelete1');
    const r = await request(s.port, { method: 'DELETE', path: '/api/apps/adelete1', headers: sameOrigin(origin()) });
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.text), { ok: true });
    assert.deepEqual(s.calls, ['sessions.forget adelete1', 'backends.stop adelete1', 'registry.remove adelete1', 'logs.clear adelete1']);
    const again = await request(s.port, { method: 'DELETE', path: '/api/apps/adelete1', headers: sameOrigin(origin()) });
    assert.equal(again.status, 404);
  });

  test('ångra: 409 medan Claude arbetar, inget git-anrop', async () => {
    s.registry.add('aundo123');
    s.sessions.busySet.add('aundo123');
    const r = await post('/api/apps/aundo123/undo');
    assert.equal(r.status, 409);
    assert.deepEqual(s.calls, []);
  });

  test('ångra med backend: undo → refresh → restart → bumpRev → noteUndo', async () => {
    s.registry.add('aundo456', { backend: true });
    s.git.undoResult = true;
    const r = await post('/api/apps/aundo456/undo');
    assert.deepEqual(JSON.parse(r.text), { ok: true });
    assert.deepEqual(s.calls, [
      'git.undo aundo456', 'registry.refresh aundo456', 'backends.restart aundo456', 'registry.bumpRev aundo456', 'sessions.noteUndo aundo456',
    ]);
  });

  test('ångra utan backend anropar ändå restart (villkorslöst, §7.4); inget att ångra ger { ok: false } och inget mer', async () => {
    s.registry.add('aundo789');
    s.git.undoResult = true;
    await post('/api/apps/aundo789/undo');
    assert.deepEqual(s.calls, ['git.undo aundo789', 'registry.refresh aundo789', 'backends.restart aundo789', 'registry.bumpRev aundo789', 'sessions.noteUndo aundo789']);
    s.calls.length = 0;
    s.git.undoResult = false;
    const r = await post('/api/apps/aundo789/undo');
    assert.deepEqual(JSON.parse(r.text), { ok: false });
    assert.deepEqual(s.calls, ['git.undo aundo789']);
    s.git.undoResult = true;
  });

  test('ångra som tar bort backenden ur manifestet: restart (som stoppar den gamla processen) före bumpRev', async () => {
    s.registry.add('aundobk1');
    s.backends.states.set('aundobk1', 'running');
    s.git.undoResult = true;
    await post('/api/apps/aundobk1/undo');
    assert.deepEqual(s.calls, [
      'git.undo aundobk1', 'registry.refresh aundobk1', 'backends.restart aundobk1', 'registry.bumpRev aundobk1', 'sessions.noteUndo aundobk1',
    ]);
  });

  test('samtidiga ångra för samma app körs efter varandra', async () => {
    s.registry.add('aundoxx1');
    let inside = 0;
    let maxInside = 0;
    const orig = s.git.undo;
    s.git.undo = async (id) => {
      inside++;
      maxInside = Math.max(maxInside, inside);
      await new Promise((r) => setTimeout(r, 20));
      inside--;
      return orig(id);
    };
    await Promise.all([post('/api/apps/aundoxx1/undo'), post('/api/apps/aundoxx1/undo'), post('/api/apps/aundoxx1/undo')]);
    s.git.undo = orig;
    assert.equal(maxInside, 1);
  });

  test('GET /api/apps/:id/chat: { events: history(id, 300) }', async () => {
    s.registry.add('achat123');
    s.sessions.hist.set('achat123', [{ k: 'user', id: 'u1', text: 'Hej', via: 'text', at: 1 }]);
    const r = await request(s.port, { path: '/api/apps/achat123/chat', headers: sameOrigin() });
    assert.deepEqual(JSON.parse(r.text), { events: [{ k: 'user', id: 'u1', text: 'Hej', via: 'text', at: 1 }] });
    assert.deepEqual(s.calls, ['sessions.history achat123 300']);
  });

  test('POST /api/stt: mediatypen före ";", appnamnen som ledtrådar', async () => {
    stt.calls.length = 0;
    stt.result = { text: 'Jag vill ha en mejlklient', provider: 'whisper' };
    s.registry.add('astt1234', { name: 'Kalender' });
    const r = await post('/api/stt', 'ljud', { 'content-type': 'audio/webm;codecs=opus' });
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.text), { text: 'Jag vill ha en mejlklient', provider: 'whisper' });
    assert.equal(stt.calls[0].mime, 'audio/webm');
    assert.equal(stt.calls[0].bytes, 4);
    assert.ok(stt.calls[0].hints.includes('Kalender'));
    assert.ok(stt.calls[0].hints.includes('Mejl'));
    assert.ok(!stt.calls[0].hints.includes(''));
    assert.equal((await post('/api/stt', 'ljud', { 'content-type': 'Audio/MP4' })).status, 200);
    assert.equal(stt.calls[1].mime, 'audio/mp4');
  });

  test('POST /api/stt: 415 för annat än audio/webm och audio/mp4, 413 över 10 MB, 400 tomt, 503 när inget fungerar', async () => {
    stt.calls.length = 0;
    for (const type of ['audio/ogg', 'audio/wav', 'video/webm', 'text/plain', 'audio/webmx', '']) {
      const r = await post('/api/stt', 'ljud', type ? { 'content-type': type } : {});
      assert.equal(r.status, 415, type);
    }
    const big = Buffer.alloc(10 * 1024 * 1024 + 1, 1);
    assert.equal((await request(s.port, { method: 'POST', path: '/api/stt', headers: { ...sameOrigin(origin()), 'content-type': 'audio/webm' }, body: big })).status, 413);
    assert.equal((await post('/api/stt', '', { 'content-type': 'audio/webm' })).status, 400);
    assert.equal(stt.calls.length, 0);
    stt.result = new Error('allt nere');
    const warn = console.warn;
    console.warn = () => {};
    const r = await post('/api/stt', 'ljud', { 'content-type': 'audio/webm' }).finally(() => {
      console.warn = warn;
    });
    assert.equal(r.status, 503);
    assert.ok(!r.text.includes('allt nere'), 'interna fel skickas inte till klienten');
  });

  test('/ws utan uppgradering ger 426', async () => {
    assert.equal((await request(s.port, { path: '/ws', headers: sameOrigin() })).status, 426);
  });
});
