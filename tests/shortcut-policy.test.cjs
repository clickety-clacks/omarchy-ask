const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

// Execute the actual QML JS library, not a second implementation of its rules.
const policy = vm.createContext({});
vm.runInContext(readFileSync(join(__dirname, '../ShortcutPolicy.js'), 'utf8')
  .replace(/^\.pragma library\s*/, ''), policy);
const claims = state => new Set(policy.conversation(state).split(' '));

test('pinned Escape stays native except when dismissing a composer selection', () => {
  assert(!claims({ composer: true }).has('0:Escape'));
  assert(claims({ overlay: true }).has('0:Escape'));
  assert(claims({ composer: true, menuSelected: true }).has('0:Escape'));
  assert(!claims({ menuSelected: true }).has('0:Escape'));
});

test('file browser does not reserve disabled horizontal scrolling shortcuts', () => {
  for (const chord of ['4:h', '4:l', '0:Left', '0:Right']) {
    assert(claims({}).has(chord), chord);
    assert(!claims({ files: true }).has(chord), chord);
  }
  for (const chord of ['4:j', '4:k', '4:u', '4:d', '0:Up', '0:Down'])
    assert(claims({ files: true }).has(chord), chord);
});

test('row shortcuts and tab navigation are scoped to results', () => {
  for (const chord of ['4:1', '4:9', '0:Tab', '1:ISO_Left_Tab']) {
    assert(!claims({}).has(chord), chord);
    assert(claims({ menu: true }).has(chord), chord);
    assert(claims({ files: true }).has(chord), chord);
  }
});

test('composer-only actions and search-mode Backspace release outside their context', () => {
  for (const chord of ['4:w', '4:e', '0:Return', '4:Return', '0:KP_Enter']) {
    assert(claims({ composer: true }).has(chord), chord);
    assert(!claims({}).has(chord), chord);
  }
  assert(!claims({ composer: true, searchMode: true }).has('0:BackSpace'));
  assert(claims({ composer: true, searchMode: true, emptyPrompt: true }).has('0:BackSpace'));
  assert(!claims({ searchMode: true, emptyPrompt: true }).has('0:BackSpace'));
  assert(!claims({ composer: true }).has('1:Return'));
  assert(claims({ composer: true, searchMode: true }).has('1:Return'));
  assert(claims({ files: true }).has('1:Return'));
});

test('permission letters belong to Ask only during a permission request', () => {
  for (const chord of ['0:y', '0:n']) {
    assert(claims({ permission: true }).has(chord));
    assert(!claims({}).has(chord));
  }
});

test('no desktop keymap or wildcard modifiers are claimed in any context', () => {
  const fields = ['menu', 'files', 'composer', 'permission', 'searchMode', 'emptyPrompt', 'overlay', 'menuSelected'];
  for (let mask = 0; mask < 1 << fields.length; mask++) {
    const state = Object.fromEntries(fields.map((field, i) => [field, !!(mask & (1 << i))]));
    const keys = claims(state);
    assert.equal(keys.size, policy.conversation(state).split(' ').length, 'duplicate declaration');
    for (const chord of ['0:F5', '64:h', '64:F12', '12:h', '64:comma', '65:comma', '68:comma'])
      assert(!keys.has(chord), chord);
  }
  assert.equal(policy.settings(), '0:Escape 4:comma');
});
