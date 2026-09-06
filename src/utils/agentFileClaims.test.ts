/**
 * Subagent file-write ownership.
 *
 * These pin the two things that make the mechanism safe to put in the write
 * path: it must never engage outside a genuine multi-agent race, and it must
 * never strand a path behind an agent that is gone.
 *
 * Run: bun run src/utils/agentFileClaims.test.ts
 */

import { runWithAgentContext } from './agentContext.js'
import {
  _orphanAgentForTest,
  _ownerLabelForTest,
  _resetAgentFileClaimsForTest,
  beginAgentFileScope,
  checkAgentFileClaim,
  endAgentFileScope,
  enforceAgentFileClaim,
} from './agentFileClaims.js'

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    _resetAgentFileClaimsForTest()
    fn()
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

/** Run `fn` as if it were subagent `id`'s async execution chain. */
function asAgent(id: string, fn: () => void): void {
  runWithAgentContext(
    { agentId: id, agentType: 'subagent', invocationEmitted: false },
    fn,
  )
}

function throws(fn: () => void): Error | undefined {
  try {
    fn()
    return undefined
  } catch (e: any) {
    return e
  }
}

const FILE = process.platform === 'win32' ? 'C:\\repo\\src\\app.ts' : '/repo/src/app.ts'
const OTHER = process.platform === 'win32' ? 'C:\\repo\\src\\other.ts' : '/repo/src/other.ts'

console.log('agent file claims')

test('the main session is never blocked and never claims', () => {
  beginAgentFileScope('a', 'alpha')
  beginAgentFileScope('b', 'bravo')
  // No agent context = main session.
  enforceAgentFileClaim(FILE)
  assert(_ownerLabelForTest(FILE) === undefined, 'main must not take ownership')
})

test('a lone subagent never engages the map', () => {
  beginAgentFileScope('a', 'alpha')
  asAgent('a', () => enforceAgentFileClaim(FILE))
  assert(
    _ownerLabelForTest(FILE) === undefined,
    'with one agent running there is no race to guard against',
  )
})

test('the first of two concurrent subagents takes ownership', () => {
  beginAgentFileScope('a', 'alpha')
  beginAgentFileScope('b', 'bravo')
  asAgent('a', () => enforceAgentFileClaim(FILE))
  assert(_ownerLabelForTest(FILE) === 'alpha', 'alpha should own the path')
})

test('a second subagent is refused, and told who owns it', () => {
  beginAgentFileScope('a', 'alpha')
  beginAgentFileScope('b', 'bravo')
  asAgent('a', () => enforceAgentFileClaim(FILE))
  const err = throws(() => asAgent('b', () => enforceAgentFileClaim(FILE)))
  assert(err !== undefined, 'the second writer must be refused')
  assert(err!.message.includes('alpha'), 'the refusal must name the owner')
  assert(err!.message.includes(FILE), 'the refusal must name the file')
})

test('the owner may keep writing its own file', () => {
  beginAgentFileScope('a', 'alpha')
  beginAgentFileScope('b', 'bravo')
  asAgent('a', () => enforceAgentFileClaim(FILE))
  assert(
    throws(() => asAgent('a', () => enforceAgentFileClaim(FILE))) === undefined,
    'an agent must not be blocked by its own claim',
  )
})

test('disjoint files never conflict', () => {
  beginAgentFileScope('a', 'alpha')
  beginAgentFileScope('b', 'bravo')
  asAgent('a', () => enforceAgentFileClaim(FILE))
  assert(
    throws(() => asAgent('b', () => enforceAgentFileClaim(OTHER))) === undefined,
    'this is the whole point: parallel work on disjoint files stays parallel',
  )
})

test('claims are released when the owner finishes', () => {
  beginAgentFileScope('a', 'alpha')
  beginAgentFileScope('b', 'bravo')
  asAgent('a', () => enforceAgentFileClaim(FILE))
  endAgentFileScope('a')
  beginAgentFileScope('c', 'charlie')
  assert(
    throws(() => asAgent('b', () => enforceAgentFileClaim(FILE))) === undefined,
    'a finished agent must not hold a path hostage',
  )
})

