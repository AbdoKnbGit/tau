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
  quota: null,
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

const quotaInfo: SessionStatusInfo = {
  ...baseInfo,
  quota: { state: 'used', percentage: 80 },
}

test('shows the quota beside the context readout when the row is wide', () => {
  const status = formatSessionStatus(quotaInfo, 120)
  assert(status.includes('Quota 80%'), `quota should be shown: ${status}`)
  assert(status.includes('Context'), `context should still be shown: ${status}`)
  assert(
    status.indexOf('Context') < status.indexOf('Quota'),
    'quota should follow the context readout',
  )
})

test('omits the quota while it is still being determined', () => {
  const status = formatSessionStatus(baseInfo, 120)
  assert(!status.includes('Quota'), `no quota segment expected: ${status}`)
})

test('names the session window so a percentage is not read as a weekly cap', () => {
  const status = formatSessionStatus(
    { ...baseInfo, quota: { state: 'used', percentage: 12, window: '5h' } },
    120,
  )
  assert(status.includes('Quota 5h 12%'), `expected a named window: ${status}`)
})

test('leaves an unnamed window as a bare percentage', () => {
  const status = formatSessionStatus(
    { ...baseInfo, quota: { state: 'used', percentage: 40 } },
    120,
  )
  assert(status.includes('Quota 40%'), `expected a bare percentage: ${status}`)
  assert(!status.includes('5h'), 'nothing invents a window that was not reported')
})

test('shows a balance that has no percentage', () => {
  const status = formatSessionStatus(
    { ...baseInfo, quota: { state: 'text', text: '$12.34 remaining' } },
    120,
  )
  assert(
    status.includes('Quota $12.34 remaining'),
    `a balance should be shown verbatim: ${status}`,
  )
})

test('shows spend where the provider publishes no quota at all', () => {
  const status = formatSessionStatus(
    { ...baseInfo, quota: { state: 'spend', usd: 0.42, estimated: false } },
    120,
  )
  assert(status.includes('Spend $0.42'), `expected spend: ${status}`)
})

test('marks a flat-fee provider as an estimate, not an amount billed', () => {
  const status = formatSessionStatus(
    { ...baseInfo, quota: { state: 'spend', usd: 1.5, estimated: true } },
    120,
  )
  assert(status.includes('Est $1.50'), `expected an estimate: ${status}`)
  assert(!status.includes('Spend'), 'a subscription was not "spent" per token')
})

test('never rounds real spend down to $0.00', () => {
  const status = formatSessionStatus(
    { ...baseInfo, quota: { state: 'spend', usd: 0.004, estimated: false } },
    120,
  )
  assert(status.includes('<$0.01'), `sub-cent work is not free: ${status}`)

  const zero = formatSessionStatus(
    { ...baseInfo, quota: { state: 'spend', usd: 0, estimated: false } },
    120,
  )
  assert(!zero.includes('Spend'), 'nothing spent means no segment')
})

test('states n/a once no provider source has a number to give', () => {
  const status = formatSessionStatus(
    { ...baseInfo, quota: { state: 'unavailable' } },
    120,
  )
  assert(
    status.includes('Quota n/a'),
    `a settled absence should be stated: ${status}`,
  )
})

test('drops the quota before sacrificing the context readout', () => {
  const wide = formatSessionStatus(quotaInfo, 120)
  const narrow = formatSessionStatus(quotaInfo, stringWidth(wide) + 2)

  assert(!narrow.includes('Quota'), `quota should be dropped first: ${narrow}`)
  assert(narrow.includes('Context'), `context must survive: ${narrow}`)
  assert(narrow.includes('~/work/tau'), `cwd must survive: ${narrow}`)
})

test('rounds and clamps the quota rather than printing a float tail', () => {
  const status = formatSessionStatus(
    { ...baseInfo, quota: { state: 'used', percentage: 66.66666666666667 } },
    120,
  )
  assert(status.includes('Quota 67%'), `quota should round: ${status}`)

  const over = formatSessionStatus(
    { ...baseInfo, quota: { state: 'used', percentage: 140 } },
    120,
  )
  assert(over.includes('Quota 100%'), `quota should clamp to 100: ${over}`)
})

test('never lets the quota push the row past the terminal width', () => {
  const wideCjk: SessionStatusInfo = {
    ...quotaInfo,
    cwd: '~/项目/非常长的目录名称',
    provider: '提供商',
    model: '模型-超长名称',
  }
  for (const info of [quotaInfo, wideCjk]) {
    for (const columns of [5, 12, 16, 24, 40, 56, 72, 88, 120, 160]) {
      const status = formatSessionStatus(info, columns)
      assert(
        stringWidth(status) <= Math.max(0, columns - 4),
        `status exceeds width at ${columns} columns: ${status}`,
      )
    }
  }
})

test('is display-width safe for unicode and pathological widths', () => {
  const unicodeInfo: SessionStatusInfo = {
    cwd: '~/项目/非常长的目录名称',
    provider: '提供商',
    model: '模型-超长名称',
    usedContextTokens: 202_000,
    contextWindowTokens: 200_000,
    consumedContextPercentage: 101.4,
    quota: null,
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

test('a long provider label is what costs the row its spend segment', () => {
  // Reported live: an Alibaba session showed cwd, provider/model and context
  // but no spend. Nothing was wrong with the money — the row simply did not
  // fit, and quota is the first segment dropped. A 1M-context model already
  // spends the width on `10K/1M`, so the provider label is the part a new
  // provider actually controls.
  //
  // This is the budget to respect when naming one: at 100 columns, a label of
  // about a dozen characters still leaves room for spend, and twenty does not.
  const row: SessionStatusInfo = {
    cwd: '~\\Desktop\\ac',
    provider: 'Alibaba',
    model: 'qwen3.8-flash',
    usedContextTokens: 10_000,
    contextWindowTokens: 1_000_000,
    consumedContextPercentage: 1,
    quota: { state: 'spend', usd: 0.0015, estimated: false },
  }

  assert(
    formatSessionStatus(row, 100).includes('Spend <$0.01'),
    `short label should keep spend: ${formatSessionStatus(row, 100)}`,
  )
  assert(
    !formatSessionStatus(
      { ...row, provider: 'Alibaba Model Studio' },
      100,
    ).includes('Spend'),
    'a 20-character label pushes spend off a 100-column row',
  )
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
