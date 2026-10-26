import type { AggregatedHookResult } from '../../hooks.js'
import type { ModRecord } from './runtime.js'

const fields: Record<string, string[]> = {
  SessionStart: [
    'additionalContext',
    'sessionTitle',
    'initialUserMessage',
    'watchPaths',
    'reloadSkills',
  ],
  PostToolUse: [
    'additionalContext',
    'updatedToolOutput',
    'updatedMCPToolOutput',
  ],
  PostToolUseFailure: ['additionalContext'],
  Stop: ['additionalContext'],
  SubagentStop: ['additionalContext'],
}
export function validateModResult(
  event: string,
  result: unknown,
): asserts result is ModRecord {
  if (!result || typeof result !== 'object' || Array.isArray(result))
    throw new Error('Mod must return an event result object')
  const value = result as ModRecord
  if (event.startsWith('classic.')) {
    const allowed = new Set([
      'block',
      'preventContinuation',
      'stopReason',
      ...(fields[event.slice(8)] ?? []),
    ])
    for (const [key, item] of Object.entries(value)) {
      if (!allowed.has(key))
        throw new Error(`Unsupported ${event} result field: ${key}`)
      if (['additionalContext', 'watchPaths'].includes(key)) {
        if (
          !Array.isArray(item) ||
          item.some((text) => typeof text !== 'string')
        )
          throw new Error(`${key} must be an array of strings`)
      } else if (['preventContinuation', 'reloadSkills'].includes(key)) {
        if (item !== true) throw new Error(`${key} must be true`)
      } else if (
        !['updatedToolOutput', 'updatedMCPToolOutput'].includes(key) &&
        typeof item !== 'string'
      )
        throw new Error(`${key} must be a string`)
    }
  } else if (event === 'command.run') {
    if (value.text !== undefined && typeof value.text !== 'string')
      throw new Error('Command text must be a string')
    if (
      value.context !== undefined &&
      (!Array.isArray(value.context) ||
        value.context.some((text: unknown) => typeof text !== 'string'))
    )
      throw new Error('Command context must be an array of strings')
  } else if (event === 'tool.call') {
    if (value.deny !== undefined) {
      if (
        typeof value.deny !== 'string' ||
        !value.deny.trim() ||
        value.result !== undefined ||
        value.context !== undefined ||
        value.ref !== undefined ||
        value.text !== undefined ||
        value.isError !== undefined
      )
        throw new Error(
          'tool.call deny must be a nonempty reason without a result',
        )
    } else {
      if (!Object.hasOwn(value, 'result'))
        throw new Error('tool.call must return { result } or { deny }')
      if (
        value.context !== undefined &&
        (!Array.isArray(value.context) ||
          value.context.some(
            (text: unknown) => typeof text !== 'string' || !text.trim(),
          ))
      )
        throw new Error('Tool context must contain nonempty strings')
      if (value.isError !== undefined && value.isError !== true)
        throw new Error('tool.call isError must be true when set')
      if (value.text !== undefined && typeof value.text !== 'string')
        throw new Error('Tool text must be a string')
      if (
        value.ref !== undefined &&
        (!Number.isSafeInteger(value.ref) || value.ref < 1)
      )
        throw new Error('Invalid tool result reference')
    }
  } else if (event === 'tool.check') {
    if (!['allow', 'ask', 'deny'].includes(value.decision))
      throw new Error('tool.check decision must be allow, ask, or deny')
    for (const key of [
      'reason',
      'rule',
      'hook',
      'setting',
      'decider',
      'ceiling',
    ])
      if (value[key] !== undefined && typeof value[key] !== 'string')
        throw new Error(`tool.check ${key} must be a string`)
  } else if (event === 'session.start' && typeof value.cwd !== 'string')
    throw new Error('session.start must return { cwd }')
  else if (event === 'session.end' && typeof value.sessionId !== 'string')
    throw new Error('session.end must return { sessionId }')
}

export function toClassicResult(results: AggregatedHookResult[]): ModRecord {
  const value: ModRecord = {}
  for (const result of results) {
    if (result.blockingError)
      value.block = [value.block, result.blockingError.blockingError]
        .filter(Boolean)
        .join('\n')
    if (result.additionalContexts)
      value.additionalContext = [
        ...(value.additionalContext ?? []),
        ...result.additionalContexts,
      ]
    if (result.watchPaths)
      value.watchPaths = [...(value.watchPaths ?? []), ...result.watchPaths]
    for (const key of ['preventContinuation', 'reloadSkills'] as const)
      if (result[key]) value[key] = true
    for (const key of [
      'stopReason',
      'sessionTitle',
      'initialUserMessage',
      'updatedToolOutput',
      'updatedMCPToolOutput',
    ] as const) {
      if (result[key] !== undefined) value[key] = result[key]
    }
  }
  return value
}

export function fromClassicResult(value: ModRecord): AggregatedHookResult {
  const { block, additionalContext, ...rest } = value
  return {
    ...rest,
    ...(block !== undefined
      ? { blockingError: { blockingError: block, command: 'mod' } }
      : {}),
    ...(additionalContext ? { additionalContexts: additionalContext } : {}),
  }
}
