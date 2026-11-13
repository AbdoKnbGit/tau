// Run after npm run build. Real naming controller, queue, and model attachments.
import assert from 'node:assert/strict'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { after, test } from 'node:test'
import { loadBuiltRuntime } from './helpers/ink-built-runtime.mjs'

const repoDir = process.cwd()
const tempRoot = realpathSync.native(tmpdir())
const scratch = realpathSync.native(
  mkdtempSync(join(tempRoot, 'tau-plan-notice-')),
)
const projectDir = join(scratch, 'project')
const configDir = join(scratch, 'config')
mkdirSync(projectDir, { recursive: true })
mkdirSync(configDir, { recursive: true })
writeFileSync(
  join(configDir, 'settings.json'),
  JSON.stringify({ cleanupPeriodDays: 30 }),
)
Object.assign(process.env, {
  NODE_ENV: 'test',
  USER_TYPE: 'external',
  DISABLE_TELEMETRY: '1',
  CLAUDE_CONFIG_DIR: configDir,
  CLAUDE_CODE_TMPDIR: join(scratch, 'tmp'),
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  CLAUDEX_DISABLE_MODEL_PRICING: '1',
})
process.chdir(projectDir)

const r = await loadBuiltRuntime({
  paths: [
    'src/bootstrap/state.ts',
    'src/utils/plans.ts',
    'src/utils/planApprovalNaming.ts',
    'src/utils/messageQueueManager.ts',
    'src/utils/attachments.ts',
    'src/utils/messages.ts',
  ],
  exports: [
    'capturePlanFileOwner',
    'getPlanFilePath',
    'nameSessionFromApprovedPlan',
    'cancelPlanApprovalNaming',
    'clearCommandQueue',
    'getCommandQueue',
    'enqueue',
    'dequeue',
    'getPlanFileRenameAttachments',
    'normalizeAttachmentForAPI',
    'setNameGenerator: generate => { generateSessionName = generate; }',
  ],
})

after(async () => {
  r.cancelPlanApprovalNaming()
  r.clearCommandQueue()
  process.chdir(repoDir)
  const child = relative(tempRoot, scratch)
  assert.ok(
    child && !child.startsWith('..') && !isAbsolute(child),
    'unsafe fixture cleanup path',
  )
  for (let attempt = 0; ; attempt++) {
    try {
      rmSync(scratch, { recursive: true, force: true })
      return
    } catch (error) {
      if (
        attempt >= 30 ||
        !['EPERM', 'EBUSY', 'ENOTEMPTY'].includes(error.code)
      )
        throw error
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
})

test(
  'a real plan rename waits for the next main-thread request without queueing a turn',
  { timeout: 15_000 },
  async () => {
    const plan = '# Continue implementing OAuth login\n'
    const oldPath = r.getPlanFilePath()
    writeFileSync(oldPath, plan)
    const owner = r.capturePlanFileOwner()
    const readFileState = new Map([[oldPath, { content: plan }]])
    r.setNameGenerator(async () => 'oauth-implementation-continues')

    // A pending user message must retain its place when background naming finishes.
    r.enqueue({
      value: 'Keep implementing the approved plan',
      mode: 'prompt',
      priority: 'next',
    })
    let state = r.getDefaultAppState()
    await r.nameSessionFromApprovedPlan(
      { plan, owner },
      {
        readFileState,
        setAppState(update) {
          state = update(state)
        },
      },
    )
    const newPath = r.getPlanFilePath()
    assert.notEqual(newPath, oldPath)
    assert.equal(readFileSync(newPath, 'utf8'), plan)
    // An idle REPL runs every queued command as a new model turn. The rename
    // must therefore add nothing to the command queue.
    assert.deepEqual(
      r.getCommandQueue().map((command) => command.mode),
      ['prompt'],
      'the rename must not queue work of its own',
    )
    assert.equal(r.dequeue().mode, 'prompt')

    // Subagents and forked side queries cannot take the main notice.
    assert.deepEqual(
      r.getPlanFileRenameAttachments({ agentId: 'worker-1' }, 'agent:custom'),
      [],
    )
    assert.deepEqual(
      r.getPlanFileRenameAttachments({}, 'prompt_suggestion'),
      [],
    )
    const attachments = r.getPlanFileRenameAttachments({}, 'repl_main_thread')
    assert.deepEqual(attachments, [
      { type: 'plan_file_renamed', oldPath, newPath },
    ])
    assert.deepEqual(
      r.getPlanFileRenameAttachments({}, 'repl_main_thread'),
      [],
      'the notice is delivered once',
    )

    const messages = attachments.flatMap(r.normalizeAttachmentForAPI)
    assert.equal(messages.length, 1)
    assert.ok(messages.every((message) => message.isMeta))
    const modelText = messages
      .map((message) =>
        typeof message.message.content === 'string'
          ? message.message.content
          : message.message.content.map((block) => block.text ?? '').join('\n'),
      )
      .join('\n')
    assert.match(modelText, /^<system-reminder>/)
    assert.ok(
      modelText.includes(`renamed from ${oldPath} to ${newPath}.`),
      'paths reach the model as written, without JSON escaping',
    )
    assert.ok(modelText.includes('Use the new path for future reads or edits'))
  },
)
