/**
 * Waiting-loop guard checks.
 *
 * Run via: bun run src/utils/waitLoop.test.ts
 */

import {
  backgroundTasksFor,
  buildWaitLoopFinalInstruction,
  buildWaitLoopNotRunResult,
  buildWaitLoopNudge,
  buildWaitLoopStopNotice,
  toolResultText,
  WAIT_LOOP_NUDGE_AT,
  WAIT_LOOP_STOP_AFTER,
  type WaitLoopCall,
  type WaitLoopFinding,
  type WaitLoopTask,
  type WaitLoopVerdict,
  WaitLoopGuard,
} from './waitLoop.js'

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (e: any) {
    failed++
    console.log(`  FAIL ${name}: ${e?.message ?? String(e)}`)
  }
}

function assert(cond: unknown, msg = 'assertion failed'): void {
  if (!cond) throw new Error(msg)
}

function assertEqual(actual: unknown, expected: unknown, msg?: string): void {
  if (actual !== expected) {
    throw new Error(msg ?? `expected ${String(expected)}, got ${String(actual)}`)
  }
}

// --- fixtures ---------------------------------------------------------------

const install: WaitLoopTask = { id: 'bvx0lqgri', description: 'bun install --frozen-lockfile' }
const build: WaitLoopTask = { id: 'b7k2m9q1z', description: 'cargo build --release' }

function call(name: string, input: unknown, resultText = '', isError = false): WaitLoopCall {
  return { name, input, resultText, isError }
}

const taskOutput = (task: WaitLoopTask) =>
  call('TaskOutput', { task_id: task.id }, '<retrieval_status>timeout</retrieval_status>')
const readLog = (task: WaitLoopTask, path = `C:\\Users\\me\\AppData\\Local\\Temp\\tau\\tasks\\${task.id}.output`) =>
  call('Read', { file_path: path }, 'File unchanged since last read.')
const socketCount = (result: string) =>
  call('Bash', { command: 'powershell.exe -Command "(Get-NetTCPConnection -OwningProcess 22020).Count"' }, result)

/** Feed rounds to a fresh guard; returns every verdict, in order. */
function run(
  rounds: WaitLoopCall[][],
  running: (round: number) => WaitLoopTask[] = () => [install],
  waitingOn: (round: number) => WaitLoopTask[] = running,
): WaitLoopVerdict[] {
  const guard = new WaitLoopGuard()
  return rounds.map((calls, i) =>
    guard.observeRound({ calls, running: running(i), waitingOn: waitingOn(i) }),
  )
}

const actions = (verdicts: WaitLoopVerdict[]) => verdicts.map(v => v.action).join(',')

// --- the reported loop ------------------------------------------------------

test('the transcript loop: nudged at the third round, stopped two rounds later', () => {
  // Each round of the reported session: a socket count that never changes,
  // TaskOutput on the install, and a read of its log.
  const round = () => [socketCount('8'), taskOutput(install), readLog(install)]
  const verdicts = run(Array.from({ length: 8 }, round))
  assertEqual(actions(verdicts.slice(0, 5)), 'none,none,nudge,none,stop')
  const nudge = verdicts[2] as WaitLoopFinding
  assertEqual(nudge.subject.kind, 'task', 'the task is named, not the probe')
  assertEqual(nudge.count, WAIT_LOOP_NUDGE_AT)
  const stop = verdicts[4] as WaitLoopFinding
  assert(stop.subject.kind === 'task' && stop.subject.task.id === install.id)
})

test('TaskOutput alone: nudge at the third check, stop after three more', () => {
  const verdicts = run(Array.from({ length: 8 }, () => [taskOutput(install)]))
  assertEqual(actions(verdicts.slice(0, 6)), 'none,none,nudge,none,none,stop')
  assertEqual((verdicts[5] as WaitLoopFinding).count, WAIT_LOOP_NUDGE_AT + WAIT_LOOP_STOP_AFTER)
})

test('reading the log counts as checking the task, whatever the path style', () => {
  for (const path of [
    `C:\\Users\\me\\AppData\\Local\\Temp\\tau\\tasks\\${install.id}.output`,
    `/c/Users/me/AppData/Local/Temp/tau/tasks/${install.id}.output`,
    `/tmp/tau-501/tasks/${install.id}.output`,
  ]) {
    const verdicts = run([[readLog(install, path)], [readLog(install, path)], [readLog(install, path)]])
    assertEqual(actions(verdicts), 'none,none,nudge', path)
  }
  // A shell reading the log by any command is the same check.
  const tail = call('Bash', { command: `tail -n 40 ~/.tau/tasks/${install.id}.output` }, 'Resolving dependencies')
  assertEqual(actions(run([[tail], [tail], [tail]])), 'none,none,nudge')
})

