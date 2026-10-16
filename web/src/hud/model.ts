// model.ts — HUD:ens vy som rena funktioner av chatthändelser och appens status (CONTRACT §13).
// Ingen DOM här, så att reglerna kan enhetstestas i Node.
import type { AppPermission, AppStatus, Ask, ChatEvent } from '../../../shared/protocol.ts';

export type Message =
  | { key: string; kind: 'user'; text: string; via: 'text' | 'voice' }
  | { key: string; kind: 'reply'; text: string }
  | { key: string; kind: 'note'; text: string };

/**
 * Meddelandena i ordning: användarens text, Claudes text och notiser. Verktygshistorik visas inte.
 * Varje tur har en enda plats för Claudes text. Det Claude skriver mellan verktygen är mellanprat:
 * nästa text tar dess plats, och turens sista text är svaret som står kvar. Medan en ny text strömmar in
 * (streaming) ersätter den redan turens förra text.
 *
 * Ett meddelande som användaren köar medan en tur pågår hamnar under turens text: först när turen fått sin
 * nästa text (den som strömmade in när meddelandet köades, eller turens svar) eller tagit slut följer det,
 * och texten efter det är dess egen tur. Annars trycktes den levande texten ned en rad (uppmätt 41 px).
 * Ett meddelande som besvarar ett väntande frågekort (§8.5 punkt 5) köas inte; det hör till turen.
 * `queued` är hur många meddelanden i slutet av listan som fortfarande väntar under turens text; den levande
 * texten visas ovanför dem.
 */
export function messages(events: readonly ChatEvent[], streaming = false): Message[] & { queued: number } {
  const out: Message[] = [];
  let slot = -1; // platsen i out för den pågående turens senaste text
  let open = false; // en tur pågår
  const asks = new Set<string>(); // frågekort som väntar (inte hemligheter, som aldrig får skriven text)
  let held: Message[] = []; // köat under den pågående turen, väntar under turens text
  const release = (): void => {
    if (!held.length) return;
    out.push(...held);
    held = [];
    slot = -1;
  };
  for (const e of events) {
    if (e.k === 'user') {
      const m: Message = { key: `u:${e.id}`, kind: 'user', text: e.text, via: e.via };
      if (open && asks.size === 0) held.push(m);
      else {
        release();
        out.push(m);
        slot = -1;
      }
    } else if (e.k === 'text') {
      const m: Message = { key: `t:${e.id}`, kind: 'reply', text: e.text };
      if (slot >= 0) out[slot] = m;
      else {
        slot = out.length;
        out.push(m);
      }
      release();
    } else if (e.k === 'note') (held.length ? held : out).push({ key: `n:${e.id}`, kind: 'note', text: e.text });
    else if (e.k === 'ask') {
      if (e.ask.kind !== 'secret') asks.add(e.id);
    } else if (e.k === 'ask-done') asks.delete(e.id);
    else if (e.k === 'turn') {
      release();
      open = e.phase === 'start';
      if (!open) asks.clear();
      slot = -1;
    }
  }
  const queued = held.length;
  out.push(...held);
  if (streaming && slot >= 0) out.splice(slot, 1);
  return Object.assign(out, { queued });
}

/** Index för senaste turens start, eller -1. */
function lastTurnStart(events: readonly ChatEvent[]): number {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.k === 'turn' && e.phase === 'start') return i;
  }
  return -1;
}

export const isActive = (status: AppStatus | undefined): boolean => status === 'building' || status === 'waiting';

/**
 * Senaste verktygets etikett i pågående tur, bara medan status är building eller waiting.
 * Medan ett frågekort väntar säger kortet redan vad som händer: raden skulle bara upprepa det
 * ("Läser example.com" under "Hämta från nätet?") och påstå att verktyget redan körs.
 */
export function activityLabel(events: readonly ChatEvent[], status: AppStatus | undefined): string | null {
  if (!isActive(status)) return null;
  if (pendingAsks(events, status).length > 0) return null;
  const start = lastTurnStart(events);
  for (let i = events.length - 1; i > start; i--) {
    const e = events[i];
    if (e.k === 'tool') return e.label;
    if (e.k === 'turn') break;
  }
  return null;
}

/**
 * Aktivitetsraden (§13 punkt 3, §14): null när ingen rad visas, annars raden med senaste verktygets etikett,
 * eller utan etikett medan Claude tänker före första verktyget (då står bara pricken där).
 * Bara medan status är building. Medan ett frågekort väntar (waiting) säger kortet redan vad som händer.
 */
export function activity(events: readonly ChatEvent[], status: AppStatus | undefined): { label: string | null } | null {
  if (status !== 'building') return null;
  return { label: activityLabel(events, status) };
}

