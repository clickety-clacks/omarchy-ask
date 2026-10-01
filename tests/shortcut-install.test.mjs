import assert from 'node:assert/strict';
import test from 'node:test';
import { parseArgs, checkVersion, checkHeadersAbi, previousArtifact } from '../hyprland/manage.mjs';

test('installation never guesses a compositor or accepts positional indexes', () => {
  assert.throws(() => parseArgs(['load'], {}), /exact Hyprland instance/);
  assert.throws(() => parseArgs(['load', '--instance', '0'], {}), /exact Hyprland instance/);
  assert.throws(() => parseArgs(['load', '--instance', '../socket'], {}), /exact Hyprland instance/);
  assert.equal(parseArgs(['load', '--instance', 'test_123'], {}).instance, 'test_123');
  assert.equal(parseArgs([], {HYPRLAND_INSTANCE_SIGNATURE: 'test_123'}).action, 'status');
});

test('unload needs an explicit module and unsupported actions/flags fail', () => {
  assert.throws(() => parseArgs(['unload', '--instance', 'test_123'], {}), /exact --module/);
  assert.throws(() => parseArgs(['reset'], {}), /Expected status/);
  assert.throws(() => parseArgs(['build', '--force', 'yes'], {}), /Expected --instance/);
});

test('private compositor hooks are gated to the tested clean source and an ABI', () => {
  const version = {commit: 'efb50993780079460b0cbed1363e2166a2de1d9f', version: '0.56.2', dirty: false, abiHash: 'test_abi'};
  assert.equal(checkVersion(version), 'test_abi');
  assert.throws(() => checkVersion({...version, dirty: true}), /not been verified/);
  assert.throws(() => checkVersion({...version, commit: 'future'}), /not been verified/);
  assert.throws(() => checkVersion({...version, abiHash: '../bad'}), /usable ABI/);
});

test('mismatched installed headers fail before a module can be loaded', () => {
  assert.doesNotThrow(() => checkHeadersAbi('same_abi', 'same_abi'));
  assert.throws(() => checkHeadersAbi('new_headers', 'old_running_compositor'), /No module was loaded/);
});

test('updates only identify ABI-compatible source-hashed artifacts in the selected cache', () => {
  const info = {protocol: 1, abi: 'test_abi', build: '0123456789abcdef01234567'};
  assert.equal(previousArtifact(info, 'test_abi', '/test/cache'), '/test/cache/test_abi-0123456789abcdef01234567.so');
  for (const changed of [{protocol: 2}, {abi: 'other'}, {build: '../../outside'}, {build: 'development'}])
    assert.throws(() => previousArtifact({...info, ...changed}, 'test_abi', '/test/cache'), /left running/);
});
