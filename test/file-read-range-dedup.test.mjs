import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test, { after } from 'node:test'

// Exercise the shipped Read and Edit tools together, the way a model drives
// them: each Read result is appended to the conversation the next call sees.
process.env.NODE_ENV = 'test'
// Reads near the limit ask the API for an exact token count. Keep that offline
// (a closed local port fails at once, and Read falls back to its estimate),
// and keep the fixtures the test harness records out of the repo.
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:9'
const fixturesRoot = mkdtempSync(join(tmpdir(), 'tau-range-dedup-fixtures-'))
process.env.CLAUDE_CODE_TEST_FIXTURES_ROOT = fixturesRoot
after(() => rmSync(fixturesRoot, { recursive: true, force: true }))
process.env.CLAUDE_CODE_SIMPLE = '1'
process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING = '1'
process.env.DISABLE_TELEMETRY = '1'
const distPath = resolve('dist/tau.mjs')
const auditPath = join(dirname(distPath), `.range-dedup-audit-${process.pid}-${Date.now()}.mjs`)
let source = readFileSync(distPath, 'utf8').replace(/\nvoid main\d*\(\);\r?\n/, '\n')
source += `
export function __rangeDedupAudit() {
  init_FileReadTool(); init_FileEditTool(); init_fileStateCache();
  return { FileReadTool, FileEditTool, createFileStateCacheWithSizeLimit };
}
`
writeFileSync(auditPath, source)
let audit
try {
  audit = (await import(pathToFileURL(auditPath).href)).__rangeDedupAudit()
} finally {
  unlinkSync(auditPath)
}

const rows = count => Array.from({ length: count }, (_, i) => `row ${i + 1}: ${'abcdefghij'.repeat(3)}`)
const parent = { message: { id: 'assistant-message' } }

function makeContext() {
  return {
    readFileState: audit.createFileStateCacheWithSizeLimit(20),
    abortController: new AbortController(),
    fileReadingLimits: { maxSizeBytes: 2_000_000, maxTokens: 1_000_000 },
    getAppState: () => ({ toolPermissionContext: {
      mode: 'default', alwaysAllowRules: {}, alwaysDenyRules: {}, alwaysAskRules: {}, additionalWorkingDirectories: new Map(),
    } }),
    updateFileHistoryState: () => {},
    messages: [],
  }
}

async function fixture(run, lines = rows(300)) {
  const root = mkdtempSync(join(tmpdir(), 'tau-range-dedup-test-'))
  const file = join(root, 'notes.txt')
  writeFileSync(file, lines.join('\n'))
  try { await run(file, makeContext(), lines) } finally {
    assert.ok(root.includes('tau-range-dedup-test-'))
    rmSync(root, { recursive: true, force: true })
  }
}

let ids = 0
/** A model Read: its result lands in the conversation like a real tool_result. */
async function modelRead(file, context, extra = {}) {
  const id = `read-${++ids}`
  const result = await audit.FileReadTool.call({ file_path: file, ...extra }, { ...context, toolUseId: id }, undefined, parent)
  const block = audit.FileReadTool.mapToolResultToToolResultBlockParam(result.data, id)
  context.messages.push({ type: 'user', message: { role: 'user', content: [block] } })
  return { data: result.data, text: block.content }
}

const edit = (file, context, old_string, new_string) =>
  audit.FileEditTool.call({ file_path: file, old_string, new_string }, context, undefined, { uuid: 'range-dedup-test' })

function touchFuture(file, seconds) {
  const future = new Date(Date.now() + seconds * 1000)
  utimesSync(file, future, future)
}

test('lines an earlier result shows unchanged come back as a short note, once', async () => {
  await fixture(async (file, context) => {
    assert.equal((await modelRead(file, context)).data.type, 'text')
    const note = await modelRead(file, context, { offset: 50, limit: 20 })
    assert.equal(note.data.type, 'file_unchanged')
    assert.deepEqual(note.data.file.lines, { start: 50, end: 69, seenStart: 1, seenEnd: 300 })
    assert.match(note.text, /^Unchanged lines 50-69: identical to your earlier read of lines 1-300/)
    assert.ok(note.text.length < 300)
    // Asking again right after the note sends the lines.
    const again = await modelRead(file, context, { offset: 50, limit: 20 })
    assert.equal(again.data.type, 'text')
    assert.equal(again.data.file.startLine, 50)
    assert.equal(again.data.file.numLines, 20)
  })
})

