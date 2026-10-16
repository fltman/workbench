// Bryggans validering i skalet (web/src/bridge.ts), utan webbläsare: vokabulär, klämda tal, origin,
// okända fönster och hastighetsbegränsning. Varje "släpper inte igenom"-test har en kalibrering där
// samma test körs mot en planterad läcka (tests/bridge-harness/leaks.ts) och måste fällas.
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { BridgeWindow, ParentBridgeOptions } from '../../web/src/types.ts';
import * as real from '../../web/src/bridge.ts';
import { BRIDGE_LEAKS, applyLeak } from '../bridge-harness/leaks.ts';

type BridgeModule = typeof real;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const LEAK_DIR = path.join(ROOT, '.scratch/bridge/leaks');

/** Laddar en kopia av bridge.ts med en planterad läcka. */
async function leaky(name: keyof typeof BRIDGE_LEAKS): Promise<BridgeModule> {
  fs.mkdirSync(LEAK_DIR, { recursive: true });
  const file = path.join(LEAK_DIR, `bridge-${name}-${process.pid}.ts`);
  // Kopian ligger i en annan katalog: dess relativa import av shared/ pekas om till den riktiga.
  const src = applyLeak(fs.readFileSync(path.join(ROOT, 'web/src/bridge.ts'), 'utf8'), BRIDGE_LEAKS[name]).replaceAll("from '../../shared/", `from '${pathToFileURL(path.join(ROOT, 'shared')).href}/`);
  fs.writeFileSync(file, src);
  return (await import(pathToFileURL(file).href)) as BridgeModule;
}

after(() => {
  for (const f of fs.existsSync(LEAK_DIR) ? fs.readdirSync(LEAK_DIR) : []) if (f.includes(`-${process.pid}.ts`)) fs.rmSync(path.join(LEAK_DIR, f));
  try {
    fs.rmdirSync(LEAK_DIR); // bara om ingen annan körning har filer kvar där
  } catch {
    /* inte tom eller redan borta */
  }
});

/** Låtsasfönster och en inspelande ParentBridgeOptions. */
function rig(mod: BridgeModule = real) {
  const srcA = { name: 'iframe-a' } as unknown as MessageEventSource;
  const srcB = { name: 'iframe-b' } as unknown as MessageEventSource;
  const stranger = { name: 'okänd' } as unknown as MessageEventSource;
  const mk = (appId: string): BridgeWindow => ({ appId, face: 'main', toScreen: (x, y) => ({ x: 1000 + x * 2, y: 500 + y * 2 }) });
  const wins = new Map<MessageEventSource, BridgeWindow>([
    [srcA, mk('aaa111')],
    [srcB, mk('bbb222')],
  ]);
  const calls: Array<[string, ...unknown[]]> = [];
  const opts: ParentBridgeOptions = {
    resolve: (s) => (s ? wins.get(s) ?? null : null),
    appOrigin: (id) => `http://${id}.localhost:8220`,
    onHello: (w, info) => calls.push(['hello', w.appId, info]),
    onZoom: (w, dy, sx, sy, o) => calls.push(['zoom', w.appId, dy, sx, sy, o]),
    onPan: (w, dx, dy, mode, momentum) => calls.push(['pan', w.appId, dx, dy, mode, momentum]),
    onAltWheel: (w, dx, dy, momentum) => calls.push(['alt', w.appId, dx, dy, momentum]),
    onKey: (w, k) => calls.push(['key', w.appId, k]),
    onFocus: (w) => calls.push(['focus', w.appId]),
    onFaceRequest: (w, f) => calls.push(['face', w.appId, f]),
  };
  let t = 0;
  const handle = mod.createBridgeHandler(opts, () => t);
  return {
    calls,
    opts,
    srcA,
    srcB,
    stranger,
    tick: (ms: number) => {
      t += ms;
    },
    fromA: (data: unknown, origin = 'http://aaa111.localhost:8220') => handle({ source: srcA, origin, data }),
    fromB: (data: unknown, origin = 'http://bbb222.localhost:8220') => handle({ source: srcB, origin, data }),
    from: (source: MessageEventSource | null, origin: string, data: unknown) => handle({ source, origin, data }),
  };
}

