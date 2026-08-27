/**
 * Which providers have a /usage reporter.
 *
 * Deliberately dependency-free. providerUsage.ts pulls in every provider
 * client and cannot be imported by anything that needs only this list - see
 * providerUsage.test.ts, which imports the parser alone for that reason.
 *
 * REPORTERS_BY_PROVIDER is typed against ProviderWithUsageReporter, so adding
 * a reporter without listing it here (or listing one that does not exist) is a
 * type error rather than a silent disagreement between the two.
 */

export const PROVIDERS_WITH_USAGE_REPORTERS = [
  'firstParty',
  'openai',
  'antigravity',
  'openrouter',
  'vercel',
  'requesty',
  'fireworks',
  'deepseek',
  'mistral',
  'glm',
  'lxd',
  'mimo',
  'moonshot',
  'minimax',
  'ollama',
  'cline',
  'copilot',
  'kilocode',
  'kiro',
] as const

export type ProviderWithUsageReporter =
  (typeof PROVIDERS_WITH_USAGE_REPORTERS)[number]

const COVERED: ReadonlySet<string> = new Set(PROVIDERS_WITH_USAGE_REPORTERS)

export function hasProviderUsageReporter(provider: string): boolean {
  return COVERED.has(provider)
}
