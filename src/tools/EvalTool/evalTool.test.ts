/**
 * Eval tool invariants.
 *
 * Run via: bun run src/tools/EvalTool/evalTool.test.ts
 *
 * Three groups:
 *   1. CACHE — the tool schema must be byte-stable across turns. These are the
 *      tests that matter most; a failure here silently doubles token cost for
 *      every session by breaking the ~50-70K cached prefix on every request.
 *   2. PURE — formatting, clamping, allowlists.
 *   3. LIVE — a real Python kernel, skipped when no interpreter is present.
 */

import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

import {
  EVAL_BRIDGE_BLOCKED_TOOLS,
  EVAL_TOOL_NAME,
  MAX_RESULT_CHARS,
} from './constants.js'
import {
  clampOutput,
  resolveTimeoutMs,
  splitFailure,
  summarizeBridgeCalls,
} from './format.js'
import { PYTHON_KERNEL_SOURCE } from './kernelSource.js'
import { DESCRIPTION, PROMPT } from './prompt.js'

let passed = 0
let failed = 0
const failures: string[] = []

// An assertion function, so a passing check narrows the value: otherwise every
// `assert(x !== null)` is followed by a possibly-null dereference.
function assert(cond: unknown, hint: string): asserts cond {
  if (!cond) throw new Error(hint)
}

