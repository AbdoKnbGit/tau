/**
 * End-to-end tool-bridge tests: real Python kernel, real loopback HTTP server,
 * real permission callback.
 *
 * Run via: bun run src/tools/EvalTool/bridge.test.ts
 *
 * This is the load-bearing path of the whole feature — `tool.Read(...)` typed
 * inside a cell has to reach a Tau tool, respect its permission decision, and
 * come back as Python data. Everything else is plumbing around it.
 */

import { z } from 'zod/v4'

import { PythonKernel } from './kernel.js'
import { resolvePythonInterpreter } from './pythonRuntime.js'
import {
  DeadlineBudget,
  disposeToolBridge,
  ensureToolBridge,
  registerBridgeSession,
} from './toolBridge.js'
import type { BridgeCallRecord } from './format.js'

let passed = 0
let failed = 0
const failures: string[] = []

function assert(cond: unknown, hint: string): void {
  if (!cond) throw new Error(hint)
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

/** A stand-in for a Tau tool: just enough surface for the bridge to drive it. */
function fakeTool(name: string, run: (input: Record<string, unknown>) => string) {
  return {
    name,
    inputSchema: z.object({ file_path: z.string() }),
    async call(input: Record<string, unknown>) {
      return { data: { text: run(input) } }
    },
    mapToolResultToToolResultBlockParam(data: { text: string }, id: string) {
      return { type: 'tool_result' as const, tool_use_id: id, content: data.text }
    },
  }
}

type Decision = { behavior: 'allow' | 'deny'; message?: string }

async function withBridge(
  options: {
    tools: unknown[]
    decide?: (name: string) => Decision
  },
  body: (kernel: PythonKernel, calls: BridgeCallRecord[]) => Promise<void>,
): Promise<void> {
  const info = await ensureToolBridge()
  const sessionKey = `test-${Math.random().toString(36).slice(2)}`
  const calls: BridgeCallRecord[] = []
  const controller = new AbortController()

  const unregister = registerBridgeSession(sessionKey, {
    // The fakes only need to satisfy the fields the bridge actually reads.
    tools: options.tools as never,
    toolUseContext: { abortController: controller } as never,
    canUseTool: (async (tool: { name: string }, input: unknown) => {
      const decision = options.decide?.(tool.name) ?? { behavior: 'allow' as const }
      return decision.behavior === 'allow'
        ? { behavior: 'allow', updatedInput: input }
        : { behavior: 'deny', message: decision.message ?? 'denied by test' }
    }) as never,
    parentMessage: {} as never,
    signal: controller.signal,
    onCall: record => calls.push(record),
    budget: new DeadlineBudget(),
  })

  const kernel = new PythonKernel({
    cwd: process.cwd(),
    bridgeUrl: info.url,
    bridgeToken: info.token,
    bridgeSession: sessionKey,
  })
  try {
    await kernel.start()
    await body(kernel, calls)
  } finally {
    unregister()
    await kernel.shutdown()
  }
}

async function main(): Promise<void> {
  if (!resolvePythonInterpreter()) {
    console.log('bridge: SKIPPED (no Python interpreter found)')
    return
  }
  console.log('\ntool bridge (python -> host -> tool -> python)')

  await asyncTest('a cell calls a real tool and gets its text back', async () => {
    await withBridge(
      { tools: [fakeTool('Read', input => `contents of ${String(input.file_path)}`)] },
      async (kernel, calls) => {
        const outcome = await kernel.execute(
          'body = tool.Read(file_path="/tmp/demo.txt")\nprint(body)',
          { timeoutMs: 20_000 },
        )
        assert(outcome.ok, `cell failed: ${outcome.error?.evalue}`)
        assert(
          outcome.stdout.includes('contents of /tmp/demo.txt'),
          `bridge value never arrived: ${JSON.stringify(outcome.stdout)}`,
        )
        assert(calls.length === 1 && calls[0]?.name === 'Read', 'the call was not recorded')
      },
    )
  })

  await asyncTest('dict-style and kwargs-style arguments both work', async () => {
    await withBridge(
      { tools: [fakeTool('Read', input => `ok:${String(input.file_path)}`)] },
      async kernel => {
        const outcome = await kernel.execute(
          'a = tool.Read({"file_path": "one"})\nb = tool.Read(file_path="two")\nprint(a, b)',
          { timeoutMs: 20_000 },
        )
        assert(outcome.ok, `cell failed: ${outcome.error?.evalue}`)
        assert(outcome.stdout.includes('ok:one ok:two'), outcome.stdout)
      },
    )
  })

  await asyncTest('a denied permission surfaces as a catchable Python error', async () => {
    await withBridge(
      {
        tools: [fakeTool('Read', () => 'should never run')],
        decide: () => ({ behavior: 'deny', message: 'user said no' }),
      },
      async kernel => {
        const outcome = await kernel.execute(
          'try:\n    tool.Read(file_path="x")\n    print("LEAKED")\nexcept ToolBridgeError as e:\n    print("denied:", e)',
          { timeoutMs: 20_000 },
        )
        assert(outcome.ok, `cell failed: ${outcome.error?.evalue}`)
        assert(!outcome.stdout.includes('LEAKED'), 'a denied tool ran anyway')
        assert(outcome.stdout.includes('user said no'), `no denial reason: ${outcome.stdout}`)
      },
    )
  })

  await asyncTest('a tool outside the allowlist is refused', async () => {
    await withBridge(
      { tools: [fakeTool('Checkpoint', () => 'nope')] },
      async kernel => {
        const outcome = await kernel.execute(
          'try:\n    tool.Checkpoint(file_path="x")\nexcept ToolBridgeError as e:\n    print("blocked:", e)',
          { timeoutMs: 20_000 },
        )
        assert(outcome.stdout.includes('blocked:'), `not blocked: ${outcome.stdout}`)
      },
    )
  })

  await asyncTest('Eval cannot call itself', async () => {
    await withBridge({ tools: [fakeTool('Eval', () => 'recursion')] }, async kernel => {
      const outcome = await kernel.execute(
        'try:\n    tool.Eval(file_path="x")\nexcept ToolBridgeError as e:\n    print("blocked:", e)',
        { timeoutMs: 20_000 },
      )
      assert(outcome.stdout.includes('blocked:'), `recursion was allowed: ${outcome.stdout}`)
    })
  })

  await asyncTest('bad arguments produce a useful message, not a crash', async () => {
    await withBridge({ tools: [fakeTool('Read', () => 'x')] }, async kernel => {
      const outcome = await kernel.execute(
        'try:\n    tool.Read(wrong_arg=1)\nexcept ToolBridgeError as e:\n    print("schema:", e)',
        { timeoutMs: 20_000 },
      )
      assert(outcome.stdout.includes('schema:'), `no schema error: ${outcome.stdout}`)
      assert(
        outcome.stdout.includes('file_path'),
        'the error should name the missing parameter',
      )
    })
  })

  await asyncTest('tool.list() reports only bridgeable tools', async () => {
    await withBridge(
      {
        tools: [
          fakeTool('Read', () => 'a'),
          fakeTool('Grep', () => 'b'),
          fakeTool('Checkpoint', () => 'c'),
        ],
      },
      async kernel => {
        const outcome = await kernel.execute('print(sorted(tool.list()))', {
          timeoutMs: 20_000,
        })
        assert(outcome.ok, `cell failed: ${outcome.error?.evalue}`)
        assert(outcome.stdout.includes('Grep'), 'Grep missing from tool.list()')
        assert(outcome.stdout.includes('Read'), 'Read missing from tool.list()')
        assert(
          !outcome.stdout.includes('Checkpoint'),
          'a non-bridgeable tool was advertised',
        )
      },
    )
  })

  await asyncTest('a loop of bridge calls stays out of the transcript', async () => {
    await withBridge(
      { tools: [fakeTool('Read', input => `${'line\n'.repeat(200)}${String(input.file_path)}`)] },
      async (kernel, calls) => {
        const outcome = await kernel.execute(
          'total = 0\nfor i in range(25):\n    total += len(tool.Read(file_path=f"f{i}.txt"))\nprint("chars:", total)',
          { timeoutMs: 40_000 },
        )
        assert(outcome.ok, `cell failed: ${outcome.error?.evalue}`)
        assert(calls.length === 25, `expected 25 bridged calls, got ${calls.length}`)
        // 25 reads of ~1000 chars each happened; the model sees one line.
        assert(outcome.stdout.trim().startsWith('chars:'), outcome.stdout)
        assert(
          outcome.stdout.length < 200,
          `the loop leaked its data into the output: ${outcome.stdout.length} chars`,
        )
      },
    )
  })

  await asyncTest('the deadline is not charged for time inside a bridge call', async () => {
    const budget = new DeadlineBudget()
    budget.enter()
    await new Promise(resolve => setTimeout(resolve, 300))
    budget.exit()
    const paused = budget.pausedMs()
    assert(paused >= 250, `budget did not accumulate: ${paused}ms`)
    // A second, still-open call must count while it is in flight.
    budget.enter()
    await new Promise(resolve => setTimeout(resolve, 150))
    assert(budget.pausedMs() > paused, 'an in-flight call is not being counted')
    budget.exit()
  })

  await asyncTest('a cell whose bridge session ended fails clearly', async () => {
    const info = await ensureToolBridge()
    const kernel = new PythonKernel({
      cwd: process.cwd(),
      bridgeUrl: info.url,
      bridgeToken: info.token,
      bridgeSession: 'never-registered',
    })
    try {
      await kernel.start()
      const outcome = await kernel.execute(
        'try:\n    tool.Read(file_path="x")\nexcept ToolBridgeError as e:\n    print("gone:", e)',
        { timeoutMs: 20_000 },
      )
      assert(outcome.stdout.includes('gone:'), `no clear error: ${outcome.stdout}`)
    } finally {
      await kernel.shutdown()
    }
  })

  await asyncTest('the bridge rejects a wrong token', async () => {
    const info = await ensureToolBridge()
    const response = await fetch(`${info.url}/v1/tool`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer not-the-token',
      },
      body: JSON.stringify({ session: 'x', name: 'Read', args: {} }),
    })
    assert(response.status === 403, `expected 403, got ${response.status}`)
  })

  await asyncTest('the bridge only listens on loopback', async () => {
    const info = await ensureToolBridge()
    assert(
      info.url.startsWith('http://127.0.0.1:'),
      `bridge is not loopback-only: ${info.url}`,
    )
  })

  await disposeToolBridge()
}

await main()

console.log(`\n${passed} passed, ${failed} failed`)
if (failures.length > 0) {
  console.log('\nfailures:')
  for (const failure of failures) console.log(`  - ${failure}`)
}
if (failed > 0) process.exit(1)
