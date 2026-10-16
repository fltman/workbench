// /__wb/* på appens origin (CONTRACT §7.2): store, loggar, wb.js och app.json.
// Testerna av symboliska länkar i data/ kalibreras först mot en naiv skrivare/läsare som MÅSTE läcka.
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { LOG_BURST, LOG_RATE_PER_S, createWbApi, logLine } from '../../server/http/wbapi.ts';
import { request, rmDir, sameOrigin, startRouter, tempDir } from './server-http-fakes.test.ts';
import type { Started } from './server-http-fakes.test.ts';

const APP = 'astore12';

describe('/__wb/store', () => {
  let s: Started;
  let root: string;
  let appDir: string;
  const host = (): string => `${APP}.localhost:${s.port}`;
  const origin = (): string => `http://${APP}.localhost:${s.port}`;
  const get = (p: string, extra: Record<string, string> = {}) => request(s.port, { path: p, host: host(), headers: { ...sameOrigin(), ...extra } });
  const put = (p: string, body: string, headers: Record<string, string> = {}) =>
    request(s.port, { method: 'PUT', path: p, host: host(), headers: { ...sameOrigin(origin()), 'content-type': 'application/json', ...headers }, body });
  const del = (p: string) => request(s.port, { method: 'DELETE', path: p, host: host(), headers: sameOrigin(origin()) });

  before(async () => {
    root = tempDir('store');
    s = await startRouter({ home: path.join(root, 'home') });
    s.registry.add(APP, { name: 'Lager', index: '<p>x</p>' });
    appDir = s.paths.appDir(APP);
  });
  beforeEach(() => {
    fs.rmSync(path.join(appDir, 'data'), { recursive: true, force: true });
  });
  after(async () => {
    await s.close();
    rmDir(root);
  });

  test('tomt från början, sedan set/get/all/delete', async () => {
    let r = await get('/__wb/store');
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.text), {});
    assert.equal((await get('/__wb/store/anteckningar')).status, 404);

    r = await put('/__wb/store/anteckningar', JSON.stringify({ text: 'Köp mjölk', klar: false }));
    assert.equal(r.status, 204);
    r = await get('/__wb/store/anteckningar');
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-type'], 'application/json; charset=utf-8');
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.deepEqual(JSON.parse(r.text), { text: 'Köp mjölk', klar: false });

    await put('/__wb/store/tal', '42');
    await put('/__wb/store/inget', 'null');
    r = await get('/__wb/store');
    assert.deepEqual(JSON.parse(r.text), { anteckningar: { text: 'Köp mjölk', klar: false }, tal: 42, inget: null });
    assert.equal((await get('/__wb/store/inget')).text, 'null');

    r = await del('/__wb/store/tal');
    assert.equal(r.status, 204);
    assert.equal((await get('/__wb/store/tal')).status, 404);
    assert.equal((await del('/__wb/store/finns-inte')).status, 204);
  });

  test('saknad nyckel: 204 utan kropp med x-wb-optional (som wb.js skickar), annars 404 (K6)', async () => {
    const plain = await get('/__wb/store/finnsinte');
    assert.equal(plain.status, 404);
    const opt = await get('/__wb/store/finnsinte', { 'x-wb-optional': '1' });
    assert.equal(opt.status, 204);
    assert.equal(opt.text, '');
    assert.equal(opt.headers['cache-control'], 'no-store');
    // En nyckel som finns svarar som vanligt även med huvudet.
    await put('/__wb/store/finns', '"ja"');
    const hit = await get('/__wb/store/finns', { 'x-wb-optional': '1' });
    assert.equal(hit.status, 200);
    assert.equal(hit.text, '"ja"');
    // HEAD följer GET: 204 med huvudet, 404 utan, 200 för en nyckel som finns.
    const head = (p: string, extra: Record<string, string> = {}) => request(s.port, { method: 'HEAD', path: p, host: host(), headers: { ...sameOrigin(), ...extra } });
    assert.equal((await head('/__wb/store/finnsinte', { 'x-wb-optional': '1' })).status, 204);
    assert.equal((await head('/__wb/store/finnsinte')).status, 404);
    assert.equal((await head('/__wb/store/finns')).status, 200);
    // Bara värdet 1 räknas; ett annat värde ger 404 som förut.
    assert.equal((await get('/__wb/store/finnsinte', { 'x-wb-optional': 'true' })).status, 404);
  });

  test('skrivs atomiskt till apps/<id>/data/store.json utan rester', async () => {
    await put('/__wb/store/a', '"å"');
    const files = fs.readdirSync(path.join(appDir, 'data'));
    assert.deepEqual(files, ['store.json']);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(appDir, 'data', 'store.json'), 'utf8')), { a: 'å' });
  });

  test('nycklar: [A-Za-z0-9._-]{1,100}, men varken "." eller ".."', async () => {
    for (const key of ['a', 'A.b_c-1', '...', '.a', 'x'.repeat(100)]) {
      assert.equal((await put(`/__wb/store/${key}`, '1')).status, 204, key);
      assert.equal((await get(`/__wb/store/${key}`)).text, '1', key);
    }
    for (const key of ['', 'a:b', 'a%2Fb', 'å', 'x'.repeat(101), 'a%20b', '%zz', '.', '..', '%2E', '%2E%2E']) {
      const r = await put(`/__wb/store/${key}`, '1');
      assert.equal(r.status, 400, `nyckeln ${JSON.stringify(key)} gav ${r.status}`);
      assert.equal((await get(`/__wb/store/${key}`)).status, 400, `GET ${JSON.stringify(key)}`);
    }
    assert.equal((await get('/__wb/store/a/b')).status, 400);
    // Ingen fil utanför data/ skapas.
    assert.deepEqual(fs.readdirSync(appDir).sort(), ['data', 'index.html']);
  });

  test('"__proto__" är en vanlig nyckel, ingen prototypförorening', async () => {
    assert.equal((await put('/__wb/store/__proto__', JSON.stringify({ polluted: true }))).status, 204);
    assert.deepEqual(JSON.parse((await get('/__wb/store/__proto__')).text), { polluted: true });
    const all = JSON.parse((await get('/__wb/store')).text) as Record<string, unknown>;
    assert.ok(Object.hasOwn(all, '__proto__'));
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
    assert.equal((await get('/__wb/store/constructor')).status, 404);
    assert.equal((await get('/__wb/store/toString')).status, 404);
  });

  test('PUT: ogiltig JSON 400, över 1 MB 413', async () => {
    assert.equal((await put('/__wb/store/a', '{inte json')).status, 400);
    assert.equal((await put('/__wb/store/a', '')).status, 400);
    const big = JSON.stringify('x'.repeat(1024 * 1024));
    assert.equal((await put('/__wb/store/a', big)).status, 413);
    const ok = JSON.stringify('x'.repeat(1024 * 1024 - 10));
    assert.equal((await put('/__wb/store/a', ok)).status, 204);
  });

  test('413 och 415 når klienten även med connection: close mitt i uppladdningen (20 samtidiga)', async () => {
    const big = JSON.stringify('x'.repeat(2 * 1024 * 1024));
    const rs = await Promise.all(Array.from({ length: 20 }, () => put('/__wb/store/a', big, { connection: 'close' })));
    assert.deepEqual(rs.map((r) => r.status), Array(20).fill(413));
    const sttLike = await Promise.all(
      Array.from({ length: 10 }, () =>
        request(s.port, { method: 'POST', path: '/api/stt', headers: { ...sameOrigin(`http://localhost:${s.port}`), 'content-type': 'audio/ogg', connection: 'close' }, body: Buffer.alloc(3 * 1024 * 1024) }),
      ),
    );
    assert.deepEqual(sttLike.map((r) => r.status), Array(10).fill(415));
  });

  test('metoder: POST på store ger 405', async () => {
    const r = await request(s.port, { method: 'POST', path: '/__wb/store/a', host: host(), headers: sameOrigin(origin()), body: '1' });
    assert.equal(r.status, 405);
    assert.equal((await request(s.port, { method: 'PUT', path: '/__wb/store', host: host(), headers: sameOrigin(origin()), body: '{}' })).status, 405);
  });

  test('samtidiga PUT tappar ingen nyckel (lås per app)', async () => {
    await Promise.all(Array.from({ length: 20 }, (_, i) => put(`/__wb/store/k${i}`, String(i))));
    const all = JSON.parse((await get('/__wb/store')).text) as Record<string, number>;
    assert.equal(Object.keys(all).length, 20);
  });

  test('data/ som symbolisk länk: skrivning vägras (kalibrerad mot en naiv skrivare)', async () => {
    const outside = path.join(root, 'utanfor-skriv');
    fs.rmSync(outside, { recursive: true, force: true });
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(appDir, 'data'));
    const detector = (): boolean => fs.existsSync(path.join(outside, 'store.json'));

    // Planterad läcka: den naiva skrivaren litar på sökvägen och skriver utanför appen.
    fs.writeFileSync(path.join(appDir, 'data', 'store.json'), '{"a":1}');
    assert.equal(detector(), true, 'detektorn ser inte den planterade läckan');
    fs.rmSync(path.join(outside, 'store.json'));
    assert.equal(detector(), false);

    const r = await put('/__wb/store/a', '1');
    assert.equal(r.status, 403);
    assert.equal(detector(), false, 'store.json skrevs utanför appen');
    assert.deepEqual(fs.readdirSync(outside), []);
    fs.unlinkSync(path.join(appDir, 'data'));
  });

  test('data/ som symbolisk länk: läsning vägras (kalibrerad)', async () => {
    const outside = path.join(root, 'utanfor-las');
    fs.rmSync(outside, { recursive: true, force: true });
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'store.json'), JSON.stringify({ hemlig: 'KANARIE-LÄS' }));
    fs.symlinkSync(outside, path.join(appDir, 'data'));
    // Planterad läcka: en naiv läsare följer länken.
    assert.ok(fs.readFileSync(path.join(appDir, 'data', 'store.json'), 'utf8').includes('KANARIE-LÄS'));
    const r = await get('/__wb/store');
    assert.equal(r.status, 403);
    assert.ok(!r.text.includes('KANARIE-LÄS'));
    fs.unlinkSync(path.join(appDir, 'data'));
  });

  test('store.json som symbolisk länk läses aldrig (O_NOFOLLOW) och skrivs aldrig igenom', async () => {
    const outside = path.join(root, 'utanfor-fil');
    fs.mkdirSync(outside, { recursive: true });
    const target = path.join(outside, 'hemlig.json');
    fs.writeFileSync(target, JSON.stringify({ hemlig: 'KANARIE-FIL' }));
    fs.mkdirSync(path.join(appDir, 'data'));
    fs.symlinkSync(target, path.join(appDir, 'data', 'store.json'));
    // Planterad läcka: readFile följer länken.
    assert.ok(fs.readFileSync(path.join(appDir, 'data', 'store.json'), 'utf8').includes('KANARIE-FIL'));
    const r = await get('/__wb/store');
    assert.ok(r.status >= 400);
    assert.ok(!r.text.includes('KANARIE-FIL'));
    assert.ok((await put('/__wb/store/a', '1')).status >= 400);
    assert.equal(fs.readFileSync(target, 'utf8'), JSON.stringify({ hemlig: 'KANARIE-FIL' }), 'målet för länken ändrades');
  });

  test('en trasig store.json ger 500, aldrig tyst dataförlust', async () => {
    fs.mkdirSync(path.join(appDir, 'data'));
    fs.writeFileSync(path.join(appDir, 'data', 'store.json'), '{trasig');
    assert.equal((await get('/__wb/store')).status, 500);
    assert.equal((await put('/__wb/store/a', '1')).status, 500);
    assert.equal(fs.readFileSync(path.join(appDir, 'data', 'store.json'), 'utf8'), '{trasig');
  });
});

