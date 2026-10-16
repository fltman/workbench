// hud-store-pending.test.ts — fönster och kamera som inte nått servern (store.ts, ROB-1/ROB-2) läggs bara över
// samma scen. Byts servern mot en med ett annat hem (WORKBENCH_HOME) får inget från den gamla scenen hamna i den
// nya, varken direkt efter återanslutningen eller via sessionStorage efter en omladdning. En gammal post kastas.
// Varje fall får en egen butik (modulen importeras med en egen fråga), utan WebSocket: send() misslyckas, så allt
// som ändras väntar.
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Camera, Scene, ServerMsg, WindowState } from '../../shared/protocol.ts';

class MemoryStorage {
  #m = new Map<string, string>();
  getItem(k: string): string | null {
    return this.#m.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.#m.set(k, String(v));
  }
  removeItem(k: string): void {
    this.#m.delete(k);
  }
}

let storage = new MemoryStorage();
Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, get: () => storage });
beforeEach(() => (storage = new MemoryStorage()));

type StoreLike = {
  scene: Scene;
  receive(msg: ServerMsg): void;
  updateWindow(w: WindowState): void;
  setCamera(c: Camera): void;
  windowOf(appId: string): WindowState | undefined;
};
let n = 0;
async function freshStore(): Promise<StoreLike> {
  const mod = (await import(`../../web/src/store.ts?fall=${++n}`)) as { store: StoreLike };
  return mod.store;
}

const win = (appId: string, x: number): WindowState => ({ id: `w-${appId}`, appId, x, y: 0, w: 400, h: 300, scale: 1, z: 1, face: 0 });
const snap = (camera: Camera, ...windows: WindowState[]): ServerMsg => ({
  t: 'snapshot',
  scene: { version: 1, camera, windows: windows.map((w) => ({ ...w })) },
  apps: [],
} as unknown as ServerMsg);
const camA: Camera = { cx: 0, cy: 0, zoom: 1 };
const camB: Camera = { cx: 40, cy: -20, zoom: 0.8 };
const moved: Camera = { cx: 0, cy: 720, zoom: 1 };

test('samma scen efter ett avbrott: det flyttade fönstret och kameran läggs över snapshoten', async () => {
  const s = await freshStore();
  s.receive(snap(camA, win('aaa1111', 0)));
  s.updateWindow({ ...win('aaa1111', 0), x: 250 });
  s.setCamera(moved);
  s.receive(snap(camA, win('aaa1111', 0)));
  assert.equal(s.windowOf('aaa1111')?.x, 250);
  assert.deepEqual(s.scene.camera, moved);
});

test('annat hem efter ett avbrott: kameran och fönstren från den gamla scenen kastas', async () => {
  const s = await freshStore();
  s.receive(snap(camA, win('aaa1111', 0)));
  s.updateWindow({ ...win('aaa1111', 0), x: 250 });
  s.setCamera(moved);
  s.receive(snap(camB, win('bbb2222', 30)));
  assert.deepEqual(s.scene.camera, camB, 'den nya scenens kamera');
  assert.equal(s.windowOf('bbb2222')?.x, 30);
  // Kastat, inte bara överhoppat: tillbaka till det gamla hemmet gäller serverns läge.
  s.receive(snap(camA, win('aaa1111', 0)));
  assert.deepEqual(s.scene.camera, camA);
  assert.equal(s.windowOf('aaa1111')?.x, 0);
});

const saved = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ at: Date.now(), ids: ['w-aaa1111'], wins: [{ ...win('aaa1111', 0), x: 250 }], cam: moved, ...over });

test('omladdning, samma scen: det som sparades vid pagehide läggs över första snapshoten', async () => {
  storage.setItem('wb.pending', saved());
  const s = await freshStore();
  s.receive(snap(camA, win('aaa1111', 0)));
  assert.equal(s.windowOf('aaa1111')?.x, 250);
  assert.deepEqual(s.scene.camera, moved);
  assert.equal(storage.getItem('wb.pending'), null, 'posten läses en gång');
});

test('omladdning mot ett annat hem: inget från den gamla scenen läggs över (inte heller kameran)', async () => {
  storage.setItem('wb.pending', saved());
  const s = await freshStore();
  s.receive(snap(camB, win('bbb2222', 30)));
  assert.deepEqual(s.scene.camera, camB);
  assert.equal(s.windowOf('bbb2222')?.x, 30);
});

test('omladdning: en gammal post, eller en utan scenens fönster, kastas', async () => {
  storage.setItem('wb.pending', saved({ at: Date.now() - 10 * 60_000 }));
  const old = await freshStore();
  old.receive(snap(camA, win('aaa1111', 0)));
  assert.equal(old.windowOf('aaa1111')?.x, 0, 'tio minuter gammal');
  assert.deepEqual(old.scene.camera, camA);
  storage.setItem('wb.pending', saved({ ids: undefined }));
  const noIds = await freshStore();
  noIds.receive(snap(camA, win('aaa1111', 0)));
  assert.equal(noIds.windowOf('aaa1111')?.x, 0, 'utan fönster-id:n');
  assert.deepEqual(noIds.scene.camera, camA);
});

test('ett skickat fönster skickas en gång: ett fel från servern eller nästa snapshot skickar det inte igen', async () => {
  const s = (await freshStore()) as StoreLike & { send(m: unknown): boolean };
  const sent: Array<{ t: string }> = [];
  s.send = (m) => (sent.push(m as { t: string }), true);
  s.receive(snap(camA, win('aaa1111', 0)));
  s.updateWindow({ ...win('aaa1111', 0), x: 250 });
  s.setCamera(moved);
  await new Promise((r) => setTimeout(r, 500));
  assert.deepEqual(sent.map((m) => m.t), ['scene.window', 'scene.camera']);
  s.receive({ t: 'error', message: 'avvisat' } as ServerMsg);
  s.receive(snap(camA, win('aaa1111', 0)));
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(sent.length, 2, 'inget skickas om');
  assert.equal(s.windowOf('aaa1111')?.x, 0, 'serverns läge gäller efter avvisningen');
});
