import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import {
  findCompatibleNodeRuntime,
  getNodeRuntimeIssue,
  managedNodeRuntimePath,
  nodeRuntimeMessage,
} from '../scripts/node-runtime.mjs'

const probeResult = (version, arch = process.arch) => ({ status: 0, stdout: JSON.stringify({ version, arch }) })

test('runtime checks preserve require(esm) support and use the upstream Windows fix boundaries', () => {
  for (const version of ['20.19.0', '20.20.1', '22.12.0', '22.22.1', '24.20.0', '24.22.1', '26.7.0', '27.0.0'])
    assert.equal(getNodeRuntimeIssue(version, 'win32'), null, version)
  for (const version of ['23.0.0', '23.11.0', '24.0.0', '24.19.99', '25.9.0', '26.6.99']) {
    assert.equal(getNodeRuntimeIssue(version, 'win32'), 'windows-shutdown', version)
    assert.equal(getNodeRuntimeIssue(version, 'linux'), null, version)
    assert.equal(getNodeRuntimeIssue(version, 'darwin'), null, version)
  }
  for (const version of ['18.20.0', '20.18.0', '21.7.0', '22.11.99'])
    assert.equal(getNodeRuntimeIssue(version, 'linux'), 'require-esm', version)
  for (const version of ['', 'bad', '24.22', '24.22.1-alpha.1'])
    assert.equal(getNodeRuntimeIssue(version), 'unsupported-version', version)
  assert.equal(nodeRuntimeMessage('v24.19.0', 'windows-shutdown'), '')
})

test('runtime fallback follows PATH order, skips relative/current/duplicate candidates and rejects bad probes', () => {
  const probes = []
  const picked = findCompatibleNodeRuntime({
    platform: 'win32',
    execPath: 'C:\\old\\node.exe',
    env: { Path: ';.;relative;\\drive-dependent;/drive-dependent;C:drive-relative;C:\\old;C:\\OLD;C:\\missing;"C:\\not node";C:\\broken;C:\\old2;C:\\fixed;C:\\later' },
    exists: candidate => !candidate.includes('missing'),
    realpath: candidate => candidate,
    probe(candidate) {
      probes.push(candidate)
      if (candidate.includes('not node')) return { status: 0, stdout: 'some other program' }
      if (candidate.includes('broken')) throw new Error('Cannot spawn')
      if (candidate.includes('old2')) return probeResult('v24.19.0\n')
      return probeResult('v24.22.1\r\n')
    },
  })
  assert.equal(picked, 'C:\\fixed\\node.exe')
  assert.deepEqual(probes, ['C:\\not node\\node.exe', 'C:\\broken\\node.exe', 'C:\\old2\\node.exe', 'C:\\fixed\\node.exe'])
  assert.equal(findCompatibleNodeRuntime({ env: {}, exists: () => { throw new Error('Must not look outside PATH') } }), null)
  assert.equal(findCompatibleNodeRuntime({
    platform: 'linux', execPath: '/current/node', env: { PATH: '.:/current:/linked' },
    exists: () => true, realpath: () => '/current/node',
    probe: () => { throw new Error('A duplicate runtime must not be probed') },
  }), null)
})

test('Tau managed runtimes are resolved from the user directory and revalidated on every launch', () => {
  const env = { LOCALAPPDATA: 'C:\\User data', PATH: 'C:\\old' }
  const managed = 'C:\\User data\\Tau\\runtime\\node.exe'
  assert.equal(managedNodeRuntimePath(env, 'win32'), managed)
  assert.equal(managedNodeRuntimePath(env, 'linux'), null)
  assert.equal(managedNodeRuntimePath({ LOCALAPPDATA: 'relative' }, 'win32'), null)
  assert.equal(managedNodeRuntimePath({ LOCALAPPDATA: '\\drive-dependent' }, 'win32'), null)
  assert.equal(managedNodeRuntimePath({ LOCALAPPDATA: '\\\\server\\user-share' }, 'win32'), '\\\\server\\user-share\\Tau\\runtime\\node.exe')
  const options = { platform: 'win32', env, execPath: 'C:\\old\\node.exe', exists: () => true, realpath: path => path }
  assert.equal(findCompatibleNodeRuntime({ ...options, probe: () => probeResult('v24.22.1') }), managed)
  assert.equal(findCompatibleNodeRuntime({ ...options, probe: () => probeResult('v24.19.0') }), null, 'An outdated managed executable must never bypass the runtime check')
  assert.equal(findCompatibleNodeRuntime({ ...options, arch: 'arm64', probe: () => probeResult('v24.22.1', 'x64') }), null, 'A runtime for another architecture must not break installed native dependencies')
  assert.equal(findCompatibleNodeRuntime({ ...options, exists: () => false }), null, 'Removed runtimes must not be reused from a cached selection')
})

