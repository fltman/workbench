// MCP-verktygen (CONTRACT §8.7) och lagringen av hemligheter.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { storeSecret } from '../../server/claude/secrets.ts';
import { callBackend, checkTryInput, getAppLogs, linesSince, makeWorkbenchTools, reloadApp, requestBackend, requestSecret, screenshotApp, tryApp } from '../../server/claude/tools.ts';
import type { ToolDeps } from '../../server/claude/tools.ts';
import type { AskDecision } from '../../shared/protocol.ts';
import { makeWorld, rmrf, tmpHome } from './server-claude-kit.ts';
import type { World } from './server-claude-kit.ts';

const ID = 'aapp001';

function deps(w: World, answer: { decision: AskDecision; value?: string } = { decision: 'deny' }): ToolDeps & { asked: { key: string; label: string }[] } {
  const asked: { key: string; label: string }[] = [];
  return {
    appId: ID, paths: w.paths, registry: w.registry, backends: w.backends, logs: w.logs, shots: w.shots,
    reload: { prev: [] },
    asked,
    async askSecret(key, label) {
      asked.push({ key, label });
      return answer;
    },
  };
}

const textOf = (r: { content: { type: string; text?: string }[] }) => r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');

describe('verktygen finns med rätt namn', () => {
  test('sex verktyg', () => {
    const w = makeWorld();
    try {
      w.addApp(ID);
      assert.deepEqual(makeWorkbenchTools(deps(w)).map((t) => t.name), ['reload_app', 'screenshot_app', 'get_app_logs', 'call_backend', 'try_app', 'request_secret']);
    } finally {
      w.cleanup();
    }
  });
});

describe('reload_app', () => {
  let w: World;
  beforeEach(() => {
    w = makeWorld();
    w.addApp(ID);
  });
  afterEach(() => w.cleanup());

  test('utan backend: refresh, restart (villkorslöst), bumpRev, och inga konsolfel', async () => {
    const r = await reloadApp(deps(w));
    assert.equal(textOf(r), 'Reloaded. Back end: none\nNo console errors since the last reload.');
    // restart anropas även utan backend: den stoppar en process som blivit kvar när backenden togs bort ur app.json.
    assert.deepEqual(w.rec.calls, [`refresh:${ID}`, `restart:${ID}`, `bumpRev:${ID}`]);
  });

  test('med backend som kör', async () => {
    w.registry.manifests.set(ID, { backend: { entry: 'server.mjs' } });
    w.backends.ports.set(ID, 18300);
    w.backends.st.set(ID, 'running');
    const r = await reloadApp(deps(w));
    assert.match(textOf(r), /^Reloaded\. Back end: running on port 18300$/m);
    assert.deepEqual(w.rec.calls, [`refresh:${ID}`, `restart:${ID}`, `bumpRev:${ID}`]);
  });

  test('kraschad backend: de 20 senaste raderna från backend och workbench', async () => {
    w.registry.manifests.set(ID, { backend: { entry: 'server.mjs' } });
    w.backends.st.set(ID, 'crashed');
    for (let i = 0; i < 29; i++) w.logs.append(ID, 'backend', `rad ${i}`);
    w.logs.append(ID, 'console', 'error: inte backend');
    // Orsaken skriver supervisorn med källan workbench (§9).
    w.logs.append(ID, 'workbench', 'Backenden lyssnade på *:18300, inte bara på 127.0.0.1, och stoppades.');
    const t = textOf(await reloadApp(deps(w)));
    assert.match(t, /^Reloaded\. Back end: crashed/);
    assert.match(t, /\[workbench\] Backenden lyssnade på \*:18300/);
    assert.match(t, /rad 28/);
    assert.match(t, /rad 10/);
    assert.doesNotMatch(t, /rad 9\b/);
    // Konsolraden hör till avsnittet om konsolfel, inte till backendens rader.
    const [tail, consoleErrors] = t.split('Console errors since the last reload:');
    assert.doesNotMatch(tail, /inte backend/);
    assert.match(consoleErrors, /error: inte backend/);
  });

  test('konsolfel sedan förra omladdningen', async () => {
    const d = deps(w);
    w.logs.append(ID, 'console', 'error: gammalt fel');
    await reloadApp(d);
    w.logs.append(ID, 'console', 'error: nytt fel');
    w.logs.append(ID, 'backend', 'lyssnar');
    const t = textOf(await reloadApp(d));
    assert.match(t, /Console errors since the last reload:\n.*error: nytt fel/);
    assert.doesNotMatch(t, /gammalt/);
    assert.doesNotMatch(t, /lyssnar/);
  });

  test('linesSince', () => {
    assert.deepEqual(linesSince([], ['a']), ['a']);
    assert.deepEqual(linesSince(['a', 'b'], ['a', 'b', 'c']), ['c']);
    assert.deepEqual(linesSince(['x', 'y'], ['b', 'c']), ['b', 'c'], 'okänt läge: allt är nytt');
    assert.deepEqual(linesSince(['a', 'b'], ['b', 'a', 'b', 'd']), ['d'], 'sista förekomsten');
  });
});

