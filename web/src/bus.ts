// bus.ts — typade händelser mellan världen (web/src/world) och HUD:en (web/src/hud). FRUSET.
import type { AppPermission } from '../../shared/protocol.ts';

export interface BusEvents {
  /** Öppna appens HUD och gör den aktiv. Andra öppna HUD:ar står kvar. Är den redan öppen blir den bara aktiv. Sänds av världen. */
  'hud:open': { appId: string; reason: 'created' | 'dot' | 'key' };
  /** Stäng appens HUD, aktiv eller inte (den sjunker in i pricken). Sänds av världen (pricken, ⌘K, tryck på tom yta). */
  'hud:close': { appId: string };
  /**
   * Öppna appens HUD, gör den aktiv och skicka texten som användarens meddelande, som om den skrivits och skickats
   * med Enter (ett klick på ett förslag, §10.8). Sänds av världen.
   */
  'hud:send': { appId: string; text: string };
  /**
   * HUD:arnas läge. open: apparna med öppen HUD, i den ordning de öppnades. active: den aktiva, null precis när
   * open är tom. Sänds BARA av HUD:en, efter varje öppning, stängning och byte av aktiv.
   */
  'hud:state': { open: string[]; active: string | null };
  /** Kamera eller fönstergeometri ändrades. Sänds av världen högst en gång per bildruta. */
  'view:changed': Record<string, never>;
  /** Användaren arbetar i en app (pekare ned i iframen eller i dess krom). Sänds av världen. */
  'app:focus': { appId: string };
  /** Ett fönster har skapats av en ritad fyrkant och är på plats. Sänds av världen före 'hud:open'. */
  'window:created': { appId: string };
  /** Användaren gav eller nekade en app webbläsarbehörigheter (HUD:en sparar dem; världen bygger om iframen). */
  'grants:changed': { appId: string };
}

type Handler<T> = (payload: T) => void;

class Bus<E extends object> {
  #handlers = new Map<keyof E, Set<Handler<never>>>();

  on<K extends keyof E>(type: K, fn: Handler<E[K]>): () => void {
    let set = this.#handlers.get(type);
    if (!set) this.#handlers.set(type, (set = new Set()));
    set.add(fn as Handler<never>);
    return () => set.delete(fn as Handler<never>);
  }

  emit<K extends keyof E>(type: K, payload: E[K]): void {
    const set = this.#handlers.get(type);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        (fn as Handler<E[K]>)(payload);
      } catch (err) {
        console.error(`[bus] ${String(type)}`, err);
      }
    }
  }
}

export const bus = new Bus<BusEvents>();

/* ---------------- behörigheter som användaren gett appar (per webbläsare) ---------------- */

const GRANTS_KEY = 'wb:grants';

/** Behörigheter användaren sagt ja till för en app. Läses av världen när den bygger iframes. */
export function grantsFor(appId: string): AppPermission[] {
  try {
    const all = JSON.parse(localStorage.getItem(GRANTS_KEY) ?? '{}') as Record<string, AppPermission[]>;
    return Array.isArray(all[appId]) ? all[appId] : [];
  } catch {
    return [];
  }
}

/** Sparas av HUD:en, som sedan sänder 'grants:changed'. */
export function setGrants(appId: string, perms: AppPermission[]): void {
  try {
    const all = JSON.parse(localStorage.getItem(GRANTS_KEY) ?? '{}') as Record<string, AppPermission[]>;
    all[appId] = perms;
    localStorage.setItem(GRANTS_KEY, JSON.stringify(all));
  } catch {
    /* lagring otillgänglig: behörigheten gäller inte */
  }
}
