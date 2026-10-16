// Statiska filer på appens origin (CONTRACT §4.6, §7.2): sökvägsreglerna och HTML-injektionen.
// Läcktesterna kalibreras först mot en naiv, lexikal server (den gamla regeln "startsWith('data/')" plus
// path.join och readFile) som MÅSTE läcka på samma förfrågningar.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { WB_SCRIPT, injectWb, injectionPoint } from '../../server/http/static.ts';
import { NAV, request, rmDir, sameOrigin, startRouter, tempDir } from './server-http-fakes.test.ts';
import type { Res, Started } from './server-http-fakes.test.ts';

/* ------------------------------ HTML-injektionen ------------------------------ */

function inj(html: string): string {
  return injectWb(Buffer.from(html, 'utf8')).toString('utf8');
}

describe('HTML-injektion', () => {
  test('efter <head…>', () => {
    assert.equal(
      inj('<!doctype html><html lang="sv"><head><title>x</title></head><body></body></html>'),
      `<!doctype html><html lang="sv"><head>${WB_SCRIPT}<title>x</title></head><body></body></html>`,
    );
    assert.equal(inj('<HTML><HEAD id="h"><meta charset="utf-8">'), `<HTML><HEAD id="h">${WB_SCRIPT}<meta charset="utf-8">`);
  });
  test('ett ">" i ett citerat attribut avslutar inte taggen', () => {
    assert.equal(inj('<html data-x="a>b"><head data-y=\'c>d\'><p>'), `<html data-x="a>b"><head data-y='c>d'>${WB_SCRIPT}<p>`);
  });
  test('saknas <head>: efter <html…>', () => {
    assert.equal(inj('<!DOCTYPE html>\n<html lang="sv">\n<body>hej</body></html>'), `<!DOCTYPE html>\n<html lang="sv">${WB_SCRIPT}\n<body>hej</body></html>`);
  });
  test('doctype utan head och html: direkt efter <!doctype …>, aldrig före (quirks mode)', () => {
    const out = inj('<!doctype html><meta charset=utf-8><title>Å ä ö</title><p>x');
    assert.equal(out, `<!doctype html>${WB_SCRIPT}<meta charset=utf-8><title>Å ä ö</title><p>x`);
    assert.ok(out.toLowerCase().startsWith('<!doctype html>'));
  });
  test('inledande kommentarer och blanktecken före doctype', () => {
    const src = '\n  <!-- byggd av Claude -->\n<!DOCTYPE html>\n<!-- en till --><p>x</p>';
    assert.equal(inj(src), `\n  <!-- byggd av Claude -->\n<!DOCTYPE html>${WB_SCRIPT}\n<!-- en till --><p>x</p>`);
    assert.equal(inj('<!-- a --><html><!-- b --><head>'), `<!-- a --><html><!-- b --><head>${WB_SCRIPT}`);
  });
  test('<header> är inte <head>', () => {
    assert.equal(inj('<!doctype html><header>x</header>'), `<!doctype html>${WB_SCRIPT}<header>x</header>`);
    assert.equal(inj('<html><header>x</header>'), `<html>${WB_SCRIPT}<header>x</header>`);
  });
  test('ett "<head>" i en sträng längre ner flyttar inte skriptet', () => {
    const src = '<!doctype html><title>t</title><script>const s = "<head>";</script>';
    assert.equal(inj(src), `<!doctype html>${WB_SCRIPT}<title>t</title><script>const s = "<head>";</script>`);
  });
  test('annars först, men efter en BOM', () => {
    assert.equal(inj('<p>hej</p>'), `${WB_SCRIPT}<p>hej</p>`);
    assert.equal(inj(''), WB_SCRIPT);
    const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('<p>x</p>')]);
    const out = injectWb(bom);
    assert.deepEqual([...out.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    assert.equal(out.subarray(3).toString('utf8'), `${WB_SCRIPT}<p>x</p>`);
  });
  test('omvandlingen är idempotent: står taggen redan först läggs ingen till', () => {
    const once = inj('<!doctype html><html><head></head></html>');
    assert.equal(inj(once), once);
    assert.equal(once.split('/__wb/wb.js').length - 1, 1);
    assert.equal(inj(`<head>${WB_SCRIPT}<title>x</title>`), `<head>${WB_SCRIPT}<title>x</title>`);
  });
  test('alltid först, även när sidan har en egen tagg längre ner (§7.2; wb.js är idempotent)', () => {
    for (const own of [
      '<head><meta charset="utf-8"><script src="/__wb/wb.js"></script></head>',
      "<head><script type=module src=app.js></script><SCRIPT defer SRC='/__wb/wb.js?v=2'></SCRIPT></head>",
      '<html><body><script src=/__wb/wb.js></script></body></html>',
    ]) {
      const out = inj(own);
      assert.equal(out.indexOf(WB_SCRIPT), injectionPoint(own), own);
      assert.equal(out.replace(WB_SCRIPT, ''), own, 'bara skriptet läggs till');
      // Bryggan står före varje annat skript i dokumentet.
      assert.ok(out.indexOf(WB_SCRIPT) <= out.toLowerCase().indexOf('<script'), own);
    }
    // Kalibrering: den gamla regeln (hoppa över sidor som redan har en tagg) lät appens skript gå först.
    const skipIfPresent = (s: string): string => (/<script\b[^>]*__wb\/wb\.js/i.test(s) ? s : inj(s));
    const late = '<head><script src="app.js"></script><script src="/__wb/wb.js"></script></head>';
    const old = skipIfPresent(late);
    assert.ok(old.indexOf('app.js') < old.indexOf('/__wb/wb.js'), 'den planterade regeln ska fällas');
    const now = inj(late);
    assert.ok(now.indexOf('/__wb/wb.js') < now.indexOf('app.js'));
  });
  test('bytes utanför ASCII lämnas orörda (å, ä, ö i UTF-8)', () => {
    const src = '<!doctype html><html><head><title>Mejl – å ä ö</title></head></html>';
    const out = injectWb(Buffer.from(src, 'utf8'));
    assert.equal(out.toString('utf8'), src.replace('<head>', `<head>${WB_SCRIPT}`));
  });
  test('injectionPoint på en oavslutad doctype eller kommentar', () => {
    assert.equal(injectionPoint('<!doctype html'), 0);
    assert.equal(injectionPoint('<!-- aldrig slut <head>'), 0);
  });
});

