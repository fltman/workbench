// server/claude/events.ts — tolkning av SDK-meddelanden: turens resultat och kvotvarningen (CONTRACT §8.3).
import type { SDKRateLimitInfo } from '@anthropic-ai/claude-agent-sdk';

/** Den del av ett result-meddelande som tolkningen läser. */
export interface ResultLike {
  subtype: string;
  is_error: boolean;
  result?: string;
  errors?: string[];
  terminal_reason?: string;
  queued_turn_count?: number;
}

export interface TurnOutcome {
  ok: boolean;
  interrupted: boolean;
  error?: string;
}

const ERROR_MAX = 2000;

/**
 * §8.3 Resultatet:
 * - interrupted = stop() anropades under turen, eller terminal_reason är aborted_streaming eller aborted_tools
 * - ok = !is_error && !interrupted
 * - error (bara när !interrupted && is_error) = subtype === 'success' ? result : errors.join('\n')
 */
export function interpretResult(msg: ResultLike, stopRequested: boolean): TurnOutcome {
  const interrupted = stopRequested || msg.terminal_reason === 'aborted_streaming' || msg.terminal_reason === 'aborted_tools';
  const ok = !msg.is_error && !interrupted;
  if (interrupted || !msg.is_error) return { ok, interrupted };
  let error = msg.subtype === 'success' ? (msg.result ?? '') : (msg.errors ?? []).join('\n');
  if (!error.trim()) error = msg.subtype;
  const cps = Array.from(error);
  if (cps.length > ERROR_MAX) error = cps.slice(0, ERROR_MAX - 1).join('') + '…';
  return { ok, interrupted, error };
}

/** Antal köade turer efter detta resultat; saknas fältet räknas det som 0. */
export function queuedAfter(msg: ResultLike): number {
  const n = msg.queued_turn_count;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;
}

/* ------------------------------ kvotvarningen ------------------------------ */

/** Fälten saknas i sdk.d.ts 0.3.301 men finns i de uppmätta händelserna, så typen utökas lokalt. */
export type RateLimitInfoExt = SDKRateLimitInfo & {
  unifiedWindows?: Partial<Record<'five_hour' | 'seven_day', { utilization?: number; resetsAt?: number }>>;
};

export const LIMIT_THRESHOLD = 0.8;

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * Håller senaste användningen per fönster (5 h och 7 dagar, gemensamt för hela kontot).
 * update() returnerar { fiveHour, sevenDay } när ett värde passerar 0,8 uppåt, en gång per passage.
 */
export class LimitsTracker {
  fiveHour: number | undefined;
  sevenDay: number | undefined;
  #above = { fiveHour: false, sevenDay: false };

  update(info: RateLimitInfoExt | null | undefined): { fiveHour: number; sevenDay: number } | null {
    if (!info || typeof info !== 'object') return null;
    const w = info.unifiedWindows;
    let five = num(w?.five_hour?.utilization);
    let seven = num(w?.seven_day?.utilization);
    // Reserv: utilization gäller fönstret som rateLimitType anger.
    const u = num(info.utilization);
    if (five === undefined && info.rateLimitType === 'five_hour') five = u;
    if (seven === undefined && info.rateLimitType === 'seven_day') seven = u;
    if (five !== undefined) this.fiveHour = five;
    if (seven !== undefined) this.sevenDay = seven;
    let crossed = false;
    for (const k of ['fiveHour', 'sevenDay'] as const) {
      const v = this[k];
      if (v === undefined) continue;
      const above = v >= LIMIT_THRESHOLD;
      if (above && !this.#above[k]) crossed = true;
      this.#above[k] = above;
    }
    return crossed ? { fiveHour: this.fiveHour ?? 0, sevenDay: this.sevenDay ?? 0 } : null;
  }
}