test('a check on the task counts even when its output changed', () => {
  // A progressing log is still polling: Tau reports the finish either way.
  const verdicts = run([0, 1, 2].map(i => [
    call('TaskOutput', { task_id: install.id }, `Resolved ${i * 100} packages`),
  ]))
  assertEqual(actions(verdicts), 'none,none,nudge')
})

test('TaskOutput and a log read in one round are one check', () => {
  const verdicts = run([[taskOutput(install), readLog(install)], [taskOutput(install), readLog(install)]])
  assertEqual(actions(verdicts), 'none,none', 'two rounds are two checks, not four')
})

test('restarting the job under a new id does not reset the countdown', () => {
  const restarted: WaitLoopTask = { id: 'byzkwcu19', description: 'bun install' }
  const rounds = [
    [taskOutput(install)],
    [taskOutput(install)],
    [taskOutput(install)], // nudge
    [call('TaskStop', { task_id: install.id }, 'stopped'), call('Bash', { command: 'bun install', run_in_background: true }, `Command running in background with ID: ${restarted.id}.`)],
    [taskOutput(restarted)],
    [taskOutput(restarted)], // 1 after the nudge
    [taskOutput(restarted)], // 2
    [taskOutput(restarted)], // 3: stop
  ]
  const verdicts = run(rounds, i => (i < 3 ? [install] : [restarted]))
  assertEqual(actions(verdicts), 'none,none,nudge,none,none,none,none,stop')
})

test('identical probes while waiting count toward the stop', () => {
  const verdicts = run(Array.from({ length: 7 }, () => [socketCount('8')]))
  assertEqual(actions(verdicts.slice(0, 6)), 'none,none,nudge,none,none,stop')
  const nudge = verdicts[2] as WaitLoopFinding
  assert(nudge.subject.kind === 'call' && nudge.subject.name === 'Bash')
})

test('a probe whose answer keeps changing learned something each time', () => {
  const verdicts = run(['28.04', '28.40', '28.77', '29.10', '29.42'].map(cpu => [
    call('Bash', { command: 'ps -o time= -p 22020' }, cpu),
  ]))
  assertEqual(actions(verdicts), 'none,none,none,none,none')
})

test('checks in the nudge round do not count toward the stop', () => {
  // Round 3 reaches the nudge with two things checked at once.
  const verdicts = run([
    [taskOutput(install), socketCount('8')],
    [taskOutput(install), socketCount('8')],
    [taskOutput(install), socketCount('8')],
    [taskOutput(install)],
  ])
  assertEqual(actions(verdicts), 'none,none,nudge,none')
})

// --- what must not trip -----------------------------------------------------

test('with nothing running, an identical repeat is nudged once and never stopped', () => {
  const status = call('Bash', { command: 'gh run view 123 --json status' }, '{"status":"in_progress"}')
  const verdicts = run(Array.from({ length: 12 }, () => [status]), () => [])
  assertEqual(verdicts.filter(v => v.action === 'nudge').length, 1)
  assertEqual(verdicts.filter(v => v.action === 'stop').length, 0)
  const nudge = verdicts.find(v => v.action === 'nudge') as WaitLoopFinding
  const text = buildWaitLoopNudge(nudge, { canWaitForNotification: true })
  assert(text.includes('Change the approach'), text)
  assert(!text.includes('task-notification'), 'nothing is running to notify about')
})

test('an edit-and-test cycle with changing results is left alone', () => {
  const rounds = [
    [call('Edit', { file_path: 'src/a.ts', old_string: 'x', new_string: 'y' }, 'ok')],
    [call('Bash', { command: 'bun test' }, '3 failed, 9 passed')],
    [call('Edit', { file_path: 'src/a.ts', old_string: 'y', new_string: 'z' }, 'ok')],
    [call('Bash', { command: 'bun test' }, '1 failed, 11 passed')],
    [call('Edit', { file_path: 'src/b.ts', old_string: 'p', new_string: 'q' }, 'ok')],
    [call('Bash', { command: 'bun test' }, '12 passed')],
  ]
  assertEqual(actions(run(rounds)), 'none,none,none,none,none,none')
})