function test(name: string, fn: () => void): void {
  try {
    fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (e: unknown) {
    failed++
    const message = e instanceof Error ? e.message : String(e)
    failures.push(`${name}: ${message}`)
    console.log(`  FAIL ${name}: ${message}`)
  }
}

async function asyncTest(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (e: unknown) {
    failed++
    const message = e instanceof Error ? e.message : String(e)
    failures.push(`${name}: ${message}`)
    console.log(`  FAIL ${name}: ${message}`)
  }
}

// ─────────────────────────── 1. CACHE INVARIANTS ───────────────────────────

console.log('\ncache invariants')

test('the description is byte-identical on every read', () => {
  const reads = [DESCRIPTION, DESCRIPTION, DESCRIPTION]
  assert(new Set(reads).size === 1, 'description is not stable')
})

test('the prompt is byte-identical on every read', () => {
  assert(PROMPT === PROMPT.slice(0), 'prompt is not stable')
  const again = PROMPT
  assert(again === PROMPT, 'prompt changed between reads')
})

test('the prompt embeds nothing session-specific', () => {
  // The failure mode this guards is exactly `perToolHashes` in
  // promptCacheBreakDetection.ts: "tool prompt/schema changed, same tool set",
  // which is 77% of tool cache breaks and is caused by AgentTool/SkillTool
  // interpolating live registry state into their descriptions.
  const forbidden = [
    process.cwd(),
    process.platform,
    process.version,
    'python3',
    '.venv',
    'site-packages',
    'C:\\',
    '/usr/',
  ]
  for (const needle of forbidden) {
    assert(
      !PROMPT.includes(needle) && !DESCRIPTION.includes(needle),
      `prompt leaks environment detail: ${needle}`,
    )
  }
})

test('the prompt is a plain literal, not a template with substitutions', () => {
  // Guards against someone later turning PROMPT into a function or a
  // template that interpolates state. Reading the source is the only way to
  // catch that before it ships.
  const here = dirname(fileURLToPath(import.meta.url))
  const source = readFileSync(join(here, 'prompt.ts'), 'utf8')
  const body = source.slice(source.indexOf('export const PROMPT'))
  // ${EVAL_TOOL_NAME} is a module-level constant and therefore still stable;
  // anything that reads process, a setting, or a registry is not.
  for (const banned of ['process.', 'getSettings', 'getCwd(', 'Date.', 'Math.random']) {
    assert(!body.includes(banned), `PROMPT interpolates ${banned}`)
  }
})

await asyncTest('the availability latch never changes its answer', async () => {
  const { isEvalToolEnabled, __resetEvalRuntimeCacheForTests } = await import(
    './pythonRuntime.js'
  )
  __resetEvalRuntimeCacheForTests()
  const first = isEvalToolEnabled()
  // Simulate the world changing underneath us mid-session. The latch must
  // ignore it: a tool that appears or disappears is a +/-1 tools cache break.
  process.env.TAU_EVAL_DISABLE = first ? '1' : '0'
  const second = isEvalToolEnabled()
  const third = isEvalToolEnabled()
  delete process.env.TAU_EVAL_DISABLE
  assert(first === second && second === third, 'availability was not latched')
})

test('the description names a trigger, not a mechanism', () => {
  // Observed in a live session: with a description that only said what the
  // tool *was*, the model never reached for it until a user typed "use Eval".
  // The description is the only text read when deciding relevance.
  const lower = DESCRIPTION.toLowerCase()
  const triggers = ['many files', 'data', 'chart']
  for (const trigger of triggers) {
    assert(lower.includes(trigger), `description lost its "${trigger}" trigger`)
  }
})

test('the prompt says long and interrupted cells are safe', () => {
  // Observed in a live session: the model refused an infinite-loop cell and a
  // `timeout: 3` cell, reasoning that it would block the kernel. Both are
  // bounded and interruptible; the prompt has to say so or the refusals return.
  const lower = PROMPT.toLowerCase()
  assert(lower.includes('interruptible'), 'prompt no longer says cells are interruptible')
  assert(
    lower.includes('survive'),
    'prompt no longer promises the kernel survives a timeout',
  )
  assert(
    lower.includes('do not refuse'),
    'prompt no longer tells the model not to refuse long work',
  )
})

test('the prompt tells the model to run reset rather than describe it', () => {
  // Observed in a live session: asked to run a cell with reset: true, the model
  // printed the code it *would* run and never called the tool.
  // Collapse wrapping: the sentence spans a line break in the source.
  const flat = PROMPT.replace(/\s+/g, ' ')
  assert(
    flat.includes('do not describe what it would do instead of doing it'),
    'prompt no longer forbids narrating reset instead of running it',
  )
})

test('the prompt tells the model to gather inside the cell', () => {
  // Observed in a live session: the model ran a direct Grep, let the result be
  // parked to a file, then read that file from a cell — paying for the round
  // trip and putting the raw matches in context anyway.
  assert(
    PROMPT.includes('Do the gathering **inside** the cell'),
    'prompt no longer steers gathering into the cell',
  )
})

test('the output cap quoted to the model matches the real constant', () => {
  // The prompt must stay a literal, so it cannot interpolate MAX_RESULT_CHARS.
  // That leaves the number hand-copied, and a hand-copied number goes stale
  // silently: the model would budget its printing against a cap that no longer
  // exists. This test is the only thing keeping the two in step.
  const grouped = MAX_RESULT_CHARS.toString().replace(
    /\B(?=(\d{3})+(?!\d))/g,
    ',',
  )
  assert(
    PROMPT.includes(grouped) || PROMPT.includes(MAX_RESULT_CHARS.toString()),
    `prompt quotes an output cap that is not ${grouped}; MAX_RESULT_CHARS moved`,
  )
})

test('the tool-choice rule does not put Bash on the read rung', () => {
  // Shipped once with Bash listed as a reading tool. Asked for the ten largest
  // files in src/ — a ranking, which this same prompt calls computing — the
  // model followed the rule into `find | xargs wc -l | sort | head`, took three
  // attempts around xargs batching, and silently ranked by lines not bytes.
  const flat = PROMPT.replace(/\s+/g, ' ')
  assert(
    !/Will read it[^.]*\bBash\b/.test(flat),
    'Bash is back on the read rung; aggregating pipelines will be blessed again',
  )
  assert(
    flat.includes('is **computing** → cell'),
    'the prompt no longer routes aggregating pipelines to a cell',
  )
})

test('Eval is registered last in getAllBaseTools', () => {
  // Tool order IS the cache prefix. A tool inserted in the middle shifts every
  // schema after it and invalidates the cached prefix for the whole session —
  // the exact failure lanes/gemini/lazy_tools.test.ts guards on the lane side.
  // The registry cannot be imported in this tree (src/tools/TungstenTool is
  // absent; see docs/inline-images-handoff.md §1), so assert on the source.
  const here = dirname(fileURLToPath(import.meta.url))
  const source = readFileSync(join(here, '..', '..', 'tools.ts'), 'utf8')
  const start = source.indexOf('export function getAllBaseTools')
  assert(start !== -1, 'getAllBaseTools was renamed')
  const body = source.slice(start, source.indexOf('\n}', start))
  const entries = body
    .split('\n')
    .map(line => line.trim())
    .filter(line => /^[A-Za-z]\w*Tool,$/.test(line))
  assert(entries.length > 5, `found only ${entries.length} plain tool entries`)
  assert(
    entries[entries.length - 1] === 'EvalTool,',
    `EvalTool must be the last registered tool, found "${entries[entries.length - 1]}"`,
  )
})

await asyncTest('Eval survives cheap power mode', async () => {
  // Cheap mode filters getAllBaseTools() down to a fixed core allowlist and
  // turns off subagents entirely, which makes the kernel the only remaining
  // way to keep bulk output out of the conversation. Dropping it here would
  // make the cheapest mode the most expensive one for any multi-file question.
  const { CHEAP_MODE_CORE_TOOL_NAME_SET } = await import(
    '../../constants/cheapModeTools.js'
  )
  assert(
    CHEAP_MODE_CORE_TOOL_NAME_SET.has(EVAL_TOOL_NAME),
    'Eval was dropped from the cheap-mode core tool set',
  )
})

test('cheap mode tells the model the kernel is still available', () => {
  // Cheap mode renames core tools on the native lanes, so the prompt has a
  // section that affirms which capabilities remain ON. A capability the model
  // believes is missing is a capability it will not use.
  const here = dirname(fileURLToPath(import.meta.url))
  const source = readFileSync(join(here, '..', '..', 'constants', 'prompts.ts'), 'utf8')
  const at = source.indexOf('function getCheapModeToolsSection')
  assert(at !== -1, 'the cheap-mode section was renamed')
  const section = source.slice(at, source.indexOf('\n}', at))
  assert(
    section.includes('persistent kernel'),
    'cheap mode no longer affirms the kernel capability',
  )
  assert(
    section.includes('Delegation is off'),
    'cheap mode no longer explains why the kernel matters there',
  )
})

test('the system-prompt orientation line is static and tool-gated', () => {
  // The bullet added to constants/prompts.ts is what makes the model reach for
  // Eval unprompted. It sits in the cached prefix, so it must be a literal
  // gated on a session-stable tool set — never on live state.
  const here = dirname(fileURLToPath(import.meta.url))
  const source = readFileSync(join(here, '..', '..', 'constants', 'prompts.ts'), 'utf8')
  const at = source.indexOf('hasEvalTool')
  assert(at !== -1, 'the Eval orientation bullet is gone')
  assert(
    source.includes('const hasEvalTool = enabledTools.has(EVAL_TOOL_NAME)'),
    'the gate is no longer a plain enabledTools check',
  )
  const bullet = source.slice(source.indexOf('hasEvalTool\n', at))
  const body = bullet.slice(0, bullet.indexOf(': null,'))
  for (const banned of ['process.env', 'getSettings', 'Date.', 'Math.random', 'await ']) {
    assert(!body.includes(banned), `the orientation bullet interpolates ${banned}`)
  }
})

test('the embedded kernel cannot break out of its template literal', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const source = readFileSync(join(here, 'kernelSource.ts'), 'utf8')
  // Anchor on the export, not on "String.raw" — the doc comment above it
  // mentions `String.raw` in backticks and would otherwise be matched first.
  const exportAt = source.indexOf('export const PYTHON_KERNEL_SOURCE')
  assert(exportAt !== -1, 'the kernel export was renamed')
  const start = source.indexOf('String.raw`', exportAt) + 'String.raw`'.length
  const end = source.lastIndexOf('`')
  const python = source.slice(start, end)
  assert(!python.includes('`'), 'a backtick in the Python would end the template')
  assert(!python.includes('${'), 'a ${ in the Python would interpolate')
  assert(python.length > 5000, 'kernel source looks truncated')
})

