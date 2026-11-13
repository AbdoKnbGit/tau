// Capture native Responses HTTP requests from the shipped Codex lane. The
// rename controller, queue, attachment conversion, and message normalization
// all remain production code; only the title model and HTTP model are fixtures.
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
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { after, test } from 'node:test'
import { loadMcpRuntime } from './helpers/mcp-built-runtime.mjs'

const originalCwd = process.cwd(),
  tempRoot = realpathSync(tmpdir())
process.env.TAU_MCP_TEST_BUNDLE = resolve(
  originalCwd,
  process.env.TAU_MCP_TEST_BUNDLE ?? 'dist/tau.mjs',
)
const scratch = realpathSync(
  mkdtempSync(join(tempRoot, 'tau-plan-native-prefix-')),
)
const project = join(scratch, 'project with spaces'),
  config = join(scratch, 'config')
mkdirSync(project)
mkdirSync(config)
writeFileSync(
  join(config, 'settings.json'),
  JSON.stringify({ plansDirectory: 'plans', cleanupPeriodDays: 30 }),
)
Object.assign(process.env, {
  CLAUDE_CONFIG_DIR: config,
  CLAUDE_CODE_TMPDIR: join(scratch, 'tmp'),
  NODE_ENV: 'test',
  USER_TYPE: 'external',
  DISABLE_TELEMETRY: '1',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  CLAUDEX_DISABLE_MODEL_PRICING: '1',
  TAU_CODEX_WEBSOCKET: '0',
})
for (const key of ['OPENAI_REASONING_EFFORT', 'CLAUDE_CODE_EFFORT_LEVEL'])
  delete process.env[key]
process.chdir(project)
const r = await loadMcpRuntime({
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
    'getPlanFileRenameAttachments',
    'normalizeAttachmentForAPI',
    'normalizeMessagesForAPI',
    'createUserMessage',
    'createAssistantMessage',
    'setNameGenerator: generate => { generateSessionName = generate; }',
  ],
})
// Installation identity is otherwise read from the real Codex configuration.
Object.defineProperty(r.codexApi, 'installationId', {
  get: () => '00000000-0000-4000-8000-000000000001',
})
const requests = []
const failures = []
const server = createServer(async (request, response) => {
  try {
    assert.equal(request.url, '/v1/responses')
    let raw = ''
    for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw)
    requests.push({ body, headers: request.headers })
    const id = `response-${requests.length}`
    const call = {
      type: 'function_call',
      id: `fc-${id}`,
      call_id: `call-${id}`,
      name: 'read_file',
      arguments: JSON.stringify({ file_path: join(project, 'input.txt') }),
    }
    const events =
      requests.length === 1
        ? [
            { type: 'response.created', response: { id } },
            {
              type: 'response.output_item.added',
              output_index: 0,
              item: { ...call, arguments: '' },
            },
            {
              type: 'response.function_call_arguments.done',
              output_index: 0,
              arguments: call.arguments,
            },
            { type: 'response.output_item.done', output_index: 0, item: call },
          ]
        : [
            { type: 'response.created', response: { id } },
            {
              type: 'response.output_item.added',
              output_index: 0,
              item: {
                type: 'message',
                id: `msg-${id}`,
                role: 'assistant',
                content: [],
              },
            },
            {
              type: 'response.output_text.delta',
              output_index: 0,
              content_index: 0,
              delta: 'APPROVAL_CONTINUED',
            },
            {
              type: 'response.output_item.done',
              output_index: 0,
              item: {
                type: 'message',
                id: `msg-${id}`,
                role: 'assistant',
                content: [
                  {
                    type: 'output_text',
                    text: 'APPROVAL_CONTINUED',
                    annotations: [],
                  },
                ],
              },
            },
          ]
    events.push({
      type: 'response.completed',
      response: {
        id,
        model: body.model,
        usage: { input_tokens: 128, output_tokens: 10 },
      },
    })
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    response.end(
      events
        .map(
          event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
        )
        .join(''),
    )
  } catch (error) {
    failures.push(error)
    response.writeHead(500)
    response.end(String(error))
  }
})
await new Promise(done => server.listen(0, '127.0.0.1', done))
after(async () => {
  r.cancelPlanApprovalNaming(true)
  r.clearCommandQueue()
  r.codexApi.clearChain()
  server.closeAllConnections()
  await new Promise(done => server.close(done))
  process.chdir(originalCwd)
  const child = relative(tempRoot, scratch)
  assert.ok(
    child && !child.startsWith('..') && !isAbsolute(child),
    'unsafe fixture cleanup',
  )
  rmSync(scratch, { recursive: true, force: true, maxRetries: 10 })
})

