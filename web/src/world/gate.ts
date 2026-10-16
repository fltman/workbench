// gate.ts — bryggans grind (SEC-1): ett meddelande från en app styr skalet bara när användaren faktiskt är
// hos just den appen. Bryggan (bridge.ts) kontrollerar avsändare, origin och vokabulär; grinden avgör om
// appen får använda dem just nu. Ren logik, enhetstestad.
//
// Uppmätt i Chrome (headless, DSF 2, .scratch/fix-world/m-gate.mjs): en pekare inne i en app-iframe syns inte
// alls för skalet. Iframen får aldrig :hover i skalet och skalet får varken pointerover, pointerout eller
// pointermove när pekaren går in i den. Däremot är document.activeElement iframen så fort fokus ligger i appen.
// Därför:
//  - key kräver att appens iframe har tangentbordsfokus (en riktig tangent i appen förutsätter det).
//  - wheel och focus kräver att skalet senast såg pekaren intill appens fönster: pekaren måste korsa kanten
//    för att komma in i iframen, och skalet ser varje rörelse fram till dess. Mängden räknas om vid varje
//    betrodd pekarhändelse i skalet och står kvar medan pekaren är inne i appen, även när kameran flyttar
//    fönstret (en panorering som börjat över appen fortsätter till appen tills gesten är slut).
//    Står pekaren still medan kameran flyttar ett fönster in under den (panorering över tom yta) gäller
//    platsen där skalet senast såg den, mot fönstrets plats nu. Tangentbordsfokus räcker också.
//  - Från ett fönster kan pekaren gå rakt in i ett annat som överlappar eller ligger nära, utan att skalet ser
//    den: ett snabbt drag (ungefär 25 px per händelse) hoppar över storlekszonerna mellan dem (uppmätt,
//    r4-sec.mjs). Hjul godtas därför också från en app vars fönster ligger inom NEAR_PX från ett fönster som
//    pekaren kan vara i (kedjan av fönster den kan gå mellan). Fokus och tangenter kräver mer: ett klick i
//    appen ger den tangentbordsfokus, och då godtas både fokus och tangenter.
//  - Innan skalet sett pekaren alls (sidan laddades om medan pekaren vilade över en app), och sedan pekaren
//    lämnat sidan (den kan komma tillbaka utifrån rakt ned i ett fönster vid vyns kant), vet skalet inte var
//    den är. Då godtas hjul, men inte fokus eller tangenter, från en app vars fönster syns och, när hjulet har
//    en punkt, är överst där. Uppmätt (.scratch/fix-world/r4-sec.mjs): annars gick det varken att nypa eller
//    panorera över appen förrän pekaren korsat skalet eller användaren klickat i appen. Att pekaren lämnar
//    sidan syns som pointerleave på <html> utan relatedTarget; att den går in i en iframe gör det inte
//    (uppmätt, r4-leave.mjs).
import type { ScreenRect } from '../types.ts';

/** Så nära ett fönster (skärm-px) skalet senast måste ha sett pekaren för att appens hjul ska godtas. */
export const NEAR_PX = 96;

export type GateKind = 'key' | 'wheel' | 'focus';

/** Syns rektangeln i vyn (vw × vh)? */
export function inView(r: ScreenRect, vw: number, vh: number): boolean {
  return r.w > 0 && r.h > 0 && r.x < vw && r.y < vh && r.x + r.w > 0 && r.y + r.h > 0;
}

/** Avståndet mellan två rektanglar (0 när de rör eller överlappar varandra). */
export function rectGap(a: ScreenRect, b: ScreenRect): number {
  const dx = Math.max(a.x - (b.x + b.w), 0, b.x - (a.x + a.w));
  const dy = Math.max(a.y - (b.y + b.h), 0, b.y - (a.y + a.h));
  return Math.hypot(dx, dy);
}

/** Avståndet från en punkt till en rektangel (0 inuti). */
export function distToRect(r: ScreenRect, x: number, y: number): number {
  const dx = Math.max(r.x - x, 0, x - (r.x + r.w));
  const dy = Math.max(r.y - y, 0, y - (r.y + r.h));
  return Math.hypot(dx, dy);
}

export class BridgeGate {
  #near = new Set<string>();
  /** Fönster som pekaren kan ha nått från #near utan att passera skalet (bara för hjul). */
  #reach = new Set<string>();
  #at: { x: number; y: number } | null = null;

  /**
   * En betrodd pekar- eller hjulhändelse i skalet vid (x, y): minns platsen, vilka appars fönster som
   * låg inom NEAR_PX just då, och kedjan av fönster som ligger inom NEAR_PX från dem.
   */
  pointer(x: number, y: number, windows: Iterable<{ appId: string; rect: ScreenRect }>): void {
    this.#at = { x, y };
    this.#near.clear();
    this.#reach.clear();
    const all = [...windows].filter((w) => w.appId);
    const queue = all.filter((w) => distToRect(w.rect, x, y) <= NEAR_PX);
    for (const w of queue) this.#near.add(w.appId);
    const seen = new Set(queue);
    while (queue.length) {
      const a = queue.pop()!;
      this.#reach.add(a.appId);
      for (const b of all) {
        if (seen.has(b) || rectGap(a.rect, b.rect) > NEAR_PX) continue;
        seen.add(b);
        queue.push(b);
      }
    }
  }

  /** Pekaren lämnade sidan: platsen är okänd tills skalet ser den igen, som efter en omladdning. */
  lost(): void {
    this.#at = null;
    this.#near.clear();
    this.#reach.clear();
  }

  /** Appen försvinner: den får aldrig något mer igenom. */
  forget(appId: string): void {
    this.#near.delete(appId);
    this.#reach.delete(appId);
  }

  /** rect: fönstrets plats på skärmen nu (för en pekare som stått still medan fönstret kom till den). */
  near(appId: string, rect?: ScreenRect): boolean {
    if (!appId) return false;
    if (this.#near.has(appId)) return true;
    return !!rect && !!this.#at && distToRect(rect, this.#at.x, this.#at.y) <= NEAR_PX;
  }

  /**
   * active: appens iframe har tangentbordsfokus (document.activeElement) och skalets dokument har fokus.
   * rect: fönstrets plats på skärmen nu.
   * plausible: frågas bara för hjul när skalet inte vet var pekaren är (före första pekarhändelsen, eller
   * sedan den lämnat sidan). Kan pekaren vara över appen (fönstret syns, och är överst där appen säger att
   * pekaren är)?
   */
  allows(kind: GateKind, appId: string, active: boolean, rect?: ScreenRect, plausible?: () => boolean): boolean {
    if (kind === 'key') return active;
    if (active || this.near(appId, rect)) return true;
    if (kind !== 'wheel') return false;
    return this.#reach.has(appId) || (this.#at === null && !!plausible?.());
  }
}