test('reading a dev server log after each edit is work, not waiting', () => {
  const edit = (n: number): WaitLoopCall => ({
    ...call('Edit', { file_path: 'src/App.tsx', old_string: `v${n}`, new_string: `v${n + 1}` }, 'ok'),
    changesFiles: true,
  })
  // The log never changes and is read ten times, but always after an edit.
  const rounds = Array.from({ length: 20 }, (_, i) => (i % 2 ? [readLog(install)] : [edit(i)]))
  assert(run(rounds).every(v => v.action === 'none'), 'no nudge, no stop')
  // A failed edit changed nothing: the reads around it are plain waiting.
  const failed = { ...edit(0), isError: true }
  assertEqual(actions(run([[readLog(install)], [failed], [readLog(install)], [failed], [readLog(install)]])),
    'none,none,none,none,nudge')
})

test('real work after a nudge restarts the countdown', () => {
  const edit: WaitLoopCall = { ...call('Edit', { file_path: 'a.ts' }, 'ok'), changesFiles: true }
  const check = () => [taskOutput(install)]
  // nudge at 3; two checks; an edit; three more checks before the stop.
  const verdicts = run([check(), check(), check(), check(), check(), [edit], check(), check(), check(), check()])
  assertEqual(actions(verdicts), 'none,none,nudge,none,none,none,none,none,none,stop')
})

// repeatToolGuard appends a <system-reminder> to the 3rd and 5th identical call's result.
const withRepeatReminder = (result: string) =>
  `${result}\n\n<system-reminder>\nYou have called Bash 3 times in a row with identical arguments.\n</system-reminder>`

test("Tau's own reminder in a result does not make an unchanged answer look new", () => {
  const plain = socketCount('8')
  const reminded = { ...plain, resultText: withRepeatReminder('8') }
  const verdicts = run([[plain], [plain], [reminded], [plain], [reminded], [plain]])
  assertEqual(actions(verdicts), 'none,none,nudge,none,none,stop')
})

test('with nothing running, a repeat Tau already reminded about gets no second message', () => {
  const status = call('Bash', { command: 'gh run view 123' }, '{"status":"in_progress"}')
  const reminded = { ...status, resultText: withRepeatReminder(status.resultText) }
  // Back to back: the 3rd result carries Tau's reminder, so the guard stays quiet.
  assertEqual(actions(run([[status], [status], [reminded], [status]], () => [])), 'none,none,none,none')
  // In a cycle Tau's reminder never fires (it counts consecutive calls only); the guard does.
  const other = call('Read', { file_path: 'a.ts' }, 'same')
  const cycle = run([[status], [other], [status], [other], [status]], () => [])
  assertEqual(actions(cycle), 'none,none,none,none,nudge')
})

test('while waiting, the nudge goes even if Tau reminded: only it says a notification is coming', () => {
  const plain = socketCount('8')
  const reminded = { ...plain, resultText: withRepeatReminder('8') }
  const verdicts = run([[plain], [plain], [reminded]])
  assertEqual(actions(verdicts), 'none,none,nudge')
})

test('one or two checks before waiting are normal', () => {
  assertEqual(actions(run([[taskOutput(install)], [taskOutput(install)]])), 'none,none')
})

test('a finished task is no longer checked on', () => {
  // After the task ends its id is not in `running`; TaskOutput on it reads a result.
  const done = call('TaskOutput', { task_id: install.id }, '<retrieval_status>success</retrieval_status>')
  const verdicts = run([[taskOutput(install)], [taskOutput(install)], [done]], i => (i < 2 ? [install] : []))
  assertEqual(actions(verdicts), 'none,none,none')
})

test('a near-miss id is not a reference', () => {
  // Read as a check on the task, three of these would earn a nudge; as plain
  // calls with changing results, they earn nothing.
  const nearMiss = (result: string) =>
    call('Bash', { command: `cat ${install.id}x.output pre${install.id}.log` }, result)
  assertEqual(actions(run([[nearMiss('1')], [nearMiss('2')], [nearMiss('3')]])), 'none,none,none')
})

test('two tasks named in one call are both checked', () => {
  const both = call('Bash', { command: `tail -n 5 ${install.id}.output ${build.id}.output` }, '...')
  const verdicts = run([[both], [both], [both]], () => [install, build])
  const nudge = verdicts[2] as WaitLoopFinding
  assertEqual(nudge.action, 'nudge')
  assertEqual(nudge.subject.kind, 'task')
})

// --- whose tasks -------------------------------------------------------------

