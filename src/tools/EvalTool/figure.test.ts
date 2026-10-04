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
import { createHash } from 'crypto'

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

const crowdedPanels = `
import matplotlib.pyplot as plt
fig, axes = plt.subplots(1, 2, figsize=(4, 3))
for i, ax in enumerate(axes):
    ax.plot([0, 1], [0, 1])
    ax.set_title('Panel %s descriptive title' % i, fontsize=14)
fig.subplots_adjust(wspace=0.02)
`

function assertQuiet(outcome: Awaited<ReturnType<PythonKernel['execute']>>): void {
  assert(outcome.ok, `cell failed: ${outcome.error?.evalue}`)
  assert(!outcome.timedOut && !outcome.crashed, 'layout inspection interrupted the kernel')
  assert(outcome.stderr === '', `internal layout diagnostic leaked: ${outcome.stderr}`)
  assert(!outcome.stdout.includes('[chart layout]'), 'private diagnostic leaked to visible output')
}

const baselinePng = `
import io, hashlib
baseline = io.BytesIO()
fig.savefig(baseline, format='png', dpi=110, bbox_inches='tight')
print(hashlib.sha256(baseline.getvalue()).hexdigest())
`

function assertBaselineImage(outcome: Awaited<ReturnType<PythonKernel['execute']>>): void {
  const image = outcome.displays.find(d => d.mime === 'image/png')
  assert(image, 'the original PNG was lost')
  const hash = createHash('sha256').update(Buffer.from(image!.data, 'base64')).digest('hex')
  assert(outcome.stdout.includes(hash), 'an unchanged/original chart was modified')
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

  console.log('\nchart layout protection')

  for (const mode of ['automatic', 'explicit']) {
    await asyncTest(`all five crowded figures get corrected (${mode} capture), verified against emitted pixels`, async () => {
      const k = kernel()
      try {
        const outcome = await k.execute(`
import hashlib, json
import matplotlib.pyplot as plt
layout_test_sentinel = 12345
observations = {}
def observe(event, chart, axes):
    renderer = event.renderer
    a, b = [ax.title.get_window_extent(renderer) for ax in axes]
    right = axes[1].yaxis
    lo, hi = sorted(right.get_view_interval())
    ticks = [tick.label1.get_window_extent(renderer) for tick in right.get_major_ticks()
             if lo <= tick.get_loc() <= hi and tick.label1.get_visible()]
    pixels = renderer.buffer_rgba()
    observations.setdefault(chart, []).append({
        'titles_overlap': bool(a.overlaps(b)),
        'ticks_intrude': any(bool(box.overlaps(axes[0].bbox)) for box in ticks),
        'pixels': hashlib.sha256(pixels).hexdigest(),
    })
for chart in range(5):
    fig, axes = plt.subplots(1, 2, figsize=(4, 3))
    for panel, ax in enumerate(axes):
        ax.plot([0, 1], [chart, chart + panel + 1])
        ax.set_title(f'Chart {chart}, panel {panel}: results', fontsize=14)
    fig.subplots_adjust(wspace=0.02)
    fig.canvas.mpl_connect('draw_event', lambda event, chart=chart, axes=axes: observe(event, chart, axes))
    if '${mode}' == 'explicit':
        display(fig)
        plt.close(fig)
`, { timeoutMs: 60_000 })
        assertQuiet(outcome)
        const images = outcome.displays.filter(d => d.mime === 'image/png')
        assert(images.length === 5, `expected all five figures, got ${images.length}`)
        const measurements = await k.execute(`
assert layout_test_sentinel == 12345
assert len(plt.get_fignums()) == 0
print(json.dumps(observations))
`, { timeoutMs: 10_000 })
        assertQuiet(measurements)
        const records = JSON.parse(measurements.stdout) as Record<string, {
          titles_overlap: boolean
          ticks_intrude: boolean
          pixels: string
        }[]>
        const { default: sharp } = await import('sharp')
        for (let i = 0; i < images.length; i++) {
          const draws = records[String(i)]!
          assert(draws[0]!.titles_overlap, `figure ${i} was not initially crowded`)
          const pixels = await sharp(Buffer.from(images[i]!.data, 'base64')).ensureAlpha().raw().toBuffer()
          const digest = createHash('sha256').update(pixels).digest('hex')
          const emitted = draws.find(draw => draw.pixels === digest)
          assert(emitted, `figure ${i} PNG does not match a measured render`)
          assert(!emitted!.titles_overlap, `figure ${i} emitted overlapping titles`)
          assert(!emitted!.ticks_intrude, `figure ${i} emitted ticks inside the adjacent panel`)
          assert(draws.length <= 6, `figure ${i} exceeded two repair attempts`)
        }
        assert(outcome.statuses.every(s => s.op !== 'chart_layout'), 'some figures were only warned about')
      } finally {
        await k.shutdown()
      }
    })
  }

  await asyncTest('crowded panels are repaired before output without changing the live figure', async () => {
    const k = kernel()
    try {
      const outcome = await k.execute(crowdedPanels + `
initial_size = tuple(fig.get_size_inches())
initial_positions = [(tuple(ax.get_position().bounds), tuple(ax.get_position(original=True).bounds), ax.get_in_layout()) for ax in axes]
initial_engine = fig.get_layout_engine()
overlaps = []
def inspect(event):
    a, b = [ax.title.get_window_extent(event.renderer) for ax in axes]
    overlaps.append(a.overlaps(b))
fig.canvas.mpl_connect('draw_event', inspect)
callbacks = len(fig.canvas.callbacks.callbacks.get('draw_event', {}))
display(fig)
assert overlaps[0], 'fixture did not start with overlapping titles'
assert not overlaps[-1], 'titles still overlap in the final rendered candidate'
assert tuple(fig.get_size_inches()) == initial_size, 'live figure size changed'
assert [(tuple(ax.get_position().bounds), tuple(ax.get_position(original=True).bounds), ax.get_in_layout()) for ax in axes] == initial_positions, 'live axes changed'
assert fig.get_layout_engine() is initial_engine, 'layout engine changed'
assert len(fig.canvas.callbacks.callbacks.get('draw_event', {})) == callbacks, 'draw callback leaked'
assert len(overlaps) <= 6, 'too many repair renders'
plt.close(fig)
`, { timeoutMs: 60_000 })
      assertQuiet(outcome)
      assert(outcome.displays.filter(d => d.mime === 'image/png').length === 1, 'intermediate charts were displayed')
      assert(outcome.statuses.every(s => s.op !== 'chart_layout'), 'a repaired chart still produced a correction note')
    } finally {
      await k.shutdown()
    }
  })

  await asyncTest('clean 45-degree labels keep the identical PNG despite overlapping upright boxes', async () => {
    const k = kernel()
    try {
      const outcome = await k.execute(`
import matplotlib.pyplot as plt
fig, ax = plt.subplots(figsize=(8, 3))
ax.set_xticks(range(12), ['Long category %02d' % i for i in range(12)], rotation=45, ha='right')
ax.set_xlim(-1, 12)
rect_overlaps = []
def inspect(event):
    boxes = [label.get_window_extent(event.renderer) for label in ax.get_xticklabels()]
    rect_overlaps.append(any(a.overlaps(b) for i, a in enumerate(boxes) for b in boxes[i + 1:]))
fig.canvas.mpl_connect('draw_event', inspect)
` + baselinePng + `
assert rect_overlaps[-1], 'fixture needs overlapping axis-aligned boxes'
rect_overlaps.clear()
display(fig)
assert len(rect_overlaps) == 2, 'a clean plot incurred a repair render'
assert all(label.get_rotation() == 45 for label in ax.get_xticklabels()), 'label rotations changed'
plt.close(fig)
`, { timeoutMs: 60_000 })
      assertQuiet(outcome)
      assertBaselineImage(outcome)
      assert(outcome.statuses.every(s => s.op !== 'chart_layout'), 'false overlap report for clean angled labels')
    } finally {
      await k.shutdown()
    }
  })

  await asyncTest('real angled-label collisions produce only a private correction note when still crowded', async () => {
    const k = kernel()
    try {
      const outcome = await k.execute(`
import matplotlib.pyplot as plt
fig, ax = plt.subplots(figsize=(2, 2))
ax.set_xticks(range(20), ['Category %02d' % i for i in range(20)], rotation=45, ha='right')
ax.set_xlim(-1, 20)
display(fig)
plt.close(fig)
`, { timeoutMs: 60_000 })
      assertQuiet(outcome)
      assert(outcome.displays.some(d => d.mime === 'image/png'), 'crowded image disappeared')
      const notes = outcome.statuses.filter(s => s.op === 'chart_layout')
      assert(notes.length === 1 && notes[0]!.detail.includes('Category'), 'remaining collision did not reach the model')
      const next = await k.execute('print("next cell")', { timeoutMs: 10_000 })
      assertQuiet(next)
      assert(next.statuses.length === 0 && next.displays.length === 0, 'chart state leaked into the next cell')
    } finally {
      await k.shutdown()
    }
  })

  await asyncTest('explicit unmanaged figures use the same correction path', async () => {
    const k = kernel()
    try {
      const outcome = await k.execute(`
from matplotlib.figure import Figure
fig = Figure(figsize=(4, 3))
axes = fig.subplots(1, 2)
for i, ax in enumerate(axes):
    ax.plot([0, 1], [0, 1])
    ax.set_title('Panel %s descriptive title' % i, fontsize=14)
fig.subplots_adjust(wspace=0.02)
overlaps = []
def inspect(event):
    a, b = [ax.title.get_window_extent(event.renderer) for ax in axes]
    overlaps.append(a.overlaps(b))
fig.canvas.mpl_connect('draw_event', inspect)
display(fig)
assert overlaps[0] and not overlaps[-1], 'unmanaged figure was not repaired'
`, { timeoutMs: 60_000 })
      assertQuiet(outcome)
      assert(outcome.displays.filter(d => d.mime === 'image/png').length === 1, 'unmanaged display failed')
      assert(outcome.statuses.every(s => s.op !== 'chart_layout'), 'unmanaged repair left a note')
    } finally {
      await k.shutdown()
    }
  })

  await asyncTest('trailing figures and automatic capture reuse the identical repaired image', async () => {
    const k = kernel()
    try {
      const outcome = await k.execute(crowdedPanels + '\nfig', { timeoutMs: 60_000 })
      assertQuiet(outcome)
      const images = outcome.displays.filter(d => d.mime === 'image/png')
      assert(images.length === 2 && images[0]!.data === images[1]!.data, 'repeat capture lost or changed the repair')
      assert(outcome.statuses.every(s => s.op !== 'chart_layout'), 'repeat capture exhausted the repair and reported stale overlap')
    } finally {
      await k.shutdown()
    }
  })

  await asyncTest('a failed repair does not deprive later figures, and the fifth repair is reusable', async () => {
    const k = kernel()
    try {
      const outcome = await k.execute(`
import matplotlib.pyplot as plt
from matplotlib.layout_engine import TightLayoutEngine
saved = TightLayoutEngine.execute
attempts = {}
def selective_failure(self, target):
    number = int(target.get_label())
    attempts[number] = attempts.get(number, 0) + 1
    if number == 0:
        raise RuntimeError('first figure cannot be repaired')
    return saved(self, target)
TightLayoutEngine.execute = selective_failure
try:
    for chart in range(5):
        fig, axes = plt.subplots(1, 2, figsize=(4, 3))
        fig.set_label(str(chart))
        for panel, ax in enumerate(axes):
            ax.plot([0, 1], [chart, chart + panel + 1])
            ax.set_title(f'Chart {chart}, panel {panel}: results', fontsize=14)
        fig.subplots_adjust(wspace=0.02)
        display(fig)
        if chart == 4:
            display(fig)
        plt.close(fig)
finally:
    TightLayoutEngine.execute = saved
assert set(attempts) == set(range(5)), 'later figures never got a repair attempt'
assert all(n <= 2 for n in attempts.values()), 'a repeat spent another repair allowance'
`, { timeoutMs: 60_000 })
      assertQuiet(outcome)
      const images = outcome.displays.filter(d => d.mime === 'image/png')
      assert(images.length === 6, 'a failed repair lost subsequent figures')
      assert(images[4]!.data === images[5]!.data, 'the fifth corrected chart was not reused')
      const notes = outcome.statuses.filter(s => s.op === 'chart_layout').map(s => s.detail).join('\n')
      assert(notes.includes('Chart 0'), 'failed chart lost its model-only correction note')
      assert(!/Chart [1-4]/.test(notes), 'successfully repaired later figures received stale warnings')
    } finally {
      await k.shutdown()
    }
  })

  await asyncTest('large batches remain bounded and disclose skipped repairs only to the model', async () => {
    const k = kernel()
    try {
      const outcome = await k.execute(`
import matplotlib.pyplot as plt
from matplotlib.layout_engine import TightLayoutEngine
saved = TightLayoutEngine.execute
attempts = {}
def count(self, target):
    number = int(target.get_label())
    attempts[number] = attempts.get(number, 0) + 1
    return saved(self, target)
TightLayoutEngine.execute = count
try:
    for chart in range(17):
        fig, axes = plt.subplots(1, 2, figsize=(4, 3))
        fig.set_label(str(chart))
        for panel, ax in enumerate(axes):
            ax.plot([0, 1], [chart, chart + panel + 1])
            ax.set_title(f'Chart {chart}, panel {panel}: results', fontsize=14)
        fig.subplots_adjust(wspace=0.02)
        display(fig)
        plt.close(fig)
finally:
    TightLayoutEngine.execute = saved
assert set(attempts) == set(range(16)), 'batch repair bound was lost or consumed too early'
assert all(n <= 2 for n in attempts.values()), 'per-figure retry bound was lost'
`, { timeoutMs: 60_000 })
      assertQuiet(outcome)
      assert(outcome.displays.filter(d => d.mime === 'image/png').length === 17, 'batch limit dropped a chart')
      const notes = outcome.statuses.filter(s => s.op === 'chart_layout')
      assert(notes.length === 1 && notes[0]!.detail.includes('safety limit'), 'batch limit was silently hidden from the model')
      assert(notes[0]!.detail.length < 2000, 'batch diagnostics were not bounded')
      const next = await k.execute(crowdedPanels + '\nfig', { timeoutMs: 60_000 })
      assertQuiet(next)
      assert(next.statuses.every(s => s.op !== 'chart_layout'), 'exhausted allowance leaked into the next cell')
    } finally {
      await k.shutdown()
    }
  })

  await asyncTest('inspection limits keep all images and a private notice, without losing cached repairs', async () => {
    const k = kernel()
    try {
      const outcome = await k.execute(crowdedPanels + `
display(fig)
for repeat in range(32):
    display(fig)
plt.close(fig)
other, ax = plt.subplots(figsize=(3, 2))
ax.plot([0, 1], [1, 0])
display(other)
plt.close(other)
`, { timeoutMs: 60_000 })
      assertQuiet(outcome)
      const images = outcome.displays.filter(d => d.mime === 'image/png')
      assert(images.length === 34, 'inspection cap dropped images')
      assert(images.slice(0, 33).every(image => image.data === images[0]!.data), 'inspection cap lost an existing repair')
      assert(outcome.statuses.some(s => s.op === 'chart_layout' && s.detail.includes('safety limit')), 'unchecked new chart was not disclosed privately')
    } finally {
      await k.shutdown()
    }
  })

  for (const helper of ['_chart_boxes', '_chart_collisions']) {
    await asyncTest(`${helper} failure preserves the original image and successful cell`, async () => {
      const k = kernel()
      try {
        const outcome = await k.execute(crowdedPanels + baselinePng + `
internals = display.__globals__
saved = internals['${helper}']
def fail(*args):
    raise RuntimeError('injected layout inspection failure')
internals['${helper}'] = fail
try:
    display(fig)
finally:
    internals['${helper}'] = saved
    plt.close(fig)
`, { timeoutMs: 60_000 })
        assertQuiet(outcome)
        assertBaselineImage(outcome)
      } finally {
        await k.shutdown()
      }
    })
  }

  await asyncTest('a failed repair is silent, restores geometry, and keeps the original PNG', async () => {
    const k = kernel()
    try {
      const outcome = await k.execute(crowdedPanels + baselinePng + `
import warnings
from matplotlib.layout_engine import TightLayoutEngine
size = tuple(fig.get_size_inches())
positions = [tuple(ax.get_position().bounds) for ax in axes]
saved = TightLayoutEngine.execute
def fail(self, target):
    target.subplots_adjust(wspace=0.8)
    warnings.warn('injected repair warning')
    raise RuntimeError('injected repair failure')
TightLayoutEngine.execute = fail
try:
    display(fig)
finally:
    TightLayoutEngine.execute = saved
assert tuple(fig.get_size_inches()) == size, 'failed repair changed size'
assert [tuple(ax.get_position().bounds) for ax in axes] == positions, 'failed repair changed positions'
plt.close(fig)
`, { timeoutMs: 60_000 })
      assertQuiet(outcome)
      assertBaselineImage(outcome)
      assert(outcome.statuses.some(s => s.op === 'chart_layout'), 'failed repair lost the private correction note')
    } finally {
      await k.shutdown()
    }
  })

  await asyncTest('manual axes are preserved and the model privately receives remaining overlap', async () => {
    const k = kernel()
    try {
      const outcome = await k.execute(`
import matplotlib.pyplot as plt
fig = plt.figure(figsize=(4, 3))
axes = [fig.add_axes([0.1, 0.2, 0.4, 0.6]), fig.add_axes([0.51, 0.2, 0.4, 0.6])]
for i, ax in enumerate(axes):
    ax.set_title('Panel %s descriptive title' % i, fontsize=14)
` + baselinePng + `
display(fig)
plt.close(fig)
`, { timeoutMs: 60_000 })
      assertQuiet(outcome)
      assertBaselineImage(outcome)
      assert(outcome.statuses.some(s => s.op === 'chart_layout'), 'manual layout lost the private note')
    } finally {
      await k.shutdown()
    }
  })

  await asyncTest('hidden axes and out-of-range ticks do not trigger a repair', async () => {
    const k = kernel()
    try {
      const outcome = await k.execute(`
import matplotlib.pyplot as plt
fig, ax = plt.subplots(figsize=(6, 3))
ax.plot([0, 1], [0, 1])
ax.set_xticks([-0.2, 0, 0.5, 1, 1.2], ['long hidden label', '0', '0.5', '1', 'long hidden label'])
ax.set_xlim(0, 1)
hidden = fig.add_axes(ax.get_position())
hidden.set_title('Invisible title that crosses visible labels')
hidden.set_visible(False)
` + baselinePng + `
display(fig)
plt.close(fig)
`, { timeoutMs: 60_000 })
      assertQuiet(outcome)
      assertBaselineImage(outcome)
      assert(outcome.statuses.every(s => s.op !== 'chart_layout'), 'invisible labels produced a correction note')
    } finally {
      await k.shutdown()
    }
  })

  await asyncTest('a candidate render failure keeps the first successful PNG and removes the callback', async () => {
    const k = kernel()
    try {
      const outcome = await k.execute(crowdedPanels + baselinePng + `
saved = fig.savefig
calls = []
def fail_candidate(*args, **kwargs):
    calls.append(1)
    if len(calls) > 1:
        raise RuntimeError('injected candidate render failure')
    return saved(*args, **kwargs)
callbacks = len(fig.canvas.callbacks.callbacks.get('draw_event', {}))
fig.savefig = fail_candidate
display(fig)
assert len(calls) == 2, 'candidate was not exercised'
assert len(fig.canvas.callbacks.callbacks.get('draw_event', {})) == callbacks, 'callback leaked on render failure'
fig.savefig = saved
plt.close(fig)
`, { timeoutMs: 60_000 })
      assertQuiet(outcome)
      assertBaselineImage(outcome)
    } finally {
      await k.shutdown()
    }
  })

  await asyncTest('1,500 labels skip inspection without an extra render or warning', async () => {
    const k = kernel()
    try {
      const outcome = await k.execute(`
import matplotlib.pyplot as plt
fig, ax = plt.subplots(figsize=(8, 3))
ax.set_xticks(range(1500), [str(i) for i in range(1500)], fontsize=2)
ax.set_xlim(-1, 1500)
draws = []
def inspect(event):
    draws.append(1)
fig.canvas.mpl_connect('draw_event', inspect)
display(fig)
assert len(draws) == 2, 'oversized label set incurred extra renders'
plt.close(fig)
`, { timeoutMs: 60_000 })
      assertQuiet(outcome)
      assert(outcome.displays.some(d => d.mime === 'image/png'), 'large chart disappeared')
      assert(outcome.statuses.every(s => s.op !== 'chart_layout'), 'partial inspection produced a warning')
    } finally {
      await k.shutdown()
    }
  })
}

await main()
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
