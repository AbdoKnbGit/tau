import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  LIFECYCLE_MARKER_FILENAME,
  TAU_RUNTIME_ALLOW_SCRIPTS,
  classifyInstallation,
  createRepairEnvironment,
  ensureDeps,
  findMissingDeps,
  getLifecycleMarkerStatus,
  isExactVersion,
  repairDeps,
  writeLifecycleCompletionMarker,
} from '../scripts/verify-deps.mjs';
import { ALLOWED_SCRIPTS } from '../packages/tau-installer/lib/installer.mjs';
import { RG_VERSION } from '../scripts/postinstall.mjs';
import {
  acquireSynchronousUpdateLease,
  getManagedLocalUpdateLockPath,
  leaseEnvironment,
  releaseSynchronousUpdateLease,
} from '../scripts/update-lock.mjs';

const temporaryRoots = [];

function makeTemporaryRoot() {
  const root = mkdtempSync(join(tmpdir(), 'tau-lifecycle-bridge-'));
  temporaryRoots.push(root);
  return root;
}

function makePackage(packageRoot, options = {}) {
  mkdirSync(packageRoot, { recursive: true });
  const dependencies = options.dependencies ?? {};
  writeFileSync(
    join(packageRoot, 'package.json'),
    `${JSON.stringify({
      name: '@abdoknbgit/tau',
      version: options.version ?? '0.93.0',
      dependencies,
      ...(options.allowScripts ? { allowScripts: options.allowScripts } : {}),
    })}\n`,
  );
  for (const dependency of Object.keys(dependencies)) {
    const dependencyRoot = join(packageRoot, 'node_modules', ...dependency.split('/'));
    mkdirSync(dependencyRoot, { recursive: true });
    writeFileSync(
      join(dependencyRoot, 'package.json'),
      `${JSON.stringify({
        name: dependency,
        version: dependencies[dependency],
        main: 'index.js',
      })}\n`,
    );
    if (!(options.missingEntrypoints ?? []).includes(dependency)) {
      writeFileSync(join(dependencyRoot, 'index.js'), 'module.exports = {};\n');
    }
  }
  return packageRoot;
}

function makePostinstallFixture(options = {}) {
  const packageRoot = makePackage(join(makeTemporaryRoot(), 'tau'));
  const scriptsRoot = join(packageRoot, 'scripts');
  mkdirSync(scriptsRoot);
  const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  copyFileSync(
    join(repositoryRoot, 'scripts', 'postinstall.mjs'),
    join(scriptsRoot, 'postinstall.mjs'),
  );
  copyFileSync(
    join(repositoryRoot, 'scripts', 'verify-deps.mjs'),
    join(scriptsRoot, 'verify-deps.mjs'),
  );
  copyFileSync(
    join(repositoryRoot, 'scripts', 'update-lock.mjs'),
    join(scriptsRoot, 'update-lock.mjs'),
  );
  copyFileSync(
    join(repositoryRoot, 'scripts', 'platform-support.mjs'),
    join(scriptsRoot, 'platform-support-real.mjs'),
  );
  // This fixture tests lifecycle completion, not network or binary upgrades.
  // Keep it independent of whichever ripgrep happens to be on the test host.
  writeFileSync(
    join(scriptsRoot, 'platform-support.mjs'),
    `export * from './platform-support-real.mjs'; export const getRipgrepVersion = () => '${RG_VERSION}';\n`,
  );

  if (options.failingRequiredNativeBuild) {
    writeFileSync(
      join(scriptsRoot, 'build-native-shell-parser.mjs'),
      'process.exit(7);\n',
    );
  }
  return packageRoot;
}

test.afterEach(() => {
  while (temporaryRoots.length > 0) {
    rmSync(temporaryRoots.pop(), { recursive: true, force: true });
  }
});

