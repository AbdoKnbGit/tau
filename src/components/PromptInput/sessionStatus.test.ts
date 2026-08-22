/**
 * Persistent session-status formatting tests.
 *
 * Run: bun run src/components/PromptInput/sessionStatus.test.ts
 */

import path from 'path'
import { stringWidth } from '../../ink/stringWidth.js'
import {
  calculateConsumedContextPercentage,
  formatSessionStatus,
  formatTokenCount,
  shortenSessionCwd,
  type SessionStatusInfo,
} from './sessionStatus.js'

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

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

const baseInfo: SessionStatusInfo = {
  cwd: '~/work/tau',
  provider: 'Anthropic',
  model: 'Claude Sonnet 4.6',
  usedContextTokens: 36_000,
  contextWindowTokens: 200_000,
  consumedContextPercentage: 18,
}

console.log('session status:')

test('collapses the home directory and its descendants', () => {
  const home = path.resolve(path.sep, 'Users', 'tau-user')
  const project = path.join(home, 'work', 'tau')

  assert(shortenSessionCwd(home, home, path) === '~', 'home should become ~')
  assert(
    shortenSessionCwd(project, home, path) === path.join('~', 'work', 'tau'),
    'home descendant should retain its relative path',
  )
})

test('does not collapse a sibling which only shares the home prefix', () => {
  const parent = path.resolve(path.sep, 'Users')
  const home = path.join(parent, 'tau')
  const sibling = path.join(parent, 'tau-backup')

  assert(
    shortenSessionCwd(sibling, home, path) === sibling,
    'sibling path must remain absolute',
  )
})

test('abbreviates token counts without reading as zero', () => {
  assert(formatTokenCount(0) === '0', 'zero should stay exact')
  assert(formatTokenCount(840) === '840', 'sub-thousand counts stay exact')
  assert(formatTokenCount(16_000) === '16K', 'thousands abbreviate to K')
  assert(formatTokenCount(1_200) === '1K', 'a partial thousand rounds to K')
  assert(formatTokenCount(999_600) === '1M', 'never renders as 1000K')
  assert(formatTokenCount(1_000_000) === '1M', 'a round million drops the .0')
  assert(formatTokenCount(1_500_000) === '1.5M', 'millions keep one decimal')
  assert(formatTokenCount(200_000) === '200K', 'window sizes abbreviate too')
  assert(formatTokenCount(Number.NaN) === '0', 'invalid counts degrade to 0')
})

test('shows tokens used, the window, and the percentage beside the bar', () => {
  const status = formatSessionStatus(
    { ...baseInfo, usedContextTokens: 16_000, contextWindowTokens: 1_000_000, consumedContextPercentage: 1.6 },
    120,
  )
  assert(
    status ===
      '~/work/tau · Anthropic / Claude Sonnet 4.6 · Context ░░░░░░░░░░ 16K/1M (2%)',
    `unexpected wide status: ${status}`,
  )
})

test('uses the descriptive format when the terminal has room', () => {
  const status = formatSessionStatus(baseInfo, 120)
  assert(
    status ===
      '~/work/tau · Anthropic / Claude Sonnet 4.6 · Context ██░░░░░░░░ 36K/200K (18%)',
    `unexpected wide status: ${status}`,
  )
})

test('shows an unknown context until usage has been measured', () => {
  const status = formatSessionStatus(
    {
      ...baseInfo,
      usedContextTokens: null,
      consumedContextPercentage: null,
    },
    120,
  )
  assert(
    status.endsWith('Context ░░░░░░░░░░ --'),
    `unexpected context label: ${status}`,
  )
})

test('omits the window size when the model does not report one', () => {
  const status = formatSessionStatus(
    { ...baseInfo, contextWindowTokens: 0 },
    120,
  )
  assert(
    status.endsWith('Context ██░░░░░░░░ 18%'),
    `unexpected context label: ${status}`,
  )
})

test('keeps the token counts on a moderately narrow row', () => {
  const columns = 64
  const status = formatSessionStatus(baseInfo, columns)

  assert(stringWidth(status) <= columns - 4, 'status exceeds padded width')
  assert(
    status.endsWith('36K/200K (18%)'),
    `token counts should survive: ${status}`,
  )
  assert(status.includes('Anthropic'), 'provider should remain identifiable')
})

test('keeps cwd, provider/model, and context on one narrow row', () => {
  const columns = 42
  const status = formatSessionStatus(baseInfo, columns)

  assert(stringWidth(status) <= columns - 4, 'status exceeds padded width')
  assert(status.includes('·'), 'status should retain field separators')
  assert(status.includes('Anthropic'), 'provider should remain identifiable')
  assert(status.endsWith('█░░░░░ 18%'), 'context bar should remain visible')
})

test('measures only supplied conversation tokens against the full window', () => {
  const percentage = calculateConsumedContextPercentage(20_000, 200_000)
  assert(percentage === 10, `unexpected consumed percentage: ${percentage}`)
  assert(
    calculateConsumedContextPercentage(-500, 200_000) === 0,
    'negative estimates should clamp to zero',
  )
  assert(
    calculateConsumedContextPercentage(250_000, 200_000) === 100,
    'usage should clamp to the context window',
  )
  assert(
    calculateConsumedContextPercentage(20_000, 0) === null,
    'invalid context windows should remain unknown',
  )
})

test('is display-width safe for unicode and pathological widths', () => {
  const unicodeInfo: SessionStatusInfo = {
    cwd: '~/项目/非常长的目录名称',
    provider: '提供商',
    model: '模型-超长名称',
    usedContextTokens: 202_000,
    contextWindowTokens: 200_000,
    consumedContextPercentage: 101.4,
  }

  for (const columns of [5, 12, 16, 24, 40, 56]) {
    const status = formatSessionStatus(unicodeInfo, columns)
    assert(
      stringWidth(status) <= Math.max(0, columns - 4),
      `status exceeds width at ${columns} columns: ${status}`,
    )
  }
  assert(
    formatSessionStatus(unicodeInfo, 160).endsWith(
      'Context ██████████ 202K/200K (100%)',
    ),
    'percentage should clamp to 100 while the counts stay honest',
  )
  assert(
    formatSessionStatus(unicodeInfo, Number.NaN) === '',
    'invalid terminal width should not produce layout output',
  )
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
