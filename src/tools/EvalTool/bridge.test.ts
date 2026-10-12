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

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join, relative, sep } from 'path'
import { z } from 'zod/v4'
import { getAgentContext, runWithAgentContext } from '../../utils/agentContext.js'
import { getForcedProvider, runWithForcedProvider } from '../../utils/forcedProvider.js'
import type { APIProvider } from '../../utils/model/providerRegistry.js'

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

/** A tool that declares it needs the user — excluded by predicate, not name. */
function interactiveFakeTool(name: string) {
  return { ...fakeTool(name, () => 'never'), requiresUserInteraction: () => true }
}

type Decision = { behavior: 'allow' | 'deny'; message?: string }

async function withBridge(
  options: {
    tools: unknown[]
    provider?: APIProvider
    model?: string
    agentId?: string
    decide?: (name: string) => Decision
    cwd?: string
    trackWrite?: (path: string, options: { created: boolean }) => Promise<void>
    commitWrites?: () => void
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
    provider: getForcedProvider() ?? options.provider,
    toolUseContext: {
      abortController: controller,
      agentId: options.agentId,
      options: { mainLoopModel: options.model },
    } as never,
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
    trackWrite: options.trackWrite,
    commitWrites: options.commitWrites,
  })

  const kernel = new PythonKernel({
    cwd: options.cwd ?? process.cwd(),
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

  for (const model of ['gpt-6-sol', 'gpt-5.6-luna']) {
    await asyncTest(`${model}: Codex aliases adapt inputs and return Tau results`, async () => {
      const seen: Array<{ name: string; input: Record<string, unknown> }> = []
      const read = {
        ...fakeTool('Read', input => {
          seen.push({ name: 'Read', input })
          return 'file contents'
        }),
        inputSchema: z.object({ file_path: z.string(), offset: z.number().optional() }),
      }
      const bash = {
        ...fakeTool('Bash', input => {
          seen.push({ name: 'Bash', input })
          return 'shell result'
        }),
        inputSchema: z.object({ command: z.string(), workdir: z.string(), run_in_background: z.boolean() }),
      }
      const grep = {
        ...fakeTool('Grep', input => {
          seen.push({ name: 'Grep', input })
          return 'grep result'
        }),
        inputSchema: z.object({ pattern: z.string(), glob: z.string(), output_mode: z.string() }),
      }
      await withBridge({ provider: 'openai', model, tools: [read, bash, grep] }, async (kernel, calls) => {
        const outcome = await kernel.execute([
          'assert tool.read_file(file_path="demo.txt", offset=2) == tool.Read(file_path="demo.txt", offset=2)',
          `assert tool.shell(command="echo hello", directory=${JSON.stringify(process.cwd())}, run_in_background=True) == "shell result"`,
          'assert tool.search_code(pattern="needle", include="*.ts", output_mode="content") == "grep result"',
          'names = tool.list()',
          'assert "Read" in names and "read_file (Read)" in names',
          'assert "shell (Bash)" in names and "search_code (Grep)" in names',
          'assert not any("apply_patch" in name or "list_directory" in name for name in names)',
        ].join('\n'), { timeoutMs: 20_000 })
        assert(outcome.ok, outcome.error?.traceback ?? 'alias cell failed')
        assert(JSON.stringify(seen[0]?.input) === JSON.stringify(seen[1]?.input), 'read alias differs from Tau call')
        assert(seen[2]?.input.workdir === process.cwd(), 'shell directory did not adapt to workdir')
        assert(seen[3]?.input.glob === '*.ts', 'search include did not adapt to glob')
        assert(calls.map(call => call.name).join(',') === 'Read,Read,Bash,Grep', 'calls did not retain Tau identities')
      })
    })
  }

  await asyncTest('undeclared, absent, unknown and other-lane aliases keep the existing error', async () => {
    await withBridge({ provider: 'openai', tools: [fakeTool('Read', () => 'ok')] }, async kernel => {
      const outcome = await kernel.execute([
        'for name in ["apply_patch", "list_directory", "write_file", "run_shell_command", "not_a_tool"]:',
        '    try:',
        '        getattr(tool, name)({})',
        '        raise AssertionError("unexpected alias: " + name)',
        '    except ToolBridgeError as error:',
        '        assert str(error) == name + " is not a tool in this session. Call tool.list() to see what is available."',
      ].join('\n'), { timeoutMs: 20_000 })
      assert(outcome.ok, outcome.error?.traceback ?? 'unexpected lookup result')
    })
  })

  await asyncTest('exact tool names win over native aliases', async () => {
    await withBridge({
      provider: 'openai',
      tools: [fakeTool('Read', () => 'Tau Read'), fakeTool('read_file', () => 'exact name')],
    }, async kernel => {
      const outcome = await kernel.execute([
        'assert tool.read_file(file_path="x") == "exact name"',
        'assert tool.Read(file_path="x") == "Tau Read"',
        'assert "read_file" in tool.list() and "read_file (Read)" not in tool.list()',
      ].join('\n'), { timeoutMs: 20_000 })
      assert(outcome.ok, outcome.error?.traceback ?? 'exact name lost')
    })
  })

  await asyncTest('alias calls retain permission and bridge eligibility checks', async () => {
    let ran = false
    await withBridge({
      provider: 'openai',
      tools: [fakeTool('Read', () => { ran = true; return 'never' }), interactiveFakeTool('Write')],
      decide: name => ({ behavior: 'deny', message: `denied ${name}` }),
    }, async kernel => {
      const outcome = await kernel.execute([
        'try:',
        '    tool.read_file(file_path="x")',
        'except ToolBridgeError as error:',
        '    assert "denied Read" in str(error)',
        'else:',
        '    raise AssertionError("permission skipped")',
        'try:',
        '    tool.write_file(file_path="x", content="y")',
        'except ToolBridgeError as error:',
        '    assert "cannot run from inside a cell" in str(error)',
        'else:',
        '    raise AssertionError("interactive alias accepted")',
        'assert "write_file (Write)" not in tool.list()',
      ].join('\n'), { timeoutMs: 20_000 })
      assert(outcome.ok, outcome.error?.traceback ?? 'permission cell failed')
      assert(!ran, 'denied alias ran')
    })
  })

  await asyncTest('provider routing belongs to the cell, including pinned subagents', async () => {
    for (const provider of ['openai', 'gemini'] as const) {
      const agentId = `alias-${provider}`
      await runWithAgentContext({ agentId, agentType: 'subagent' }, () =>
        runWithForcedProvider({ provider }, () => withBridge({
          // Deliberately give the other global provider/model. The agent's
          // pin remains authoritative under existing provider routing.
          provider: provider === 'openai' ? 'gemini' : 'openai',
          model: provider === 'openai' ? 'gemini-2.5-pro' : 'gpt-6-sol',
          agentId,
          tools: [fakeTool('Read', () => {
            assert(getForcedProvider() === provider, 'listener inherited another provider')
            assert(getAgentContext()?.agentId === agentId, 'listener inherited another agent')
            return 'owner restored'
          })],
          decide: () => {
            assert(getForcedProvider() === provider, 'permission checked under wrong provider')
            assert(getAgentContext()?.agentId === agentId, 'permission checked under wrong agent')
            return { behavior: 'allow' }
          },
        }, async kernel => {
          const code = provider === 'openai'
            ? 'assert tool.read_file(file_path="x") == "owner restored"'
            : [
                'assert tool.Read(file_path="x") == "owner restored"',
                'assert "read_file (Read)" not in tool.list()',
                'try:',
                '    tool.read_file(file_path="x")',
                'except ToolBridgeError as error:',
                '    assert "is not a tool in this session" in str(error)',
                'else:',
                '    raise AssertionError("OpenAI alias leaked to Gemini")',
              ].join('\n')
          const outcome = await kernel.execute(code, { timeoutMs: 20_000 })
          assert(outcome.ok, outcome.error?.traceback ?? 'provider scope failed')
        })),
      )
    }
  })

  await asyncTest('unpinned provider correction uses the owning cell model', async () => {
    await withBridge({ provider: 'gemini', model: 'gpt-5.6-luna', tools: [fakeTool('Read', () => 'routed')] }, async kernel => {
      const outcome = await kernel.execute('assert tool.read_file(file_path="x") == "routed"', { timeoutMs: 20_000 })
      assert(outcome.ok, outcome.error?.traceback ?? 'effective provider was ignored')
    })
  })

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

  await asyncTest('a session-mode tool is refused', async () => {
    // Blocked because it cannot work, not because it is unsafe: plan mode is
    // applied by the main loop from the tool result, so a bridged call would
    // report success and change nothing.
    await withBridge(
      { tools: [fakeTool('EnterPlanMode', () => 'nope')] },
      async kernel => {
        const outcome = await kernel.execute(
          'try:\n    tool.EnterPlanMode(file_path="x")\nexcept ToolBridgeError as e:\n    print("blocked:", e)',
          { timeoutMs: 20_000 },
        )
        assert(outcome.stdout.includes('blocked:'), `not blocked: ${outcome.stdout}`)
        assert(
          !outcome.stdout.includes('Available:'),
          'the error still pastes the whole tool inventory',
        )
      },
    )
  })

  await asyncTest('a tool needing the user is refused by predicate', async () => {
    await withBridge(
      { tools: [interactiveFakeTool('AskUserQuestion')] },
      async kernel => {
        const outcome = await kernel.execute(
          'try:\n    tool.AskUserQuestion(file_path="x")\nexcept ToolBridgeError as e:\n    print("blocked:", e)',
          { timeoutMs: 20_000 },
        )
        assert(outcome.stdout.includes('blocked:'), `not blocked: ${outcome.stdout}`)
      },
    )
  })

  await asyncTest('an ordinary workspace tool is reachable', async () => {
    // Regression: a hand-written allowlist refused ArtifactCanvas purely
    // because nobody had added it to the list.
    await withBridge(
      { tools: [fakeTool('ArtifactCanvas', () => 'canvas built')] },
      async kernel => {
        const outcome = await kernel.execute(
          'print(tool.ArtifactCanvas(file_path="x"))',
          { timeoutMs: 20_000 },
        )
        assert(
          outcome.stdout.includes('canvas built'),
          `an ordinary tool was withheld: ${outcome.stdout}`,
        )
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
          fakeTool('ArtifactCanvas', () => 'c'),
          fakeTool('EnterPlanMode', () => 'd'),
          interactiveFakeTool('AskUserQuestion'),
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
          outcome.stdout.includes('ArtifactCanvas'),
          'an ordinary workspace tool was withheld from the bridge',
        )
        assert(
          !outcome.stdout.includes('EnterPlanMode'),
          'a session-mode tool was advertised',
        )
        assert(
          !outcome.stdout.includes('AskUserQuestion'),
          'a tool declaring requiresUserInteraction was advertised',
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

  await asyncTest('plain Python writes ask for a backup before the file changes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tau-eval-backup-'))
    const seed: Record<string, string> = {
      'edit.txt': 'one',
      'append.txt': 'two',
      'src.txt': 'three',
      'dst.txt': 'four',
      'gone.txt': 'five',
      'keep.txt': 'six',
      'tree/a.txt': 'seven',
      'tree/b.txt': 'eight',
    }
    for (const [name, text] of Object.entries(seed)) {
      mkdirSync(dirname(join(dir, name)), { recursive: true })
      writeFileSync(join(dir, name), text)
    }
    // What each existing file held when the host was asked: a backup taken
    // then is only worth anything if the write has not landed yet. A new file
    // has nothing to save and must arrive flagged as created.
    const seen = new Map<string, string | null>()
    try {
      await withBridge(
        {
          tools: [],
          cwd: dir,
          trackWrite: async (path, { created }) => {
            const name = relative(dir, path).split(sep).join('/')
            seen.set(name, created ? null : existsSync(path) ? readFileSync(path, 'utf8') : 'MISSING')
          },
        },
        async (kernel, calls) => {
          const code = [
            'from pathlib import Path',
            'import os, shutil',
            'Path("edit.txt").write_text("ONE")',
            'Path("edit.txt").write_text("ONE AGAIN")',
            'with open("append.txt", "a") as f:',
            '    f.write("+")',
            'Path("new.txt").write_text("fresh")',
            'os.replace("src.txt", "dst.txt")',
            'os.remove("gone.txt")',
            'print(open("keep.txt").read())',
            'shutil.rmtree("tree")',
            'os.makedirs("__pycache__", exist_ok=True)',
            'Path("__pycache__/x.pyc").write_bytes(b"0")',
          ].join('\n')
          const outcome = await kernel.execute(code, { timeoutMs: 20_000 })
          assert(outcome.ok, `cell failed: ${outcome.error?.evalue}`)
          assert(outcome.stdout.includes('six'), `read-only open broke: ${outcome.stdout}`)
          assert(calls.length === 0, `backups showed up as tool calls: ${JSON.stringify(calls)}`)
        },
      )
      const expected: Record<string, string | null> = {
        'append.txt': 'two',
        'dst.txt': 'four',
        'edit.txt': 'one',
        'gone.txt': 'five',
        'new.txt': null,
        'src.txt': 'three',
        'tree/a.txt': 'seven',
        'tree/b.txt': 'eight',
      }
      const got = Object.fromEntries([...seen.entries()].sort(([a], [b]) => a.localeCompare(b)))
      assert(
        JSON.stringify(got) === JSON.stringify(expected),
        `backups asked for: ${JSON.stringify(got)}`,
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await asyncTest('a cell creating many files records every one as created', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tau-eval-backup-'))
    writeFileSync(join(dir, 'existing.txt'), 'before')
    const seen = new Map<string, string | null>()
    try {
      await withBridge(
        {
          tools: [],
          cwd: dir,
          trackWrite: async (path, { created }) => {
            seen.set(relative(dir, path), created ? null : readFileSync(path, 'utf8'))
          },
        },
        async kernel => {
          const outcome = await kernel.execute(
            'from pathlib import Path\nfor i in range(250):\n    Path(f"f{i}.txt").write_text("x")\nPath("existing.txt").write_text("after")',
            { timeoutMs: 60_000 },
          )
          assert(outcome.ok, `cell failed: ${outcome.error?.evalue}`)
        },
      )
      const created = [...seen.entries()].filter(([, v]) => v === null).length
      assert(created === 250, `expected 250 created files, got ${created}`)
      assert(seen.get('existing.txt') === 'before', `existing file backup: ${seen.get('existing.txt')}`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await asyncTest('backups are recorded before a bridged tool runs', async () => {
    // tool.Edit on a file the cell already wrote must find it tracked, or it
    // would back the file up again with the changed content.
    const dir = mkdtempSync(join(tmpdir(), 'tau-eval-backup-'))
    writeFileSync(join(dir, 'a.txt'), 'before')
    const order: string[] = []
    try {
      await withBridge(
        {
          tools: [fakeTool('Read', () => {
            order.push('tool')
            return 'ok'
          })],
          cwd: dir,
          trackWrite: async path => {
            order.push(`backup ${relative(dir, path)}`)
          },
          commitWrites: () => {
            order.push('commit')
          },
        },
        async kernel => {
          const outcome = await kernel.execute(
            'from pathlib import Path\nPath("a.txt").write_text("after")\ntool.Read(file_path="a.txt")',
            { timeoutMs: 20_000 },
          )
          assert(outcome.ok, `cell failed: ${outcome.error?.evalue}`)
        },
      )
      assert(
        JSON.stringify(order) === JSON.stringify(['backup a.txt', 'commit', 'tool']),
        `order: ${JSON.stringify(order)}`,
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await asyncTest('a failing backup never blocks the write', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tau-eval-backup-'))
    try {
      await withBridge(
        {
          tools: [],
          cwd: dir,
          trackWrite: async () => {
            throw new Error('disk full')
          },
        },
        async kernel => {
          const outcome = await kernel.execute(
            'from pathlib import Path\nPath("out.txt").write_text("done")\nprint(Path("out.txt").read_text())',
            { timeoutMs: 20_000 },
          )
          assert(outcome.ok, `cell failed: ${outcome.error?.evalue}`)
          assert(outcome.stdout.includes('done'), `write did not land: ${outcome.stdout}`)
        },
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await asyncTest('writes still work when the host tracks nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tau-eval-backup-'))
    try {
      await withBridge({ tools: [], cwd: dir }, async kernel => {
        const outcome = await kernel.execute(
          'import os\nopen("a.txt", "w").write("x")\nos.replace("a.txt", "b.txt")\nprint(sorted(os.listdir(".")))',
          { timeoutMs: 20_000 },
        )
        assert(outcome.ok, `cell failed: ${outcome.error?.evalue}`)
        assert(outcome.stdout.includes("['b.txt']"), outcome.stdout)
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
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