test('runtime discovery matches native environment casing instead of object insertion order', () => {
  const options = {
    execPath: '/current/node', exists: () => true, realpath: path => path,
    probe: () => probeResult('24.22.1'),
  }
  for (const platform of ['linux', 'darwin']) {
    assert.equal(findCompatibleNodeRuntime({ ...options, platform, env: { Path: '/wrong' } }), null)
    assert.equal(findCompatibleNodeRuntime({ ...options, platform, env: { Path: '/wrong', PATH: '/right' } }), '/right/node')
  }
  assert.equal(findCompatibleNodeRuntime({ ...options, platform: 'win32', env: { Path: 'C:\\wrong', PATH: 'C:\\right' } }), 'C:\\right\\node.exe')
  assert.equal(managedNodeRuntimePath({ localappdata: 'C:\\wrong', LOCALAPPDATA: 'C:\\right' }, 'win32'), 'C:\\right\\Tau\\runtime\\node.exe')
})

// Exercise the actual generated launcher using injected runtime facts. The
// alternate invocation is the real Node binary, running the same launcher;
// no mock agent/network request can hide an argument or exit-code regression.
function launcherFixture(agentSource) {
  const root = mkdtempSync(join(tmpdir(), 'tau-runtime-launcher-'))
    mkdirSync(join(root, 'dist'))
    let launcher = readFileSync(resolve('dist/cli.mjs'), 'utf8')
    assert.match(launcher, /(?:const|var|let) runtimeIssue = getNodeRuntimeIssue\(process\.versions\.node\)/, 'Rebuild the generated launcher before running this test')
    launcher = launcher.replace(
      /(?:const|var|let) runtimeIssue = getNodeRuntimeIssue\(process\.versions\.node\)/,
      "const runtimeIssue = process.env.TAU_RUNTIME_TEST_RESTARTED ? null : (process.env.TAU_RUNTIME_TEST_ISSUE || 'windows-shutdown')",
    ).replace(/(?:const|var|let) compatibleNode = findCompatibleNodeRuntime\(\)/,
      "const compatibleNode = process.env.TAU_RUNTIME_TEST_NO_ALTERNATIVE ? null : (process.env.TAU_RUNTIME_TEST_BAD_ALTERNATIVE || process.execPath); process.env.TAU_RUNTIME_TEST_RESTARTED = '1'")
    const cli = join(root, 'dist', 'cli.mjs')
    writeFileSync(cli, launcher)
    writeFileSync(join(root, 'dist', 'tau.mjs'), agentSource)
    return { root, cli }
}

test('launcher restarts once with a compatible runtime and preserves args, cwd, environment and exit status', () => {
  const { root, cli } = launcherFixture(`
      console.log(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),env:process.env.TAU_RUNTIME_TEST_VALUE,restarted:process.env.TAU_RUNTIME_TEST_RESTARTED}));
      process.exitCode=7;
    `)
  try {
    const args = ['with spaces', 'Unicode-é-漢字', 'a&b', '--flag=value', '']
    const result = spawnSync(process.execPath, [cli, ...args], {
      cwd: root, encoding: 'utf8', windowsHide: true,
      env: { ...process.env, TAU_SKIP_PREFLIGHT: '1', TAU_RUNTIME_TEST_VALUE: 'preserved' },
      timeout: 10_000,
    })
    assert.equal(result.status, 7, result.stderr)
    const reported = JSON.parse(result.stdout)
    // Temporary directories may use a symlink alias for the same working directory.
    assert.deepEqual({ ...reported, cwd: realpathSync(reported.cwd) }, {
      args, cwd: realpathSync(root), env: 'preserved', restarted: '1',
    })
    const continued = spawnSync(process.execPath, [cli, ...args], {
      cwd: root, encoding: 'utf8', windowsHide: true,
      env: { ...process.env, TAU_SKIP_PREFLIGHT: '1', TAU_RUNTIME_TEST_NO_ALTERNATIVE: '1' }, timeout: 10_000,
    })
    assert.equal(continued.status, 7, continued.stderr)
    assert.equal(continued.stderr, '', 'A missing alternative must not add a warning')
    assert.deepEqual(JSON.parse(continued.stdout).args, args, 'An affected Windows runtime remains usable without an alternative')
    const failedAlternative = spawnSync(process.execPath, [cli, ...args], {
      cwd: root, encoding: 'utf8', windowsHide: true,
      env: { ...process.env, TAU_SKIP_PREFLIGHT: '1', TAU_RUNTIME_TEST_BAD_ALTERNATIVE: join(root, 'missing-node') }, timeout: 10_000,
    })
    assert.equal(failedAlternative.status, 7, failedAlternative.stderr)
    assert.equal(failedAlternative.stderr, '', 'An unavailable optional runtime must fall back quietly')
    assert.deepEqual(JSON.parse(failedAlternative.stdout).args, args)
    const rejected = spawnSync(process.execPath, [cli], {
      cwd: root, encoding: 'utf8', windowsHide: true,
      env: { ...process.env, TAU_RUNTIME_TEST_NO_ALTERNATIVE: '1', TAU_RUNTIME_TEST_ISSUE: 'require-esm' }, timeout: 10_000,
    })
    assert.equal(rejected.status, 1)
    assert.match(rejected.stderr, /require\(esm\) support/)
    assert.equal(rejected.stdout, '', 'A runtime missing required JavaScript support must stop before the agent loads')
  } finally {
    assert.equal(dirname(root), tmpdir())
    rmSync(root, { recursive: true, force: true })
  }
})

