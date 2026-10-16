// Sessionerna (CONTRACT §8.1–§8.6, §8.10) mot en skriptad SDK-motor: samma meddelandeformer som Claude Code
// sänder, men utan modell. Riktiga Claude provas separat (se slutrapporten).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, test } from 'node:test';
import type { CanUseTool, PermissionResult, PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
import { createSessionsWith } from '../../server/claude/sessions.ts';
import { appendEvents } from '../../server/claude/chatlog.ts';
import { LANGUAGE_LINE } from '../../server/claude/prompt.ts';
import type { Sessions } from '../../server/types.ts';
import type { ChatEvent } from '../../shared/protocol.ts';
import { autoReply, makeWorld, readChat, ScriptEngine, sdk, sleep, until } from './server-claude-kit.ts';
import type { ScriptProc, World } from './server-claude-kit.ts';
import type { Config } from '../../server/types.ts';

const ID = 'aapp001';
let w: World;
let s: Sessions;
let engine: ScriptEngine;

function setup(over: Partial<Config> = {}, opts: { gitDelayMs?: number; sandbox?: boolean } = {}): void {
  w = makeWorld(over, opts.gitDelayMs ?? 0);
  w.addApp(ID);
  engine = new ScriptEngine();
  s = createSessionsWith(
    { config: w.config, paths: w.paths, registry: w.registry, scene: w.scene, hub: w.hub, backends: w.backends, logs: w.logs, shots: w.shots, git: w.git },
    engine,
    { sandbox: opts.sandbox ?? true },
  );
}

afterEach(async () => {
  await s?.closeAll();
  w?.cleanup();
});

const kinds = (evs: ChatEvent[]) => evs.map((e) => (e.k === 'turn' ? `turn:${e.phase}` : e.k));
const chat = () => w.hub.chat(ID);
const lastTurnEnd = () => chat().filter((e): e is Extract<ChatEvent, { k: 'turn' }> => e.k === 'turn' && e.phase === 'end').at(-1);
const proc = () => engine.procs.at(-1) as ScriptProc;
const status = () => w.registry.get(ID)?.status;
const sig = () => new AbortController().signal;
const cut = (p: ScriptProc) => p.options.canUseTool as CanUseTool;
const askOf = (id?: string) => chat().filter((e): e is Extract<ChatEvent, { k: 'ask' }> => e.k === 'ask' && (!id || e.id === id)).at(-1);

async function turnDone(n = 1): Promise<void> {
  await until(() => chat().filter((e) => e.k === 'turn' && e.phase === 'end').length >= n && !s.busy(ID), 3000, 'turen');
}

describe('en tur', () => {
  test('händelserna, chat.jsonl och §8.6 i ordning', async () => {
    setup();
    const app = w.paths.appDir(ID);
    engine.onProc = (p) => {
      p.onMessage = (_t, pp) => {
        pp.emit(
          sdk.init('sess-1', ['Bash', 'mcp__workbench__reload_app', 'mcp__workbench__screenshot_app', 'mcp__workbench__get_app_logs', 'mcp__workbench__call_backend', 'mcp__workbench__request_secret', 'mcp__workbench__try_app']),
          sdk.delta('Jag '),
          sdk.delta('bygger.'),
          sdk.toolUse('toolu_1', 'Write', { file_path: path.join(app, 'index.html'), content: '<h1>Hej</h1>' }),
          sdk.toolResult('toolu_1'),
          sdk.toolUse('toolu_2', 'TodoWrite', { todos: [] }),
          sdk.toolResult('toolu_2'),
          sdk.toolUse('toolu_3', 'Bash', { command: 'npm install imapflow' }),
          sdk.toolResult('toolu_3', true),
          sdk.toolUse('toolu_sub', 'Read', { file_path: 'x' }, 'toolu_parent'),
          sdk.text('underagent', 'toolu_parent'),
          sdk.text('Klart.'),
          sdk.result(),
        );
      };
    };
    s.open(ID);
    s.send(ID, 'Gör en mejlklient\nmed IMAP', 'voice');
    await turnDone();
    const evs = chat();
    assert.deepEqual(kinds(evs), ['user', 'turn:start', 'delta', 'delta', 'tool', 'tool-done', 'tool', 'tool-done', 'text', 'turn:end']);
    assert.deepEqual(evs[0], { ...evs[0], text: 'Gör en mejlklient\nmed IMAP', via: 'voice' });
    const tools = evs.filter((e) => e.k === 'tool') as Extract<ChatEvent, { k: 'tool' }>[];
    assert.deepEqual(tools.map((t) => [t.id, t.label]), [['toolu_1', 'Skriver index.html'], ['toolu_3', 'Installerar imapflow']]);
    const dones = evs.filter((e) => e.k === 'tool-done') as Extract<ChatEvent, { k: 'tool-done' }>[];
    assert.deepEqual(dones.map((d) => [d.id, d.ok]), [['toolu_1', true], ['toolu_3', false]]);
    assert.deepEqual(lastTurnEnd(), { ...lastTurnEnd(), ok: true, interrupted: false });
    assert.equal('error' in (lastTurnEnd() ?? {}), false);
    // chat.jsonl: samma utan delta
    assert.deepEqual(readChat(w, ID), evs.filter((e) => e.k !== 'delta'));
    assert.deepEqual(s.history(ID, 300), readChat(w, ID));
    // §8.6: commit → refresh → restart (villkorslöst, även utan backend) → bumpRev → idle
    assert.deepEqual(w.rec.calls, [`setStatus:${ID}:building`, `commit:${ID}:Gör en mejlklient`, `refresh:${ID}`, `restart:${ID}`, `bumpRev:${ID}`, `setStatus:${ID}:idle`]);
    // session.json
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(w.paths.appDataDir(ID), 'session.json'), 'utf8')), { sessionId: 'sess-1' });
    // <workbench>-blocket först, sedan användarens text
    const msg = proc().received[0];
    assert.ok(msg.startsWith(`<workbench>\nWindow: 640×480 CSS px (scale 1). Front face: main (1 of 1).\nBack end: none.\n${LANGUAGE_LINE}\nYour notes (CLAUDE.md):\n# aapp001`), msg.slice(0, 300));
    assert.ok(msg.endsWith('</workbench>\nGör en mejlklient\nmed IMAP'));
    // inga varningar från självtestet
    assert.deepEqual(w.logs.tail(ID).filter((l) => l.includes('självtest')), []);
  });

  test('Claude tog bort backenden ur app.json: restart anropas ändå och stoppar den gamla processen (§8.6 steg 3)', async () => {
    setup();
    // Kalibrering: den gamla regeln (restart bara när manifestet har en backend) hade inte anropat restart här.
    const oldRule = (m: { backend?: unknown }) => (m.backend ? ['restart'] : []);
    assert.deepEqual(oldRule(w.registry.manifest(ID)), []);
    engine.onProc = (p) => autoReply(p);
    s.send(ID, 'Ta bort servern', 'text');
    await turnDone();
    assert.deepEqual(w.rec.calls.slice(1), [`commit:${ID}:Ta bort servern`, `refresh:${ID}`, `restart:${ID}`, `bumpRev:${ID}`, `setStatus:${ID}:idle`]);
  });

  test('med backend startas den om före bumpRev', async () => {
    setup();
    w.registry.manifests.set(ID, { backend: { entry: 'server.mjs' } });
    engine.onProc = (p) => autoReply(p);
    s.send(ID, 'Lägg till /api/tid', 'text');
    await turnDone();
    assert.deepEqual(w.rec.calls.slice(1), [`commit:${ID}:Lägg till /api/tid`, `refresh:${ID}`, `restart:${ID}`, `bumpRev:${ID}`, `setStatus:${ID}:idle`]);
  });

  test('anteckningarna bara i första meddelandet i varje process; ångra-raden en gång', async () => {
    setup();
    engine.onProc = (p) => autoReply(p);
    s.send(ID, 'ett', 'text');
    await turnDone(1);
    s.noteUndo(ID);
    const note = chat().at(-1);
    assert.deepEqual(note, { ...note, k: 'note', text: 'Ångrade senaste ändringen.' });
    assert.ok(readChat(w, ID).some((e) => e.k === 'note'), 'notisen sparas');
    s.send(ID, 'två', 'text');
    await turnDone(2);
    s.send(ID, 'tre', 'text');
    await turnDone(3);
    const [m1, m2, m3] = proc().received;
    assert.match(m1, /Your notes \(CLAUDE\.md\):/);
    assert.doesNotMatch(m2, /Your notes/);
    assert.match(m2, /the user undid your last change/);
    assert.doesNotMatch(m3, /undid/);
    assert.equal(engine.procs.length, 1, 'samma process');
  });
});