test('writes an exact-version marker atomically with no temporary file left behind', () => {
  const packageRoot = makePackage(join(makeTemporaryRoot(), 'tau'));
  const markerPath = writeLifecycleCompletionMarker(packageRoot, {
    nonce: 'test',
    now: () => new Date('2026-07-16T00:00:00.000Z'),
  });

  assert.equal(markerPath, join(packageRoot, LIFECYCLE_MARKER_FILENAME));
  assert.deepEqual(getLifecycleMarkerStatus(packageRoot), {
    ok: true,
    reason: 'complete',
    markerPath,
    expected: {
      schema: 1,
      packageName: '@abdoknbgit/tau',
      version: '0.93.0',
    },
    actual: {
      schema: 1,
      packageName: '@abdoknbgit/tau',
      version: '0.93.0',
      completedAt: '2026-07-16T00:00:00.000Z',
    },
  });
  assert.equal(
    readdirSync(packageRoot).some(name => name.endsWith('.tmp')),
    false,
  );
});

test('rejects a completion marker from a different Tau version', () => {
  const packageRoot = makePackage(join(makeTemporaryRoot(), 'tau'));
  writeFileSync(
    join(packageRoot, LIFECYCLE_MARKER_FILENAME),
    JSON.stringify({
      schema: 1,
      packageName: '@abdoknbgit/tau',
      version: '0.92.14',
    }),
  );

  const status = getLifecycleMarkerStatus(packageRoot);
  assert.equal(status.ok, false);
  assert.equal(status.reason, 'mismatch');
});

test('exact versions support build metadata and reject invalid numeric prereleases', () => {
  assert.equal(isExactVersion('0.93.0+build.7'), true);
  assert.equal(isExactVersion('0.93.0-rc.1+linux.x64'), true);
  assert.equal(isExactVersion('0.93.0-01'), false);
  assert.equal(isExactVersion('01.93.0'), false);
  assert.equal(isExactVersion('latest'), false);
});

test('synchronous lifecycle leases contend, release, and recover dead stale owners', () => {
  const root = makeTemporaryRoot();
  const lockPath = join(root, '.local-update.lock');
  const common = {
    lockPath,
    env: {},
    envPrefix: 'TAU_LOCAL_UPDATE_LOCK',
  };
  const owner = acquireSynchronousUpdateLease({
    ...common,
    pid: 111,
    isProcessAliveImpl: () => false,
  });
  assert.equal(owner.status, 'acquired');

  const contender = acquireSynchronousUpdateLease({
    ...common,
    pid: 222,
    isProcessAliveImpl: pid => pid === 111,
  });
  assert.equal(contender.status, 'contended');

  const staleTime = new Date(Date.now() - 20 * 60 * 1000);
  utimesSync(owner.lease.leasePath, staleTime, staleTime);
  const stillLive = acquireSynchronousUpdateLease({
    ...common,
    pid: 222,
    isProcessAliveImpl: pid => pid === 111,
  });
  assert.equal(stillLive.status, 'contended');

  const recovered = acquireSynchronousUpdateLease({
    ...common,
    pid: 222,
    isProcessAliveImpl: () => false,
  });
  assert.equal(recovered.status, 'acquired');
  releaseSynchronousUpdateLease(recovered.lease);
  assert.equal(existsSync(lockPath), false);

  writeFileSync(lockPath, '111');
  utimesSync(lockPath, staleTime, staleTime);
  const liveLegacy = acquireSynchronousUpdateLease({
    ...common,
    pid: 222,
    isProcessAliveImpl: pid => pid === 111,
  });
  assert.equal(liveLegacy.status, 'contended');
  const migratedLegacy = acquireSynchronousUpdateLease({
    ...common,
    pid: 222,
    isProcessAliveImpl: () => false,
  });
  assert.equal(migratedLegacy.status, 'acquired');
  releaseSynchronousUpdateLease(migratedLegacy.lease);
});

test('synchronous lifecycle leases borrow a valid outer lock without releasing it', () => {
  const root = makeTemporaryRoot();
  const lockPath = join(root, '.local-update.lock');
  const envPrefix = 'TAU_LOCAL_UPDATE_LOCK';
  const outer = acquireSynchronousUpdateLease({
    lockPath,
    env: {},
    envPrefix,
    pid: 111,
    isProcessAliveImpl: () => false,
  });
  assert.equal(outer.status, 'acquired');

  const borrowed = acquireSynchronousUpdateLease({
    lockPath,
    env: leaseEnvironment(outer.lease, envPrefix),
    envPrefix,
    pid: 222,
    isProcessAliveImpl: pid => pid === 111,
  });
  assert.equal(borrowed.status, 'borrowed');
  releaseSynchronousUpdateLease(borrowed.lease);
  assert.equal(existsSync(outer.lease.leasePath), true);
  releaseSynchronousUpdateLease(outer.lease);
});