test('runtime launcher forwards a targeted parent signal and waits for child cleanup', {
  skip: process.platform === 'win32' ? 'Windows console interrupts are delivered to the inherited child' : false,
}, async () => {
  const { root, cli } = launcherFixture(`
    const timer=setInterval(()=>{},1000);
    const failsafe=setTimeout(()=>{clearInterval(timer);process.exitCode=9},8000);
    process.on('SIGTERM',()=>{console.log('CHILD-CLEANUP-COMPLETE');clearInterval(timer);clearTimeout(failsafe);process.exitCode=7});
    console.log('CHILD-READY');
  `)
  const child = spawn(process.execPath, [cli], {
    cwd: root, env: { ...process.env, TAU_SKIP_PREFLIGHT: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = '', stderr = ''
  const done = new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject) })
  child.stdout.on('data', part => { stdout += part })
  child.stderr.on('data', part => { stderr += part })
  const timer = setTimeout(() => child.kill('SIGKILL'), 10_000)
  try {
    await new Promise((resolve, reject) => {
      const ready = () => { if (stdout.includes('CHILD-READY')) { child.stdout.off('data', ready); resolve() } }
      child.stdout.on('data', ready)
      done.then(() => reject(new Error('Child exited before readiness: ' + stderr)), reject)
    })
    child.kill('SIGTERM')
    assert.equal(await done, 7, stderr)
    assert.match(stdout, /CHILD-CLEANUP-COMPLETE/)
  } finally {
    clearTimeout(timer)
    rmSync(root, { recursive: true, force: true })
  }
})

test('runtime launcher preserves an unhandled child signal termination', {
  skip: process.platform === 'win32' ? 'POSIX signal termination is reported separately from exit status' : false,
}, async () => {
  const { root, cli } = launcherFixture(`
    const timer=setInterval(()=>{},1000);
    setTimeout(()=>{clearInterval(timer);process.exitCode=9},8000);
    console.log('CHILD-READY');
  `)
  const child = spawn(process.execPath, [cli], {
    cwd: root, env: { ...process.env, TAU_SKIP_PREFLIGHT: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = '', stderr = ''
  const done = new Promise((resolve, reject) => {
    child.once('close', (status, signal) => resolve({ status, signal }))
    child.once('error', reject)
  })
  child.stdout.on('data', part => { stdout += part })
  child.stderr.on('data', part => { stderr += part })
  const timer = setTimeout(() => child.kill('SIGKILL'), 10_000)
  try {
    await new Promise((resolve, reject) => {
      const ready = () => { if (stdout.includes('CHILD-READY')) { child.stdout.off('data', ready); resolve() } }
      child.stdout.on('data', ready)
      done.then(() => reject(new Error('Child exited before readiness: ' + stderr)), reject)
    })
    child.kill('SIGTERM')
    assert.deepEqual(await done, { status: null, signal: 'SIGTERM' }, stderr)
  } finally {
    clearTimeout(timer)
    rmSync(root, { recursive: true, force: true })
  }
})