test('no note once the earlier result has left the conversation', async () => {
  await fixture(async (file, context) => {
    await modelRead(file, context)
    context.messages.length = 0 // rewound, or compacted away
    assert.equal((await modelRead(file, context, { offset: 50, limit: 20 })).data.type, 'text')
    await modelRead(file, context)
    context.messages[context.messages.length - 1].message.content[0].content = '[Old tool result content cleared]'
    assert.equal((await modelRead(file, context, { offset: 80, limit: 5 })).data.type, 'text')
  })
})

test('internal reads neither answer with a note nor count as shown', async () => {
  await fixture(async (file, context) => {
    await audit.FileReadTool.call({ file_path: file }, context)
    assert.equal((await modelRead(file, context, { offset: 10, limit: 5 })).data.type, 'text')
    await modelRead(file, context)
    const internal = await audit.FileReadTool.call({ file_path: file, offset: 30, limit: 5 }, context)
    assert.equal(internal.data.type, 'text')
  })
})

test('an edit keeps untouched lines reusable and sends shifted lines again', async () => {
  await fixture(async (file, context, lines) => {
    await modelRead(file, context)
    await edit(file, context, lines[199], 'row 200: changed in place')
    assert.equal((await modelRead(file, context, { offset: 50, limit: 20 })).data.type, 'file_unchanged')
    await edit(file, context, lines[9], `${lines[9]}\ninserted below row 10`)
    assert.equal((await modelRead(file, context, { offset: 120, limit: 20 })).data.type, 'text')
    assert.equal((await modelRead(file, context, { offset: 1, limit: 5 })).data.type, 'file_unchanged')
  })
})

test('offset 0 reads and numbers from line 1', async () => {
  await fixture(async (file, context) => {
    const { data, text } = await modelRead(file, context, { offset: 0, limit: 3 })
    assert.equal(data.file.startLine, 1)
    assert.match(text, /^1\trow 1:/)
  })
})

test('a newer mtime alone does not make a ranged read stale', async () => {
  await fixture(async (file, context, lines) => {
    await modelRead(file, context, { offset: 1, limit: 20 })
    const changed = [...lines]
    changed[199] = 'row 200: changed by a formatter'
    writeFileSync(file, changed.join('\n'))
    touchFuture(file, 5)
    const input = { file_path: file, old_string: lines[4], new_string: 'row 5: edited' }
    assert.equal((await audit.FileEditTool.validateInput(input, context)).result, true)
  })
})

test('a stale read shows the current lines and counts as the read', async () => {
  await fixture(async (file, context, lines) => {
    await modelRead(file, context, { offset: 1, limit: 20 })
    const changed = [...lines]
    changed[4] = 'row 5: changed by the user'
    writeFileSync(file, changed.join('\n'))
    touchFuture(file, 5)
    const stale = { file_path: file, old_string: lines.slice(3, 6).join('\n'), new_string: 'x' }
    const rejection = await audit.FileEditTool.validateInput(stale, context)
    assert.equal(rejection.result, false)
    assert.match(rejection.message, /modified since read/)
    assert.match(rejection.message, /\n5\trow 5: changed by the user\n/)
    const retry = { ...stale, old_string: changed.slice(3, 6).join('\n') }
    assert.equal((await audit.FileEditTool.validateInput(retry, context)).result, true)
  })
})

test('a long old_string that fails names the differing line and shows it', async () => {
  await fixture(async (file, context, lines) => {
    await modelRead(file, context)
    const remembered = lines.slice(99, 160)
    remembered[50] = 'row 150: remembered wrongly'
    const input = { file_path: file, old_string: remembered.join('\n'), new_string: 'replacement' }
    const rejection = await audit.FileEditTool.validateInput(input, context)
    assert.equal(rejection.result, false)
    assert.match(rejection.message, /^String to replace not found in file\./)
    assert.match(rejection.message, /matches the file from line 100 to 149, then differs at line 150/)
    assert.ok(rejection.message.includes(`\n150\t${lines[149]}\n`))
    assert.ok(!rejection.message.includes(lines[129]), 'neither echoes nor shows lines far from the difference')
  })
})