test('a claim whose owner vanished is taken over, not stranded', () => {
  beginAgentFileScope('a', 'alpha')
  beginAgentFileScope('b', 'bravo')
  asAgent('a', () => enforceAgentFileClaim(FILE))
  // Simulate a run that ended without its cleanup finally.
  _orphanAgentForTest('a')
  beginAgentFileScope('c', 'charlie')
  assert(
    throws(() => asAgent('b', () => enforceAgentFileClaim(FILE))) === undefined,
    'a dead owner must never block a live agent',
  )
  assert(_ownerLabelForTest(FILE) === 'bravo', 'the live agent takes over')
})

test('an unregistered agent id is not part of the concurrent set', () => {
  beginAgentFileScope('a', 'alpha')
  beginAgentFileScope('b', 'bravo')
  asAgent('a', () => enforceAgentFileClaim(FILE))
  assert(
    throws(() => asAgent('ghost', () => enforceAgentFileClaim(FILE))) === undefined,
    'an agent with no scope open is not racing anyone',
  )
})

if (process.platform === 'win32') {
  test('windows paths collide case-insensitively', () => {
    beginAgentFileScope('a', 'alpha')
    beginAgentFileScope('b', 'bravo')
    asAgent('a', () => enforceAgentFileClaim('C:\\repo\\Src\\App.ts'))
    assert(
      throws(() => asAgent('b', () => enforceAgentFileClaim('C:\\repo\\src\\app.ts'))) !== undefined,
      'NTFS treats these as one file, so the claim must too',
    )
  })
}

test('releasing an agent drops only its own claims', () => {
  beginAgentFileScope('a', 'alpha')
  beginAgentFileScope('b', 'bravo')
  asAgent('a', () => enforceAgentFileClaim(FILE))
  asAgent('b', () => enforceAgentFileClaim(OTHER))
  endAgentFileScope('a')
  assert(_ownerLabelForTest(FILE) === undefined, "alpha's claim is gone")
  assert(_ownerLabelForTest(OTHER) === 'bravo', "bravo's claim survives")
})

// checkAgentFileClaim is what the mutating tools call in validateInput, before
// they read the file or match old_string. Without it the write-path backstop is
// the first thing to fire — and by then Edit has already rejected with "String
// to replace not found", which names no agent and invites the loser to retry
// against the winner's content.
test('checkAgentFileClaim names the owner without taking ownership', () => {
  beginAgentFileScope('a', 'alpha')
  beginAgentFileScope('b', 'bravo')
  asAgent('a', () => enforceAgentFileClaim(FILE))

  let seen: string | undefined
  asAgent('b', () => {
    seen = checkAgentFileClaim(FILE)
  })
  assert(seen === 'alpha', `expected alpha, got ${seen}`)
  assert(_ownerLabelForTest(FILE) === 'alpha', 'a check must not steal ownership')
})

test('checkAgentFileClaim is silent for the owner, main session, and lone agents', () => {
  beginAgentFileScope('a', 'alpha')
  beginAgentFileScope('b', 'bravo')
  asAgent('a', () => enforceAgentFileClaim(FILE))

  let own: string | undefined = 'x'
  asAgent('a', () => {
    own = checkAgentFileClaim(FILE)
  })
  assert(own === undefined, 'the owner is never blocked by its own claim')
  assert(checkAgentFileClaim(FILE) === undefined, 'the main session is never blocked')

  endAgentFileScope('b')
  let lone: string | undefined = 'x'
  asAgent('a', () => {
    lone = checkAgentFileClaim(FILE)
  })
  assert(lone === undefined, 'with one agent left there is no race')
})

test('checkAgentFileClaim never claims on an unowned path', () => {
  beginAgentFileScope('a', 'alpha')
  beginAgentFileScope('b', 'bravo')
  asAgent('b', () => checkAgentFileClaim(OTHER))
  assert(
    _ownerLabelForTest(OTHER) === undefined,
    'a validation that never reaches a write must leave no claim behind',
  )
})

// The wiring — that writeTextContent actually calls into this module — is
// asserted against the built bundle in tools/AgentTool/subagentSurface.test.ts,
// because importing utils/file.js here pulls in the app graph that does not
// resolve under bun's direct runner.

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)