describe('screenshot_app och get_app_logs', () => {
  let w: World;
  beforeEach(() => {
    w = makeWorld();
    w.addApp(ID);
  });
  afterEach(() => w.cleanup());

  test('bild plus storlek och sida', async () => {
    const r = await screenshotApp(deps(w), 'main');
    assert.equal(r.content[0].type, 'image');
    assert.equal((r.content[0] as { mimeType: string }).mimeType, 'image/png');
    assert.equal(textOf(r), '640×480, face main');
    assert.deepEqual(w.shots.calls, [{ appId: ID, face: 'main' }]);
  });

  test('saknad sida ger ett textfel', async () => {
    w.shots.fail = 'No face "x". Faces: main.';
    const r = await screenshotApp(deps(w), 'x');
    assert.equal(r.isError, true);
    assert.match(textOf(r), /No face/);
  });

  test('loggarna: standard 80, högst 400', () => {
    for (let i = 0; i < 500; i++) w.logs.append(ID, 'backend', `r${i}`);
    assert.equal(textOf(getAppLogs(deps(w), undefined)).split('\n').length, 80);
    assert.equal(textOf(getAppLogs(deps(w), 10000)).split('\n').length, 400);
    assert.equal(textOf(getAppLogs(deps(w), 0)).split('\n').length, 1);
    w.logs.clear(ID);
    assert.equal(textOf(getAppLogs(deps(w), 5)), 'No log lines yet.');
  });
});

