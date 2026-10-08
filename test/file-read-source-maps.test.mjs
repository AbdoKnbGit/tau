import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

// Exercise the shipped tools, guards, schemas and WASM parser together.
// No provider requests: the token budget keeps estimation entirely local.
process.env.NODE_ENV = 'test'
process.env.CLAUDE_CODE_SIMPLE = '1'
process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING = '1'
process.env.DISABLE_TELEMETRY = '1'
const distPath = resolve('dist/tau.mjs')
const auditPath = join(dirname(distPath), `.source-map-audit-${process.pid}-${Date.now()}.mjs`)
let source = readFileSync(distPath, 'utf8').replace(/\nvoid main\d*\(\);\r?\n/, '\n')
source += `
export function __sourceMapAudit() {
  init_FileReadTool(); init_FileEditTool(); init_FileWriteTool(); init_fileStateCache();
  return { FileReadTool, FileEditTool, FileWriteTool, createFileStateCacheWithSizeLimit, fileReadListeners };
}
`
writeFileSync(auditPath, source)
let audit
try {
  audit = (await import(pathToFileURL(auditPath).href)).__sourceMapAudit()
} finally {
  unlinkSync(auditPath)
}

const map = { version: 3, sources: ['input.ts'], mappings: 'AAAA', names: [], sourcesContent: ['const original = 1;'.repeat(2000)] }
const payload = Buffer.from(JSON.stringify(map)).toString('base64')
const directive = `//# sourceMappingURL=data:application/json;charset=utf-8;base64,${payload}`
const original = `const n = 1;\n${directive}\nconst m = 2;\n`
function makeContext() {
  return {
    readFileState: audit.createFileStateCacheWithSizeLimit(20),
    abortController: new AbortController(),
    fileReadingLimits: { maxSizeBytes: 2_000_000, maxTokens: 1_000_000 },
    getAppState: () => ({ toolPermissionContext: {
      mode: 'default', alwaysAllowRules: {}, alwaysDenyRules: {}, alwaysAskRules: {}, additionalWorkingDirectories: new Map(),
    } }),
    updateFileHistoryState: () => {},
  }
}
async function fixture(run, text = original) {
  const root = mkdtempSync(join(tmpdir(), 'tau-source-map-test-'))
  const file = join(root, 'unrelated-name.ts')
  writeFileSync(file, text)
  try { await run(file, makeContext()) } finally {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()))
    assert.ok(root.includes('tau-source-map-test-'))
    rmSync(root, { recursive: true, force: true })
  }
}
const read = (file, context, extra = {}) => audit.FileReadTool.call({ file_path: file, offset: 1, limit: 4, ...extra }, context)

test('two-line read returns a short numbered view, raw state and raw listeners', async () => {
  await fixture(async (file, context) => {
    context.fileReadingLimits.maxTokens = 2_000
    let observed
    const listener = (path, content) => { if (path === file) observed = content }
    audit.fileReadListeners.push(listener)
    try {
      const { data } = await read(file, context, { offset: 2, limit: 2 })
      assert.equal(data.type, 'text')
      assert.equal(data.file.startLine, 2)
      assert.equal(data.file.numLines, 2)
      assert.equal(data.file.totalLines, 4)
      assert.ok(data.file.content.length < 200)
      assert.equal(data.file.content.split('\n')[1], 'const m = 2;')
      const raw = `${directive}\nconst m = 2;`
      assert.equal(context.readFileState.get(file).content, raw)
      assert.equal(observed, raw)
      assert.equal(context.readFileState.get(file).sourceMapsOmitted, true)
      const block = audit.FileReadTool.mapToolResultToToolResultBlockParam(data, 'read-1')
      assert.match(block.content, /2[^\n]*Inline source map omitted/)
      assert.match(block.content, /3[^\n]*const m = 2;/)
      assert.ok(!block.content.includes(payload))
      assert.equal(readFileSync(file, 'utf8'), original)
    } finally { audit.fileReadListeners.splice(audit.fileReadListeners.indexOf(listener), 1) }
  })
})

test('same view dedups; explicit raw access bypasses dedup and auto-skeleton', async () => {
  await fixture(async (file, context) => {
    assert.equal((await read(file, context)).data.type, 'text')
    assert.equal((await read(file, context)).data.type, 'file_unchanged')
    const raw = await read(file, context, { include_source_maps: true })
    assert.equal(raw.data.file.content, original)
    assert.equal(context.readFileState.get(file).sourceMapsOmitted, undefined)
    assert.equal((await read(file, context, { include_source_maps: true })).data.type, 'file_unchanged')
    const whole = await read(file, makeContext(), { limit: undefined, include_source_maps: true })
    assert.equal(whole.data.type, 'text')
    assert.equal(whole.data.file.content, original)
    // Switching back to the default view produces a marker again.
    assert.ok(!(await read(file, context)).data.file.content.includes(payload))
  })
})

