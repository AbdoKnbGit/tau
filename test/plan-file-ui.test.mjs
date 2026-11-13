// The real file-tool UI must distinguish plans from ordinary files stored in
// or beside the configured plans directory, including plansDirectory='.'.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { after, test } from 'node:test'
import { loadBuiltRuntime, mount } from './helpers/ink-built-runtime.mjs'

const previousCwd = process.cwd()
const scratch = mkdtempSync(join(tmpdir(), 'tau-plan-file-ui-'))
const project = join(scratch, 'plans with spaces'),
  config = join(scratch, 'config')
mkdirSync(project)
mkdirSync(config)
writeFileSync(
  join(config, 'settings.json'),
  JSON.stringify({ plansDirectory: '.', cleanupPeriodDays: 30 }),
)
Object.assign(process.env, {
  CLAUDE_CONFIG_DIR: config,
  CLAUDE_CODE_TMPDIR: join(scratch, 'tmp'),
  CLAUDE_CODE_SIMPLE: '1',
  DISABLE_TELEMETRY: '1',
  CLAUDEX_DISABLE_MODEL_PRICING: '1',
})
process.chdir(project)
const r = await loadBuiltRuntime({
  paths: [
    'src/bootstrap/state.ts',
    'src/utils/plans.ts',
    'src/utils/planFileStorage.ts',
    'src/tools/FileWriteTool/FileWriteTool.ts',
    'src/tools/FileEditTool/FileEditTool.ts',
    'src/tools/FileReadTool/FileReadTool.ts',
  ],
  exports: [
    'switchSession',
    'getSessionId',
    'setPlanSlug',
    'getPlanSlugCache',
    'getPlanFilePath',
    'isPlanFileForDisplay',
    'renameStoredPlanFile',
    'getPlanMetadataPath',
    'FileReadTool',
    'FileWriteTool',
    'FileEditTool',
  ],
})
after(() => {
  process.chdir(previousCwd)
  const child = relative(tmpdir(), scratch)
  assert.ok(child && !child.startsWith('..') && !isAbsolute(child))
  rmSync(scratch, { recursive: true, force: true, maxRetries: 10 })
})
function plan() {
  r.switchSession(randomUUID())
  const planId = `plan-${randomUUID()}`
  r.setPlanSlug(r.getSessionId(), planId)
  const path = r.getPlanFilePath()
  writeFileSync(path, '# Saved plan\n')
  return { planId, path }
}
async function rename(source, title) {
  return r.renameStoredPlanFile({
    directory: project,
    planId: source.planId,
    title,
    shouldProceed: () => true,
    persistReference: async () => {},
  })
}
function assertOrdinaryFile(path) {
  const input = { file_path: path }
  assert.equal(r.isPlanFileForDisplay(path), false)
  assert.equal(r.FileWriteTool.userFacingName(input), 'Write')
  assert.equal(r.FileEditTool.userFacingName(input), 'Update')
  assert.equal(r.FileReadTool.userFacingName(input), 'Read')
  assert.notEqual(
    r.FileWriteTool.renderToolUseMessage(input, { verbose: false }),
    '',
  )
  assert.notEqual(
    r.FileEditTool.renderToolUseMessage(input, { verbose: false }),
    '',
  )
  const edited = {
    filePath: path,
    content: '# Report\n',
    originalFile: '# Before\n',
    structuredPatch: [],
  }
  assert.equal(
    r.FileWriteTool.renderToolResultMessage({ ...edited, type: 'update' }, [], {
      verbose: false,
    }).props.previewHint,
    undefined,
  )
  assert.equal(
    r.FileEditTool.renderToolResultMessage(edited, [], { verbose: false }).props
      .previewHint,
    undefined,
  )
}

test('nested reports, root Markdown, and sibling prefix directories keep ordinary file UI', async () => {
  plan()
  const report = join(project, 'manual-checks', 'setup-report.md')
  const sibling = join(`${project}-other`, 'report.md')
  for (const directory of [join(project, 'manual-checks'), `${project}-other`])
    mkdirSync(directory)
  for (const path of [report, join(project, 'README.md'), sibling]) {
    writeFileSync(path, '# Ordinary report\n')
    assertOrdinaryFile(path)
  }
  assertOrdinaryFile(relative(project, report))
  const element = r.FileWriteTool.renderToolResultMessage(
    {
      type: 'create',
      filePath: report,
      content: '# Ordinary report\n',
      structuredPatch: [],
    },
    [],
    { verbose: false },
  )
  const ui = await mount(r, element)
  try {
    assert.match(ui.frame(), /Wrote.*lines to/)
    assert.match(ui.frame(), /setup-report\.md/)
    assert.doesNotMatch(ui.frame(), /\/plan to preview/)
  } finally {
    ui.close()
  }
})

test('unpublished title-collision reservations cannot turn ordinary reports into plan UI', async () => {
  const source = plan()
  const report = join(project, 'existing-diagnostics.md')
  writeFileSync(report, '# Existing diagnostic report\n')
  const published = await rename(source, 'existing diagnostics')
  assert.notEqual(published.newPath, report)
  assert.equal(readFileSync(report, 'utf8'), '# Existing diagnostic report\n')
  assertOrdinaryFile(report)
  assert.equal(r.isPlanFileForDisplay(published.newPath), true)
})

test('current, retired, and agent plan paths retain plan labels and previews', async () => {
  const source = plan()
  const agent = r.getPlanFilePath('worker-1')
  writeFileSync(agent, '# Agent plan\n')
  const published = await rename(source, `ui-plan-${randomUUID()}`)
  for (const path of [
    source.path,
    published.newPath,
    agent,
    relative(project, published.newPath),
  ]) {
    const input = { file_path: path }
    assert.equal(r.isPlanFileForDisplay(path), true)
    assert.equal(r.FileWriteTool.userFacingName(input), 'Updated plan')
    assert.equal(r.FileEditTool.userFacingName(input), 'Updated plan')
    assert.equal(r.FileReadTool.userFacingName(input), 'Reading Plan')
    assert.equal(
      r.FileWriteTool.renderToolUseMessage(input, { verbose: false }),
      '',
    )
    assert.equal(
      r.FileEditTool.renderToolUseMessage(input, { verbose: false }),
      '',
    )
  }
  const update = {
    filePath: published.newPath,
    content: '# Plan\n',
    originalFile: '# Before\n',
    structuredPatch: [],
  }
  assert.equal(
    r.FileWriteTool.renderToolResultMessage({ ...update, type: 'update' }, [], {
      verbose: false,
    }).props.previewHint,
    '/plan to preview',
  )
  assert.equal(
    r.FileEditTool.renderToolResultMessage(update, [], { verbose: false }).props
      .previewHint,
    '/plan to preview',
  )
})

test('missing identity and corrupt metadata do not break file UI or generate new plan IDs', async () => {
  const source = plan()
  const published = await rename(source, `corrupt-ui-${randomUUID()}`)
  const metadata = r.getPlanMetadataPath(project, source.planId)
  writeFileSync(metadata, '{invalid')
  assert.doesNotThrow(() => assertOrdinaryFile(published.newPath))
  r.getPlanSlugCache().delete(r.getSessionId())
  assertOrdinaryFile(source.path)
  assert.equal(r.getPlanSlugCache().has(r.getSessionId()), false)
})
