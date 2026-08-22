/**
 * Cheap prompt/memory regression contract.
 * Run: bun run src/constants/prompts.compaction.test.ts
 */
import assert from 'node:assert/strict'
import { buildCheapStaticPromptSections } from './prompts.js'
import {
  buildCompactMemoryLines,
  buildMemoryLines,
  COMPACT_SELF_LEARNING_OFFER_GUIDANCE,
} from '../memdir/memdir.js'
import {
  buildCombinedMemoryPrompt,
  buildCompactCombinedMemoryPrompt,
} from '../memdir/teamMemPrompts.js'

const cheapTools = new Set([
  'Bash',
  'TodoWrite',
  'Read',
  'Edit',
  'Write',
  'Glob',
  'Grep',
  'AskUserQuestion',
  'NotebookEdit',
  'EnterPlanMode',
  'ExitPlanMode',
  'Snapshot',
  'WebFetch',
  'WebSearch',
])

const staticSections = buildCheapStaticPromptSections(
  cheapTools,
  'Test style',
)
const staticPrompt = staticSections.join('\n\n')
const staticBytes = Buffer.byteLength(staticPrompt)

assert.match(staticPrompt, /authorized security testing/)
assert.match(staticPrompt, /Follow the "Test style" output style/)
assert.match(staticPrompt, /denied, do not repeat it unchanged/)
assert.match(staticPrompt, /prompt injection/)
assert.match(staticPrompt, /Read the exact existing file in this session before/)
assert.match(staticPrompt, /no unrelated features\/refactors/)
assert.match(staticPrompt, /Never blindly repeat a failed, denied, or already-completed action/)
assert.match(staticPrompt, /verify the working directory and relevant manifest/)
assert.match(staticPrompt, /report actual results faithfully/)
assert.match(staticPrompt, /user misconception or adjacent bug/)
assert.match(staticPrompt, /local, reversible actions/)
assert.match(staticPrompt, /exact action and scope\. One approval never generalizes/)
assert.match(staticPrompt, /never guess parameter names or unsupported actions/)
assert.match(staticPrompt, /update an item as soon as its state changes/)
assert.match(staticPrompt, /independent tool calls in parallel/)
assert.match(staticPrompt, /Subagents\/delegation, skills, plugins, MCP, and LSP are off/)
assert.match(staticPrompt, /notebooks.*plan mode.*snapshots.*web fetch/s)
assert.match(staticPrompt, /preserve required evidence, caveats, decisions, and next steps/)
assert.match(staticPrompt, /file_path:line_number/)
assert.ok(staticBytes <= 5_000, `cheap static prompt is ${staticBytes} bytes`)
assert.deepEqual(
  buildCheapStaticPromptSections(cheapTools, 'Test style'),
  staticSections,
  'same inputs must render a cache-stable prefix',
)

