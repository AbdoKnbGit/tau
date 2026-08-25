/**
 * Which providers receive the `x-anthropic-billing-header` system prompt block.
 * Kept dependency-free so it can be unit-tested without pulling in the
 * bootstrap / config import chain (same reason as systemBoundaryProviders.ts).
 */

/**
 * Providers whose request terminates at an Anthropic-operated API that actually
 * parses this header: billing attribution, the `cch` attestation placeholder,
 * and the fingerprint the 1P / Bedrock / Vertex / Azure backends validate (see
 * utils/fingerprint.ts — "do not change this method without careful
 * coordination with 1P and 3P APIs").
 *
 * Everywhere else the header is inert text that the model tokenizes and nothing
 * reads — and it is a prompt-cache hazard, not merely dead weight. It is
 * emitted as system prompt block 0, the head of the cached prefix, AHEAD of
 * SYSTEM_PROMPT_DYNAMIC_BOUNDARY, so the stable/volatile split the Gemini,
 * Codex, OpenRouter and DeepSeek lanes perform cannot protect it. Two of its
 * fields move on their own:
 *
 *   • `cc_version=<version>.<fingerprint>` — the fingerprint hashes characters
 *     of the FIRST user message, which /resume and --continue re-render because
 *     the attachments merged into it were never persisted. Live-measured
 *     through a recording proxy: one --continue moved it 1ee → 699 and
 *     cold-started 44,123 chars of an otherwise byte-identical prefix.
 *   • `cc_workload=cron` — turn-scoped (utils/workloadContext.ts, set by
 *     hooks/useScheduledTasks.ts). A scheduled turn firing between interactive
 *     turns flips the header mid-session, cold-starting the whole prompt on
 *     that turn and again when it flips back.
 */
export const ATTRIBUTION_HEADER_PROVIDERS: ReadonlySet<string> = new Set([
  'firstParty',
  'bedrock',
  'vertex',
  'foundry',
])

export function providerReadsAttributionHeader(provider: string): boolean {
  return ATTRIBUTION_HEADER_PROVIDERS.has(provider)
}