describe('call_backend', () => {
  let w: World;
  let srv: http.Server;
  let port: number;
  const seen: { method?: string; url?: string; host?: string; body: string; ct?: string; extra?: string }[] = [];

  before(async () => {
    srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen.push({ method: req.method, url: req.url, host: req.headers.host, body, ct: req.headers['content-type'], extra: req.headers['x-extra'] as string | undefined });
        if (req.url === '/api/stor') {
          res.writeHead(200, { 'content-type': 'text/plain' });
          res.end('å'.repeat(30_000));
        } else if (req.url === '/api/seg') {
          res.writeHead(200);
          res.write('början');
          // svarar aldrig klart
        } else {
          res.writeHead(201, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ tid: 'nu', svar: 'åäö' }));
        }
      });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    port = (srv.address() as AddressInfo).port;
  });
  after(async () => {
    srv.closeAllConnections();
    await new Promise<void>((r) => srv.close(() => r()));
  });
  beforeEach(() => {
    w = makeWorld();
    w.addApp(ID);
    w.registry.manifests.set(ID, { backend: { entry: 'server.mjs' } });
    w.backends.ports.set(ID, port);
    seen.length = 0;
  });
  afterEach(() => w.cleanup());

  test('GET mot appens backend med Host 127.0.0.1:<port>', async () => {
    const r = await callBackend(deps(w), { method: 'GET', path: '/api/tid', headers: { Host: 'evil.example', 'X-Extra': 'ja' } });
    assert.equal(textOf(r), 'HTTP 201\ncontent-type: application/json; charset=utf-8\n\n{"tid":"nu","svar":"åäö"}');
    assert.equal(seen[0].host, `127.0.0.1:${port}`);
    assert.equal(seen[0].extra, 'ja');
    assert.deepEqual(w.rec.calls, [`ensure:${ID}`]);
  });

  test('POST med JSON-kropp', async () => {
    await callBackend(deps(w), { method: 'post', path: '/api/spara', body: '{"a":1}' });
    assert.equal(seen[0].method, 'POST');
    assert.equal(seen[0].body, '{"a":1}');
    assert.equal(seen[0].ct, 'application/json');
  });

  test('sökvägen måste börja med /api/', async () => {
    for (const p of ['/x', 'api/x', '/api', '/api/a b', 'http://evil/api/x', '/api/x\r\nHost: y']) {
      const r = await callBackend(deps(w), { method: 'GET', path: p });
      assert.equal(r.isError, true, p);
    }
    assert.equal(seen.length, 0);
  });

  test('okänd metod', async () => {
    assert.equal((await callBackend(deps(w), { method: 'TRACE', path: '/api/x' })).isError, true);
  });

  test('svaret kortas vid 20 kB', async () => {
    const t = textOf(await callBackend(deps(w), { method: 'GET', path: '/api/stor' }));
    assert.match(t, /truncated at 20 kB/);
    assert.ok(Buffer.byteLength(t) < 21 * 1024);
  });

  test('tidsgräns', async () => {
    const r = await requestBackend(port, 'GET', '/api/seg', undefined, undefined, 200);
    assert.equal(r.isError, true);
    assert.match(textOf(r), /timed out/);
  });

  test('utan backend i manifestet', async () => {
    w.registry.manifests.set(ID, {});
    const r = await callBackend(deps(w), { method: 'GET', path: '/api/tid' });
    assert.equal(r.isError, true);
    assert.match(textOf(r), /no back end/);
  });

  test('backenden kom inte upp: orsaken från backend och workbench syns', async () => {
    w.backends.ports.delete(ID);
    w.logs.append(ID, 'backend', 'SyntaxError: Unexpected token');
    w.logs.append(ID, 'workbench', 'Backenden svarade inte på port 18300 inom 8 s.');
    w.logs.append(ID, 'console', 'error: något i webbläsaren');
    const r = await callBackend(deps(w), { method: 'GET', path: '/api/tid' });
    assert.equal(r.isError, true);
    assert.match(textOf(r), /SyntaxError/);
    assert.match(textOf(r), /\[workbench\] Backenden svarade inte på port 18300 inom 8 s\./);
    assert.doesNotMatch(textOf(r), /något i webbläsaren/);
  });
});

