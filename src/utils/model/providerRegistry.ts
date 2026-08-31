/**
 * Dependency-free provider registry.
 *
 * Keep provider enumeration here so routing/cache contract tests can cover
 * every provider without importing configuration, credentials, or SDK state.
 */
export const API_PROVIDERS = [
  'firstParty', 'bedrock', 'vertex', 'foundry',
  'openai', 'gemini', 'antigravity',
  'openrouter', 'agentrouter', 'modelrouter', 'vercel', 'requesty', 'opencode', 'opencodego', 'commandcode', 'lxd', 'mimo', 'fireworks', 'cloudflare', 'groq', 'mistral', 'nim', 'deepseek', 'glm', 'moonshot', 'minimax', 'ollama', 'lmstudio',
  'cline', 'clinepass', 'copilot', 'cursor', 'iflow', 'kilocode', 'kiro',
] as const

export type APIProvider = (typeof API_PROVIDERS)[number]

/** Providers available for user selection in /provider and /login. */
export const SELECTABLE_PROVIDERS: readonly APIProvider[] = [
  'firstParty', 'openai', 'commandcode', 'antigravity', 'openrouter', 'agentrouter', 'vercel', 'requesty', 'opencode', 'opencodego', 'lxd', 'mimo', 'fireworks', 'cloudflare', 'mistral', 'nim', 'deepseek', 'glm', 'moonshot', 'minimax', 'ollama', 'lmstudio',
  'cline', 'clinepass', 'copilot', 'kilocode', 'kiro',
]