/* ------------------------------ sökvägar över HTTP ------------------------------ */

const APP = 'astatic1';
const CANARIES = {
  outside: 'KANARIE-UTANFÖR',
  data: 'KANARIE-DATA',
  nm: 'KANARIE-NODEMODULES',
  dot: 'KANARIE-PUNKTFIL',
};

/** Detektorn: förfrågan gav innehåll med kanariefågeln. */
const leaked = (r: Res, canary: string): boolean => r.status < 300 && r.text.includes(canary);

/** De förfrågningar som ska fällas, med kanariefågeln de annars skulle läcka. */
const ATTACKS: { path: string; canary: string }[] = [
  { path: '/../../outside/secret.txt', canary: CANARIES.outside },
  { path: '/..%2F..%2Foutside%2Fsecret.txt', canary: CANARIES.outside },
  { path: '/%2e%2e/%2e%2e/outside/secret.txt', canary: CANARIES.outside },
  { path: '/leak.txt', canary: CANARIES.outside },
  { path: '/linkdir/secret.txt', canary: CANARIES.outside },
  { path: '/data/secrets.json', canary: CANARIES.data },
  { path: '/Data/secrets.json', canary: CANARIES.data },
  { path: '/DATA/secrets.json', canary: CANARIES.data },
  { path: '/%64ata/secrets.json', canary: CANARIES.data },
  { path: '/alias/secrets.json', canary: CANARIES.data },
  { path: '/sub/../data/secrets.json', canary: CANARIES.data },
  { path: '/node_modules/pkg/index.js', canary: CANARIES.nm },
  { path: '/Node_Modules/pkg/index.js', canary: CANARIES.nm },
  { path: '/.env', canary: CANARIES.dot },
  { path: '/.git/config', canary: CANARIES.dot },
  { path: '/sub/.hidden', canary: CANARIES.dot },
  { path: '/.ENV', canary: CANARIES.dot },
];

