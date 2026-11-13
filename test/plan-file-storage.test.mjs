import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { spawn } from 'node:child_process'
import { after, test } from 'node:test'
import { build } from 'esbuild'

// Exercise the production storage module on real files. Inject individual OS
// failures at its filesystem boundary, without maintaining a second algorithm.
const built = await build({
  entryPoints: ['src/utils/planFileStorage.ts'],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
  packages: 'external',
  logLevel: 'silent',
})
const source = built.outputFiles[0].text
const require = createRequire(import.meta.url)
function storage(overrides = {}) {
  const module = { exports: {} }
  Function(
    'require',
    'module',
    'exports',
    source,
  )(
    (name) => (name === 'fs' ? { ...fs, ...overrides } : require(name)),
    module,
    module.exports,
  )
  return module.exports
}
const r = storage()
const root = fs.mkdtempSync(join(tmpdir(), 'tau-plan-storage-'))
after(() => {
  assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep))
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10 })
})
let sequence = 0
function fixture(content = Buffer.from('\ufeff# Plan\r\n\r\nKeep bytes.\r\n')) {
  const directory = join(root, `case ${sequence++}`)
  fs.mkdirSync(directory)
  const planId = 'original-plan'
  const oldPath = join(directory, `${planId}.md`)
  fs.writeFileSync(oldPath, content)
  return { directory, planId, oldPath, content }
}
const change = (f, extra = {}, api = r) =>
  api.renameStoredPlanFile({
    ...f,
    title: 'Add OAuth login',
    now: new Date('2026-11-11T15:30:45Z'),
    shouldProceed: () => true,
    persistReference: async () => {},
    ...extra,
  })

test('portable filename policy rejects paths and handles reserved, long, accented, and agent names', () => {
  assert.equal(
    r.planTitleToFilenameSlug('  Add OAuth / login! '),
    'add-oauth-login',
  )
  assert.equal(r.planTitleToFilenameSlug('CON'), 'plan-con')
  assert.equal(r.planTitleToFilenameSlug('café résumé'), 'cafe-resume')
  assert.equal(r.planTitleToFilenameSlug('添加 登录 功能'), '添加-登录-功能')
  assert.equal(
    r.planTitleToFilenameSlug('fix-agent-agent-config'),
    'fix-agentplan-agentplan-config',
  )
  assert.equal(r.planTitleToFilenameSlug(' \t /...'), undefined)
  assert.ok(r.planTitleToFilenameSlug('x'.repeat(1000)).length <= 100)
  assert.ok(
    Buffer.byteLength(r.planTitleToFilenameSlug('计划'.repeat(1000))) <= 100,
  )
  for (const filename of [
    '../escape.md',
    'CON.md',
    'fix-agent-abc.md',
    'x.md:stream',
    'x.md\0',
  ]) {
    assert.equal(
      r.parsePlanFileReference({
        version: 1,
        planId: 'original-plan',
        filename,
        revision: 1,
      }),
      undefined,
    )
  }
})

test('successful rename preserves exact bytes, identity, and permissions; repeated calls are idempotent', async () => {
  const f = fixture()
  const before = fs.statSync(f.oldPath)
  const result = await change(f)
  assert.equal(result.status, 'renamed')
  assert.equal(basename(result.newPath), 'add-oauth-login.md')
  assert.equal(fs.existsSync(f.oldPath), false)
  assert.deepEqual(fs.readFileSync(result.newPath), f.content)
  assert.equal(fs.statSync(result.newPath).ino, before.ino)
  assert.equal(fs.statSync(result.newPath).mode, before.mode)
  assert.equal((await change(f)).status, 'unchanged')
  assert.equal(r.readPlanFileRecord(f.directory, f.planId).revision, 1)
})

test('non-Latin titles remain readable and portable in the actual filename', async () => {
  const f = fixture()
  const result = await change(f, { title: '添加 登录 功能' })
  assert.equal(basename(result.newPath), '添加-登录-功能.md')
  assert.deepEqual(fs.readFileSync(result.newPath), f.content)
  assert.equal(
    r.readPlanFileRecord(f.directory, f.planId).filename,
    '添加-登录-功能.md',
  )
})

