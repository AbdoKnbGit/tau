/**
 * Code Assist SSE parser tests.
 *
 * Run: bun run src/services/api/providers/gemini_code_assist.test.ts
 */

import {
  ANTIGRAVITY_MODEL_IDS,
  ANTIGRAVITY_MODELS,
  ANTIGRAVITY_PICKER_MODELS,
  antigravityLoadCodeAssistHeaders,
  antigravityOnboardUserBody,
  antigravityOnboardUserHeaders,
  codeAssistAntigravityOnboardTierId,
  codeAssistEligibilityErrorMessage,
  codeAssistGenerationBases,
  codeAssistHasEligibleTier,
  antigravityGenerationHostCount,
  codeAssistGenerationBasesForModel,
  codeAssistOnboardingDecision,
  describeAntigravityEntitlementGap,
  executorForModel,
  recordAntigravityGeminiHostExhausted,
  _resetAntigravityGeminiHostCooldownForTest,
  getAntigravityModelDisplayName,
  isAntigravityGeminiModel,
  parseCodeAssistSSE,
  resolveAntigravityWireModel,
  wrapForCodeAssist,
} from './gemini_code_assist.js'
import {
  ANTIGRAVITY_API_VERSION,
  ANTIGRAVITY_HUB_USER_AGENT,
} from '../../../constants/antigravity.js'
import type { GeminiStreamChunk } from '../adapters/gemini_to_anthropic.js'

let passed = 0
let failed = 0

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (e: any) {
    failed++
    console.log(`  FAIL ${name}: ${e?.message ?? String(e)}`)
  }
}

function assert(cond: unknown, hint: string): void {
  if (!cond) throw new Error(hint)
}

function streamFromStrings(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk))
      }
      controller.close()
    },
  })
}

async function collect(chunks: string[]): Promise<GeminiStreamChunk[]> {
  const parsed: GeminiStreamChunk[] = []
  for await (const chunk of parseCodeAssistSSE(streamFromStrings(chunks))) {
    parsed.push(chunk)
  }
  return parsed
}

