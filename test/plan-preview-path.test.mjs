// Render /plan output through the shipped local-command Markdown component.
// The transcript must preserve literal paths before terminal-width wrapping.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { after, test } from 'node:test'
import React from 'react'
import { loadBuiltRuntime, mount } from './helpers/ink-built-runtime.mjs'

const originalCwd = process.cwd()
// Tau works in the resolved directory (on macOS /var is /private/var), so
// paths expected here must start from it too.
const temporaryRoot = realpathSync.native(tmpdir())
const scratch = realpathSync.native(
  mkdtempSync(join(temporaryRoot, 'tau-plan-preview-path-')),
)
const project = join(scratch, 'project with [brackets] and _underscores_')
const config = join(scratch, 'config')
mkdirSync(project)
mkdirSync(config)
writeFileSync(
  join(config, 'settings.json'),
  JSON.stringify({ plansDirectory: '.tau-plan-tests', cleanupPeriodDays: 30 }),
)
Object.assign(process.env, {
  CLAUDE_CONFIG_DIR: config,
  CLAUDE_CODE_TMPDIR: join(scratch, 'tmp'),
  CLAUDE_CODE_SIMPLE: '1',
  DISABLE_TELEMETRY: '1',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  CLAUDEX_DISABLE_MODEL_PRICING: '1',
  VISUAL: 'code',
})
process.chdir(project)

after(() => {
  process.chdir(originalCwd)
  const child = relative(temporaryRoot, scratch)
  assert.ok(child && !child.startsWith('..') && !isAbsolute(child))
  rmSync(scratch, { recursive: true, force: true, maxRetries: 10 })
})

const r = await loadBuiltRuntime({
  paths: [
    'src/bootstrap/state.ts',
    'src/utils/plans.ts',
    'src/commands/plan/plan.tsx',
    'src/components/messages/UserLocalCommandOutputMessage.tsx',
  ],
  exports: [
    'planCommand: plan_exports',
    'UserLocalCommandOutputMessage',
    'switchSession',
    'setPlanSlug',
    'getPlanFilePath',
    'getPlansDirectory',
    'getPlan',
  ],
})

const reportedPath = String.raw`C:\Users\dev\Desktop\ML\app_project\.tau-plan-tests\resilient-watching-pebble.md`
const body =
  'Keep this complete plan paragraph intact: ' +
  'literal-path-check '.repeat(8).trimEnd()
const planContent = '# Preview regression\n\n' + body + '\n'

async function renderOutput(output, path) {
  const ui = await mount(
    r,
    React.createElement(r.UserLocalCommandOutputMessage, {
      content: '<local-command-stdout>' + output + '</local-command-stdout>',
    }),
    // A wide final terminal exposes mutations already introduced into the
    // transcript, including an 80-column pre-rendered newline in a code span.
    { columns: Math.max(240, path.length + 40, body.length + 40) },
  )
  try {
    return ui.frame()
  } finally {
    ui.close()
  }
}

function assertPreview(frame, path, editorName) {
  assert.ok(
    frame.includes(path),
    'rendered preview must contain the exact literal path',
  )
  assert.ok(frame.includes('Current Plan'))
  assert.ok(frame.includes('Preview regression'))
  assert.ok(
    frame.includes(body),
    'plan body must survive without pre-rendered line breaks',
  )
  if (editorName) {
    assert.ok(frame.includes('/plan open to edit this plan in ' + editorName))
  } else {
    assert.ok(!frame.includes('/plan open'))
  }
}

const paths = [
  ['reported 80-character Windows path', reportedPath],
  [
    'long Windows path',
    reportedPath.replace('ML\\', 'ML\\' + 'deep-project-directory\\'.repeat(8)),
  ],
  [
    'POSIX path with Markdown punctuation and backticks',
    '/home/ok/project [draft]/__plans__/a`b``c_*.md',
  ],
]
for (const [name, path] of paths) {
  test(
    'plan preview preserves ' + name + ' through local-command Markdown',
    async () => {
      if (path === reportedPath) assert.equal(path.length, 80)
      else if (name === 'long Windows path') assert.ok(path.length > 80)
      const editorName = 'VS _Code_ [preview] `editor`'
      const output = r.planCommand.formatPlanPreview(
        path,
        planContent,
        editorName,
      )
      assert.ok(
        output.includes(path),
        'Markdown source must contain the full unwrapped path',
      )
      assert.ok(
        output.includes(planContent),
        'Markdown source must retain the original plan body',
      )
      assert.ok(output.includes(editorName))
      assert.ok(
        !output.includes('\x1b'),
        'transcript source should not contain terminal styling',
      )
      assertPreview(await renderOutput(output, path), path, editorName)
    },
  )
}

