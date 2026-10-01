#!/usr/bin/env node
// Explicit installation tool. No user config edits, package installs, guessed
// compositor selection, or replacement of an unrelated loaded module.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceDir = dirname(fileURLToPath(import.meta.url));
const supportedCommit = 'efb50993780079460b0cbed1363e2166a2de1d9f';

export function parseArgs(argv, env = process.env) {
  const action = argv[0] || 'status';
  if (!['status', 'build', 'load', 'unload'].includes(action)) throw new Error('Expected status, build, load, or unload.');
  const result = { action, instance: env.HYPRLAND_INSTANCE_SIGNATURE || '',
    cache: join(env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'clickety-clacks.ask', 'shortcuts') };
  for (let i = 1; i < argv.length; i += 2) {
    if (!['--instance', '--cache-dir', '--module'].includes(argv[i]) || !argv[i + 1])
      throw new Error('Expected --instance INSTANCE, --cache-dir PATH, or --module PATH.');
    result[argv[i] === '--instance' ? 'instance' : argv[i] === '--cache-dir' ? 'cache' : 'module'] = argv[i + 1];
  }
  if (!/^[a-zA-Z0-9_.-]+$/.test(result.instance) || /^\d+$/.test(result.instance))
    throw new Error('An exact Hyprland instance is required; use --instance or HYPRLAND_INSTANCE_SIGNATURE.');
  result.cache = resolve(result.cache);
  if (action === 'unload' && !result.module) throw new Error('Unloading requires the exact --module path returned by build/load.');
  return result;
}

export function checkVersion(version) {
  if (version.commit !== supportedCommit || version.dirty)
    throw new Error(`This Ask shortcut module has not been verified for Hyprland ${version.version || 'unknown'}. Update Ask before loading it.`);
  if (!/^[a-zA-Z0-9_.-]+$/.test(version.abiHash || '')) throw new Error('Hyprland did not report a usable ABI identifier.');
  return version.abiHash;
}

export function checkHeadersAbi(headersAbi, runningAbi) {
  if (headersAbi !== runningAbi)
    throw new Error('Installed Hyprland headers do not match the running compositor. No module was loaded. Restart into the installed Hyprland version or install matching headers.');
}

export function previousArtifact(info, abi, cache) {
  if (info?.protocol !== 1 || info.abi !== abi || !/^[a-f0-9]{24}$/.test(info.build || ''))
    throw new Error('An unrecognized Ask shortcut module is already loaded. It was left running.');
  return join(cache, `${abi}-${info.build}.so`);
}

function execute(binary, args, tolerateFailure = false) {
  const result = spawnSync(binary, args, { encoding: 'utf8', timeout: 120_000, maxBuffer: 2 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    if (tolerateFailure) return null;
    throw new Error(`${binary} failed: ${result.error?.message || result.stderr?.trim() || result.stdout?.trim() || result.status}`);
  }
  return result.stdout.trim();
}

export function main(argv) {
  const options = parseArgs(argv);
  const hypr = (...args) => execute('hyprctl', ['-i', options.instance, ...args]);
  const loaded = JSON.parse(hypr('plugin', 'list', '-j')).filter(plugin => plugin.name === 'ask-shortcut-scope');
  const rawInfo = loaded.length ? execute('hyprctl', ['-i', options.instance, 'askshortcuts', 'info'], true) : null;
  const info = rawInfo?.startsWith('{') ? JSON.parse(rawInfo) : null;
  if (options.action === 'status') return { loaded: loaded.length > 0, compatibleProtocol: info?.protocol === 1, info };
  if (options.action === 'unload') {
    const path = resolve(options.module);
    if (dirname(path) !== options.cache || !/^[a-zA-Z0-9_.-]+\.so$/.test(path.slice(options.cache.length + 1)))
      throw new Error('Refusing to unload a module outside this Ask cache directory.');
    if (loaded.length && hypr('plugin', 'unload', path) !== 'ok') throw new Error('Hyprland did not confirm module unload.');
    return { loaded: false, module: path, retained: true };
  }
  const abi = checkVersion(JSON.parse(hypr('version', '-j')));
  const hash = createHash('sha256');
  for (const name of ['shortcut-scope.cpp', 'abi-probe.cpp', 'Makefile']) hash.update(readFileSync(join(sourceDir, name)));
  const build = hash.digest('hex').slice(0, 24);
  const module = join(options.cache, `${abi}-${build}.so`);
  let previous = null;
  if (options.action === 'load' && loaded.length) {
    if (info?.protocol === 1 && info.abi === abi && info.build === build)
      return { loaded: true, unchanged: true, abi, build, artifact: module };
    previous = previousArtifact(info, abi, options.cache);
    if (loaded.length !== 1 || !existsSync(previous) || !lstatSync(previous).isFile())
      throw new Error('The loaded Ask shortcut module is not an artifact in this cache. It was left running.');
  }
  mkdirSync(options.cache, { recursive: true, mode: 0o700 });
  if (!existsSync(module)) {
    const temporary = mkdtempSync(join(options.cache, '.build-'));
    try {
      const args = ['-C', sourceDir, `ASK_BUILD_DIR=${temporary}`, `ASK_SCOPE_BUILD_ID=${build}`];
      execute('make', [...args, 'abi']);
      const headersAbi = execute(join(temporary, 'abi-probe'), []);
      checkHeadersAbi(headersAbi, abi);
      execute('make', [...args, 'all']);
      // Publish an immutable artifact; never overwrite a loaded shared object.
      renameSync(join(temporary, 'ask-shortcut-scope.so'), module);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }
  if (options.action === 'load') {
    if (previous) {
      const current = JSON.parse(hypr('askshortcuts', 'info'));
      if (current.protocol !== info.protocol || current.abi !== info.abi || current.build !== info.build)
        throw new Error('The loaded Ask module changed during setup. It was left running; retry opening Ask.');
      // Build and validate first. Hyprland only unloads the exact loaded path;
      // an equally named artifact in another cache is not ours to replace.
      if (hypr('plugin', 'unload', previous) !== 'ok')
        throw new Error('Hyprland did not confirm the previous Ask module path. It was left running.');
    }
    try {
      if (hypr('plugin', 'load', module) !== 'ok') throw new Error('Hyprland did not confirm module load.');
      const actual = JSON.parse(hypr('askshortcuts', 'info'));
      if (actual.protocol !== 1 || actual.abi !== abi || actual.build !== build)
        throw new Error('Loaded module identity did not match the built artifact.');
    } catch (error) {
      if (previous) {
        execute('hyprctl', ['-i', options.instance, 'plugin', 'unload', module], true);
        const restored = execute('hyprctl', ['-i', options.instance, 'plugin', 'load', previous], true);
        throw new Error(`${error.message} Previous shortcut support ${restored === 'ok' ? 'was restored' : 'could not be restored'}.`);
      }
      throw error;
    }
  }
  return { loaded: options.action === 'load', abi, build, module };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(JSON.stringify(main(process.argv.slice(2))) + '\n'); }
  catch (error) { process.stderr.write(`Ask shortcuts: ${error.message}\n`); process.exitCode = 1; }
}