test('a dependency manifest without its resolvable entrypoint is incomplete', () => {
  const packageRoot = makePackage(join(makeTemporaryRoot(), 'tau'), {
    dependencies: { 'broken-runtime': '1.0.0' },
    missingEntrypoints: ['broken-runtime'],
  });

  assert.deepEqual(findMissingDeps(packageRoot), ['broken-runtime']);
  assert.equal(ensureDeps(packageRoot, { quiet: true }), false);
});

test('a manifest-only type dependency is not falsely rejected', () => {
  const packageRoot = makePackage(join(makeTemporaryRoot(), 'tau'), {
    dependencies: { 'type-fest': '4.41.0' },
    missingEntrypoints: ['type-fest'],
  });

  assert.deepEqual(findMissingDeps(packageRoot), []);
});

test('legacy bridge runtime policy stays aligned with the reviewed installer', () => {
  assert.deepEqual(TAU_RUNTIME_ALLOW_SCRIPTS, ALLOWED_SCRIPTS);
});

test('postinstall dependency verification explicitly ignores the not-yet-written marker', () => {
  const packageRoot = makePackage(join(makeTemporaryRoot(), 'tau'), {
    dependencies: { zod: '4.0.0' },
  });

  assert.equal(
    ensureDeps(packageRoot, {
      repair: true,
      quiet: true,
      skipLifecycleMarker: true,
      spawnSyncImpl: () => {
        throw new Error('npm must not run');
      },
    }),
    true,
  );
});

