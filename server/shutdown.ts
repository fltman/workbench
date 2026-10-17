// server/shutdown.ts — vad SIGINT och SIGTERM gör (CONTRACT §7). En Node-process äger Claude-barnen, backenderna och
// varje apps rev, så en omstart (npm run dev skickar SIGTERM och väntar) avbröt förut varje bygge. Nu väntar första
// signalen ut pågående turer, högst 15 min, medan servern fortsätter servera; en andra signal stänger direkt.
// Med låtsas-Claude, eller när inget pågår, stängs servern direkt (testerna räknar med snabba avslut).

export const DRAIN_MAX_MS = 15 * 60_000;

export interface SignalDeps {
  /** Hur många appar som har en pågående tur just nu. */
  busy(): number;
  /** Ingen ny tur startar från och med nu (sessions.drain). */
  drain(): void;
  /** Det vanliga avslutet (§7 steg 2–6), med sin egen tidsgräns. Anropas högst en gång. */
  shutdown(): void;
  /** Låtsas-Claude: ingen väntan. */
  fake: boolean;
  log(line: string): void;
  /** Längsta väntan. Standard DRAIN_MAX_MS. */
  maxWaitMs?: number;
  /** Hur ofta busy() prövas under väntan. Standard 250 ms. */
  pollMs?: number;
}

/** Hanteraren för en signal: första signalen tömmer (eller stänger direkt), nästa stänger direkt. */
export function createSignalHandler(d: SignalDeps): (signal: string) => void {
  const maxWaitMs = d.maxWaitMs ?? DRAIN_MAX_MS;
  let draining = false;
  let done = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const stop = (): void => {
    if (done) return;
    done = true;
    if (timer) clearInterval(timer);
    timer = null;
    d.shutdown();
  };

  return (signal) => {
    if (done) return;
    if (draining) {
      d.log(`[workbench] ${signal}: stänger utan att vänta på turerna`);
      stop();
      return;
    }
    const n = d.fake ? 0 : d.busy();
    if (n === 0) {
      d.log(`[workbench] ${signal}: stänger`);
      stop();
      return;
    }
    draining = true;
    d.drain();
    const min = Math.round(maxWaitMs / 60_000);
    d.log(`[workbench] ${signal}: väntar på ${n} ${n === 1 ? 'pågående tur' : 'pågående turer'} innan servern stänger (högst ${min} min, en signal till stänger direkt)`);
    const t0 = Date.now();
    timer = setInterval(() => {
      if (d.busy() === 0 || Date.now() - t0 >= maxWaitMs) stop();
    }, d.pollMs ?? 250);
  };
}