const wheel = (o: Record<string, unknown> = {}) => ({ wb: 1, type: 'wheel', action: 'pan', dx: 0, dy: 10, mode: 0, x: 5, y: 6, momentum: false, alt: false, smart: false, ...o });
const key = (o: Record<string, unknown>) => ({ wb: 1, type: 'key', meta: false, ctrl: false, alt: false, shift: false, ...o });

describe('bridge: vokabulären', () => {
  it('varje meddelandetyp når rätt hanterare med rätt värden', () => {
    const r = rig();
    r.fromA({ wb: 1, type: 'hello', face: 'main', w: 640, h: 480 });
    r.fromA(wheel({ action: 'zoom', dy: -3.5, x: 10.25, y: 20.5, alt: true, mode: 0 }));
    r.fromA(wheel({ action: 'pan', dx: 4, dy: -7, mode: 1, momentum: true }));
    r.fromA(wheel({ action: 'alt', dx: 30, dy: 0, momentum: true }));
    r.fromA(key({ code: 'KeyK', meta: true, shift: true }));
    r.fromA({ wb: 1, type: 'focus' });
    r.fromA({ wb: 1, type: 'face', show: 'baksida-2' });
    assert.deepEqual(r.calls, [
      ['hello', 'aaa111', { face: 'main', w: 640, h: 480 }],
      ['zoom', 'aaa111', -3.5, 1020.5, 541, { alt: true, smart: false, mode: 0 }],
      ['pan', 'aaa111', 4, -7, 1, true],
      ['alt', 'aaa111', 30, 0, true],
      ['key', 'aaa111', { code: 'KeyK', meta: true, ctrl: false, alt: false, shift: true }],
      ['focus', 'aaa111'],
      ['face', 'aaa111', 'baksida-2'],
    ]);
  });

  it('tangenter: bara ⌘K, ⌘0, ⌃⌥←/→ och Esc', () => {
    const r = rig();
    const ok = [
      key({ code: 'KeyK', meta: true }),
      key({ code: 'Digit0', meta: true }),
      key({ code: 'ArrowLeft', ctrl: true, alt: true }),
      key({ code: 'ArrowRight', ctrl: true, alt: true }),
      key({ code: 'Escape' }),
    ];
    const bad = [
      key({ code: 'KeyK' }),
      key({ code: 'Digit0', ctrl: true }),
      key({ code: 'ArrowLeft' }),
      key({ code: 'ArrowRight', ctrl: true }),
      key({ code: 'ArrowRight', alt: true }),
      key({ code: 'KeyQ', meta: true }),
      key({ code: 'KeyM', ctrl: true, alt: true }),
      key({ code: 'ArrowDown', ctrl: true, alt: true }),
      key({ code: 'ArrowUp', ctrl: true, alt: true }),
      key({ code: 'k', meta: true }),
      key({ code: 'KeyK', meta: 'true' }),
    ];
    for (const m of [...ok, ...bad]) r.fromA(m);
    assert.deepEqual(
      r.calls.map((c) => (c[2] as { code: string }).code),
      ['KeyK', 'Digit0', 'ArrowLeft', 'ArrowRight', 'Escape'],
    );
  });

  it('kalibrering: utan ackordkontrollen går en bar pil igenom', async () => {
    const r = rig(await leaky('vocab'));
    r.fromA(key({ code: 'ArrowLeft' }));
    assert.equal(r.calls.length, 1, 'testet ska fälla den planterade läckan');
  });

  it('avvisar allt utanför vokabulären', () => {
    const r = rig();
    const bad: unknown[] = [
      null,
      undefined,
      'focus',
      42,
      [],
      { type: 'focus' },
      { wb: 2, type: 'focus' },
      { wb: '1', type: 'focus' },
      { wb: 1, type: 'reload' },
      { wb: 1, type: 'hello', face: 'main', w: '640', h: 480 },
      { wb: 1, type: 'hello', face: 'Main', w: 640, h: 480 },
      { wb: 1, type: 'hello', face: 'main', w: Number.NaN, h: 480 },
      { wb: 1, type: 'hello', face: 7, w: 640, h: 480 },
      wheel({ action: 'scroll' }),
      wheel({ action: undefined }),
      wheel({ dx: '1' }),
      wheel({ dy: Number.NaN }),
      wheel({ x: undefined }),
      wheel({ mode: 'pixel' }),
      { wb: 1, type: 'face', show: '' },
      { wb: 1, type: 'face', show: 'Baksida' },
      { wb: 1, type: 'face', show: 'a'.repeat(33) },
      { wb: 1, type: 'face', show: '../x' },
      { wb: 1, type: 'face' },
    ];
    for (const m of bad) r.fromA(m);
    assert.deepEqual(r.calls, []);
  });

  it('kläm alla tal', () => {
    const r = rig();
    r.fromA({ wb: 1, type: 'hello', face: '', w: 1e9, h: -5 });
    r.fromA(wheel({ action: 'pan', dx: 1e12, dy: -Infinity, mode: 0 }));
    r.fromA(wheel({ action: 'pan', dx: 1e6, dy: -1e6, mode: 1 }));
    r.fromA(wheel({ action: 'pan', dx: 1e6, dy: 3, mode: 2 }));
    r.fromA(wheel({ action: 'pan', dx: 1, dy: 1, mode: 9 }));
    r.fromA(wheel({ action: 'pan', dx: 1, dy: 1, mode: -3 }));
    r.fromA(wheel({ action: 'pan', dx: 1, dy: 1, mode: 1.4 }));
    r.fromA(wheel({ action: 'zoom', dy: 1, x: 1e10, y: -1e10 }));
    assert.deepEqual(r.calls, [
      ['hello', 'aaa111', { face: '', w: 10000, h: 0 }],
      ['pan', 'aaa111', 5000, -5000, 0, false],
      ['pan', 'aaa111', 312.5, -312.5, 1, false],
      ['pan', 'aaa111', 12.5, 3, 2, false],
      ['pan', 'aaa111', 1, 1, 2, false],
      ['pan', 'aaa111', 1, 1, 0, false],
      ['pan', 'aaa111', 1, 1, 1, false],
      ['zoom', 'aaa111', 1, 1000 + 2e5, 500 - 2e5, { alt: false, smart: false, mode: 0 }],
    ]);
  });

  it('kalibrering: utan klämning når ett jättetal hanteraren', async () => {
    const r = rig(await leaky('clamp'));
    r.fromA(wheel({ action: 'pan', dx: 1e12 }));
    assert.equal(r.calls[0]?.[2], 1e12, 'testet ska fälla den planterade läckan');
  });

  it('flaggor blir booleska; smart bara med nollor', () => {
    const r = rig();
    r.fromA(wheel({ action: 'zoom', dx: 0, dy: 0, smart: true }));
    r.fromA(wheel({ action: 'zoom', dx: 0, dy: 2, smart: true }));
    r.fromA(wheel({ action: 'zoom', dx: 0, dy: 0, smart: 1, alt: 'yes' }));
    r.fromA(wheel({ action: 'pan', dx: 0, dy: 0, smart: true, momentum: 'true' }));
    assert.deepEqual(
      r.calls.map((c) => c.slice(2)),
      [
        [0, 1010, 512, { alt: false, smart: true, mode: 0 }],
        [2, 1010, 512, { alt: false, smart: false, mode: 0 }],
        [0, 1010, 512, { alt: false, smart: false, mode: 0 }],
        [0, 0, 0, false],
      ],
    );
  });

  it('⌥+hjul får px även när appen skickar rader eller sidor', () => {
    const r = rig();
    r.fromA(wheel({ action: 'alt', dx: 3, dy: -1, mode: 1 }));
    r.fromA(wheel({ action: 'alt', dx: 0.5, dy: 0, mode: 2 }));
    assert.deepEqual(r.calls, [
      ['alt', 'aaa111', 48, -16, false],
      ['alt', 'aaa111', 200, 0, false],
    ]);
  });
});

