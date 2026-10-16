// shared/open.ts — fältet (CONTRACT §10.9): känn igen en adress eller ett datum i det användaren skrivit, och
// kontrollera det som lämnas till en app. Rena funktioner, används av skalet och servern, enhetstestade.
import type { OpenItem, OpenKind } from './protocol.ts';

export const OPEN_TEXT_MAX = 2000;

const pad = (n: number): string => String(n).padStart(2, '0');
const iso = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Ett giltigt datum ÅÅÅÅ-MM-DD (ingen 31 februari). */
export function validDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.getFullYear() === Number(m[1]) && d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3]);
}

/** En http(s)-adress, med https:// framför när schemat saknas; null för allt annat. */
export function normalUrl(raw: string): string | null {
  const s = raw.trim();
  if (!s || /\s/.test(s) || s.length > 2000) return null;
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password) return null;
  return u.href;
}

/** Det som lämnas till en app: kontrollerat och normaliserat, eller null. */
export function normalizeItem(kind: unknown, value: unknown): OpenItem | null {
  if (typeof value !== 'string') return null;
  if (kind === 'url') {
    const url = normalUrl(value);
    return url ? { kind: 'url', url } : null;
  }
  if (kind === 'date') return validDate(value.trim()) ? { kind: 'date', date: value.trim() } : null;
  if (kind === 'text') {
    const text = value.replace(/\s+/g, ' ').trim();
    return text && text.length <= OPEN_TEXT_MAX ? { kind: 'text', text } : null;
  }
  return null;
}

export function itemValue(item: OpenItem): string {
  return item.kind === 'url' ? item.url : item.kind === 'date' ? item.date : item.text;
}

export function itemKind(item: OpenItem): OpenKind {
  return item.kind;
}

const MONTHS: Array<[RegExp, number]> = [
  [/^jan(uari)?$/, 0], [/^feb(ruari)?$/, 1], [/^mar(s)?$/, 2], [/^apr(il)?$/, 3], [/^maj$/, 4], [/^jun(i)?$/, 5],
  [/^jul(i)?$/, 6], [/^aug(usti)?$/, 7], [/^sep(t|tember)?$/, 8], [/^okt(ober)?$/, 9], [/^nov(ember)?$/, 10], [/^dec(ember)?$/, 11],
];
const WEEKDAYS = ['söndag', 'måndag', 'tisdag', 'onsdag', 'torsdag', 'fredag', 'lördag'];

function month(word: string): number | null {
  const w = word.replace(/\.$/, '');
  for (const [re, m] of MONTHS) if (re.test(w)) return m;
  return null;
}

/** Måndagen i ISO-vecka w det år som innehåller dagen today. */
function isoWeekMonday(year: number, w: number): Date {
  const jan4 = new Date(year, 0, 4);
  const monday1 = new Date(year, 0, 4 - ((jan4.getDay() + 6) % 7));
  return new Date(monday1.getFullYear(), monday1.getMonth(), monday1.getDate() + (w - 1) * 7);
}

/**
 * Ett datum på svenska eller med siffror: 2026-10-20, 20/10, 20/10/2026, 20 okt, den 20 oktober 2026, idag, i morgon,
 * i övermorgon, igår, fredag (närmast, idag räknas), nästa fredag (i nästa vecka, måndag–söndag), vecka 43 (dess måndag). Annars null.
 */
export function parseDate(raw: string, today: Date): string | null {
  const s = raw.trim().toLocaleLowerCase('sv').replace(/\s+/g, ' ').replace(/^den /, '');
  if (!s) return null;
  if (validDate(s)) return s;
  const day = (offset: number): string => iso(new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset));
  const rel: Record<string, number> = { idag: 0, 'i dag': 0, imorgon: 1, 'i morgon': 1, 'i övermorgon': 2, övermorgon: 2, igår: -1, 'i går': -1 };
  if (s in rel) return day(rel[s]);
  let m = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?$/.exec(s);
  if (m) {
    const out = `${m[3] ?? today.getFullYear()}-${pad(Number(m[2]))}-${pad(Number(m[1]))}`;
    return validDate(out) ? out : null;
  }
  m = /^(\d{1,2}) ([a-zåäö.]+)(?: (\d{4}))?$/.exec(s);
  if (m) {
    const mo = month(m[2]);
    if (mo === null) return null;
    const out = `${m[3] ?? today.getFullYear()}-${pad(mo + 1)}-${pad(Number(m[1]))}`;
    return validDate(out) ? out : null;
  }
  m = /^(nästa )?([a-zåäö]+)$/.exec(s);
  if (m) {
    const wd = WEEKDAYS.indexOf(m[2]);
    if (wd >= 0) {
      if (!m[1]) return day((wd - today.getDay() + 7) % 7);
      // Nästa: dagen i nästa vecka (måndag–söndag), räknat från veckans måndag.
      const sinceMonday = (today.getDay() + 6) % 7;
      return day(-sinceMonday + 7 + ((wd + 6) % 7));
    }
  }
  m = /^v(?:ecka|\.)? ?(\d{1,2})$/.exec(s);
  if (m) {
    const w = Number(m[1]);
    if (w < 1 || w > 53) return null;
    return iso(isoWeekMonday(today.getFullYear(), w));
  }
  return null;
}

/** En adress som någon skulle skriva i ett adressfält: med http(s):// eller ett värdnamn med toppdomän (bokstäver). */
export function looksLikeUrl(raw: string): boolean {
  const s = raw.trim();
  if (!s || /\s/.test(s) || s.includes('@')) return false;
  if (/^https?:\/\/\S+$/i.test(s)) return normalUrl(s) !== null;
  if (/^localhost(:\d+)?(\/\S*)?$/i.test(s)) return true;
  return /^(?:[a-z0-9-]+\.)+[a-z]{2,24}(?::\d+)?(?:[/?#]\S*)?$/i.test(s) && normalUrl(s) !== null;
}

/** Vad det användaren skrev är, när det går att avgöra direkt: en adress eller ett datum. Annars null (Claude avgör). */
export function classifyInput(raw: string, today: Date): OpenItem | null {
  if (looksLikeUrl(raw)) {
    const url = normalUrl(raw);
    if (url) return { kind: 'url', url };
  }
  const date = parseDate(raw, today);
  return date ? { kind: 'date', date } : null;
}
