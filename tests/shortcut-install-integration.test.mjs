import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('real header preflight refuses an ABI mismatch without calling plugin load',
  {skip: process.env.ASK_TEST_NATIVE_BUILD !== '1'}, () => {
    const temporary = mkdtempSync(join(tmpdir(), 'ask-install-test-'));
    try {
      const bin = join(temporary, 'bin');
      const log = join(temporary, 'calls.jsonl');
      const cache = join(temporary, 'cache');
      mkdirSync(bin);
      writeFileSync(join(bin, 'hyprctl'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (args[2] === 'plugin' && args[3] === 'list') console.log('[]');
else if (args[2] === 'version') console.log(JSON.stringify({
  commit: 'efb50993780079460b0cbed1363e2166a2de1d9f', version: '0.56.2', dirty: false,
  abiHash: 'deliberately_mismatched_test_abi'
}));
else process.exit(97);
`, {mode: 0o700});
      const result = spawnSync(process.execPath,
        [new URL('../hyprland/manage.mjs', import.meta.url).pathname, 'load',
          '--instance', 'isolated_test_instance', '--cache-dir', cache],
        {env: {...process.env, PATH: `${bin}:${process.env.PATH}`}, encoding: 'utf8', timeout: 120_000});
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /Installed Hyprland headers do not match/);
      const calls = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      assert(!calls.some(args => args[2] === 'plugin' && args[3] === 'load'), calls);
      assert.deepEqual(readdirSync(cache), [], 'failed builds must not publish an artifact or leave their temporary directory');
    } finally {
      rmSync(temporary, {recursive: true, force: true});
    }
  });