describe('request_secret och secrets.json', () => {
  let root: string;
  let app: string;
  beforeEach(() => {
    root = tmpHome('wb-secret');
    app = path.join(root, 'app');
    fs.mkdirSync(app);
  });
  afterEach(() => rmrf(root));

  test('lagras med läge 0600 och slås ihop med befintliga nycklar', () => {
    storeSecret(app, 'imap_password', 'hemligt-1');
    storeSecret(app, 'api_key', 'hemligt-2');
    const file = path.join(app, 'data', 'secrets.json');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { imap_password: 'hemligt-1', api_key: 'hemligt-2' });
    assert.deepEqual(fs.readdirSync(path.join(app, 'data')), ['secrets.json'], 'inga tmp-filer kvar');
  });

  test('data/ som symbolisk länk vägras (planterad läcka: skrivningen hade hamnat utanför)', () => {
    const outside = path.join(root, 'utanfor');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(app, 'data'));
    // Kalibrering: en naiv skrivning följer länken ut ur appen.
    fs.writeFileSync(path.join(app, 'data', 'probe'), 'x');
    assert.ok(fs.existsSync(path.join(outside, 'probe')), 'kalibrering');
    fs.rmSync(path.join(outside, 'probe'));
    assert.throws(() => storeSecret(app, 'k', 'hemligt-3'), /symbolic link/);
    assert.deepEqual(fs.readdirSync(outside), []);
  });

  test('secrets.json som symbolisk länk vägras, och felet innehåller aldrig värdet', () => {
    fs.mkdirSync(path.join(app, 'data'));
    const target = path.join(root, 'mal.json');
    fs.writeFileSync(target, '{"x":"y"}');
    fs.symlinkSync(target, path.join(app, 'data', 'secrets.json'));
    let msg = '';
    try {
      storeSecret(app, 'k', 'VÄRDE-som-inte-får-synas');
    } catch (err) {
      msg = (err as Error).message;
    }
    assert.match(msg, /not a regular file/);
    assert.doesNotMatch(msg, /VÄRDE/);
    assert.equal(fs.readFileSync(target, 'utf8'), '{"x":"y"}', 'målet orört');
  });

  test('ogiltig nyckel', () => {
    assert.throws(() => storeSecret(app, 'Inte OK', 'v'));
  });

  test('verktyget: värdet sparas, och bara nyckeln går tillbaka till Claude', async () => {
    const w = makeWorld();
    try {
      w.addApp(ID);
      const d = deps(w, { decision: 'answered', value: 'SUPERHEMLIGT-42' });
      const r = await requestSecret(d, 'api_nyckel', 'API-nyckel');
      assert.equal(textOf(r), 'Stored in data/secrets.json as "api_nyckel".');
      assert.doesNotMatch(JSON.stringify(r), /SUPERHEMLIGT/);
      assert.deepEqual(d.asked, [{ key: 'api_nyckel', label: 'API-nyckel' }]);
      assert.equal(JSON.parse(fs.readFileSync(path.join(w.paths.appDir(ID), 'data', 'secrets.json'), 'utf8')).api_nyckel, 'SUPERHEMLIGT-42');
    } finally {
      w.cleanup();
    }
  });

  test('verktyget: avböjt, tidsgräns och ogiltig nyckel blir textfel', async () => {
    const w = makeWorld();
    try {
      w.addApp(ID);
      for (const decision of ['deny', 'timeout', 'cancelled'] as const) {
        const r = await requestSecret(deps(w, { decision }), 'k', 'K');
        assert.equal(r.isError, true, decision);
      }
      const bad = deps(w, { decision: 'answered', value: 'v' });
      assert.equal((await requestSecret(bad, 'Ogiltig Nyckel', 'x')).isError, true);
      assert.equal(bad.asked.length, 0, 'ingen fråga för en ogiltig nyckel');
      assert.equal(fs.existsSync(path.join(w.paths.appDir(ID), 'data', 'secrets.json')), false);
    } finally {
      w.cleanup();
    }
  });
});

