// Etiketterna i HUD:ens aktivitetsrad (CONTRACT §8.3): svenska, högst 60 tecken, sökvägar relativa appens mapp.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { bashLabel, LABEL_MAX, toolLabel } from '../../server/claude/labels.ts';

const APP = '/Users/x/Projekt/workbench/apps/aapp001';
const L = (name: string, input: Record<string, unknown>) => toolLabel(name, input, APP);

describe('etiketter enligt tabellen i §8.3', () => {
  test('filverktygen visar sökvägen relativt appens mapp', () => {
    assert.equal(L('Write', { file_path: `${APP}/index.html` }), 'Skriver index.html');
    assert.equal(L('Edit', { file_path: `${APP}/server.mjs` }), 'Ändrar server.mjs');
    assert.equal(L('Read', { file_path: `${APP}/app.json` }), 'Läser app.json');
    assert.equal(L('Write', { file_path: 'sub/a.css' }), 'Skriver sub/a.css');
    assert.equal(L('NotebookEdit', { notebook_path: `${APP}/n.ipynb` }), 'Ändrar n.ipynb');
  });

  test('Glob och Grep', () => {
    assert.equal(L('Glob', { pattern: '**/*.js' }), 'Letar i koden');
    assert.equal(L('Grep', { pattern: 'x' }), 'Letar i koden');
  });

  test('npm install med och utan paket', () => {
    assert.equal(L('Bash', { command: 'npm install imapflow nodemailer' }), 'Installerar imapflow, nodemailer');
    assert.equal(L('Bash', { command: 'npm i -D imapflow@1.0.0 @scope/x@2' }), 'Installerar imapflow, @scope/x');
    assert.equal(L('Bash', { command: 'npm install' }), 'Installerar beroenden');
    assert.equal(L('Bash', { command: 'npm ci' }), 'Installerar beroenden');
    assert.equal(L('Bash', { command: 'cd sub && npm install --no-audit' }), 'Installerar beroenden');
  });

  test('omdirigeringar är inga paket (sett i ett riktigt bygge: "Installerar imapflow, nodemailer, mailparser, 2>&1")', () => {
    assert.equal(L('Bash', { command: 'npm install imapflow nodemailer mailparser 2>&1 | tail -3' }), 'Installerar imapflow, nodemailer, mailparser');
    assert.equal(L('Bash', { command: 'npm i qrcode > /dev/null 2>&1' }), 'Installerar qrcode');
    assert.equal(L('Bash', { command: 'npm install 2>&1' }), 'Installerar beroenden');
    assert.equal(L('Bash', { command: 'npm install --no-audit &> npm.log' }), 'Installerar beroenden');
    assert.equal(L('Bash', { command: 'npm install marked >>install.log' }), 'Installerar marked');
  });

  test('node och övrig Bash', () => {
    assert.equal(L('Bash', { command: 'node server.mjs' }), 'Kör node');
    assert.equal(L('Bash', { command: '/opt/homebrew/bin/node -e "1"' }), 'Kör node');
    assert.equal(L('Bash', { command: 'ls -la' }), 'Kör ls');
    assert.equal(L('Bash', { command: 'FOO=1 curl -s https://x' }), 'Kör curl');
    assert.equal(bashLabel(''), 'Kör ett kommando');
  });

  test('webben', () => {
    assert.equal(L('WebSearch', { query: 'imapflow idle' }), 'Söker: imapflow idle');
    assert.equal(L('WebFetch', { url: 'https://nodemailer.com/about/' }), 'Läser nodemailer.com');
    assert.equal(L('WebFetch', { url: 'inte en adress' }), 'Läser en webbsida');
  });

  test('workbench-verktygen', () => {
    assert.equal(L('mcp__workbench__screenshot_app', {}), 'Tittar på appen');
    assert.equal(L('mcp__workbench__get_app_logs', { lines: 10 }), 'Läser loggarna');
    assert.equal(L('mcp__workbench__reload_app', {}), 'Startar om appen');
    assert.equal(L('mcp__workbench__call_backend', { method: 'GET', path: '/api/x' }), 'Testar /api/x');
    assert.equal(L('mcp__workbench__request_secret', { key: 'imap_password', label: 'Lösenord för mejlkontot' }), 'Ber om Lösenord för mejlkontot');
  });

  test('övriga verktyg', () => {
    assert.equal(L('AskUserQuestion', {}), 'Ställer en fråga');
    assert.equal(L('Okänt', {}), 'Använder Okänt');
  });
});

describe('längd', () => {
  test('högst 60 tecken, långa sökvägar kortas från vänster så att filnamnet syns', () => {
    const long = `${APP}/${'mapp/'.repeat(20)}sista-filen.html`;
    const l = L('Write', { file_path: long });
    assert.ok(Array.from(l).length <= LABEL_MAX, l);
    assert.ok(l.startsWith('Skriver …'));
    assert.ok(l.endsWith('sista-filen.html'));
  });
  test('lång fri text kortas i slutet', () => {
    const l = L('WebSearch', { query: 'åäö '.repeat(40) });
    assert.equal(Array.from(l).length, LABEL_MAX);
    assert.ok(l.endsWith('…'));
    assert.ok(l.startsWith('Söker: åäö'));
  });
  test('många paket', () => {
    const l = L('Bash', { command: `npm install ${Array.from({ length: 30 }, (_, i) => `paket${i}`).join(' ')}` });
    assert.ok(Array.from(l).length <= LABEL_MAX);
    assert.ok(l.startsWith('Installerar paket0, paket1'));
  });
  test('inga etiketter blir längre än 60 tecken', () => {
    const big = 'x'.repeat(500);
    for (const [n, i] of [
      ['Bash', { command: big }],
      ['Read', { file_path: big }],
      ['WebFetch', { url: `https://${big}.se/` }],
      ['mcp__workbench__call_backend', { path: `/api/${big}` }],
      ['mcp__workbench__request_secret', { label: big }],
      [big, {}],
    ] as const) {
      assert.ok(Array.from(L(n, i)).length <= LABEL_MAX, n.slice(0, 20));
    }
  });
});
