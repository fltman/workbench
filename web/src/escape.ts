// escape.ts — Esc stänger det innersta först: avbryt drag → stäng HUD → lämna fokus.
// Den som startar ett läge pushar en hanterare och anropar den returnerade funktionen när läget tar slut.

const stack: Array<() => void> = [];

export function pushEscape(fn: () => void): () => void {
  stack.push(fn);
  return () => {
    const i = stack.lastIndexOf(fn);
    if (i >= 0) stack.splice(i, 1);
  };
}

/** Kör den innersta hanteraren. Returnerar false om stacken var tom. */
export function runEscape(): boolean {
  const fn = stack.pop();
  if (!fn) return false;
  fn();
  return true;
}
