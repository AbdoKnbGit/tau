/**
 * Agent frontmatter -> provider binding.
 *
 * Guards the failure this fixes: an agent that names its provider by display
 * name ("Fireworks AI") used to have the provider silently dropped, so the
 * agent's Fireworks model id was sent to whatever provider the session was on
 * (e.g. Antigravity, which answered with a 404 for a model it never served).
 */
import { parseAgentFromMarkdown } from './loadAgentsDir.js'
import { runAgent } from './runAgent.js'

let passed = 0
let failed = 0

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (error: any) {
    failed++
    console.log(`  FAIL ${name}: ${error?.message ?? String(error)}`)
  }
}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

function parse(frontmatter: Record<string, unknown>) {
  return parseAgentFromMarkdown(
    '/agents/reviewer.md',
    '/agents',
    { name: 'reviewer', description: 'Reviews code.', ...frontmatter },
    'You are a reviewer.',
    'projectSettings',
  )
}

async function main(): Promise<void> {
  console.log('agent provider config:')

  await test('display name in frontmatter binds the right provider', () => {
    const agent = parse({
      provider: 'Fireworks AI ',
      model: 'accounts/fireworks/models/deepseek-v4-flash-0731',
    })
    assert(agent !== null, 'agent failed to parse')
    assert(
      agent!.provider === 'fireworks',
      `provider was ${String(agent!.provider)}, expected fireworks`,
    )
    assert(
      agent!.model === 'accounts/fireworks/models/deepseek-v4-flash-0731',
      'model was rewritten',
    )
    assert(
      agent!.providerConfigError === undefined,
      'valid config reported an error',
    )
  })

  await test('canonical id still binds', () => {
    const agent = parse({ provider: 'antigravity', model: 'gemini-3.6-flash-high' })
    assert(agent!.provider === 'antigravity', 'canonical id did not bind')
    assert(agent!.providerConfigError === undefined, 'unexpected error')
  })

  await test('unknown provider is reported, not silently dropped', () => {
    const agent = parse({ provider: 'Fireworkz', model: 'some-model' })
    assert(agent !== null, 'agent failed to parse')
    assert(agent!.provider === undefined, 'unknown provider should not bind')
    assert(
      agent!.providerConfigError?.includes('Fireworkz') === true,
      `error did not name the bad value: ${String(agent!.providerConfigError)}`,
    )
  })

  await test('provider without an explicit model is reported', () => {
    for (const frontmatter of [
      { provider: 'fireworks' },
      { provider: 'fireworks', model: 'inherit' },
    ]) {
      const agent = parse(frontmatter)
      assert(agent!.provider === undefined, 'provider bound without a model')
      assert(
        agent!.providerConfigError?.includes('explicit model') === true,
        `missing model error: ${String(agent!.providerConfigError)}`,
      )
    }
  })

  await test('no provider field stays unconfigured', () => {
    const agent = parse({ model: 'sonnet' })
    assert(agent!.provider === undefined, 'provider appeared from nowhere')
    assert(agent!.providerConfigError === undefined, 'unexpected error')
  })

  await test('a tier alias on a provider with no fixed tier is rejected', () => {
    for (const provider of ['fireworks', 'openai', 'kiro', 'mistral', 'nim']) {
      const agent = parse({ provider, model: 'sonnet' })
      assert(
        agent!.providerConfigError?.includes('tier alias') === true,
        `${provider} accepted a tier alias: ${String(agent!.providerConfigError)}`,
      )
      assert(
        agent!.provider === undefined,
        `${provider} kept a binding despite an error`,
      )
    }
  })

  await test('a tier alias is allowed where the provider fixes it', () => {
    // Anthropic-native routes run the real tier resolver; antigravity and
    // openrouter map every alias to a fixed model of their own.
    const allowed: Array<[string, string]> = [
      ['firstParty', 'sonnet'],
      ['bedrock', 'haiku'],
      ['vertex', 'opus'],
      ['foundry', 'sonnet[1m]'],
      ['antigravity', 'opus'],
      ['openrouter', 'sonnet'],
    ]
    for (const [provider, model] of allowed) {
      const agent = parse({ provider, model })
      assert(
        agent!.providerConfigError === undefined,
        `${provider}/${model} was rejected: ${String(agent!.providerConfigError)}`,
      )
      assert(agent!.provider === provider, `${provider} did not bind`)
    }
  })

  await test('a concrete model id is always allowed', () => {
    for (const provider of ['fireworks', 'openai', 'kiro', 'mistral']) {
      const agent = parse({ provider, model: 'some/concrete-model-id' })
      assert(
        agent!.providerConfigError === undefined,
        `${provider} rejected a concrete id: ${String(agent!.providerConfigError)}`,
      )
      assert(agent!.provider === provider, `${provider} did not bind`)
    }
  })

  await test('any recorded error clears the binding', () => {
    const broken = [
      { provider: 'Fireworkz', model: 'm' },
      { provider: 'fireworks' },
      { provider: 'fireworks', model: 'inherit' },
      { provider: 'fireworks', model: 'opus' },
      { provider: 42, model: 'm' },
    ]
    for (const frontmatter of broken) {
      const agent = parse(frontmatter)
      assert(
        agent!.providerConfigError !== undefined,
        `no error for ${JSON.stringify(frontmatter)}`,
      )
      assert(
        agent!.provider === undefined,
        `binding survived an error for ${JSON.stringify(frontmatter)}`,
      )
    }
  })

  await test('spawning a misconfigured agent fails loudly', async () => {
    const iterator = runAgent({
      agentDefinition: {
        agentType: 'reviewer',
        providerConfigError: 'Agent "reviewer" declares provider \'Fireworkz\'',
      },
    } as any)
    let message: string | undefined
    try {
      await iterator.next()
    } catch (error: any) {
      message = error?.message
    }
    assert(message !== undefined, 'spawn did not throw')
    assert(
      message!.includes('Fireworkz'),
      `throw did not carry the config error: ${String(message)}`,
    )
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

void main()