test('plain, timestamp, and counter collisions never overwrite existing files', async () => {
  const f = fixture()
  const occupied = [
    'add-oauth-login.md',
    'add-oauth-login-20261111T153045Z.md',
    'add-oauth-login-20261111T153045Z-1.md',
  ]
  for (const name of occupied) fs.writeFileSync(join(f.directory, name), name)
  const result = await change(f)
  assert.equal(
    basename(result.newPath),
    'add-oauth-login-20261111T153045Z-2.md',
  )
  for (const name of occupied)
    assert.equal(fs.readFileSync(join(f.directory, name), 'utf8'), name)
  assert.equal((await change(f)).newPath, result.newPath)
})

test('an identity reservation prevents title publication over a not-yet-written plan', async () => {
  const f = fixture()
  assert.equal(r.reservePlanIdentity(f.directory, 'add-oauth-login'), true)
  assert.equal(r.reservePlanIdentity(f.directory, 'add-oauth-login'), false)
  const result = await change(f)
  assert.equal(basename(result.newPath), 'add-oauth-login-20261111T153045Z.md')
})

test('stale approvals and unusable generated names leave the original untouched', async () => {
  for (const extra of [{ shouldProceed: () => false }, { title: '   ' }]) {
    const f = fixture()
    assert.equal((await change(f, extra)).status, 'skipped')
    assert.deepEqual(fs.readFileSync(f.oldPath), f.content)
  }
})

test('missing source and unsupported linking cannot erase or disconnect the original', async () => {
  const absent = fixture()
  fs.unlinkSync(absent.oldPath)
  await assert.rejects(change(absent), { code: 'ENOENT' })
  const f = fixture()
  const unsupported = storage({
    linkSync() {
      throw Object.assign(new Error('unsupported'), { code: 'ENOTSUP' })
    },
  })
  await assert.rejects(change(f, {}, unsupported), { code: 'ENOTSUP' })
  assert.deepEqual(fs.readFileSync(f.oldPath), f.content)
  assert.equal(
    r.readPlanFileRecord(f.directory, f.planId).filename,
    'original-plan.md',
  )
})

test('failed manifest commit leaves the original authoritative and intact', async () => {
  const f = fixture()
  const failed = storage({
    renameSync(from, to) {
      if (to === r.getPlanMetadataPath(f.directory, f.planId))
        throw Object.assign(new Error('disk full'), { code: 'ENOSPC' })
      fs.renameSync(from, to)
    },
  })
  await assert.rejects(change(f, {}, failed), { code: 'ENOSPC' })
  assert.deepEqual(fs.readFileSync(f.oldPath), f.content)
  assert.equal(
    r.readPlanFileRecord(f.directory, f.planId).filename,
    'original-plan.md',
  )
})

test('postcommit persistence failure retains both recoverable names, then retry finishes cleanup', async () => {
  const f = fixture()
  await assert.rejects(
    change(f, {
      persistReference: async () => {
        throw new Error('transcript unavailable')
      },
    }),
    /transcript unavailable/,
  )
  const record = r.readPlanFileRecord(f.directory, f.planId)
  assert.equal(record.filename, 'add-oauth-login.md')
  assert.deepEqual(
    fs.readFileSync(join(f.directory, record.filename)),
    f.content,
  )
  assert.deepEqual(fs.readFileSync(f.oldPath), f.content)
  await change(f)
  assert.equal(fs.existsSync(f.oldPath), false)
})

test('cleanup never deletes the last old copy when the destination disappears', async () => {
  const f = fixture()
  await change(f, {
    persistReference: async (ref) =>
      fs.unlinkSync(join(f.directory, ref.filename)),
  })
  assert.deepEqual(fs.readFileSync(f.oldPath), f.content)
  assert.ok(r.readPlanFileRecord(f.directory, f.planId).cleanup)
  const repaired = await r.recoverStoredPlanFile(f.directory, f.planId)
  assert.equal(repaired.filename, 'original-plan.md')
  assert.deepEqual(
    fs.readFileSync(join(f.directory, repaired.filename)),
    f.content,
  )
})