const noCoding = buildCheapStaticPromptSections(
  cheapTools,
  undefined,
  false,
).join('\n\n')
assert.doesNotMatch(noCoding, /# Work contract/)
assert.match(noCoding, /# Safety and authorization/)
assert.match(noCoding, /# Tool contract/)

const replPrompt = buildCheapStaticPromptSections(
  cheapTools,
  undefined,
  true,
  true,
).join('\n\n')
assert.match(replPrompt, /In REPL mode, use the REPL documented interface/)
assert.doesNotMatch(replPrompt, /Read for reads/)
assert.doesNotMatch(replPrompt, /Edit for edits/)
assert.doesNotMatch(replPrompt, /Write for creation/)
assert.doesNotMatch(replPrompt, /Glob\/Grep for search/)
assert.doesNotMatch(replPrompt, /Bash only for shell/)

const minimalPrompt = buildCheapStaticPromptSections(
  new Set(['Bash']),
  undefined,
  true,
  false,
).join('\n\n')
assert.doesNotMatch(minimalPrompt, /AskUserQuestion/)
assert.doesNotMatch(minimalPrompt, /Read for reads/)
assert.doesNotMatch(minimalPrompt, /Edit for edits/)
assert.doesNotMatch(minimalPrompt, /Write for creation/)
assert.doesNotMatch(minimalPrompt, /Glob\/Grep for search/)
assert.match(minimalPrompt, /Bash only for shell\/system commands/)
assert.match(minimalPrompt, /When their matching tools are listed/)
assert.match(minimalPrompt, /never invent a missing capability/)

const memoryDir = '/tmp/tau-memory/'
const compactMemory = buildCompactMemoryLines(
  'auto memory',
  memoryDir,
  ['EXTRA POLICY SENTINEL'],
).join('\n')
const normalMemory = buildMemoryLines('auto memory', memoryDir).join('\n')
const compactMemoryBytes = Buffer.byteLength(compactMemory)
const normalMemoryBytes = Buffer.byteLength(normalMemory)

for (const type of [
  'user',
  'feedback',
  'invariant',
  'decision',
  'project',
  'reference',
]) {
  assert.match(compactMemory, new RegExp(`\\b${type}\\b`))
}
assert.match(compactMemory, /explicitly asks to remember.*save it immediately/)
assert.match(compactMemory, /asked to forget.*remove or update/)
assert.match(compactMemory, /do not probe for it or run mkdir/)
assert.match(compactMemory, /Never save secrets or sensitive credentials/)
assert.match(compactMemory, /code patterns\/architecture\/paths, git history, fix recipes/)
assert.match(compactMemory, /These exclusions still apply when asked/)
assert.match(compactMemory, /name: <specific name>/)
assert.match(compactMemory, /description: <one-line relevance hook>/)
assert.match(compactMemory, /update it instead of duplicating it/)
assert.match(compactMemory, /add or update one pointer in `MEMORY\.md`/)
assert.match(compactMemory, /under ~150 characters/)
assert.match(compactMemory, /within 200 lines/)
assert.match(compactMemory, /ignore\/not use memory, act as if it were empty/)
assert.match(compactMemory, /do not apply, cite, compare against, or mention it/)
assert.match(compactMemory, /Current evidence wins/)
assert.match(compactMemory, /use code and git rather than a frozen memory snapshot/)
assert.match(compactMemory, /plans and task tracking.*durable future context/)
assert.match(compactMemory, /EXTRA POLICY SENTINEL/)
assert.match(normalMemory, /<types>/)
assert.match(normalMemory, /mocked tests passed but the prod migration failed/)
assert.ok(
  compactMemoryBytes * 3 < normalMemoryBytes,
  `compact=${compactMemoryBytes}, normal=${normalMemoryBytes}`,
)
assert.ok(
  compactMemoryBytes <= 4_000,
  `compact memory prompt is ${compactMemoryBytes} bytes`,
)

const skipIndexMemory = buildCompactMemoryLines(
  'auto memory',
  memoryDir,
  undefined,
  true,
).join('\n')
assert.match(skipIndexMemory, /does not require an index update/)
assert.doesNotMatch(skipIndexMemory, /add or update one pointer/)

const replMemory = buildCompactMemoryLines(
  'auto memory',
  memoryDir,
  undefined,
  false,
  true,
).join('\n')
assert.match(replMemory, /REPL's documented file interface/)
assert.doesNotMatch(replMemory, /Write tool/)

assert.match(COMPACT_SELF_LEARNING_OFFER_GUIDANCE, /natural end.*substantial/s)
assert.match(COMPACT_SELF_LEARNING_OFFER_GUIDANCE, /at most once/)
assert.match(COMPACT_SELF_LEARNING_OFFER_GUIDANCE, /Approve \/ Edit wording \/ Skip/)
assert.match(COMPACT_SELF_LEARNING_OFFER_GUIDANCE, /origin: learned/)
assert.match(COMPACT_SELF_LEARNING_OFFER_GUIDANCE, /active next session/)

const compactCombined = buildCompactCombinedMemoryPrompt([
  'TEAM EXTRA SENTINEL',
])
const normalCombined = buildCombinedMemoryPrompt()
const compactCombinedBytes = Buffer.byteLength(compactCombined)
const normalCombinedBytes = Buffer.byteLength(normalCombined)
assert.match(compactCombined, /always private/)
assert.match(compactCombined, /private by default, team only/)
assert.match(compactCombined, /team by default, private only/)
assert.match(compactCombined, /Never put secrets\/credentials or sensitive personal data in team memory/)
assert.match(compactCombined, /act as if both indexes were empty/)
assert.match(compactCombined, /TEAM EXTRA SENTINEL/)
const replCombined = buildCompactCombinedMemoryPrompt(undefined, false, true)
assert.match(replCombined, /REPL's documented file interface/)
assert.doesNotMatch(replCombined, /write directly with Write/)
assert.ok(
  compactCombinedBytes * 3 < normalCombinedBytes,
  `compact combined=${compactCombinedBytes}, normal combined=${normalCombinedBytes}`,
)
assert.ok(
  compactCombinedBytes <= 4_500,
  `compact combined memory prompt is ${compactCombinedBytes} bytes`,
)

console.log(
  JSON.stringify({
    staticBytes,
    compactMemoryBytes,
    normalMemoryBytes,
    compactCombinedBytes,
    normalCombinedBytes,
  }),
)
