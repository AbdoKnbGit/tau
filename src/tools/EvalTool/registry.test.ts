/** Real Python processes: cwd changes must preserve an OpenAI agent's state. */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, isAbsolute } from 'node:path'
import { z } from 'zod/v4'
import { resolvePythonInterpreter } from './pythonRuntime.js'
import { acquireKernel, discardKernel, kernelKey, __disposeAllKernelsForTests } from './registry.js'
import { DeadlineBudget, disposeToolBridge, registerBridgeSession } from './toolBridge.js'

const root = mkdtempSync(join(realpathSync(tmpdir()), 'tau-eval-cwd-'))
const sub = join(root, 'sub folder ü')
mkdirSync(sub)
writeFileSync(join(root, 'root_module.py'), 'value = 10\n')
writeFileSync(join(sub, 'sub_module.py'), 'value = 32\n')
let passed = 0
let failed = 0
async function test(name: string, run: () => Promise<void> | void) {
  try {
    await run()
    passed++
    console.log(`  ok ${name}`)
  } catch (error) {
    failed++
    console.error(`  FAIL ${name}`, error)
  } finally {
    await __disposeAllKernelsForTests()
  }
}
const acquire = (cwd = root, agentId: string | undefined = undefined, followSessionCwd = true, reset = false) =>
  acquireKernel({ cwd, agentId, followSessionCwd, reset })