describe('bridge: avsändaren', () => {
  const msg = { wb: 1, type: 'focus' };

  it('godtar bara känt fönster med exakt rätt origin', () => {
    const r = rig();
    r.fromA(msg, 'http://bbb222.localhost:8220'); // fönster A, men B:s origin
    r.fromA(msg, 'http://aaa111.localhost:8221'); // fel port
    r.fromA(msg, 'http://aaa111.localhost'); // ingen port
    r.fromA(msg, 'https://aaa111.localhost:8220');
    r.fromA(msg, 'null'); // sandlådad utan allow-same-origin
    r.fromA(msg, 'http://localhost:8220'); // skalets egen origin
    r.from(r.stranger, 'http://aaa111.localhost:8220', msg); // okänt fönster med A:s origin
    r.from(null, 'http://aaa111.localhost:8220', msg);
    assert.deepEqual(r.calls, []);
    r.fromA(msg);
    r.fromB(msg);
    assert.deepEqual(r.calls, [
      ['focus', 'aaa111'],
      ['focus', 'bbb222'],
    ]);
  });

  it('kalibrering: utan origin-kontrollen går fel origin igenom', async () => {
    const r = rig(await leaky('origin'));
    r.fromA(msg, 'http://bbb222.localhost:8220');
    assert.equal(r.calls.length, 1, 'testet ska fälla den planterade läckan');
  });

  it('kalibrering: en brygga som litar på origin släpper in ett okänt fönster', async () => {
    const mod = await leaky('by-origin');
    const g = globalThis as unknown as { __resolveByOrigin?: (o: string) => BridgeWindow | null };
    g.__resolveByOrigin = (o) => (o === 'http://aaa111.localhost:8220' ? { appId: 'aaa111', face: 'main', toScreen: (x, y) => ({ x, y }) } : null);
    try {
      const r = rig(mod);
      r.from(r.stranger, 'http://aaa111.localhost:8220', msg);
      assert.equal(r.calls.length, 1, 'testet ska fälla den planterade läckan');
    } finally {
      delete g.__resolveByOrigin;
    }
  });

  it('ett resolve eller appOrigin som kastar fäller bara meddelandet', () => {
    const r = rig();
    const boom: ParentBridgeOptions = {
      ...r.opts,
      resolve: () => {
        throw new Error('trasig');
      },
    };
    assert.doesNotThrow(() => real.createBridgeHandler(boom)({ source: r.srcA, origin: 'http://aaa111.localhost:8220', data: msg }));
    const boom2: ParentBridgeOptions = {
      ...r.opts,
      appOrigin: () => {
        throw new Error('trasig');
      },
    };
    assert.doesNotThrow(() => real.createBridgeHandler(boom2)({ source: r.srcA, origin: 'http://aaa111.localhost:8220', data: msg }));
    assert.deepEqual(r.calls, []);
  });

  it('ett fel i en hanterare stoppar inte bryggan', (t) => {
    const r = rig();
    const errors: unknown[] = [];
    t.mock.method(console, 'error', (...a: unknown[]) => errors.push(a));
    const opts: ParentBridgeOptions = {
      ...r.opts,
      onFocus: () => {
        throw new Error('hanteraren kraschade');
      },
    };
    const handle = real.createBridgeHandler(opts);
    assert.doesNotThrow(() => handle({ source: r.srcA, origin: 'http://aaa111.localhost:8220', data: msg }));
    handle({ source: r.srcA, origin: 'http://aaa111.localhost:8220', data: { wb: 1, type: 'face', show: 'main' } });
    assert.equal(errors.length, 1);
    assert.deepEqual(r.calls, [['face', 'aaa111', 'main']]);
  });
});

