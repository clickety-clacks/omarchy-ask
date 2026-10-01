const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const platform = vm.createContext({});
vm.runInContext(readFileSync(join(__dirname, '../ShortcutPlatform.js'), 'utf8').replace(/^\.pragma library\s*/, ''), platform);

test('Quickshell connection wins over a stale environment instance', () => {
  assert.equal(platform.instance('/run/user/1000/hypr/current_123/.socket.sock', 'stale_456'), 'current_123');
  assert.equal(platform.instance('/tmp/hypr/current_123/.socket.sock', ''), 'current_123');
});
test('explicit environment is a fallback, never a guessed desktop index', () => {
  assert.equal(platform.instance('', 'explicit_123'), 'explicit_123');
  for (const invalid of ['', '0', '../other', 'contains space'])
    assert.equal(platform.instance('', invalid), '');
});