describe('/__wb/log, /__wb/wb.js och /__wb/app.json', () => {
  let s: Started;
  let root: string;
  const host = (): string => `${APP}.localhost:${s.port}`;
  const origin = (): string => `http://${APP}.localhost:${s.port}`;
  const log = (body: string) =>
    request(s.port, { method: 'POST', path: '/__wb/log', host: host(), headers: { ...sameOrigin(origin()), 'content-type': 'application/json' }, body });

  before(async () => {
    root = tempDir('wbapi');
    // En egen rot med sdk/wb.js, så att testet inte beror på bryggans fil.
    fs.mkdirSync(path.join(root, 'repo', 'sdk'), { recursive: true });
    fs.writeFileSync(path.join(root, 'repo', 'sdk', 'wb.js'), '/* wb */ window.wb = {};');
    s = await startRouter({ home: path.join(root, 'home'), root: path.join(root, 'repo') });
    s.registry.add(APP, { name: 'Loggar', faces: [{ id: 'main', page: 'index.html' }, { id: 'baksida', page: 'b.html', label: 'Baksida' }] });
  });
  after(async () => {
    await s.close();
    rmDir(root);
  });

  test('wb.js: text/javascript; charset=utf-8 och no-store', async () => {
    const r = await request(s.port, { path: '/__wb/wb.js', host: host(), headers: { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'script' } });
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-type'], 'text/javascript; charset=utf-8');
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal(r.text, '/* wb */ window.wb = {};');
  });

  test('wb.js finns bara på appernas origins', async () => {
    const r = await request(s.port, { path: '/__wb/wb.js', headers: sameOrigin() });
    assert.notEqual(r.text, '/* wb */ window.wb = {};');
  });

  test('app.json: { id, name, faces }', async () => {
    const r = await request(s.port, { path: '/__wb/app.json', host: host(), headers: sameOrigin() });
    assert.deepEqual(JSON.parse(r.text), {
      id: APP, name: 'Loggar', faces: [{ id: 'main', page: 'index.html' }, { id: 'baksida', page: 'b.html', label: 'Baksida' }],
    });
  });

  test('log: poster läggs i logs med källan console', async () => {
    s.logs.lines.length = 0;
    const r = await log(JSON.stringify([
      { level: 'error', text: 'Uncaught TypeError: x är odefinierad\n    at index.html:3' },
      { level: 'warn', text: 'varning' },
      { level: 'log', text: 'hej' },
    ]));
    assert.equal(r.status, 204);
    assert.deepEqual(s.logs.lines, [
      { appId: APP, source: 'console', line: 'error: Uncaught TypeError: x är odefinierad ⏎     at index.html:3' },
      { appId: APP, source: 'console', line: 'warn: varning' },
      { appId: APP, source: 'console', line: 'log: hej' },
    ]);
  });

  test('log: ogiltiga kroppar ger 400', async () => {
    const bad = [
      '{}', 'inte json', JSON.stringify([{ level: 'info', text: 'x' }]), JSON.stringify([{ level: 'error' }]),
      JSON.stringify([{ level: 'error', text: 5 }]), JSON.stringify(Array.from({ length: 51 }, () => ({ level: 'log', text: 'x' }))),
    ];
    for (const b of bad) assert.equal((await log(b)).status, 400, b.slice(0, 40));
    const get = await request(s.port, { path: '/__wb/log', host: host() });
    assert.equal(get.status, 405);
  });

  test('log: text kortas till 2000 tecken och kontrolltecken plattas till', () => {
    const line = logLine('error', 'x'.repeat(5000));
    assert.equal(line, `error: ${'x'.repeat(2000)}…`);
    assert.equal(logLine('log', 'a\r\nb\u0000c\u001bd\te'), 'log: a ⏎ b c d\te');
    // En app kan inte förfalska en rad från en annan källa.
    assert.equal(logLine('log', 'x\n12:00:00 [workbench] falsk'), 'log: x ⏎ 12:00:00 [workbench] falsk');
  });

  test('log: högst 100 poster per sekund och app; resten släpps', async () => {
    let t = 1_000_000;
    const lines: string[] = [];
    const api = createWbApi({
      config: { root: s.config.root }, paths: s.paths, registry: s.registry,
      logs: { append: (_a, _s, l) => void lines.push(l) }, now: () => t,
    });
    const batch = JSON.stringify(Array.from({ length: 50 }, (_, i) => ({ level: 'log', text: `rad ${i}` })));
    const fakeReq = (body: string): IncomingMessage => {
      const r = Readable.from([Buffer.from(body)]) as unknown as IncomingMessage;
      Object.assign(r, { method: 'POST', headers: {}, complete: true });
      return r;
    };
    const fakeRes = (): ServerResponse => {
      const res = {
        statusCode: 0, headersSent: false, req: { method: 'POST', complete: true },
        writeHead(st: number) {
          res.statusCode = st;
          res.headersSent = true;
        },
        end() {},
        destroy() {},
      };
      return res as unknown as ServerResponse;
    };
    // En flod: hinken rymmer 1,5 s av takten (150), sedan fylls den på med 100 poster/s.
    for (let i = 0; i < 6; i++) await api.handle(fakeReq(batch), fakeRes(), APP, '/__wb/log');
    assert.equal(lines.length, LOG_BURST);
    t += 1000;
    for (let i = 0; i < 6; i++) await api.handle(fakeReq(batch), fakeRes(), APP, '/__wb/log');
    assert.equal(lines.length, LOG_BURST + LOG_RATE_PER_S);
    // Under lång tid blir det aldrig mer än takten plus hinken.
    for (let s2 = 0; s2 < 20; s2++) {
      t += 100;
      for (let i = 0; i < 4; i++) await api.handle(fakeReq(batch), fakeRes(), APP, '/__wb/log');
    }
    assert.ok(lines.length <= LOG_BURST + LOG_RATE_PER_S * 3 + 1, `${lines.length}`);
  });

  test('log: wb.js takt (50 poster var 500 ms, ojämnt) släpps aldrig; kalibrerat mot ett fast fönster', async () => {
    // Samma ankomster mot två begränsare: den riktiga hinken och det gamla fasta 1 s-fönstret (planterad läcka).
    let t = 5_000_000;
    // wb.js skickar var 500 ms; ankomsten varierar ±40 ms (deterministiskt brus), utan att driva iväg.
    const arrivals: number[] = [];
    let seed = 7;
    for (let i = 1; i <= 120; i++) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      arrivals.push(t + 500 * i + Math.round((seed / 2147483648) * 80 - 40));
    }
    const fixedWindow = () => {
      let start = -Infinity;
      let n = 0;
      return (time: number, k: number): number => {
        if (time - start >= 1000) {
          start = time;
          n = 0;
        }
        const ok = Math.min(k, LOG_RATE_PER_S - n);
        n += ok;
        return ok;
      };
    };
    const planted = fixedWindow();
    const plantedKept = arrivals.reduce((sum, time) => sum + planted(time, 50), 0);
    assert.ok(plantedKept < arrivals.length * 50, 'det fasta fönstret ska släppa poster vid ojämn ankomst');

    const lines: string[] = [];
    const api = createWbApi({
      config: { root: s.config.root }, paths: s.paths, registry: s.registry,
      logs: { append: (_a, _s, l) => void lines.push(l) }, now: () => t,
    });
    const batch = JSON.stringify(Array.from({ length: 50 }, (_, i) => ({ level: 'warn', text: `rad ${i}` })));
    const res = (): ServerResponse =>
      ({ statusCode: 0, headersSent: false, req: { method: 'POST', complete: true }, writeHead() {}, end() {}, destroy() {} }) as unknown as ServerResponse;
    for (const time of arrivals) {
      t = time;
      const r = Readable.from([Buffer.from(batch)]) as unknown as IncomingMessage;
      Object.assign(r, { method: 'POST', headers: {}, complete: true });
      await api.handle(r, res(), APP, '/__wb/log');
    }
    assert.equal(lines.length, arrivals.length * 50);
  });
});
