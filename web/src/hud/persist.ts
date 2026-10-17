// persist.ts — HUD:ens tillstånd över en omladdning av sidan (sessionStorage, alltså per flik).
// I dev laddar Vites HMR-klient om hela skalet efter varje omstart av servern, och ⌘R gör detsamma.
// Utan detta stängdes en öppen HUD och ett osänt utkast försvann (uppmätt).
// Det som sparas: vilka appar som har sin HUD öppen (i den ordning de öppnades), för var och en hur den öppnades,
// om något skickats sedan dess och vilken sida den står på, vilken som är aktiv, Esc-ordningen och de halvskrivna
// utkasten per app. Ett värde i den äldre formen (en enda app) läses som en öppen HUD. Varje åtkomst är inlindad
// i try/catch: utan lagring (privat fönster, blockerad webbplatsdata) fungerar HUD:arna som förut, bara utan minne.

import { APP_ID_RE } from '../../../shared/protocol.ts';

const KEY = 'wb.hud';
const REASONS = ['created', 'dot', 'key', 'auto'] as const;
/** Ett utkast är vad som ryms i inmatningen; mer sparas inte. */
const MAX_DRAFT = 20_000;
const MAX_DRAFTS = 64;

export type SavedReason = (typeof REASONS)[number];

const SIDES = ['right', 'left', 'below', 'above', 'overlay', 'dock'] as const;
export type SavedSide = (typeof SIDES)[number];
/** Ett trasigt värde får inte växa utan gräns. */
export const MAX_OPEN = 16;

export interface SavedHud {
  app: string;
  reason: SavedReason;
  sent: boolean;
  side: SavedSide | null;
}

export interface Saved {
  /** HUD:arna i den ordning de öppnades. */
  open: SavedHud[];
  /** Den aktiva, eller null. Alltid en av open. */
  active: string | null;
  /** Esc-ordningen (den aktiva sist), bara appar i open. */
  recent: string[];
  drafts: Record<string, string>;
}

/** Tolka det sparade värdet. Allt som inte stämmer kastas, så att en trasig post aldrig öppnar fel app. */
export function parseSaved(raw: string | null): Saved | null {
  if (!raw) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  // Den äldre formen { app, reason, sent, drafts }: en enda HUD.
  const list: unknown[] = Array.isArray(o.open) ? o.open : 'app' in o ? [{ app: o.app, reason: o.reason, sent: o.sent }] : [];
  const open: SavedHud[] = [];
  for (const e of list) {
    if (open.length >= MAX_OPEN) break;
    if (!e || typeof e !== 'object' || Array.isArray(e)) continue;
    const r = e as Record<string, unknown>;
    if (typeof r.app !== 'string' || !APP_ID_RE.test(r.app) || open.some((x) => x.app === r.app)) continue;
    open.push({
      app: r.app,
      reason: REASONS.includes(r.reason as SavedReason) ? (r.reason as SavedReason) : 'key',
      sent: r.sent === true,
      side: SIDES.includes(r.side as SavedSide) ? (r.side as SavedSide) : null,
    });
  }
  const ids = new Set(open.map((x) => x.app));
  const activeRaw = 'open' in o ? o.active : o.app;
  const active = typeof activeRaw === 'string' && ids.has(activeRaw) ? activeRaw : null;
  const recent = Array.isArray(o.recent) ? [...new Set(o.recent.filter((x): x is string => typeof x === 'string' && ids.has(x)))] : [];
  const drafts: Record<string, string> = {};
  if (o.drafts && typeof o.drafts === 'object' && !Array.isArray(o.drafts)) {
    let n = 0;
    for (const [k, d] of Object.entries(o.drafts as Record<string, unknown>)) {
      if (!APP_ID_RE.test(k) || typeof d !== 'string' || !d.trim()) continue;
      if (++n > MAX_DRAFTS) break;
      drafts[k] = d.slice(0, MAX_DRAFT);
    }
  }
  return { open, active, recent, drafts };
}

export function loadSaved(): Saved | null {
  try {
    return parseSaved(sessionStorage.getItem(KEY));
  } catch {
    return null;
  }
}

export function save(s: Saved): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* ingen lagring: HUD:en klarar sig utan */
  }
}
