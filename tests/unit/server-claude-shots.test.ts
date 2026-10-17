// try_app (K8): spärren "en körning per app" måste släppas också när körningen dör innan webbläsaren
// öppnat en kontext (trasig app.json, Chrome som inte startar), annars vägras appen try_app tills omstart.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { apiKey, createShots, dragProblem, isLocalHost } from '../../server/claude/shots.ts';
import type { AppManifest } from '../../shared/protocol.ts';
import type { AppRegistry, SceneStore } from '../../server/types.ts';
import { testPort } from '../ports.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ID = 'aprov01';

// Före första testet: annars är körningen klar innan webbläsartesterna hunnit registreras.
let noChrome: string | false = false;
try {
  await (await chromium.launch({ channel: 'chrome', headless: true })).close();
} catch (err) {
  const msg = String((err as Error)?.message ?? err);
  if (/distribution 'chrome' is not (found|supported)|doesn't exist|ENOENT/i.test(msg)) noChrome = 'Chrome saknas';
  else throw err;
}

test('try_app: ett fel före kontexten släpper spärren', async () => {
  let broken = true;
  const registry = {
    get: () => ({ id: 'aapp001' }),
    manifest: () => {
      if (broken) throw new Error('app.json kunde inte läsas');
      return { name: 'x', faces: [{ id: 'main', page: 'index.html' }], permissions: [] };
    },
  } as unknown as AppRegistry;
  const scene = { window: () => undefined } as unknown as SceneStore;
  const shots = createShots({ config: { port: 8289 } as never, registry, scene, logs: { append: () => {} } as never });
  try {
    await assert.rejects(shots.tryRun('aapp001', { steps: [{ shot: true }] }), /app\.json/);
    broken = false;
    // En sida som inte finns avvisas före webbläsaren, så inget Chrome behövs här.
    await assert.rejects(shots.tryRun('aapp001', { face: 'finns-inte', steps: [{ shot: true }] }), /No face "finns-inte"/);
  } finally {
    await shots.close();
  }
});

test('try_app drag: punkterna prövas mot fönstrets storlek (0 ≤ x ≤ w, 0 ≤ y ≤ h)', () => {
  assert.equal(dragProblem([[0, 0], [480, 320]], 480, 320), null);
  assert.match(dragProblem([[10, 10], [481, 10]], 480, 320) ?? '', /drag point 2 \(481,10\) is outside the window \(0–480 × 0–320\)/);
  assert.match(dragProblem([[10, 321], [1, 1]], 480, 320) ?? '', /drag point 1 .* outside/);
  // Utan känd storlek prövas bara antal och tal.
  assert.equal(dragProblem([[10, 10], [5000, 10]]), null);
});

test('try_app api: nycklarna normaliseras som webbläsaren skriver adressen och stannar under /api', () => {
  assert.equal(apiKey('/api/items?folder=inbox'), '/api/items?folder=inbox');
  assert.equal(apiKey('/api/q?s=å'), '/api/q?s=%C3%A5');
  assert.equal(apiKey('/api/a b'), '/api/a%20b');
  assert.equal(apiKey('/api/./x'), '/api/x');
  assert.equal(apiKey('/api'), '/api');
  for (const k of ['/api/../x', '/api/%2e%2e/x', '/api\\..\\x', '/apix', '/x', '/api#a', 5, null]) assert.equal(apiKey(k), null, String(k));
});

// "Lokala värdar avbryts alltid" (§8.7): url.hostname i alla stavningar som Chrome ansluter till den här datorn
// med. En provkörning nådde annars en lyssnare på 127.0.0.1 via http://localhost.:<port>/,
// http://[::ffff:127.0.0.1]:<port>/ och http://[::]:<port>/ (samma värden som Chrome ger url.hostname).
test('isLocalHost: alla stavningar av den här datorn, men inget annat', () => {
  for (const h of ['localhost', 'a.localhost', 'LOCALHOST', '127.0.0.1', '127.1.2.3', '[::1]', '0.0.0.0', 'localhost.', 'aprobe2.localhost.', '[::]', '[::ffff:7f00:1]', '[::ffff:0:0]']) {
    assert.equal(isLocalHost(h), true, h);
  }
  for (const h of ['example.com', 'localhost.example.com', 'mylocalhost', '128.0.0.1', '[2001:db8::1]']) assert.equal(isLocalHost(h), false, h);
});

// ---------------------------------------------------------------------------------------------------------------
// try_app i riktig Chrome (granskningen 17 oktober): en fil till en filväljare, en släppyta och inklistring,
// låtsad kamera och mikrofon, och fältets open-meddelande till wb.onOpen. Riggen serverar appen som servern gör
// (§7.2: wb.js först, frame-ancestors skalet) på <id>.localhost:<port>; skalets origin får aldrig en förfrågan.
const PAGES: Record<string, string> = {
  'index.html': `<!doctype html><html lang="sv"><head><meta charset="utf-8"><title>Prov</title></head><body>
<input type="file" id="fil" hidden>
<div id="zon" style="width:200px;height:60px;background:#eee">Släpp här</div>
<button id="kamera">Kamera</button> <button id="mikrofon">Mikrofon</button> <button id="vrid">Vrid</button> <button id="regler">Regler</button>
<p id="ut">ingen fil</p><p id="media">ingen enhet</p><p id="oppnat">ingen öppning</p><p id="tangent">ingen tangent</p><p id="policy">inga regler</p>
<script>
const $ = (id) => document.getElementById(id);
async function visa(file, how) {
  let dim = 'ingen bild';
  try { const b = await createImageBitmap(file); dim = b.width + '×' + b.height; } catch {}
  const text = file.type.startsWith('text/') ? ' ' + (await file.text()).trim().split('\\n')[0] : '';
  $('ut').textContent = how + ' ' + file.name + ' ' + file.size + ' ' + file.type + ' ' + dim + text;
}
$('fil').addEventListener('change', async () => {
  const f = $('fil').files[0];
  await visa(f, 'vald');
  await fetch('/api/items?name=' + encodeURIComponent(f.name), { method: 'POST', body: f }).catch(() => {});
});
$('zon').addEventListener('dragover', (e) => e.preventDefault());
$('zon').addEventListener('drop', (e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) visa(f, 'släppt'); });
document.addEventListener('paste', (e) => { const f = e.clipboardData && e.clipboardData.files[0]; if (f) visa(f, 'inklistrad'); });
async function enhet(c) {
  try { const t = (await navigator.mediaDevices.getUserMedia(c)).getTracks()[0]; $('media').textContent = 'spår ' + t.kind + ' ' + t.label; }
  catch (e) { $('media').textContent = 'fel ' + e.name; }
}
$('kamera').onclick = () => enhet({ video: true });
$('mikrofon').onclick = () => enhet({ audio: true });
// Vad iframens allow (Permissions Policy) ger sidan: i ramen samma som skalets iframes.
$('regler').onclick = () => {
  const fp = document.featurePolicy;
  $('policy').textContent = 'regler fullscreen ' + document.fullscreenEnabled + ['clipboard-write', 'camera', 'microphone'].map((f) => ' ' + f + ' ' + (fp ? fp.allowsFeature(f) : '?')).join('');
};
$('vrid').onclick = () => wb.face.show('baksida');
const fått = [];
wb.onOpen((item) => { fått.push(item.kind + ' ' + (item.url || item.date || item.text)); $('oppnat').textContent = 'öppnad ' + fått.join(' | '); });
document.addEventListener('keydown', (e) => { $('tangent').textContent = 'tangent ' + e.key; });
// En sida kan inte spela skalet: ett eget open-meddelande ska avvisas av wb.js.
window.postMessage({ wb: 1, type: 'open', item: { kind: 'text', text: 'självpostat' } }, '*');
</script></body></html>`,
  'baksida.html': `<!doctype html><html lang="sv"><head><meta charset="utf-8"><title>Baksida</title></head><body><p>baksidan</p></body></html>`,
};

interface Rig {
  port: number;
  /** Förfrågningar som nådde något annat än appens origin (skalet). Ska vara tom. */
  shellHits: string[];
  /** Planterad läcka: en wb.js som tar emot open från vem som helst. */
  plantNoOriginCheck: boolean;
  close(): Promise<void>;
}

async function startRig(manifest: () => AppManifest): Promise<Rig> {
  const port = await testPort();
  const wbSrc = fs.readFileSync(path.join(ROOT, 'sdk', 'wb.js'), 'utf8');
  const CHECK = 'if (e.origin !== SHELL || e.source !== window.parent) return;';
  assert.ok(wbSrc.includes(CHECK), 'wb.js:s kontroll av avsändaren finns inte längre där testet väntar sig den');
  const rig: Rig = { port, shellHits: [], plantNoOriginCheck: false, close: async () => {} };
  const handler = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    const host = String(req.headers.host ?? '');
    const url = new URL(req.url ?? '/', 'http://x');
    const send = (status: number, type: string, body: string, extra: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...extra });
      res.end(body);
    };
    if (host !== `${ID}.localhost:${port}`) {
      rig.shellHits.push(`${req.method} ${host}${url.pathname}`);
      return send(404, 'text/plain', '');
    }
    if (url.pathname === '/__wb/wb.js') return send(200, 'text/javascript; charset=utf-8', rig.plantNoOriginCheck ? wbSrc.replace(CHECK, '') : wbSrc);
    if (url.pathname === '/__wb/app.json') {
      const m = manifest();
      return send(200, 'application/json; charset=utf-8', JSON.stringify({ id: ID, name: m.name, faces: m.faces }));
    }
    if (url.pathname.startsWith('/__wb/')) return send(204, 'text/plain', '');
    const html = PAGES[url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1))];
    if (html === undefined) return send(404, 'text/html; charset=utf-8', '');
    send(200, 'text/html; charset=utf-8', html.replace('<head>', '<head><script src="/__wb/wb.js"></script>'), {
      'content-security-policy': `frame-ancestors http://localhost:${port}`,
    });
  };
  const servers: http.Server[] = [];
  for (const addr of ['127.0.0.1', '::1']) {
    servers.push(
      await new Promise<http.Server>((resolve, reject) => {
        const s = http.createServer(handler);
        s.once('error', reject);
        s.listen(port, addr, () => resolve(s));
      }),
    );
  }
  rig.close = async () => {
    await Promise.all(servers.map((s) => new Promise<void>((r) => (s.closeAllConnections(), s.close(() => r())))));
  };
  return rig;
}

