import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadMcpRuntime } from './helpers/mcp-built-runtime.mjs'

// The environment block states the session root. A cd inside the project
// moves only the shell: the block, and the prompt cache behind it, stay as
// they are and the cwd_awareness reminder reports the folder. EnterWorktree and
// ExitWorktree move the root, so the block follows them.
// Run after `node build.mjs`: node --test test/env-working-directory.test.mjs
const testDirectory = mkdtempSync(join(tmpdir(), 'tau-env-cwd-'))
process.env.CLAUDE_CONFIG_DIR = join(testDirectory, 'config')
test.after(() => rmSync(testDirectory, { recursive: true, force: true }))

const r = await loadMcpRuntime({
  paths: ['src/utils/Shell.ts', 'src/utils/attachments.ts', 'src/lanes/shared/working_directory.ts'],
  exports: ['computeSimpleEnvInfo', 'computeCheapEnvInfo', 'setCwd', 'getCwd', 'setOriginalCwd', 'getOriginalCwd',
    'getCwdAwarenessAttachment', 'statedWorkingDirectory'],
})

const project = join(testDirectory, 'project')
const assets = join(project, 'assets')
const worktree = join(project, '.claude', 'worktrees', 'probe')
for (const dir of [assets, worktree]) mkdirSync(dir, { recursive: true })
const blocks = async () => [await r.computeSimpleEnvInfo('test-model'), await r.computeCheapEnvInfo('test-model')]

test('a cd inside the project leaves the environment block unchanged', async () => {
  r.setCwd(project)
  r.setOriginalCwd(r.getCwd())
  const root = r.getOriginalCwd()
  const before = await blocks()
  for (const block of before) assert.equal(r.statedWorkingDirectory(block), root)
  assert.deepEqual(r.getCwdAwarenessAttachment(), [])

  r.setCwd(assets)
  assert.notEqual(r.getCwd(), root)
  assert.deepEqual(await blocks(), before)
  // The model still learns where the shell is.
  assert.deepEqual(r.getCwdAwarenessAttachment(), [{ type: 'cwd_awareness', currentCwd: r.getCwd(), originalCwd: root }])
})

test('EnterWorktree and ExitWorktree move the stated directory', async () => {
  r.setCwd(project)
  r.setOriginalCwd(r.getCwd())
  const root = r.getOriginalCwd()
  // What EnterWorktree does: move the shell, then the root.
  r.setCwd(worktree)
  r.setOriginalCwd(r.getCwd())
  for (const block of await blocks()) assert.equal(r.statedWorkingDirectory(block), r.getCwd())
  // What ExitWorktree does: back to the project.
  r.setCwd(root)
  r.setOriginalCwd(root)
  for (const block of await blocks()) assert.equal(r.statedWorkingDirectory(block), root)
})
