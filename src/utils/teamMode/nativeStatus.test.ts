import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { summarizeNativeTeamModeStatus } from './nativeStatus.js'

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

function withTempConfig(fn: (dir: string) => void): void {
  const previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  const dir = mkdtempSync(join(tmpdir(), 'tau-team-mode-native-'))
  process.env.CLAUDE_CONFIG_DIR = dir
  try {
    fn(dir)
  } finally {
    if (previousConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = previousConfigDir
    }
    rmSync(dir, { recursive: true, force: true })
  }
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8')
}

function main(): void {
  console.log('team-mode native status:')

  test('returns empty native status when no team is active', () => {
    withTempConfig(() => {
      const status = summarizeNativeTeamModeStatus()
      assert(status.teamName === undefined, 'expected no team name')
      assert(!status.teamFileExists, 'expected no team file')
      assert(status.taskCounts.total === 0, 'expected no tasks')
    })
  })

  test('summarizes Tau team file, inboxes, and task board', () => {
    withTempConfig(dir => {
      const teamName = 'task-demo'
      const teamDir = join(dir, 'teams', teamName)
      const inboxDir = join(teamDir, 'inboxes')
      const taskDir = join(dir, 'tasks', teamName)
      mkdirSync(inboxDir, { recursive: true })
      mkdirSync(taskDir, { recursive: true })

      writeJson(join(teamDir, 'config.json'), {
        name: teamName,
        members: [
          { name: 'team-lead', isActive: true },
          { name: 'architect', isActive: true },
          { name: 'reviewer', isActive: false },
        ],
      })
      writeJson(join(inboxDir, 'architect.json'), [
        { from: 'team-lead', text: 'go', read: false },
        { from: 'reviewer', text: 'note', read: true },
      ])
      writeJson(join(taskDir, '1.json'), { status: 'pending' })
      writeJson(join(taskDir, '2.json'), { status: 'in_progress' })
      writeJson(join(taskDir, '3.json'), { status: 'completed' })

      const status = summarizeNativeTeamModeStatus({
        teamContext: { teamName },
      })
      assert(status.teamFileExists, 'expected team file')
      assert(status.memberCount === 3, 'expected three members')
      assert(status.activeMemberCount === 2, 'expected two active members')
      assert(status.inboxFileCount === 1, 'expected one inbox')
      assert(status.messageCount === 2, 'expected two messages')
      assert(status.unreadMessageCount === 1, 'expected one unread message')
      assert(status.taskCounts.total === 3, 'expected three tasks')
      assert(status.taskCounts.pending === 1, 'expected pending task')
      assert(status.taskCounts.in_progress === 1, 'expected in-progress task')
      assert(status.taskCounts.completed === 1, 'expected completed task')
    })
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) {
    process.exit(1)
  }
}

main()
