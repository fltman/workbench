// Options till Agent SDK:n (CONTRACT §8.2). Miljön är en vitlista: inga CLAUDE_CODE_*, inga API-nycklar.
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import fs from 'node:fs';
import { buildOptions, claudeEnv, NETWORK_DOMAINS, nodePrefixUnderHome, secretDenyRules, TOOLS } from '../../server/claude/options.ts';
import { testConfig } from './server-claude-kit.ts';

const config = testConfig(path.join(os.tmpdir(), 'wb-opts-home'), { model: 'claude-opus-5-5', effort: 'high' });
const APP = '/Users/x/Projekt/workbench/apps/aapp001';
const canUseTool = async () => ({ behavior: 'deny' as const, message: 'x' });
const stderr = () => {};

function opts(sandbox: boolean, resume?: string) {
  return buildOptions({ config, appReal: APP, appsDir: '/Users/x/Projekt/workbench/apps', sandbox, appRules: 'REGLER', tools: [], canUseTool, resume, stderr });
}

describe('miljön', () => {
  test('hemligheter och föräldrasessionens variabler följer aldrig med (planterade i process.env)', () => {
    const planted: Record<string, string> = {
      OPENAI_API_KEY: 'sk-planterad', ANTHROPIC_API_KEY: 'sk-ant-planterad', CLAUDECODE: 'planterad-cc', CLAUDE_CODE_MESSAGING_TOKEN: 'planterad-tok',
      CLAUDE_CODE_ENTRYPOINT: 'planterad-cli', WORKBENCH_SECRET: 'planterad-wb', AWS_SECRET_ACCESS_KEY: 'planterad-aws',
    };
    const saved = Object.fromEntries(Object.keys(planted).map((k) => [k, process.env[k]]));
    Object.assign(process.env, planted);
    try {
      // Kalibrering: en kopia av process.env (det gamla receptet) skulle läcka dem.
      const naive = { ...process.env };
      for (const k of Object.keys(planted)) assert.equal(naive[k], planted[k], `kalibrering ${k}`);
      const env = claudeEnv(APP, '/apps');
      for (const k of Object.keys(planted)) assert.equal(env[k], undefined, k);
      for (const [k, v] of Object.entries(env)) {
        assert.ok(!k.startsWith('CLAUDE_CODE_') || k === 'CLAUDE_CODE_DISABLE_AUTO_MEMORY', k);
        assert.ok(!Object.values(planted).includes(v), k);
      }
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  test('isoleringsväxlarna och npm', () => {
    const env = claudeEnv(APP, '/home/apps');
    assert.equal(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1');
    assert.equal(env.ENABLE_CLAUDEAI_MCP_SERVERS, 'false');
    assert.equal(env.CLAUDE_AGENT_SDK_CLIENT_APP, 'workbench/0.1');
    assert.equal(env.GIT_CEILING_DIRECTORIES, '/home/apps');
    assert.equal(env.npm_config_cache, `${APP}/node_modules/.cache/npm`);
    assert.equal(env.npm_config_update_notifier, 'false');
    assert.equal(env.PATH, process.env.PATH);
  });
});

describe('options enligt §8.2', () => {
  test('med sandlåda', () => {
    const o = opts(true, 'sess-1');
    assert.equal(o.cwd, APP);
    assert.deepEqual(o.settingSources, []);
    assert.equal(o.strictMcpConfig, true);
    assert.deepEqual(o.settings, {
      crossSessionInbound: 'refuse', disableAllHooks: true,
      permissions: { deny: [`Read(/${APP}/data/secrets.json)`, `Edit(/${APP}/data/secrets.json)`] },
    });
    assert.deepEqual(o.tools, ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'AskUserQuestion', 'TodoWrite']);
    assert.deepEqual(o.tools, TOOLS);
    assert.deepEqual(Object.keys(o.mcpServers ?? {}), ['workbench']);
    const ws = (o.mcpServers ?? {}).workbench as { type: string; name: string };
    assert.equal(ws.type, 'sdk');
    assert.equal(ws.name, 'workbench');
    assert.deepEqual(o.allowedTools, ['mcp__workbench__*', 'WebSearch']);
    assert.deepEqual(o.sandbox?.network, { allowedDomains: NETWORK_DOMAINS });
    assert.deepEqual(NETWORK_DOMAINS, ['registry.npmjs.org', 'esm.sh', 'cdn.jsdelivr.net']);
    assert.equal(o.sandbox?.enabled, true);
    assert.equal(o.sandbox?.failIfUnavailable, true);
    assert.equal(o.sandbox?.autoAllowBashIfSandboxed, true);
    assert.equal(o.sandbox?.allowUnsandboxedCommands, false);
    assert.deepEqual(o.sandbox?.filesystem?.allowWrite, [APP]);
    assert.deepEqual(o.sandbox?.filesystem?.denyWrite, [`${APP}/.claude`, `${APP}/data/secrets.json`]);
    assert.equal(o.sandbox?.filesystem?.denyRead?.[0], os.homedir());
    assert.equal(o.sandbox?.filesystem?.allowRead?.[0], APP);
    assert.deepEqual(o.systemPrompt, { type: 'preset', preset: 'claude_code', append: 'REGLER' });
    assert.equal(o.permissionMode, 'acceptEdits');
    assert.equal(o.includePartialMessages, true);
    assert.equal(o.model, 'claude-opus-5-5');
    assert.equal(o.effort, 'high');
    assert.equal(o.canUseTool, canUseTool);
    assert.equal(o.resume, 'sess-1');
    assert.equal(o.stderr, stderr);
  });

  test('utan sandlåda: npm install tillåts, inget sandbox-block', () => {
    const o = opts(false);
    assert.equal(o.sandbox, undefined);
    assert.deepEqual(o.allowedTools, ['mcp__workbench__*', 'WebSearch', 'Bash(npm install:*)', 'Bash(npm i:*)', 'Bash(npm ci:*)']);
    assert.equal('resume' in o, false);
  });

  test('hemligheterna (SEC-2): deny-regler för Read och Edit, sandlådans credentials-spärr och denyRead', () => {
    const o = opts(true);
    // Absolut sökväg i Claude Codes regelsyntax: två snedstreck först.
    assert.deepEqual(secretDenyRules(APP), ['Read(//Users/x/Projekt/workbench/apps/aapp001/data/secrets.json)', 'Edit(//Users/x/Projekt/workbench/apps/aapp001/data/secrets.json)']);
    assert.deepEqual(o.sandbox?.credentials, { files: [{ path: `${APP}/data/secrets.json`, mode: 'deny' }] });
    assert.ok(o.sandbox?.filesystem?.denyRead?.includes(`${APP}/data/secrets.json`));
    // Även utan sandlåda gäller deny-reglerna för Claudes egna verktyg.
    assert.deepEqual((opts(false).settings as { permissions?: unknown }).permissions, { deny: secretDenyRules(APP) });
  });

  test('egen TMPDIR i appens data/ och den delade TMPDIR:en stängd (SEC-3)', () => {
    const o = opts(true);
    assert.equal(claudeEnv(APP, '/apps').TMPDIR, `${APP}/data/tmp`);
    assert.equal(o.env?.TMPDIR, `${APP}/data/tmp`);
    // Kalibrering: den delade TMPDIR:en är inte appens, så en regel som släpper den skulle synas här.
    const shared = fs.realpathSync.native(os.tmpdir());
    assert.notEqual(shared, `${APP}/data/tmp`);
    assert.ok(!o.sandbox?.filesystem?.allowWrite?.some((p) => p === os.tmpdir() || p === shared), 'den delade TMPDIR:en får inte vara skrivbar');
    assert.ok(o.sandbox?.filesystem?.denyRead?.includes(shared), 'den delade TMPDIR:en ska nekas läsning');
  });

  test('WORKBENCH_HOME utanför hemkatalogen nekas också läsning', () => {
    const o = opts(true);
    assert.ok(o.sandbox?.filesystem?.denyRead?.includes(config.home));
  });

  test('Nodes prefix under hemkatalogen får läsas', () => {
    assert.equal(nodePrefixUnderHome('/Users/x/.nvm/versions/node/v25/bin/node', '/Users/x'), '/Users/x/.nvm/versions/node/v25');
    assert.equal(nodePrefixUnderHome('/opt/homebrew/Cellar/node/25.9.0_1/bin/node', '/Users/x'), undefined);
  });

  test('en ny MCP-server per process', () => {
    const a = opts(true).mcpServers?.workbench as { instance: unknown };
    const b = opts(true).mcpServers?.workbench as { instance: unknown };
    assert.notEqual(a.instance, b.instance);
  });
});
