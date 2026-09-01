/**
 * Figure capture: a matplotlib plot that exists only inside the running kernel
 * must reach the transcript as an image block.
 *
 * Run via: bun run src/tools/EvalTool/figure.test.ts
 *
 * This closes the gap named in docs/inline-images-handoff.md §8: "No
 * live-process capture. A plot must reach a file, a data URI, or a notebook."
 */
import { PythonKernel } from './kernel.js'
import { resolvePythonInterpreter } from './pythonRuntime.js'

let passed = 0
let failed = 0

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
    console.log(`  FAIL ${name}: ${e instanceof Error ? e.message : String(e)}`)
  }
}

function kernel(): PythonKernel {
  return new PythonKernel({
    cwd: process.cwd(),
    bridgeUrl: 'http://127.0.0.1:1',
    bridgeToken: 'unused',
    bridgeSession: 'figure-test',
  })
}

async function hasMatplotlib(k: PythonKernel): Promise<boolean> {
  const probe = await k.execute(
    'try:\n    import matplotlib\n    print("yes")\nexcept Exception:\n    print("no")',
    { timeoutMs: 60_000 },
  )
  return probe.stdout.includes('yes')
}

async function main(): Promise<void> {
  if (!resolvePythonInterpreter()) {
    console.log('figures: SKIPPED (no Python interpreter)')
    return
  }
  const probeKernel = kernel()
  await probeKernel.start()
  const available = await hasMatplotlib(probeKernel)
  await probeKernel.shutdown()
  if (!available) {
    console.log('figures: SKIPPED (matplotlib not installed)')
    return
  }

  console.log('\nfigure capture')

  await asyncTest('an open figure is captured as a PNG and closed', async () => {
    const k = kernel()
    try {
      const outcome = await k.execute(
        'import matplotlib.pyplot as plt\nplt.plot([1, 4, 9, 16])\nplt.title("demo")',
        { timeoutMs: 120_000 },
      )
      assert(outcome.ok, `cell failed: ${outcome.error?.evalue}`)
      const images = outcome.displays.filter(d => d.mime === 'image/png')
      assert(images.length === 1, `expected 1 figure, got ${images.length}`)
      const png = Buffer.from(images[0]!.data, 'base64')
      assert(png.length > 1000, `png looks empty: ${png.length} bytes`)
      // PNG magic number — proves it is a real image, not an error string.
      assert(
        png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47,
        'captured bytes are not a PNG',
      )

      // The figure must be closed, or the next cell re-emits it forever.
      const after = await k.execute(
        'import matplotlib.pyplot as plt\nprint(len(plt.get_fignums()))',
        { timeoutMs: 60_000 },
      )
      assert(after.stdout.includes('0'), 'the figure was not closed after capture')
      assert(
        after.displays.filter(d => d.mime === 'image/png').length === 0,
        'a stale figure was emitted again on the next cell',
      )
    } finally {
      await k.shutdown()
    }
  })

  await asyncTest('two figures in one cell both come back', async () => {
    const k = kernel()
    try {
      const outcome = await k.execute(
        'import matplotlib.pyplot as plt\nplt.figure()\nplt.plot([1,2])\nplt.figure()\nplt.plot([3,1])',
        { timeoutMs: 120_000 },
      )
      const images = outcome.displays.filter(d => d.mime === 'image/png')
      assert(images.length === 2, `expected 2 figures, got ${images.length}`)
    } finally {
      await k.shutdown()
    }
  })

  await asyncTest('display() renders an explicit object', async () => {
    const k = kernel()
    try {
      const outcome = await k.execute('display({"rows": 3, "cols": 2})', {
        timeoutMs: 60_000,
      })
      const json = outcome.displays.find(d => d.mime === 'application/json')
      assert(json !== undefined, 'display() did not emit a JSON bundle')
      assert(
        (json?.data ?? '').includes('"rows"'),
        `unexpected payload: ${json?.data ?? '(none)'}`,
      )
    } finally {
      await k.shutdown()
    }
  })

  await asyncTest('a figure survives being the last expression', async () => {
    const k = kernel()
    try {
      const outcome = await k.execute(
        'import matplotlib.pyplot as plt\nfig, ax = plt.subplots()\nax.bar(["a","b"], [3,5])\nfig',
        { timeoutMs: 120_000 },
      )
      const images = outcome.displays.filter(d => d.mime === 'image/png')
      assert(images.length >= 1, 'the trailing figure expression produced no image')
      assert(
        outcome.result === undefined,
        'a figure was stringified as a repr instead of rendered',
      )
    } finally {
      await k.shutdown()
    }
  })
}

await main()
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