test('the kernel source is what actually gets written to disk', () => {
  assert(PYTHON_KERNEL_SOURCE.includes('def main()'), 'kernel entrypoint missing')
  assert(
    PYTHON_KERNEL_SOURCE.includes('_thread.interrupt_main'),
    'the socket cancel path is gone — Ctrl+C would destroy kernel state on Windows',
  )
  assert(
    PYTHON_KERNEL_SOURCE.includes('"\\n"') || PYTHON_KERNEL_SOURCE.includes("\\n"),
    'String.raw escaping was lost',
  )
})

// ───────────────────────────── 2. PURE LOGIC ─────────────────────────────

console.log('\npure logic')

test('timeout defaults, clamps, and honors 0 as unlimited', () => {
  assert(resolveTimeoutMs(undefined) === 60_000, 'default should be 60s')
  assert(resolveTimeoutMs(0) === 0, '0 must disable the deadline')
  assert(resolveTimeoutMs(5) === 5_000, '5s')
  assert(resolveTimeoutMs(999_999) === 3_600_000, 'must clamp to one hour')
  assert(resolveTimeoutMs(-4) === 1_000, 'negative must clamp up to 1s')
})

test('short output is passed through untouched', () => {
  const result = clampOutput('hello')
  assert(result.text === 'hello', 'short text was modified')
  assert(!result.truncated, 'short text was marked truncated')
})

test('long output keeps both the head and the tail', () => {
  const body = `HEAD_MARKER${'x'.repeat(MAX_RESULT_CHARS * 2)}TAIL_MARKER`
  const result = clampOutput(body)
  assert(result.truncated, 'oversized output was not marked truncated')
  assert(result.text.includes('HEAD_MARKER'), 'head was lost')
  assert(result.text.includes('TAIL_MARKER'), 'tail was lost — the answer usually lives there')
  assert(result.text.length < body.length, 'nothing was actually trimmed')
})

