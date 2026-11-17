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
  assert.ok(text.includes('Argument: src/parser.ts\nIf it is a PR number, branch name, or file path, review that target instead.'))
  assert.ok(!(await promptFor(['Agent'])).includes('Argument:'))
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
