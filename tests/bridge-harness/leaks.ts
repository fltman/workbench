// leaks.ts — planterade läckor för kalibrering (CONTRACT §15: varje test som ska visa att något inte
// läcker fälls först av en planterad läcka). Varje läcka är en exakt textändring i den riktiga källan.
// applyLeak kastar om texten inte finns exakt en gång, så att en kalibrering aldrig tyst blir en no-op.

export type Patch = readonly [from: string, to: string];

/** Läckor i sdk/wb.js (serveras som /__wb/wb.js?leak=<namn> av testriggen). */
export const WB_LEAKS = {
  /** Hjulet förhindras aldrig: webbläsaren får göra sitt (scrolla, zooma). */
  'wheel-prevent': [['if (e.cancelable) e.preventDefault();\n      const near', 'const near']],
  /** Skalets tangenter når appen ändå. */
  'key-stop': [['e.preventDefault();\n      e.stopImmediatePropagation();\n      if (!e.repeat) sendKey(e, c);', 'e.preventDefault();\n      if (!e.repeat) sendKey(e, c);']],
  /** Esc skickas även när appen själv anropat preventDefault. */
  'escape-check': [["if (!e.defaultPrevented) sendKey(e, 'Escape');", "sendKey(e, 'Escape');"]],
  /** Hjulets heltalskoordinater i stället för pekarens fraktionella. */
  precise: [['x: near ? px : e.clientX,\n        y: near ? py : e.clientY,', 'x: e.clientX,\n        y: e.clientY,']],
  /** Bryggan tror att den alltid ligger i en iframe. */
  toplevel: [['const EMBEDDED = window.parent !== window;', 'const EMBEDDED = true;']],
  /** Ett misslyckat loggutskick loggas, vilket ger en återkopplingsslinga. */
  'log-feedback': [
    [
      "body, keepalive: final === true }).catch(() => {});",
      "body, keepalive: final === true }).then((r) => { if (!r.ok) console.error('wb: loggen svarade ' + r.status); }, () => {});",
    ],
  ],
  /** Ingen tömning när sidan lämnas: det som väntar på nästa bunt försvinner. */
  pagehide: [["  addEventListener('pagehide', () => flush(true));\n", '']],
  /** Rekursionsspärren borta: console.error inifrån formateringen loggar igen. */
  'log-guard': [['    if (inLog) return;\n    inLog = true;\n    try {\n      fn();', '    inLog = true;\n    try {\n      fn();']],
} as const satisfies Record<string, readonly Patch[]>;

/** Läckor i web/src/bridge.ts. */
export const BRIDGE_LEAKS = {
  /** Origin kontrolleras inte. */
  origin: [['    if (e.origin !== origin) return; // iframen har navigerat till en annan origin\n', '']],
  /** Avsändaren identifieras via origin i stället för via event.source. */
  'by-origin': [
    [
      'w = opts.resolve(e.source);',
      'w = opts.resolve(e.source) ?? ((globalThis as unknown as { __resolveByOrigin?: (o: string) => BridgeWindow | null }).__resolveByOrigin?.(e.origin) ?? null);',
    ],
  ],
  /** Ingen hastighetsbegränsning. */
  rate: [['    if (!take(w.appId)) return;\n', '']],
  /** Talen kläms inte. */
  clamp: [['  return Math.min(hi, Math.max(lo, v));', '  return v;']],
  /** Piltangenter godtas utan ⌃⌥. */
  vocab: [["    if ((code === 'ArrowLeft' || code === 'ArrowRight') && !(ctrl && alt)) return null;\n", '']],
} as const satisfies Record<string, readonly Patch[]>;

export function applyLeak(source: string, patches: readonly Patch[]): string {
  let out = source;
  for (const [from, to] of patches) {
    const n = out.split(from).length - 1;
    if (n !== 1) throw new Error(`planterad läcka: texten finns ${n} gånger, inte exakt en: ${JSON.stringify(from.slice(0, 80))}`);
    out = out.replace(from, () => to);
  }
  return out;
}
