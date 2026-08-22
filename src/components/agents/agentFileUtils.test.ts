import { formatAgentAsMarkdown } from './agentMarkdown.js'

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
  if (!condition) throw new Error(message)
}

function main(): void {
  console.log('agent file utilities:')

  test('serializes a provider and exact model in frontmatter', () => {
    const markdown = formatAgentAsMarkdown(
      'reviewer',
      'Review changes',
      ['Read'],
      'Be precise.',
      'blue',
      'gpt-5.4',
      undefined,
      undefined,
      'openai',
    )

    assert(markdown.includes('\nprovider: openai\nmodel: gpt-5.4\n'), markdown)
    assert(markdown.endsWith('\n\nBe precise.\n'), 'prompt was not preserved')
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main()