test('a handful of bridge calls are listed individually', () => {
  const summary = summarizeBridgeCalls([
    { name: 'Read', detail: 'src/a.ts', ms: 3 },
    { name: 'Grep', detail: 'TODO', ms: 9 },
  ])
  assert(summary.includes('Read src/a.ts'), 'individual call missing')
  assert(summary.includes('Grep TODO'), 'individual call missing')
})

test('many bridge calls collapse to an aggregate', () => {
  const calls = Array.from({ length: 400 }, (_, i) => ({
    name: 'Read',
    detail: `file-${i}.ts`,
    ms: 1,
  }))
  const summary = summarizeBridgeCalls(calls)
  assert(summary.includes('400 Read'), 'calls were not aggregated')
  assert(
    summary.split('\n').length < 8,
    'a 400-call loop must not spend 400 lines of context describing itself',
  )
})

test('failed bridge calls stay visible even in the aggregate', () => {
  const calls = Array.from({ length: 40 }, (_, i) => ({
    name: 'Read',
    detail: `f${i}`,
    ms: 1,
    ...(i === 7 ? { error: 'no such file' } : {}),
  }))
  const summary = summarizeBridgeCalls(calls)
  assert(summary.includes('no such file'), 'a failure was swallowed by aggregation')
})

test('no output produces no bridge section', () => {
  assert(summarizeBridgeCalls([]) === '', 'empty call list produced a section')
})

test('a bridge error is capped so it cannot fill the screen', () => {
  // A mistyped tool name once printed the same 400-character paragraph twice —
  // in the traceback and again here.
  const summary = summarizeBridgeCalls([
    { name: 'ArtifactCanvas', detail: '', ms: 2, error: 'x'.repeat(4000) },
  ])
  assert(summary.length < 400, `bridge error not capped: ${summary.length} chars`)
  assert(summary.includes('ArtifactCanvas'), 'the failing tool must still be named')
})

test('the display collapses a traceback to one line', () => {
  const text = [
    'partial output before the failure',
    'Traceback (most recent call last):',
    '  File "<cell-7>", line 34, in <module>',
    '    print(f"{bad)}")',
    '        ^',
    "SyntaxError: f-string: unmatched ')'",
    '',
    '[tool bridge]',
    '  Read src/a.ts',
  ].join('\n')

  const failure = splitFailure(text)
  assert(failure !== null, 'a traceback was not recognised')
  assert(
    failure.headline === "SyntaxError: f-string: unmatched ')' · cell 7, line 34",
    `wrong headline: ${failure.headline}`,
  )
  assert(failure.hiddenLines >= 4, `expected the frames to be hidden: ${failure.hiddenLines}`)
  // Output printed before the crash is kept — it is usually why the error
  // makes sense.
  assert(failure.rest.includes('partial output'), 'pre-crash output was dropped')
  // The bridge section lives AFTER the traceback, so cutting to the end of the
  // text would have swallowed it.
  assert(failure.rest.includes('[tool bridge]'), 'the bridge summary was swallowed')
  assert(!failure.rest.includes('SyntaxError'), 'the traceback was not removed')
})

test('the display leaves a result with no traceback alone', () => {
  assert(splitFailure('just some output\nand more') === null, 'nothing to collapse')
  assert(splitFailure('') === null, 'empty text')
})

test('the display survives a truncated traceback', () => {
  // clampOutput can cut a result mid-traceback; the collapse must not throw or
  // invent a headline from half a frame.
  const cut = 'Traceback (most recent call last):\n  File "<cell-3>", line 3, in <module>'
  const failure = splitFailure(cut)
  assert(failure === null, 'a headerless, exception-less block should not collapse')
})

test('Eval cannot be called from inside a cell', () => {
  assert(
    EVAL_BRIDGE_BLOCKED_TOOLS.has(EVAL_TOOL_NAME),
    'recursion would deadlock: the tool is exclusive, so the inner call could never be scheduled',
  )
})

test('the blocked set stays small and justified', () => {
  // This was a 28-name allowlist, which silently refused ArtifactCanvas, every
  // MCP tool, and anything written later. The bridge is a correctness
  // boundary, not a security one — canUseTool does the gating — so only tools
  // that cannot work belong here. If this set grows, something is wrong.
  assert(
    EVAL_BRIDGE_BLOCKED_TOOLS.size <= 8,
    `the blocked set has grown to ${EVAL_BRIDGE_BLOCKED_TOOLS.size}; it should list only tools that act on the session`,
  )
  for (const name of ['Snapshot', 'ArtifactCanvas', 'MermaidRender', 'Skill', 'LSP']) {
    assert(
      !EVAL_BRIDGE_BLOCKED_TOOLS.has(name),
      `${name} acts on the workspace and works fine from a cell`,
    )
  }
})