test('backgroundTasksFor splits what can be checked from what is awaited', () => {
  const tasks = {
    mine: { id: 'bmine0001', type: 'local_bash', status: 'running', description: 'npm test', isBackgrounded: true },
    child: { id: 'bchild001', type: 'local_bash', status: 'running', description: 'agent build', isBackgrounded: true, agentId: 'a1' },
    agent: { id: 'a1', type: 'local_agent', status: 'running', description: 'research', isBackgrounded: true, agentId: 'a1' },
    fg: { id: 'bfore0001', type: 'local_bash', status: 'running', description: 'foreground', isBackgrounded: false },
    done: { id: 'bdone0001', type: 'local_bash', status: 'completed', description: 'old', isBackgrounded: true },
    session: { id: 's1', type: 'local_agent', status: 'running', description: 'main', agentType: 'main-session' },
    dream: { id: 'd1', type: 'dream', status: 'running', description: 'memory' },
    // Long-lived by design: no completion to wait for.
    teammate: { id: 't1', type: 'in_process_teammate', status: 'running', description: 'reviewer' },
    monitor: { id: 'bmon00001', type: 'local_bash', status: 'running', description: 'tail logs', isBackgrounded: true, kind: 'monitor' },
  }
  const ids = (list: WaitLoopTask[]) => list.map(t => t.id).sort().join(',')

  const main = backgroundTasksFor(tasks, undefined)
  assertEqual(ids(main.running), 'a1,bchild001,bmine0001,d1')
  assertEqual(ids(main.waitingOn), 'a1,bmine0001')

  const sub = backgroundTasksFor(tasks, 'a1')
  assertEqual(ids(sub.running), 'bchild001,bmine0001,d1', 'an agent never waits on itself')
  assertEqual(ids(sub.waitingOn), 'bchild001')
  assertEqual(ids(backgroundTasksFor(undefined, undefined).running), '')
})

// --- what the model and the user read ---------------------------------------

const taskFinding = (action: 'nudge' | 'stop'): WaitLoopFinding => ({
  action,
  subject: { kind: 'task', task: install },
  count: 6,
  waitingOn: [install],
})

test('main-thread nudge: notification, stop checking, end the turn', () => {
  const text = buildWaitLoopNudge(taskFinding('nudge'), { canWaitForNotification: true })
  for (const part of [install.id, install.description, '<task-notification>', 'end your turn', 'TaskOutput', 'output file']) {
    assert(text.includes(part), `missing "${part}" in:\n${text}`)
  }
})

test('subagent nudge: one long wait, never "end your turn"', () => {
  const text = buildWaitLoopNudge(taskFinding('nudge'), { canWaitForNotification: false })
  assert(text.includes('block: true') && text.includes('600000'), text)
  assert(!text.includes('end your turn'), text)
})

test('probe nudge while waiting names what is running', () => {
  const finding: WaitLoopFinding = {
    action: 'nudge',
    subject: { kind: 'call', name: 'Bash', inputPreview: 'netstat -ano', resultPreview: '8' },
    count: 3,
    waitingOn: [install, build],
  }
  const text = buildWaitLoopNudge(finding, { canWaitForNotification: true })
  assert(text.includes(install.id) && text.includes(build.id) && text.includes('netstat -ano'), text)
})

test('final round, not-run result and notice say the turn is ending and why', () => {
  const stop = taskFinding('stop')
  const final = buildWaitLoopFinalInstruction(stop, { canWaitForNotification: true })
  assert(final.includes('Do not call any more tools') && final.includes(install.id), final)
  const notRun = buildWaitLoopNotRunResult(stop, { canWaitForNotification: true })
  assert(notRun.startsWith('Not run:') && notRun.includes('It is still running'), notRun)
  const notice = buildWaitLoopStopNotice(stop, { canWaitForNotification: true })
  assert(notice.includes(install.id) && notice.includes('picks it up'), notice)
  const subNotice = buildWaitLoopStopNotice(stop, { canWaitForNotification: false })
  assert(!subNotice.includes('picks it up'), 'a finished subagent picks nothing up')
})

test('long descriptions and previews stay one short line', () => {
  const long: WaitLoopTask = { id: 'blong0001', description: 'x'.repeat(500) }
  const text = buildWaitLoopNudge({ ...taskFinding('nudge'), subject: { kind: 'task', task: long }, waitingOn: [long] }, { canWaitForNotification: true })
  assert(text.length < 900, `nudge is ${text.length} chars`)
})

test('toolResultText reads strings and text blocks, ignores images', () => {
  assertEqual(toolResultText('plain'), 'plain')
  assertEqual(toolResultText([{ type: 'text', text: 'a' }, { type: 'image', source: {} }, { type: 'text', text: 'b' }]), 'a\nb')
  assertEqual(toolResultText(undefined), '')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