describe('köade turer', () => {
  test('en kedja av köade turer blir en commit', async () => {
    setup();
    engine.onProc = (p) => {
      p.onMessage = (text, pp) => {
        if (text.endsWith('första')) pp.emit(sdk.init('sess-1'), sdk.text('Jobbar…'));
        else pp.emit(sdk.result({ queued: 1 }), sdk.init('sess-1'), sdk.text('Andra klar.'), sdk.result({ queued: 0 }));
      };
    };
    s.send(ID, 'första', 'text');
    await until(() => proc()?.received.length === 1);
    s.send(ID, 'andra', 'text');
    await turnDone();
    assert.deepEqual(kinds(chat()), ['user', 'turn:start', 'text', 'user', 'text', 'turn:end']);
    assert.deepEqual(w.git.commits.map((c) => c.message), ['första']);
  });

  test('meddelanden under §8.6 hålls och läggs i kön först efter steg 5', async () => {
    setup({}, { gitDelayMs: 150 });
    engine.onProc = (p) => {
      p.onMessage = (text, pp) => {
        w.rec.calls.push(`received:${text.split('\n').at(-1)}`);
        pp.emit(sdk.init('sess-1'), sdk.text('ok'), sdk.result());
      };
    };
    s.send(ID, 'ett', 'text');
    await until(() => w.rec.calls.some((c) => c.startsWith('commit:')));
    assert.equal(s.busy(ID), true, '§8.6 räknas som upptaget');
    s.send(ID, 'två', 'text');
    assert.equal(chat().at(-1)?.k, 'user', 'user sänds direkt');
    await turnDone(2);
    const c = w.rec.calls;
    const idle1 = c.indexOf(`setStatus:${ID}:idle`);
    assert.ok(idle1 > 0 && idle1 < c.indexOf('received:två'), c.join(' | '));
    assert.deepEqual(kinds(chat()), ['user', 'turn:start', 'text', 'turn:end', 'user', 'turn:start', 'text', 'turn:end']);
    assert.deepEqual(w.git.commits.map((x) => x.message), ['ett', 'två']);
  });

  test('en tur som Claude Code började själv (meddelandet hann fram precis efter resultatet) blir en egen tur', async () => {
    setup({}, { gitDelayMs: 100 });
    let n = 0;
    engine.onProc = (p) => {
      p.onMessage = (_t, pp) => {
        if (++n === 1) pp.emit(sdk.init('sess-1'), sdk.result({ queued: 0 }));
      };
    };
    s.send(ID, 'ett', 'text');
    await until(() => w.rec.calls.some((c) => c.startsWith('commit:')));
    // processen fortsätter med en tur som vi aldrig öppnade
    proc().emit(sdk.text('Jag fortsätter.'), sdk.result({ queued: 0 }));
    await until(() => chat().filter((e) => e.k === 'turn' && e.phase === 'end').length === 2 && !s.busy(ID), 3000);
    assert.equal(status(), 'idle');
    assert.equal(w.git.commits.length, 2);
  });
});

