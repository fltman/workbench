// forget raderar appens Claude-transkript (CONTRACT §8.1) med SDK:ns riktiga listSessions och deleteSession.
// SDK:n läser CLAUDE_CONFIG_DIR, så testet pekar den på en egen katalog under .scratch: användarens
// ~/.claude rörs aldrig. Påståendet "andra transkript raderas inte" fälls först av en planterad, naiv rensning.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { deleteSession, listSessions } from '@anthropic-ai/claude-agent-sdk';
import { deleteTranscripts, projectDirName, removeEmptyProjectDirs } from '../../server/claude/engine.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Samma namn som Claude Code ger projektkatalogen för en cwd (korta sökvägar). */
function projectName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

function transcript(sessionId: string, cwd: string, prompt: string): string {
  const base = { sessionId, cwd, version: '2.1.0', gitBranch: '', userType: 'external', entrypoint: 'sdk-ts', isSidechain: false };
  return [
    { ...base, type: 'user', parentUuid: null, uuid: crypto.randomUUID(), timestamp: '2026-10-16T00:00:00.000Z', message: { role: 'user', content: prompt } },
    { ...base, type: 'assistant', parentUuid: null, uuid: crypto.randomUUID(), timestamp: '2026-10-16T00:00:01.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Klart.' }] } },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n';
}