describe('bridge: hastighetsbegränsning', () => {
  const flood = (r: ReturnType<typeof rig>, n: number, from: 'fromA' | 'fromB' = 'fromA') => {
    for (let i = 0; i < n; i++) r[from]({ wb: 1, type: 'focus' });
  };
  const count = (r: ReturnType<typeof rig>, id: string) => r.calls.filter((c) => c[1] === id).length;

  it(`högst ${real.BRIDGE_RATE} meddelanden/s per fönster, och fönstren påverkar inte varandra`, () => {
    const r = rig();
    flood(r, 2000);
    assert.equal(count(r, 'aaa111'), 400);
    flood(r, 10, 'fromB');
    assert.equal(count(r, 'bbb222'), 10);
    r.tick(500);
    flood(r, 2000);
    assert.equal(count(r, 'aaa111'), 600);
    r.tick(10_000);
    flood(r, 2000);
    assert.equal(count(r, 'aaa111'), 1000, 'hinken fylls bara till 400');
    r.tick(2.5); // 2,5 ms = 1 meddelande
    flood(r, 5);
    assert.equal(count(r, 'aaa111'), 1001);
  });

  it('kalibrering: utan hinken går hela floden igenom', async () => {
    const r = rig(await leaky('rate'));
    flood(r, 2000);
    assert.equal(count(r, 'aaa111'), 2000, 'testet ska fälla den planterade läckan');
  });

  it('meddelanden från okända fönster tar inte av hinken', () => {
    const r = rig();
    for (let i = 0; i < 1000; i++) r.from(r.stranger, 'http://aaa111.localhost:8220', { wb: 1, type: 'focus' });
    for (let i = 0; i < 1000; i++) r.fromA({ wb: 1, type: 'focus' }, 'http://evil.localhost:8220');
    flood(r, 400);
    assert.equal(count(r, 'aaa111'), 400);
  });
});

