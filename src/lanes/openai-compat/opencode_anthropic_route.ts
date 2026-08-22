// Rows served through OpenCode's Anthropic-format `/messages` route rather
// than the OpenAI-compatible lane. Keep this in a leaf module so routing and
// lazy-tool capability checks cannot drift.
export const OPENCODE_ANTHROPIC_ROUTE_MODELS: ReadonlySet<string> = new Set([
  'qwen3.5-plus',
  'qwen3.6-plus',
  'qwen3.7-plus',
  'qwen3.7-max',
])

export function isOpenCodeAnthropicRouteModel(model: string): boolean {
  const normalized = model.trim().toLowerCase()
  return OPENCODE_ANTHROPIC_ROUTE_MODELS.has(
    normalized.endsWith('-free') ? normalized.slice(0, -5) : normalized,
  )
}