describe('transkripten raderas bara för appens egen mapp', () => {
  let scratch: string;
  let config: string;
  let projects: string;
  let appA: string;
  let appB: string;
  let lookalike: string;
  const ids = { own: '', ownSub: '', other: '', lookalike: '' };
  const prevConfig = process.env.CLAUDE_CONFIG_DIR;

  function file(cwd: string, id: string): string {
    return path.join(projects, projectName(cwd), `${id}.jsonl`);
  }

  function plant(): void {
    fs.rmSync(projects, { recursive: true, force: true });
    for (const k of Object.keys(ids) as (keyof typeof ids)[]) ids[k] = crypto.randomUUID();
    const put = (cwd: string, id: string, prompt: string) => {
      fs.mkdirSync(path.dirname(file(cwd, id)), { recursive: true });
      fs.writeFileSync(file(cwd, id), transcript(id, cwd, prompt));
    };
    put(appA, ids.own, 'Bygg en klocka');
    put(appA, ids.ownSub, 'Lägg till datum');
    // En underagents transkript ligger i <session>/subagents/ och ska följa med.
    fs.mkdirSync(path.join(projects, projectName(appA), ids.own, 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(projects, projectName(appA), ids.own, 'subagents', 'agent-1.jsonl'), '{}\n');
    put(appB, ids.other, 'Bygg en mejlklient');
    // Samma projektkatalog (namnet saneras till samma sträng) men en annan cwd: får aldrig raderas.
    fs.mkdirSync(path.dirname(file(appA, ids.lookalike)), { recursive: true });
    fs.writeFileSync(file(appA, ids.lookalike), transcript(ids.lookalike, lookalike, 'Någon annans session'));
  }

  before(() => {
    scratch = fs.realpathSync(fs.mkdtempSync(path.join(ROOT, '.scratch', 'transcripts-')));
    config = path.join(scratch, 'claude-config');
    projects = path.join(config, 'projects');
    appA = path.join(scratch, 'home', 'apps', 'aklocka');
    appB = path.join(scratch, 'home', 'apps', 'amejl01');
    lookalike = path.join(scratch, 'home', 'apps-aklocka'); // saneras till samma namn som appA, finns inte på disk
    fs.mkdirSync(appA, { recursive: true });
    fs.mkdirSync(appB, { recursive: true });
    assert.equal(projectName(lookalike), projectName(appA), 'förutsättning: kollisionen');
    process.env.CLAUDE_CONFIG_DIR = config;
  });
  beforeEach(() => plant());
  after(() => {
    if (prevConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevConfig;
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  test('SDK:n ser de planterade sessionerna (förutsättning för resten)', async () => {
    const listed = await listSessions({ dir: appA, includeWorktrees: false });
    const got = new Set(listed.map((s) => s.sessionId));
    assert.ok(got.has(ids.own) && got.has(ids.ownSub), `listSessions såg inte appens sessioner: ${[...got].join(', ')}`);
    assert.ok(got.has(ids.lookalike), 'kollisionen listas av SDK:n, så cwd-spärren behövs');
  });

  test('kalibrering: en naiv rensning (allt som listSessions ger) raderar någon annans transkript', async () => {
    for (const s of await listSessions({ dir: appA })) await deleteSession(s.sessionId, { dir: appA }).catch(() => {});
    assert.equal(fs.existsSync(file(appA, ids.lookalike)), false, 'den naiva rensningen ska fällas av kollisionen');
  });

  test('deleteTranscripts raderar appens två sessioner och underagenten, men inget annat', async () => {
    const n = await deleteTranscripts(appA);
    assert.equal(n, 2);
    assert.equal(fs.existsSync(file(appA, ids.own)), false);
    assert.equal(fs.existsSync(file(appA, ids.ownSub)), false);
    assert.equal(fs.existsSync(path.join(projects, projectName(appA), ids.own)), false, 'underagentens katalog');
    assert.equal(fs.existsSync(file(appB, ids.other)), true, 'en annan apps transkript');
    assert.equal(fs.existsSync(file(appA, ids.lookalike)), true, 'en session med en annan cwd i samma projektkatalog');
    // Andra gången finns inget kvar att radera.
    assert.equal(await deleteTranscripts(appA), 0);
  });

  test('en app utan transkript: 0 och inga fel', async () => {
    const empty = path.join(scratch, 'home', 'apps', 'atom001');
    fs.mkdirSync(empty, { recursive: true });
    assert.equal(await deleteTranscripts(empty), 0);
  });

  test('projektkatalogen: tom efter rensningen tas bort, med någon annans session kvar står den (K7)', async () => {
    // amejl01 har bara sin egen session: katalogen ska bort. aklocka delar katalog med kollisionen: den ska stå.
    assert.equal(await deleteTranscripts(appB), 1);
    assert.equal(fs.existsSync(path.join(projects, projectName(appB))), false, 'tom projektkatalog ska tas bort');
    assert.equal(await deleteTranscripts(appA), 2);
    assert.equal(fs.existsSync(file(appA, ids.lookalike)), true, 'en annan cwd:s transkript i samma katalog');
  });

  test('kalibrering: en planterad rekursiv rensning av projektkatalogen tar med sig någon annans transkript', async () => {
    await removeEmptyProjectDirs([appA], (p) => fs.promises.rm(p, { recursive: true }));
    assert.equal(fs.existsSync(file(appA, ids.lookalike)), false, 'den rekursiva rensningen ska fällas av kollisionen');
  });

  test('långa sökvägar: projectDirName stämmer med SDK:n, och en tom katalog med annan hash tas också bort', async () => {
    const long = path.join(scratch, 'home', 'x'.repeat(120), 'y'.repeat(120), 'apps', 'along01');
    fs.mkdirSync(long, { recursive: true });
    assert.equal(projectDirName(appA), projectName(appA));
    assert.ok(projectDirName(long).length > 200);
    const id = crypto.randomUUID();
    // CLI:t (Bun) kan räkna hashen annorlunda; SDK:n matchar därför kortade namn på prefixet.
    const other = `${projectDirName(long).slice(0, 200)}-0bun`;
    assert.notEqual(other, projectDirName(long), 'kalibrering: en rensning på exakt namn missar den här katalogen');
    for (const name of [projectDirName(long), other]) {
      fs.mkdirSync(path.join(projects, name), { recursive: true });
      fs.writeFileSync(path.join(projects, name, `${id}.jsonl`), transcript(id, long, 'Lång sökväg'));
      assert.equal((await listSessions({ dir: long, includeWorktrees: false })).some((s) => s.sessionId === id), true, name);
      assert.equal(await deleteTranscripts(long), 1);
      assert.equal(fs.existsSync(path.join(projects, name)), false, `tom katalog ${name.slice(-12)} ska tas bort`);
    }
  });

  test('cwd saknas i transkriptet: sessionen raderas inte', async () => {
    let calls = 0;
    const n = await deleteTranscripts(appA, {
      listSessions: async () => [{ sessionId: ids.own, summary: 'x', lastModified: 0 }],
      deleteSession: async () => {
        calls++;
      },
    });
    assert.equal(n, 0);
    assert.equal(calls, 0);
  });
});
