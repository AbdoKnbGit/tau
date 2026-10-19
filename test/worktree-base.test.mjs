import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, test } from 'node:test'
import { loadBuiltRuntime } from './helpers/ink-built-runtime.mjs'

// Run after npm run build. Exercise shipped functions and the actual Git
// executable; every repository, remote, hook, and settings file is temporary.
const originalCwd = process.cwd()
const scratch = mkdtempSync(join(tmpdir(), 'tau worktree bases-'))
process.env.CLAUDE_CONFIG_DIR = join(scratch, 'config')
process.env.CLAUDE_CODE_TMPDIR = join(scratch, 'tmp')
process.env.GIT_CONFIG_NOSYSTEM = '1'
process.env.GIT_CONFIG_GLOBAL = join(scratch, 'gitconfig')
writeFileSync(process.env.GIT_CONFIG_GLOBAL, '')

const r = await loadBuiltRuntime({
  paths: ['src/utils/worktree.ts', 'src/tools/EnterWorktreeTool/EnterWorktreeTool.ts'],
  exports: [
    'getOrCreateWorktree', 'createWorktreeForSession', 'createAgentWorktree',
    'resolveWorktreeBase', 'restoreWorktreeSession', 'EnterWorktreeTool',
    'findCanonicalGitRoot',
    'setCwd', 'getCwd', 'setOriginalCwd', 'setProjectRoot', 'runWithCwdOverride',
    'updateSettingsForSource', 'getInitialSettings', 'resetSettingsCache',
    'resetGitFileWatcher: () => gitWatcher.reset()',
    // Observe commands / move a ref at the resolution-to-add boundary while
    // still executing the unmodified production Git runner underneath.
    `instrumentGit: callback => {
      const original = execFileNoThrowWithCwd;
      execFileNoThrowWithCwd = async (file, args, options) => {
        await callback(args, options);
        return original(file, args, options);
      };
      return () => { execFileNoThrowWithCwd = original; };
    }`,
  ],
})

