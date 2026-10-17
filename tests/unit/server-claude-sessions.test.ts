// Sessionerna (CONTRACT §8.1–§8.6, §8.10) mot en skriptad SDK-motor: samma meddelandeformer som Claude Code
// sänder, men utan modell. Riktiga Claude provas separat (tests/e2e/real-claude.test.ts, WORKBENCH_REAL=1).
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
import * as M from '../../web/src/hud/model.ts';
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
}, { timeout: 30_000 });

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

  test('gör om: note som vid ångra, och blocket säger sanningen netto (§7.4, §8.4)', async () => {
    setup();
    engine.onProc = (p) => autoReply(p);
    s.send(ID, 'ett', 'text');
    await turnDone(1);
    s.noteUndo(ID);
    s.noteRedo(ID);
    const note = chat().at(-1);
    assert.deepEqual(note, { ...note, k: 'note', text: 'Gjorde om ändringen.' });
    assert.ok(readChat(w, ID).some((e) => e.k === 'note' && e.text === 'Gjorde om ändringen.'), 'notisen sparas');
    s.send(ID, 'två', 'text');
    await turnDone(2);
    s.noteUndo(ID);
    s.noteUndo(ID);
    s.noteRedo(ID);
    s.send(ID, 'tre', 'text');
    await turnDone(3);
    s.noteRedo(ID); // ett steg som ångrades före förra meddelandet görs om
    s.send(ID, 'fyra', 'text');
    await turnDone(4);
    s.send(ID, 'fem', 'text');
    await turnDone(5);
    const [, m2, m3, m4, m5] = proc().received;
    assert.match(m2, /^Since your last turn: the user undid and then redid your changes; the files are as you left them\.$/m);
    assert.doesNotMatch(m2, /restored/, 'efter gör om påstår blocket inte att filerna återställts');
    assert.match(m3, /^Since your last turn: the user undid your last change; files are restored to the previous version\.$/m);
    assert.match(m4, /^Since your last turn: the user redid a change that had been undone earlier; the files now include it again\.$/m);
    assert.doesNotMatch(m5, /Since your last turn/, 'raden en gång');
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
    // Turslutet sänds efter steg 3 (§8.6), så det hållna meddelandets rad står före det.
    assert.deepEqual(kinds(chat()), ['user', 'turn:start', 'text', 'user', 'turn:end', 'turn:start', 'text', 'turn:end']);
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
  // Kalibrering: varje test fälls av en kopia av sessions.ts med raden borttagen eller med en
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
  // Kalibrering: fälls av bredare villkor (gemener, startsWith, endsWith, /bash/i, en lista av skalverktyg).
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
    const shown = (e: ChatEvent) => (e.k === 'turn' ? `turn:${e.phase}:${e.interrupted}` : e.k === 'note' ? `note:${e.text}` : `${e.k}:${'decision' in e ? e.decision : ''}`);
    assert.deepEqual(h.slice(-3).map(shown), ['ask-done:cancelled', 'turn:end:true', 'note:Avbröts']);
  });

  test('servern stängs under §8.6 steg 1–3: turslutet sparas direkt, så att nästa start inte lagar en färdig tur som avbruten', async () => {
    const restart = () => {
      s = createSessionsWith({ config: w.config, paths: w.paths, registry: w.registry, scene: w.scene, hub: w.hub, backends: w.backends, logs: w.logs, shots: w.shots, git: w.git }, engine, { sandbox: true });
    };
    const saved = () => readChat(w, ID).map((e) => (e.k === 'turn' ? (e.phase === 'end' ? `turn:end:${e.ok}:${e.interrupted}` : 'turn:start') : e.k === 'note' ? `note:${e.text}` : e.k));
    setup({}, { gitDelayMs: 300 });
    engine.onProc = (p) => autoReply(p);
    s.send(ID, 'ett', 'text');
    await until(() => w.rec.calls.some((c) => c.startsWith('commit:')));
    await s.closeAll();
    restart();
    assert.deepEqual(saved(), ['user', 'turn:start', 'text', 'turn:end:true:false'], 'en färdig tur, ingen "Avbröts"');
    await s.closeAll();
    w.cleanup();
    // En stoppad tur får "Avbröts" en gång (commitens resultat är okänt, så utan "ändringarna finns kvar").
    setup({}, { gitDelayMs: 300 });
    engine.onProc = (p) => {
      p.onMessage = (_t, pp) => pp.emit(sdk.init('s'), sdk.delta('Jag bygger'));
      p.onInterrupt = (pp) => pp.emit(sdk.result({ subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_streaming' }));
    };
    s.send(ID, 'en klocka', 'text');
    await until(() => chat().some((e) => e.k === 'delta'));
    await s.stop(ID);
    await until(() => w.rec.calls.some((c) => c.startsWith('commit:')));
    await s.closeAll();
    restart();
    assert.deepEqual(saved(), ['user', 'turn:start', 'text', 'turn:end:false:true', 'note:Avbröts']);
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
    // Bara den stoppade turen får en not (§8.6), det nya meddelandet ingen "Stoppad".
    assert.deepEqual(chat().filter((e) => e.k === 'note').map((e) => (e as { text: string }).text), ['Avbröts – ändringarna finns kvar']);
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

/* ---------- fel som användaren ser blir noter (§8.2) ---------- */

describe('fel som användaren ser blir noter (§8.2)', () => {
  const notes = () => chat().filter((e): e is Extract<ChatEvent, { k: 'note' }> => e.k === 'note');

  test('en commit som misslyckas: en not efter turslutet om att Ångra nu tar två ändringar, och loggraden som förut', async () => {
    setup();
    w.git.commitAll = async (appId, message) => {
      w.rec.calls.push(`commit:${appId}:${message}`);
      throw new Error('index.lock finns redan');
    };
    engine.onProc = (p) => autoReply(p);
    s.send(ID, 'Gör en klocka', 'text');
    await turnDone();
    const evs = chat();
    const end = evs.findIndex((e) => e.k === 'turn' && e.phase === 'end');
    const at = evs.findIndex((e) => e.k === 'note');
    assert.ok(at > end && end > 0, `noten ska komma efter turslutet: ${kinds(evs).join(' ')}`);
    assert.equal((evs[at] as { text: string }).text, 'Ändringen kunde inte sparas separat, så Ångra tar nu två ändringar på en gång.');
    assert.ok(readChat(w, ID).some((e) => e.k === 'note' && e.text.startsWith('Ändringen kunde inte sparas')), 'noten sparas i chat.jsonl');
    assert.ok(w.logs.tail(ID).some((l) => l.includes('commit misslyckades: index.lock finns redan')), 'loggraden för Claude finns kvar');
    assert.equal(status(), 'idle');
  });

  test('sessionen går inte att återuppta: en not om att Claude börjar om utan minne', async () => {
    setup();
    fs.writeFileSync(path.join(w.paths.appDataDir(ID), 'session.json'), JSON.stringify({ sessionId: 'borta' }));
    engine.failNext = 1;
    engine.onProc = (p) => autoReply(p, 'ny-session');
    s.open(ID);
    await until(() => engine.procs.length === 1, 3000, 'den nya processen');
    await until(() => notes().length > 0, 3000, 'noten');
    assert.deepEqual(notes().map((n) => n.text), ['Claude kunde inte fortsätta det tidigare samtalet och börjar om utan minne av det.']);
    assert.ok(w.logs.tail(ID).some((l) => l.includes('kunde inte återupptas')), 'loggraden finns kvar');
    assert.ok(readChat(w, ID).some((e) => e.k === 'note'), 'noten sparas');
  });

  test('självtestet: minnesfiler och främmande MCP-servrar blir noter; saknade verktyg bara varningar', async () => {
    setup();
    engine.onProc = (p) => {
      p.statusReply = [{ name: 'workbench', status: 'connected' }, { name: 'gmail', status: 'connected' }];
      p.memoryReply = [{ path: '/Users/x/.claude/CLAUDE.md' }, { path: '/Users/x/.claude/projects/y/memory/MEMORY.md' }];
      p.onMessage = (_t, pp) => pp.emit(sdk.init('s', ['Bash']), sdk.result());
    };
    s.open(ID);
    await until(() => notes().length >= 2, 3000, 'noterna');
    await sleep(30);
    assert.deepEqual(notes().map((n) => n.text).sort(), [
      'Claude fick tillgång till MCP-servrar utanför appen: gmail. Det de når kan hamna i appen.',
      'Claude läste in minnesfiler utanför appen: /Users/x/.claude/CLAUDE.md, /Users/x/.claude/projects/y/memory/MEMORY.md. Det som står där kan hamna i appen.',
    ]);
    // Verktygen som saknas i system/init (bara Bash) är en varning i loggen, ingen not.
    s.send(ID, 'x', 'text');
    await turnDone();
    assert.ok(w.logs.tail(ID).some((l) => l.includes('verktyg saknas i system/init')));
    assert.equal(notes().length, 2);
  });

  test('självtestet: samma läcka ger en not en gång, även i nästa process och efter en omstart; en annan läcka ger en ny', async () => {
    setup({ idleCloseMs: 20 });
    let files = ['/Users/x/.claude/CLAUDE.md'];
    engine.onProc = (p) => {
      p.memoryReply = files.map((f) => ({ path: f }));
    };
    // Självtestet loggar varningen och sänder noten i samma steg: när varningen finns är noten avgjord.
    const tested = (n: number) => until(() => w.logs.tail(ID, 1000).filter((l) => l.includes('självtest: minnesfiler')).length >= n, 3000, `självtest ${n}`);
    const reopen = async (n: number) => {
      s.close(ID);
      await until(() => engine.alive === 0, 3000, 'processen stängd');
      s.open(ID);
      await tested(n);
    };
    s.open(ID);
    await tested(1);
    assert.equal(notes().length, 1);
    // HUD:en stängs och öppnas igen: en ny process med samma läcka.
    await reopen(2);
    assert.equal(notes().length, 1, 'samma not upprepas inte i nästa process');
    // En omstart av servern: nya sessioner, samma chat.jsonl.
    await s.closeAll();
    s = createSessionsWith({ config: w.config, paths: w.paths, registry: w.registry, scene: w.scene, hub: w.hub, backends: w.backends, logs: w.logs, shots: w.shots, git: w.git }, engine, { sandbox: true });
    s.open(ID);
    await tested(3);
    assert.equal(notes().length, 1, 'samma not upprepas inte efter en omstart');
    // En annan läcka (en fil till) är ny information.
    files = [...files, '/Users/x/.claude/projects/y/memory/MEMORY.md'];
    await reopen(4);
    assert.deepEqual(notes().map((n) => n.text), [
      'Claude läste in minnesfiler utanför appen: /Users/x/.claude/CLAUDE.md. Det som står där kan hamna i appen.',
      'Claude läste in minnesfiler utanför appen: /Users/x/.claude/CLAUDE.md, /Users/x/.claude/projects/y/memory/MEMORY.md. Det som står där kan hamna i appen.',
    ]);
    assert.equal(w.logs.tail(ID, 1000).filter((l) => l.includes('självtest: minnesfiler')).length, 4, 'varningen loggas varje gång');
  });

  test('kalibrering: ett rent självtest ger ingen not', async () => {
    setup();
    engine.onProc = (p) => autoReply(p);
    s.open(ID);
    s.send(ID, 'x', 'text');
    await turnDone();
    await sleep(50);
    assert.deepEqual(notes(), []);
  });
});

/* ---------- Stopp lämnar ett spår (§8.3, §8.6) ---------- */

describe('Stopp lämnar ett spår (§8.3, §8.6)', () => {
  /** En tur som strömmar text och väntar; stopp avbryter den med ett result som Claude Code. */
  function streaming(deltas: string[], after: (pp: ScriptProc) => void = () => {}): void {
    engine.onProc = (p) => {
      p.onMessage = (_t, pp) => {
        pp.emit(sdk.init('s'), ...deltas.map((d) => sdk.delta(d)));
        after(pp);
      };
      p.onInterrupt = (pp) => pp.emit(sdk.result({ subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_streaming' }));
    };
  }

  test('stopp mitt i strömmen: det delvisa svaret blir en sista text, och en not efter turslutet säger att ändringarna finns kvar', async () => {
    setup();
    streaming(['Jag bygger ', 'en klocka']);
    s.send(ID, 'en klocka', 'text');
    await until(() => chat().filter((e) => e.k === 'delta').length === 2);
    await s.stop(ID);
    await turnDone();
    assert.deepEqual(kinds(chat()), ['user', 'turn:start', 'delta', 'delta', 'text', 'turn:end', 'note']);
    const text = chat().find((e) => e.k === 'text') as Extract<ChatEvent, { k: 'text' }>;
    assert.equal(text.text, 'Jag bygger en klocka');
    assert.equal((chat().at(-1) as { text: string }).text, 'Avbröts – ändringarna finns kvar');
    // Båda sparas, så att de står kvar när HUD:en öppnas igen.
    assert.deepEqual(readChat(w, ID).filter((e) => e.k === 'text' || e.k === 'note').map((e) => (e as { text: string }).text), ['Jag bygger en klocka', 'Avbröts – ändringarna finns kvar']);
    assert.equal(status(), 'idle');
  });

  test('inget att committa: noten säger bara Avbröts', async () => {
    setup();
    w.git.commitAll = async () => false;
    streaming(['Jag ']);
    s.send(ID, 'x', 'text');
    await until(() => chat().some((e) => e.k === 'delta'));
    await s.stop(ID);
    await turnDone();
    assert.equal((chat().at(-1) as { text: string }).text, 'Avbröts');
  });

  test('en text som redan kommit efter strömmen sänds inte igen; bara text som strömmat in efter den', async () => {
    setup();
    streaming(['Jag börjar.'], (pp) => pp.emit(sdk.text('Jag börjar.'), sdk.delta('Nu skriver ')));
    s.send(ID, 'x', 'text');
    await until(() => chat().filter((e) => e.k === 'delta').length === 2);
    await s.stop(ID);
    await turnDone();
    assert.deepEqual(chat().filter((e) => e.k === 'text').map((e) => (e as { text: string }).text), ['Jag börjar.', 'Nu skriver ']);
  });

  test('stopp med ett köat meddelande: det delvisa svaret hör till den första turen, och den köade turens början visas inte', async () => {
    setup();
    engine.onProc = (p) => {
      p.onMessage = (_t, pp) => {
        if (pp.received.length === 1) pp.emit(sdk.init('s'), sdk.delta('Jag bygger '), sdk.delta('anteckningar'));
      };
      p.onInterrupt = (pp) => {
        if (pp.interrupts > 1) return;
        pp.emit(sdk.result({ subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_streaming', queued: 1 }));
        // Den köade turen börjar strömma innan avbrottet når den (som Claude Code mellan turerna).
        setTimeout(() => pp.emit(sdk.init('s'), sdk.delta('Klockan '), sdk.result({ subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_streaming' })), 10);
      };
    };
    s.send(ID, 'en anteckningsapp', 'text');
    await until(() => chat().filter((e) => e.k === 'delta').length === 2);
    s.send(ID, 'en klocka', 'text');
    await until(() => proc()?.received.length === 2);
    await s.stop(ID);
    await turnDone();
    await sleep(30);
    assert.deepEqual(chat().filter((e) => e.k === 'text').map((e) => (e as { text: string }).text), ['Jag bygger anteckningar']);
    const shown = chat().filter((e) => e.k !== 'delta').map((e) => (e.k === 'turn' ? `turn:${e.phase}` : e.k === 'user' || e.k === 'text' || e.k === 'note' ? `${e.k}:${e.text}` : e.k));
    assert.deepEqual(shown, [
      'user:en anteckningsapp', 'turn:start', 'user:en klocka', 'note:Stoppad – ”en klocka” avbröts', 'text:Jag bygger anteckningar', 'turn:end', 'note:Avbröts – ändringarna finns kvar',
    ]);
  });

  test('stopp under en köad tur som redan börjat: den får ingen "Stoppad"-not, och dess delvisa svar står kvar', async () => {
    setup();
    engine.onProc = (p) => {
      p.onMessage = (_t, pp) => {
        if (pp.received.length === 1) pp.emit(sdk.init('s'), sdk.text('Anteckningarna är klara.'), sdk.result({ queued: 1 }), sdk.init('s'), sdk.delta('Jag lägger till '));
      };
      p.onInterrupt = (pp) => pp.emit(sdk.result({ subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_streaming' }));
    };
    s.send(ID, 'en anteckningsapp', 'text');
    s.send(ID, 'och en rubrik', 'text');
    await until(() => chat().some((e) => e.k === 'delta' && e.text === 'Jag lägger till '));
    await s.stop(ID);
    await turnDone();
    assert.deepEqual(chat().filter((e) => e.k === 'note').map((e) => (e as { text: string }).text), ['Avbröts – ändringarna finns kvar']);
    assert.deepEqual(chat().filter((e) => e.k === 'text').map((e) => (e as { text: string }).text), ['Anteckningarna är klara.', 'Jag lägger till ']);
  });

  test('en tur som inte avbröts får ingen extra text och ingen not', async () => {
    setup();
    engine.onProc = (p) => autoReply(p);
    s.send(ID, 'x', 'text');
    await turnDone();
    assert.deepEqual(kinds(chat()), ['user', 'turn:start', 'delta', 'text', 'turn:end']);
  });

  test('noterna för meddelanden som aldrig kördes pekar ut användarens rad (dropped)', async () => {
    setup();
    engine.startDelayMs = 80;
    engine.onProc = (p) => {
      p.onMessage = (_t, pp) => pp.emit(sdk.result({ subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_streaming' }));
    };
    s.send(ID, 'ett', 'text');
    s.send(ID, 'två', 'text');
    await s.stop(ID);
    await turnDone();
    const two = chat().find((e) => e.k === 'user' && e.text === 'två') as Extract<ChatEvent, { k: 'user' }>;
    const note = chat().find((e) => e.k === 'note' && e.text === 'Stoppad – ”två” skickades inte') as Extract<ChatEvent, { k: 'note' }>;
    assert.ok(two && note, JSON.stringify(chat()));
    assert.equal(note.dropped, two.id);
    const saved = readChat(w, ID).find((e) => e.k === 'note' && e.text.startsWith('Stoppad')) as Extract<ChatEvent, { k: 'note' }> | undefined;
    assert.equal(saved?.dropped, two.id, 'dropped sparas i chat.jsonl');
    // Noten för själva turen pekar inte ut någon rad: det första meddelandet kördes.
    assert.equal((chat().find((e) => e.k === 'note' && e.text.startsWith('Avbröts')) as { dropped?: string } | undefined)?.dropped, undefined);
  });

  test('turslutet sänds först efter backendens omstart (§8.6 steg 3), så att en GET direkt efter turslutet når den nya backenden', async () => {
    setup();
    const send = w.hub.broadcast;
    w.hub.broadcast = (m) => {
      if (m.t === 'chat' && m.ev.k === 'turn') w.rec.calls.push(`turn:${m.ev.phase}`);
      send(m);
    };
    engine.onProc = (p) => autoReply(p);
    s.send(ID, 'Lägg till /api/tid', 'text');
    await turnDone();
    assert.deepEqual(w.rec.calls, [
      'turn:start', `setStatus:${ID}:building`, `commit:${ID}:Lägg till /api/tid`, `refresh:${ID}`, `restart:${ID}`, 'turn:end', `bumpRev:${ID}`, `setStatus:${ID}:idle`,
    ]);
  });

  test('i HUD:en med serverns ordning står turens not ovanför meddelandet efter Stopp eller under §8.6, och rösten väntar på sin tur (§12, §13)', async () => {
    const view = () => M.messages(chat()).map((m) => `${m.kind}:${m.text}`);
    // Stopp, och ett nytt meddelande innan den stoppade turen har slutat.
    setup();
    engine.onProc = (p) => {
      p.onMessage = (_t, pp) => {
        if (pp.received.length === 1) pp.emit(sdk.init('s'), sdk.delta('Jag bygger '), sdk.delta('en klocka'));
        else pp.emit(sdk.init('s'), sdk.text('Klart. Väckarklockan finns.'), sdk.result());
      };
      p.onInterrupt = (pp) => setTimeout(() => pp.emit(sdk.result({ subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_streaming' })), 50);
    };
    s.send(ID, 'en klocka', 'text');
    await until(() => chat().filter((e) => e.k === 'delta').length === 2);
    await s.stop(ID);
    s.send(ID, 'gör en väckarklocka i stället', 'text');
    await turnDone(2);
    assert.deepEqual(view(), [
      'user:en klocka', 'reply:Jag bygger en klocka', 'note:Avbröts – ändringarna finns kvar', 'user:gör en väckarklocka i stället', 'reply:Klart. Väckarklockan finns.',
    ]);
    await s.closeAll();
    w.cleanup();
    // Ett köat meddelande vars tur hann börja (ett verktyg, ingen text) när Stopp kom: noten hör till den turen.
    setup();
    engine.onProc = (p) => {
      p.onMessage = (_t, pp) => {
        if (pp.received.length === 1) {
          pp.emit(sdk.init('s'), sdk.text('Klart. Anteckningar.'), sdk.result({ queued: 1 }), sdk.init('s'), sdk.toolUse('toolu_q', 'Edit', { file_path: 'index.html' }));
        }
      };
      p.onInterrupt = (pp) => pp.emit(sdk.result({ subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_tools' }));
    };
    s.send(ID, 'en anteckningsapp', 'text');
    s.send(ID, 'och en rubrik', 'text');
    await until(() => chat().some((e) => e.k === 'tool'));
    await s.stop(ID);
    await turnDone();
    assert.deepEqual(view(), ['user:en anteckningsapp', 'reply:Klart. Anteckningar.', 'user:och en rubrik', 'note:Avbröts – ändringarna finns kvar']);
    await s.closeAll();
    w.cleanup();
    // Ett röstmeddelande under §8.6, och en commit som misslyckas första gången.
    setup();
    let commits = 0;
    w.git.commitAll = async (appId, message) => {
      w.rec.calls.push(`commit:${appId}:${message}`);
      await sleep(150);
      if (++commits === 1) throw new Error('index.lock finns redan');
      return true;
    };
    engine.onProc = (p) => {
      p.onMessage = (_t, pp) => pp.emit(sdk.init('s'), sdk.text(pp.received.length === 1 ? 'Klart. Klockan går.' : 'Klart. Den är större.'), sdk.result());
    };
    s.send(ID, 'en klocka', 'text');
    await until(() => w.rec.calls.some((c) => c.startsWith('commit:')));
    s.send(ID, 'gör den större', 'voice');
    await turnDone(2);
    assert.deepEqual(view(), [
      'user:en klocka', 'reply:Klart. Klockan går.', 'note:Ändringen kunde inte sparas separat, så Ångra tar nu två ändringar på en gång.',
      'user:gör den större', 'reply:Klart. Den är större.',
    ]);
    const ends = chat().flatMap((e, i) => (e.k === 'turn' && e.phase === 'end' ? [i] : []));
    assert.equal(M.spokenReply(chat().slice(0, ends[0] + 1)), 'wait', 'den första turen svarade inte på röstmeddelandet');
    assert.deepEqual(M.spokenReply(chat().slice(0, ends[1] + 1)), { via: 'voice', text: 'Klart. Den är större.' });
  });
});

/* ---------- gravstenen efter forget (§8.1) ---------- */

describe('gravstenen efter forget (§8.1)', () => {
  test('forget → open startar ingen process (gravsten, inte borttagen session)', async () => {
    setup();
    engine.onProc = (p) => autoReply(p);
    s.open(ID);
    await until(() => engine.procs.length === 1);
    await s.forget(ID);
    // Ett chat.open (och ett meddelande) mellan forget och registry.remove, som i en DELETE mitt i en öppning.
    s.open(ID);
    s.send(ID, 'x', 'text');
    await sleep(100);
    assert.equal(engine.startOptions.length, 1, 'ingen ny process startades');
    assert.equal(engine.alive, 0);
    s.noteUndo(ID);
    s.note(ID, 'Backenden har kraschat.');
    assert.deepEqual(chat(), [], 'inget skrevs');
  });

  test('forget på en app som aldrig öppnats → open startar ingen process', async () => {
    setup();
    await s.forget(ID);
    s.open(ID);
    s.send(ID, 'x', 'text');
    await sleep(100);
    assert.equal(engine.startOptions.length, 0, 'ingen process startades');
    assert.deepEqual(chat(), []);
  });
});

/* ---------- noter från andra moduler och tömning vid avslut (§8.1, §7) ---------- */

describe('sessions.note och tömningen', () => {
  test('sessions.note: utanför en tur sänds och sparas noten; under en tur tas den inte med', async () => {
    setup();
    s.note(ID, 'Backenden kraschade 4 gånger på 60 s. Den startar igen när Claude ändrar appen eller när du ångrar.');
    assert.deepEqual(chat().map((e) => `${e.k}:${(e as { text?: string }).text}`), ['note:Backenden kraschade 4 gånger på 60 s. Den startar igen när Claude ändrar appen eller när du ångrar.']);
    assert.equal(readChat(w, ID).length, 1, 'sparas');
    engine.onProc = (p) => {
      p.onMessage = (_t, pp) => pp.emit(sdk.init('s'));
    };
    s.send(ID, 'x', 'text');
    await until(() => proc()?.received.length === 1);
    s.note(ID, 'under turen');
    assert.equal(chat().some((e) => e.k === 'note' && e.text === 'under turen'), false, 'Claude ser kraschen själv under turen');
  });

  test('sessions.note under §8.6 (backendens omstart i steg 3) väntar till efter turslutet', async () => {
    setup({}, { gitDelayMs: 150 });
    engine.onProc = (p) => autoReply(p);
    s.send(ID, 'ett', 'text');
    await until(() => w.rec.calls.some((c) => c.startsWith('commit:')));
    const text = 'Backenden kan inte startas: backend.entry finns inte: "server.mjs".';
    s.note(ID, text);
    assert.equal(chat().some((e) => e.k === 'note'), false, 'inte medan §8.6 pågår');
    await turnDone();
    const evs = chat();
    const end = evs.findIndex((e) => e.k === 'turn' && e.phase === 'end');
    const at = evs.findIndex((e) => e.k === 'note' && e.text === text);
    assert.ok(end > 0 && at > end, `noten ska komma efter turslutet: ${kinds(evs).join(' ')}`);
    assert.ok(readChat(w, ID).some((e) => e.k === 'note' && e.text === text), 'sparas');
  });

  test('drain: ingen ny tur startar, ett meddelande får en not, och en pågående tur går klart', async () => {
    setup();
    w.addApp('aapp002');
    const release: (() => void)[] = [];
    engine.onProc = (p) => {
      p.onMessage = (_t, pp) => {
        pp.emit(sdk.init('s'));
        release.push(() => pp.emit(sdk.text('Klart.'), sdk.result()));
      };
    };
    s.send(ID, 'en klocka', 'text');
    await until(() => release.length === 1);
    s.drain();
    assert.equal(s.busy(ID), true);
    s.send('aapp002', 'en kalender', 'text');
    s.send(ID, 'och en väckarklocka', 'text');
    s.open('aapp002');
    await sleep(60);
    assert.equal(engine.startOptions.length, 1, 'ingen ny process');
    assert.equal(proc().received.length, 1, 'inget lades i kön');
    const noteFor = (appId: string, text: string) => {
      const u = w.hub.chat(appId).find((e) => e.k === 'user' && e.text === text) as Extract<ChatEvent, { k: 'user' }> | undefined;
      const n = w.hub.chat(appId).find((e) => e.k === 'note' && e.text === `Servern startar om – ”${text}” skickades inte`) as Extract<ChatEvent, { k: 'note' }> | undefined;
      return { user: !!u, note: !!n, dropped: !!u && n?.dropped === u.id };
    };
    assert.deepEqual(noteFor('aapp002', 'en kalender'), { user: true, note: true, dropped: true });
    assert.deepEqual(noteFor(ID, 'och en väckarklocka'), { user: true, note: true, dropped: true });
    assert.equal(s.busy('aapp002'), false);
    release[0]();
    await until(() => !s.busy(ID), 3000, 'den pågående turen');
    assert.deepEqual(lastTurnEnd(), { ...lastTurnEnd(), ok: true });
    assert.deepEqual(w.git.commits.map((c) => c.message), ['en klocka']);
  });

  test('drain: meddelanden som hålls under §8.6 körs inte', async () => {
    setup({}, { gitDelayMs: 150 });
    engine.onProc = (p) => autoReply(p);
    s.send(ID, 'ett', 'text');
    await until(() => w.rec.calls.some((c) => c.startsWith('commit:')));
    s.send(ID, 'två', 'text');
    s.drain();
    await until(() => !s.busy(ID), 3000);
    await sleep(50);
    assert.equal(proc().received.length, 1);
    assert.ok(chat().some((e) => e.k === 'note' && e.text === 'Servern startar om – ”två” skickades inte'), JSON.stringify(chat().filter((e) => e.k === 'note')));
    assert.equal(w.git.commits.length, 1);
  });

  test('drain: ett kort i den pågående turen kan fortfarande besvaras med text', async () => {
    setup();
    engine.onProc = (p) => {
      p.onMessage = (_t, pp) => pp.emit(sdk.init('s'));
    };
    s.send(ID, 'x', 'text');
    await until(() => proc()?.received.length === 1);
    const pending = cut(proc())('WebFetch', { url: 'https://example.com' }, { signal: sig(), toolUseID: 't', requestId: 'r' });
    await until(() => !!askOf());
    s.drain();
    s.send(ID, 'nej, använd en lokal lista', 'text');
    assert.deepEqual(await pending, { behavior: 'deny', message: 'The user said no and wrote instead: "nej, använd en lokal lista"' });
    assert.equal(chat().some((e) => e.k === 'note'), false);
  });
});

describe('reload_app i en ny session (§8.7)', () => {
  test('första omladdningen tar inte med konsolfel från före sessionen (loggen fylls från logs.txt efter en omstart); nya fel kommer med', async () => {
    setup();
    // Rader som fanns innan sessionen startade, till exempel gårdagens rader som lästs in igen ur logs.txt.
    w.logs.append(ID, 'console', 'error: fel från igår');
    engine.onProc = (p) => {
      p.onMessage = (_t, pp) => pp.emit(sdk.init('s', ['mcp__workbench__reload_app']));
    };
    s.send(ID, 'x', 'text');
    await until(() => proc()?.received.length === 1);
    const reload = proc().tools.find((t) => t.name === 'reload_app')!;
    const textOf = (r: unknown) => ((r as { content: { type: string; text?: string }[] }).content).map((c) => c.text ?? '').join('\n');
    w.logs.append(ID, 'console', 'error: nytt fel');
    const first = textOf(await reload.handler({}, {} as never));
    assert.match(first, /error: nytt fel/);
    assert.doesNotMatch(first, /fel från igår/, 'gamla rader räknas som nya fel');
    w.logs.append(ID, 'console', 'error: ännu ett fel');
    const second = textOf(await reload.handler({}, {} as never));
    assert.match(second, /ännu ett fel/);
    assert.doesNotMatch(second, /nytt fel\b/);
  });
});