describe('try_app i Chrome: filer, kamera och mikrofon, och fältet', { skip: noChrome, timeout: 180_000 }, () => {
  const manifest: AppManifest & { faces: NonNullable<AppManifest['faces']>; permissions: NonNullable<AppManifest['permissions']> } = {
    name: 'Prov',
    faces: [{ id: 'main', page: 'index.html' }, { id: 'baksida', page: 'baksida.html' }],
    permissions: [],
    opens: ['url'],
  };
  let rig: Rig;
  let shots: ReturnType<typeof createShots>;
  const run = async (input: Parameters<typeof shots.tryRun>[1]) => (await shots.tryRun(ID, input)).lines.join('\n');
  const visible = (out: string) => out.slice(out.indexOf('Visible text:'));

  before(async () => {
    rig = await startRig(() => manifest);
    const registry = { get: (x: string) => (x === ID ? { id: ID } : undefined), manifest: () => structuredClone(manifest) } as unknown as AppRegistry;
    const scene = { window: () => ({ id: `w-${ID}`, appId: ID, x: 0, y: 0, w: 480, h: 320, scale: 1, face: 0, z: 1 }) } as unknown as SceneStore;
    shots = createShots({ config: { port: rig.port } as never, registry, scene, logs: { append: () => {} } as never });
  }, { timeout: 30_000 });

  after(async () => {
    await shots?.close();
    await rig?.close();
  }, { timeout: 30_000 });

  test('upload: inbyggda PNG, JPEG och text på en dold filväljare, och uppladdningen till backenden stoppas (kalibrerat utan steget)', async () => {
    const cal = await run({ steps: [{ click: '#zon' }] });
    assert.match(visible(cal), /ingen fil/, cal);
    const png = await run({ steps: [{ upload: '#fil', sample: 'png' }, { wait: 'text=/vald/' }] });
    assert.match(png, /ok {3}1 upload "#fil" sample\.png \(image\/png, \d+ bytes\) \d+ ms/, png);
    assert.match(visible(png), /vald sample\.png \d+ image\/png 64×64/, png);
    assert.match(png, /Blocked requests:\nPOST \/api\/items/, png);
    const jpeg = await run({ steps: [{ upload: '#fil', sample: 'jpeg' }, { wait: 'text=/vald/' }] });
    assert.match(visible(jpeg), /vald sample\.jpg \d+ image\/jpeg 64×64/, jpeg);
    const txt = await run({ steps: [{ upload: '#fil', sample: 'txt' }, { wait: 'text=/vald/' }] });
    assert.match(visible(txt), /vald sample\.txt \d+ text\/plain ingen bild Hej från Workbench\./, txt);
  });

  test('drop och paste: samma provfiler som en släppt fil och som inklistrad (kalibrerat: ett klick på ytan och ⌘V ger ingen fil)', async () => {
    const cal = await run({ steps: [{ click: '#zon' }, { press: 'Meta+v' }, { wait: 300 }] });
    assert.match(visible(cal), /ingen fil/, cal);
    const dropped = await run({ steps: [{ drop: '#zon', sample: 'jpeg' }, { wait: 'text=/släppt/' }] });
    assert.match(dropped, /ok {3}1 drop "#zon" sample\.jpg \(image\/jpeg, \d+ bytes\)/, dropped);
    assert.match(visible(dropped), /släppt sample\.jpg \d+ image\/jpeg 64×64/, dropped);
    const pasted = await run({ steps: [{ paste: 'body', sample: 'png' }, { wait: 'text=/inklistrad/' }] });
    assert.match(pasted, /ok {3}1 paste "body" sample\.png/, pasted);
    assert.match(visible(pasted), /inklistrad sample\.png \d+ image\/png 64×64/, pasted);
  });

  test('kamera och mikrofon: låtsade enheter bara när app.json anger behörigheten, även i ramen för open (kalibrerat: utan den NotAllowedError)', async () => {
    const öppna = { open: { kind: 'url', url: 'dn.se' } };
    const regler = (out: string) => visible(out).match(/regler fullscreen .*/)?.[0] ?? out;
    manifest.permissions = [];
    for (const knapp of ['#kamera', '#mikrofon']) {
      const cal = await run({ steps: [{ click: knapp }, { wait: 'text=/spår|fel/' }] });
      assert.match(visible(cal), /fel NotAllowedError/, cal);
      assert.doesNotMatch(cal, /fake device/);
    }
    // I ramen får appen fullscreen och clipboard-write som i skalet, men inte det som app.json inte anger.
    const ramUtan = await run({ steps: [öppna, { click: '#regler' }, { wait: 'text=/fullscreen (true|false)/' }] });
    assert.equal(regler(ramUtan), 'regler fullscreen true clipboard-write true camera false microphone false', ramUtan);
    const kameraUtan = await run({ steps: [öppna, { click: '#kamera' }, { wait: 'text=/spår|fel/' }] });
    assert.match(visible(kameraUtan), /fel NotAllowedError/, kameraUtan);
    manifest.permissions = ['camera', 'microphone'];
    try {
      const cam = await run({ steps: [{ click: '#kamera' }, { wait: 'text=/spår|fel/' }] });
      assert.match(visible(cam), /spår video \S+/, cam);
      assert.match(cam, /^Fake media: camera: fake device granted, microphone: fake device granted\./m, cam);
      const mic = await run({ steps: [{ click: '#mikrofon' }, { wait: 'text=/spår|fel/' }] });
      assert.match(visible(mic), /spår audio \S+/, mic);
      // Samma i ramen: iframen saknar src (sidan laddas med frame.goto), och Chrome prövar en inbäddad ram mot toppsidan.
      const ram = await run({ steps: [öppna, { click: '#regler' }, { wait: 'text=/fullscreen (true|false)/' }] });
      assert.equal(regler(ram), 'regler fullscreen true clipboard-write true camera true microphone true', ram);
      for (const [knapp, slag] of [['#kamera', 'video'], ['#mikrofon', 'audio']]) {
        const out = await run({ steps: [öppna, { click: knapp }, { wait: 'text=/spår|fel/' }] });
        assert.match(visible(out), new RegExp(`spår ${slag} \\S+`), out);
        assert.match(out, /^Fake media: camera: fake device granted, microphone: fake device granted\./m, out);
      }
    } finally {
      manifest.permissions = [];
    }
  });

  test('open: når wb.onOpen genom bryggans egen kontroll, bara med slaget i opens (kalibrerat utan steget och mot en planterad brygga)', async () => {
    // Kalibrering: utan steget händer ingenting.
    const cal = await run({ steps: [{ wait: 200 }] });
    assert.match(visible(cal), /ingen öppning/, cal);
    const opened = await run({ steps: [{ open: { kind: 'url', url: 'dn.se' } }, { wait: 'text=/öppnad/' }, { press: 'a' }] });
    assert.match(opened, /ok {3}1 open url "https:\/\/dn\.se\/" \d+ ms/, opened);
    assert.match(visible(opened), /öppnad url https:\/\/dn\.se\//, opened);
    assert.match(visible(opened), /tangent a/, opened); // tangenterna når appen även i ramen
    assert.doesNotMatch(opened, /självpostat/, 'sidans eget open-meddelande ska ha avvisats');
    // Planterad läcka: utan bryggans kontroll av avsändaren tar sidan emot sitt eget meddelande, så påståendet ovan biter.
    rig.plantNoOriginCheck = true;
    try {
      const leaky = await run({ steps: [{ open: { kind: 'url', url: 'dn.se' } }, { wait: 300 }] });
      assert.match(visible(leaky), /självpostat/, leaky);
    } finally {
      rig.plantNoOriginCheck = false;
    }
    // Ett slag som app.json inte anger lämnar skalet aldrig fram: steget fälls, och sidan får inget.
    const undeclared = await run({ steps: [{ open: { kind: 'date', date: '2026-10-20' } }] });
    assert.match(undeclared, /FAIL 1 open date "2026-10-20" \d+ ms: app\.json does not list "date" in opens/, undeclared);
    assert.match(visible(undeclared), /ingen öppning/, undeclared);
    // Från en annan sida: skalet vrider fram första sidan och lämnar det där, som World.show och deliver.
    const back = await run({ face: 'baksida', steps: [{ open: { kind: 'url', url: 'https://example.com/' } }, { wait: 'text=/öppnad/' }] });
    assert.match(back, /Face changes: baksida → main/, back);
    assert.match(visible(back), /öppnad url https:\/\/example\.com\//, back);
    // wb.face.show i ramen byter sida som på toppnivå.
    const turned = await run({ steps: [{ open: { kind: 'url', url: 'dn.se' } }, { click: '#vrid' }, { wait: 'text=baksidan' }] });
    assert.match(turned, /Face changes: main → baksida/, turned);
    assert.deepEqual(rig.shellHits, [], 'skalets origin fick förfrågningar');
    // Kalibrering av detektorn: en förfrågan till skalets origin syns.
    await fetch(`http://localhost:${rig.port}/kalibrering`).then((r) => r.text());
    assert.deepEqual(rig.shellHits, [`GET localhost:${rig.port}/kalibrering`]);
  });
});
