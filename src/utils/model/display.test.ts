import {
  getProviderModelDisplayName,
} from './providerDisplayNames.js'

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (error: any) {
    failed++
    console.log(`  FAIL ${name}: ${error?.message ?? String(error)}`)
  }
}

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message)
  }
}

function main(): void {
  console.log('model display:')

  test('cursor auto display keeps the native label', () => {
    assert(getProviderModelDisplayName('cursor', 'auto') === 'Auto', 'expected Auto')
    assert(getProviderModelDisplayName('cursor', 'default') === 'Auto', 'expected legacy default to map to Auto')
  })

  test('cursor codex variants use cursor-native names', () => {
    assert(
      getProviderModelDisplayName('cursor', 'gpt-5.3-codex-high-fast') === 'GPT-5.3 Codex High Fast',
      'expected Cursor high-fast label',
    )
    assert(getProviderModelDisplayName('cursor', 'gpt-5.3-codex') === 'GPT-5.3 Codex', 'expected Cursor base label')
  })

  test('non-cursor providers keep their existing display fallback', () => {
    assert(
      getProviderModelDisplayName('openai', 'gpt-5.3-codex') === null,
      'expected non-Cursor providers to keep their existing display path',
    )
  })

  test('antigravity uses clean provider-owned labels', () => {
    assert(
      getProviderModelDisplayName('antigravity', 'gemini-3.5-flash-high') === 'Gemini 3.5 Flash (High)',
      'expected Gemini 3.5 Flash High label',
    )
    assert(
      getProviderModelDisplayName('antigravity', 'claude-opus-4-6-thinking') === 'Claude Opus 4.6',
      'expected Claude Opus Antigravity label without thinking suffix',
    )
  })

  test('cursor lookup covers extra-high labels', () => {
    assert(
      getProviderModelDisplayName('cursor', 'gpt-5.3-codex-xhigh') === 'GPT-5.3 Codex XHigh',
      'expected friendly Cursor xhigh label',
    )
  })

  test('cursor claude ids use the current native notation', () => {
    assert(
      getProviderModelDisplayName('cursor', 'claude-4.6-opus-high-thinking') === 'Claude 4.6 Opus High Thinking',
      'expected current Cursor 4.6 opus id',
    )
    assert(
      getProviderModelDisplayName('cursor', 'claude-4.5-sonnet') === 'Claude 4.5 Sonnet',
      'expected current Cursor 4.5 sonnet id',
    )
  })

  test('legacy cursor aliases resolve to the current display names', () => {
    assert(
      getProviderModelDisplayName('cursor', 'opus-4.6') === 'Claude 4.6 Opus High',
      'expected legacy Cursor alias to resolve to current Cursor display',
    )
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) {
    process.exit(1)
  }
}

main()
