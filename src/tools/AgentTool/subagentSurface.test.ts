/**
 * Subagent surface tests, asserted against the shipped bundle.
 *
 * These pin the wiring that makes a spawned subagent addressable end to end:
 * the model can name a spawn, the continuation tool is in the pool, its prompt
 * documents the address the model will be handed, per-spawn provider routing
 * is validated rather than gated off, and the result trailer that advertises
 * all of it is skipped only for agents that genuinely never get continued.
 *
 * Every one of these was broken at once, because each was gated on a team-mode
 * or agent-swarms flag that is off by default while the Agent tool advertised
 * the capability unconditionally.
 *
 * Asserting on dist/tau.mjs rather than importing the modules is deliberate:
 * these modules reach into the app graph, which does not resolve under bun's
 * direct runner (build.mjs shims files such as entrypoints/sdk/runtimeTypes.js
 * that do not exist on disk). The bundle is what actually ships, so checking it
 * also proves the change survived bundling and dead-code elimination.
 *
 * Run: node build.mjs && bun run src/tools/AgentTool/subagentSurface.test.ts
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const BUNDLE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'dist',
  'tau.mjs',
)

let passed = 0
let failed = 0

function test(name: string, fn: (bundle: string) => void): void {
  try {
    fn(bundleText)
    passed++
    console.log(`  ok  ${name}`)
  } catch (e: any) {
    failed++
    console.log(`  FAIL ${name}: ${e?.message ?? String(e)}`)
  }
}

function present(bundle: string, needle: string, hint: string): void {
  if (!bundle.includes(needle)) throw new Error(`${hint} — missing: ${needle}`)
}

function absent(bundle: string, needle: string, hint: string): void {
  if (bundle.includes(needle)) throw new Error(`${hint} — still present: ${needle}`)
}

let bundleText: string
try {
  bundleText = readFileSync(BUNDLE, 'utf8')
} catch {
  console.error(`Bundle not found at ${BUNDLE}. Run: node build.mjs`)
  process.exit(1)
}

console.log('subagent surface (bundle)')

test('the continuation tool is no longer gated on the swarms flag', bundle => {
  absent(
    bundle,
    'isEnabled() {\n      return isAgentSwarmsEnabled();',
    'SendMessage must not be gated: it is the only follow-up path to a spawned agent',
  )
})

test('SendMessage documents continuing an agent you spawned', bundle => {
  present(bundle, 'Continue an agent you spawned', 'the subagent section must ship')
  present(
    bundle,
    'the id or name of an agent you spawned',
    'the `to` param must describe subagent addressing',
  )
})

test('the teammate-only recipient description is gone', bundle => {
  absent(
    bundle,
    'Recipient: teammate name, or',
    'the old description advertised only teammates, which are off by default',
  )
})

test('`name` reaches the wire — it is not filtered as a swarm field', bundle => {
  present(
    bundle,
    '["team_name", "mode"]',
    'the Agent tool swarm filter must keep team_name/mode but release name',
  )
  absent(
    bundle,
    '["name", "team_name", "mode"]',
    'stripping `name` left the model unable to address its own spawns',
  )
})

test('one-shot agent types are derived from the definitions', bundle => {
  present(bundle, 'oneShot: true', 'built-in one-shot agents must declare themselves')
  present(bundle, 'oneShot) types.add(', 'the derivation must ship')
  absent(
    bundle,
    'Set(["Explore","Plan"])',
    'the hardcoded set named agents this build strips, so it never matched',
  )
})

test('per-spawn provider routing is validated, not gated on team mode', bundle => {
  present(
    bundle,
    'isAPIProvider(rawProviderParam)',
    'an unknown provider name must be dropped up front',
  )
  absent(
    bundle,
    'teamModeOn ? rawProviderParam',
    'provider/model_id must work without /team-mode being on',
  )
  absent(
    bundle,
    'Pick one of the supported APIProvider names',
    'the downstream throw is unreachable once the param is narrowed at entry',
  )
})

test('the Agent tool prompt carries the parallel-work contract', bundle => {
  present(bundle, 'Settle shared contracts up front', 'contract rule must ship')
  present(bundle, 'Give each agent disjoint files', 'file-ownership rule must ship')
  present(bundle, '**Target**', 'the Target/Change/Acceptance shape must ship')
  present(bundle, '**Acceptance**', 'the Target/Change/Acceptance shape must ship')
})

// Markdown backticks are re-escaped inside the bundle's own template
// literals, so assertions here stay clear of them on purpose.
test('the Agent tool prompt tells the model to name and reuse its spawns', bundle => {
  present(bundle, 'Pass a short', 'naming guidance must ship')
  present(bundle, '(one or two words, lowercase)', 'naming guidance must ship')
  present(
    bundle,
    'Prefer continuing an existing agent over spawning a fresh one',
    'continuation-over-respawn guidance must ship',
  )
})

// Enabling SendMessage by default widened the blast radius of an existing
// silent failure: with no team, handleMessage writes a mailbox file nothing
// drains and still answers "Message sent". An unresolved recipient must fail.
test('an unresolvable recipient fails loudly instead of reporting success', bundle => {
  present(
    bundle,
    'and its transcript could not be resumed',
    'a name that resolves to no agent must return success:false',
  )
  present(
    bundle,
    'No agent has been spawned in this session yet',
    'the failure must say what is addressable',
  )
})

// The claim logic is unit-tested in utils/agentFileClaims.test.ts. What that
// cannot see is whether the write path still calls it — so assert the hook
// survives into the artifact, at the one choke point Edit, Write, NotebookEdit
// and Bash-applied writes all funnel through.
test('every mutating write path enforces subagent file ownership', bundle => {
  present(
    bundle,
    'enforceAgentFileClaim',
    'the claim check must ship',
  )
  // writeTextContent's body, with the check as its first statement.
  const hooked =
    /function writeTextContent\([^)]*\)\s*\{\s*(?:\/\/[^\n]*\n\s*)*enforceAgentFileClaim\(/.test(
      bundle,
    )
  if (!hooked) {
    throw new Error(
      'writeTextContent must call enforceAgentFileClaim before writing — ' +
        'without it two concurrent subagents can clobber one file through Bash, ' +
        'which carries no staleness guard',
    )
  }
})

test('the mutating tools check ownership before doing any work', bundle => {
  // The write-path hook alone is too late: Edit rejects on its own
  // "String to replace not found" first, which names no agent. Each mutating
  // tool must consult the registry in validateInput, before it reads the file.
  const checks = bundle.split('checkAgentFileClaim(').length - 1
  if (checks < 3) {
    throw new Error(
      `expected Edit, Write and NotebookEdit to each check ownership in ` +
        `validateInput; found ${checks} call sites`,
    )
  }
  present(bundle, 'agentFileConflictMessage', 'both paths must share one wording')
})

test('agent lifecycle releases file claims', bundle => {
  present(
    bundle,
    'endAgentFileScope',
    'claims must be released, or a finished agent holds paths hostage',
  )
  present(
    bundle,
    'beginAgentFileScope',
    'agents must register, or the concurrent set is never populated',
  )
})

test('the repair cache fails safe on colliding schemas', bundle => {
  present(bundle, 'ambiguous', 'the conflict guard must ship')
  present(
    bundle,
    'shapeOf(',
    'the top-level shape digest drives conflict detection',
  )
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
