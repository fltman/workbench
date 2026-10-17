// hud-store-redo.test.ts — när skalet har Gör om (store.ts, CONTRACT §13). Svaren på ångra och gör om sätter det,
// och appens nästa turn-händelse tar bort det, också när händelsen kommer medan frågan är ute: servern räknade då ut
// canRedo före turens commit, så ett svar som kommer efter turen får inte sätta det igen.
// Varje fall får en egen butik (modulen importeras med en egen fråga), utan WebSocket. fetch byts mot en som håller
// svaret tills testet släpper det.
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import type { ServerMsg } from '../../shared/protocol.ts';

type StoreLike = {
  receive(msg: ServerMsg): void;
  undo(appId: string): Promise<boolean>;
  redo(appId: string): Promise<boolean>;
  canRedo(appId: string): boolean;
};
let n = 0;
async function freshStore(): Promise<StoreLike> {
  const mod = (await import(`../../web/src/store.ts?gorom=${++n}`)) as { store: StoreLike };
  return mod.store;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** fetch som svarar { ok: true, canRedo: true } först när testet släpper svaret. */
function heldFetch(): { release: () => void; urls: string[] } {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const urls: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request) => {
    urls.push(String(url));
    await gate;
    return new Response(JSON.stringify({ ok: true, canRedo: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { release, urls };
}

const turn = (appId: string, phase: 'start' | 'end', at: number): ServerMsg =>
  ({ t: 'chat', appId, ev: phase === 'start' ? { k: 'turn', phase, at } : { k: 'turn', phase, ok: true, at } }) as ServerMsg;

test('ett svar på ångra som kommer efter en tur sätter inte Gör om; utan tur gör det det (kalibrerat)', async () => {
  const s = await freshStore();
  // Kalibrering: samma svar utan någon tur sätter Gör om, och nästa turn-händelse tar bort det.
  let f = heldFetch();
  let p = s.undo('aaa1111');
  f.release();
  assert.equal(await p, true);
  assert.deepEqual(f.urls, ['/api/apps/aaa1111/undo']);
  assert.equal(s.canRedo('aaa1111'), true, 'kalibrering: canRedo i svaret sätter Gör om');
  s.receive(turn('aaa1111', 'start', 1));
  assert.equal(s.canRedo('aaa1111'), false, 'nästa tur tar bort Gör om');

  // En tur börjar och slutar medan frågan är ute: servern räknade ut canRedo före turens commit.
  f = heldFetch();
  p = s.undo('aaa1111');
  s.receive(turn('aaa1111', 'end', 2));
  s.receive(turn('aaa1111', 'start', 3));
  s.receive(turn('aaa1111', 'end', 4));
  f.release();
  assert.equal(await p, true);
  assert.equal(s.canRedo('aaa1111'), false, 'turen kom medan ångra pågick: ingen Gör om efter den');
});

test('detsamma för gör om, och en tur i en annan app rör inte appens Gör om (kalibrerat åt båda hållen)', async () => {
  const s = await freshStore();
  let f = heldFetch();
  let p = s.redo('aaa1111');
  s.receive(turn('bbb2222', 'start', 1));
  s.receive(turn('bbb2222', 'end', 2));
  f.release();
  assert.equal(await p, true);
  assert.deepEqual(f.urls, ['/api/apps/aaa1111/redo']);
  assert.equal(s.canRedo('aaa1111'), true, 'kalibrering: en tur i en annan app rör inte appens Gör om');
  assert.equal(s.canRedo('bbb2222'), false);

  f = heldFetch();
  p = s.redo('aaa1111');
  s.receive(turn('aaa1111', 'start', 3));
  f.release();
  assert.equal(await p, true);
  assert.equal(s.canRedo('aaa1111'), false, 'turen började medan gör om pågick: ingen Gör om');
});
