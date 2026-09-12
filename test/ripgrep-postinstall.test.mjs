import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { RG_VERSION, installRipgrep, resolveRipgrepRelease, verifyRipgrepArchive } from '../scripts/postinstall.mjs';

function fixture(t, { version, systemVersion = null, platform = 'win32', arch = 'x64', getReport } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'tau-rg-install-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const release = resolveRipgrepRelease({ platform, arch, getReport });
  const destDir = join(root, 'dist', 'vendor', 'ripgrep', release.dir);
  const binary = join(destDir, release.binary);
  if (version) {
    mkdirSync(destDir, { recursive: true });
    writeFileSync(binary, `ripgrep ${version}\n`);
  }
  const calls = [];
  const logs = [];
  const options = {
    root, platform, arch, getReport,
    log: message => logs.push(message),
    versionImpl: command => {
      if (command === 'rg') return systemVersion;
      if (!existsSync(command)) return null;
      return /^ripgrep (\S+)/.exec(readFileSync(command, 'utf8'))?.[1] ?? null;
    },
    downloadImpl: async (url, archive) => {
      calls.push(['download', url, archive]);
      writeFileSync(archive, 'fixture archive');
    },
    verifyArchiveImpl: async (archive, digest) => {
      calls.push(['verify', archive, digest]);
      assert.equal(readFileSync(archive, 'utf8'), 'fixture archive');
      assert.equal(digest, release.sha256);
    },
    extractImpl: async (_archive, ext, name, dest) => {
      calls.push(['extract', ext, dest]);
      writeFileSync(join(dest, name), `ripgrep ${RG_VERSION}\n`);
    },
    renameImpl: (source, target) => {
      calls.push(['promote', source, target]);
      renameSync(source, target);
    },
  };
  return { root, destDir, binary, options, calls, logs };
}

function assertClean(f) {
  const download = f.calls.find(call => call[0] === 'download');
  if (download) assert.equal(existsSync(dirname(download[2])), false, 'private download directory is removed');
  const parent = dirname(f.destDir);
  if (existsSync(parent)) {
    assert.deepEqual(readdirSync(parent), [f.destDir.split(/[\\/]/).at(-1)], 'no staging directories remain');
  }
}

test('current usable vendored ripgrep skips the download', async t => {
  const f = fixture(t, { version: RG_VERSION });
  await installRipgrep(f.options);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.logs, []);
});

test('a usable older ripgrep is replaced only after archive and executable verification', async t => {
  const f = fixture(t, { version: '14.1.1' });
  const extract = f.options.extractImpl;
  f.options.extractImpl = async (...args) => {
    assert.equal(readFileSync(f.binary, 'utf8'), 'ripgrep 14.1.1\n');
    await extract(...args);
  };
  await installRipgrep(f.options);
  assert.equal(readFileSync(f.binary, 'utf8'), `ripgrep ${RG_VERSION}\n`);
  assert.deepEqual(f.calls.map(call => call[0]), ['download', 'verify', 'extract', 'promote']);
  assert.match(f.calls[0][1], new RegExp(`/download/${RG_VERSION}/ripgrep-${RG_VERSION}-x86_64-pc-windows-msvc\\.zip$`));
  assertClean(f);
});

test('new ARM64 musl installs use the matching archive and normal runtime directory', async t => {
  const f = fixture(t, { platform: 'linux', arch: 'arm64', getReport: () => ({ header: {} }) });
  await installRipgrep(f.options);
  assert.match(f.calls[0][1], /aarch64-unknown-linux-musl\.tar\.gz$/);
  assert.equal(readFileSync(f.binary, 'utf8'), `ripgrep ${RG_VERSION}\n`);
  assert.match(f.binary, /arm64-linux[\\/]rg$/);
  assertClean(f);
});

for (const failure of ['download', 'checksum', 'extraction', 'version', 'promotion']) {
  test(`failed ${failure} keeps the working older binary and removes staging files`, async t => {
    const f = fixture(t, { version: '14.1.1' });
    if (failure === 'download') {
      const download = f.options.downloadImpl;
      f.options.downloadImpl = async (...args) => {
        await download(...args);
        throw new Error('network unavailable');
      };
    } else if (failure === 'checksum') {
      f.options.verifyArchiveImpl = verifyRipgrepArchive;
    } else if (failure === 'extraction') {
      f.options.extractImpl = async () => { throw new Error('archive damaged'); };
    } else if (failure === 'version') {
      f.options.extractImpl = async (_archive, _ext, name, dest) => {
        writeFileSync(join(dest, name), 'ripgrep 14.1.1\n');
      };
    } else {
      f.options.renameImpl = () => { throw new Error('executable locked'); };
    }
    await installRipgrep(f.options);
    assert.equal(readFileSync(f.binary, 'utf8'), 'ripgrep 14.1.1\n');
    assert.match(f.logs.at(-1), /keeping working vendored ripgrep 14\.1\.1/);
    assertClean(f);
  });
}

