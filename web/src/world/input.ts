// input.ts — DOM-kopplingen för hjulet och tangenterna (CONTRACT §10.3). Besluten fattas i gestures.ts.
import type { KeyAction } from './gestures.ts';
import { classifyKey, classifyWheel, matchKey } from './gestures.ts';

export interface WheelHandlers {
  zoom(factor: number, sx: number, sy: number): void;
  smart(sx: number, sy: number): void;
  pan(dx: number, dy: number): void;
  scaleWindow(factor: number, sx: number, sy: number): void;
  rotate(dx: number, sx: number, sy: number, momentum: boolean, t: number): void;
  /** Nypet är slut (120 ms utan händelser), eller Safaris gestureend. */
  pinchEnd(): void;
}

/** Safaris GestureEvent (finns inte i lib.dom). */
interface GestureLike extends UIEvent {
  scale: number;
  clientX: number;
  clientY: number;
}

/**
 * Hjulroutern på #stage med { passive: false }: om första händelsen i en gest inte stoppas zoomar Chrome
 * hela sidan. Vanliga hjul vars target ligger i #hud-layer lämnas orörda (HUD:ens lista scrollar själv).
 */
export function attachWheel(stage: HTMLElement, hudLayer: Element | null, h: WheelHandlers): () => void {
  let pinchTimer: ReturnType<typeof setTimeout> | null = null;
  let gesture: { scale: number } | null = null;
  const pinched = (): void => {
    if (pinchTimer) clearTimeout(pinchTimer);
    pinchTimer = setTimeout(() => {
      pinchTimer = null;
      h.pinchEnd();
    }, 120);
  };

  const onWheel = (e: WheelEvent): void => {
    const t = e.target;
    const overHud = !!hudLayer && t instanceof Node && hudLayer.contains(t);
    const a = classifyWheel({ ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, deltaX: e.deltaX, deltaY: e.deltaY, deltaMode: e.deltaMode, wheelDeltaY: (e as WheelEvent & { wheelDeltaY?: number }).wheelDeltaY }, overHud);
    if (a.kind === 'ignore') return;
    e.preventDefault();
    switch (a.kind) {
      case 'zoom':
        if (gesture) return; // Safari: gesten zoomar redan
        h.zoom(a.factor, e.clientX, e.clientY);
        pinched();
        break;
      case 'smart':
        h.smart(e.clientX, e.clientY);
        break;
      case 'pan':
        h.pan(a.dx, a.dy);
        break;
      case 'scale-window':
        h.scaleWindow(a.factor, e.clientX, e.clientY);
        pinched();
        break;
      case 'rotate':
        h.rotate(a.dx, e.clientX, e.clientY, (e as WheelEvent & { momentum?: boolean }).momentum === true, e.timeStamp);
        break;
      default:
        break;
    }
  };

  const gs = (ev: Event): void => {
    const e = ev as GestureLike;
    e.preventDefault();
    gesture = { scale: e.scale || 1 };
  };
  const gc = (ev: Event): void => {
    const e = ev as GestureLike;
    e.preventDefault();
    if (!gesture || !e.scale) return;
    h.zoom(e.scale / gesture.scale, e.clientX, e.clientY);
    gesture.scale = e.scale;
  };
  const ge = (ev: Event): void => {
    ev.preventDefault();
    gesture = null;
    h.pinchEnd();
  };

  stage.addEventListener('wheel', onWheel, { passive: false });
  stage.addEventListener('gesturestart', gs, { passive: false } as AddEventListenerOptions);
  stage.addEventListener('gesturechange', gc, { passive: false } as AddEventListenerOptions);
  stage.addEventListener('gestureend', ge, { passive: false } as AddEventListenerOptions);
  return () => {
    stage.removeEventListener('wheel', onWheel);
    stage.removeEventListener('gesturestart', gs);
    stage.removeEventListener('gesturechange', gc);
    stage.removeEventListener('gestureend', ge);
  };
}

/**
 * Den enda keydown-lyssnaren på skalets window (capture). handle får skalets tangenter (⌘K, ⌘0, ⌃⌥←/→, Esc)
 * och svarar true om den tog hand om tangenten. other får alla andra tangenter (för inmatningsbufferten).
 * Upprepningar av skalets tangenter stoppas men gör ingenting.
 */
export function attachKeys(handle: (a: KeyAction) => boolean, other: (e: KeyboardEvent) => void): () => void {
  const onKey = (e: KeyboardEvent): void => {
    if (e.isComposing) return;
    const m = matchKey(e);
    if (!m) {
      other(e);
      return;
    }
    const a = classifyKey(e);
    if (!a) {
      if (m !== 'escape') e.preventDefault(); // en hållen ⌘0 ska inte nollställa sidans zoom
      return;
    }
    if (handle(a) || a === 'fit' || a === 'toggle-hud') e.preventDefault();
  };
  window.addEventListener('keydown', onKey, true);
  return () => window.removeEventListener('keydown', onKey, true);
}
