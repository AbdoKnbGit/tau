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
  nodeEndOfLifeMessage,
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
})

test('the Windows warning names the version that fixes the bug on the same line', () => {
  const now = new Date('2026-10-30')
  const windows = version => nodeRuntimeMessage(version, 'windows-shutdown', now)
  assert.match(windows('v24.19.0'), /Node\.js v24\.19\.0 has a Windows bug/)
  assert.match(windows('v24.19.0'), /Update to Node\.js 24\.20 or newer/)
  assert.match(windows('v26.6.0'), /Update to Node\.js 26\.7 or newer/)
  // These lines ended without the fix, so they go to a supported line instead.
  assert.match(windows('v25.9.0'), /Update to Node\.js 24 LTS/)
  assert.match(windows('v23.11.0'), /Update to Node\.js 24 LTS/)
  assert.match(windows('v24.19.0'), /https:\/\/nodejs\.org/)
  assert.match(nodeRuntimeMessage('v20.18.0', 'require-esm', now), /Install Node\.js 24 LTS from https:\/\/nodejs\.org/)
})

test('a release line is only called unsupported once it has ended', () => {
  const now = new Date('2026-10-30')
  assert.match(nodeEndOfLifeMessage('v20.19.0', now), /Node\.js v20\.19\.0 stopped getting security updates on 2026-04-30\. Update to Node\.js 24 LTS/)
  assert.match(nodeEndOfLifeMessage('v25.9.0', now), /stopped getting security updates/)
  for (const version of ['v22.12.0', 'v24.22.2', 'v26.13.0', 'v27.0.0', 'bad'])
    assert.equal(nodeEndOfLifeMessage(version, now), '', version)
  assert.equal(nodeEndOfLifeMessage('v22.12.0', new Date('2027-04-30')), '', 'Still supported on its last day')
  assert.match(nodeEndOfLifeMessage('v22.12.0', new Date('2027-05-01')), /on 2027-04-30/)
  // The recommendation moves on by itself when the line it names ends.
  assert.match(nodeEndOfLifeMessage('v24.22.2', new Date('2028-05-01')), /Update to Node\.js 26 LTS/)
  assert.match(nodeEndOfLifeMessage('v26.13.0', new Date('2029-05-01')), /Update to the current Node\.js LTS/)
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
    // Node's own off switch, so the run on the good runtime can be told apart from a warning.
    const result = spawnSync(process.execPath, [cli, ...args], {
      cwd: root, encoding: 'utf8', windowsHide: true,
      env: { ...process.env, TAU_SKIP_PREFLIGHT: '1', TAU_RUNTIME_TEST_VALUE: 'preserved', NODE_NO_WARNINGS: '1' },
      timeout: 10_000,
    })
    assert.equal(result.status, 7, result.stderr)
    assert.equal(result.stderr, '', 'A restart onto a good runtime has nothing to warn about')
    const reported = JSON.parse(result.stdout)
    // Temporary directories may use a symlink alias for the same working directory.
    assert.deepEqual({ ...reported, cwd: realpathSync(reported.cwd) }, {
      args, cwd: realpathSync(root), env: 'preserved', restarted: '1',
    })
    const continued = spawnSync(process.execPath, [cli, ...args], {
      cwd: root, encoding: 'utf8', windowsHide: true,
      env: { ...process.env, NODE_NO_WARNINGS: undefined, TAU_SKIP_PREFLIGHT: '1', TAU_RUNTIME_TEST_NO_ALTERNATIVE: '1' }, timeout: 10_000,
    })
    assert.equal(continued.status, 7, continued.stderr)
    assert.match(continued.stderr, /Windows bug/, 'With no alternative the user has to be told to update')
    assert.deepEqual(JSON.parse(continued.stdout).args, args, 'The warning stays out of stdout, and an affected Windows runtime remains usable')
    const silenced = spawnSync(process.execPath, [cli, ...args], {
      cwd: root, encoding: 'utf8', windowsHide: true,
      env: { ...process.env, NODE_NO_WARNINGS: '1', TAU_SKIP_PREFLIGHT: '1', TAU_RUNTIME_TEST_NO_ALTERNATIVE: '1' }, timeout: 10_000,
    })
    assert.equal(silenced.status, 7, silenced.stderr)
    assert.equal(silenced.stderr, '', 'NODE_NO_WARNINGS=1 turns the warning off')
    const failedAlternative = spawnSync(process.execPath, [cli, ...args], {
      cwd: root, encoding: 'utf8', windowsHide: true,
      env: { ...process.env, NODE_NO_WARNINGS: undefined, TAU_SKIP_PREFLIGHT: '1', TAU_RUNTIME_TEST_BAD_ALTERNATIVE: join(root, 'missing-node') }, timeout: 10_000,
    })
    assert.equal(failedAlternative.status, 7, failedAlternative.stderr)
    assert.match(failedAlternative.stderr, /Windows bug/, 'An unavailable alternative leaves the user on the affected runtime')
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