test('a real rename notice preserves native Codex instructions, tools, affinity, and previous input prefix', async () => {
  const lane = new r.CodexLane()
  lane.configure({
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    apiKey: 'fixture-key',
    chatgptAccessToken: '',
  })
  const model = 'gpt-6-sol'
  const plan =
    '# Inspect the project setup\r\n\r\nRead input.txt and write a report.\r\n'
  const oldPath = r.getPlanFilePath()
  writeFileSync(oldPath, plan)
  writeFileSync(join(project, 'input.txt'), 'Fixture input\n')
  const owner = r.capturePlanFileOwner()
  const history = [
    r.createUserMessage({
      content: `Implement the approved plan saved at ${oldPath}.`,
    }),
  ]
  const readTool = {
    name: 'Read',
    description: 'Read a file.',
    input_schema: {
      type: 'object',
      properties: { file_path: { type: 'string' } },
      required: ['file_path'],
    },
  }
  const stableSystem = 'Stable coding instructions. '.repeat(40)
  const send = async () =>
    r.assembleFinalMessage(
      lane.streamAsProvider({
        model,
        sessionId: owner.sessionId,
        system: `${stableSystem}\n<env>\nWorking directory: ${project}\n</env>`,
        messages: r
          .normalizeMessagesForAPI(history, [], { provider: 'openai', model })
          .map(message => message.message),
        tools: [readTool],
        max_tokens: 100,
        effortValue: null,
        signal: new AbortController().signal,
      }),
      model,
    )

  const firstAnswer = await send()
  const call = firstAnswer.content.find(block => block.type === 'tool_use')
  assert.equal(call?.name, 'Read')
  // The notification arrives after a new assistant tool round, as query.ts
  // drains it. Inserting it into an already-sent tool result is not that flow.
  history.push(
    r.createAssistantMessage({ content: firstAnswer.content }),
    r.createUserMessage({
      content: [
        {
          type: 'tool_result',
          tool_use_id: call.id,
          content: 'Fixture input\n',
        },
      ],
    }),
  )
  r.setNameGenerator(async () => 'inspect-project-setup')
  await r.nameSessionFromApprovedPlan({ plan, owner }, { setAppState() {} })
  assert.deepEqual(r.getCommandQueue(), [], 'no queued turn of its own')
  const newPath = r.getPlanFilePath()
  assert.notEqual(newPath, oldPath)
  assert.equal(readFileSync(newPath, 'utf8'), plan)
  // The same main-thread attachment the next request collects.
  const attachments = r.getPlanFileRenameAttachments({}, 'repl_main_thread')
  assert.equal(attachments.length, 1)
  history.push(...attachments.flatMap(r.normalizeAttachmentForAPI))

  const secondAnswer = await send()
  assert.ok(
    secondAnswer.content.some(
      block =>
        block.type === 'text' && block.text.includes('APPROVAL_CONTINUED'),
    ),
  )
  history.push(
    r.createAssistantMessage({ content: secondAnswer.content }),
    r.createUserMessage({ content: 'Continue using that same saved plan.' }),
  )
  await send()
  assert.deepEqual(failures, [])
  assert.equal(requests.length, 3)
  const first = requests[0]
  for (const request of requests.slice(1)) {
    assert.equal(request.body.instructions, first.body.instructions)
    assert.deepEqual(request.body.tools, first.body.tools)
    assert.equal(request.body.prompt_cache_key, owner.sessionId)
    assert.equal(request.headers.session_id, first.headers.session_id)
    assert.equal(
      request.headers['x-client-request-id'],
      first.headers['x-client-request-id'],
    )
    const reminders = request.body.input
      .flatMap(item => item.content ?? [])
      .filter(
        part =>
          part.type === 'input_text' &&
          part.text.includes('The approved plan file was renamed'),
      )
    assert.equal(
      reminders.length,
      1,
      'the notice is replayed as history, not inserted repeatedly',
    )
    assert.ok(reminders[0].text.includes(`to ${newPath}.`))
    assert.equal(
      request.body.instructions.includes('The approved plan file was renamed'),
      false,
    )
  }
  for (let i = 1; i < requests.length; i++) {
    const previous = requests[i - 1].body.input
    assert.deepEqual(
      requests[i].body.input.slice(0, previous.length),
      previous,
      'a renamed plan extends native Responses input without rewriting its previous prefix',
    )
  }
})