test('an edit that changes the line count says where the lines below moved', async () => {
  await fixture(async (file, context, lines) => {
    await modelRead(file, context)
    const grow = await edit(file, context, lines[9], `${lines[9]}\ninserted below row 10`)
    const grown = audit.FileEditTool.mapToolResultToToolResultBlockParam(grow.data, 'edit-1').content
    assert.match(grown, /Lines below the edit moved down 1: old line 11 is now line 12\./)
    const same = await edit(file, context, lines[49], 'row 50: same line count')
    assert.ok(!audit.FileEditTool.mapToolResultToToolResultBlockParam(same.data, 'edit-2').content.includes('Lines below the edit moved'))
  })
})

test('a large HTML page reads as a structure view, and its bodies stay one ranged Read away', async () => {
  const fn = i => [`    function part${i}(scene) {`, ...Array.from({ length: 40 }, (_, k) => `      scene.add(makeMesh(${i}, ${k}, "${'x'.repeat(10)}"));`), '    }']
  const page = ['<!DOCTYPE html>', '<html>', '<body>', '  <canvas id="c"></canvas>', '  <script>', ...Array.from({ length: 12 }, (_, i) => fn(i)).flat(), '  </script>', '</body>', '</html>']
  await fixture(async (file, context) => {
    const html = file.replace(/notes\.txt$/, 'index.html')
    writeFileSync(html, page.join('\n'))
    const whole = await modelRead(html, context)
    assert.equal(whole.data.type, 'skeleton')
    assert.match(whole.text, /Auto-skeleton view/)
    assert.match(whole.text, /\n\s*6[\t→] {4}function part0\(scene\) \{/)
    assert.match(whole.text, /Read with offset=7 & limit=40 to expand/)
    assert.equal(context.readFileState.get(html).isPartialView, true)
    const body = await modelRead(html, context, { offset: 7, limit: 40 })
    assert.equal(body.data.type, 'text')
    assert.equal(body.data.file.startLine, 7)
  })
})

test('a low read limit (cheap mode) still gets an outline, folded to fit', async () => {
  // A long run of top-level setup plus a few functions: the outline is over
  // the limit until that run folds, then far under it, so Read never needs an
  // exact token count (CI replays recorded API calls and has none for this).
  const setup = Array.from({ length: 400 }, (_, k) => `    world.value${k} = makeValue(${k}, "${'y'.repeat(12)}");`)
  const fn = i => [`    function part${i}() {`, ...Array.from({ length: 30 }, (_, k) => `      step(${i}, ${k});`), '    }']
  const page = ['<html><body>', '<script>', '    // --- setup ---', ...setup, ...[0, 1, 2].flatMap(fn), '</script>', '</body></html>']
  await fixture(async (file, context) => {
    const html = file.replace(/notes\.txt$/, 'app.html')
    writeFileSync(html, page.join('\n'))
    assert.ok(readFileSync(html).length > 16_000)
    context.fileReadingLimits.maxTokens = 4000
    const { data, text } = await modelRead(html, context)
    assert.equal(data.type, 'skeleton')
    assert.equal(data.file.condensedRegions, 1)
    assert.match(text, /folded so this view fits the read limit/)
    assert.match(text, /code folded: lines \d+-\d+ \(\d+ lines\) — Read with offset=\d+ & limit=\d+ to expand/)
    assert.ok(text.includes('function part0() {'), 'signatures stay visible')
    assert.ok(text.length / 4 <= 1000, 'far under the limit once the run folds')
  })
})

test('a hidden read (the Eval bridge) gets the text and is never pointed back to', async () => {
  await fixture(async (file, context) => {
    const hidden = (extra, id) => audit.FileReadTool.call({ file_path: file, ...extra }, { ...context, toolUseId: id, readResultHidden: true }, undefined, parent)
    // Nothing visible yet: the hidden read of a range must not make the
    // model's own read of that range come back as "unchanged".
    assert.equal((await hidden({ offset: 10, limit: 5 }, 'eval-1')).data.type, 'text')
    assert.equal((await modelRead(file, context, { offset: 10, limit: 5 })).data.type, 'text')
    // Lines the model already holds still come back as text to the cell.
    await modelRead(file, context)
    assert.equal((await hidden({ offset: 40, limit: 5 }, 'eval-2')).data.type, 'text')
    assert.equal((await hidden({ offset: 40, limit: 5 }, 'eval-3')).data.type, 'text')
  })
})

test('a large file that is one big function is read whole, not as a near-empty outline', async () => {
  const single = ['function main() {', ...Array.from({ length: 420 }, (_, i) => `  check(${i}, "${'z'.repeat(30)}")`), '}', 'main()']
  const many = Array.from({ length: 14 }, (_, i) => [`function part${i}() {`, ...Array.from({ length: 30 }, (_, k) => `  step(${i}, ${k}, "${'z'.repeat(20)}")`), '}']).flat()
  await fixture(async (file, context) => {
    const thin = file.replace(/notes\.txt$/, 'one.test.ts')
    const wide = file.replace(/notes\.txt$/, 'parts.ts')
    writeFileSync(thin, single.join('\n'))
    writeFileSync(wide, many.join('\n'))
    assert.ok(readFileSync(thin).length > 16_000 && readFileSync(wide).length > 16_000)
    const whole = await modelRead(thin, context)
    assert.equal(whole.data.type, 'text')
    assert.equal(whole.data.file.numLines, single.length)
    assert.equal((await modelRead(wide, context)).data.type, 'skeleton')
    // Over half the read limit, the thin file keeps its outline (a fresh
    // conversation, so the earlier whole read is not simply repeated).
    const tight = makeContext()
    tight.fileReadingLimits.maxTokens = 8_000
    assert.equal((await modelRead(thin, tight)).data.type, 'skeleton')
  })
})

test('Read tells every model to read just the range it needs', async () => {
  const prompt = await audit.FileReadTool.prompt()
  assert.match(prompt, /Read only the offset\/limit range you need; in a large file, find it with Grep first\./)
  assert.ok(!prompt.includes('Omit offset/limit for the whole file'))
})

test('a long edit whose old_string skipped one empty line still applies, and keeps it', async () => {
  const body = Array.from({ length: 140 }, (_, i) => `  camera.step${i}(target, ${i});`)
  const lines = ['function setCameraPreset(mode) {', ...body.slice(0, 70), '', ...body.slice(70), '}', 'setCameraPreset("orbit")']
  await fixture(async (file, context) => {
    await modelRead(file, context)
    const old = ['function setCameraPreset(mode) {', ...body, '}'].join('\n')
    const input = { file_path: file, old_string: old, new_string: old.replace('camera.step100(target, 100);', 'camera.step100(target, 0);') }
    assert.equal((await audit.FileEditTool.validateInput(input, context)).result, true)
    await audit.FileEditTool.call(input, context, undefined, { uuid: 'blank-line-drift' })
    const after = readFileSync(file, 'utf8').split('\n')
    assert.equal(after[71], '', 'the empty line the old_string skipped is still there')
    assert.equal(after[102], '  camera.step100(target, 0);')
    assert.equal(after.length, lines.length)
  }, lines)
})

test('a long old_string that fails names empty lines and suggests splitting', async () => {
  const body = Array.from({ length: 60 }, (_, i) => `  render.pass${i}(frame, ${i});`)
  const lines = ['function animate() {', ...body.slice(0, 20), '', ...body.slice(20), '}']
  await fixture(async (file, context) => {
    await modelRead(file, context)
    const remembered = ['function animate() {', ...body, '}']
    remembered[21] = '  render.pass20(frame, 99);'
    const rejection = await audit.FileEditTool.validateInput({ file_path: file, old_string: remembered.join('\n'), new_string: 'x' }, context)
    assert.equal(rejection.result, false)
    assert.match(rejection.message, /differs at line 22 \(the file has an empty line your old_string lacks\):\n {2}file: {7}\(empty line\)\n/)
    assert.match(rejection.message, /This old_string is 62 lines, and a long one fails on any drift: edit just the lines you change plus 2-3 lines of context, in several smaller edits\./)
  }, lines)
})

test('Edit tells every model to keep old_string small', async () => {
  const prompt = await audit.FileEditTool.prompt()
  assert.match(prompt, /Keep `old_string` to the lines you change plus 2-3 lines of context; split a large change into several edits\./)
})

test('duplicate matches report where they are', async () => {
  await fixture(async (file, context) => {
    await modelRead(file, context)
    const input = { file_path: file, old_string: 'dup();', new_string: 'once();' }
    const rejection = await audit.FileEditTool.validateInput(input, context)
    assert.match(rejection.message, /Found 2 matches of the string to replace \(starting at lines 2, 7\)/)
  }, ['a', 'dup();', 'b', 'c', 'd', 'e', 'dup();'])
})
