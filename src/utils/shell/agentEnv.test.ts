/**
 * Tests for the agent session variables added to shell commands.
 * Run: bun run src/utils/shell/agentEnv.test.ts
 *
 * The merge is pure, so each platform's naming rules are checked on any host.
 * One live case spawns a real child to show what the OS actually passes on.
 */

import { spawnSync } from 'child_process'
import { AGENT_ENV, AI_AGENT_NAME, type AgentModelEnv, withAgentEnv } from './agentEnv.js'

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (e: unknown) {
    failed++
    console.log(`  FAIL ${name}: ${(e as Error)?.message ?? String(e)}`)
  }
}

function eq(actual: unknown, expected: unknown, hint: string): void {
  if (actual !== expected) {
    throw new Error(
      `${hint}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    )
  }
}

/** Names that belong to this feature, in whatever case they appear. */
function ownedNames(env: NodeJS.ProcessEnv): string[] {
  return Object.keys(env)
    .filter(name => /^(ai_agent|tau_(session_id|provider|model|effort))$/i.test(name))
    .sort()
}

const MODEL: AgentModelEnv = {
  provider: 'fireworks',
  model: 'accounts/fireworks/models/kimi-k2',
  effort: 'high',
}

console.log('agent env:')

test('adds AI_AGENT and the session id, keeping everything else', () => {
  const env = withAgentEnv({ PATH: '/bin', HOME: '/h' }, { sessionId: 's-1' }, 'linux')
  eq(env[AGENT_ENV.agent], AI_AGENT_NAME, 'AI_AGENT')
  eq(env[AGENT_ENV.sessionId], 's-1', 'TAU_SESSION_ID')
  eq(env.PATH, '/bin', 'PATH')
  eq(env.HOME, '/h', 'HOME')
})

test('leaves provider, model and effort unset without an agent model', () => {
  const env = withAgentEnv({}, { sessionId: 's-1' }, 'linux')
  eq(ownedNames(env).join(','), 'AI_AGENT,TAU_SESSION_ID', 'names')
})

test('sets provider, model and effort from the agent model', () => {
  const env = withAgentEnv({}, { sessionId: 's-1', agentModel: MODEL }, 'linux')
  eq(env[AGENT_ENV.provider], 'fireworks', 'TAU_PROVIDER')
  eq(env[AGENT_ENV.model], MODEL.model, 'TAU_MODEL')
  eq(env[AGENT_ENV.effort], 'high', 'TAU_EFFORT')
})

test('leaves the effort unset when the agent model has none', () => {
  const env = withAgentEnv(
    {},
    { sessionId: 's-1', agentModel: { provider: 'openrouter', model: 'm' } },
    'linux',
  )
  eq(env[AGENT_ENV.model], 'm', 'TAU_MODEL')
  eq(AGENT_ENV.effort in env, false, 'TAU_EFFORT present')
})

test('sets no model variable when provider or model is empty', () => {
  for (const agentModel of [
    { provider: '', model: 'm', effort: 'low' },
    { provider: 'p', model: '', effort: 'low' },
  ]) {
    const env = withAgentEnv({}, { sessionId: 's', agentModel }, 'linux')
    eq(ownedNames(env).join(','), 'AI_AGENT,TAU_SESSION_ID', JSON.stringify(agentModel))
  }
})

test('replaces every value inherited from a parent Tau', () => {
  const parent = {
    AI_AGENT: 'other-agent',
    TAU_SESSION_ID: 'parent-session',
    TAU_PROVIDER: 'openrouter',
    TAU_MODEL: 'parent-model',
    TAU_EFFORT: 'max',
  }
  const withoutModel = withAgentEnv(parent, { sessionId: 'child' }, 'linux')
  eq(withoutModel.AI_AGENT, 'tau', 'AI_AGENT')
  eq(withoutModel.TAU_SESSION_ID, 'child', 'TAU_SESSION_ID')
  eq(ownedNames(withoutModel).join(','), 'AI_AGENT,TAU_SESSION_ID', 'stale model vars left')

  const withModel = withAgentEnv(
    parent,
    { sessionId: 'child', agentModel: { provider: 'firstParty', model: 'm2' } },
    'linux',
  )
  eq(withModel.TAU_PROVIDER, 'firstParty', 'TAU_PROVIDER')
  eq(withModel.TAU_MODEL, 'm2', 'TAU_MODEL')
  eq(AGENT_ENV.effort in withModel, false, 'stale TAU_EFFORT kept')
})

test('POSIX: a differently cased name is another variable and is kept', () => {
  const env = withAgentEnv({ tau_model: 'mine', Ai_Agent: 'mine' }, { sessionId: 's' }, 'linux')
  eq(env.tau_model, 'mine', 'tau_model')
  eq(env.Ai_Agent, 'mine', 'Ai_Agent')
})

test('Windows: inherited copies in any letter case are dropped', () => {
  const env = withAgentEnv(
    {
      tau_model: 'stale',
      Tau_Session_Id: 'stale',
      ai_agent: 'stale',
      tau_effort: 'stale',
      Path: 'C:\\bin',
    },
    { sessionId: 's' },
    'win32',
  )
  eq(ownedNames(env).join(','), 'AI_AGENT,TAU_SESSION_ID', 'names left')
  eq(env.TAU_SESSION_ID, 's', 'TAU_SESSION_ID')
  eq(env.Path, 'C:\\bin', 'unrelated names keep their casing')
})

test('does not modify the object it is given', () => {
  const input: NodeJS.ProcessEnv = { TAU_MODEL: 'stale', tau_model: 'x', KEEP: '1' }
  const before = JSON.stringify(input)
  withAgentEnv(input, { sessionId: 's', agentModel: MODEL }, 'win32')
  eq(JSON.stringify(input), before, 'input')
})

test('keeps keys whose value is undefined (spawn skips them)', () => {
  const env = withAgentEnv({ SHELL: undefined }, { sessionId: 's' }, 'linux')
  eq('SHELL' in env, true, 'SHELL key')
  eq(env.SHELL, undefined, 'SHELL value')
})

test('leaves the session id unset when it is empty', () => {
  const env = withAgentEnv({ TAU_SESSION_ID: 'stale' }, { sessionId: '' }, 'linux')
  eq(AGENT_ENV.sessionId in env, false, 'TAU_SESSION_ID present')
})

test('live: a child process sees exactly these values', () => {
  // Stale copies a parent could pass down, in the casings each OS allows.
  const inherited: NodeJS.ProcessEnv = {
    ...process.env,
    TAU_MODEL: 'stale',
    AI_AGENT: 'other',
  }
  if (process.platform === 'win32') {
    inherited.tau_provider = 'stale-lower'
  }
  const env = withAgentEnv(inherited, { sessionId: 'live-1' })
  const result =
    process.platform === 'win32'
      ? spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'set'], {
          env,
          encoding: 'utf8',
          windowsHide: true,
        })
      : spawnSync('env', [], { env, encoding: 'utf8' })
  const seen = (result.stdout ?? '')
    .split(/\r?\n/)
    .filter(line => /^(ai_agent|tau_(session_id|provider|model|effort))=/i.test(line))
    .sort()
  eq(seen.join(' | '), 'AI_AGENT=tau | TAU_SESSION_ID=live-1', 'child env')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  process.exit(1)
}
