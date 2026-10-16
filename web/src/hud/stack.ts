// stack.ts — ordningen mellan öppna HUD:ar (CONTRACT §13). Ren, utan DOM, enhetstestad.
// Två listor:
//   opened: i den ordning HUD:arna öppnades. Den avgör placeringen (en ny HUD flyttar aldrig en äldre) och är
//           vad hud:state.open bär.
//   recent: i den ordning de senast var aktiva. Sista posten är den aktiva, och listan är Esc-ordningen: stängs
//           den aktiva blir den som senast var aktiv före den aktiv.
// Automatiken öppnar bakom den aktiva (näst sist i recent), så att den inte tar fokus men blir aktiv när den
// aktiva stängs.

export interface Stack {
  readonly opened: readonly string[];
  readonly recent: readonly string[];
}

export const EMPTY: Stack = { opened: [], recent: [] };

export const activeOf = (s: Stack): string | null => s.recent.at(-1) ?? null;

export const isOpen = (s: Stack, id: string): boolean => s.opened.includes(id);

/**
 * Öppna en HUD. Redan öppen: activate flyttar den sist i recent, annars ändras inget.
 * Ny: läggs sist i opened; med activate (eller när ingen annan är öppen) sist i recent, annars näst sist.
 */
export function open(s: Stack, id: string, activate: boolean): Stack {
  if (isOpen(s, id)) return activate ? toFront(s, id) : s;
  const opened = [...s.opened, id];
  if (activate || s.recent.length === 0) return { opened, recent: [...s.recent, id] };
  const r = [...s.recent];
  r.splice(r.length - 1, 0, id);
  return { opened, recent: r };
}

/** Gör en öppen HUD aktiv (sist i recent). Okänd: oförändrad. */
export function activate(s: Stack, id: string): Stack {
  return isOpen(s, id) ? toFront(s, id) : s;
}

/** Stäng en HUD: bort ur båda listorna. */
export function close(s: Stack, id: string): Stack {
  if (!isOpen(s, id)) return s;
  return { opened: s.opened.filter((x) => x !== id), recent: s.recent.filter((x) => x !== id) };
}

/**
 * Efter en omladdning: opened = ids (dubbletter bort). recent = den sparade Esc-ordningen för de id som finns kvar,
 * följd av övriga i öppningsordning, med den aktiva sist. Finns den aktiva inte bland ids blir ordningens sista aktiv.
 */
export function restore(ids: readonly string[], active: string | null, recent: readonly string[] = []): Stack {
  const opened = [...new Set(ids)];
  const set = new Set(opened);
  const r = [...new Set(recent.filter((x) => set.has(x)))];
  for (const id of opened) if (!r.includes(id)) r.push(id);
  if (active && set.has(active)) {
    r.splice(r.indexOf(active), 1);
    r.push(active);
  }
  return { opened, recent: r };
}

function toFront(s: Stack, id: string): Stack {
  if (s.recent.at(-1) === id) return s;
  return { opened: s.opened, recent: [...s.recent.filter((x) => x !== id), id] };
}
