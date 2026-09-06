export const AGENT_TOOL_NAME = 'Agent'
// Legacy wire name for backward compat (permission rules, hooks, resumed sessions)
export const LEGACY_AGENT_TOOL_NAME = 'Task'
export const VERIFICATION_AGENT_TYPE = 'verification'

// One-shot agent types are derived from the definitions that declare
// `oneShot` — see getOneShotAgentTypes() in ./builtInAgents.ts. Keeping a
// literal name list here meant the exemption silently stopped matching when
// a build stripped those agents.