after(async () => {
  r.resetGitFileWatcher()
  process.chdir(originalCwd)
  r.setCwd(originalCwd)
  assert.ok(resolve(scratch).startsWith(join(resolve(tmpdir()), 'tau worktree bases-')))
  // Windows may briefly retain handles after Git/settings children exit.
  for (let attempt = 0; ; attempt++) {
    try { rmSync(scratch, { recursive: true, force: true }); break }
    catch (error) {
      if (attempt >= 50 || !['EPERM', 'EBUSY', 'ENOTEMPTY'].includes(error.code)) throw error
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
})

function git(cwd, ...args) {
  return execFileSync('git', [
    '-c', 'core.hooksPath=', '-c', 'commit.gpgSign=false',
    '-c', 'user.name=Tau worktree test', '-c', 'user.email=test@example.invalid',
    ...args,
  ], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}
let serial = 0
function repo({ empty = false } = {}) {
  const path = join(scratch, `repo ${serial++}`)
  mkdirSync(path)
  git(path, 'init', '-b', 'main')
  if (!empty) commit(path, 'initial')
  return path
}
function commit(path, value, filename = 'version.txt') {
  writeFileSync(join(path, filename), `${value}\n`)
  git(path, 'add', '--', filename)
  git(path, 'commit', '-m', value)
  return git(path, 'rev-parse', 'HEAD')
}
function context(path, settings = {}) {
  r.restoreWorktreeSession(null)
  r.setCwd(path)
  r.setOriginalCwd(path)
  r.setProjectRoot(path)
  r.resetSettingsCache()
  const result = r.updateSettingsForSource('localSettings', { worktree: settings })
  assert.equal(result.error, null)
}
function create(path, name, extra = {}) {
  return r.getOrCreateWorktree(path, name, { sourceCwd: path, ...extra })
}
function head(path) { return git(path, 'rev-parse', 'HEAD') }
function assertSamePath(actual, expected, message) {
  // Git and Tau may resolve symlinks or Windows 8.3 names differently.
  // Compare real directories, while still rejecting a different checkout.
  assert.equal(realpathSync.native(actual), realpathSync.native(expected), message)
}
function remoteFixture() {
  const publisher = repo()
  const remote = join(scratch, `remote ${serial++}.git`)
  git(scratch, 'clone', '--bare', publisher, remote)
  git(publisher, 'remote', 'add', 'origin', remote)
  const client = join(scratch, `client ${serial++}`)
  git(scratch, 'clone', '--single-branch', remote, client)
  return { publisher, remote, client }
}

test('HEAD includes six unpushed commits, stays offline, and ignores dirty files', async () => {
  const path = repo()
  git(path, 'update-ref', 'refs/remotes/origin/main', head(path))
  git(path, 'remote', 'add', 'origin', join(scratch, 'offline.git'))
  for (let i = 1; i <= 6; i++) commit(path, `local-${i}`)
  const expected = head(path)
  writeFileSync(join(path, 'version.txt'), 'staged but not committed\n')
  git(path, 'add', 'version.txt')
  writeFileSync(join(path, 'untracked.txt'), 'not committed')
  context(path)
  const commands = []
  const stop = r.instrumentGit(args => commands.push(args))
  try {
    const created = await create(path, 'six-ahead')
    assert.equal(created.headCommit, expected)
    assert.equal(head(created.worktreePath), expected)
    assert.equal(readFileSync(join(created.worktreePath, 'version.txt'), 'utf8'), 'local-6\n')
    assert.equal(existsSync(join(created.worktreePath, 'untracked.txt')), false)
    assert.equal(commands.some(args => args[0] === 'fetch'), false)
  } finally { stop() }
})

test('session and EnterWorktree preserve the caller HEAD from a linked worktree subdirectory', async () => {
  const path = repo()
  const linked = join(scratch, `linked ${serial++}`)
  git(path, 'worktree', 'add', '-b', 'feature', linked)
  const expected = commit(linked, 'feature-only')
  const subdir = join(linked, 'sub dir')
  mkdirSync(subdir)
  context(path, { base: 'remote-default' })
  context(subdir, { base: 'head', remote: 'upstream' })
  const session = await r.createWorktreeForSession('test-session', 'from-linked')
  assertSamePath(session.originalCwd, subdir)
  assert.equal(session.originalHeadCommit, expected)
  assert.equal(head(session.worktreePath), expected)
  assertSamePath(session.worktreePath, join(path, '.claude', 'worktrees', 'from-linked'))
  assertSamePath(r.getCwd(), subdir, 'creation does not change ambient cwd')
  assert.deepEqual(JSON.parse(readFileSync(join(session.worktreePath, '.claude', 'settings.local.json'), 'utf8')).worktree,
    { base: 'head', remote: 'upstream' }, 'inherit the caller settings, not the canonical checkout settings')
  context(subdir)
  try {
    const result = await r.EnterWorktreeTool.call({ name: 'tool-linked' })
    assert.equal(result.data.baseCommit, expected)
    assert.equal(result.data.baseRef, 'HEAD')
    assert.equal(result.data.resumed, false)
    assert.equal(head(result.data.worktreePath), expected)
    assert.match(result.data.message, new RegExp(expected))
  } finally { process.chdir(originalCwd) }
})

test('concurrent subagents use their own async cwd, without sharing HEAD or cwd', async () => {
  const path = repo()
  const linked = [join(scratch, `agent ${serial++}`), join(scratch, `agent ${serial++}`)]
  const expected = linked.map((dir, i) => {
    git(path, 'worktree', 'add', '-b', `feature-${i}`, dir)
    return commit(dir, `agent-${i}`)
  })
  context(path)
  const results = await Promise.all(linked.map((dir, i) =>
    r.runWithCwdOverride(dir, () => r.createAgentWorktree(`child-${i}`))))
  results.forEach((result, i) => {
    assert.equal(result.headCommit, expected[i])
    assert.equal(head(result.worktreePath), expected[i])
    assert.equal(result.snapshotBased, undefined)
  })
  assertSamePath(r.getCwd(), path)
})

test('linked worktrees keep their canonical repository through a directory alias', () => {
  const path = repo()
  const linked = join(scratch, `linked alias target ${serial++}`)
  git(path, 'worktree', 'add', '-b', 'alias-feature', linked)
  const alias = join(scratch, `directory alias ${serial++}`)
  symlinkSync(linked, alias, process.platform === 'win32' ? 'junction' : 'dir')
  assertSamePath(r.findCanonicalGitRoot(alias), path)
})

test('Windows short paths still resolve linked worktrees to the main repository', {
  skip: process.platform !== 'win32',
}, t => {
  const path = repo()
  const linked = join(scratch, `linked short path ${serial++}`)
  git(path, 'worktree', 'add', '-b', 'short-path-feature', linked)
  const shortPath = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '$fso = New-Object -ComObject Scripting.FileSystemObject; $fso.GetFolder($env:TAU_TEST_PATH).ShortPath'],
  { encoding: 'utf8', env: { ...process.env, TAU_TEST_PATH: linked } }).trim()
  if (shortPath === realpathSync.native(linked)) {
    t.skip('8.3 names are disabled on this volume')
    return
  }
  assertSamePath(r.findCanonicalGitRoot(shortPath), path)
})

test('canonical repository validation rejects a borrowed worktree entry and a forged common directory', () => {
  const trusted = repo()
  const linked = join(scratch, `trusted linked ${serial++}`)
  git(trusted, 'worktree', 'add', '-b', 'trusted-feature', linked)

  const borrowed = join(scratch, `borrowed ${serial++}`)
  mkdirSync(borrowed)
  writeFileSync(join(borrowed, '.git'), readFileSync(join(linked, '.git')))
  assertSamePath(r.findCanonicalGitRoot(borrowed), borrowed, 'the reciprocal link must match')

  const forged = join(scratch, `forged ${serial++}`)
  const entry = join(forged, 'fake-entry')
  mkdirSync(entry, { recursive: true })
  writeFileSync(join(forged, '.git'), `gitdir: ${entry}\n`)
  writeFileSync(join(entry, 'commondir'), `${join(trusted, '.git')}\n`)
  writeFileSync(join(entry, 'gitdir'), `${join(forged, '.git')}\n`)
  assertSamePath(r.findCanonicalGitRoot(forged), forged, 'the entry must live inside the common directory')
})

test('HEAD is read fresh after commits, supports packed refs and detached HEAD, without a remote', async () => {
  const path = repo()
  context(path)
  const first = await create(path, 'first')
  const next = commit(path, 'after-first')
  git(path, 'pack-refs', '--all')
  const second = await create(path, 'second')
  assert.notEqual(first.headCommit, second.headCommit)
  assert.equal(second.headCommit, next)
  git(path, 'checkout', '--detach', first.headCommit)
  assert.equal((await create(path, 'detached')).headCommit, first.headCommit)
})

test('creation pins its SHA even if HEAD moves between resolution and git worktree add', async () => {
  const path = repo()
  context(path)
  const expected = head(path)
  const stop = r.instrumentGit(args => {
    if (args[0] === 'worktree' && args[1] === 'add') commit(path, 'concurrent-commit')
  })
  try {
    const created = await create(path, 'pinned')
    assert.notEqual(head(path), expected)
    assert.equal(created.headCommit, expected)
    assert.equal(head(created.worktreePath), expected)
  } finally { stop() }
})

test('remote default is fresh after advance and rename, despite stale/narrow/packed tracking refs', async () => {
  const { publisher, remote, client } = remoteFixture()
  const stale = head(client)
  git(client, 'pack-refs', '--all')
  git(publisher, 'checkout', '-b', 'release/next')
  const expected = commit(publisher, 'new-default')
  git(publisher, 'push', 'origin', 'release/next')
  git(remote, 'symbolic-ref', 'HEAD', 'refs/heads/release/next')
  const fetchHead = join(client, '.git', 'FETCH_HEAD')
  writeFileSync(fetchHead, 'another operation owns FETCH_HEAD\n')
  context(client, { base: 'remote-default' })
  const created = await create(client, 'fresh')
  assert.equal(created.headCommit, expected)
  assert.equal(head(created.worktreePath), expected)
  assert.equal(git(client, 'rev-parse', 'origin/main'), stale)
  assert.equal(readFileSync(fetchHead, 'utf8'), 'another operation owns FETCH_HEAD\n')
  assert.equal(git(client, 'for-each-ref', '--format=%(refname)', 'refs/tau/worktree-bases/'), '')
  const newer = commit(publisher, 'newer-default')
  git(publisher, 'push', 'origin', 'release/next')
  assert.equal((await create(client, 'fresh-again')).headCommit, newer)
})

test('config changes take effect immediately and support a custom Git remote', async () => {
  const { publisher, client } = remoteFixture()
  git(client, 'remote', 'rename', 'origin', 'upstream')
  const local = commit(client, 'local-only')
  const upstream = commit(publisher, 'upstream-only')
  git(publisher, 'push', 'origin', 'main')
  context(client, { remote: 'upstream' })
  assert.equal(r.getInitialSettings().worktree.base, undefined)
  assert.equal((await create(client, 'local')).headCommit, local)
  assert.equal(r.updateSettingsForSource('localSettings', { worktree: { base: 'remote-default' } }).error, null)
  assert.equal((await create(client, 'upstream')).headCommit, upstream)
  assert.equal(r.getInitialSettings().worktree.remote, 'upstream')
  assert.equal(r.updateSettingsForSource('localSettings', { worktree: { base: 'head' } }).error, null)
  assert.equal((await create(client, 'back-to-head')).headCommit, local)
})

test('remote failure never substitutes cached HEAD or a subagent snapshot; resume stays offline', async () => {
  const { client } = remoteFixture()
  context(client)
  const original = await create(client, 'resume-me')
  const resumedHead = commit(original.worktreePath, 'worktree-progress')
  git(client, 'remote', 'set-url', 'origin', join(scratch, 'unreachable.git'))
  assert.equal(r.updateSettingsForSource('localSettings', { worktree: { base: 'remote-default' } }).error, null)
  await assert.rejects(create(client, 'must-fail'), /No cached commit was used/)
  await assert.rejects(r.createAgentWorktree('must-fail-agent'), /No cached commit was used/)
  assert.equal(existsSync(join(client, '.claude', 'worktrees', 'must-fail')), false)
  const resumed = await create(client, 'resume-me')
  assert.equal(resumed.existed, true)
  assert.equal(resumed.headCommit, resumedHead)
  assert.equal(git(client, 'for-each-ref', '--format=%(refname)', 'refs/tau/worktree-bases/'), '')
})

test('concurrent PR fetches override the preference without racing through FETCH_HEAD', async () => {
  const { publisher, remote, client } = remoteFixture()
  const first = head(publisher)
  const second = commit(publisher, 'other-pr')
  git(publisher, 'push', 'origin', `${first}:refs/pull/11/head`, `${second}:refs/pull/12/head`)
  assert.equal(git(remote, 'rev-parse', 'refs/pull/12/head'), second)
  context(client, { base: 'head' })
  writeFileSync(join(client, '.git', 'FETCH_HEAD'), 'untouched\n')
  const results = await Promise.all([create(client, 'pr-one', { prNumber: 11 }), create(client, 'pr-two', { prNumber: 12 })])
  assert.deepEqual(results.map(result => result.headCommit), [first, second])
  results.forEach((result, i) => assert.equal(head(result.worktreePath), [first, second][i]))
  assert.equal(readFileSync(join(client, '.git', 'FETCH_HEAD'), 'utf8'), 'untouched\n')
  assert.equal(git(client, 'for-each-ref', '--format=%(refname)', 'refs/tau/worktree-bases/'), '')
  await assert.rejects(create(client, 'missing-pr', { prNumber: 999 }), /Cannot fetch/)
})

test('unborn HEAD fails clearly and never falls back to copying a dirty repository', async () => {
  const path = repo({ empty: true })
  context(path)
  await assert.rejects(create(path, 'empty'), /must have a commit/)
  await assert.rejects(r.createAgentWorktree('empty-agent'), /must have a commit/)
  assert.equal(existsSync(join(path, '.claude', 'worktrees')), false)
})

test('a preexisting worktree branch is never reset or silently replaced by a snapshot', async () => {
  const path = repo()
  context(path)
  const saved = head(path)
  git(path, 'branch', 'worktree-collision', saved)
  commit(path, 'newer-main')
  await assert.rejects(create(path, 'collision'), /already exists/)
  await assert.rejects(r.createAgentWorktree('collision'), /already exists/)
  assert.equal(git(path, 'rev-parse', 'worktree-collision'), saved)
})

test('sparse checkout uses the same resolved commit and reports it accurately', async () => {
  const path = repo()
  mkdirSync(join(path, 'included'))
  mkdirSync(join(path, 'excluded'))
  commit(path, 'included', 'included/file.txt')
  const expected = commit(path, 'excluded', 'excluded/file.txt')
  context(path, { sparsePaths: ['included'] })
  const created = await create(path, 'sparse')
  assert.equal(created.headCommit, expected)
  assert.equal(head(created.worktreePath), expected)
  assert.equal(existsSync(join(created.worktreePath, 'included', 'file.txt')), true)
  assert.equal(existsSync(join(created.worktreePath, 'excluded', 'file.txt')), false)
})

test('SHA-256 repository creation and resume retain the full object ID', async t => {
  const path = join(scratch, `sha256 ${serial++}`)
  mkdirSync(path)
  try { git(path, 'init', '-b', 'main', '--object-format=sha256') }
  catch { t.skip('installed Git does not support SHA-256 repositories'); return }
  const expected = commit(path, 'sha256')
  context(path)
  const created = await create(path, 'sha256')
  assert.equal(expected.length, 64)
  assert.equal(created.headCommit, expected)
  assert.equal(head(created.worktreePath), expected)
  assert.equal((await create(path, 'sha256')).existed, true)
})

test('reftable worktrees resume through Git without depending on loose/packed ref files', async t => {
  const path = join(scratch, `reftable ${serial++}`)
  mkdirSync(path)
  try { git(path, 'init', '-b', 'main', '--ref-format=reftable') }
  catch { t.skip('installed Git does not support reftable'); return }
  commit(path, 'reftable')
  context(path)
  const created = await create(path, 'reftable')
  const expected = commit(created.worktreePath, 'worktree-progress')
  const resumed = await create(path, 'reftable')
  assert.equal(resumed.existed, true)
  assert.equal(resumed.headCommit, expected)
})

test('a failed EnterWorktree leaves the caller directory and session untouched', async () => {
  const path = repo()
  const subdir = join(path, 'sub dir')
  mkdirSync(subdir)
  context(subdir, { base: 'remote-default' })
  const processCwd = process.cwd()
  await assert.rejects(r.EnterWorktreeTool.call({ name: 'failed-tool' }), /Cannot fetch/)
  assert.equal(process.cwd(), processCwd)
  assertSamePath(r.getCwd(), subdir)
  assert.equal(existsSync(join(path, '.claude', 'worktrees', 'failed-tool')), false)
})