describe('try_app: indata och gränser (K8)', () => {
  test('giltiga steg godtas', () => {
    assert.equal(checkTryInput({ steps: [{ click: 'text=7' }, { fill: '#n', text: 'Mjölk' }, { type: 'abc' }, { press: 'Enter' }, { wait: 'text=15' }, { wait: 300 }, { shot: true }] }), null);
    assert.equal(checkTryInput({ steps: [{ click: '#b' }], store: 'empty' }), null);
    assert.equal(checkTryInput({ steps: [{ click: '#b' }], store: { count: 41, 'lista.v2': [1, 2] } }), null);
  });

  test('gränserna fäller det som går utanför', () => {
    assert.match(checkTryInput({ steps: [] }) ?? '', /1–20/);
    assert.match(checkTryInput({ steps: Array.from({ length: 21 }, () => ({ click: '#b' })) }) ?? '', /1–20/);
    assert.match(checkTryInput({ steps: [{ click: '#a', press: 'Enter' }] }) ?? '', /exactly one/);
    assert.match(checkTryInput({ steps: [{}] }) ?? '', /exactly one/);
    assert.match(checkTryInput({ steps: [{ click: 'x'.repeat(201) }] }) ?? '', /selector/);
    assert.match(checkTryInput({ steps: [{ fill: '#n', text: 'x'.repeat(501) }] }) ?? '', /500/);
    assert.match(checkTryInput({ steps: [{ press: 'x'.repeat(33) }] }) ?? '', /1–32/);
    assert.match(checkTryInput({ steps: [{ wait: 3001 }] }) ?? '', /0–3000/);
    assert.match(checkTryInput({ steps: [{ shot: true }, { shot: true }, { shot: true }] }) ?? '', /At most 2/);
    assert.match(checkTryInput({ steps: [{ click: '#b' }], store: { 'ogiltig nyckel': 1 } }) ?? '', /Invalid store key/);
    assert.match(checkTryInput({ steps: [{ click: '#b' }], store: { a: 'x'.repeat(70_000) } }) ?? '', /too large|seed/);
  });

  test('drag: 2–50 punkter [x, y] med ändliga tal ≥ 0, ensam i sitt steg', () => {
    const pts = (n: number) => Array.from({ length: n }, (_, i) => [i, i * 2]);
    assert.equal(checkTryInput({ steps: [{ drag: pts(2) }, { drag: pts(50) }, { drag: [[0, 0], [12.5, 2400]] }] }), null);
    assert.match(checkTryInput({ steps: [{ drag: pts(1) }] }) ?? '', /Step 1: drag needs 2–50/);
    assert.match(checkTryInput({ steps: [{ click: '#b' }, { drag: pts(51) }] }) ?? '', /Step 2: drag needs 2–50/);
    assert.match(checkTryInput({ steps: [{ drag: [] }] }) ?? '', /2–50/);
    for (const bad of [[[1, 2], [3]], [[1, 2], [3, 4, 5]], [[1, 2], ['3', 4]], [[1, 2], [NaN, 4]], [[1, 2], [Infinity, 4]], [[1, 2], null], [[1, 2], 7]]) {
      assert.match(checkTryInput({ steps: [{ drag: bad as number[][] }] }) ?? '', /drag point 2 must be/, JSON.stringify(bad));
    }
    assert.match(checkTryInput({ steps: [{ drag: [[1, 2], [-1, 4]] }] }) ?? '', /drag point 2 .* outside/);
    assert.match(checkTryInput({ steps: [{ drag: 'x' as unknown as number[][] }] }) ?? '', /2–50/);
    assert.match(checkTryInput({ steps: [{ drag: pts(2), click: '#b' }] }) ?? '', /exactly one/);
  });

  test('api: /api-sökvägar utan #, högst 20 nycklar och 64 kB, eget tak utanför stegens 16 kB', () => {
    assert.equal(checkTryInput({ steps: [{ shot: true }], api: { '/api': {}, '/api/messages': [{ from: 'Anna' }], '/api/items?folder=inbox': [], '/api/q?s=å': null } }), null);
    // Ett stort men tillåtet svar fälls inte av stegens tak.
    assert.equal(checkTryInput({ steps: [{ shot: true }], api: { '/api/big': 'x'.repeat(40_000) } }), null);
    for (const k of ['/items', 'api/x', '/apix', '/api#x', '/api/x#y', '', '/api/../store', '/api/%2e%2e/x', '/api\\..\\x', '//evil.example/api/x']) {
      assert.match(checkTryInput({ steps: [{ shot: true }], api: { [k]: 1 } }) ?? '', /Invalid api path/, JSON.stringify(k));
    }
    assert.match(checkTryInput({ steps: [{ shot: true }], api: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`/api/p${i}`, i])) }) ?? '', /at most 20/);
    assert.equal(checkTryInput({ steps: [{ shot: true }], api: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`/api/p${i}`, i])) }), null);
    assert.match(checkTryInput({ steps: [{ shot: true }], api: { '/api/big': 'x'.repeat(70_000) } }) ?? '', /at most 65536/);
    for (const bad of [[], 'x', null, 5]) {
      assert.match(checkTryInput({ steps: [{ shot: true }], api: bad as unknown as Record<string, unknown> }) ?? '', /api must be an object/, JSON.stringify(bad));
    }
  });

  test('utan tryRun i Shots blir det ett textfel, inget kast', async () => {
    const w = makeWorld();
    try {
      w.addApp(ID);
      const r = await tryApp(deps(w), { steps: [{ click: '#b' }] });
      assert.equal(r.isError, true);
      assert.match(textOf(r), /not available/);
    } finally {
      w.cleanup();
    }
  });
});