/** Den gamla, lexikala regeln: neka "data/", "node_modules/" och punktfiler på förfrågans text, läs med path.join. */
function naiveServer(appDir: string): http.Server {
  return http.createServer((req, res) => {
    let rel: string;
    try {
      rel = decodeURIComponent((req.url ?? '/').split('?')[0]).replace(/^\/+/, '');
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (rel.startsWith('data/') || rel.startsWith('node_modules/') || rel.split('/').some((s) => s.startsWith('.') && s !== '..')) {
      res.writeHead(404).end();
      return;
    }
    fs.readFile(path.join(appDir, rel), (err, buf) => {
      if (err) res.writeHead(404).end();
      else res.writeHead(200).end(buf);
    });
  });
}

describe('statiska filer: sökvägsreglerna (§4.6)', () => {
  let s: Started;
  let root: string;
  let appDir: string;
  let naive: http.Server;
  let naivePort: number;
  const host = (): string => `${APP}.localhost:${s.port}`;

  before(async () => {
    root = tempDir('static');
    s = await startRouter({ home: path.join(root, 'home') });
    s.registry.add(APP, { name: 'Statisk', index: '<!doctype html><html lang="sv"><head><title>Å</title></head><body>hej</body></html>' });
    appDir = s.paths.appDir(APP);
    // Utanför appen: två nivåer upp från appDir är <home>, så ../../outside ligger i hemkatalogen.
    const outside = path.join(s.home, 'outside');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'secret.txt'), CANARIES.outside);
    fs.mkdirSync(path.join(appDir, 'data'), { recursive: true });
    fs.writeFileSync(path.join(appDir, 'data', 'secrets.json'), JSON.stringify({ k: CANARIES.data }));
    fs.mkdirSync(path.join(appDir, 'node_modules', 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(appDir, 'node_modules', 'pkg', 'index.js'), `// ${CANARIES.nm}`);
    fs.writeFileSync(path.join(appDir, '.env'), CANARIES.dot);
    fs.mkdirSync(path.join(appDir, '.git'), { recursive: true });
    fs.writeFileSync(path.join(appDir, '.git', 'config'), CANARIES.dot);
    fs.mkdirSync(path.join(appDir, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(appDir, 'sub', '.hidden'), CANARIES.dot);
    fs.writeFileSync(path.join(appDir, 'sub', 'page.html'), '<p>sida</p>');
    fs.writeFileSync(path.join(appDir, 'style.css'), 'body { color: red }');
    fs.writeFileSync(path.join(appDir, 'app.mjs'), 'export {}');
    fs.writeFileSync(path.join(appDir, 'bild.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    fs.writeFileSync(path.join(appDir, 'tom.txt'), '');
    fs.symlinkSync('../../outside/secret.txt', path.join(appDir, 'leak.txt'));
    fs.symlinkSync(outside, path.join(appDir, 'linkdir'));
    fs.symlinkSync('data', path.join(appDir, 'alias'));
    execFileSync('mkfifo', [path.join(appDir, 'pipe.html')]);
    naive = naiveServer(appDir);
    await new Promise<void>((r) => naive.listen(0, '127.0.0.1', r));
    naivePort = (naive.address() as { port: number }).port;
  });
  after(async () => {
    await s.close();
    naive.closeAllConnections();
    await new Promise<void>((r) => naive.close(() => r()));
    rmDir(root);
  });

  test('kalibrering: den naiva servern läcker på minst en förfrågan per kanariefågel', async () => {
    const hits = new Set<string>();
    for (const a of ATTACKS) {
      const r = await request(naivePort, { path: a.path, headers: NAV });
      if (leaked(r, a.canary)) hits.add(a.canary);
    }
    // Punktfilerna nekas även av den naiva regeln, så de tre andra måste ha läckt.
    for (const c of [CANARIES.outside, CANARIES.data]) assert.ok(hits.has(c), `detektorn såg ingen läcka för ${c}`);
    const naiveSymlink = await request(naivePort, { path: '/leak.txt' });
    assert.equal(leaked(naiveSymlink, CANARIES.outside), true, 'den naiva servern följer inte symboliska länkar?');
    const naiveCase = await request(naivePort, { path: '/Data/secrets.json' });
    assert.equal(leaked(naiveCase, CANARIES.data), true, 'skiftlägesvarianten läcker inte i den naiva servern?');
  });

  test('ingen av attackerna läcker genom den riktiga routern', async () => {
    for (const a of ATTACKS) {
      const r = await request(s.port, { path: a.path, host: host(), headers: NAV });
      assert.equal(leaked(r, a.canary), false, `${a.path} läckte (status ${r.status})`);
      assert.ok(r.status === 404 || r.status === 400, `${a.path}: status ${r.status}`);
    }
  });

  test('%00 och ogiltiga escape-sekvenser ger 400', async () => {
    for (const p of ['/index.html%00.txt', '/%00', '/%E0%A4%A', '/%zz', '/abc%']) {
      const r = await request(s.port, { path: p, host: host(), headers: NAV });
      assert.equal(r.status, 400, p);
    }
  });

  test('/ ger första sidan med wb.js injicerat och appens HTML-huvuden', async () => {
    const r = await request(s.port, { path: '/', host: host(), headers: { ...NAV, 'sec-fetch-site': 'cross-site', 'sec-fetch-dest': 'iframe' } });
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-type'], 'text/html; charset=utf-8');
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal(r.headers['content-security-policy'], `frame-ancestors http://localhost:${s.port}`);
    assert.equal(r.headers['referrer-policy'], 'same-origin');
    assert.equal(r.text, `<!doctype html><html lang="sv"><head>${WB_SCRIPT}<title>Å</title></head><body>hej</body></html>`);
    assert.equal(Number(r.headers['content-length']), r.body.length);
  });

  test('innehållstyper, charset för text och no-store', async () => {
    const cases: [string, string][] = [
      ['/style.css', 'text/css; charset=utf-8'],
      ['/app.mjs', 'text/javascript; charset=utf-8'],
      ['/bild.png', 'image/png'],
      ['/sub/page.html', 'text/html; charset=utf-8'],
    ];
    for (const [p, type] of cases) {
      const r = await request(s.port, { path: p, host: host(), headers: sameOrigin() });
      assert.equal(r.status, 200, p);
      assert.equal(r.headers['content-type'], type, p);
      assert.equal(r.headers['cache-control'], 'no-store', p);
      assert.equal(r.headers['x-content-type-options'], 'nosniff', p);
    }
    const css = await request(s.port, { path: '/style.css', host: host() });
    assert.equal(css.headers['content-security-policy'], undefined, 'CSP frame-ancestors gäller bara HTML');
    const empty = await request(s.port, { path: '/tom.txt', host: host() });
    assert.equal(empty.status, 200);
    assert.equal(empty.text, '');
  });

  test('en hård länk till data/secrets.json serveras inte (SEC-5); samma fil utan extra länk serveras', async () => {
    const copy = path.join(appDir, 'kopia.json');
    const hard = path.join(appDir, 'hard.json');
    fs.copyFileSync(path.join(appDir, 'data', 'secrets.json'), copy);
    try {
      // Kalibrering: kopian (en länk) ger 200 med kanariet, så förfrågan når innehållet.
      const ok = await request(s.port, { path: '/kopia.json', host: host(), headers: sameOrigin() });
      assert.equal(ok.status, 200);
      assert.ok(ok.text.includes(CANARIES.data));
      fs.linkSync(path.join(appDir, 'data', 'secrets.json'), hard);
      const r = await request(s.port, { path: '/hard.json', host: host(), headers: sameOrigin() });
      assert.equal(r.status, 404);
      assert.ok(!r.text.includes(CANARIES.data));
      // Kopian får en andra länk: då vägras även den, så det är länkantalet som fäller.
      fs.linkSync(copy, path.join(appDir, 'kopia2.json'));
      assert.equal((await request(s.port, { path: '/kopia.json', host: host(), headers: sameOrigin() })).status, 404);
    } finally {
      for (const f of [copy, hard, path.join(appDir, 'kopia2.json')]) fs.rmSync(f, { force: true });
    }
  });

  test('okänd fil: 404 med en tom sida; HEAD utan kropp; POST 405', async () => {
    const r = await request(s.port, { path: '/finns-inte.html', host: host() });
    assert.equal(r.status, 404);
    assert.equal(r.text, '');
    assert.equal(r.headers['content-type'], 'text/html; charset=utf-8');
    const head = await request(s.port, { method: 'HEAD', path: '/', host: host() });
    assert.equal(head.status, 200);
    assert.equal(head.text, '');
    assert.ok(Number(head.headers['content-length']) > 0);
    const post = await request(s.port, { method: 'POST', path: '/', host: host(), headers: { origin: `http://${APP}.localhost:${s.port}` } });
    assert.equal(post.status, 405);
  });

  test('en namngiven rörledning låser aldrig servern', async () => {
    const t0 = Date.now();
    const r = await request(s.port, { path: '/pipe.html', host: host() });
    assert.equal(r.status, 404);
    assert.ok(Date.now() - t0 < 2000);
  });

  test('första sidan följer faces[0].page och samma regler', async () => {
    fs.writeFileSync(path.join(appDir, 'start.html'), '<p>start</p>');
    s.registry.manifests.set(APP, { faces: [{ id: 'main', page: 'start.html' }] });
    let r = await request(s.port, { path: '/', host: host() });
    assert.equal(r.text, `${WB_SCRIPT}<p>start</p>`);
    s.registry.manifests.set(APP, { faces: [{ id: 'main', page: 'data/secrets.json' }] });
    r = await request(s.port, { path: '/', host: host() });
    assert.equal(r.status, 404);
    assert.ok(!r.text.includes(CANARIES.data));
    s.registry.manifests.set(APP, { faces: [{ id: 'main', page: 'leak.txt' }] });
    r = await request(s.port, { path: '/', host: host() });
    assert.equal(r.status, 404);
    s.registry.manifests.set(APP, {});
  });

  test('appmappen själv utbytt mot en länk: 404', async () => {
    const id = 'alinked1';
    const real = path.join(s.home, 'elsewhere');
    fs.mkdirSync(real, { recursive: true });
    fs.writeFileSync(path.join(real, 'index.html'), CANARIES.outside);
    s.registry.add(id);
    fs.rmSync(s.paths.appDir(id), { recursive: true });
    fs.symlinkSync(real, s.paths.appDir(id));
    const r = await request(s.port, { path: '/', host: `${id}.localhost:${s.port}` });
    assert.equal(r.status, 404);
    assert.ok(!r.text.includes(CANARIES.outside));
  });
});

describe('dist/ i produktion', () => {
  let s: Started;
  let root: string;
  before(async () => {
    root = tempDir('dist');
    const dist = path.join(root, 'dist');
    fs.mkdirSync(path.join(dist, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>Workbench</title>');
    fs.writeFileSync(path.join(dist, 'assets', 'main.js'), 'console.log(1)');
    fs.writeFileSync(path.join(dist, '.secret'), 'nej');
    s = await startRouter({ home: path.join(root, 'home'), distDir: dist });
  });
  after(async () => {
    await s.close();
    rmDir(root);
  });

  test('filer, SPA-fallback, skalets huvuden och ingen injektion', async () => {
    const index = await request(s.port, { path: '/', headers: NAV });
    assert.equal(index.status, 200);
    assert.equal(index.text, '<!doctype html><title>Workbench</title>');
    assert.match(String(index.headers['content-security-policy']), /frame-ancestors 'none'/);
    assert.equal(index.headers['x-frame-options'], 'DENY');
    const js = await request(s.port, { path: '/assets/main.js', headers: sameOrigin() });
    assert.equal(js.headers['content-type'], 'text/javascript; charset=utf-8');
    const spa = await request(s.port, { path: '/nagon/vy', headers: NAV });
    assert.equal(spa.status, 200);
    assert.equal(spa.text, '<!doctype html><title>Workbench</title>');
    const missing = await request(s.port, { path: '/assets/finns-inte.js', headers: sameOrigin() });
    assert.equal(missing.status, 404);
    const dot = await request(s.port, { path: '/.secret', headers: sameOrigin() });
    assert.equal(dot.status, 404);
    assert.ok(!dot.text.includes('nej'));
    const up = await request(s.port, { path: '/..%2Fhome', headers: sameOrigin() });
    assert.equal(up.status, 404);
  });
});