await asyncTest('blocked names match the real tool constants', async () => {
  // The set holds string literals so this module stays a zero-import leaf.
  // That is only safe if a rename fails here rather than silently unblocking
  // a tool that cannot work.
  const [enterPlan, exitPlan, enterWorktree, exitWorktree] = await Promise.all([
    import('../EnterPlanModeTool/constants.js'),
    import('../ExitPlanModeTool/constants.js'),
    import('../EnterWorktreeTool/constants.js'),
    import('../ExitWorktreeTool/constants.js'),
  ])
  const expected = [
    enterPlan.ENTER_PLAN_MODE_TOOL_NAME,
    exitPlan.EXIT_PLAN_MODE_V2_TOOL_NAME,
    enterWorktree.ENTER_WORKTREE_TOOL_NAME,
    exitWorktree.EXIT_WORKTREE_TOOL_NAME,
  ]
  for (const name of expected) {
    assert(
      EVAL_BRIDGE_BLOCKED_TOOLS.has(name),
      `${name} was renamed and is no longer blocked from the bridge`,
    )
  }
})

test('interactive tools are excluded by predicate, not by name', () => {
  // AskUserQuestion, Computer and ExitPlanMode declare requiresUserInteraction.
  // The bridge asks each tool rather than keeping a list, so a new interactive
  // tool is covered the day it is written — but only while the declarations
  // exist, which is what this checks.
  const here = dirname(fileURLToPath(import.meta.url))
  const bridge = readFileSync(join(here, 'toolBridge.ts'), 'utf8')
  assert(
    bridge.includes('requiresUserInteraction?.()'),
    'the bridge no longer asks tools whether they need the user',
  )
  for (const file of [
    '../AskUserQuestionTool/AskUserQuestionTool.tsx',
    '../ComputerTool/ComputerTool.tsx',
  ]) {
    const source = readFileSync(join(here, file), 'utf8')
    assert(
      source.includes('requiresUserInteraction()'),
      `${file} stopped declaring requiresUserInteraction, so the bridge would now accept it`,
    )
  }
})

// ─────────────────────────────── 3. LIVE ───────────────────────────────