test('a failed download can use system ripgrep when no vendored binary works', async t => {
  const f = fixture(t, { systemVersion: '15.2.0' });
  f.options.downloadImpl = async () => { throw new Error('offline'); };
  await installRipgrep(f.options);
  assert.equal(existsSync(f.binary), false);
  assert.match(f.logs.at(-1), /using the working system rg/);
});

for (const available of ['vendored', 'system', 'neither']) {
  test(`an unavailable temp directory respects the ${available} binary fallback`, async t => {
    const f = fixture(t, {
      version: available === 'vendored' ? '14.1.1' : undefined,
      systemVersion: available === 'system' ? RG_VERSION : null,
    });
    const temporaryRoot = join(f.root, 'not-a-directory');
    writeFileSync(temporaryRoot, 'blocked temporary path');
    const options = { ...f.options, temporaryRoot };
    if (available === 'neither') {
      await assert.rejects(installRipgrep(options), /no working system rg was found/);
    } else {
      await installRipgrep(options);
      assert.match(f.logs.at(-1), available === 'vendored'
        ? /keeping working vendored ripgrep 14\.1\.1/
        : /using the working system rg/);
    }
    assert.deepEqual(f.calls, [], 'directory failure must happen before downloading');
    if (available === 'vendored') assert.equal(readFileSync(f.binary, 'utf8'), 'ripgrep 14.1.1\n');
    else assert.equal(existsSync(f.binary), false);
    assertClean(f);
  });
}

test('installation fails when neither downloaded, vendored nor system ripgrep works', async t => {
  const f = fixture(t);
  f.options.extractImpl = async (_archive, _ext, name, dest) => {
    writeFileSync(join(dest, name), 'not an executable');
  };
  await assert.rejects(installRipgrep(f.options), /no working system rg was found/);
  assert.equal(existsSync(f.binary), false);
  assertClean(f);
});

test('unsupported platforms require a working system rg without downloading', async () => {
  const options = {
    platform: 'freebsd', arch: 'x64', log: () => {},
    downloadImpl: async () => assert.fail('must not download an incompatible binary'),
    versionImpl: () => null,
  };
  await assert.rejects(installRipgrep(options), /no working system rg was found/);
  await installRipgrep({ ...options, versionImpl: () => '15.2.0' });
});

test('archive digests are checked against the actual file bytes', async t => {
  const f = fixture(t);
  const archive = join(f.root, 'archive.zip');
  writeFileSync(archive, 'verified content');
  const digest = createHash('sha256').update('verified content').digest('hex');
  await verifyRipgrepArchive(archive, digest);
  writeFileSync(archive, 'tampered content');
  await assert.rejects(verifyRipgrepArchive(archive, digest), /SHA-256 checksum mismatch/);
});

test('imports are inert and --ripgrep-only cannot trigger unrelated lifecycles', t => {
  const f = fixture(t);
  const scripts = join(f.root, 'scripts');
  mkdirSync(scripts);
  const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const installer = join(scripts, 'postinstall.mjs');
  copyFileSync(join(repositoryRoot, 'scripts', 'postinstall.mjs'), installer);
  writeFileSync(join(scripts, 'platform-support.mjs'), `
    export const getRipgrepVersion = () => '${RG_VERSION}';
    export const isLinuxArm64Musl = () => false;
    export const resolveWindowsSystemExecutable = () => null;
  `);
  writeFileSync(join(scripts, 'verify-deps.mjs'), 'throw new Error("Unrelated lifecycle must not run");');
  for (const args of [
    ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(installer).href)})`],
    [installer, '--ripgrep-only'],
  ]) {
    const run = spawnSync(process.execPath, args, { cwd: f.root, encoding: 'utf8', timeout: 10_000, windowsHide: true });
    assert.equal(run.status, 0, run.error?.message ?? run.stderr);
    assert.equal(existsSync(join(f.root, '.tau-lifecycle-complete.json')), false);
  }
});
