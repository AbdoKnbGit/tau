/**
 * Environment variables that tell a shell command which Tau session started
 * it and, for the model's own Bash/PowerShell tool calls, which provider,
 * model and effort the calling agent uses. Scripts, git hooks and CLIs can
 * read them. They live only in the spawned process's environment, never in a
 * prompt, so they cost no tokens and cannot affect prompt caching.
 *
 * Import-free on purpose, so it can be tested directly with `bun run`.
 */

/** The variable names this module owns. */
export const AGENT_ENV = {
  /** Generic cross-agent marker: which agent started the process. */
  agent: 'AI_AGENT',
  sessionId: 'TAU_SESSION_ID',
  provider: 'TAU_PROVIDER',
  model: 'TAU_MODEL',
  effort: 'TAU_EFFORT',
} as const

/** Value of AI_AGENT (pi uses `AI_AGENT=pi` the same way). */
export const AI_AGENT_NAME = 'tau'

/** Provider, model and effort of the agent whose tool call runs a command. */
export type AgentModelEnv = {
  provider: string
  model: string
  /** Set only when Tau knows the effort level the request actually uses. */
  effort?: string
}

const OWNED_NAMES: ReadonlySet<string> = new Set(Object.values(AGENT_ENV))

/**
 * Returns a copy of `env` carrying this session's agent variables.
 *
 * Every inherited value of an owned name is dropped first, so a Tau started
 * from another Tau's shell never reports its parent's session or model. On
 * Windows, names are case-insensitive (PowerShell reads an inherited
 * `tau_model` as `$env:TAU_MODEL`), so copies in any letter case are dropped
 * there. Without `agentModel`, TAU_PROVIDER, TAU_MODEL and TAU_EFFORT stay
 * unset.
 */
export function withAgentEnv(
  env: NodeJS.ProcessEnv,
  values: { sessionId: string; agentModel?: AgentModelEnv },
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { ...env }
  const ignoreCase = platform === 'win32'
  for (const name of Object.keys(result)) {
    if (OWNED_NAMES.has(ignoreCase ? name.toUpperCase() : name)) {
      delete result[name]
    }
  }
  result[AGENT_ENV.agent] = AI_AGENT_NAME
  if (values.sessionId) {
    result[AGENT_ENV.sessionId] = values.sessionId
  }
  const agentModel = values.agentModel
  if (agentModel?.provider && agentModel.model) {
    result[AGENT_ENV.provider] = agentModel.provider
    result[AGENT_ENV.model] = agentModel.model
    if (agentModel.effort) {
      result[AGENT_ENV.effort] = agentModel.effort
    }
  }
  return result
}
