// Run after npm run build. Real naming controller, queue, and model attachments.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
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
import React from 'react'
import { loadBuiltRuntime, mount } from './helpers/ink-built-runtime.mjs'

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
    'src/utils/sessionStorage.ts',
    'src/components/messages/AttachmentMessage.tsx',
    'src/components/messages/SystemTextMessage.tsx',
    'src/components/messages/nullRenderingAttachments.ts',
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
    'addPlanFileRenameNotice',
    'onPlanFileRenameNotice',
    'showPlanFileRenameNotices',
    'createPlanFileRenamedMessage',
    'createAttachmentMessage',
    'createAssistantMessage',
    'createUserMessage',
    'normalizeMessagesForAPI',
    'isLoggableMessage',
    'isNullRenderingAttachment',
    'AttachmentMessage',
    'SystemTextMessage',
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

const modelTextOf = (attachments) =>
  attachments
    .flatMap(r.normalizeAttachmentForAPI)
    .map((message) =>
      typeof message.message.content === 'string'
        ? message.message.content
        : message.message.content.map((block) => block.text ?? '').join(' '),
    )
    .join(' ')

async function screenOf(element) {
  const ui = await mount(r, element, { columns: 120 })
  try {
    return ui.frame()
  } finally {
    ui.close()
  }
}

// A turn can end without another request, and a rename can land while the
// session is idle. The screen then shows the rename itself, at once.
test('a rename the screen showed first still reaches the model once, with the same text', () => {
  const owner = r.capturePlanFileOwner()
  const oldPath = join(projectDir, 'plans', 'curious-wandering-otter.md')
  const newPath = join(projectDir, 'plans', 'add-oauth-login.md')
  let heard = 0
  // A failing listener must not lose the notice or silence the others.
  const stopFailing = r.onPlanFileRenameNotice(() => {
    throw new Error('a listener failed')
  })
  const stopHearing = r.onPlanFileRenameNotice(() => {
    heard++
  })
  try {
    r.addPlanFileRenameNotice({ owner, oldPath, newPath })
  } finally {
    stopFailing()
    stopHearing()
  }
  assert.equal(heard, 1, 'the screen hears about a rename as it is recorded')

  // Another session's rename is not this screen's to show.
  r.addPlanFileRenameNotice({
    owner: { ...owner, sessionId: randomUUID() },
    oldPath: join(projectDir, 'plans', 'other-old.md'),
    newPath: join(projectDir, 'plans', 'other-new.md'),
  })
  assert.equal(heard, 1, 'a removed listener hears nothing more')
  assert.deepEqual(r.showPlanFileRenameNotices(), [{ newPath }])
  assert.deepEqual(
    r.showPlanFileRenameNotices(),
    [],
    'the screen shows a rename once',
  )

  const attachments = r.getPlanFileRenameAttachments({}, 'repl_main_thread')
  assert.deepEqual(attachments, [
    { type: 'plan_file_renamed', oldPath, newPath, shownToUser: true },
  ])
  assert.deepEqual(
    r.getPlanFileRenameAttachments({}, 'repl_main_thread'),
    [],
    'the model is told once',
  )
  assert.equal(
    modelTextOf(attachments),
    modelTextOf([{ type: 'plan_file_renamed', oldPath, newPath }]),
    'the model gets the same text whether or not the screen showed it first',
  )
})

test('a session that showed the rename first sends the same request as one that did not', () => {
  const oldPath = join(projectDir, 'plans', 'curious-wandering-otter.md')
  const newPath = join(projectDir, 'plans', 'add-oauth-login.md')
  const approved = r.createUserMessage({ content: 'Approve the plan.' })
  const answer = r.createAssistantMessage({ content: 'Plan saved.' })
  const next = r.createUserMessage({ content: 'Continue with the plan.' })
  const told = (extra) =>
    r.createAttachmentMessage({
      type: 'plan_file_renamed',
      oldPath,
      newPath,
      ...extra,
    })
  // Only what goes on the wire: ids and timestamps never do.
  const wire = (messages) =>
    r
      .normalizeMessagesForAPI(messages)
      .map(({ message }) => ({ role: message.role, content: message.content }))

  // The model stopped after approval and the user typed again. Before, the
  // request that told the model also drew the line.
  const before = wire([approved, answer, next, told({})])
  // Now the screen line comes first and the notice is marked as shown.
  const now = wire([
    approved,
    answer,
    r.createPlanFileRenamedMessage(newPath),
    next,
    told({ shownToUser: true }),
  ])
  assert.deepEqual(now, before)
  assert.equal(
    JSON.stringify(now).split('Use the new path for future reads or edits')
      .length - 1,
    1,
  )
})

test('the screen line is saved with the session, drawn once, and never sent to the model', async () => {
  const oldPath = join(projectDir, 'plans', 'curious-wandering-otter.md')
  const newPath = join(projectDir, 'plans', 'add-oauth-login.md')
  const row = `Plan renamed to ${join('plans', 'add-oauth-login.md')}`
  const draw = (component, props) =>
    screenOf(
      React.createElement(component, {
        addMargin: false,
        verbose: false,
        ...props,
      }),
    )

  const line = r.createPlanFileRenamedMessage(newPath)
  assert.equal(r.isLoggableMessage(line), true, 'a resumed session shows it')
  const sent = r.normalizeMessagesForAPI([
    r.createUserMessage({ content: 'Continue with the plan.' }),
    line,
  ])
  assert.equal(sent.length, 1)
  assert.ok(!JSON.stringify(sent).includes('Plan renamed'))
  assert.ok((await draw(r.SystemTextMessage, { message: line })).includes(row))

  // Told to the model in the middle of a turn: the attachment draws the row.
  const first = { type: 'plan_file_renamed', oldPath, newPath }
  assert.ok(
    (await draw(r.AttachmentMessage, { attachment: first })).includes(row),
  )
  assert.equal(
    r.isNullRenderingAttachment(r.createAttachmentMessage(first)),
    false,
  )

  // Already on screen: the attachment only tells the model.
  const later = { ...first, shownToUser: true }
  assert.equal(
    (await draw(r.AttachmentMessage, { attachment: later })).trim(),
    '',
  )
  assert.equal(
    r.isNullRenderingAttachment(r.createAttachmentMessage(later)),
    true,
  )
  for (const attachment of [first, later]) {
    assert.equal(
      r.isLoggableMessage(r.createAttachmentMessage(attachment)),
      true,
      'what the model was told is saved, so a resumed session sends it again',
    )
  }
})
