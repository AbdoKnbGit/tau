import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixtureContext, loadMcpRuntime } from './helpers/mcp-built-runtime.mjs'

// /simplify fans out to four review agents only where the caller has the Agent
// tool. Cheap mode drops that tool, and so does every subagent (/batch workers
// run /simplify), so both get the single-pass prompt instead of being told to
// launch agents they cannot spawn.
// Run after `node build.mjs`: node --test test/simplify-variants.test.mjs
const testDirectory = mkdtempSync(join(tmpdir(), 'tau-simplify-variants-'))
process.env.CLAUDE_CONFIG_DIR = testDirectory
test.after(() => rmSync(testDirectory, { recursive: true, force: true }))

const r = await loadMcpRuntime({
  paths: ['src/skills/bundledSkills.ts', 'src/skills/bundled/simplify.ts'],
  exports: ['registerSimplifySkill', 'getBundledSkills'],
})
r.registerSimplifySkill()
const simplify = r.getBundledSkills().find(command => command.name === 'simplify')

async function promptFor(toolNames, args = '') {
  const blocks = await simplify.getPromptForCommand(args, fixtureContext(toolNames.map(name => ({ name }))))
  assert.equal(blocks.length, 1)
  return blocks[0].text
}

const ANGLES = ['### Reuse', '### Simplification', '### Efficiency', '### Altitude']
const FAN_OUT = 'Launch **4 independent review agents** via the Agent tool'
const SINGLE_PASS = "The Agent tool isn't available in this context"

test('the Agent tool selects the four-agent fan-out', async () => {
  const text = await promptFor(['Bash', 'Read', 'Agent'])
  assert.ok(text.includes(FAN_OUT))
  assert.ok(!text.includes(SINGLE_PASS))
  for (const angle of ANGLES) assert.ok(text.includes(angle), angle)
})

test('without the Agent tool the review runs in one pass', async () => {
  // Cheap mode's core tools and a subagent's tools both lack Agent.
  const text = await promptFor(['Bash', 'Glob', 'Grep', 'Read', 'Edit'])
  assert.ok(text.includes(SINGLE_PASS))
  assert.ok(text.includes('single-pass review done without the Agent tool'))
  assert.ok(!text.includes(FAN_OUT))
  for (const angle of ANGLES) assert.ok(text.includes(angle), angle)
})

test('an argument becomes the review target or extra focus', async () => {
  const text = await promptFor(['Agent'], '  src/parser.ts  ')
  assert.ok(text.includes('Argument: src/parser.ts\nIf it is a PR number, an existing branch, or an existing file path, review that instead'))
  // "my brunch" once widened the review to every file on the branch.
  assert.ok(text.includes('Anything else is extra focus only, and the scope stays the diff.'))
  assert.ok(!(await promptFor(['Agent'])).includes('Argument:'))
})

test('the review stays inside its scope and the project', async () => {
  // A live run's Altitude agent searched the whole home folder for the skill,
  // and fixes landed in files outside the diff.
  for (const tools of [['Agent'], ['Bash']]) {
    const text = await promptFor(tools)
    assert.ok(text.includes('never review or edit them, and never search outside the project'))
    assert.ok(text.includes('change observable behavior (what users or callers see or get)'))
    // A live run removed a state setter that two handlers still called.
    assert.ok(text.includes('Before removing or renaming anything, find every use of it.'))
  }
  const fanOut = await promptFor(['Agent'])
  assert.ok(fanOut.includes('Give each a complete, self-contained brief'))
  // A review agent once ran /simplify itself through the Skill tool.
  assert.ok(fanOut.includes('report findings only, never edit files or run skills'))
  assert.ok(fanOut.includes('If an agent fails or returns no report, review its angle yourself and say so'))
})

test('the same tools give the same prompt, which names no missing command', async () => {
  for (const tools of [['Agent'], ['Bash']]) {
    const text = await promptFor(tools)
    assert.equal(await promptFor(tools), text)
    assert.ok(!text.includes('/code-review'))
    // PowerShell reads a bare @{...} as a hashtable.
    assert.ok(text.includes("git diff '@{upstream}...HEAD'"))
  }
})
