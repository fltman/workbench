// seed.ts — fröytans konstruktionslinjer (CONTRACT §14): svaga stödlinjer på ett ritat men obyggt ark, och
// under bygget en grupp till per tool-händelse: rubrikrad, rader, en kolumn, sedan fler detaljer.
// Ren geometri i layout-px (appens CSS-px); DOM:en byggs i windows.ts. Ingen text.

export interface SeedGroup {
  /** SVG-sökvägar i layout-px. */
  paths: string[];
}

const f = (v: number): string => (Math.round(v * 10) / 10).toString();
const line = (x1: number, y1: number, x2: number, y2: number): string => `M${f(x1)} ${f(y1)}L${f(x2)} ${f(y2)}`;
function rrect(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  return (
    `M${f(x + rr)} ${f(y)}H${f(x + w - rr)}A${f(rr)} ${f(rr)} 0 0 1 ${f(x + w)} ${f(y + rr)}V${f(y + h - rr)}` +
    `A${f(rr)} ${f(rr)} 0 0 1 ${f(x + w - rr)} ${f(y + h)}H${f(x + rr)}A${f(rr)} ${f(rr)} 0 0 1 ${f(x)} ${f(y + h - rr)}` +
    `V${f(y + rr)}A${f(rr)} ${f(rr)} 0 0 1 ${f(x + rr)} ${f(y)}Z`
  );
}
function circle(cx: number, cy: number, r: number): string {
  return `M${f(cx - r)} ${f(cy)}A${f(r)} ${f(r)} 0 1 0 ${f(cx + r)} ${f(cy)}A${f(r)} ${f(r)} 0 1 0 ${f(cx - r)} ${f(cy)}Z`;
}
/** Deterministisk variation (0..1) så att raderna inte blir identiska. */
const jit = (i: number): number => ((i * 37 + 11) % 23) / 23;

/** Stödlinjerna på ett nyss ritat ark: marginalerna, dragna förbi hörnen som på ett ritbord. */
export function seedGuides(W: number, H: number): string[] {
  const m = Math.min(24, W * 0.06, H * 0.08);
  return [line(0, m, W, m), line(0, H - m, W, H - m), line(m, 0, m, H), line(W - m, 0, W - m, H)];
}

/** Var kolumnen delar arket (bred app: en lista till vänster och en läsyta till höger). */
export function columnX(W: number): number | null {
  return W >= 520 ? Math.round(Math.min(Math.max(W * 0.36, 200), 340)) : null;
}

/** Grupperna i den ordning de tecknas in. */
export function seedGroups(W: number, H: number): SeedGroup[] {
  const m = 24;
  const head = Math.min(56, H * 0.22);
  const col = columnX(W);
  const listR = col ?? W - m;
  const groups: SeedGroup[] = [];

  // 1. Rubrikraden: rubrik, två verktygsknappar och raden under.
  {
    const p: string[] = [];
    p.push(rrect(m, head / 2 - 7, Math.min(150, W * 0.3), 14, 7));
    const bx = W - m - 9;
    p.push(circle(bx, head / 2, 9), circle(bx - 30, head / 2, 9));
    p.push(line(0, head, W, head));
    groups.push({ paths: p });
  }

  // 2. Raderna: en lista med avdelare och två textstreck per rad.
  {
    const p: string[] = [];
    const rowH = 58;
    const width = listR - m;
    for (let i = 0, y = head; y + rowH <= H - m * 0.5 && i < 14; i++, y += rowH) {
      p.push(rrect(m, y + 14, width * (0.38 + 0.3 * jit(i)), 10, 5));
      p.push(rrect(m, y + 32, width * (0.6 + 0.3 * jit(i + 5)), 8, 4));
      p.push(line(m, y + rowH, listR, y + rowH));
    }
    groups.push({ paths: p });
  }

  // 3. En kolumn: avdelaren och läsytans stycken (smal app: en kolumn med stycken under listan saknas,
  //    då delas arket i stället av en bottenrad).
  {
    const p: string[] = [];
    if (col !== null) {
      p.push(line(col, head, col, H));
      const x0 = col + m + 4;
      const w = W - x0 - m - 4;
      p.push(rrect(x0, head + 26, w * 0.55, 16, 8));
      let y = head + 64;
      for (let i = 0; y + 9 <= H - m; i++, y += 22) {
        if (i % 5 === 4) continue; // styckebrytning
        p.push(rrect(x0, y, w * (0.62 + 0.36 * jit(i + 2)), 8, 4));
      }
    } else {
      p.push(line(0, H - 64, W, H - 64));
      p.push(rrect(m, H - 46, W - 2 * m - 46, 28, 14), circle(W - m - 14, H - 32, 14));
    }
    groups.push({ paths: p });
  }

  // 4. Avatarer i listan.
  {
    const p: string[] = [];
    const rowH = 58;
    for (let i = 0, y = head; y + rowH <= H - m * 0.5 && i < 14; i++, y += rowH) p.push(circle(listR - 22, y + 24, 6));
    groups.push({ paths: p });
  }

  // 5. Ett kort överst på läsytan (eller under rubriken i en smal app).
  {
    const p: string[] = [];
    if (col !== null) {
      const x0 = col + m + 4;
      const w = W - x0 - m - 4;
      const top = Math.min(H - m - 60, head + 64 + 22 * 6);
      if (top > head + 64) p.push(rrect(x0, top, w, Math.min(120, H - top - m), 12));
    } else {
      p.push(rrect(m, head + 12, W - 2 * m, Math.min(90, H * 0.2), 12));
    }
    groups.push({ paths: p });
  }

  // 6. Inmatningsraden längst ner på läsytan.
  {
    const p: string[] = [];
    if (col !== null) {
      const x0 = col + m;
      p.push(line(col, H - 60, W, H - 60), rrect(x0, H - 46, W - x0 - m - 44, 28, 14), circle(W - m - 14, H - 32, 14));
    }
    groups.push({ paths: p });
  }

  return groups.filter((g) => g.paths.length > 0);
}

/** Hur många tool-händelser den senaste turen har haft (räknat från dess turn start). */
export function toolsInLastTurn(events: ReadonlyArray<{ k: string; phase?: string }>): number {
  let n = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.k === 'turn' && e.phase === 'start') return n;
    if (e.k === 'tool') n++;
  }
  return n;
}