async function main(): Promise<void> {
  console.log('gemini code assist sse parser:')

  await test('wire normalization leaves caller configuration and Claude history unchanged', () => {
    const input = {
      generationConfig: { maxOutputTokens: 128, temperature: 0 },
      contents: [{ role: 'model', parts: [
        { functionResponse: { name: 'lookup', response: { result: 'ok' } } },
        { thoughtSignature: 'original-signature' },
      ] }],
    }
    const before = JSON.stringify(input)
    const gemini = wrapForCodeAssist('gemini-3.8-flash-low', 'project', input)
    assert((gemini.request.generationConfig as any).maxOutputTokens === undefined, 'Gemini wire normalization missing')
    const claude = wrapForCodeAssist('claude-sonnet-4-6', 'project', input)
    assert((claude.request.contents as any)[0].role === 'user', 'Claude tool response role was not normalized')
    assert(JSON.stringify(input) === before, 'wire normalization mutated caller input')
  })

  await test('parses multi-line usage event with cache reads', async () => {
    const chunks = await collect([
      'data: {"response":{\n',
      'data: "usageMetadata":{\n',
      'data: "promptTokenCount":35862,\n',
      'data: "cachedContentTokenCount":15105,\n',
      'data: "candidatesTokenCount":90\n',
      'data: }}}\n\n',
    ])

    assert(chunks.length === 1, `expected 1 chunk, got ${chunks.length}`)
    const usage = chunks[0]?.usageMetadata
    assert(usage?.promptTokenCount === 35862, `promptTokenCount=${usage?.promptTokenCount}`)
    assert(usage?.cachedContentTokenCount === 15105, `cachedContentTokenCount=${usage?.cachedContentTokenCount}`)
    assert(usage?.candidatesTokenCount === 90, `candidatesTokenCount=${usage?.candidatesTokenCount}`)
  })

  await test('keeps single-line event and done handling intact', async () => {
    const chunks = await collect([
      'data: {"response":{"candidates":[{"content":{"parts":[{"text":"o',
      'k"}]}}]}}\n\n',
      'data: [DONE]\n\n',
      'data: {"response":{"usageMetadata":{"promptTokenCount":1}}}\n\n',
    ])

    assert(chunks.length === 1, `expected 1 chunk, got ${chunks.length}`)
    const text = chunks[0]?.candidates?.[0]?.content?.parts?.[0]?.text
    assert(text === 'ok', `text=${text}`)
  })

  await test('flushes final unterminated event', async () => {
    const chunks = await collect([
      'data: {"response":{"usageMetadata":{"promptTokenCount":10,"cachedContentTokenCount":4}}}',
    ])

    assert(chunks.length === 1, `expected 1 chunk, got ${chunks.length}`)
    assert(chunks[0]?.usageMetadata?.cachedContentTokenCount === 4, 'cache read tokens missing')
  })

  await test('routes Gemini 3.5 Flash variants through Antigravity', async () => {
    assert(
      ANTIGRAVITY_MODELS.some(model => model.id === 'gemini-3.5-flash-high'),
      'missing Gemini 3.5 Flash High from Antigravity catalog',
    )
    assert(
      ANTIGRAVITY_MODELS.some(model => model.id === 'gemini-3.5-flash-medium'),
      'missing Gemini 3.5 Flash Medium from Antigravity catalog',
    )
    assert(
      ANTIGRAVITY_MODELS.some(model => model.id === 'gemini-3.5-flash-low'),
      'missing Gemini 3.5 Flash Low from Antigravity catalog',
    )
    assert(executorForModel('gemini-3.5-flash-high') === 'antigravity', 'high variant must use Antigravity')
    assert(executorForModel('gemini-3.5-flash-medium') === 'antigravity', 'medium variant must use Antigravity')
    assert(executorForModel('gemini-3.5-flash-low') === 'antigravity', 'low variant must use Antigravity')
    assert(executorForModel('gemini-3-flash') === 'antigravity', 'Gemini 3 Flash must use Antigravity')
    assert(executorForModel('gemini-3-flash-agent') === 'cli', 'backend wire key must not be exposed as a public model id')
    assert(executorForModel('gemini-3.5-flash-extra-low') === 'cli', 'backend wire key must not be exposed as a public model id')
    assert(
      getAntigravityModelDisplayName('claude-opus-4-6-thinking') === 'Claude Opus 4.6',
      'Claude Opus label should not include thinking/via suffix',
    )
  })

  await test('routes level-based Flash picker variants through the tiered Antigravity model', async () => {
    // 3.6 / 3.7 / 3.8 each offer Low/Medium/High in the picker and ride one
    // tiered wire model per generation, so switching level keeps the
    // session's implicit-cache entry (one upstream id, not three).
    for (const generation of ['3.6', '3.7', '3.8'] as const) {
      for (const [level, label] of [['high', 'High'], ['medium', 'Medium'], ['low', 'Low']] as const) {
        const id = `gemini-${generation}-flash-${level}`
        const name = `Gemini ${generation} Flash (${label})`
        const pickerModel = ANTIGRAVITY_PICKER_MODELS.find(model => model.id === id)
        assert(pickerModel?.name === name, `missing ${name} from Antigravity picker`)
        assert(executorForModel(id) === 'antigravity', `${id} must use Antigravity`)
        assert(
          resolveAntigravityWireModel(id) === `gemini-${generation}-flash-tiered`,
          `${id} must use the tiered wire model`,
        )
        // Membership in the Antigravity Gemini set is what turns on the
        // implicit-cache discipline (prefix pad, commit-window pacing,
        // per-session endpoint affinity) for these ids.
        assert(isAntigravityGeminiModel(id), `${id} must get the Antigravity cache discipline`)
      }
    }
  })

  await test('gemini-3-flash is hidden from the picker but stays routable', async () => {
    // Hidden from selection: its channel commits the implicit cache slowly
    // and misses replicas often (measured 64-71% vs 85-93% on 3.5/Claude).
    assert(
      !ANTIGRAVITY_PICKER_MODELS.some(model => model.id === 'gemini-3-flash'),
      'gemini-3-flash must not appear in the model picker',
    )
    assert(
      ANTIGRAVITY_PICKER_MODELS.some(model => model.id === 'gemini-3.5-flash-low'),
      'picker must keep the healthy Antigravity models',
    )
    // Still fully routable for saved configs / explicit --model:
    assert(ANTIGRAVITY_MODEL_IDS.has('gemini-3-flash'), 'gemini-3-flash must stay routable')
    assert(executorForModel('gemini-3-flash') === 'antigravity', 'routing must be unchanged')
    assert(
      isAntigravityGeminiModel('gemini-3-flash'),
      'cache discipline must still cover explicit gemini-3-flash use',
    )
  })

  await test('wraps Gemini 3.5 Flash variants with the Antigravity wire model', async () => {
    assert(
      resolveAntigravityWireModel('gemini-3.5-flash-medium') === 'gemini-3.5-flash-low',
      'medium variant must resolve to the Antigravity backend Flash model',
    )
    assert(
      resolveAntigravityWireModel('gemini-3.5-flash-high') === 'gemini-3-flash-agent',
      'high variant must resolve to the Antigravity backend Flash model',
    )
    assert(
      resolveAntigravityWireModel('gemini-3.5-flash-low') === 'gemini-3.5-flash-extra-low',
      'low variant must resolve to the Antigravity backend Flash model',
    )
    assert(
      resolveAntigravityWireModel('gemini-3.1-pro-high') === 'gemini-pro-agent',
      '3.1 Pro High must resolve to the Antigravity backend Pro model',
    )

    const wrapped = wrapForCodeAssist('gemini-3.5-flash-medium', 'project-id', {
      generationConfig: {
        thinkingConfig: { thinkingLevel: 'medium', includeThoughts: true },
        maxOutputTokens: 100,
      },
      safetySettings: [],
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
    })

    assert(wrapped.model === 'gemini-3.5-flash-low', `wire model=${wrapped.model}`)
    assert(wrapped.userAgent === 'antigravity', 'missing Antigravity userAgent')
    assert(wrapped.requestType === 'agent', 'Flash variants should use agent requestType')
    const request = wrapped.request as {
      generationConfig?: { thinkingConfig?: { thinkingLevel?: string }; maxOutputTokens?: number }
      safetySettings?: unknown
    }
    assert(request.generationConfig?.thinkingConfig?.thinkingLevel === 'medium', 'thinking level was not preserved')
    assert(!('safetySettings' in request), 'safety settings should be stripped')
    assert(request.generationConfig?.maxOutputTokens === undefined, 'maxOutputTokens should be stripped for Gemini')

    const wrappedPro = wrapForCodeAssist('gemini-3.1-pro-high', 'project-id', {
      generationConfig: {
        thinkingConfig: { thinkingLevel: 'high', includeThoughts: true },
      },
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
    })

    assert(wrappedPro.model === 'gemini-pro-agent', `pro wire model=${wrappedPro.model}`)
  })

  await test('preserves explicit Antigravity session id for cache stability', async () => {
    const wrapped = wrapForCodeAssist('gemini-3.5-flash-low', 'project-id', {
      sessionId: '-stable-real-history',
      contents: [{ role: 'user', parts: [{ text: 'volatile injected environment context' }] }],
    })

    const request = wrapped.request as { sessionId?: string }
    assert(request.sessionId === '-stable-real-history', `sessionId=${request.sessionId}`)
  })

  await test('forwards the legacy provider session id into Antigravity requests', async () => {
    const wrapped = wrapForCodeAssist(
      'gemini-3.5-flash-low',
      'project-id',
      { contents: [{ role: 'user', parts: [{ text: 'bounded report' }] }] },
      'live-root-session',
    )

    const request = wrapped.request as { sessionId?: string }
    assert(request.sessionId === 'live-root-session', `sessionId=${request.sessionId}`)
  })

  await test('no entitlement claim is made before selecting a credential', async () => {
    // Disk caches may belong to another login. Without a request credential,
    // they cannot establish entitlement for this process. Credential-bound
    // positive and negative cases live in antigravity_project_cache.test.ts.
    for (const model of ANTIGRAVITY_MODELS) {
      assert(describeAntigravityEntitlementGap(model.id) === null,
        `${model.id}: entitlement diagnosed without a selected credential`)
    }

    // Never claims anything about a non-Antigravity id.
    assert(
      describeAntigravityEntitlementGap('gpt-5.4') === null,
      'helper diagnosed a model outside the Antigravity registry',
    )
  })

  await test('quota cooldown cannot route any request away from daily', async () => {
    _resetAntigravityGeminiHostCooldownForTest()
    try {
      const daily = 'https://daily-cloudcode-pa.googleapis.com/v1internal'
      recordAntigravityGeminiHostExhausted(daily, 120000)
      for (const model of ['gemini-3.8-flash-high', 'claude-sonnet-4-6']) {
        for (const querySource of [undefined, 'repl_main_thread', 'agent:default', 'report', 'quota_check', 'compact']) {
          const bases = codeAssistGenerationBasesForModel('antigravity', model, undefined, querySource)
          assert(bases.length === 1 && bases[0] === daily,
            model + '/' + querySource + ': cooldown changed the generation host')
        }
      }
    } finally {
      _resetAntigravityGeminiHostCooldownForTest()
    }
  })

  await test('all Antigravity models have one daily generation host', async () => {
    for (const model of ['gemini-3.8-flash-high', 'claude-sonnet-4-6', undefined]) {
      assert(antigravityGenerationHostCount(model) === 1, 'unexpected host count for ' + model)
    }
  })

  await test('daily-only Antigravity generation preserves Gemini CLI production routing', async () => {
    const antigravityBases = codeAssistGenerationBases('antigravity')
    assert(antigravityBases.length === 1, 'Antigravity retained a fallback')
    assert(antigravityBases[0] === 'https://daily-cloudcode-pa.googleapis.com/v1internal',
      'Antigravity did not use daily')
    const cliBases = codeAssistGenerationBases('cli')
    assert(cliBases.length === 1, 'Gemini CLI host count changed')
    assert(cliBases[0] === 'https://cloudcode-pa.googleapis.com/v1internal', 'Gemini CLI host changed')
  })

  await test('keeps user-managed standard tiers classified for Gemini CLI', async () => {
    const current = codeAssistOnboardingDecision({
      cloudaicompanionProject: {},
      currentTier: { id: 'standard-tier' },
    })
    assert(current.kind === 'require-user-project', `current decision=${current.kind}`)
    assert(current.tierId === 'standard-tier', `current tier=${current.tierId}`)

    const allowed = codeAssistOnboardingDecision({
      cloudaicompanionProject: {},
      allowedTiers: [{
        id: 'standard-tier',
        isDefault: true,
        userDefinedCloudaicompanionProject: true,
      }],
    })
    assert(allowed.kind === 'require-user-project', `allowed decision=${allowed.kind}`)

    const free = codeAssistOnboardingDecision({
      allowedTiers: [{ id: 'free-tier', isDefault: true }],
    })
    assert(free.kind === 'onboard', `free decision=${free.kind}`)
  })

  await test('bootstraps Antigravity standard-tier with the native auth fingerprint', async () => {
    const standardTierResponse = {
      cloudaicompanionProject: {},
      currentTier: { id: 'standard-tier' },
      allowedTiers: [{
        id: 'standard-tier',
        isDefault: true,
        userDefinedCloudaicompanionProject: true,
      }],
    }
    const tierId = codeAssistAntigravityOnboardTierId(standardTierResponse)
    assert(tierId === 'standard-tier', `Antigravity tier=${tierId}`)
    const decision = codeAssistOnboardingDecision(standardTierResponse, 'antigravity')
    assert(decision.kind === 'onboard', `Antigravity decision=${decision.kind}`)

    const loadHeaders = antigravityLoadCodeAssistHeaders('access-token')
    assert(
      loadHeaders['User-Agent'] === ANTIGRAVITY_HUB_USER_AGENT,
      `load UA=${loadHeaders['User-Agent']}`,
    )
    assert(!('X-Goog-Api-Client' in loadHeaders), 'load request has legacy X-Goog header')
    assert(!('Client-Metadata' in loadHeaders), 'load request has legacy Client-Metadata header')

    const onboardHeaders = antigravityOnboardUserHeaders('access-token')
    assert(
      onboardHeaders['User-Agent'] ===
        `${ANTIGRAVITY_HUB_USER_AGENT} google-api-nodejs-client/10.3.0`,
      `onboard UA=${onboardHeaders['User-Agent']}`,
    )
    assert(
      onboardHeaders['X-Goog-Api-Client'] === 'gl-node/22.21.1',
      `onboard X-Goog=${onboardHeaders['X-Goog-Api-Client']}`,
    )

    const body = antigravityOnboardUserBody(tierId)
    assert(body.tier_id === 'standard-tier', `tier_id=${body.tier_id}`)
    assert(body.metadata.ide_type === 'ANTIGRAVITY', `ide_type=${body.metadata.ide_type}`)
    assert(body.metadata.ide_version === ANTIGRAVITY_API_VERSION, `ide_version=${body.metadata.ide_version}`)
  })

  await test('turns shutdown eligibility responses into actionable errors', async () => {
    const unsupported = codeAssistEligibilityErrorMessage('antigravity', [{
      reasonCode: 'UNSUPPORTED_CLIENT',
      reasonMessage: 'This client is no longer supported.',
    }])
    assert(unsupported?.includes('https://antigravity.google/'), `unsupported=${unsupported}`)
    assert(unsupported?.includes('/login antigravity'), `unsupported=${unsupported}`)

    const validation = codeAssistEligibilityErrorMessage('antigravity', [{
      reasonCode: 'VALIDATION_REQUIRED',
      reasonMessage: 'Verify the account',
      validationUrl: 'https://example.test/verify',
    }])
    assert(validation?.includes('Verify the account'), `validation=${validation}`)
    assert(validation?.includes('https://example.test/verify'), `validation=${validation}`)
  })

  await test('does not mistake an unavailable tier for total account ineligibility', async () => {
    assert(codeAssistHasEligibleTier({
      allowedTiers: [{ id: 'free-tier', isDefault: true }],
      ineligibleTiers: [{ reasonCode: 'UNSUPPORTED_CLIENT' }],
    }), 'allowed free tier was ignored')
    assert(!codeAssistHasEligibleTier({
      ineligibleTiers: [{ reasonCode: 'UNSUPPORTED_CLIENT' }],
    }), 'ineligible-only response was treated as usable')
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

void main()
