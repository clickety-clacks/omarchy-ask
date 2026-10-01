import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const source = new URL('../hyprland/', import.meta.url);
const hash = createHash('sha256');
for (const file of ['shortcut-scope.cpp', 'abi-probe.cpp', 'Makefile']) hash.update(readFileSync(new URL(file, source)));
const build = hash.digest('hex').slice(0, 24);
const oldBuild = '0123456789abcdef01234567';

for (const scenario of ['replace', 'load-fails', 'build-fails', 'foreign-path', 'unknown-build', 'unchanged']) {
  test(`managed upgrade: ${scenario}`, () => {
    const temporary = mkdtempSync(join(tmpdir(), 'ask-upgrade-test-'));
    try {
      const bin = join(temporary, 'bin');
      const cache = join(temporary, 'cache');
      const statePath = join(temporary, 'state.json');
      const log = join(temporary, 'calls.jsonl');
      mkdirSync(bin); mkdirSync(cache);
      const old = join(cache, `test_abi-${oldBuild}.so`);
      const next = join(cache, `test_abi-${build}.so`);
      writeFileSync(old, 'test artifact');
      if (scenario !== 'build-fails') writeFileSync(next, 'test artifact');
      writeFileSync(statePath, JSON.stringify({
        build: scenario === 'unknown-build' ? 'development' : scenario === 'unchanged' ? build : oldBuild,
        path: scenario === 'foreign-path' ? '/another/cache/module.so' : scenario === 'unchanged' ? next : old
      }));
      writeFileSync(join(bin, 'hyprctl'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const statePath = ${JSON.stringify(statePath)};
let state = JSON.parse(fs.readFileSync(statePath));
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (args[2] === 'version') console.log(JSON.stringify({commit:'efb50993780079460b0cbed1363e2166a2de1d9f',version:'0.56.2',abiHash:'test_abi'}));
else if (args[2] === 'askshortcuts') console.log(JSON.stringify({protocol:1,abi:'test_abi',build:state.build}));
else if (args[3] === 'list') console.log(JSON.stringify(state.path ? [{name:'ask-shortcut-scope'}] : []));
else if (args[3] === 'unload') {
  if (args[4] !== state.path) console.log('error: not loaded');
  else { state = {}; console.log('ok'); }
} else if (args[3] === 'load') {
  if (${JSON.stringify(scenario)} === 'load-fails' && args[4] === ${JSON.stringify(next)}) console.log('error: test failure');
  else { state = {path: args[4], build: args[4] === ${JSON.stringify(next)} ? ${JSON.stringify(build)} : ${JSON.stringify(oldBuild)}}; console.log('ok'); }
} else process.exit(97);
fs.writeFileSync(statePath, JSON.stringify(state));
`, {mode: 0o700});
      writeFileSync(join(bin, 'make'), `#!${process.execPath}\nprocess.exit(96);\n`, {mode: 0o700});
      const result = spawnSync(process.execPath, [new URL('manage.mjs', source).pathname, 'load',
        '--instance', 'isolated_test_instance', '--cache-dir', cache],
      {env: {...process.env, PATH: `${bin}:${process.env.PATH}`}, encoding:'utf8', timeout:10000});
      const state = JSON.parse(readFileSync(statePath, 'utf8'));
      const calls = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
      assert(calls.every(args => args[0] === '-i' && args[1] === 'isolated_test_instance'));
      if (scenario === 'replace' || scenario === 'unchanged') {
        assert.equal(result.status, 0, result.stderr);
        assert.equal(state.build, build);
        if (scenario === 'unchanged') assert.equal(JSON.parse(result.stdout).unchanged, true);
      } else {
        assert.equal(result.status, 1, result.stderr);
        assert.equal(state.build, scenario === 'unknown-build' ? 'development' : oldBuild);
        if (scenario === 'load-fails') assert.match(result.stderr, /was restored/);
      }
      if (['build-fails', 'unknown-build', 'unchanged'].includes(scenario))
        assert(!calls.some(args => args[3] === 'unload' || args[3] === 'load'), calls);
      if (scenario === 'foreign-path') assert(!calls.some(args => args[3] === 'load'), calls);
    } finally { rmSync(temporary, {recursive: true, force: true}); }
  });
}
