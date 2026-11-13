import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
  symlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join, relative } from 'node:path'
import { after, test } from 'node:test'
import { loadBuiltRuntime } from './helpers/ink-built-runtime.mjs'

// Test the consumers in the shipped bundle, using real plan metadata and files.
// Run `npm run build` first.
const repoDir = process.cwd()
const tempRoot = realpathSync.native(tmpdir())
const scratch = realpathSync.native(
  mkdtempSync(join(tempRoot, 'tau-plan-consumers-')),
)
const projectDir = join(scratch, 'project')
const configDir = join(scratch, 'config')
mkdirSync(projectDir, { recursive: true })
mkdirSync(configDir, { recursive: true })
writeFileSync(
  join(configDir, 'settings.json'),
  JSON.stringify({ cleanupPeriodDays: 0 }),
)
process.env.CLAUDE_CONFIG_DIR = configDir
process.env.CLAUDE_CODE_TMPDIR = join(scratch, 'tmp')
process.env.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING = '1'
process.env.CLAUDE_CODE_SIMPLE = '1'
process.env.CLAUDEX_DISABLE_MODEL_PRICING = '1'
process.env.DISABLE_TELEMETRY = '1'
delete process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING
process.chdir(projectDir)

after(async () => {
  process.chdir(repoDir)
  const child = relative(tempRoot, scratch)
  assert.ok(
    child && !child.startsWith('..') && !isAbsolute(child),
    'unsafe fixture cleanup path',
  )
  for (let attempt = 0; ; attempt++) {
    try {
      rmSync(scratch, { recursive: true, force: true })
      return
    } catch (error) {
      if (
        attempt >= 50 ||
        !['EPERM', 'EBUSY', 'ENOTEMPTY'].includes(error.code)
      )
        throw error
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
})

const r = await loadBuiltRuntime({
  paths: [
    'src/bootstrap/state.ts',
    'src/utils/plans.ts',
    'src/utils/planFileStorage.ts',
    'src/utils/permissions/filesystem.ts',
    'src/utils/fileHistory.ts',
    'src/tools/FileWriteTool/FileWriteTool.ts',
    'src/tools/FileEditTool/FileEditTool.ts',
  ],
  exports: [
    'getSessionId',
    'setPlanSlug',
    'getPlanFilePath',
    'getPlansDirectory',
    'getPlanHistoryPath',
    'getRetiredPlanPathReplacement',
    'isCurrentSessionPlanFile',
    'renameStoredPlanFile',
    'withPlanFileMutation',
    'withPlanFileLock',
    'checkEditableInternalPath',
    'checkReadableInternalPath',
    'FileWriteTool',
    'FileEditTool',
    'fileHistoryTrackEdit',
    'fileHistoryMakeSnapshot',
    'fileHistoryRewind',
    'fileHistoryGetDiffStatsBetween',
  ],
})

function plan(content = '# Original plan\n') {
  const id = `plan-${randomUUID()}`
  r.setPlanSlug(r.getSessionId(), id)
  const oldPath = r.getPlanFilePath()
  if (content !== null) writeFileSync(oldPath, content)
  return { id, oldPath }
}

async function rename(fixture, title, now = new Date('2026-11-10T15:30:45Z')) {
  const result = await r.renameStoredPlanFile({
    directory: r.getPlansDirectory(),
    planId: fixture.id,
    title,
    now,
    shouldProceed: () => true,
    persistReference: async () => {},
  })
  assert.equal(result.status, 'renamed')
  return result.newPath
}

function history(messageId = randomUUID()) {
  let state = {
    snapshots: [{ messageId, trackedFileBackups: {}, timestamp: new Date() }],
    trackedFiles: new Set(),
    snapshotSequence: 1,
  }
  return {
    get state() {
      return state
    },
    update(updater) {
      state = updater(state)
    },
  }
}

test('current and retired plan aliases follow the actual filesystem case semantics', async () => {
  const fixture = plan()
  const alternate = join(
    r.getPlansDirectory(),
    basename(fixture.oldPath).toUpperCase(),
  )
  const aliases = existsSync(alternate)
  assert.equal(r.isCurrentSessionPlanFile(alternate), aliases)
  const newPath = await rename(fixture, `case-semantics-${randomUUID()}`)
  const currentAlternate = join(
    r.getPlansDirectory(),
    basename(newPath).toUpperCase(),
  )
  assert.equal(r.isCurrentSessionPlanFile(currentAlternate), aliases)
  assert.equal(
    r.getRetiredPlanPathReplacement(alternate),
    aliases ? newPath : undefined,
  )
  if (!aliases) {
    writeFileSync(currentAlternate, '# Separate case-sensitive document\n')
    assert.equal(r.isCurrentSessionPlanFile(currentAlternate), false)
    assert.equal(readFileSync(newPath, 'utf8'), '# Original plan\n')
  }
})

test('plan permissions exclude neighboring titles and timestamp collision files', async () => {
  const first = plan()
  const agentPath = r.getPlanFilePath('worker-1')
  writeFileSync(agentPath, '# Agent plan\n')
  const firstPath = await rename(first, 'fix-oauth-login')
  const second = plan()
  const secondPath = await rename(second, 'fix-oauth-login')
  assert.equal(basename(secondPath), 'fix-oauth-login-20261110T153045Z.md')

  r.setPlanSlug(r.getSessionId(), first.id)
  assert.equal(
    r.getPlanFilePath('worker-1'),
    agentPath,
    'agent namespace stays stable',
  )
  for (const check of [
    r.checkReadableInternalPath,
    r.checkEditableInternalPath,
  ]) {
    assert.equal(check(firstPath, {}).behavior, 'allow')
    assert.equal(check(agentPath, {}).behavior, 'allow')
    for (const otherPath of [
      secondPath,
      join(r.getPlansDirectory(), 'fix-oauth-login-extra.md'),
      join(r.getPlansDirectory(), 'fix-oauth-login-agent-worker-1.md'),
      join(r.getPlansDirectory(), `${first.id}-agent-.md`),
      join(r.getPlansDirectory(), `${first.id}-agent-worker-1`, 'nested.md'),
      first.oldPath,
    ]) {
      assert.equal(check(otherPath, {}).behavior, 'passthrough', otherPath)
    }
  }
})

test('stale Write and Edit calls cannot recreate a retired plan filename', async () => {
  const fixture = plan()
  const newPath = await rename(fixture, 'reject-stale-consumer-paths')
  const context = { readFileState: new Map(), updateFileHistoryState: () => {} }
  const write = { file_path: fixture.oldPath, content: '# Stale replacement\n' }
  const edit = {
    file_path: fixture.oldPath,
    old_string: '',
    new_string: '# Stale replacement\n',
  }
  for (const [tool, input] of [
    [r.FileWriteTool, write],
    [r.FileEditTool, edit],
  ]) {
    const validation = await tool.validateInput(input, context)
    assert.equal(validation.result, false)
    assert.ok(validation.message.includes(newPath), validation.message)
    await assert.rejects(
      tool.call(input, context, undefined, { uuid: randomUUID() }),
      /moved|renamed/,
    )
    assert.equal(existsSync(fixture.oldPath), false)
    assert.equal(readFileSync(newPath, 'utf8'), '# Original plan\n')
  }
})

test('directory aliases preserve exact permissions and cannot bypass retired-path rejection', async () => {
  const fixture = plan()
  const newPath = await rename(fixture, 'directory-alias-plan')
  const alias = join(scratch, `plan-alias-${randomUUID()}`)
  symlinkSync(r.getPlansDirectory(), alias, 'junction')
  const retiredAlias = join(alias, basename(fixture.oldPath))
  const currentAlias = join(alias, basename(newPath))
  assert.equal(r.getRetiredPlanPathReplacement(retiredAlias), newPath)
  assert.equal(r.checkEditableInternalPath(currentAlias, {}).behavior, 'allow')
  await assert.rejects(
    r.withPlanFileMutation(retiredAlias, async () =>
      writeFileSync(retiredAlias, 'wrong'),
    ),
    /moved/,
  )
  assert.equal(existsSync(fixture.oldPath), false)
})

test('a waiting mutation cannot follow a switch to another plan', async () => {
  const fixture = plan('# Keep original bytes\n')
  let release, entered
  const acquired = new Promise(resolve => {
    entered = resolve
  })
  const held = r.withPlanFileLock(
    r.getPlansDirectory(),
    fixture.id,
    async () => {
      entered()
      await new Promise(resolve => {
        release = resolve
      })
    },
  )
  await acquired
  const pending = r.withPlanFileMutation(fixture.oldPath, async () =>
    writeFileSync(fixture.oldPath, 'wrong bytes'),
  )
  const rejected = assert.rejects(pending, /session changed/)
  r.setPlanSlug(r.getSessionId(), `plan-${randomUUID()}`)
  release()
  await held
  await rejected
  assert.equal(readFileSync(fixture.oldPath, 'utf8'), '# Keep original bytes\n')
})

test('renamed plans require a new read before a full replacement', async () => {
  const fixture = plan()
  const newPath = await rename(fixture, 'read-new-plan-path')
  const state = r.getDefaultAppState()
  const context = {
    readFileState: new Map([
      [
        fixture.oldPath,
        {
          content: '# Original plan\n',
          timestamp: Math.floor(statSync(newPath).mtimeMs),
        },
      ],
    ]),
    getAppState: () => state,
    agentId: undefined,
  }
  const input = { file_path: newPath, content: '# New plan\n' }
  const validation = await r.FileWriteTool.validateInput(input, context)
  assert.equal(
    validation.result,
    false,
    'an old-path read must not authorize a new-path replacement',
  )
  assert.equal(readFileSync(newPath, 'utf8'), '# Original plan\n')
})

test(
  'file history keeps one key and restores content at the renamed path',
  { timeout: 15_000 },
  async () => {
    const fixture = plan('# Baseline\n')
    const h = history()
    const first = h.state.snapshots[0].messageId
    await r.fileHistoryTrackEdit(h.update, fixture.oldPath, first)
    const originalKey = [...h.state.trackedFiles][0]
    const originalBackup =
      h.state.snapshots[0].trackedFileBackups[originalKey].backupFileName
    const newPath = await rename(fixture, 'rewind-renamed-plan')
    assert.equal(r.getPlanHistoryPath(newPath), fixture.oldPath)

    const second = randomUUID()
    await r.fileHistoryMakeSnapshot(h.update, second)
    assert.equal(
      h.state.snapshots.at(-1).trackedFileBackups[originalKey].backupFileName,
      originalBackup,
    )
    await r.fileHistoryTrackEdit(h.update, newPath, second)
    assert.deepEqual([...h.state.trackedFiles], [originalKey])
    writeFileSync(newPath, '# Changed after approval\n')
    await r.fileHistoryMakeSnapshot(h.update, randomUUID())
    const newBackup =
      h.state.snapshots.at(-1).trackedFileBackups[originalKey].backupFileName
    assert.equal(
      newBackup.split('@')[0],
      originalBackup.split('@')[0],
      'backup identity stays stable',
    )
    assert.notEqual(newBackup, originalBackup)
    assert.equal(
      readFileSync(
        join(configDir, 'file-history', r.getSessionId(), originalBackup),
        'utf8',
      ),
      '# Baseline\n',
    )

    const changes = await r.fileHistoryGetDiffStatsBetween(
      h.state,
      first,
      undefined,
    )
    assert.deepEqual(changes.filesChanged, [newPath])
    await r.fileHistoryRewind(h.update, first)
    assert.equal(readFileSync(newPath, 'utf8'), '# Baseline\n')
    assert.equal(
      existsSync(fixture.oldPath),
      false,
      'rewind must not resurrect the old filename',
    )
  },
)

test(
  'rewinding plan creation deletes the renamed file without reviving the old one',
  { timeout: 15_000 },
  async () => {
    const fixture = plan(null)
    const h = history()
    const first = h.state.snapshots[0].messageId
    await r.fileHistoryTrackEdit(h.update, fixture.oldPath, first)
    writeFileSync(fixture.oldPath, '# Created plan\n')
    const newPath = await rename(fixture, 'rewind-plan-creation')
    await r.fileHistoryMakeSnapshot(h.update, randomUUID())
    await r.fileHistoryRewind(h.update, first)
    assert.equal(existsSync(newPath), false)
    assert.equal(existsSync(fixture.oldPath), false)
  },
)

test(
  'a plan mutation finishes before its filename is published',
  { timeout: 15_000 },
  async () => {
    const fixture = plan()
    let release
    let entered
    const started = new Promise(resolve => {
      entered = resolve
    })
    const gate = new Promise(resolve => {
      release = resolve
    })
    const mutation = r.withPlanFileMutation(fixture.oldPath, async () => {
      entered()
      await gate
      writeFileSync(fixture.oldPath, '# Last plan edit\n')
    })
    await started
    let renameSettled = false
    const renamed = rename(fixture, 'serialize-plan-mutations').finally(() => {
      renameSettled = true
    })
    await new Promise(resolve => setTimeout(resolve, 40))
    assert.equal(
      renameSettled,
      false,
      'rename must wait for the in-flight mutation',
    )
    release()
    await mutation
    const newPath = await renamed
    assert.equal(readFileSync(newPath, 'utf8'), '# Last plan edit\n')
    assert.equal(existsSync(fixture.oldPath), false)
  },
)
