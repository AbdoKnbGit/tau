import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isLinuxArm64Musl,
  isUsableRipgrepCommand,
  getRipgrepVersion,
  resolveWindowsSystemExecutable,
} from '../scripts/platform-support.mjs';
import { RG_VERSION, resolveRipgrepRelease } from '../scripts/postinstall.mjs';

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test('Windows System32 tools follow SystemRoot instead of assuming drive C', () => {
  const expected = 'D:\\Windows\\System32\\tar.exe';
  const result = resolveWindowsSystemExecutable('tar.exe', {
    env: { SystemRoot: 'D:\\Windows' },
    fileExists: path => path === expected,
  });
  assert.equal(result, expected);
});

test('Windows System32 resolution fails closed for missing or unsafe roots', () => {
  assert.equal(
    resolveWindowsSystemExecutable('tar.exe', {
      env: { SystemRoot: 'relative\\Windows', WINDIR: 'E:\\Windows\nother' },
      fileExists: () => true,
    }),
    null,
  );
  assert.equal(
    resolveWindowsSystemExecutable('..\\taskkill.exe', {
      env: { SystemRoot: 'D:\\Windows' },
      fileExists: () => true,
    }),
    null,
  );
});

test('Linux ARM64 musl detection is narrow and treats unknown reports safely', () => {
  assert.equal(
    isLinuxArm64Musl({
      platform: 'linux',
      arch: 'arm64',
      getReport: () => ({ header: {} }),
    }),
    true,
  );
  assert.equal(
    isLinuxArm64Musl({
      platform: 'linux',
      arch: 'arm64',
      getReport: () => ({ header: { glibcVersionRuntime: '2.39' } }),
    }),
    false,
  );
  assert.equal(
    isLinuxArm64Musl({
      platform: 'linux',
      arch: 'x64',
      getReport: () => ({ header: {} }),
    }),
    false,
  );
  assert.equal(
    isLinuxArm64Musl({
      platform: 'linux',
      arch: 'arm64',
      getReport: () => {
        throw new Error('report unavailable');
      },
    }),
    false,
  );
});

test('all supported platforms use pinned ripgrep, including native ARM64 musl', () => {
  const targets = [
    ['win32', 'x64', 'x86_64-pc-windows-msvc'],
    ['win32', 'arm64', 'aarch64-pc-windows-msvc'],
    ['darwin', 'x64', 'x86_64-apple-darwin'],
    ['darwin', 'arm64', 'aarch64-apple-darwin'],
    ['linux', 'x64', 'x86_64-unknown-linux-musl'],
    ['linux', 'arm64', 'aarch64-unknown-linux-gnu'],
  ];
  for (const [platform, arch, target] of targets) {
    const release = resolveRipgrepRelease({ platform, arch, getReport: () => ({ header: { glibcVersionRuntime: '2.39' } }) });
    assert.equal(release.version, RG_VERSION);
    assert.equal(release.target, target);
    assert.match(release.sha256, /^[a-f0-9]{64}$/);
  }
  assert.equal(
    resolveRipgrepRelease({ platform: 'linux', arch: 'arm64', getReport: () => ({ header: {} }) }).target,
    'aarch64-unknown-linux-musl',
  );
  assert.equal(resolveRipgrepRelease({ platform: 'freebsd', arch: 'x64' }), null);
});

test('ripgrep probes require a real ripgrep version response', () => {
  const calls = [];
  assert.equal(
    isUsableRipgrepCommand('rg', {
      spawnSyncImpl: (command, args, options) => {
        calls.push({ command, args, options });
        return { status: 0, stdout: 'ripgrep 15.1.0\n' };
      },
    }),
    true,
  );
  assert.equal(calls[0].command, 'rg');
  assert.deepEqual(calls[0].args, ['--version']);
  assert.equal(calls[0].options.timeout, 5000);

  assert.equal(
    isUsableRipgrepCommand('rg', {
      spawnSyncImpl: () => ({ status: 0, stdout: 'not-ripgrep\n' }),
    }),
    false,
  );
  assert.equal(
    isUsableRipgrepCommand('/missing/rg', {
      requireFile: true,
      fileExists: () => false,
      spawnSyncImpl: () => {
        throw new Error('must not spawn');
      },
    }),
    false,
  );
});

test('postinstall does not certify an install without vendored or system ripgrep', () => {
  const source = readFileSync(join(repositoryRoot, 'scripts', 'postinstall.mjs'), 'utf8');
  assert.match(source, /await installRipgrep\(\)/);
  assert.doesNotMatch(source, /await installRipgrep\(\);\s*\} catch \{ \/\* ripgrep is optional/);
  assert.match(source, /no working system rg was found/);
  assert.ok(
    source.indexOf('await installRipgrep();') <
      source.indexOf('writeLifecycleCompletionMarker(packageRoot)'),
    'ripgrep verification must finish before the lifecycle marker is written',
  );
});

test('ripgrep version probes distinguish old, prerelease and unusable executables', () => {
  for (const [stdout, expected] of [
    ['ripgrep 14.1.1\n', '14.1.1'],
    ['ripgrep 15.2.0 (rev abc123)\nfeatures:+pcre2\n', '15.2.0'],
    ['ripgrep 15.3.0-rc.1\n', '15.3.0-rc.1'],
    ['ripgrep nonsense\n', null],
    ['ripgrep 15.2.0malformed\n', null],
  ]) {
    assert.equal(getRipgrepVersion('rg', {
      spawnSyncImpl: () => ({ status: 0, stdout }),
    }), expected);
  }
  assert.equal(getRipgrepVersion('rg', {
    spawnSyncImpl: () => ({ status: 1, stdout: 'ripgrep 15.2.0\n' }),
  }), null);
});
