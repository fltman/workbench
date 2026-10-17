// types.ts — gränssnitten mellan skalets delar. FRUSET: ändra CONTRACT.md först.
import type { OpenItem } from '../../shared/protocol.ts';

/** Rektangel i skärmens CSS-px (skalets viewport). */
export interface ScreenRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Det HUD:en behöver av världen. Implementeras av web/src/world/world.ts. */
export interface World {
  /** Fönstrets rektangel på skärmen just nu, eller null om appen saknar fönster. */
  screenRectOf(appId: string): ScreenRect | null;
  /** Var appens blå prick sitter på skärmen (mittpunkt). */
  dotOf(appId: string): { x: number; y: number } | null;
  /** Flyg kameran så att fönstret fyller vyn (med marginal); andra anropet flyger tillbaka. */
  flyTo(appId: string): void;
  /** Lägg fönstret överst och gör appen till den i fokus (⌘K gäller den). */
  focus(appId: string): void;
  /** Animera bort fönstret. Idempotent; världen gör det också själv vid window.removed/app.removed. */
  dissolve(appId: string): Promise<void>;
  /** Minimera appen till raden i nedre vänstra hörnet (§10.7). Stänger appens HUD. */
  minimize(appId: string): void;
  /** Ta fram en minimerad app till sin plats. */
  restore(appId: string): void;
  isMinimized(appId: string): boolean;
  /** Fältet (§10.9): flyg till appen och visa dess första sida (en minimerad app tas fram först). */
  show(appId: string): void;
  /** Lämna något från fältet till appens första sida (wb.onOpen). false: appen anger inte slaget i opens. */
  deliver(appId: string, item: OpenItem): boolean;
  /** En ny app mitt i vyn, som om den ritats (HUD:en öppnas med reason 'created'). Ger appens id. */
  createApp(): Promise<string | null>;
}

/**
 * Fabriker (implementeras av respektive byggare):
 *   web/src/world/world.ts  export function createWorld(stage: HTMLElement): World
 *   web/src/hud/hud.ts      export function createHud(layer: HTMLElement, world: World): void
 *   web/src/bridge.ts       export function createParentBridge(opts: ParentBridgeOptions): () => void
 * Världen följer HUD:arnas läge via bus-händelsen 'hud:state'.
 */

/** Ett app-fönster som bryggan känner igen via event.source. */
export interface BridgeWindow {
  appId: string;
  /** Vilken sida (face-id) iframen visar. */
  face: string;
  /** Punkt i appens CSS-px -> skärmens CSS-px (genom fönstrets transform och kameran, även roterade sidor). */
  toScreen(x: number, y: number): { x: number; y: number };
}

export interface ParentBridgeOptions {
  /** Hitta fönstret vars iframe har detta contentWindow. */
  resolve(source: MessageEventSource | null): BridgeWindow | null;
  /** Exakt origin för en app, t.ex. 'http://ak3x9q2.localhost:8220'. Meddelandet godtas bara om e.origin är just den. */
  appOrigin(appId: string): string;
  onHello?(w: BridgeWindow, info: { face: string; w: number; h: number }): void;
  /** ctrl+wheel (nyp) i appen. sx/sy = skärmpunkt. alt = skala bara fönstret. smart = tvåfingers dubbeltryck. */
  onZoom?(w: BridgeWindow, dy: number, sx: number, sy: number, opts: { alt: boolean; smart: boolean; mode: number }): void;
  /** Panorera världen (wheel som appen inte kan scrolla, eller ⌘+wheel). */
  onPan?(w: BridgeWindow, dx: number, dy: number, mode: number, momentum: boolean): void;
  /** ⌥+wheel över appen (vrid prisma vågrätt). */
  onAltWheel?(w: BridgeWindow, dx: number, dy: number, momentum: boolean): void;
  /** Bara ⌘K, ⌘0, ⌃⌥←/→ och Esc. */
  onKey?(w: BridgeWindow, key: { code: 'KeyK' | 'Digit0' | 'ArrowLeft' | 'ArrowRight' | 'Escape'; meta: boolean; ctrl: boolean; alt: boolean; shift: boolean }): void;
  onFocus?(w: BridgeWindow): void;
  /** Appen ber om att en viss sida vrids fram (wb.face.show). */
  onFaceRequest?(w: BridgeWindow, faceId: string): void;
  /** Appens märke bredvid pricken (wb.badge, §10.5): redan tvättat, högst 3 kodpunkter; null tar bort det. */
  onBadge?(w: BridgeWindow, text: string | null): void;
}
