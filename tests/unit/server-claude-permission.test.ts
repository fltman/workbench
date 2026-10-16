// Frågekortet (CONTRACT §8.5 punkt 3): titlar, detalj, remember/canRemember/defaultNo och svaren.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
import { permissionCard, permissionResult, rememberFrom } from '../../server/claude/policy.ts';

// Inspelade förslag (spike sdk-core: M-perm-default, M-perm-confine, M11-sandbox).
const BASH_LOCAL: PermissionUpdate = { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'node -e "console.log(6*7)"' }], behavior: 'allow', destination: 'localSettings' };
const WEBFETCH_SESSION: PermissionUpdate = { type: 'addRules', rules: [{ toolName: 'WebFetch', ruleContent: 'domain:example.com' }], behavior: 'allow', destination: 'session' };
const ADD_DIRS: PermissionUpdate = { type: 'addDirectories', directories: ['/Users/x/Projekt'], destination: 'session' };
const SET_MODE: PermissionUpdate = { type: 'setMode', mode: 'acceptEdits', destination: 'session' };
const DENY_RULE: PermissionUpdate = { type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'deny', destination: 'session' };
const USER_SETTINGS: PermissionUpdate = { type: 'addRules', rules: [{ toolName: 'Read', ruleContent: '//Users/**' }], behavior: 'allow', destination: 'userSettings' };
const REPLACE: PermissionUpdate = { type: 'replaceRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'session' };

describe('remember', () => {
  test('bara addRules med allow, alltid omskrivna till session', () => {
    const r = rememberFrom([BASH_LOCAL, ADD_DIRS, SET_MODE, DENY_RULE, USER_SETTINGS, REPLACE, WEBFETCH_SESSION]);
    assert.deepEqual(r, [
      { ...BASH_LOCAL, destination: 'session' },
      { ...USER_SETTINGS, destination: 'session' },
      WEBFETCH_SESSION,
    ]);
    for (const u of r) {
      assert.equal(u.type, 'addRules');
      assert.equal(u.destination, 'session');
    }
  });
  test('inga förslag', () => {
    assert.deepEqual(rememberFrom(undefined), []);
  });
});

describe('frågekortet', () => {
  test('WebFetch', () => {
    const c = permissionCard('WebFetch', { url: 'https://nodemailer.com/about', prompt: 'x' }, { suggestions: [WEBFETCH_SESSION] });
    assert.equal(c.title, 'Hämta från nätet?');
    assert.equal(c.detail, 'https://nodemailer.com/about');
    assert.equal(c.canRemember, true);
    assert.equal(c.defaultNo, false);
  });
  test('SandboxNetworkAccess (inspelad indata { host })', () => {
    const c = permissionCard('SandboxNetworkAccess', { host: 'example.com' }, { suggestions: [WEBFETCH_SESSION] });
    assert.equal(c.title, 'Hämta från nätet?');
    assert.equal(c.detail, 'example.com');
  });
  test('Bash utan sandlåda', () => {
    const c = permissionCard('Bash', { command: 'node -e "console.log(6*7)"', description: 'x' }, { suggestions: [BASH_LOCAL] });
    assert.equal(c.title, 'Köra ett kommando?');
    assert.equal(c.detail, 'node -e "console.log(6*7)"');
    assert.deepEqual(c.remember, [{ ...BASH_LOCAL, destination: 'session' }]);
  });
  test('övriga verktyg: kort JSON', () => {
    const c = permissionCard('Write', { file_path: '.mcp.json', content: 'x'.repeat(1000) }, {});
    assert.equal(c.title, 'Använda Write?');
    assert.ok(c.detail.startsWith('{"file_path":".mcp.json"'));
    assert.ok(Array.from(c.detail).length <= 300);
    assert.equal(c.canRemember, false, 'inga förslag: inget Alltid');
  });
  test('suppressAlwaysAllowRule tar bort Alltid', () => {
    const c = permissionCard('Bash', { command: 'x' }, { suggestions: [BASH_LOCAL], suppressAlwaysAllowRule: true });
    assert.equal(c.canRemember, false);
  });
  test('bara addDirectories eller setMode: inget Alltid', () => {
    assert.equal(permissionCard('Write', { file_path: '/x' }, { suggestions: [ADD_DIRS, SET_MODE] }).canRemember, false);
  });
  test('defaultToNo blir defaultNo', () => {
    assert.equal(permissionCard('Bash', { command: 'x' }, { defaultToNo: true }).defaultNo, true);
  });
});

describe('svaren', () => {
  const input = { url: 'https://example.com' };
  const card = permissionCard('WebFetch', input, { suggestions: [WEBFETCH_SESSION, ADD_DIRS] });
  test('allow', () => {
    assert.deepEqual(permissionResult('allow', input, card), { behavior: 'allow', updatedInput: input });
  });
  test('allow-always ger bara reglerna med destination session', () => {
    assert.deepEqual(permissionResult('allow-always', input, card), { behavior: 'allow', updatedInput: input, updatedPermissions: [WEBFETCH_SESSION] });
  });
  test('allow-always utan canRemember blir allow', () => {
    assert.deepEqual(permissionResult('allow-always', input, { remember: [WEBFETCH_SESSION], canRemember: false }), { behavior: 'allow', updatedInput: input });
  });
  test('deny', () => {
    assert.deepEqual(permissionResult('deny', input, card), { behavior: 'deny', message: 'The user said no.' });
  });
  test('timeout och cancelled nekar', () => {
    assert.equal(permissionResult('timeout', input, card).behavior, 'deny');
    assert.equal(permissionResult('cancelled', input, card).behavior, 'deny');
  });
});