test('postinstall writes the marker only after its final successful step', () => {
  const packageRoot = makePostinstallFixture();
  const result = spawnSync(
    process.execPath,
    [join(packageRoot, 'scripts', 'postinstall.mjs')],
    {
      cwd: packageRoot,
      env: {
        ...process.env,
        TAU_SKIP_OLLAMA_PREPULL: '1',
        TAU_SKIP_NATIVE_TOOLS_POSTINSTALL: '1',
        TAU_REPAIR: '',
      },
      encoding: 'utf8',
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(getLifecycleMarkerStatus(packageRoot).ok, true);
});

test('postinstall failure leaves the completion marker absent', () => {
  const packageRoot = makePostinstallFixture({ failingRequiredNativeBuild: true });
  writeLifecycleCompletionMarker(packageRoot);
  assert.equal(getLifecycleMarkerStatus(packageRoot).ok, true);

  const result = spawnSync(
    process.execPath,
    [join(packageRoot, 'scripts', 'postinstall.mjs')],
    {
      cwd: packageRoot,
      env: {
        ...process.env,
        TAU_SKIP_OLLAMA_PREPULL: '1',
        TAU_SKIP_NATIVE_TOOLS_POSTINSTALL: '',
        TAU_REQUIRE_NATIVE_SHELL_PARSER: '1',
        TAU_REPAIR: '',
      },
      encoding: 'utf8',
    },
  );

  assert.equal(result.status, 7);
  assert.equal(getLifecycleMarkerStatus(packageRoot).ok, false);
});

test('a source checkout does not require a generated lifecycle marker', () => {
  const packageRoot = makePackage(join(makeTemporaryRoot(), 'checkout'));
  mkdirSync(join(packageRoot, 'src'));
  writeFileSync(join(packageRoot, 'package-lock.json'), '{}\n');

  assert.equal(
    ensureDeps(packageRoot, {
      quiet: true,
      spawnSyncImpl: () => {
        throw new Error('npm must not run for development');
      },
    }),
    true,
  );
});

test('missing global marker triggers an exact-version installer repair with scrubbed npm config', () => {
  const temporaryRoot = makeTemporaryRoot();
  const globalNodeModules = join(temporaryRoot, 'prefix', 'node_modules');
  const packageRoot = makePackage(
    join(globalNodeModules, '@abdoknbgit', 'tau'),
    { version: '0.93.1-rc.2', dependencies: { zod: '4.0.0' } },
  );
  const calls = [];
  const hostileEnv = {
    PATH: process.env.PATH,
    npm_config_ignore_scripts: 'true',
    NPM_CONFIG_ALLOW_SCRIPTS: 'evil',
    npm_config_dangerously_allow_all_scripts: 'true',
    npm_config_dry_run: 'true',
    npm_config_global: 'false',
    npm_config_omit: 'optional',
  };
  const spawnSyncImpl = (command, args, options) => {
    calls.push({ command, args, options });
    if (args.includes('root')) {
      return { status: 0, stdout: `${globalNodeModules}\n`, stderr: '' };
    }
    assert.ok(args.includes('exec'));
    writeLifecycleCompletionMarker(packageRoot, {
      nonce: 'repair',
      now: () => new Date('2026-07-16T00:00:00.000Z'),
    });
    return { status: 0, stdout: '', stderr: '' };
  };

  assert.equal(
    ensureDeps(packageRoot, {
      repair: true,
      quiet: true,
      env: hostileEnv,
      homeDirectory: temporaryRoot,
      spawnSyncImpl,
    }),
    true,
  );
  assert.equal(calls.length, 2);
  const repair = calls[1];
  assert.ok(repair.args.includes('--package=@abdoknbgit/tau-installer@latest'));
  assert.deepEqual(
    repair.args.slice(repair.args.indexOf('--tau-version')),
    ['--tau-version', '0.93.1-rc.2'],
  );
  assert.equal(repair.options.cwd, temporaryRoot);
  assert.equal(repair.options.timeout, undefined);
  assert.equal(repair.options.env.TAU_LIFECYCLE_BRIDGE_REPAIR, '1');
  for (const key of Object.keys(hostileEnv).filter(key =>
    key.toLowerCase().startsWith('npm_config_'),
  )) {
    assert.equal(key in repair.options.env, false, `${key} must be scrubbed`);
  }
});

test('a failed installer fails closed', () => {
  const temporaryRoot = makeTemporaryRoot();
  const globalNodeModules = join(temporaryRoot, 'prefix', 'node_modules');
  const packageRoot = makePackage(join(globalNodeModules, '@abdoknbgit', 'tau'));
  let calls = 0;

  assert.equal(
    ensureDeps(packageRoot, {
      repair: true,
      quiet: true,
      homeDirectory: temporaryRoot,
      spawnSyncImpl: (_command, args) => {
        calls += 1;
        return args.includes('root')
          ? { status: 0, stdout: `${globalNodeModules}\n`, stderr: '' }
          : { status: 1, stdout: '', stderr: 'install failed' };
      },
    }),
    false,
  );
  assert.equal(calls, 2);
  assert.equal(getLifecycleMarkerStatus(packageRoot).ok, false);
});

test('an exit-zero installer is not accepted until the exact marker exists', () => {
  const temporaryRoot = makeTemporaryRoot();
  const globalNodeModules = join(temporaryRoot, 'prefix', 'node_modules');
  const packageRoot = makePackage(join(globalNodeModules, '@abdoknbgit', 'tau'));

  assert.equal(
    ensureDeps(packageRoot, {
      repair: true,
      quiet: true,
      homeDirectory: temporaryRoot,
      spawnSyncImpl: (_command, args) =>
        args.includes('root')
          ? { status: 0, stdout: `${globalNodeModules}\n`, stderr: '' }
          : { status: 0, stdout: '', stderr: '' },
    }),
    false,
  );
  assert.equal(getLifecycleMarkerStatus(packageRoot).ok, false);
});

test('managed-local installation rebuilds reviewed lifecycles in place', () => {
  const temporaryRoot = makeTemporaryRoot();
  const home = join(temporaryRoot, 'home');
  const projectRoot = join(home, '.claude', 'local');
  const packageRoot = makePackage(
    join(projectRoot, 'node_modules', '@abdoknbgit', 'tau'),
    {
      version: '0.93.2',
      allowScripts: {
        '@abdoknbgit/tau': true,
        '@whiskeysockets/baileys': true,
        'core-js': true,
        'fsevents': true,
        'node-pty': true,
        'protobufjs': true,
        'sharp': true,
        'esbuild': true,
        'not-reviewed': false,
      },
    },
  );
  writeFileSync(
    join(projectRoot, 'package.json'),
    `${JSON.stringify({ name: 'tau-local', version: '0.0.1', private: true })}\n`,
  );

  assert.deepEqual(
    classifyInstallation(packageRoot, {
      homeDirectory: home,
      spawnSyncImpl: () => {
        throw new Error('global npm probe must not run');
      },
    }),
    { kind: 'managed-local', projectRoot },
  );

  const calls = [];
  assert.equal(
    ensureDeps(packageRoot, {
      repair: true,
      quiet: true,
      homeDirectory: home,
      spawnSyncImpl: (command, args, options) => {
        calls.push({ command, args, options });
        assert.equal(options.cwd, projectRoot);
        if (args.includes('--version')) {
          return { status: 0, stdout: '12.4.1\n', stderr: '' };
        }
        if (args.includes('install')) {
          assert.ok(args.includes('@abdoknbgit/tau@0.93.2'));
          writeLifecycleCompletionMarker(packageRoot, {
            nonce: 'preliminary-install',
          });
        } else {
          assert.ok(args.includes('rebuild'));
          if (args.at(-1) === '@abdoknbgit/tau') {
            writeLifecycleCompletionMarker(packageRoot, {
              nonce: 'local-repair',
            });
          } else {
            assert.equal(
              getLifecycleMarkerStatus(packageRoot).ok,
              false,
              'preliminary install marker must be cleared before rebuild',
            );
          }
        }
        assert.ok(args.includes('--global=false'));
        assert.equal(args.includes('exec'), false);
        return { status: 0, stdout: '', stderr: '' };
      },
    }),
    true,
  );
  assert.equal(calls.length, 4);
  const [versionProbe, install, dependencyRebuild, tauRebuild] = calls;
  assert.ok(versionProbe.args.includes('--version'));
  assert.ok(install.args.includes('install'));
  assert.deepEqual(
    dependencyRebuild.args.slice(-6),
    TAU_RUNTIME_ALLOW_SCRIPTS.filter(name => name !== '@abdoknbgit/tau'),
  );
  assert.deepEqual(tauRebuild.args.slice(-1), ['@abdoknbgit/tau']);
  assert.equal(install.options.timeout, undefined);
  assert.equal(install.options.env.TAU_LIFECYCLE_BRIDGE_REPAIR, '1');
  assert.equal(
    install.options.env.TAU_LOCAL_UPDATE_LOCK_PATH,
    getManagedLocalUpdateLockPath(projectRoot),
  );
  assert.match(install.options.env.TAU_LOCAL_UPDATE_LOCK_TOKEN, /^[0-9a-f-]{36}$/i);
  assert.equal(install.options.env.TAU_LOCAL_UPDATE_LOCK_PID, String(process.pid));
  assert.deepEqual(
    JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8')).allowScripts,
    Object.fromEntries(TAU_RUNTIME_ALLOW_SCRIPTS.map(name => [name, true])),
  );
  assert.equal(
    readdirSync(projectRoot).some(name => /\.(?:tmp|bak)$/.test(name)),
    false,
  );
  assert.equal(existsSync(getManagedLocalUpdateLockPath(projectRoot)), false);
});

test('managed-local lifecycle repair does not mutate while another updater owns its lock', () => {
  const temporaryRoot = makeTemporaryRoot();
  const home = join(temporaryRoot, 'home');
  const projectRoot = join(home, '.claude', 'local');
  const policy = Object.fromEntries(
    TAU_RUNTIME_ALLOW_SCRIPTS.map(name => [name, true]),
  );
  const packageRoot = makePackage(
    join(projectRoot, 'node_modules', '@abdoknbgit', 'tau'),
    { allowScripts: policy },
  );
  const projectManifestPath = join(projectRoot, 'package.json');
  writeFileSync(
    projectManifestPath,
    `${JSON.stringify({ name: 'tau-local', version: '0.0.1', private: true })}\n`,
  );

  const lockPath = getManagedLocalUpdateLockPath(projectRoot);
  const owner = acquireSynchronousUpdateLease({
    lockPath,
    env: {},
    envPrefix: 'TAU_LOCAL_UPDATE_LOCK',
    pid: 111,
    isProcessAliveImpl: () => false,
  });
  assert.equal(owner.status, 'acquired');
  try {
    assert.equal(
      ensureDeps(packageRoot, {
        repair: true,
        quiet: true,
        homeDirectory: home,
        updateLockPid: 222,
        isProcessAliveImpl: pid => pid === 111,
        spawnSyncImpl: () => {
          throw new Error('npm must not run while the local updater lock is held');
        },
      }),
      false,
    );
    assert.equal(
      JSON.parse(readFileSync(projectManifestPath, 'utf8')).allowScripts,
      undefined,
    );
  } finally {
    releaseSynchronousUpdateLease(owner.lease);
  }
});

test('failed local dependency rebuild cannot retain an install-created marker', () => {
  const temporaryRoot = makeTemporaryRoot();
  const home = join(temporaryRoot, 'home');
  const projectRoot = join(home, '.claude', 'local');
  const policy = Object.fromEntries(
    TAU_RUNTIME_ALLOW_SCRIPTS.map(name => [name, true]),
  );
  const packageRoot = makePackage(
    join(projectRoot, 'node_modules', '@abdoknbgit', 'tau'),
    { allowScripts: policy },
  );
  writeFileSync(
    join(projectRoot, 'package.json'),
    `${JSON.stringify({
      name: 'tau-local',
      version: '0.0.1',
      private: true,
      allowScripts: policy,
    })}\n`,
  );

  assert.equal(
    ensureDeps(packageRoot, {
      repair: true,
      quiet: true,
      homeDirectory: home,
      spawnSyncImpl: (_command, args) => {
        if (args.includes('--version')) {
          return { status: 0, stdout: '12.0.1\n', stderr: '' };
        }
        if (args.includes('install')) {
          writeLifecycleCompletionMarker(packageRoot, {
            nonce: 'must-be-invalidated',
          });
          return { status: 0, stdout: '', stderr: '' };
        }
        assert.ok(args.includes('rebuild'));
        return { status: 1, stdout: '', stderr: 'native build failed' };
      },
    }),
    false,
  );
  assert.equal(getLifecycleMarkerStatus(packageRoot).ok, false);
  assert.equal(existsSync(getManagedLocalUpdateLockPath(projectRoot)), false);
});

test('project-scoped dependency repair never passes CLI allow-scripts', () => {
  const packageRoot = makePackage(join(makeTemporaryRoot(), 'tau'), {
    allowScripts: Object.fromEntries(
      TAU_RUNTIME_ALLOW_SCRIPTS.map(name => [name, true]),
    ),
  });
  const calls = [];
  assert.equal(
    repairDeps(packageRoot, {
      quiet: true,
      interactive: false,
      installation: { kind: 'installed-other' },
      spawnSyncImpl: (command, args, options) => {
        calls.push({ command, args, options });
        return args.includes('--version')
          ? { status: 0, stdout: '12.4.1\n', stderr: '' }
          : { status: 0, stdout: '', stderr: '' };
      },
    }),
    true,
  );
  assert.equal(calls.length, 2);
  assert.ok(calls[1].args.includes('--strict-allow-scripts=true'));
  assert.equal(
    calls[1].args.some(argument => argument.startsWith('--allow-scripts=')),
    false,
  );
});

test('an installed-other tree is probed but never redirected globally', () => {
  const temporaryRoot = makeTemporaryRoot();
  const packageRoot = makePackage(join(temporaryRoot, 'vendor', 'tau'));
  let calls = 0;

  assert.equal(
    ensureDeps(packageRoot, {
      repair: true,
      quiet: true,
      homeDirectory: temporaryRoot,
      spawnSyncImpl: (_command, args) => {
        calls += 1;
        assert.ok(args.includes('root'));
        return {
          status: 0,
          stdout: `${join(temporaryRoot, 'different-prefix', 'node_modules')}\n`,
          stderr: '',
        };
      },
    }),
    false,
  );
  assert.equal(calls, 1, 'only the read-only npm root probe may run');
});

test('repair environment scrubs case-insensitive dangerous npm settings', () => {
  const env = createRepairEnvironment({
    PATH: 'kept',
    NPM_CONFIG_IGNORE_SCRIPTS: 'true',
    npm_config_allow_scripts: 'anything',
    npm_config_package_lock_only: 'true',
  });
  assert.deepEqual(env, { PATH: 'kept' });
});

test('the generated marker is not part of the root package files allowlist', () => {
  const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const manifest = JSON.parse(
    readFileSync(join(repositoryRoot, 'package.json'), 'utf8'),
  );
  assert.equal(manifest.files.includes(LIFECYCLE_MARKER_FILENAME), false);
});

test('the generated launcher fails closed when its integrity verifier throws', () => {
  const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const buildSource = readFileSync(join(repositoryRoot, 'build.mjs'), 'utf8');
  const launcherStart = buildSource.indexOf('const launcher = `');
  const launcherWrite = buildSource.indexOf(
    "writeFileSync('./dist/cli.mjs', launcher)",
    launcherStart,
  );
  const launcherEnd = buildSource.lastIndexOf('`', launcherWrite);

  assert.notEqual(launcherStart, -1, 'launcher template is missing');
  assert.notEqual(launcherWrite, -1, 'launcher write is missing');
  assert.notEqual(launcherEnd, -1, 'launcher template terminator is missing');

  const launcherSource = buildSource.slice(launcherStart, launcherEnd);
  const exceptionHandler = launcherSource.slice(
    launcherSource.indexOf('} catch (error) {'),
  );

  assert.match(launcherSource, /Installation integrity check failed/);
  assert.match(launcherSource, /manualFixInstructions/);
  assert.match(exceptionHandler, /stopForIntegrityFailure/);
  assert.ok(
    exceptionHandler.indexOf('stopForIntegrityFailure') <
      exceptionHandler.indexOf('await import(pathToFileURL(agentBundlePath).href)'),
    'the broken installation must exit before importing the agent bundle',
  );
});

test('the generated launcher checks required installed files before import', () => {
  const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const buildSource = readFileSync(join(repositoryRoot, 'build.mjs'), 'utf8');
  const launcherStart = buildSource.indexOf('const launcher = `');
  const launcherWrite = buildSource.indexOf(
    "writeFileSync('./dist/cli.mjs', launcher)",
    launcherStart,
  );
  const launcherEnd = buildSource.lastIndexOf('`', launcherWrite);
  const launcherSource = buildSource.slice(launcherStart, launcherEnd);
  const bundleCheck = launcherSource.indexOf('if (!existsSync(agentBundlePath))');
  const verifierCheck = launcherSource.indexOf('if (!existsSync(verifierPath))');
  const bundleImport = launcherSource.indexOf(
    'await import(pathToFileURL(agentBundlePath).href)',
  );

  assert.notEqual(bundleCheck, -1, 'agent bundle existence check is missing');
  assert.notEqual(verifierCheck, -1, 'installed verifier existence check is missing');
  assert.notEqual(bundleImport, -1, 'agent bundle import is missing');
  assert.ok(bundleCheck < bundleImport, 'bundle must be checked before import');
  assert.ok(verifierCheck < bundleImport, 'verifier must be checked before import');
  assert.match(launcherSource, /if \(!isSourceCheckout\) \{[\s\S]*installation verifier is missing/);
  assert.match(launcherSource, /npm run build/);
  assert.match(launcherSource, /npx -y @abdoknbgit\/tau-installer@latest/);
});

test('the generated launcher catches only module and native load failures', () => {
  const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const buildSource = readFileSync(join(repositoryRoot, 'build.mjs'), 'utf8');
  const launcherStart = buildSource.indexOf('const launcher = `');
  const launcherWrite = buildSource.indexOf(
    "writeFileSync('./dist/cli.mjs', launcher)",
    launcherStart,
  );
  const launcherEnd = buildSource.lastIndexOf('`', launcherWrite);
  const launcherSource = buildSource.slice(launcherStart, launcherEnd);
  const bundleCatch = launcherSource.slice(
    launcherSource.lastIndexOf('try {'),
  );

  assert.match(bundleCatch, /await import\(pathToFileURL\(agentBundlePath\)\.href\)/);
  assert.match(bundleCatch, /if \(isIntegrityLoadFailure\(error\)\)/);
  assert.match(launcherSource, /ERR_MODULE_NOT_FOUND/);
  assert.match(launcherSource, /ERR_DLOPEN_FAILED/);
  assert.match(bundleCatch, /throw error/);
  assert.ok(
    bundleCatch.indexOf('stopForIntegrityFailure') <
      bundleCatch.indexOf('throw error'),
    'recognized load failures recover while unrelated errors are rethrown',
  );
});
