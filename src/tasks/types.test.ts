import { isTaskDialogItem, type TaskState } from './types.js'

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

function task(overrides: Record<string, unknown>): TaskState {
  return {
    id: 'task-1',
    type: 'local_agent',
    status: 'running',
    isBackgrounded: false,
    ...overrides,
  } as TaskState
}

function main(): void {
  console.log('task dialog selection:')

  test('includes a running foreground sub-agent session', () => {
    if (!isTaskDialogItem(task({}))) {
      throw new Error('foreground sub-agent was omitted')
    }
  })

  test('keeps unrelated foreground tasks out of the dialog', () => {
    if (isTaskDialogItem(task({ type: 'local_bash' }))) {
      throw new Error('foreground shell was included')
    }
  })

  test('keeps background teammates in the dialog', () => {
    if (
      !isTaskDialogItem(
        task({ type: 'in_process_teammate', isBackgrounded: true }),
      )
    ) {
      throw new Error('background teammate was omitted')
    }
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main()