async function live(): Promise<void> {
  const { resolvePythonInterpreter, __resetEvalRuntimeCacheForTests } = await import(
    './pythonRuntime.js'
  )
  __resetEvalRuntimeCacheForTests()
  if (!resolvePythonInterpreter()) {
    console.log('\nlive kernel: SKIPPED (no Python interpreter found)')
    return
  }
  console.log('\nlive kernel')

  const { PythonKernel } = await import('./kernel.js')
  const make = () =>
    new PythonKernel({
      cwd: process.cwd(),
      bridgeUrl: 'http://127.0.0.1:1',
      bridgeToken: 'unused',
      bridgeSession: 'test',
    })

  await asyncTest('state persists across cells', async () => {
    const kernel = make()
    try {
      await kernel.start()
      const first = await kernel.execute('answer = 6 * 7', { timeoutMs: 15_000 })
      assert(first.ok, `setup cell failed: ${first.error?.evalue}`)
      const second = await kernel.execute('print(answer)', { timeoutMs: 15_000 })
      assert(second.ok, 'follow-up cell failed')
      assert(
        second.stdout.includes('42'),
        `variable did not survive: ${JSON.stringify(second.stdout)}`,
      )
    } finally {
      await kernel.shutdown()
    }
  })

  await asyncTest('the last expression is returned', async () => {
    const kernel = make()
    try {
      const outcome = await kernel.execute('2 ** 10', { timeoutMs: 15_000 })
      assert(outcome.result === '1024', `got ${outcome.result}`)
    } finally {
      await kernel.shutdown()
    }
  })

  await asyncTest('an exception does not kill the kernel', async () => {
    const kernel = make()
    try {
      const boom = await kernel.execute('kept = 1\nraise ValueError("nope")', {
        timeoutMs: 15_000,
      })
      assert(!boom.ok, 'a raising cell reported success')
      assert(boom.error?.ename === 'ValueError', `wrong error: ${boom.error?.ename}`)
      assert(
        !(boom.error?.traceback ?? '').includes('_exec_compiled'),
        'kernel internals leaked into the traceback',
      )
      const after = await kernel.execute('print(kept)', { timeoutMs: 15_000 })
      assert(after.ok && after.stdout.includes('1'), 'state before the error was lost')
    } finally {
      await kernel.shutdown()
    }
  })

  await asyncTest('a timeout interrupts the cell and the kernel survives', async () => {
    const kernel = make()
    try {
      const spin = await kernel.execute(
        'import time\nmarker = "before"\nwhile True:\n    time.sleep(0.05)',
        { timeoutMs: 1_200 },
      )
      assert(spin.timedOut, 'the deadline did not fire')
      assert(spin.cancelled, 'the cell was not reported as interrupted')
      assert(!spin.crashed, 'the kernel had to be killed — the socket cancel failed')
      const after = await kernel.execute('print(marker)', { timeoutMs: 15_000 })
      assert(
        after.ok && after.stdout.includes('before'),
        'the namespace did not survive the interrupt',
      )
    } finally {
      await kernel.shutdown()
    }
  })

  await asyncTest('an abort signal interrupts the cell', async () => {
    const kernel = make()
    const controller = new AbortController()
    try {
      setTimeout(() => controller.abort(), 600)
      const spin = await kernel.execute(
        'import time\nwhile True:\n    time.sleep(0.05)',
        { timeoutMs: 30_000, signal: controller.signal },
      )
      assert(spin.cancelled, 'abort did not interrupt the cell')
      assert(!spin.timedOut, 'abort was misreported as a timeout')
    } finally {
      await kernel.shutdown()
    }
  })

  await asyncTest('reset clears the namespace', async () => {
    const kernel = make()
    try {
      await kernel.execute('gone = 1', { timeoutMs: 15_000 })
      await kernel.reset()
      const after = await kernel.execute('print("gone" in dir())', { timeoutMs: 15_000 })
      assert(after.stdout.includes('False'), 'reset left the namespace populated')
      const prelude = await kernel.execute('print(callable(display))', { timeoutMs: 15_000 })
      assert(prelude.stdout.includes('True'), 'reset dropped the prelude')
    } finally {
      await kernel.shutdown()
    }
  })

  await asyncTest('secrets are kept out of the kernel environment', async () => {
    process.env.TAU_TEST_FAKE_API_KEY = 'sk-should-never-appear'
    process.env.ANTHROPIC_AUTH_TOKEN = 'oauth-should-never-appear'
    const kernel = make()
    try {
      const outcome = await kernel.execute(
        'import os\nprint("|".join(k for k in os.environ if "KEY" in k.upper() or "TOKEN" in k.upper()))',
        { timeoutMs: 15_000 },
      )
      assert(
        !outcome.stdout.includes('TAU_TEST_FAKE_API_KEY'),
        'an API key reached the kernel environment',
      )
      assert(
        !outcome.stdout.includes('ANTHROPIC_AUTH_TOKEN'),
        'an auth token reached the kernel environment',
      )
    } finally {
      delete process.env.TAU_TEST_FAKE_API_KEY
      delete process.env.ANTHROPIC_AUTH_TOKEN
      await kernel.shutdown()
    }
  })

  await asyncTest('magics are rewritten', async () => {
    const kernel = make()
    try {
      const outcome = await kernel.execute('here = %pwd\nprint(len(here) > 0)', {
        timeoutMs: 15_000,
      })
      assert(outcome.ok, `magic cell failed: ${outcome.error?.evalue}`)
      assert(outcome.stdout.includes('True'), 'the %pwd magic did not run')
    } finally {
      await kernel.shutdown()
    }
  })

  await asyncTest('a percent sign inside a string is left alone', async () => {
    const kernel = make()
    try {
      const outcome = await kernel.execute('s = "100%% sure"\nprint(s)', {
        timeoutMs: 15_000,
      })
      assert(outcome.ok, `cell failed: ${outcome.error?.evalue}`)
      assert(outcome.stdout.includes('100%% sure'), 'string content was rewritten')
    } finally {
      await kernel.shutdown()
    }
  })

  await asyncTest('top-level await works', async () => {
    const kernel = make()
    try {
      const outcome = await kernel.execute(
        'import asyncio\nasync def go():\n    await asyncio.sleep(0)\n    return "awaited"\nawait go()',
        { timeoutMs: 15_000 },
      )
      assert(outcome.ok, `await cell failed: ${outcome.error?.evalue}`)
      assert(outcome.result === "'awaited'", `got ${outcome.result}`)
    } finally {
      await kernel.shutdown()
    }
  })

  await asyncTest('a dead kernel is transparently restarted', async () => {
    // Regression: start() memoized its promise forever, so after a segfault,
    // an OOM kill, or a killTree() escalation every later execute() wrote into
    // a closed stdin and reported a crash for the rest of the session.
    const kernel = make()
    try {
      await kernel.start()
      await kernel.execute('x = 1', { timeoutMs: 15_000 })
      kernel.killTree()
      await new Promise(resolve => setTimeout(resolve, 800))
      assert(!kernel.isAlive(), 'the kernel survived killTree')

      const after = await kernel.execute('print("restarted")', { timeoutMs: 20_000 })
      assert(after.ok, `no restart: ${after.error?.ename} ${after.error?.evalue}`)
      assert(after.stdout.includes('restarted'), `stdout was ${JSON.stringify(after.stdout)}`)
      const gone = await kernel.execute('print("x" in dir())', { timeoutMs: 15_000 })
      assert(gone.stdout.includes('False'), 'a restarted kernel must start empty')
    } finally {
      await kernel.shutdown()
    }
  })

  await asyncTest('a cancel that loses its race does not kill the kernel', async () => {
    // Regression: cancel() arriving just after a cell finished raised
    // KeyboardInterrupt inside the main read loop and tore the kernel down.
    const kernel = make()
    try {
      await kernel.execute('quick = 1', { timeoutMs: 15_000 })
      for (let i = 0; i < 5; i++) kernel.cancel()
      await new Promise(resolve => setTimeout(resolve, 400))
      assert(kernel.isAlive(), 'an idle cancel killed the kernel')
      const after = await kernel.execute('print(quick)', { timeoutMs: 15_000 })
      assert(after.ok && after.stdout.includes('1'), 'state lost to an idle cancel')
    } finally {
      await kernel.shutdown()
    }
  })

  await asyncTest('a one-line docstring does not disable later magics', async () => {
    // Regression: block detection toggled on "starts with triple quote", so a
    // self-closing docstring flipped the parser into "inside a string" for the
    // rest of the cell and a following %pwd stayed literal -> SyntaxError.
    const kernel = make()
    try {
      const outcome = await kernel.execute(
        ['def helper():', '    """One line."""', '    return 1', '', 'here = %pwd', 'print(helper(), len(here) > 0)'].join('\n'),
        { timeoutMs: 15_000 },
      )
      assert(outcome.ok, `cell failed: ${outcome.error?.ename}: ${outcome.error?.evalue}`)
      assert(outcome.stdout.includes('1 True'), `stdout was ${JSON.stringify(outcome.stdout)}`)
    } finally {
      await kernel.shutdown()
    }
  })

  await asyncTest('two overlapping cells are refused, not interleaved', async () => {
    const kernel = make()
    try {
      await kernel.start()
      const first = kernel.execute('import time\ntime.sleep(1.5)\nprint("first")', {
        timeoutMs: 20_000,
      })
      let refused = false
      try {
        await kernel.execute('print("second")', { timeoutMs: 5_000 })
      } catch (error) {
        refused = /already running/.test(String(error))
      }
      const outcome = await first
      assert(refused, 'a concurrent cell was accepted and would steal frames')
      assert(outcome.stdout.includes('first'), 'the first cell was disturbed')
    } finally {
      await kernel.shutdown()
    }
  })

  await asyncTest('%who reports what survived, %whos describes it', async () => {
    const kernel = make()
    try {
      await kernel.execute('alpha = [1, 2, 3]\nbeta = "hello"', { timeoutMs: 15_000 })
      // Line magics only fire at the start of a line, as in IPython, so the
      // result has to be bound before it can be printed.
      const who = await kernel.execute('names = %who\nprint(names)', {
        timeoutMs: 15_000,
      })
      assert(who.ok, `%who failed: ${who.error?.evalue}`)
      assert(who.stdout.includes('alpha'), `%who missed a name: ${who.stdout}`)
      assert(who.stdout.includes('beta'), `%who missed a name: ${who.stdout}`)
      assert(
        !who.stdout.includes('display'),
        '%who leaked prelude helpers into the user namespace listing',
      )
      const whos = await kernel.execute('rows = %whos\nprint(rows)', {
        timeoutMs: 15_000,
      })
      assert(whos.stdout.includes('list len=3'), `%whos lost detail: ${whos.stdout}`)
    } finally {
      await kernel.shutdown()
    }
  })

  await asyncTest('a kernel does not outlive a hard-killed parent', async () => {
    // registerCleanup covers a graceful exit, but Windows has no process groups
    // and the child is not detached-killed with the parent. What actually saves
    // us is the read loop: when the parent dies its pipe closes, readline
    // returns EOF, and the kernel exits on its own. If that ever regresses,
    // every crashed session leaks a python.exe.
    assert(
      PYTHON_KERNEL_SOURCE.includes('if not line:\n            return'),
      'the kernel no longer exits on stdin EOF; a killed parent would leak it',
    )
    const kernel = make()
    try {
      await kernel.start()
      await kernel.execute('x = 1', { timeoutMs: 15_000 })
      // Closing stdin is exactly what a dead parent looks like from the child.
      kernel.closeStdinForTests()
      const exited = await kernel.waitForExit(8_000)
      assert(exited, 'the kernel stayed alive after its control pipe closed')
    } finally {
      await kernel.shutdown()
    }
  })

  await asyncTest('a traceback contains only the user\'s own frames', async () => {
    // Regression: frames were dropped by function name (_run_cell,
    // _exec_compiled), so anything else on the stack leaked — Lib/ast.py for a
    // SyntaxError, two tau_kernel.py frames for a bridge failure. Filtering on
    // the filename covers every such case, including ones not yet written.
    const kernel = make()
    try {
      const syntax = await kernel.execute('x = 1\nprint(f"{\'a\'):>9s}")', {
        timeoutMs: 15_000,
      })
      const trace = syntax.error?.traceback ?? ''
      assert(syntax.error?.ename === 'SyntaxError', `got ${syntax.error?.ename}`)
      assert(!trace.includes('ast.py'), `interpreter frame leaked:\n${trace}`)
      assert(!trace.includes('tau_kernel'), `kernel frame leaked:\n${trace}`)
      // The caret is the most useful part of a SyntaxError and lives in list
      // elements that do not name the file, so a naive filter drops it.
      assert(trace.includes('^'), `the caret was lost:\n${trace}`)
      assert(trace.includes('<cell-'), `the cell location was lost:\n${trace}`)

      const bridge = await kernel.execute('tool.Read(file_path="x")', {
        timeoutMs: 15_000,
      })
      const bridgeTrace = bridge.error?.traceback ?? ''
      assert(
        !bridgeTrace.includes('tau_kernel'),
        `bridge helper frames leaked:\n${bridgeTrace}`,
      )
      assert(bridgeTrace.includes('<cell-'), 'the calling line should still show')

      const runtime = await kernel.execute('1 + "a"', { timeoutMs: 15_000 })
      const runtimeTrace = runtime.error?.traceback ?? ''
      assert(runtime.error?.ename === 'TypeError', `got ${runtime.error?.ename}`)
      assert(
        !runtimeTrace.includes('tau_kernel') && !runtimeTrace.includes('ast.py'),
        `internals leaked:\n${runtimeTrace}`,
      )
    } finally {
      await kernel.shutdown()
    }
  })

  await asyncTest('a traceback shows the offending source line', async () => {
    const kernel = make()
    try {
      const outcome = await kernel.execute('value = 1\nvalue["nope"]', {
        timeoutMs: 15_000,
      })
      const trace = outcome.error?.traceback ?? ''
      assert(
        trace.includes('value["nope"]'),
        `the source line was not shown:\n${trace}`,
      )
    } finally {
      await kernel.shutdown()
    }
  })

  await asyncTest('an older cell\'s frame shows ITS OWN source, not the newest', async () => {
    // The whole reason each cell needs a unique filename. linecache keeps one
    // source per filename, so a shared "<cell>" hands the newest cell's text to
    // an older cell's frame — a confident, wrong line with a caret under
    // innocent code. Worse than showing nothing, and the common case, because
    // the prompt tells the model to define helpers in one cell and call them
    // from later ones.
    const kernel = make()
    try {
      const setup = await kernel.execute(
        'def helper(d):\n    return d["missing_key"]',
        { timeoutMs: 15_000 },
      )
      assert(setup.ok, `setup cell failed: ${setup.error?.evalue}`)

      const call = await kernel.execute(
        'data = {}\nprint("an innocent line")\nhelper(data)',
        { timeoutMs: 15_000 },
      )
      const trace = call.error?.traceback ?? ''
      assert(call.error?.ename === 'KeyError', `got ${call.error?.ename}`)
      assert(
        trace.includes('d["missing_key"]'),
        `the helper's own source was not shown:\n${trace}`,
      )
      assert(
        !trace.includes('an innocent line'),
        `the newest cell's source was pasted into an older frame:\n${trace}`,
      )
      // Two different cells, and the traceback must say which is which.
      assert(
        /<cell-\d+>/.test(trace) && !trace.includes('"<cell>"'),
        `frames are not attributed to a specific cell:\n${trace}`,
      )
    } finally {
      await kernel.shutdown()
    }
  })

  await asyncTest('a bridge call with no listener fails cleanly, not silently', async () => {
    const kernel = make()
    try {
      const outcome = await kernel.execute(
        'try:\n    tool.Read(file_path="x")\nexcept ToolBridgeError as e:\n    print("raised")',
        { timeoutMs: 15_000 },
      )
      assert(outcome.ok, `cell failed: ${outcome.error?.evalue}`)
      assert(
        outcome.stdout.includes('raised'),
        'an unreachable bridge did not raise ToolBridgeError',
      )
    } finally {
      await kernel.shutdown()
    }
  })
}

await live()

console.log(`\n${passed} passed, ${failed} failed`)
if (failures.length > 0) {
  console.log('\nfailures:')
  for (const failure of failures) console.log(`  - ${failure}`)
}
if (failed > 0) process.exit(1)
