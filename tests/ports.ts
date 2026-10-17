// tests/ports.ts — portarna i testerna (CONTRACT §15). Inget test lyssnar på en fast port: varje port väljs när
// testet körs, ledig, om inte en miljövariabel anger den. Då krockar aldrig flera körningar samtidigt (andra
// agenter, en egen instans bredvid Anders) och ingen körning tar en port som en riktig workbench använder.
import net from 'node:net';

/** Går porten att binda på host just nu? Utan IPv6 räknas ::1 som ledig. */
function bindable(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', (e: NodeJS.ErrnoException) => resolve(host === '::1' && (e.code === 'EADDRNOTAVAIL' || e.code === 'EAFNOSUPPORT')));
    s.listen(port, host, () => s.close(() => resolve(true)));
  });
}

/**
 * Porten som miljövariabeln `env` anger, annars en port som är ledig på både 127.0.0.1 och ::1 (servern lyssnar
 * på båda, §3). Systemet väljer den bland sina tillfälliga portar, så två körningar får olika.
 */
export async function testPort(env?: string): Promise<number> {
  const named = env ? process.env[env] : undefined;
  if (named) {
    const p = Number(named);
    if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error(`${env} är ingen port: ${JSON.stringify(named)}`);
    return p;
  }
  for (let i = 0; i < 20; i++) {
    const s = net.createServer();
    const p = await new Promise<number>((resolve, reject) => {
      s.once('error', reject);
      s.listen(0, '127.0.0.1', () => resolve((s.address() as net.AddressInfo).port));
    });
    const v6 = await bindable(p, '::1');
    await new Promise((r) => s.close(r));
    if (v6) return p;
  }
  throw new Error('hittade ingen ledig port');
}

// Spannen ligger mellan produktionens backendportar (18300–18499) och systemets tillfälliga portar (från 49152),
// i fack om SLOT portar: först låset, sedan spannet.
const SPAN_FIRST = 20_000;
const SPAN_END = 49_000;
const SLOT = 50;

function hold(port: number): Promise<net.Server | null> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(null));
    s.listen(port, '127.0.0.1', () => resolve(s.unref()));
  });
}

/**
 * Första porten i ett spann av `n` portar i följd (backendernas portBase), lediga just nu och inte någon annan
 * testkörnings. Porten närmast under spannet hålls som lås tills processen avslutas, och samma port på 127.0.0.1
 * kan bara en process binda åt gången.
 */
export async function testPortSpan(n: number): Promise<number> {
  if (!Number.isInteger(n) || n < 1 || n >= SLOT) throw new Error(`ett spann har 1–${SLOT - 1} portar, inte ${n}`);
  const slots = Math.floor((SPAN_END - SPAN_FIRST) / SLOT);
  for (let i = 0; i < slots; i++) {
    const lock = SPAN_FIRST + ((process.pid + i) % slots) * SLOT;
    const held = await hold(lock);
    if (!held) continue;
    let free = true;
    for (let p = lock + 1; free && p <= lock + n; p++) free = await bindable(p, '127.0.0.1');
    if (free) return lock + 1;
    held.close();
  }
  throw new Error(`hittade inget ledigt spann om ${n} portar`);
}
