import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, normalize } from 'path'
import {
  clearTeamModeRuntimeState,
  completeTeamModeRun,
  failTeamModeRun,
  getTeamModeRuntimePath,
  readTeamModeRuntimeState,
  startTeamModeRun,
  summarizeTeamModeRuntime,
  syncTeamModeRuntimeConfig,
  TEAM_MODE_RUNTIME_SCHEMA_VERSION,
} from './runtime.js'
import type { TeamModeRole } from './state.js'

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

function role(overrides: Partial<TeamModeRole> = {}): TeamModeRole {
  return {
    role: 'architect',
    provider: 'openai',
    model: 'gpt-5.2',
    active: true,
    ...overrides,
  }
}

function withTempConfig(fn: (dir: string) => void): void {
  const previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  const dir = mkdtempSync(join(tmpdir(), 'tau-team-mode-runtime-'))
  process.env.CLAUDE_CONFIG_DIR = dir
  try {
    clearTeamModeRuntimeState()
    fn(dir)
  } finally {
    clearTeamModeRuntimeState()
    if (previousConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = previousConfigDir
    }
    rmSync(dir, { recursive: true, force: true })
  }
}

function main(): void {
  console.log('team-mode runtime:')

  test('writes versioned state under the configured config directory', () => {
    withTempConfig(dir => {
      const state = syncTeamModeRuntimeConfig({
        roles: [role()],
        enabled: true,
        event: 'test config',
      })
      assert(state !== null, 'expected runtime state')

      const runtimePath = getTeamModeRuntimePath()
      assert(
        normalize(runtimePath).startsWith(normalize(dir)),
        'runtime path must stay inside CLAUDE_CONFIG_DIR',
      )

      const raw = JSON.parse(readFileSync(runtimePath, 'utf-8'))
      assert(
        raw.schemaVersion === TEAM_MODE_RUNTIME_SCHEMA_VERSION,
        'expected schema version',
      )
      assert(raw.roles.length === 1, 'expected persisted role')
      assert(raw.enabled === true, 'expected enabled runtime')
    })
  })

  test('summarizes enabled state and fallback configuration', () => {
    withTempConfig(() => {
      syncTeamModeRuntimeConfig({
        roles: [role(), role({ role: 'implementer', active: false })],
        fallback: {
          provider: 'kiro',
          model: 'claude-sonnet-4-6-20251117',
        },
        fallbackEnabled: true,
        enabled: false,
      })

      const summary = summarizeTeamModeRuntime()
      assert(summary.exists, 'expected runtime summary')
      assert(summary.enabled === false, 'expected runtime disabled')
      assert(summary.roleCount === 2, 'expected two roles')
      assert(summary.activeRoleCount === 1, 'expected one active role')
      assert(summary.fallbackEnabled === true, 'expected fallback enabled')
    })
  })

  test('records worker run start and completion', () => {
    withTempConfig(() => {
      syncTeamModeRuntimeConfig({ roles: [role()], enabled: true })
      const run = startTeamModeRun({
        role: 'architect',
        provider: 'openai',
        model: 'gpt-5.2',
        description: 'design runtime',
        prompt: 'Produce the team-mode runtime plan.',
      })
      assert(run !== null, 'expected run record')
      completeTeamModeRun(run.id, { resultPreview: 'status=completed' })

      const state = readTeamModeRuntimeState()
      assert(state !== null, 'expected persisted state')
      assert(state.runs.length === 1, 'expected one run')
      assert(state.runs[0]?.status === 'completed', 'expected completed run')
      assert(state.outcomes.length === 1, 'expected completed outcome')

      const summary = summarizeTeamModeRuntime(state)
      assert(summary.runCounts.completed === 1, 'expected completed count')
      assert(summary.latestRun?.role === 'architect', 'expected latest run role')
    })
  })

  test('records failed worker runs without throwing', () => {
    withTempConfig(() => {
      const run = startTeamModeRun({
        role: 'reviewer',
        provider: 'kiro',
        model: 'claude-sonnet-4-6-20251117',
      })
      assert(run !== null, 'expected run record')
      failTeamModeRun(run.id, new Error('x'.repeat(2_000)))

      const state = readTeamModeRuntimeState()
      assert(state !== null, 'expected persisted state')
      assert(state.runs[0]?.status === 'failed', 'expected failed run')
      assert(
        (state.runs[0]?.error?.length ?? 0) <= 1_200,
        'expected truncated error',
      )

      const summary = summarizeTeamModeRuntime(state)
      assert(summary.runCounts.failed === 1, 'expected failed count')
      assert(summary.latestLog?.level === 'error', 'expected error log')
    })
  })

  test('clears runtime state on reset', () => {
    withTempConfig(() => {
      syncTeamModeRuntimeConfig({ roles: [role()], enabled: true })
      assert(readTeamModeRuntimeState() !== null, 'expected runtime state')
      clearTeamModeRuntimeState()
      assert(readTeamModeRuntimeState() === null, 'expected runtime cleared')
    })
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) {
    process.exit(1)
  }
}

main()