test('plan preview omits the editor hint when no editor is supplied', async () => {
  const output = r.planCommand.formatPlanPreview(reportedPath, planContent)
  assertPreview(await renderOutput(output, reportedPath), reportedPath)
})

const controlPaths = [
  {
    name: 'line breaks, tabs, and C1 controls in a POSIX directory',
    path: '/tmp/line\nbreak\tpart\u0085/`quoted`/plan.md',
    display: '"/tmp/line\\nbreak\\tpart\\u0085/`quoted`/plan.md"',
  },
  {
    name: 'Unicode separators and directional/astral format controls',
    path: '/tmp/directional\u202e/line\u2028paragraph\u2029/tag\u{e0001}/plan.md',
    display:
      '"/tmp/directional\\u202e/line\\u2028paragraph\\u2029/tag\\udb40\\udc01/plan.md"',
  },
]
for (const { name, path, display } of controlPaths) {
  test('plan preview shows a reversible escaped path for ' + name, async () => {
    const output = r.planCommand.formatPlanPreview(path, planContent)
    const pathSource = output.split('\n\n')[1]
    assert.ok(
      pathSource.includes(display),
      'the path source must contain its exact JSON-quoted representation',
    )
    assert.doesNotMatch(
      pathSource,
      /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u,
      'the path source must contain no raw invisible controls or line separators',
    )
    const frame = await renderOutput(output, display)
    assertPreview(frame, display)
    assert.equal(
      JSON.parse(display),
      path,
      'the displayed representation must recover the original path',
    )
  })
}

test('a POSIX path cannot close the local-command output wrapper before Markdown rendering', async () => {
  const path = '/tmp/project</local-command-stdout>/plans/plan.md'
  const display =
    '"/tmp/project\\u003c/local-command-stdout\\u003e/plans/plan.md"'
  const output = r.planCommand.formatPlanPreview(path, planContent)
  const pathSource = output.split('\n\n')[1]
  assert.ok(pathSource.includes(display))
  assert.doesNotMatch(
    pathSource,
    /[<>]/,
    'wrapper-like characters in the path must be escaped before tag extraction',
  )
  assertPreview(await renderOutput(output, display), display)
  assert.equal(JSON.parse(display), path)
})

test('the real /plan command renders its actual configured plan file path unchanged', async () => {
  const sessionId = randomUUID()
  r.switchSession(sessionId)
  r.setPlanSlug(sessionId, 'resilient-watching-pebble')
  const path = r.getPlanFilePath()
  assert.equal(r.getPlansDirectory(), join(project, '.tau-plan-tests'))
  assert.equal(
    path,
    join(project, '.tau-plan-tests', 'resilient-watching-pebble.md'),
  )
  assert.ok(path.length > 80)
  writeFileSync(path, planContent)
  assert.equal(r.getPlan(), planContent)
  const completions = []
  const result = await r.planCommand.call(
    (output, options) => completions.push({ output, options }),
    {
      getAppState: () => ({ toolPermissionContext: { mode: 'plan' } }),
      setAppState: () =>
        assert.fail('previewing an existing plan must not change its mode'),
    },
    '',
  )
  assert.equal(result, null)
  assert.equal(completions.length, 1)
  const [{ output }] = completions
  assert.equal(
    output,
    r.planCommand.formatPlanPreview(path, planContent, 'VS Code'),
  )
  assert.ok(
    output.includes(path),
    'real command must emit its complete filesystem path',
  )
  assert.ok(output.includes(planContent))
  assert.equal(r.getPlanFilePath(), path)
  assertPreview(await renderOutput(output, path), path, 'VS Code')
})
