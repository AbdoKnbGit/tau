/**
 * Tasks between Tau sessions (store.ts + runtime.ts): the files, the
 * addressing, and the rules that keep a task from being lost, run twice,
 * looping, or reaching a session that did not opt in.
 *
 * Run: bun run src/services/peers/peers.test.ts
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  peerCommandLine,
  defaultOpenCommand,
  describeClosedSession,
  expandOpenCommand,
  listClosedSessions,
  openPeerSession,
  openSessionIds,
} from './open.js'
import {
  acceptPeersFrom,
  attachPeerSession,
  getPeerRole,
  isAccepting,
  openTaskCount,
  pollPeersForTesting,
  resetPeersForTesting,
  resetTaskBudget,
  sendPeerTask,
  sendReply,
  setAccepting,
  setOrchestrator,
  setPeerWorkingFor,
  settlePeersForTesting,
  subscribePeerRole,
  updatePeerSelf,
  type PeerHandlers,
} from './runtime.js'
import {
  cutText,
  formatReplyNotification,
  formatTaskPrompt,
  peerInboxDir,
  listLiveCards,
  newMessageId,
  peersDir,
  postMessage,
  resolvePeer,
  takeMessages,
  thisHost,
  writeCard,
  type PeerCard,
  type PeerReply,
  type PeerTask,
} from './store.js'

let passed = 0
let failed = 0

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  await resetPeersForTesting()
  const root = mkdtempSync(join(tmpdir(), 'tau-peers-'))
  process.env.CLAUDE_CONFIG_DIR = root
  try {
    await fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (e) {
    failed++
    console.log(`  FAIL ${name}: ${e instanceof Error ? e.stack : String(e)}`)
  } finally {
    await resetPeersForTesting()
    rmSync(root, { recursive: true, force: true })
  }
}

function eq(actual: unknown, expected: unknown, label: string): void {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error(`${label}: ${a} !== ${b}`)
}

function assert(cond: unknown, label: string): void {
  if (!cond) throw new Error(label)
}

const ORCH = '11111111-1111-4111-8111-111111111111'
const WORKER = '22222222-2222-4222-8222-222222222222'
const OTHER = '33333333-3333-4333-8333-333333333333'

function cardFor(sessionId: string, name: string, extra: Partial<PeerCard> = {}): PeerCard {
  return {
    sessionId,
    pid: process.pid,
    host: thisHost(),
    cwd: `C:\\work\\${name}`,
    name,
    status: 'idle',
    activeAt: Date.now(),
    updatedAt: Date.now(),
    ...extra,
  }
}

function taskFor(to: string, extra: Partial<PeerTask> = {}): PeerTask {
  return {
    kind: 'task',
    id: newMessageId(),
    to,
    from: { sessionId: ORCH, name: 'main', cwd: 'C:\\work\\main', permissionMode: 'default' },
    text: 'fix the login test',
    sentAt: Date.now(),
    ...extra,
  }
}

function recorder(): PeerHandlers & { tasks: PeerTask[]; replies: PeerReply[] } {
  const tasks: PeerTask[] = []
  const replies: PeerReply[] = []
  return { tasks, replies, onTask: t => tasks.push(t), onReply: r => replies.push(r) }
}

const options = (extra: Partial<{ taskLimit: number }> = {}) => ({
  sessionId: ORCH,
  permissionMode: 'default',
  taskLimit: extra.taskLimit ?? 20,
  replyLimit: 8000,
})

async function waitForExit(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null) return
  await new Promise<void>(resolve => child.once('exit', () => resolve()))
}

async function main(): Promise<void> {
  console.log('cards')

  await test('a live card is listed, a dead one is swept', async () => {
    await writeCard(cardFor(WORKER, 'api'))
    await writeCard(cardFor(OTHER, 'gone', { pid: 2_000_000_000 }))
    eq((await listLiveCards()).map(c => c.name), ['api'], 'live')
    eq(readdirSync(join(peersDir(), 'cards')).sort(), [`${WORKER}.json`], 'swept')
  })

  await test('a card that stopped beating is not live even if its pid runs', async () => {
    await writeCard(cardFor(WORKER, 'api', { updatedAt: Date.now() - 5 * 60_000 }))
    eq((await listLiveCards()).length, 0, 'stale')
    eq(readdirSync(join(peersDir(), 'cards')).length, 1, 'kept until the long sweep')
  })

  await test('a torn or foreign file in cards/ is skipped', async () => {
    mkdirSync(join(peersDir(), 'cards'), { recursive: true })
    writeFileSync(join(peersDir(), 'cards', 'x.json'), '{"sessionId":')
    writeFileSync(join(peersDir(), 'cards', 'y.json'), '{"sessionId":"../../etc","pid":1}')
    await writeCard(cardFor(WORKER, 'api'))
    eq((await listLiveCards()).map(c => c.name), ['api'], 'only the valid card')
  })

  console.log('inbox')

  await test('a message is taken once, oldest first', async () => {
    const first = taskFor(WORKER, { id: newMessageId(1000), text: 'one' })
    const second = taskFor(WORKER, { id: newMessageId(2000), text: 'two' })
    await postMessage(second)
    await postMessage(first)
    eq((await takeMessages(WORKER)).map(m => m.text), ['one', 'two'], 'order')
    eq((await takeMessages(WORKER)).length, 0, 'not twice')
    eq(readdirSync(peerInboxDir(WORKER)).length, 0, 'folder empty')
  })

  await test('junk, misaddressed and oversized messages are dropped', async () => {
    mkdirSync(peerInboxDir(WORKER), { recursive: true })
    writeFileSync(join(peerInboxDir(WORKER), 'a.json'), 'not json')
    await postMessage({ ...taskFor(WORKER), text: 'x'.repeat(200_001) })
    const wrong = taskFor(OTHER)
    writeFileSync(join(peerInboxDir(WORKER), `${wrong.id}.json`), JSON.stringify(wrong))
    await postMessage(taskFor(WORKER, { text: 'kept' }))
    eq((await takeMessages(WORKER)).map(m => m.text), ['kept'], 'only the good one')
    eq(readdirSync(peerInboxDir(WORKER)).length, 0, 'all consumed')
  })

  await test('ids cannot leave the inbox folder', async () => {
    let threw = false
    try {
      await postMessage(taskFor('../cards'))
    } catch {
      threw = true
    }
    assert(threw, 'post refused')
    eq((await takeMessages('..')).length, 0, 'take refused')
  })

  console.log('addressing')

  const cards = [
    cardFor(WORKER, 'api'),
    cardFor(OTHER, 'web'),
    cardFor('44444444-4444-4444-8444-444444444444', 'Web'),
  ]

  await test('a name matches regardless of case, an id prefix works', () => {
    eq((resolvePeer(cards, ' API ') as { card: PeerCard }).card.sessionId, WORKER, 'name')
    eq((resolvePeer(cards, '2222') as { card: PeerCard }).card.sessionId, WORKER, 'id prefix')
  })

  await test('two sessions with one name ask for an id', () => {
    const r = resolvePeer(cards, 'web') as { error: string }
    assert(r.error.includes('peer:33333333') && r.error.includes('peer:44444444'), r.error)
  })

  await test('an unknown name lists who takes tasks', () => {
    const r = resolvePeer(cards, 'docs') as { error: string }
    assert(r.error.includes('api, web, Web'), r.error)
    assert((resolvePeer([], 'api') as { error: string }).error.includes('/peers on'), 'none')
  })

  console.log('formats')

  await test('a task tells the session where its answer goes', () => {
    const text = formatTaskPrompt(taskFor(WORKER, { from: { sessionId: ORCH, name: 'ma"in\n', cwd: 'C:\\w' } }))
    assert(text.startsWith('<peer-task from="ma in" cwd="C:\\w">\nfix the login test\n</peer-task>'), text)
    assert(text.includes('goes back to it automatically'), 'explains the answer')
  })

  await test('an answer is a task notification addressed by peer:', () => {
    const reply: PeerReply = {
      kind: 'reply',
      id: newMessageId(),
      to: ORCH,
      from: { sessionId: WORKER, name: 'api', cwd: 'C:\\work\\api' },
      text: 'fixed',
      sentAt: Date.now(),
      inReplyTo: 'x',
      outcome: 'done',
    }
    eq(
      formatReplyNotification(reply),
      '<task-notification>\n<task-id>peer:api</task-id>\n<status>completed</status>\n<summary>Session "api" answered</summary>\n<result>fixed</result>\n</task-notification>',
      'done',
    )
    const closed = formatReplyNotification({ ...reply, outcome: 'closed', text: '' })
    assert(closed.includes('<status>killed</status>') && !closed.includes('<result>'), closed)
  })

  await test('a long answer is cut and says so', () => {
    eq(cutText('abc', 3), 'abc', 'fits')
    assert(cutText('abcdef', 3).startsWith('abc\n[Cut at 3 characters.'), 'cut')
  })

  console.log('orchestrator')

  await test('a task reaches the worker; its answer comes back once', async () => {
    setOrchestrator()
    const h = recorder()
    attachPeerSession(h, { sessionId: ORCH, cwd: 'C:\\work\\main', name: 'main', status: 'idle' }, false)
    await writeCard(cardFor(WORKER, 'api'))
    const sent = await sendPeerTask('api', 'fix it', options())
    assert(sent.ok, sent.message)
    eq(openTaskCount(WORKER), 1, 'open')
    const [task] = (await takeMessages(WORKER)) as PeerTask[]
    eq([task!.text, task!.from.sessionId, task!.replyLimit], ['fix it', ORCH, 8000], 'task')
    await postMessage({
      kind: 'reply',
      id: newMessageId(),
      to: ORCH,
      from: { sessionId: WORKER, name: 'api', cwd: 'C:\\work\\api' },
      text: 'done',
      sentAt: Date.now(),
      inReplyTo: task!.id,
      outcome: 'done',
    })
    await pollPeersForTesting()
    await pollPeersForTesting()
    eq(h.replies.map(r => r.text), ['done'], 'one answer')
    eq(openTaskCount(WORKER), 0, 'closed out')
  })

  await test('the task budget stops a runaway loop until the user writes', async () => {
    setOrchestrator()
    attachPeerSession(recorder(), { sessionId: ORCH, cwd: 'C:\\m', name: 'main', status: 'idle' }, false)
    await writeCard(cardFor(WORKER, 'api'))
    assert((await sendPeerTask('api', '1', options({ taskLimit: 2 }))).ok, 'first')
    assert((await sendPeerTask('api', '2', options({ taskLimit: 2 }))).ok, 'second')
    const third = await sendPeerTask('api', '3', options({ taskLimit: 2 }))
    assert(!third.ok && third.message.includes('peers.taskLimit'), third.message)
    resetTaskBudget()
    assert((await sendPeerTask('api', '4', options({ taskLimit: 2 }))).ok, 'after the user wrote')
  })

  await test('a session that closes mid-task is reported, not waited on', async () => {
    setOrchestrator()
    const h = recorder()
    attachPeerSession(h, { sessionId: ORCH, cwd: 'C:\\m', name: 'main', status: 'idle' }, false)
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' })
    await writeCard(cardFor(WORKER, 'api', { pid: child.pid! }))
    assert((await sendPeerTask('api', 'work', options())).ok, 'sent')
    child.kill()
    await waitForExit(child)
    await pollPeersForTesting()
    eq(h.replies.map(r => r.outcome), ['closed'], 'closed')
    eq(openTaskCount(WORKER), 0, 'no longer open')
  })

  await test('a non-orchestrator cannot send, and an orchestrator cannot take', async () => {
    attachPeerSession(recorder(), { sessionId: WORKER, cwd: 'C:\\a', name: 'api', status: 'idle' }, false)
    assert(!(await sendPeerTask('x', 'y', options())).ok, 'send refused')
    await resetPeersForTesting()
    setOrchestrator()
    attachPeerSession(recorder(), { sessionId: ORCH, cwd: 'C:\\m', name: 'main', status: 'idle' }, false)
    assert(setAccepting(true)?.includes('orchestrator'), 'take refused')
    eq((await listLiveCards()).length, 0, 'an orchestrator has no card')
  })

  await test('the footer badge follows the role, one snapshot until it changes', async () => {
    let told = 0
    const stop = subscribePeerRole(() => told++)
    eq(getPeerRole(), null, 'no part: no badge')
    attachPeerSession(recorder(), { sessionId: WORKER, cwd: 'C:\\a', name: 'api', status: 'idle' }, true)
    const worker = getPeerRole()
    eq(worker, { kind: 'worker', workingFor: null }, 'worker')
    assert(getPeerRole() === worker, 'the same object while nothing changes')
    setPeerWorkingFor('main')
    eq(getPeerRole(), { kind: 'worker', workingFor: 'main' }, 'whose task runs')
    setAccepting(false)
    eq(getPeerRole(), null, '/peers off: no badge')
    assert(told >= 3, `subscribers told of each change (${told})`)
    stop()
    await resetPeersForTesting()
    setOrchestrator()
    attachPeerSession(recorder(), { sessionId: ORCH, cwd: 'C:\\work\\main', name: 'main', status: 'idle' }, false)
    eq(getPeerRole(), { kind: 'orchestrator', openTasks: 0 }, 'orchestrator')
    await writeCard(cardFor(WORKER, 'api'))
    assert((await sendPeerTask('api', 'fix it', options())).ok, 'sent')
    eq(getPeerRole(), { kind: 'orchestrator', openTasks: 1 }, 'counts what it waits on')
  })

  console.log('taker')

  await test('nothing happens until the session opts in', async () => {
    const h = recorder()
    attachPeerSession(h, { sessionId: WORKER, cwd: 'C:\\a', name: 'api', status: 'idle' }, false)
    eq((await listLiveCards()).length, 0, 'no card')
    await postMessage(taskFor(WORKER))
    eq(readdirSync(peerInboxDir(WORKER)).length, 1, 'left unread')
  })

  await test('an accepted task is handed to the REPL; stale ones are refused', async () => {
    const h = recorder()
    attachPeerSession(h, { sessionId: WORKER, cwd: 'C:\\a', name: 'api', status: 'idle' }, true)
    await settlePeersForTesting()
    eq((await listLiveCards()).map(c => c.name), ['api'], 'card')
    await postMessage(taskFor(WORKER, { text: 'fresh' }))
    await postMessage(taskFor(WORKER, { text: 'old', sentAt: Date.now() - 20 * 60_000 }))
    await pollPeersForTesting()
    eq(h.tasks.map(t => t.text), ['fresh'], 'handed over')
    eq((await takeMessages(ORCH)).map(m => (m as PeerReply).outcome), ['expired'], 'stale answered')
  })

  await test('a session with checks off refuses a sender that has them on', async () => {
    const h = recorder()
    attachPeerSession(
      h,
      { sessionId: WORKER, cwd: 'C:\\a', name: 'api', status: 'idle', permissionMode: 'bypassPermissions' },
      true,
    )
    await postMessage(taskFor(WORKER))
    await postMessage(taskFor(WORKER, { from: { sessionId: ORCH, name: 'main', cwd: 'C:\\m', permissionMode: 'bypassPermissions' } }))
    await pollPeersForTesting()
    eq(h.tasks.length, 1, 'only the matching sender')
    eq((await takeMessages(ORCH)).map(m => (m as PeerReply).outcome), ['declined'], 'refusal answered')
  })

  await test('/peers off removes the card and declines what was already sent', async () => {
    const h = recorder()
    attachPeerSession(h, { sessionId: WORKER, cwd: 'C:\\a', name: 'api', status: 'idle' }, true)
    await postMessage(taskFor(WORKER))
    eq(setAccepting(false), null, 'off')
    await pollPeersForTesting()
    assert(!isAccepting(), 'not accepting')
    eq((await listLiveCards()).length, 0, 'card gone')
    eq(h.tasks.length, 0, 'not run')
    eq((await takeMessages(ORCH)).map(m => (m as PeerReply).outcome), ['declined'], 'told')
  })

  await test('a session switch moves the card and still reads the old inbox', async () => {
    const h = recorder()
    attachPeerSession(h, { sessionId: WORKER, cwd: 'C:\\a', name: 'api', status: 'idle' }, true)
    updatePeerSelf({ sessionId: OTHER })
    await settlePeersForTesting()
    eq((await listLiveCards()).map(c => c.sessionId), [OTHER], 'moved')
    await postMessage(taskFor(WORKER, { text: 'to the old id' }))
    await pollPeersForTesting()
    eq(h.tasks.map(t => t.text), ['to the old id'], 'still delivered')
  })

  await test('an answer goes to the sender, cut at its limit', async () => {
    attachPeerSession(recorder(), { sessionId: WORKER, cwd: 'C:\\a', name: 'api', status: 'idle' }, true)
    await sendReply(taskFor(WORKER, { replyLimit: 600 }), 'done', 'y'.repeat(900))
    const [reply] = (await takeMessages(ORCH)) as PeerReply[]
    assert(reply!.text.startsWith('y'.repeat(600) + '\n[Cut at 600'), 'cut')
    eq([reply!.from.name, reply!.outcome], ['api', 'done'], 'from the worker')
  })

  console.log('opening sessions')

  /** A window command that only records what it was asked to run. */
  function recordingCommand(file: string): string[] {
    return [
      process.execPath,
      '-e',
      "require('fs').writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)))",
      file,
      '{folder}',
      '{title}',
      '{tau}',
    ]
  }
  async function waitForFile(file: string): Promise<string[]> {
    for (let i = 0; i < 100 && !existsSync(file); i++) await new Promise(r => setTimeout(r, 50))
    return JSON.parse(readFileSync(file, 'utf8'))
  }
  function saveTranscript(sessionId: string, folder: string, title: string): void {
    const dir = join(process.env.CLAUDE_CONFIG_DIR!, 'projects', 'test-project')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, `${sessionId}.jsonl`),
      [
        JSON.stringify({ type: 'custom-title', customTitle: title, sessionId }),
        JSON.stringify({ type: 'user', cwd: folder, sessionId, timestamp: new Date().toISOString(), message: { role: 'user', content: 'fix auth' } }),
      ].join('\n') + '\n',
    )
  }
  function registerOpen(sessionId: string, pid: number, extra: Record<string, unknown> = {}): void {
    const dir = join(process.env.CLAUDE_CONFIG_DIR!, 'sessions')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${pid}.json`), JSON.stringify({ pid, sessionId, ...extra }))
  }
  const orchestrate = () => {
    setOrchestrator()
    const h = recorder()
    attachPeerSession(h, { sessionId: ORCH, cwd: 'C:\\work\\main', name: 'main', status: 'idle' }, false)
    return h
  }

  await test('a window command expands placeholders, {tau} into separate arguments', () => {
    const argv = expandOpenCommand(['term', '--dir={folder}', '-t', '{title}', '{tau}', 'sh -c {tauLine}'], {
      folder: '/w/api',
      title: 'api',
      tauArgs: ['--resume', 'abc'],
    }, 'linux')
    eq(argv.slice(0, 4), ['term', '--dir=/w/api', '-t', 'api'], 'placeholders')
    eq(argv.slice(4, argv.length - 1).slice(-2), ['--resume', 'abc'], 'tau args last')
    eq(argv[4], process.execPath, 'same runtime')
    assert(argv.at(-1)!.startsWith('sh -c ') && argv.at(-1)!.endsWith('--resume abc'), argv.at(-1)!)
  })

  await test('a command line quotes what needs it, per shell', () => {
    eq(peerCommandLine(['tau', '--resume', 'a b', "it's"], 'linux'), `tau --resume 'a b' 'it'\\''s'`, 'posix')
    eq(peerCommandLine(['C:\\Program Files\\node.exe', 'x'], 'win32'), '"C:\\Program Files\\node.exe" x', 'cmd')
  })

  await test('built-in window commands need no guessing', () => {
    const bin = mkdtempSync(join(tmpdir(), 'tau-peers-bin-'))
    try {
      eq(defaultOpenCommand('linux', { TMUX: '/tmp/tmux-1' })?.[0], 'tmux', 'inside tmux')
      eq(defaultOpenCommand('linux', {}), null, 'plain linux: none')
      eq(defaultOpenCommand('darwin', {}), null, 'plain macOS: none')
      eq(defaultOpenCommand('win32', { PATH: bin })?.[0], 'cmd.exe', 'windows without wt')
      eq(defaultOpenCommand('win32', { PATH: bin })?.[3], '', 'start gets a title Node quotes')
      // The usual wt.exe is an app alias that can't be stat'ed, like this dangling link.
      symlinkSync(join(bin, 'missing'), join(bin, 'wt.exe'), 'junction')
      eq(defaultOpenCommand('win32', { PATH: bin })?.[0], 'wt.exe', 'windows terminal')
    } finally {
      rmSync(bin, { recursive: true, force: true })
    }
  })

  await test('a session open in any window counts as open, a dead one does not', async () => {
    registerOpen('aaaa1111-0000-4000-8000-000000000000', process.pid)
    registerOpen('bbbb2222-0000-4000-8000-000000000000', 2_000_000_000)
    registerOpen('cccc3333-0000-4000-8000-000000000000', 2_000_000_001, { pidDomain: 'linux:elsewhere' })
    const open = await openSessionIds()
    assert(open.has('aaaa1111-0000-4000-8000-000000000000'), 'live')
    assert(!open.has('bbbb2222-0000-4000-8000-000000000000'), 'dead')
    assert(open.has('cccc3333-0000-4000-8000-000000000000'), "another host's: kept to be safe")
  })

  await test('closed sessions are listed, open ones are not', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'tau-peers-proj-'))
    try {
      saveTranscript('dddd4444-0000-4000-8000-000000000000', folder, 'auth work')
      saveTranscript('eeee5555-0000-4000-8000-000000000000', folder, 'open elsewhere')
      registerOpen('eeee5555-0000-4000-8000-000000000000', process.pid)
      const closed = await listClosedSessions()
      eq(closed.map(s => s.sessionId), ['dddd4444-0000-4000-8000-000000000000'], 'only the closed one')
      assert(describeClosedSession(closed[0]!).startsWith('closed · "auth work" · '), describeClosedSession(closed[0]!))
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })

  await test('OpenPeer starts a new session in a folder with the task waiting for it', async () => {
    orchestrate()
    const folder = mkdtempSync(join(tmpdir(), 'tau-peers-proj-'))
    const record = join(folder, 'argv.json')
    try {
      const result = await openPeerSession(
        { folder, name: 'web', message: 'build the page' },
        { ...options(), openCommand: recordingCommand(record) },
      )
      assert(result.ok && result.message.startsWith('Opening "web"'), result.message)
      const argv = await waitForFile(record)
      eq(argv.slice(0, 2), [folder, 'web'], 'folder and title')
      const id = argv[argv.indexOf('--session-id') + 1]!
      eq(argv.slice(argv.indexOf('-n'), argv.indexOf('-n') + 2), ['-n', 'web'], 'named')
      eq(argv.slice(-2), ['--peer-of', ORCH], 'takes tasks from its opener')
      const [task] = (await takeMessages(id)) as PeerTask[]
      eq([task!.text, task!.maxAgeMs], ['build the page', 6 * 60 * 60_000], 'task waiting, longer')
      eq(openTaskCount(id), 1, 'tracked')
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })

  await test('OpenPeer reopens a closed session by id prefix', async () => {
    orchestrate()
    const folder = mkdtempSync(join(tmpdir(), 'tau-peers-proj-'))
    const record = join(folder, 'argv.json')
    try {
      saveTranscript('ffff6666-0000-4000-8000-000000000000', folder, 'auth work')
      const result = await openPeerSession(
        { session: 'ffff6666', message: 'finish it' },
        { ...options(), openCommand: recordingCommand(record) },
      )
      assert(result.ok, result.message)
      const argv = await waitForFile(record)
      eq(argv.slice(0, 2), [folder, 'auth work'], 'its own folder and title')
      eq(argv.slice(-4), ['--resume', 'ffff6666-0000-4000-8000-000000000000', '--peer-of', ORCH], 'resumed')
      eq((await takeMessages('ffff6666-0000-4000-8000-000000000000')).length, 1, 'task waiting')
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })

  await test('OpenPeer never opens a second copy of an open session', async () => {
    orchestrate()
    const folder = mkdtempSync(join(tmpdir(), 'tau-peers-proj-'))
    try {
      const id = '99997777-0000-4000-8000-000000000000'
      saveTranscript(id, folder, 'busy one')
      registerOpen(id, process.pid)
      const blocked = await openPeerSession({ session: id, message: 'x' }, { ...options(), openCommand: ['nothing-here'] })
      assert(!blocked.ok && blocked.message.includes('already open'), blocked.message)
      await writeCard(cardFor(id, 'busy one'))
      const routed = await openPeerSession({ session: id, message: 'x' }, { ...options(), openCommand: ['nothing-here'] })
      assert(routed.ok && routed.message.startsWith('Sent to "busy one"'), routed.message)
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })

  await test('without a window command the user gets lines to run, and the task waits', async () => {
    orchestrate()
    const folder = mkdtempSync(join(tmpdir(), 'tau-peers-proj-'))
    try {
      const result = await openPeerSession(
        { folder, message: 'later' },
        { ...options(), openCommand: ['tau-peers-no-such-terminal'] },
      )
      assert(result.ok && result.message.includes('No terminal window could be opened'), result.message)
      const id = result.message.match(/--session-id ([0-9a-f-]+)/)?.[1]
      assert(id && result.message.includes(`tau --session-id ${id}`), result.message)
      eq((await takeMessages(id!)).length, 1, 'waiting')
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })

  await test('a session opened for an orchestrator takes tasks from it alone', async () => {
    acceptPeersFrom(ORCH)
    const h = recorder()
    attachPeerSession(h, { sessionId: WORKER, cwd: 'C:\\a', name: 'api', status: 'idle' }, false)
    await settlePeersForTesting()
    eq((await listLiveCards()).length, 1, 'card without /peers on')
    await postMessage(taskFor(WORKER, { text: 'from opener' }))
    await postMessage(taskFor(WORKER, { text: 'from another', from: { sessionId: OTHER, name: 'x', cwd: 'C:\\x' } }))
    await pollPeersForTesting()
    eq(h.tasks.map(t => t.text), ['from opener'], 'opener only')
    eq((await takeMessages(OTHER)).map(m => (m as PeerReply).outcome), ['declined'], 'the other told')
    eq(setAccepting(true), null, '/peers on')
    await postMessage(taskFor(WORKER, { text: 'now anyone', from: { sessionId: OTHER, name: 'x', cwd: 'C:\\x' } }))
    await pollPeersForTesting()
    eq(h.tasks.map(t => t.text), ['from opener', 'now anyone'], 'opened up')
  })

  await test('a task may wait longer when asked, a bad wait means the default', async () => {
    const h = recorder()
    attachPeerSession(h, { sessionId: WORKER, cwd: 'C:\\a', name: 'api', status: 'idle' }, true)
    const old = Date.now() - 20 * 60_000
    await postMessage(taskFor(WORKER, { text: 'kept', sentAt: old, maxAgeMs: 6 * 60 * 60_000 }))
    await postMessage(taskFor(WORKER, { text: 'stale', sentAt: old, maxAgeMs: 'x' as unknown as number }))
    await pollPeersForTesting()
    eq(h.tasks.map(t => t.text), ['kept'], 'long wait honoured')
    eq((await takeMessages(ORCH)).map(m => (m as PeerReply).outcome), ['expired'], 'bad wait expired')
  })

  await test('an opened session is watched once it starts, and reported if it closes', async () => {
    const h = orchestrate()
    const folder = mkdtempSync(join(tmpdir(), 'tau-peers-proj-'))
    try {
      const result = await openPeerSession({ folder, name: 'web', message: 'go' }, { ...options(), openCommand: ['tau-peers-no-such-terminal'] })
      const id = result.message.match(/--session-id ([0-9a-f-]+)/)![1]!
      await pollPeersForTesting()
      eq(h.replies.length, 0, 'not started yet: no false alarm')
      const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' })
      await writeCard(cardFor(id, 'web', { pid: child.pid! }))
      await pollPeersForTesting()
      child.kill()
      await waitForExit(child)
      await pollPeersForTesting()
      eq(h.replies.map(r => r.outcome), ['closed'], 'closed after it started')
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

void main()