/** Frågor utan ask-done. Visas bara när status är waiting. */
export function pendingAsks(events: readonly ChatEvent[], status: AppStatus | undefined): Array<{ id: string; ask: Ask }> {
  if (status !== 'waiting') return [];
  const done = new Set<string>();
  for (const e of events) if (e.k === 'ask-done') done.add(e.id);
  const out: Array<{ id: string; ask: Ask }> = [];
  for (const e of events) if (e.k === 'ask' && !done.has(e.id)) out.push({ id: e.id, ask: e.ask });
  return out;
}

/** Felet från senaste avslutade tur, om ingen ny tur har börjat sedan dess. */
export function turnError(events: readonly ChatEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.k !== 'turn') continue;
    if (e.phase === 'start') return null;
    return !e.interrupted && e.error ? e.error : null;
  }
  return null;
}

/** Claudes avslutande text i senaste turen (sista textblocket efter turens start). */
export function closingText(events: readonly ChatEvent[]): string | null {
  const start = lastTurnStart(events);
  for (let i = events.length - 1; i > start; i--) {
    const e = events[i];
    if (e.k === 'text' && e.text.trim()) return e.text;
  }
  return null;
}

/** Den största tidsstämpeln i listan (för att skilja nya händelser från historik). */
export function maxAt(events: readonly ChatEvent[]): number {
  let m = 0;
  for (const e of events) if ('at' in e && typeof e.at === 'number' && e.at > m) m = e.at;
  return m;
}

/* -------------------------------- Esc-regeln -------------------------------- */

/**
 * §13: oanvända appar tas bort bara med Esc. Alla villkor måste gälla:
 * HUD:en öppnades med reason 'created', inget chat.send sedan dess, appen är inte byggd och inmatningen är tom.
 * En halvskriven beskrivning (draft) är användarens arbete: då stänger Esc bara HUD:en, och fyrkanten och
 * texten finns kvar.
 */
export function deleteOnEsc(s: { reason: string; sentSinceOpen: boolean; built: boolean | undefined; draft: boolean }): boolean {
  return s.reason === 'created' && !s.sentSinceOpen && s.built === false && !s.draft;
}

/* -------------------------------- behörigheter -------------------------------- */

const PERMISSION_WORD: Record<AppPermission, string> = {
  microphone: 'mikrofonen',
  camera: 'kameran',
  'clipboard-read': 'urklippet',
  geolocation: 'platsen',
};

/** Behörigheter som appen vill ha men som användaren varken gett eller nekat. */
export function pendingPermissions(
  wanted: readonly AppPermission[],
  granted: readonly AppPermission[],
  denied: readonly AppPermission[],
): AppPermission[] {
  return wanted.filter((p, i) => wanted.indexOf(p) === i && p in PERMISSION_WORD && !granted.includes(p) && !denied.includes(p));
}

/** "Klocka vill använda mikrofonen och kameran". */
export function permissionSentence(name: string, perms: readonly AppPermission[]): string {
  const words = perms.map((p) => PERMISSION_WORD[p]);
  const list = new Intl.ListFormat('sv', { style: 'long', type: 'conjunction' }).format(words);
  return `${name.trim() || 'Appen'} vill använda ${list}`;
}

/* -------------------------------- kvoten -------------------------------- */

export const LIMIT_THRESHOLD = 0.8;

/** "Du har använt 80 % av din Claude-kvot", när något fönster har passerat 0,8. */
export function limitsSentence(limits: { fiveHour: number; sevenDay: number } | null): string | null {
  if (!limits) return null;
  const used = Math.max(Number(limits.fiveHour) || 0, Number(limits.sevenDay) || 0);
  if (!(used >= LIMIT_THRESHOLD)) return null;
  const pct = Math.min(100, Math.floor(used * 100));
  return `Du har använt ${pct}\u{a0}% av din Claude-kvot`;
}

/* -------------------------------- uppläsning -------------------------------- */

/** Första meningen, högst max tecken (avkortad vid ett ordslut). Meningsgränser enligt Intl.Segmenter för svenska. */
export function firstSentence(text: string, max = 200): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  let first = clean;
  try {
    const seg = new Intl.Segmenter('sv', { granularity: 'sentence' });
    for (const s of seg.segment(clean)) {
      first = s.segment.trim();
      break;
    }
  } catch {
    /* utan Segmenter: hela texten, avkortad nedan */
  }
  if ([...first].length <= max) return first;
  const cps = [...first].slice(0, max);
  let cut = cps.join('');
  const space = cut.lastIndexOf(' ');
  if (space > max * 0.6) cut = cut.slice(0, space);
  return cut.replace(/[\s,;:–-]+$/u, '') + '…';
}