try {
  await test('OpenAI identity is per session and agent; legacy identity remains per directory', () => {
    assert.equal(kernelKey(undefined, root, true), kernelKey(undefined, sub, true))
    assert.notEqual(kernelKey(undefined, root, true), kernelKey('child', root, true))
    assert.notEqual(kernelKey(undefined, root), kernelKey(undefined, sub))
    assert.notEqual(kernelKey(undefined, root), kernelKey(undefined, root, true))
  })

  if (!resolvePythonInterpreter()) {
    console.log('Live registry tests skipped: no Python interpreter.')
  } else {
    await test('cwd changes reuse the process and namespace and update relative imports', async () => {
      const first = await acquire()
      const setup = await first.kernel.execute('import os, sys\nimport root_module\nx = root_module.value', { timeoutMs: 15_000, cwd: root })
      assert.equal(setup.ok, true, setup.error?.evalue)
      const next = await acquire(sub)
      assert.equal(next.kernel, first.kernel)
      assert.equal(next.sessionKey, first.sessionKey)
      assert.equal(next.restarted, false)
      const outcome = await next.kernel.execute(
        'import sub_module\nprint(x + sub_module.value)\nprint(os.getcwd())\nprint(sys.path[0])',
        { timeoutMs: 15_000, cwd: sub },
      )
      assert.equal(outcome.ok, true, outcome.error?.evalue)
      assert.deepEqual(outcome.stdout.trim().split(/\r?\n/), ['42', realpathSync(sub), realpathSync(sub)])
      const back = await first.kernel.execute('print(x)\nprint(os.getcwd())', { timeoutMs: 15_000, cwd: root })
      assert.deepEqual(back.stdout.trim().split(/\r?\n/), ['10', realpathSync(root)])
    })

    await test('a bridged shell cwd change does not replace the next cell kernel', async () => {
      let currentCwd = root
      const first = await acquire(currentCwd)
      const shell = {
        name: 'Bash', inputSchema: z.object({ command: z.string() }),
        async call({ command }: { command: string }) {
          assert.equal(command, 'cd sub && ls')
          currentCwd = sub
          return { data: 'sub_module.py' }
        },
        mapToolResultToToolResultBlockParam: (data: string, id: string) => ({ type: 'tool_result', tool_use_id: id, content: data }),
      }
      const unregister = registerBridgeSession(first.sessionKey, {
        provider: 'openai', tools: [shell] as never,
        toolUseContext: { options: { mainLoopModel: 'fixture' } } as never,
        parentMessage: {} as never, signal: new AbortController().signal,
        canUseTool: (async () => ({ behavior: 'allow' })) as never,
        onCall() {}, budget: new DeadlineBudget(),
      })
      try {
        const setup = await first.kernel.execute('x = 42\nprint(tool.Bash(command="cd sub && ls"))', { timeoutMs: 15_000, cwd: currentCwd })
        assert.equal(setup.ok, true, setup.error?.evalue)
        assert.equal(currentCwd, sub)
        const next = await acquire(currentCwd)
        assert.equal(next.kernel, first.kernel)
        const read = await next.kernel.execute('import os\nprint(x)\nprint(os.getcwd())', { timeoutMs: 15_000, cwd: currentCwd })
        assert.deepEqual(read.stdout.trim().split(/\r?\n/), ['42', realpathSync(sub)])
      } finally {
        unregister()
      }
    })

    await test('an invalid new directory fails one cell without running it or losing variables', async () => {
      const { kernel } = await acquire()
      assert.equal((await kernel.execute('x = 42', { timeoutMs: 15_000, cwd: root })).ok, true)
      const bad = await kernel.execute('x = 0', { timeoutMs: 15_000, cwd: join(root, 'missing') })
      assert.equal(bad.ok, false)
      assert.equal(bad.error?.ename, 'FileNotFoundError')
      const recovered = await kernel.execute('print(x)', { timeoutMs: 15_000, cwd: sub })
      assert.equal(recovered.stdout.trim(), '42')
    })

    await test('subagents keep independent namespaces even in the same directory', async () => {
      const main = await acquire()
      const child = await acquire(root, 'child')
      assert.notEqual(main.kernel, child.kernel)
      await main.kernel.execute('x = 42', { timeoutMs: 15_000, cwd: root })
      const result = await child.kernel.execute('print("x" in globals())', { timeoutMs: 15_000, cwd: root })
      assert.equal(result.stdout.trim(), 'False')
    })

    await test('reset after cwd change clears the same namespace explicitly', async () => {
      const first = await acquire()
      await first.kernel.execute('x = 42', { timeoutMs: 15_000, cwd: root })
      const reset = await acquire(sub, undefined, true, true)
      assert.equal(reset.kernel, first.kernel)
      assert.equal(reset.restarted, true)
      const result = await reset.kernel.execute('import os\nprint("x" in globals())\nprint(os.getcwd())', { timeoutMs: 15_000, cwd: sub })
      assert.deepEqual(result.stdout.trim().split(/\r?\n/), ['False', realpathSync(sub)])
    })

    await test('a dead kernel restarts at the current directory and reports state loss', async () => {
      const first = await acquire()
      await first.kernel.shutdown()
      const next = await acquire(sub)
      assert.notEqual(next.kernel, first.kernel)
      assert.equal(next.restarted, true)
      const result = await next.kernel.execute('import os\nprint(os.getcwd())', { timeoutMs: 15_000, cwd: sub })
      assert.equal(result.stdout.trim(), realpathSync(sub))
    })

    await test('discard after a directory change removes the OpenAI entry only', async () => {
      const first = await acquire()
      const legacy = await acquire(root, undefined, false)
      discardKernel(undefined, sub, true)
      const next = await acquire(sub)
      assert.notEqual(next.kernel, first.kernel)
      assert.equal((await acquire(root, undefined, false)).kernel, legacy.kernel)
      await first.kernel.shutdown()
    })

    await test('other-provider directory kernels and cell-local chdir remain unchanged', async () => {
      const first = await acquire(root, undefined, false)
      await first.kernel.execute('x = 42', { timeoutMs: 15_000 })
      const other = await acquire(sub, undefined, false)
      assert.notEqual(other.kernel, first.kernel)
      const check = await other.kernel.execute('print("x" in globals())', { timeoutMs: 15_000 })
      assert.equal(check.stdout.trim(), 'False')
      const change = await first.kernel.execute(`import os\nos.chdir(${JSON.stringify(sub)})`, { timeoutMs: 15_000 })
      assert.equal(change.ok, true, change.error?.evalue)
      const kept = await first.kernel.execute('print(x)\nprint(os.getcwd())', { timeoutMs: 15_000 })
      assert.deepEqual(kept.stdout.trim().split(/\r?\n/), ['42', realpathSync(sub)])
    })
  }
} finally {
  await __disposeAllKernelsForTests()
  await disposeToolBridge()
  const child = relative(realpathSync(tmpdir()), realpathSync(root))
  assert.ok(child && !child.startsWith('..') && !isAbsolute(child))
  rmSync(root, { recursive: true, force: true })
}
console.log(`${passed} passed, ${failed} failed`)
if (failed) process.exitCode = 1
