// gestures.ts — hjulrouterns och tangenternas beslut (CONTRACT §10.3) som rena funktioner, enhetstestade.
// DOM-kopplingen ligger i input.ts.
import { clamp } from './math.ts';

/** deltaMode 0, 1, 2 → px (×16 för rader, ×400 för sidor). */
export function normDelta(d: number, mode: number): number {
  return mode === 1 ? d * 16 : mode === 2 ? d * 400 : d;
}

/** Nyp: ctrl+wheel → zoomfaktor. Klämningen tämjer hackiga mushjul. */
export function zoomFactor(dyPx: number): number {
  return Math.exp(-clamp(dyPx, -50, 50) / 100);
}

export interface WheelLike {
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  /** Den gamla WheelEvent.wheelDeltaY (0 vid smart zoom). */
  wheelDeltaY?: number;
}

export type WheelAction =
  | { kind: 'ignore' } // lämnas orört (vanligt hjul över HUD:en)
  | { kind: 'zoom'; factor: number }
  | { kind: 'smart' } // tvåfingers dubbeltryck
  | { kind: 'pan'; dx: number; dy: number } // px som innehållet ska flyttas
  | { kind: 'scale-window'; factor: number } // ⌥+nyp
  | { kind: 'rotate'; dx: number } // ⌥+vågrätt
  | { kind: 'none' }; // stoppas men gör inget

/** Beslutet för en hjulhändelse på #stage. overHud: target ligger i #hud-layer. */
export function classifyWheel(e: WheelLike, overHud: boolean): WheelAction {
  const modified = e.ctrlKey || e.metaKey || e.altKey;
  if (overHud && !modified) return { kind: 'ignore' };
  const dx = normDelta(e.deltaX, e.deltaMode);
  const dy = normDelta(e.deltaY, e.deltaMode);
  if (e.ctrlKey) {
    if (e.altKey) return { kind: 'scale-window', factor: zoomFactor(dy) };
    if (e.deltaX === 0 && e.deltaY === 0 && (e.wheelDeltaY ?? 0) === 0) return { kind: 'smart' };
    return { kind: 'zoom', factor: zoomFactor(dy) };
  }
  if (e.metaKey) return { kind: 'pan', dx: -dx, dy: -dy };
  if (e.altKey) return Math.abs(dx) >= Math.abs(dy) && dx !== 0 ? { kind: 'rotate', dx } : { kind: 'none' };
  return { kind: 'pan', dx: -dx, dy: -dy };
}

export type SmartAction = 'fly-to' | 'back' | 'fit' | 'none';

/**
 * Smart zoom och dubbelklick på tom yta (§10.3). hit: appen vars fönster ligger under pekaren (null på tom yta).
 * flownTo: appen kameran senast flög till. canGoBack: tillbaka-stacken har något. På tom yta utan något att flyga
 * tillbaka till visar den allt, som ⌘0, så att det finns en väg tillbaka med pekaren när man zoomat vilse.
 */
export function smartAction(hit: string | null, flownTo: string | null, canGoBack: boolean): SmartAction {
  if (hit && hit !== flownTo) return 'fly-to';
  if (canGoBack) return 'back';
  return hit ? 'none' : 'fit';
}

export interface KeyLike {
  code: string;
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  repeat: boolean;
}

export type KeyAction = 'toggle-hud' | 'fit' | 'prev-face' | 'next-face' | 'escape';

/** Vilken av skalets tangenter det är (⌘K, ⌘0, ⌃⌥←/→, Esc), oavsett upprepning. Matchning på e.code. */
export function matchKey(e: Omit<KeyLike, 'repeat'>): KeyAction | null {
  if (e.metaKey && !e.ctrlKey && !e.altKey && e.code === 'KeyK') return 'toggle-hud';
  if (e.metaKey && !e.ctrlKey && !e.altKey && e.code === 'Digit0') return 'fit';
  if (e.ctrlKey && e.altKey && !e.metaKey && e.code === 'ArrowLeft') return 'prev-face';
  if (e.ctrlKey && e.altKey && !e.metaKey && e.code === 'ArrowRight') return 'next-face';
  if (e.code === 'Escape' || e.key === 'Escape') return 'escape';
  return null;
}

/** Som matchKey, men upprepningar (e.repeat) ger ingen åtgärd för just dessa tangenter. */
export function classifyKey(e: KeyLike): KeyAction | null {
  return e.repeat ? null : matchKey(e);
}
