/**
 * Bash command planner unit tests.
 *
 * Run: bun run src/tools/BashTool/bashCommandPlanner.test.ts
 */

import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { _primeCacheForTest, resetCommandHelpCache } from './commandHelp.js'
import {
  analyzeBashCommandPlanning,
  renderBashCommandPlan,
  shouldAutoPlanBashCommand,
} from './bashCommandPlanner.js'

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

async function main(): Promise<void> {
  console.log('bash command planner:')

  await test('detects container subcommand syntax', () => {
    const plan = analyzeBashCommandPlanning({
      command: 'docker compose -f docker-compose.yml up -d api',
    })

    assert(plan.domain === 'container', `expected container, got ${plan.domain}`)
    assert(plan.key === 'docker compose', `expected docker compose key, got ${plan.key}`)
    assert(
      plan.discoveryCommands.includes('docker compose --help'),
      'expected docker compose help suggestion',
    )
  })

  await test('detects package-manager commands and suggests manifest discovery', () => {
    const plan = analyzeBashCommandPlanning({
      command: 'pnpm test -- src/foo.test.ts -t "handles edge cases"',
    })

    assert(plan.domain === 'package-manager', `expected package-manager, got ${plan.domain}`)
    assert(plan.discoveryCommands.includes('cat package.json'), 'expected package.json')
    assert(plan.discoveryCommands.includes('pnpm run'), 'expected pnpm run')
  })

  await test('detects python module entrypoints and suggests module help', () => {
    const plan = analyzeBashCommandPlanning({
      command: 'python -m ml.train_regression --target target_power_next_1s --epochs 5',
    })

    assert(plan.domain === 'python', `expected python, got ${plan.domain}`)
    assert(
      plan.discoveryCommands.includes('python -m ml.train_regression --help'),
      'expected python module --help',
    )
    assert(
      plan.discoveryCommands.some(command => command.includes('argparse')),
      'expected argparse source search',
    )
  })

  await test('recognizes discovery commands and does not suggest more discovery', () => {
    const plan = analyzeBashCommandPlanning({
      command: 'docker compose --help',
    })

    assert(plan.isDiscoveryCommand, 'expected discovery command')
    assert(plan.discoveryCommands.length === 0, 'expected no discovery suggestions')
  })

  await test('requires proactive plan for complex external CLI syntax', () => {
    const decision = shouldAutoPlanBashCommand({
      command: 'docker compose -f docker-compose.yml --profile gpu up --build -d api worker',
    })

    assert(decision.required, 'expected auto-plan requirement')
    assert(
      decision.reasons.some(reason => reason.includes('container')),
      'expected container reason',
    )
  })

  await test('does not auto-plan discovery, read-like, confirmed, or structured commands', () => {
    assert(
      !shouldAutoPlanBashCommand({ command: 'docker compose --help' }).required,
      'discovery should not require auto-plan',
    )
    assert(
      !shouldAutoPlanBashCommand({
        command: 'rg -n "argparse|click|typer" . --glob "*.py"',
      }).required,
      'read-like commands should not require auto-plan',
    )
    assert(
      !shouldAutoPlanBashCommand({
        command: 'docker compose -f docker-compose.yml --profile gpu up --build -d api worker',
        syntax_confirmed: true,
      }).required,
      'confirmed syntax should not require auto-plan',
    )
    assert(
      !shouldAutoPlanBashCommand({
        command: 'docker compose --file docker-compose.yml up --detach api',
        command_parts: {
          executable: 'docker',
          tokens: [
            { kind: 'arg', value: 'compose' },
            { kind: 'flag', name: 'file', value: 'docker-compose.yml' },
            { kind: 'arg', value: 'up' },
            { kind: 'flag', name: 'detach', value: true },
            { kind: 'arg', value: 'api' },
          ],
        },
      }).required,
      'structured command parts should not require auto-plan',
    )
  })

  await test('renders dry-run report with cached verified local syntax', async () => {
    resetCommandHelpCache()
    _primeCacheForTest('docker compose', {
      content: 'Usage: docker compose [OPTIONS] COMMAND\n\nCommands:\n  up\n  config',
      source: 'help',
    })
    const root = mkdtempSync(join(tmpdir(), 'tau-bash-planner-'))

    try {
      const report = await renderBashCommandPlan(
        {
          command: 'docker compose -f docker-compose.yml up -d api',
          workdir: root,
        },
        root,
      )

      assert(report.includes('Bash command plan (dry run only)'), 'missing header')
      assert(report.includes('The command was not executed.'), 'missing non-execution statement')
      assert(report.includes('Domain: container'), 'missing domain')
      assert(report.includes('Native shell parser:'), 'missing native parser section')
      assert(report.includes('Verified local CLI syntax from docker compose --help'), 'missing verified help attribution')
      assert(report.includes('Usage: docker compose'), 'missing help content')
    } finally {
      rmSync(root, { recursive: true, force: true })
      resetCommandHelpCache()
    }
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