describe('bridge: koppling till window och sendFace', () => {
  it('createParentBridge lyssnar på window och avregistreras', () => {
    const r = rig();
    const g = globalThis as unknown as { window?: EventTarget };
    const had = 'window' in g;
    const saved = g.window;
    g.window = new EventTarget();
    try {
      const off = real.createParentBridge(r.opts);
      const post = (data: unknown) => {
        const ev = new Event('message');
        Object.defineProperties(ev, { data: { value: data }, origin: { value: 'http://aaa111.localhost:8220' }, source: { value: r.srcA } });
        g.window?.dispatchEvent(ev);
      };
      post({ wb: 1, type: 'focus' });
      off();
      post({ wb: 1, type: 'focus' });
      assert.deepEqual(r.calls, [['focus', 'aaa111']]);
    } finally {
      if (had) g.window = saved;
      else delete g.window;
    }
  });

  it('sendFace skickar bara giltiga sid-id till en exakt origin', () => {
    const sent: unknown[][] = [];
    const target = { postMessage: (...a: unknown[]) => sent.push(a) } as unknown as Window;
    real.sendFace(target, 'http://aaa111.localhost:8220', 'baksida');
    real.sendFace(target, '*', 'main');
    real.sendFace(target, 'http://aaa111.localhost:8220/', 'main');
    real.sendFace(target, 'http://aaa111.localhost:8220', 'Ogiltig');
    real.sendFace(null, 'http://aaa111.localhost:8220', 'main');
    assert.deepEqual(sent, [[{ wb: 1, type: 'face', current: 'baksida' }, 'http://aaa111.localhost:8220']]);
  });

  it('sendOpen (§10.9) skickar bara giltiga adresser, datum och texter, normaliserade, till en exakt origin', () => {
    const sent: unknown[][] = [];
    const target = { postMessage: (...a: unknown[]) => sent.push(a) } as unknown as Window;
    const o = 'http://aaa111.localhost:8220';
    real.sendOpen(target, o, { kind: 'url', url: 'dn.se' });
    real.sendOpen(target, o, { kind: 'url', url: 'javascript:alert(1)' });
    real.sendOpen(target, o, { kind: 'date', date: '2026-10-20' });
    real.sendOpen(target, o, { kind: 'date', date: '2026-02-30' });
    real.sendOpen(target, o, { kind: 'text', text: ' köp  mjölk ' });
    real.sendOpen(target, '*', { kind: 'text', text: 'x' });
    real.sendOpen(null, o, { kind: 'text', text: 'x' });
    assert.deepEqual(sent, [
      [{ wb: 1, type: 'open', item: { kind: 'url', url: 'https://dn.se/' } }, o],
      [{ wb: 1, type: 'open', item: { kind: 'date', date: '2026-10-20' } }, o],
      [{ wb: 1, type: 'open', item: { kind: 'text', text: 'köp mjölk' } }, o],
    ]);
  });

  it('parseFromApp avvisar extra typer men behåller giltiga meddelanden oförändrade', () => {
    const m = { wb: 1, type: 'wheel', action: 'zoom', dx: 0, dy: -1.25, mode: 0, x: 3.5, y: 4.75, momentum: false, alt: false, smart: false, extra: 'ignoreras' };
    const { extra: _extra, ...expected } = m;
    assert.deepEqual(real.parseFromApp(m), expected);
  });
});
