// Resultattolkningen (avbruten/ok/fel) och kvotvarningen (CONTRACT §8.3), med inspelade SDK-händelser.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { interpretResult, LIMIT_THRESHOLD, LimitsTracker, queuedAfter } from '../../server/claude/events.ts';
import type { RateLimitInfoExt } from '../../server/claude/events.ts';

// Inspelad rate_limit_event (Agent SDK 0.3.301, CLI 2.1.301), ordagrant ur spikens
// scratchpad/spikes/sdk-extend/evidence/q1-main.jsonl rad 2. Märk: ingen utilization på toppnivå.
const RECORDED = JSON.parse(
  '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1792113000,"rateLimitType":"five_hour","overageStatus":"rejected","overageDisabledReason":"org_level_disabled","isUsingOverage":false,"unifiedWindows":{"five_hour":{"utilization":0.03,"resetsAt":1792113000},"seven_day":{"utilization":0.22,"resetsAt":1792346400}}},"uuid":"d5296086-b32f-43b7-905d-b0f5fda763fb","session_id":"2f08a613-94cc-4d3b-9cd7-e49ac4665bf6"}',
) as { rate_limit_info: RateLimitInfoExt };

// Inspelade result-meddelanden (fälten som tolkningen läser), ur spike M9 och q6-interrupt.
const RESULT_OK = { subtype: 'success', is_error: false, result: 'first', terminal_reason: 'completed', queued_turn_count: 0 };
const RESULT_ABORTED_STREAMING = {
  subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_streaming', queued_turn_count: 0,
  errors: ['[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null'],
};

function bump(info: RateLimitInfoExt, five: number, seven: number): RateLimitInfoExt {
  return { ...info, unifiedWindows: { five_hour: { utilization: five }, seven_day: { utilization: seven } } };
}

describe('resultattolkningen', () => {
  test('lyckad tur', () => {
    assert.deepEqual(interpretResult(RESULT_OK, false), { ok: true, interrupted: false });
  });
  test('avbruten under strömning (inspelad): avbruten, inte fel', () => {
    assert.deepEqual(interpretResult(RESULT_ABORTED_STREAMING, false), { ok: false, interrupted: true });
  });
  test('avbruten under ett verktyg (aborted_tools): avbruten, inte fel', () => {
    assert.deepEqual(interpretResult({ ...RESULT_ABORTED_STREAMING, terminal_reason: 'aborted_tools' }, false), { ok: false, interrupted: true });
  });
  test('stop() under turen räknas som avbruten även om turen hann bli klar', () => {
    assert.deepEqual(interpretResult(RESULT_OK, true), { ok: false, interrupted: true });
  });
  test('success med is_error (API-fel): felet är result', () => {
    assert.deepEqual(interpretResult({ subtype: 'success', is_error: true, result: 'API Error: 529 overloaded', terminal_reason: 'api_error' }, false), {
      ok: false, interrupted: false, error: 'API Error: 529 overloaded',
    });
  });
  test('felsubtyp: felen radvis', () => {
    assert.deepEqual(interpretResult({ subtype: 'error_max_turns', is_error: true, errors: ['a', 'b'], terminal_reason: 'max_turns' }, false), {
      ok: false, interrupted: false, error: 'a\nb',
    });
  });
  test('tomt fel blir subtypens namn', () => {
    assert.equal(interpretResult({ subtype: 'error_during_execution', is_error: true, errors: [] }, false).error, 'error_during_execution');
  });
  test('långt fel kortas', () => {
    const e = interpretResult({ subtype: 'success', is_error: true, result: 'x'.repeat(5000) }, false).error ?? '';
    assert.ok(Array.from(e).length <= 2000);
  });
  test('queued_turn_count', () => {
    assert.equal(queuedAfter({ subtype: 'success', is_error: false, queued_turn_count: 2 }), 2);
    assert.equal(queuedAfter({ subtype: 'success', is_error: false }), 0);
  });
});

describe('kvotvarningen', () => {
  test('den inspelade händelsen ger värdena ur unifiedWindows, men ingen varning under 0,8', () => {
    const t = new LimitsTracker();
    assert.equal(t.update(RECORDED.rate_limit_info), null);
    assert.equal(t.fiveHour, 0.03);
    assert.equal(t.sevenDay, 0.22);
  });

  test('kalibrering: det typade fältet utilization saknas i den inspelade händelsen', () => {
    // En implementation som bara läser det typade fältet skulle aldrig se något värde.
    assert.equal(RECORDED.rate_limit_info.utilization, undefined);
  });

  test('passage över 0,8 ger limits en gång, med båda talen', () => {
    const t = new LimitsTracker();
    t.update(RECORDED.rate_limit_info);
    assert.deepEqual(t.update(bump(RECORDED.rate_limit_info, 0.81, 0.22)), { fiveHour: 0.81, sevenDay: 0.22 });
    assert.equal(t.update(bump(RECORDED.rate_limit_info, 0.85, 0.22)), null, 'en gång per passage');
    assert.equal(t.update(bump(RECORDED.rate_limit_info, 0.5, 0.22)), null, 'ned under');
    assert.deepEqual(t.update(bump(RECORDED.rate_limit_info, LIMIT_THRESHOLD, 0.3)), { fiveHour: 0.8, sevenDay: 0.3 }, 'ny passage');
  });

  test('sjudagarsfönstret har sin egen passage', () => {
    const t = new LimitsTracker();
    assert.equal(t.update(bump(RECORDED.rate_limit_info, 0.1, 0.79)), null);
    assert.deepEqual(t.update(bump(RECORDED.rate_limit_info, 0.1, 0.9)), { fiveHour: 0.1, sevenDay: 0.9 });
  });

  test('reserv: utilization gäller fönstret som rateLimitType anger', () => {
    const t = new LimitsTracker();
    assert.deepEqual(t.update({ status: 'allowed_warning', rateLimitType: 'seven_day', utilization: 0.9 }), { fiveHour: 0, sevenDay: 0.9 });
    assert.equal(t.update({ status: 'allowed', rateLimitType: 'seven_day_opus', utilization: 0.99 }), null, 'andra fönster räknas inte');
    assert.equal(t.update({ status: 'allowed', rateLimitType: 'five_hour', utilization: 0.2 }), null);
    assert.equal(t.fiveHour, 0.2);
    assert.equal(t.sevenDay, 0.9, 'senaste värdet per fönster behålls');
  });

  test('skräp ignoreras', () => {
    const t = new LimitsTracker();
    assert.equal(t.update(null), null);
    assert.equal(t.update({ status: 'allowed', unifiedWindows: { five_hour: { utilization: Number.NaN } } }), null);
  });
});
