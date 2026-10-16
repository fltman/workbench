// focusguard.ts — en app som tar fokus av sig själv (autofocus när den laddas, till exempel efter ett bygge) får inte
// ta det från skalets inmatningar (fältet §10.9, den aktiva HUD:en §13). Uppmätt i Anders instans: hans webbläsare tog
// fokus till sin iframe tre sekunder efter att sidan laddats, och Esc och tecknen hamnade i appen.
//
// En användare som klickar i en app syns för skalet som 'app:focus' (bryggans focus vid pointerdown, §11). Går fokus
// till en app-iframe utan ett sådant klick strax före eller efter tas det tillbaka. Meddelandet och blur kommer från
// olika processer, så ordningen mellan dem är inte given: ett klick inom USER_MS före räknas också.
import { bus } from '../bus.ts';

let lastAppFocus = Number.NEGATIVE_INFINITY;
bus.on('app:focus', () => (lastAppFocus = performance.now()));

/** Hur länge efter att fokus gått till en iframe bryggans focus kan komma (meddelandet är asynkront). */
const GRACE_MS = 160;
/** Ett klick i en app så här långt före blur räknas som användarens. */
const USER_MS = 500;

/** Ta tillbaka fokus till input när en app tar det av sig själv, så länge keep() är sant. */
export function guardFocus(input: HTMLElement, keep: () => boolean): void {
  input.addEventListener('blur', () => {
    if (!keep()) return;
    const at = performance.now();
    setTimeout(() => {
      if (!keep() || !input.isConnected) return;
      const a = document.activeElement;
      if (a instanceof HTMLIFrameElement && lastAppFocus < at - USER_MS) input.focus({ preventScroll: true });
    }, GRACE_MS);
  });
}