test('stored results stay byte-stable after later reads, disk changes and serialization', async () => {
  await fixture(async (file, context) => {
    const { data } = await read(file, context)
    const frozen = JSON.stringify(data)
    const block = audit.FileReadTool.mapToolResultToToolResultBlockParam(data, 'read-1')
    await read(file, context, { include_source_maps: true })
    writeFileSync(file, 'changed\n')
    assert.equal(JSON.stringify(data), frozen)
    const replay = audit.FileReadTool.mapToolResultToToolResultBlockParam(JSON.parse(frozen), 'read-1')
    assert.deepEqual(replay, block)
    // Older transcript data must not be retroactively filtered by the mapper.
    const oldData = { type: 'text', file: { filePath: file, content: original, startLine: 1, numLines: 4, totalLines: 4 } }
    assert.ok(audit.FileReadTool.mapToolResultToToolResultBlockParam(oldData, 'old-read').content.includes(payload))
  })
})

test('ordinary Edit remains valid; stale reads still fail', async () => {
  await fixture(async (file, context) => {
    await read(file, context)
    const input = { file_path: file, old_string: 'const n = 1;', new_string: 'const n = 3;' }
    assert.equal((await audit.FileEditTool.validateInput(input, context)).result, true)
    const future = new Date(Date.now() + 5000)
    writeFileSync(file, original.replace('const m = 2;', 'const m = 9;'))
    utimesSync(file, future, future)
    const rejection = await audit.FileEditTool.validateInput(input, context)
    assert.equal(rejection.result, false)
    assert.match(rejection.message, /modified since read/)
  })
})

test('whole-file Write cannot accidentally erase hidden maps, even after other ranged reads', async () => {
  await fixture(async (file, context) => {
    const first = await read(file, context)
    await read(file, context, { offset: 1, limit: 1 })
    const input = { file_path: file, content: first.data.file.content }
    const rejection = await audit.FileWriteTool.validateInput(input, context)
    assert.equal(rejection.result, false)
    assert.match(rejection.message, /include_source_maps/)
    assert.equal(readFileSync(file, 'utf8'), original)
    await read(file, context, { include_source_maps: true, limit: undefined })
    assert.equal((await audit.FileWriteTool.validateInput({ file_path: file, content: original }, context)).result, true)
  })
})

test('ambiguous modes and cancellation fail without storing read state', async () => {
  await fixture(async (file, context) => {
    await assert.rejects(read(file, context, { skeleton: true, include_source_maps: true }), /requires skeleton/)
    context.abortController.abort()
    await assert.rejects(read(file, context), /abort/i)
    assert.equal(context.readFileState.get(file), undefined)
  })
})

test('actual edits and no-ops preserve maps on disk and the whole-write guard', async () => {
  await fixture(async (file, context) => {
    await read(file, context)
    const input = { file_path: file, old_string: 'const n = 1;', new_string: 'const n = 3;' }
    await audit.FileEditTool.call(input, context, undefined, { uuid: 'source-map-test' })
    assert.equal(readFileSync(file, 'utf8'), original.replace('const n = 1;', 'const n = 3;'))
    assert.equal(context.readFileState.get(file).sourceMapsOmitted, true)
    await audit.FileEditTool.call({ ...input, old_string: 'const n = 3;' }, context, undefined, { uuid: 'source-map-test' })
    assert.equal(context.readFileState.get(file).sourceMapsOmitted, true)
    const rejection = await audit.FileWriteTool.validateInput({ file_path: file, content: 'const n = 3;' }, context)
    assert.equal(rejection.result, false)
    assert.match(rejection.message, /include_source_maps/)
  })
})

test('the two reported files reproduce the reduction without changing either file', async () => {
  for (const relative of ['src/commands/copy/copy.tsx', 'src/commands/effort/effort.tsx']) {
    const file = resolve(relative)
    const bytes = readFileSync(file)
    const lines = bytes.toString('utf8').replaceAll('\r\n', '\n').split('\n')
    const index = lines.findIndex(line => line.startsWith('//# sourceMappingURL=data:'))
    assert.ok(index > 0)
    const { data } = await read(file, makeContext(), { offset: index, limit: 2, skeleton: false })
    assert.equal(data.type, 'text')
    assert.ok(!data.file.content.includes('base64,'))
    assert.ok(data.file.content.includes('Inline source map omitted'))
    assert.equal(data.file.content.split('\n')[0], lines[index - 1])
    assert.deepEqual(readFileSync(file), bytes)
    console.log(`${relative}: source-map line ${index + 1}, ${lines[index].length} characters -> ${data.file.content.split('\n')[1].length}-character marker`)
  }
})
