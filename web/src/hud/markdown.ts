// markdown.ts — enkel markdown för Claudes svar i HUD:en (CONTRACT §13): stycken, **fet**, `kod`, listor.
// Bara tolkning till ett rent träd av data, aldrig HTML. DOM:en byggs i markdown-dom.ts med createElement
// och textContent, så att en sträng från Claude aldrig kan bli markup. Inga länkar eller bilder.

export type Inline =
  | { t: 'text'; text: string }
  | { t: 'strong'; children: Inline[] }
  | { t: 'em'; children: Inline[] }
  | { t: 'code'; text: string }
  | { t: 'br' };

export type Block =
  | { t: 'p'; children: Inline[] }
  | { t: 'ul'; items: Inline[][] }
  | { t: 'ol'; start: number; items: Inline[][] }
  | { t: 'pre'; text: string };

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const BULLET = /^\s{0,8}[-*+•]\s+(.*)$/;
const ORDERED = /^\s{0,8}(\d{1,9})[.)]\s+(.*)$/;
const HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const CONTINUATION = /^\s{2,}\S/;

/** Tolkar markdown till block. Ofullständig markdown (under strömning) blir bokstavlig text. */
export function parseMarkdown(src: string): Block[] {
  const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let para: string[] = [];
  let list: { t: 'ul' | 'ol'; start: number; items: string[][] } | null = null;

  const flushPara = () => {
    if (para.length) blocks.push({ t: 'p', children: joinLines(para) });
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    const items = list.items.map(joinLines);
    blocks.push(list.t === 'ul' ? { t: 'ul', items } : { t: 'ol', start: list.start, items });
    list = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = FENCE.exec(line);
    if (fence) {
      flushPara();
      flushList();
      const marker = fence[1];
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith(marker)) body.push(lines[i++]);
      blocks.push({ t: 'pre', text: body.join('\n') });
      continue;
    }
    if (!line.trim() || RULE.test(line)) {
      flushPara();
      flushList();
      continue;
    }
    const bullet = BULLET.exec(line);
    const ordered = bullet ? null : ORDERED.exec(line);
    if (bullet || ordered) {
      flushPara();
      const kind = bullet ? 'ul' : 'ol';
      if (!list || list.t !== kind) {
        flushList();
        list = { t: kind, start: ordered ? Number(ordered[1]) : 1, items: [] };
      }
      list.items.push([bullet ? bullet[1] : (ordered as RegExpExecArray)[2]]);
      continue;
    }
    if (list && CONTINUATION.test(line)) {
      list.items[list.items.length - 1].push(line.trim());
      continue;
    }
    flushList();
    const heading = HEADING.exec(line);
    if (heading) {
      flushPara();
      blocks.push({ t: 'p', children: [{ t: 'strong', children: parseInline(heading[1]) }] });
      continue;
    }
    const quote = QUOTE.exec(line);
    para.push(quote ? quote[1] : line.trim());
  }
  flushPara();
  flushList();
  return blocks;
}

function joinLines(lines: string[]): Inline[] {
  const out: Inline[] = [];
  lines.forEach((l, i) => {
    if (i > 0) out.push({ t: 'br' });
    out.push(...parseInline(l));
  });
  return out;
}

const PUNCT = /[!-/:-@[-`{-~\u{2000}-\u{206f}\u{3000}-\u{303f}]/u;
const isSpace = (c: string | undefined) => c === undefined || /\s/u.test(c);
const isWordChar = (c: string | undefined) => c !== undefined && !isSpace(c) && !PUNCT.test(c);

/** Tolkar inline-markdown: `kod`, **fet**, __fet__, *kursiv*, _kursiv_ och \-escapes. Allt annat är text. */
export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let buf = '';
  const flush = () => {
    if (buf) out.push({ t: 'text', text: buf });
    buf = '';
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\' && i + 1 < src.length && /[!-/:-@[-`{-~]/.test(src[i + 1])) {
      buf += src[i + 1];
      i += 2;
      continue;
    }
    if (c === '`') {
      const n = runLength(src, i, '`');
      const end = findRun(src, n, i + n);
      if (end >= 0) {
        flush();
        let code = src.slice(i + n, end);
        if (code.length > 2 && code.startsWith(' ') && code.endsWith(' ') && code.trim()) code = code.slice(1, -1);
        out.push({ t: 'code', text: code });
        i = end + n;
      } else {
        buf += src.slice(i, i + n);
        i += n;
      }
      continue;
    }
    if (c === '*' || c === '_') {
      const n = src[i + 1] === c ? 2 : 1;
      if (opens(src, i, n)) {
        const end = closingDelim(src, c.repeat(n), i + n);
        if (end > i + n) {
          flush();
          const children = parseInline(src.slice(i + n, end));
          out.push(n === 2 ? { t: 'strong', children } : { t: 'em', children });
          i = end + n;
          continue;
        }
      }
      buf += src.slice(i, i + n);
      i += n;
      continue;
    }
    buf += c;
    i++;
  }
  flush();
  return out;
}

function runLength(src: string, i: number, ch: string): number {
  let n = 0;
  while (src[i + n] === ch) n++;
  return n;
}

/** En öppnande avgränsare: inte mitt i ett ord, och följs av något annat än blanktecken. */
function opens(src: string, i: number, n: number): boolean {
  return !isWordChar(src[i - 1]) && !isSpace(src[i + n]);
}

/** Kodspann [start, slut) från och med `from`, så att avgränsare inne i `…` inte räknas. */
function codeSpans(src: string, from: number): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  let i = src.indexOf('`', from);
  while (i >= 0) {
    const n = runLength(src, i, '`');
    const end = findRun(src, n, i + n);
    if (end < 0) {
      i = src.indexOf('`', i + n);
      continue;
    }
    spans.push([i, end + n]);
    i = src.indexOf('`', end + n);
  }
  return spans;
}

/** Index för en stängande avgränsare: föregås av icke-blanktecken och följs inte av en ordbokstav. */
function closingDelim(src: string, d: string, from: number): number {
  const spans = codeSpans(src, from);
  let j = from;
  while ((j = src.indexOf(d, j)) >= 0) {
    const span = spans.find(([s, e]) => j >= s && j < e);
    if (span) {
      j = span[1];
      continue;
    }
    // en enkel avgränsare som egentligen är början på en dubbel hoppas över i sin helhet
    if (d.length === 1 && src[j + 1] === d) {
      j += runLength(src, j, d);
      continue;
    }
    if (!isSpace(src[j - 1]) && !isWordChar(src[j + d.length])) return j;
    j += d.length;
  }
  return -1;
}

/** Nästa förekomst av en följd av exakt n backticks (inte längre eller kortare). */
function findRun(src: string, n: number, from: number): number {
  let j = src.indexOf('`', from);
  while (j >= 0) {
    const len = runLength(src, j, '`');
    if (len === n) return j;
    j = src.indexOf('`', j + len);
  }
  return -1;
}

/** Ren text ur trädet (för uppläsning och skärmläsare). */
export function plainText(blocks: Block[]): string {
  const inl = (xs: Inline[]): string =>
    xs.map((x) => (x.t === 'text' || x.t === 'code' ? x.text : x.t === 'br' ? '\n' : inl(x.children))).join('');
  return blocks
    .map((b) => (b.t === 'p' ? inl(b.children) : b.t === 'pre' ? b.text : b.items.map(inl).join('\n')))
    .join('\n\n');
}