describe('avbrott och fel', () => {
  test('stopp under ett verktyg: avbruten, inte fel, status idle', async () => {
    setup();
    engine.onProc = (p) => {
      p.onMessage = (_t, pp) => pp.emit(sdk.init('sess-1'), sdk.toolUse('toolu_1', 'Bash', { command: 'sleep 20' }));
      p.onInterrupt = (pp) => pp.emit(sdk.result({ subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_tools', errors: ['x'] }));
    };
    s.send(ID, 'Kör länge', 'text');
    await until(() => chat().some((e) => e.k === 'tool'));
    await s.stop(ID);
    await turnDone();
    assert.equal(proc().interrupts, 1);
    assert.deepEqual(lastTurnEnd(), { ...lastTurnEnd(), ok: false, interrupted: true });
    assert.equal(lastTurnEnd()?.error, undefined);
    assert.equal(status(), 'idle');
    assert.equal(w.git.commits.length, 1, 'ändringarna committas ändå');
  });

  test('stopp som Claude Code rapporterar som completed räknas ändå som avbruten', async () => {
    setup();
    engine.onProc = (p) => {
      p.onMessage = (_t, pp) => pp.emit(sdk.init('sess-1'));
      p.onInterrupt = (pp) => pp.emit(sdk.result({ terminal_reason: 'completed' }));
    };
    s.send(ID, 'x', 'text');
    await until(() => proc()?.received.length === 1);
    await s.stop(ID);
    await turnDone();
    assert.equal(lastTurnEnd()?.interrupted, true);
  });

  test('stopp innan processen startat avbryter den första turen', async () => {
    setup();
    engine.startDelayMs = 80;
    let interrupted = false;
    engine.onProc = (p) => {
      p.onMessage = (_t, pp) => {
        if (interrupted) pp.emit(sdk.result({ subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_streaming' }));
      };
      p.onInterrupt = () => {
        interrupted = true;
      };
    };
    s.send(ID, 'x', 'text');
    await s.stop(ID);
    await turnDone();
    assert.equal(lastTurnEnd()?.interrupted, true);
  });

  test('fel från API:t: turfel och status error', async () => {
    setup();
    engine.onProc = (p) => {
      p.onMessage = (_t, pp) => pp.emit(sdk.init('s'), sdk.result({ subtype: 'success', is_error: true, result: 'API Error: 529 Overloaded', terminal_reason: 'api_error' }));
    };
    s.send(ID, 'x', 'text');
    await turnDone();
    assert.deepEqual(lastTurnEnd(), { ...lastTurnEnd(), ok: false, interrupted: false, error: 'API Error: 529 Overloaded' });
    assert.equal(status(), 'error');
  });

  test('processen dör mitt i en tur', async () => {
    setup();
    engine.onProc = (p) => {
      p.onMessage = (_t, pp) => {
        pp.emit(sdk.init('s'), sdk.text('börjar'));
        setTimeout(() => pp.crash(), 10);
      };
    };
    s.send(ID, 'x', 'text');
    await turnDone();
    assert.equal(lastTurnEnd()?.error, 'Claude Code avslutades oväntat.');
    assert.equal(status(), 'error');
    assert.ok(w.logs.tail(ID).some((l) => l.includes('process died')), 'felet loggas');
    // nästa meddelande startar en ny process
    engine.onProc = (p) => autoReply(p);
    s.send(ID, 'igen', 'text');
    await turnDone(2);
    assert.equal(engine.procs.length, 2);
    assert.equal(status(), 'idle');
  });

  test('Claude Code kan inte starta', async () => {
    setup();
    engine.failNext = 1;
    s.send(ID, 'x', 'text');
    await turnDone();
    assert.match(lastTurnEnd()?.error ?? '', /^Claude Code kunde inte starta/);
    assert.equal(status(), 'error');
    assert.ok(w.logs.tail(ID).some((l) => l.includes('kunde inte starta')));
  });
});

describe('frågor (§8.5)', () => {
  async function inTurn(): Promise<ScriptProc> {
    engine.onProc = (p) => {
      p.onMessage = (_t, pp) => pp.emit(sdk.init('s'));
    };
    s.send(ID, 'x', 'text');
    await until(() => proc()?.received.length === 1);
    return proc();
  }

  test('policyn nekar direkt, utan ask', async () => {
    setup();
    const p = await inTurn();
    const r = await cut(p)('Read', { file_path: '/etc/passwd' }, { signal: sig(), toolUseID: 't', requestId: 'r' });
    assert.equal(r?.behavior, 'deny');
    assert.equal(askOf(), undefined);
  });

  test('frågekortet: allow-always ger bara session-regler; status waiting och sedan building', async () => {
    setup();
    const p = await inTurn();
    const pending = cut(p)('WebFetch', { url: 'https://nodemailer.com/x', prompt: 'p' }, {
      signal: sig(), toolUseID: 't', requestId: 'r',
      suggestions: [
        { type: 'addRules', rules: [{ toolName: 'WebFetch', ruleContent: 'domain:nodemailer.com' }], behavior: 'allow', destination: 'localSettings' },
        { type: 'addDirectories', directories: ['/'], destination: 'session' },
      ],
    });
    await until(() => !!askOf());
    const ask = askOf()!;
    assert.deepEqual(ask.ask, { kind: 'permission', tool: 'WebFetch', title: 'Hämta från nätet?', detail: 'https://nodemailer.com/x', canRemember: true, defaultNo: false });
    assert.equal(status(), 'waiting');
    assert.equal(s.busy(ID), true);
    s.answer(ID, ask.id, 'allow-always');
    const r = (await pending) as PermissionResult;
    assert.deepEqual(r, {
      behavior: 'allow', updatedInput: { url: 'https://nodemailer.com/x', prompt: 'p' },
      updatedPermissions: [{ type: 'addRules', rules: [{ toolName: 'WebFetch', ruleContent: 'domain:nodemailer.com' }], behavior: 'allow', destination: 'session' }],
    });
    assert.deepEqual(chat().at(-1), { k: 'ask-done', id: ask.id, decision: 'allow-always' });
    assert.equal(status(), 'building');
  });

  test('neka', async () => {
    // Utan sandlåda: i sandlådan godkänns Bash utan kort (§8.5 punkt 2), så kortet "Köra ett kommando?" visas bara här.
    setup({ sandbox: false }, { sandbox: false });
    const p = await inTurn();
    const pending = cut(p)('Bash', { command: 'node x.js' }, { signal: sig(), toolUseID: 't', requestId: 'r', defaultToNo: true });
    await until(() => !!askOf());
    assert.equal((askOf()!.ask as { defaultNo: boolean }).defaultNo, true);
    assert.equal((askOf()!.ask as { title: string }).title, 'Köra ett kommando?');
    s.answer(ID, askOf()!.id, 'deny');
    assert.deepEqual(await pending, { behavior: 'deny', message: 'The user said no.' });
  });

  test('obesvarad fråga nekas efter tidsgränsen', async () => {
    setup({ permissionTimeoutMs: 80 });
    const p = await inTurn();
    const r = await cut(p)('WebFetch', { url: 'https://x.se' }, { signal: sig(), toolUseID: 't', requestId: 'r' });
    assert.equal(r?.behavior, 'deny');
    assert.deepEqual(chat().at(-1), { k: 'ask-done', id: askOf()!.id, decision: 'timeout' });
  });

  test('stopp avbryter en öppen fråga', async () => {
    setup();
    const p = await inTurn();
    p.onInterrupt = (pp) => pp.emit(sdk.result({ subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_tools' }));
    const pending = cut(p)('WebFetch', { url: 'https://x.se' }, { signal: sig(), toolUseID: 't', requestId: 'r' });
    await until(() => !!askOf());
    await s.stop(ID);
    assert.equal((await pending)?.behavior, 'deny');
    assert.ok(chat().some((e) => e.k === 'ask-done' && e.decision === 'cancelled'));
    await turnDone();
  });

  test('turens AbortSignal avbryter frågan', async () => {
    setup();
    const p = await inTurn();
    const ac = new AbortController();
    const pending = cut(p)('WebFetch', { url: 'https://x.se' }, { signal: ac.signal, toolUseID: 't', requestId: 'r' });
    await until(() => !!askOf());
    ac.abort();
    assert.equal((await pending)?.behavior, 'deny');
    assert.deepEqual(chat().at(-1), { k: 'ask-done', id: askOf()!.id, decision: 'cancelled' });
  });

  test('AskUserQuestion: frågan och svaret i rätt form', async () => {
    setup();
    const p = await inTurn();
    const questions = [{ question: 'Vilken mejltjänst?', header: 'Tjänst', multiSelect: false, options: [{ label: 'Gmail', description: 'Google' }, { label: 'iCloud', description: 'Apple', preview: 'x' }] }];
    const pending = cut(p)('AskUserQuestion', { questions }, { signal: sig(), toolUseID: 't', requestId: 'r' });
    await until(() => !!askOf());
    assert.deepEqual(askOf()!.ask, {
      kind: 'question',
      questions: [{ question: 'Vilken mejltjänst?', header: 'Tjänst', multiSelect: false, options: [{ label: 'Gmail', description: 'Google' }, { label: 'iCloud', description: 'Apple' }] }],
    });
    s.answer(ID, askOf()!.id, 'answered', { 'Vilken mejltjänst?': 'iCloud' });
    assert.deepEqual(await pending, { behavior: 'allow', updatedInput: { questions, answers: { 'Vilken mejltjänst?': 'iCloud' } } });
  });

  test('svar som inte passar frågan ignoreras', async () => {
    setup({ permissionTimeoutMs: 150 });
    const p = await inTurn();
    const pending = cut(p)('WebFetch', { url: 'https://x.se' }, { signal: sig(), toolUseID: 't', requestId: 'r' });
    await until(() => !!askOf());
    s.answer(ID, askOf()!.id, 'answered', { a: 'b' });
    s.answer(ID, 'q-okand', 'allow');
    assert.equal((await pending)?.behavior, 'deny', 'bara tidsgränsen avslutade den');
    assert.equal((chat().at(-1) as { decision?: string }).decision, 'timeout');
  });
});

/* ---------- Bash i sandlådan godkänns utan kort (§8.5 punkt 2, beslut 16 oktober 2026) ---------- */

describe('Bash i sandlådan (§8.5 punkt 2)', () => {
  // Claude Codes egna heuristiker frågar ibland trots sandlådan, till exempel med skälet nedan för JSON i en heredoc.
  // Det gav kortet "Köra ett kommando?" i 3 av 18 riktiga turer. Sandlådan är gränsen, så Workbench godkänner
  // sådana anrop direkt, men bara när policyn har släppt igenom dem och bara när Bash verkligen körs i sandlådan.
  // Kalibrering (slutrapporten): varje test fälls av en kopia av sessions.ts med raden borttagen eller med en
  // planterad för bred regel (raden före policyn, utan villkoret sandbox, alla verktyg i sandlådan).
  const HEREDOC = `cat > package.json <<'EOF'\n{"name": "x"}\nEOF`;
  const REASON = 'Contains brace with quote character (expansion obfuscation)';
  // Ett förslag i samma form som Claude Codes (addRules, allow, localSettings). Det får aldrig sparas av sig självt.
  const BASH_RULE: PermissionUpdate = { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'cat:*' }], behavior: 'allow', destination: 'localSettings' };

  async function inTurn(): Promise<ScriptProc> {
    engine.onProc = (p) => {
      p.onMessage = (_t, pp) => pp.emit(sdk.init('s'));
    };
    s.send(ID, 'x', 'text');
    await until(() => proc()?.received.length === 1);
    return proc();
  }

  /** Som när Claude Code frågar om ett Bash-kommando som heuristikerna fastnat på. */
  const bash = (p: ScriptProc, input: Record<string, unknown>, extra: { blockedPath?: string } = {}) =>
    cut(p)('Bash', input, { signal: sig(), toolUseID: 't', requestId: 'r', decisionReason: REASON, suggestions: [BASH_RULE], ...extra });

  /** Svaret om det kommer inom ms, annars 'väntar' (anropet hänger på ett kort). */
  async function within(r: Promise<PermissionResult | null>, ms = 1000): Promise<PermissionResult | null | 'väntar'> {
    let t: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([r, new Promise<'väntar'>((res) => (t = setTimeout(() => res('väntar'), ms)))]);
    } finally {
      clearTimeout(t);
    }
  }

  /** Nekat direkt, utan kort; ger policyns meddelande. */
  async function denied(r: Promise<PermissionResult | null>, what: string): Promise<string> {
    const x = await within(r);
    if (x === 'väntar' || x === null || x.behavior !== 'deny') assert.fail(`${what} nekades inte direkt: ${JSON.stringify(x)}`);
    return x.message;
  }

  /** Vad användaren har sett: kort (ask, ask-done), hur många gånger status blev waiting, och status nu. */
  const seen = () => ({
    cards: chat().filter((e) => e.k === 'ask' || e.k === 'ask-done').map((e) => e.k),
    waiting: w.rec.calls.filter((c) => c === `setStatus:${ID}:waiting`).length,
    status: status(),
  });
  const NO_CARD = { cards: [], waiting: 0, status: 'building' };

  // 1. Med sandlådan godkänns kommandon som heuristikerna fastnar på direkt.
  const ALLOWED: [string, string][] = [
    ['JSON i en heredoc', HEREDOC],
    ['node -e med klamrar (§8.11)', `node -e '{"a": 1}'`],
    ['$VAR', 'echo "$PORT"'],
  ];
  for (const [label, command] of ALLOWED) {
    test(`med sandlådan godkänns ${label} direkt: inget kort, aldrig status waiting, ingen regel sparas`, async () => {
      setup({}, { sandbox: true });
      const p = await inTurn();
      // Godkännandet vilar på att processen kör Bash i sandlådan, utan väg ut.
      assert.deepEqual(p.options.sandbox, { ...p.options.sandbox, enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false });
      const input = { command, description: 'x' };
      const r = await within(bash(p, input));
      assert.deepEqual({ r, ...seen() }, { r: { behavior: 'allow', updatedInput: input }, ...NO_CARD });
    });
  }

  // 2. Med sandlådan går policyn ändå först. blocked är relativ appens mapp; Claude Code sätter blockedPath
  // (absolut) när ett kommando når utanför tillåtna mappar.
  const SECRETS = /^Blocked by Workbench: data\/secrets\.json holds the user's secrets/;
  const POLICY: { label: string; command: string; blocked?: string; msg: RegExp }[] = [
    { label: 'cat data/secrets.json', command: 'cat data/secrets.json', msg: SECRETS },
    { label: 'secrets.json i en heredoc', command: `cat > data/secrets.json <<'EOF'\n{"api_key": "x"}\nEOF`, msg: SECRETS },
    {
      label: 'en annan apps fil i blockedPath',
      command: `cat > ../aapp002/index.html <<'EOF'\n{"x": 1}\nEOF`,
      blocked: '../aapp002/index.html',
      msg: /^Blocked by Workbench: ".*\/aapp002\/index\.html" is outside this app's folder/,
    },
    { label: 'en sökväg utanför appen i kommandot', command: '../aapp002/run.sh', msg: /^Blocked by Workbench: "\.\.\/aapp002\/run\.sh" is outside this app's folder/ },
  ];
  for (const c of POLICY) {
    test(`med sandlådan går policyn ändå först: ${c.label} nekas direkt med policyns meddelande`, async () => {
      setup({}, { sandbox: true });
      const p = await inTurn();
      const extra = c.blocked ? { blockedPath: path.resolve(w.paths.appDir(ID), c.blocked) } : {};
      assert.match(await denied(bash(p, { command: c.command }, extra), c.label), c.msg);
      assert.deepEqual(seen(), NO_CARD);
    });
  }

  // 3. Utan sandlåda är allt som förut.
  test('utan sandlåda ger JSON i en heredoc fortfarande kortet "Köra ett kommando?"', async () => {
    setup({ sandbox: false }, { sandbox: false });
    const p = await inTurn();
    assert.equal(p.options.sandbox, undefined);
    const input = { command: HEREDOC, description: 'x' };
    const pending = bash(p, input);
    await until(() => !!askOf(), 2000, 'kortet "Köra ett kommando?"');
    const card = { kind: 'permission', tool: 'Bash', title: 'Köra ett kommando?', detail: HEREDOC, canRemember: true, defaultNo: false };
    assert.deepEqual({ ask: askOf()!.ask, status: status() }, { ask: card, status: 'waiting' });
    s.answer(ID, askOf()!.id, 'allow');
    assert.deepEqual(await pending, { behavior: 'allow', updatedInput: input });
    assert.equal(status(), 'building');
  });

  test('med sandlådan men en ask-regel (matchedAskRule) visas kortet ändå: någon har uttryckligen bett om en människa', async () => {
    setup({}, { sandbox: true });
    const p = await inTurn();
    const input = { command: HEREDOC, description: 'x' };
    const pending = cut(p)('Bash', input, {
      signal: sig(), toolUseID: 't', requestId: 'r', decisionReason: REASON, suggestions: [BASH_RULE],
      matchedAskRule: { source: 'policySettings', toolName: 'Bash', ruleContent: 'cat:*' },
    } as Parameters<ReturnType<typeof cut>>[2]);
    await until(() => !!askOf(), 2000, 'kortet "Köra ett kommando?" trots sandlådan');
    assert.equal(askOf()!.ask.kind, 'permission');
    assert.equal(status(), 'waiting');
    s.answer(ID, askOf()!.id, 'deny');
    assert.equal((await pending)?.behavior, 'deny');
  });

  test('utan sandlåda går policyn först: git nekas direkt, utan kort', async () => {
    setup({ sandbox: false }, { sandbox: false });
    const p = await inTurn();
    assert.match(await denied(bash(p, { command: 'git commit -am x' }), 'git'), /^Blocked by Workbench: git is not available here/);
    assert.deepEqual(seen(), NO_CARD);
  });

  // 4. Med sandlådan frågar nätet och övriga verktyg som förut.
  const ASKED: [string, Record<string, unknown>, string, string][] = [
    ['SandboxNetworkAccess', { host: 'example.com' }, 'Hämta från nätet?', 'example.com'],
    ['WebFetch', { url: 'https://nodemailer.com/x', prompt: 'p' }, 'Hämta från nätet?', 'https://nodemailer.com/x'],
    ['Write', { file_path: '.mcp.json', content: '{}' }, 'Använda Write?', '{"file_path":".mcp.json","content":"{}"}'],
  ];
  for (const [tool, input, title, detail] of ASKED) {
    test(`med sandlådan frågar ${tool} som förut ("${title}")`, async () => {
      setup({}, { sandbox: true });
      const p = await inTurn();
      const pending = cut(p)(tool, input, { signal: sig(), toolUseID: 't', requestId: 'r' });
      await until(() => !!askOf(), 2000, `kortet för ${tool}`);
      const card = { kind: 'permission', tool, title, detail, canRemember: false, defaultNo: false };
      assert.deepEqual({ ask: askOf()!.ask, status: status() }, { ask: card, status: 'waiting' });
      s.answer(ID, askOf()!.id, 'deny');
      assert.deepEqual(await pending, { behavior: 'deny', message: 'The user said no.' });
      assert.equal(status(), 'building');
    });
  }

  // 5. Bara verktyget som heter exakt Bash godkänns. Andra skalverktyg (som inte körs genom Bash-sandlådans
  // beslut), gemener och MCP-verktyg med Bash i namnet frågar som förut, även med heuristikernas skäl.
  // Kalibrering (slutrapporten): fälls av bredare villkor (gemener, startsWith, endsWith, /bash/i, en lista av skalverktyg).
  const NEAR: [string, Record<string, unknown>][] = [
    ['bash', { command: 'ls' }],
    ['BashOutput', { bash_id: 'b1' }],
    ['KillShell', { shell_id: 'b1' }],
    ['Monitor', { command: 'tail -f x.log', description: 'x' }],
    ['mcp__evil__Bash', { command: 'ls' }],
  ];
  for (const [tool, input] of NEAR) {
    test(`med sandlådan frågar ${tool} som förut (bara exakt Bash godkänns)`, async () => {
      setup({}, { sandbox: true });
      const p = await inTurn();
      const pending = cut(p)(tool, input, { signal: sig(), toolUseID: 't', requestId: 'r', decisionReason: REASON });
      await until(() => !!askOf(), 2000, `kortet för ${tool}`);
      const card = { kind: 'permission', tool, title: `Använda ${tool}?`, detail: JSON.stringify(input), canRemember: false, defaultNo: false };
      assert.deepEqual({ ask: askOf()!.ask, status: status() }, { ask: card, status: 'waiting' });
      s.answer(ID, askOf()!.id, 'deny');
      assert.deepEqual(await pending, { behavior: 'deny', message: 'The user said no.' });
      assert.equal(status(), 'building');
    });
  }
});

describe('request_secret läcker inte', () => {
  test('värdet hamnar bara i data/secrets.json (kalibrerad sökning)', async () => {
    setup();
    const SECRET = 'HEMLIGT-värde-9d2f81';
    const captured: string[] = [];
    const orig = { log: console.log, warn: console.warn, error: console.error };
    for (const k of ['log', 'warn', 'error'] as const) console[k] = (...a: unknown[]) => captured.push(a.map(String).join(' '));
    try {
      engine.onProc = (p) => {
        p.onMessage = (_t, pp) => pp.emit(sdk.init('s'), sdk.toolUse('toolu_s', 'mcp__workbench__request_secret', { key: 'api_nyckel', label: 'API-nyckel' }));
      };
      s.send(ID, 'Koppla mot tjänsten', 'text');
      await until(() => proc()?.received.length === 1);
      const def = proc().tools.find((t) => t.name === 'request_secret')!;
      const pending = def.handler({ key: 'api_nyckel', label: 'API-nyckel' }, {});
      await until(() => askOf()?.ask.kind === 'secret');
      assert.deepEqual(askOf()!.ask, { kind: 'secret', key: 'api_nyckel', label: 'API-nyckel' });
      assert.equal(status(), 'waiting');
      s.answer(ID, askOf()!.id, 'answered', undefined, SECRET);
      const res = await pending;
      proc().emit(sdk.toolResult('toolu_s'), sdk.text('Sparat.'), sdk.result());
      await turnDone();

      const stored = JSON.parse(fs.readFileSync(path.join(w.paths.appDir(ID), 'data', 'secrets.json'), 'utf8'));
      assert.equal(stored.api_nyckel, SECRET);
      assert.equal(fs.statSync(path.join(w.paths.appDir(ID), 'data', 'secrets.json')).mode & 0o777, 0o600);

      const places = (): Record<string, string> => ({
        'chat.jsonl': fs.readFileSync(path.join(w.paths.appDataDir(ID), 'chat.jsonl'), 'utf8'),
        broadcasts: JSON.stringify(w.hub.msgs),
        logs: JSON.stringify([...w.logs.all.values()]),
        toolResult: JSON.stringify(res),
        console: captured.join('\n'),
        dataDir: fs.readdirSync(w.paths.appDataDir(ID)).map((f) => fs.readFileSync(path.join(w.paths.appDataDir(ID), f), 'utf8')).join('\n'),
      });
      const leaks = (p: Record<string, string>) => Object.entries(p).filter(([, v]) => v.includes(SECRET)).map(([k]) => k);
      // Kalibrering: sökningen hittar värdet när det planteras i en av platserna.
      const planted = places();
      planted.logs += SECRET;
      assert.deepEqual(leaks(planted), ['logs'], 'kalibrering: den planterade läckan hittas');
      assert.deepEqual(leaks(places()), [], 'värdet finns ingen annanstans');
      assert.deepEqual(chat().find((e) => e.k === 'ask-done'), { k: 'ask-done', id: askOf()!.id, decision: 'answered' });
    } finally {
      Object.assign(console, orig);
    }
  });

  test('tom hemlighet räknas som avböjd', async () => {
    setup();
    engine.onProc = (p) => {
      p.onMessage = (_t, pp) => pp.emit(sdk.init('s'));
    };
    s.send(ID, 'x', 'text');
    await until(() => proc()?.received.length === 1);
    const pending = proc().tools.find((t) => t.name === 'request_secret')!.handler({ key: 'k', label: 'K' }, {});
    await until(() => !!askOf());
    s.answer(ID, askOf()!.id, 'answered', undefined, '');
    assert.equal((await pending).isError, true);
    assert.equal(fs.existsSync(path.join(w.paths.appDir(ID), 'data', 'secrets.json')), false);
  });
});

describe('processer (§8.1)', () => {
  test('sessions-id sparas och nästa process återupptar samma session', async () => {
    setup({ idleCloseMs: 30 });
    engine.onProc = (p) => autoReply(p, 'sess-abc');
    s.send(ID, 'ett', 'text');
    await turnDone();
    await until(() => engine.alive === 0, 3000, 'vilostängning');
    s.send(ID, 'två', 'text');
    await turnDone(2);
    assert.equal(engine.startOptions.length, 2);
    assert.equal(engine.startOptions[0].resume, undefined);
    assert.equal(engine.startOptions[1].resume, 'sess-abc');
    assert.match(engine.procs[1].received[0], /Your notes \(CLAUDE\.md\):/, 'ny process: anteckningarna igen');
  });

  test('går sessionen inte att återuppta startas en ny', async () => {
    setup();
    fs.writeFileSync(path.join(w.paths.appDataDir(ID), 'session.json'), JSON.stringify({ sessionId: 'borta' }));
    engine.failNext = 1;
    engine.onProc = (p) => autoReply(p, 'ny-session');
    s.send(ID, 'x', 'text');
    await turnDone();
    assert.equal(engine.startOptions[0].resume, 'borta');
    assert.equal(engine.startOptions[1].resume, undefined);
    assert.equal(lastTurnEnd()?.ok, true);
    assert.ok(w.logs.tail(ID).some((l) => l.includes('kunde inte återupptas')));
    assert.match(fs.readFileSync(path.join(w.paths.appDataDir(ID), 'session.json'), 'utf8'), /ny-session/);
  });

  test('aldrig två processer på samma session', async () => {
    setup({ idleCloseMs: 20 });
    engine.onProc = (p) => {
      autoReply(p);
      p.endDelayMs = 250; // processen tar tid på sig att avsluta
    };
    s.send(ID, 'ett', 'text');
    await turnDone();
    await until(() => engine.procs[0].inputEnded, 3000, 'vilostängningen började');
    s.send(ID, 'två', 'text');
    await turnDone(2);
    assert.equal(engine.procs.length, 2);
    assert.equal(engine.maxConcurrent, 1);
  });

  test('vilostängning: bara när HUD:en är stängd och ingen tur pågår', async () => {
    setup({ idleCloseMs: 40 });
    engine.onProc = (p) => autoReply(p);
    s.open(ID);
    s.send(ID, 'x', 'text');
    await turnDone();
    await sleep(120);
    assert.equal(engine.alive, 1, 'HUD:en öppen: processen lever');
    s.close(ID);
    await until(() => engine.alive === 0, 3000);
    assert.equal(engine.procs[0].inputEnded, true, 'kön stängdes (inputQueue.end)');
  });

  test('högst fyra levande processer; den som varit stilla längst stängs, aldrig en som arbetar', async () => {
    setup();
    const ids = ['abbb001', 'abbb002', 'abbb003', 'abbb004', 'abbb005', 'abbb006'];
    for (const id of ids) w.addApp(id);
    engine.onProc = (p) => autoReply(p);
    // abbb001 arbetar (öppen tur som aldrig blir klar)
    engine.onProc = (p) => {
      p.onMessage = (_t, pp) => pp.emit(sdk.init('busy'));
    };
    s.send('abbb001', 'arbeta', 'text');
    await until(() => engine.procs.length === 1);
    engine.onProc = (p) => autoReply(p);
    for (const id of ids.slice(1, 4)) {
      s.open(id);
      await sleep(5);
    }
    await until(() => engine.alive === 4);
    s.open('abbb005');
    await until(() => engine.procs.length === 5);
    await until(() => engine.alive === 4, 3000, 'en process stängdes');
    assert.equal(engine.procs[0].inputEnded, false, 'den som arbetar stängs aldrig');
    assert.equal(engine.procs[1].inputEnded, true, 'abbb002 var stilla längst');
    assert.equal(s.busy('abbb001'), true);
  });

  test('självtestets avvikelser loggas som varningar', async () => {
    setup();
    engine.onProc = (p) => {
      p.statusReply = [{ name: 'workbench', status: 'connected' }, { name: 'gmail', status: 'connected' }];
      p.memoryReply = [{ path: '/Users/x/.claude/CLAUDE.md' }];
      p.onMessage = (_t, pp) => pp.emit(sdk.init('s', ['Bash', 'mcp__workbench__reload_app']), sdk.result());
    };
    s.open(ID);
    s.send(ID, 'x', 'text');
    await turnDone();
    await until(() => w.logs.tail(ID).filter((l) => l.includes('självtest')).length >= 3, 3000, 'varningarna');
    const lines = w.logs.tail(ID).filter((l) => l.includes('självtest')).join('\n');
    assert.match(lines, /\[workbench\] varning: självtest: MCP-servrar: workbench, gmail/);
    assert.match(lines, /minnesfiler lästes in: \/Users\/x\/\.claude\/CLAUDE\.md/);
    assert.match(lines, /verktyg saknas i system\/init: mcp__workbench__screenshot_app/);
  });

  test('utan sandlåda loggas en varning', async () => {
    setup({ sandbox: false }, { sandbox: false });
    engine.onProc = (p) => autoReply(p);
    s.send(ID, 'x', 'text');
    await turnDone();
    assert.ok(w.logs.tail(ID).some((l) => l.includes('[workbench] varning: WORKBENCH_SANDBOX=0')));
    assert.equal(engine.startOptions[0].sandbox, undefined);
  });
});

describe('forget, historik och omstart', () => {
  test('forget: processen stängs, session.json tas bort och inga händelser efteråt', async () => {
    setup();
    engine.onProc = (p) => {
      p.onMessage = (_t, pp) => pp.emit(sdk.init('sess-f'), sdk.text('börjar'));
    };
    s.send(ID, 'x', 'text');
    await until(() => fs.existsSync(path.join(w.paths.appDataDir(ID), 'session.json')));
    const p = proc();
    const before = w.hub.msgs.length;
    await s.forget(ID);
    assert.equal(p.closed || p.inputEnded, true);
    assert.equal(fs.existsSync(path.join(w.paths.appDataDir(ID), 'session.json')), false);
    p.emit(sdk.text('sent'), sdk.result());
    await sleep(30);
    assert.equal(w.hub.msgs.length, before, 'inga händelser efter forget');
    assert.equal(s.busy(ID), false);
    assert.ok(!w.rec.calls.some((c) => c.startsWith('commit:')), 'ingen commit för en borttagen app');
  });

  test('forget raderar appens transkript först när processen är stängd (§8.1)', async () => {
    setup();
    const order: string[] = [];
    engine.deleteTranscripts = async (dir) => {
      order.push(`delete:${dir}:${proc().closed || proc().inputEnded ? 'stängd' : 'lever'}`);
      return 1;
    };
    engine.onProc = (p) => {
      p.onMessage = (_t, pp) => pp.emit(sdk.init('sess-t'), sdk.text('börjar'));
    };
    s.send(ID, 'x', 'text');
    await until(() => fs.existsSync(path.join(w.paths.appDataDir(ID), 'session.json')));
    await s.forget(ID);
    assert.deepEqual(order, [`delete:${w.paths.appDir(ID)}:stängd`]);
    // En app som aldrig öppnats i den här serverprocessen kan ha transkript från en tidigare körning.
    order.length = 0;
    w.addApp('aapp002');
    await s.forget('aapp002');
    assert.equal(order.length, 1);
    assert.match(order[0], /aapp002/);
  });

  test('createSessions lagar chat.jsonl vid start', async () => {
    w = (await import('./server-claude-kit.ts')).makeWorld();
    w.addApp(ID);
    appendEvents(w.paths.appDataDir(ID), [
      { k: 'turn', phase: 'start', at: 1 },
      { k: 'ask', id: 'q-1', ask: { kind: 'secret', key: 'k', label: 'K' }, at: 2 },
    ]);
    engine = new ScriptEngine();
    s = createSessionsWith({ config: w.config, paths: w.paths, registry: w.registry, scene: w.scene, hub: w.hub, backends: w.backends, logs: w.logs, shots: w.shots, git: w.git }, engine, { sandbox: true });
    const h = s.history(ID, 10);
    assert.deepEqual(h.slice(-2).map((e) => (e.k === 'turn' ? `turn:${e.phase}:${e.interrupted}` : `${e.k}:${'decision' in e ? e.decision : ''}`)), ['ask-done:cancelled', 'turn:end:true']);
  });

  test('historiken för en okänd eller ogiltig app är tom', () => {
    setup();
    assert.deepEqual(s.history('../x'), []);
    assert.deepEqual(s.history('aokand1'), []);
  });

  test('kvotvarningen sänds en gång när den passerar 0,8', async () => {
    setup();
    engine.onProc = (p) => {
      p.onMessage = (_t, pp) => {
        const u = (f: number) => sdk.rateLimit({ status: 'allowed', rateLimitType: 'five_hour', unifiedWindows: { five_hour: { utilization: f }, seven_day: { utilization: 0.3 } } });
        pp.emit(sdk.init('s'), u(0.5), u(0.82), u(0.9), sdk.result());
      };
    };
    s.send(ID, 'x', 'text');
    await turnDone();
    assert.deepEqual(w.hub.msgs.filter((m) => m.t === 'limits'), [{ t: 'limits', fiveHour: 0.82, sevenDay: 0.3 }]);
  });
});

/* ---------- stopp med köade meddelanden (FE-4/ROB-7) ---------- */

describe('stopp gäller hela kedjan', () => {
  /**
   * Som Claude Code: andra meddelandet köas bakom turen. Stopp avbryter tur 1 (result med queued 1), sedan
   * börjar den köade turen och blir klar efter 60 ms om den inte avbryts. ignoreLater = planterat fel: den
   * köade turen kan inte avbrytas, vilket kalibrerar att testet ser när den körs färdigt.
   */
  async function scenario(ignoreLater: boolean): Promise<void> {
    setup();
    let turn = 0;
    let done: ReturnType<typeof setTimeout> | null = null;
    engine.onProc = (p) => {
      p.onMessage = (_t, pp) => {
        if (++turn === 1) pp.emit(sdk.init('sess-1'), sdk.toolUse('toolu_1', 'Bash', { command: 'sleep 20' }));
      };
      p.onInterrupt = (pp) => {
        if (pp.interrupts === 1) {
          pp.emit(sdk.result({ subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_tools', queued: 1 }));
          // Den köade turen börjar: Claude Code ignorerar ett avbrott mellan turerna.
          setTimeout(() => {
            pp.emit(sdk.init('sess-1'), sdk.delta('Klockan '));
            done = setTimeout(() => pp.emit(sdk.text('Klockan klar.'), sdk.result({ queued: 0 })), 60);
          }, 10);
        } else if (!ignoreLater && done) {
          clearTimeout(done);
          done = null;
          pp.emit(sdk.result({ subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_streaming', queued: 0 }));
        }
      };
    };
    s.send(ID, 'en anteckningsapp', 'text');
    await until(() => chat().some((e) => e.k === 'tool'));
    s.send(ID, 'en klocka', 'text');
    await until(() => proc()?.received.length === 2);
    await s.stop(ID);
    await turnDone();
  }

  test('kalibrering: kan den köade turen inte avbrytas syns den köras färdigt', async () => {
    await scenario(true);
    assert.ok(chat().some((e) => e.k === 'text' && e.text === 'Klockan klar.'));
  });

  test('den köade turen avbryts när den börjar, kedjan slutar avbruten och en not förklarar', async () => {
    await scenario(false);
    assert.equal(chat().some((e) => e.k === 'text' && e.text === 'Klockan klar.'), false, 'den köade turen kördes färdigt');
    assert.ok(proc().interrupts >= 2, `avbrott: ${proc().interrupts}`);
    assert.deepEqual(lastTurnEnd(), { ...lastTurnEnd(), ok: false, interrupted: true });
    assert.ok(chat().some((e) => e.k === 'note' && e.text === 'Stoppad – ”en klocka” avbröts'), JSON.stringify(chat().filter((e) => e.k === 'note')));
    assert.equal(status(), 'idle');
    assert.deepEqual(w.git.commits.map((c) => c.message), ['en anteckningsapp']);
  });

  test('ett köat meddelande som processen inte läst tas ur kön och skickas aldrig', async () => {
    setup();
    engine.startDelayMs = 80;
    engine.onProc = (p) => {
      p.onMessage = (_t, pp) => pp.emit(sdk.result({ subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_streaming' }));
    };
    s.send(ID, 'ett', 'text');
    s.send(ID, 'två', 'text');
    await s.stop(ID);
    await turnDone();
    assert.equal(proc().received.length, 1, 'bara det första meddelandet når processen');
    assert.ok(proc().received[0].endsWith('ett'));
    assert.ok(chat().some((e) => e.k === 'note' && e.text === 'Stoppad – ”två” skickades inte'));
  });

  /**
   * Som Claude Code: ett meddelande som kommer under en tur köas bakom den (queued i resultatet). Stoppet
   * avbryter tur 1 och resultatet kommer 150 ms senare; ett nytt meddelande skickas 50 ms efter stoppet.
   */
  async function newAfterStop(): Promise<void> {
    setup();
    let busy = false;
    let pending = 0;
    let done: ReturnType<typeof setTimeout> | null = null;
    const runTurn = (pp: ScriptProc) => {
      busy = true;
      pp.emit(sdk.init('sess-1'), sdk.delta('Två '));
      done = setTimeout(() => {
        done = null;
        busy = false;
        pp.emit(sdk.text('Två klar.'), sdk.result({ queued: 0 }));
      }, 60);
    };
    engine.onProc = (p) => {
      p.onMessage = (_t, pp) => {
        if (pp.received.length === 1) {
          busy = true;
          pp.emit(sdk.init('sess-1'), sdk.toolUse('toolu_1', 'Bash', { command: 'sleep 20' }));
        } else if (busy) pending++;
        else runTurn(pp);
      };
      p.onInterrupt = (pp) => {
        if (pp.interrupts === 1) {
          setTimeout(() => {
            const q = pending;
            pending = 0;
            busy = false;
            pp.emit(sdk.result({ subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_tools', queued: q }));
            if (q > 0) setTimeout(() => runTurn(pp), 10);
          }, 150);
        } else if (done) {
          clearTimeout(done);
          done = null;
          busy = false;
          pp.emit(sdk.result({ subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_streaming', queued: 0 }));
        }
      };
    };
    s.send(ID, 'en anteckningsapp', 'text');
    await until(() => chat().some((e) => e.k === 'tool'));
    await s.stop(ID);
    await sleep(50);
    s.send(ID, 'två', 'text');
    await until(() => !s.busy(ID) && chat().some((e) => e.k === 'turn' && e.phase === 'end'), 3000, 'kedjan');
    await sleep(200);
    await until(() => !s.busy(ID), 3000, 'turen');
  }

  test('ett nytt meddelande strax efter stoppet körs som vanligt, i en egen kedja', async () => {
    await newAfterStop();
    assert.ok(chat().some((e) => e.k === 'text' && e.text === 'Två klar.'), 'det nya meddelandet kördes inte färdigt');
    assert.equal(chat().some((e) => e.k === 'note'), false, JSON.stringify(chat().filter((e) => e.k === 'note')));
    assert.equal(proc().interrupts, 1);
    assert.deepEqual(lastTurnEnd(), { ...lastTurnEnd(), ok: true, interrupted: false });
    assert.deepEqual(w.git.commits.map((c) => c.message), ['en anteckningsapp', 'två']);
  });

  test('ett andra stopp tar också meddelandet som väntar på den stoppade kedjan', async () => {
    setup();
    engine.onProc = (p) => {
      p.onMessage = (_t, pp) => pp.emit(sdk.init('sess-1'), sdk.toolUse('toolu_1', 'Bash', { command: 'sleep 20' }));
      p.onInterrupt = (pp) => {
        if (pp.interrupts === 1) setTimeout(() => pp.emit(sdk.result({ subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_tools' })), 150);
      };
    };
    s.send(ID, 'ett', 'text');
    await until(() => chat().some((e) => e.k === 'tool'));
    await s.stop(ID);
    s.send(ID, 'två', 'text');
    await s.stop(ID);
    await turnDone();
    await sleep(50);
    assert.equal(proc().received.length, 1);
    assert.ok(chat().some((e) => e.k === 'note' && e.text === 'Stoppad – ”två” skickades inte'));
    assert.equal(w.git.commits.length, 1);
  });

  test('stopp under §8.6: hållna meddelanden skickas aldrig', async () => {
    setup({}, { gitDelayMs: 150 });
    engine.onProc = (p) => autoReply(p);
    s.send(ID, 'ett', 'text');
    await until(() => w.rec.calls.some((c) => c.startsWith('commit:')));
    s.send(ID, 'två', 'text');
    await s.stop(ID);
    await until(() => !s.busy(ID), 3000);
    await sleep(50);
    assert.equal(proc().received.length, 1);
    assert.ok(chat().some((e) => e.k === 'note' && e.text === 'Stoppad – ”två” skickades inte'));
    assert.equal(w.git.commits.length, 1);
  });
});

/* ---------- text som skrivs medan ett kort väntar (ROB-4/FE-3) ---------- */

describe('skriven text besvarar ett väntande kort', () => {
  async function inTurn(): Promise<ScriptProc> {
    engine.onProc = (p) => {
      p.onMessage = (_t, pp) => pp.emit(sdk.init('s'));
    };
    s.send(ID, 'x', 'text');
    await until(() => proc()?.received.length === 1);
    return proc();
  }

  test('tillstånd: nej med användarens ord, kortet försvinner, texten blir inget eget meddelande', async () => {
    setup();
    const p = await inTurn();
    const pending = cut(p)('WebFetch', { url: 'https://example.com' }, { signal: sig(), toolUseID: 't', requestId: 'r' });
    await until(() => !!askOf());
    s.send(ID, 'nej, hämta inget, använd en lokal lista', 'text');
    assert.deepEqual(await pending, { behavior: 'deny', message: 'The user said no and wrote instead: "nej, hämta inget, använd en lokal lista"' });
    assert.ok(chat().some((e) => e.k === 'ask-done' && e.id === askOf()!.id && e.decision === 'deny'));
    assert.ok(chat().some((e) => e.k === 'user' && e.text === 'nej, hämta inget, använd en lokal lista'), 'användarens rad syns');
    assert.equal(status(), 'building');
    await sleep(30);
    assert.equal(p.received.length, 1, 'texten gick till kortet, inte som ett köat meddelande');
  });

  test('fråga: texten blir det fria svaret', async () => {
    setup();
    const p = await inTurn();
    const questions = [{ question: 'Vilken mejltjänst?', header: 'Tjänst', multiSelect: false, options: [{ label: 'Gmail' }, { label: 'iCloud' }] }];
    const pending = cut(p)('AskUserQuestion', { questions }, { signal: sig(), toolUseID: 't', requestId: 'r' });
    await until(() => !!askOf());
    s.send(ID, 'Fastmail', 'text');
    assert.deepEqual(await pending, { behavior: 'allow', updatedInput: { questions, answers: { 'Vilken mejltjänst?': 'Fastmail' } } });
    await sleep(30);
    assert.equal(p.received.length, 1);
  });

  test('två kort: texten besvarar det äldsta, det andra står kvar; ett kort som just löpt ut tar ingen text', async () => {
    setup({ permissionTimeoutMs: 400 });
    const p = await inTurn();
    const first = cut(p)('WebFetch', { url: 'https://example.com/a' }, { signal: sig(), toolUseID: 't1', requestId: 'r1' });
    await until(() => chat().filter((e) => e.k === 'ask').length === 1);
    await sleep(150);
    const second = cut(p)('WebFetch', { url: 'https://example.com/b' }, { signal: sig(), toolUseID: 't2', requestId: 'r2' });
    await until(() => chat().filter((e) => e.k === 'ask').length === 2);
    s.send(ID, 'nej, ingen webb', 'text');
    assert.deepEqual(await first, { behavior: 'deny', message: 'The user said no and wrote instead: "nej, ingen webb"' });
    assert.equal(status(), 'waiting', 'det andra kortet väntar fortfarande');
    // Det andra kortet löper ut; texten som kommer efteråt blir ett vanligt meddelande, en gång.
    assert.equal((await second)?.behavior, 'deny');
    assert.equal(status(), 'building');
    s.send(ID, 'gör en lokal lista', 'text');
    await until(() => p.received.length === 2, 1000, 'texten som meddelande');
    await sleep(50);
    assert.equal(p.received.length, 2);
    assert.ok(p.received[1].endsWith('gör en lokal lista'));
  });

  test('kalibrering och spärr: en hemlighet får aldrig skriven text; kortet avböjs och texten går fram som meddelande', async () => {
    setup();
    const p = await inTurn();
    const tool = p.tools.find((t) => t.name === 'request_secret')!;
    const res = tool.handler({ key: 'api_nyckel', label: 'API-nyckel' }, { signal: sig() } as never) as Promise<{ isError?: boolean }>;
    await until(() => !!askOf());
    s.send(ID, 'jag har ingen nyckel än', 'text');
    assert.equal((await res).isError, true, 'request_secret ska avböjas');
    assert.equal(fs.existsSync(path.join(w.paths.appDir(ID), 'data', 'secrets.json')), false, 'texten får aldrig bli hemligheten');
    await until(() => p.received.length === 2, 1000, 'texten som meddelande');
    assert.ok(p.received[1].endsWith('jag har ingen nyckel än'));
  });
});

/* ---------- taket på levande processer (ROB-6) ---------- */

describe('taket på fyra processer', () => {
  test('sex samtidiga byggen: sex levande under turerna, högst fyra när de är klara', async () => {
    setup();
    const ids = ['aapp001', 'aapp002', 'aapp003', 'aapp004', 'aapp005', 'aapp006'];
    for (const id of ids.slice(1)) w.addApp(id);
    const release: (() => void)[] = [];
    engine.onProc = (p) => {
      p.onMessage = (_t, pp) => {
        pp.emit(sdk.init('sess'));
        release.push(() => pp.emit(sdk.text('Klart.'), sdk.result()));
      };
    };
    for (const id of ids) s.send(id, 'en klocka', 'text');
    await until(() => release.length === 6);
    // Kalibrering: medan alla arbetar får ingen stängas, så räkningen ser sex.
    assert.equal(engine.alive, 6);
    for (const r of release) r();
    await until(() => ids.every((id) => !s.busy(id)), 3000, 'turerna');
    await until(() => engine.alive <= 4, 8000, 'trimningen');
    assert.ok(engine.alive <= 4, `levande: ${engine.alive}`);
  });

  test('trimningen efter en tur tar aldrig processen bakom den öppna HUD:en', async () => {
    // Användaren tittar på aapp001 medan fem andra appar byggs; aapp001 blir klar först och är då den
    // enda stilla processen, och den som varit stilla längst.
    setup();
    const ids = ['aapp001', 'aapp002', 'aapp003', 'aapp004', 'aapp005', 'aapp006'];
    for (const id of ids.slice(1)) w.addApp(id);
    const release = new Map<string, () => void>();
    engine.onProc = (p) => {
      p.onMessage = (_t, pp) => {
        pp.emit(sdk.init('sess'));
        release.set(String(pp.options.cwd), () => pp.emit(sdk.text('Klart.'), sdk.result()));
      };
    };
    s.open(ID);
    s.send(ID, 'en klocka', 'text');
    await until(() => release.size === 1);
    const hudProc = proc();
    for (const id of ids.slice(1)) s.send(id, 'en klocka', 'text');
    await until(() => release.size === 6);
    release.get(String(hudProc.options.cwd))!();
    await until(() => !s.busy(ID), 3000, 'den första turen');
    await sleep(100);
    for (const [cwd, r] of release) if (cwd !== String(hudProc.options.cwd)) r();
    await until(() => ids.every((id) => !s.busy(id)), 3000, 'turerna');
    await until(() => engine.alive <= 4, 8000, 'trimningen');
    await sleep(100);
    assert.equal(hudProc.closed || hudProc.inputEnded, false, 'processen bakom den öppna HUD:en stängdes');
  });
  test('sex öppna HUD:ar: högst fyra levande när inget arbetar, den senast aktiva lever, och en återaktiverad app får sin process tillbaka', async () => {
    // Flera HUD:ar (§13): fler HUD:ar än taket kan vara öppna. Kalibrering: med dagens undantag för öppna HUD:ar
    // lever alla sex kvar efter turerna (trimningen nedan når aldrig fyra).
    setup();
    const ids = ['aapp001', 'aapp002', 'aapp003', 'aapp004', 'aapp005', 'aapp006'];
    for (const id of ids.slice(1)) w.addApp(id);
    const release: (() => void)[] = [];
    engine.onProc = (p) => {
      p.onMessage = (_t, pp) => {
        pp.emit(sdk.init('sess'));
        release.push(() => pp.emit(sdk.text('Klart.'), sdk.result()));
      };
    };
    for (const id of ids) {
      s.open(id);
      s.send(id, 'en klocka', 'text');
      await sleep(5);
    }
    await until(() => release.length === 6);
    assert.equal(engine.alive, 6, 'kalibrering: under turerna lever alla sex');
    for (const r of release) r();
    await until(() => ids.every((id) => !s.busy(id)), 3000, 'turerna');
    await until(() => engine.alive <= 4, 8000, 'trimningen');
    const live = (id: string) => engine.procs.some((p) => String(p.options.cwd).includes(id) && !p.closed && !p.inputEnded);
    assert.ok(live('aapp006'), 'den senast aktiva lever');
    assert.equal(live('aapp001'), false, 'den som varit stilla längst stängdes');
    // Användaren gör aapp001 aktiv igen (chat.open skickas vid aktivering): den får en process, och taket håller.
    s.open('aapp001');
    await until(() => live('aapp001'), 3000, 'aapp001 igen');
    await until(() => engine.alive <= 4, 8000, 'taket');
    assert.ok(live('aapp001'), 'den återaktiverade lever');
  });

  test('blandat: processer utan öppen HUD stängs först', async () => {
    setup();
    const ids = ['aapp001', 'aapp002', 'aapp003', 'aapp004', 'aapp005', 'aapp006'];
    for (const id of ids.slice(1)) w.addApp(id);
    const release: (() => void)[] = [];
    engine.onProc = (p) => {
      p.onMessage = (_t, pp) => {
        pp.emit(sdk.init('sess'));
        release.push(() => pp.emit(sdk.text('Klart.'), sdk.result()));
      };
    };
    // De tre första har sin HUD öppen och är äldst; de tre sista har ingen.
    for (const id of ids) {
      if (ids.indexOf(id) < 3) s.open(id);
      s.send(id, 'en klocka', 'text');
      await sleep(5);
    }
    await until(() => release.length === 6);
    for (const r of release) r();
    await until(() => ids.every((id) => !s.busy(id)), 3000, 'turerna');
    await until(() => engine.alive <= 4, 8000, 'trimningen');
    await sleep(50);
    const live = (id: string) => engine.procs.some((p) => String(p.options.cwd).includes(id) && !p.closed && !p.inputEnded);
    for (const id of ids.slice(0, 3)) assert.ok(live(id), `${id} har öppen HUD och lever`);
  });
});
