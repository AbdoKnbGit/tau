import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hasInstructionsInsideToolOutput } from './wire-checks.mjs'

// List labels oldest first; a later rerun replaces the same provider/model/case.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../tmp/mcp-instr/out')
// Explicitly exclude obsolete targets (for example a model ID that routed to
// the wrong provider). Keep their names in the output; raw evidence is retained.
const args = process.argv.slice(2)
const excludedTargets = args.filter(arg => arg.startsWith('--exclude-target='))
  .map(arg => arg.slice('--exclude-target='.length))
const rows = new Map()
for (const label of args.filter(arg => !arg.startsWith('--exclude-target='))) {
  if (!/^[a-zA-Z0-9_-]+$/.test(label)) throw new Error('Invalid run label')
  for (const row of JSON.parse(readFileSync(join(root, label, 'summary.json'), 'utf8'))) {
    if (excludedTargets.includes(`${row.provider}=${row.model}`)) continue
    rows.set(`${row.provider}:${row.model}:${row.scenario}`, { ...row, label })
  }
}
if (!rows.size) throw new Error('Pass one or more completed run labels')
let requests = 0
const nestedInstructionRequests = []
const wrongRouteRequests = []
const results = [...rows.values()].map(row => {
  const log = join(root, row.label, row.provider, row.scenario, 'requests.jsonl')
  for (const line of readFileSync(log, 'utf8').split('\n').filter(Boolean)) {
    const event = JSON.parse(line)
    if (event.kind !== 'req' || !event.main || !event.body) continue
    requests++
    if (row.provider === 'antigravity' && (event.format !== 'antigravity' || event.body.userAgent !== 'antigravity')) {
      wrongRouteRequests.push({ label: row.label, provider: row.provider, scenario: row.scenario, id: event.id })
    }
    if (hasInstructionsInsideToolOutput(event.body)) {
      nestedInstructionRequests.push({ label: row.label, provider: row.provider, scenario: row.scenario, id: event.id })
    }
  }
  return {
    provider: row.provider, model: row.model, scenario: row.scenario,
    label: row.label, verdict: row.verdict,
    failures: row.checks.filter(check => check.pass !== true),
    ...(row.cache && { cache: row.cache }),
  }
})
const failed = results.filter(row => row.verdict !== 'OK' || row.failures.length)
console.log(JSON.stringify({
  cases: results.length, passed: results.length - failed.length,
  providers: new Set(results.map(row => row.provider)).size,
  requests, nestedInstructionRequests, wrongRouteRequests, excludedTargets, results,
}, null, 2))
process.exitCode = failed.length || nestedInstructionRequests.length || wrongRouteRequests.length ? 1 : 0
