/**
 * /lane — native-lane diagnostic + kill switch.
 *
 * Usage:
 *   /lane             → alias for /lane status
 *   /lane status      → list every lane with health + registered models
 *   /lane why <model> → show which lane would handle <model> and why
 *   /lane disable <name> → mark a lane unhealthy; dispatcher falls through
 *   /lane enable <name>  → re-enable a previously disabled lane
 *
 * No user will type this in normal use — auto-routing already does the
 * right thing. Kept around for: debugging weird dispatch, probing a new
 * model's routing at install time, temporarily steering around a
 * degraded lane without restarting Tau.
 */

import type { LocalCommandCall } from '../../types/command.js'
import {
  getAllLanes,
  getLane,
  resolveRoute,
  getLaneStatus,
} from '../../lanes/dispatcher.js'
import type { Lane } from '../../lanes/types.js'

export const call: LocalCommandCall = async (args) => {
  const trimmed = args.trim()
  const [sub, ...rest] = trimmed.split(/\s+/)
  const arg = rest.join(' ')

  switch (sub) {
    case '':
    case 'status':
      return { type: 'text', value: renderStatus() }
    case 'why':
      return { type: 'text', value: renderWhy(arg) }
    case 'disable':
      return { type: 'text', value: renderToggle(arg, false) }
    case 'enable':
      return { type: 'text', value: renderToggle(arg, true) }
    default:
      return {
        type: 'text',
        value: [
          `Unknown /lane subcommand: "${sub}"`,
          '',
          'Available:',
          '  /lane status         list every lane with health + supported models',
          '  /lane why <model>    show which lane would handle this model',
          '  /lane disable <name> mark a lane unhealthy (legacy path takes over)',
          '  /lane enable  <name> re-enable a previously disabled lane',
        ].join('\n'),
      }
  }
}

// ─── status ─────────────────────────────────────────────────────

function renderStatus(): string {
  const entries = getLaneStatus()
  if (entries.length === 0) {
    return 'No lanes registered. initLanes() has not run yet — send any model request to trigger lazy init.'
  }

  const lines: string[] = []
  lines.push('Native lanes registered:')
  lines.push('')

  const pad = (s: string, n: number): string => s + ' '.repeat(Math.max(0, n - s.length))

  lines.push(pad('LANE', 18) + pad('HEALTHY', 10) + pad('SMALL/FAST MODEL', 32) + 'MODELS')
  lines.push(pad('----', 18) + pad('-------', 10) + pad('-----------------', 32) + '------')

  for (const entry of entries) {
    const lane = getLane(entry.name)
    if (!lane) continue
    const health = entry.healthy ? 'yes' : 'no'
    const small = lane.smallFastModel?.() ?? '-'
    const sample = sampleSupportedModels(lane)
    lines.push(
      pad(entry.name, 18)
      + pad(health, 10)
      + pad(String(small), 32)
      + sample,
    )
  }

  lines.push('')
  lines.push('Routing: model id → lane. Users pick a model via /models; the dispatcher')
  lines.push('auto-routes to its lane. Opt out of a specific lane:')
  lines.push('  CLAUDEX_NATIVE_LANES=-gemini   (env var, before launch)')
  lines.push('  /lane disable gemini            (interactive, this session only)')
  return lines.join('\n')
}

function sampleSupportedModels(lane: Lane): string {
  // The Lane interface has supportsModel(id) — we don't enumerate, so
  // sample a few canonical ids per lane for the status table.
  const CANDIDATES: Record<string, string[]> = {
    claude: ['claude-sonnet-4-6', 'claude-opus-4-8', 'claude-haiku-4-5'],
    gemini: ['gemini-3.1-pro-high', 'gemini-2.5-flash', 'gemma-2-9b'],
    codex: ['gpt-5-codex', 'o3-mini', 'codex-turbo'],
    qwen: ['qwen3-coder-plus', 'qwen-max', 'coder-model'],
    'openai-compat': ['deepseek-reasoner', 'llama-3.3-70b', 'mistral-large'],
  }
  const hints = CANDIDATES[lane.name] ?? []
  return hints.filter(m => lane.supportsModel(m)).join(', ')
}

// ─── why <model> ────────────────────────────────────────────────

function renderWhy(model: string): string {
  if (!model) return 'Usage: /lane why <model-id>'
  const route = resolveRoute(model)
  if (route.type === 'native') {
    const lane = route.lane
    const small = lane.smallFastModel?.() ?? '-'
    return [
      `Model: ${model}`,
      `Lane:  ${lane.name}  (${lane.displayName})`,
      `Healthy: ${lane.isHealthy() ? 'yes' : 'no'}`,
      `Small/fast model for this lane: ${small}`,
      '',
      `Why this lane: ${lane.name}.supportsModel("${model}") returned true.`,
      'Dispatcher matches each registered lane in order; first match wins.',
    ].join('\n')
  }
  return [
    `Model: ${model}`,
    `Lane:  (no native lane)`,
    `Reason: ${route.reason}`,
    route.lane ? `Closest lane: ${route.lane}` : '',
    '',
    'This model falls through to the legacy provider path. Anthropic / Tau',
    'models always take this path — that IS the native Anthropic Messages API',
    'path (see services/api/claude.ts).',
  ].filter(Boolean).join('\n')
}

// ─── disable / enable ──────────────────────────────────────────

function renderToggle(name: string, enable: boolean): string {
  if (!name) return `Usage: /lane ${enable ? 'enable' : 'disable'} <lane-name>`
  const lane = getLane(name)
  if (!lane) {
    const known = getAllLanes().map(l => l.name).join(', ') || '(none)'
    return `No lane named "${name}". Known lanes: ${known}`
  }
  const setter = (lane as { setHealthy?: (b: boolean) => void }).setHealthy
  if (typeof setter !== 'function') {
    return `Lane "${name}" does not expose setHealthy(). Rebuild Tau or report this.`
  }
  setter.call(lane, enable)
  return enable
    ? `Re-enabled lane "${name}". Next request will route through the native path.`
    : `Disabled lane "${name}". Requests fall through to the legacy provider path until re-enabled.`
}