test('an external atomic save at the old path is retained as a conflict', async () => {
  const f = fixture()
  const result = await change(f, {
    persistReference: async () => {
      const replacement = join(f.directory, 'editor-save.tmp')
      fs.writeFileSync(replacement, 'external edit')
      fs.renameSync(replacement, f.oldPath)
    },
  })
  assert.equal(fs.readFileSync(f.oldPath, 'utf8'), 'external edit')
  assert.deepEqual(fs.readFileSync(result.newPath), f.content)
  assert.ok(r.readPlanFileRecord(f.directory, f.planId).cleanup)
})

test('restored human filenames never adopt an unrelated occupied file', async () => {
  const f = fixture()
  const filename = 'imported-title.md'
  fs.writeFileSync(join(f.directory, filename), 'other plan')
  const restored = await r.restorePlanFileReference(
    f.directory,
    { version: 1, planId: f.planId, filename, revision: 2 },
    'snapshot',
  )
  assert.notEqual(restored.filename, filename)
  assert.equal(
    fs.readFileSync(join(f.directory, filename), 'utf8'),
    'other plan',
  )
  assert.deepEqual(
    fs.readFileSync(join(f.directory, restored.filename)),
    f.content,
    'an intact legacy file is newer than portable snapshot content',
  )
})

test('malformed metadata fails closed rather than selecting an arbitrary path', () => {
  const f = fixture()
  fs.mkdirSync(join(f.directory, '.plan-metadata'))
  fs.writeFileSync(
    r.getPlanMetadataPath(f.directory, f.planId),
    JSON.stringify({
      version: 1,
      planId: f.planId,
      filename: '../foreign.md',
      revision: 4,
      previousFilenames: [],
    }),
  )
  assert.throws(
    () => r.readPlanFileRecord(f.directory, f.planId),
    /Invalid plan metadata/,
  )
  assert.deepEqual(fs.readFileSync(f.oldPath), f.content)
})

test('a reservation another process is still writing makes the rename pick the next name', async () => {
  const f = fixture()
  // reserveFilename creates the entry empty and writes its owner right after.
  const names = join(f.directory, '.plan-metadata', 'names')
  fs.mkdirSync(names, { recursive: true })
  fs.writeFileSync(join(names, 'add-oauth-login.md.json'), '')
  const result = await change(f)
  assert.equal(result.status, 'renamed')
  assert.equal(
    basename(result.newPath),
    'add-oauth-login-20261111T153045Z.md',
  )
  assert.deepEqual(fs.readFileSync(result.newPath), f.content)
  assert.equal(
    fs.readFileSync(join(names, 'add-oauth-login.md.json'), 'utf8'),
    '',
  )
})

test('simultaneous independent processes reserve distinct title filenames', async () => {
  const f = fixture()
  const secondId = 'second-plan'
  fs.writeFileSync(join(f.directory, `${secondId}.md`), 'second bytes')
  const compiledPath = join(root, 'storage.cjs')
  fs.writeFileSync(compiledPath, source)
  const script = `import {createRequire} from 'node:module';import {readFileSync} from 'node:fs';
    const require=createRequire(${JSON.stringify(import.meta.url)});const module={exports:{}};
    Function('require','module','exports',readFileSync(${JSON.stringify(compiledPath)},'utf8'))(require,module,module.exports);
    const result=await module.exports.renameStoredPlanFile({directory:process.argv[1],planId:process.argv[2],title:'same title',now:new Date('2026-11-11T15:30:45Z'),shouldProceed:()=>true,persistReference:async()=>{}});
    process.stdout.write(JSON.stringify(result));`
  const run = (id) =>
    new Promise((yes, no) => {
      const child = spawn(
        process.execPath,
        ['--input-type=module', '-e', script, f.directory, id],
        { windowsHide: true },
      )
      let output = '',
        error = ''
      child.stdout.on('data', (chunk) => {
        output += chunk
      })
      child.stderr.on('data', (chunk) => {
        error += chunk
      })
      child.on('error', no)
      child.on('exit', (code) =>
        code === 0 ? yes(JSON.parse(output)) : no(new Error(error)),
      )
    })
  const [first, second] = await Promise.all([run(f.planId), run(secondId)])
  assert.notEqual(first.newPath, second.newPath)
  assert.deepEqual(fs.readFileSync(first.newPath), f.content)
  assert.equal(fs.readFileSync(second.newPath, 'utf8'), 'second bytes')
})
