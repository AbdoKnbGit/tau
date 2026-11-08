import type { AggregatedHookResult, HookOutsideReplResult } from '../../hooks.js'
import type { ModRecord } from './runtime.js'
import { MOD_API_EVENTS } from './contracts.js'

/**
 * The event-specific fields of each settings hook event's result, as Claude
 * Code's ClassicResultFields names them; `block`, `preventContinuation` and
 * `stopReason` are every event's. `classic.PreToolUse` has its own shape.
 */
const fields: Record<string, string[]> = {
  UserPromptSubmit: ['additionalContext', 'sessionTitle', 'suppressOriginalPrompt'],
  UserPromptExpansion: ['additionalContext', 'suppressOriginalPrompt'],
  SessionStart: [
    'additionalContext',
    'sessionTitle',
    'initialUserMessage',
    'watchPaths',
    'reloadSkills',
  ],
  Setup: ['additionalContext'],
  PreModelSwitch: ['permissionDecision', 'permissionDecisionReason'],
  PostModelSwitch: ['additionalContext'],
  SubagentStart: ['additionalContext'],
  PostToolUse: [
    'additionalContext',
    'updatedToolOutput',
    'updatedMCPToolOutput',
  ],
  PostToolUseFailure: ['additionalContext'],
  PostToolBatch: ['additionalContext'],
  Stop: ['additionalContext'],
  SubagentStop: ['additionalContext'],
  PermissionDenied: ['retry'],
  PermissionRequest: ['decision'],
  MessageDisplay: ['displayContent'],
  WorktreeCreate: ['worktreePath'],
}
const PRE_TOOL_FIELDS = ['allow', 'ask', 'deny', 'updatedInput', 'additionalContext']

const isRecord = (value: unknown): value is ModRecord =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const strings = (value: unknown) =>
  Array.isArray(value) && value.every(text => typeof text === 'string')

function validateClassicResult(event: string, value: ModRecord): void {
  const name = event.slice('classic.'.length)
  if (name === 'PreToolUse') {
    for (const key of Object.keys(value))
      if (!PRE_TOOL_FIELDS.includes(key))
        throw new Error(`Unsupported ${event} result field: ${key}`)
    const decisions = ['allow', 'ask', 'deny'].filter(key => value[key] !== undefined)
    if (decisions.length > 1)
      throw new Error(`${event} returns one of allow, ask or deny`)
    if (value.allow !== undefined && value.allow !== true)
      throw new Error('allow must be true')
    for (const key of ['ask', 'deny'])
      if (value[key] !== undefined && (typeof value[key] !== 'string' || !value[key].trim()))
        throw new Error(`${key} must be a nonempty reason`)
    if (value.updatedInput !== undefined && !isRecord(value.updatedInput))
      throw new Error('updatedInput must be an object')
    if (value.additionalContext !== undefined && !strings(value.additionalContext))
      throw new Error('additionalContext must be an array of strings')
    return
  }
  const allowed = new Set([
    'block',
    'preventContinuation',
    'stopReason',
    ...(fields[name] ?? []),
  ])
  for (const [key, item] of Object.entries(value)) {
    if (!allowed.has(key))
      throw new Error(`Unsupported ${event} result field: ${key}`)
    if (key === 'additionalContext' || key === 'watchPaths') {
      if (!strings(item)) throw new Error(`${key} must be an array of strings`)
    } else if (['preventContinuation', 'reloadSkills', 'suppressOriginalPrompt', 'retry'].includes(key)) {
      if (item !== true) throw new Error(`${key} must be true`)
    } else if (key === 'permissionDecision') {
      if (!['allow', 'deny', 'ask'].includes(item))
        throw new Error('permissionDecision must be allow, deny or ask')
    } else if (key === 'decision') {
      if (!isRecord(item) || !['allow', 'deny'].includes(item.behavior))
        throw new Error('decision must be { behavior: "allow" | "deny" }')
    } else if (key !== 'updatedToolOutput' && key !== 'updatedMCPToolOutput' && typeof item !== 'string')
      throw new Error(`${key} must be a string`)
  }
}
export function validateModResult(
  event: string,
  result: unknown,
): asserts result is ModRecord {
  // A drawing is a tree, a string or a fragment; its dispatch validates it
  // against the surface's element table.
  if (event === 'ui.render') return
  if (!result || typeof result !== 'object' || Array.isArray(result))
    throw new Error('Mod must return an event result object')
  if (event === 'ui.press' || event === 'ui.input' || event === 'ui.select') {
    const answer = result as ModRecord
    if (typeof answer.element !== 'string' || (answer.value !== undefined && typeof answer.value !== 'string'))
      throw new Error(`${event} must return { element }`)
    return
  }
  if (event === 'ui.close') return
  if (event === 'ui.message' || event === 'ui.fault') {
    const answer = result as ModRecord
    const keys = Object.keys(answer)
    if (event === 'ui.fault' ? keys.length !== 0 : keys.some(key => key !== 'props'))
      throw new Error(event === 'ui.fault' ? 'ui.fault must return {}' : 'ui.message must return {} or { props }')
    return
  }
  if (event === 'ui.focus' || event === 'ui.scroll') {
    const answer = result as ModRecord
    if (Object.keys(answer).some(key => key !== 'deny') || (answer.deny !== undefined && typeof answer.deny !== 'string'))
      throw new Error(`${event} must return {} or { deny: reason }`)
    return
  }
  const value = result as ModRecord
  if (event === 'plugin.register') {
    const refused = Object.hasOwn(value, 'refuse')
    if (refused ? typeof value.refuse !== 'string' || !value.refuse.trim() || Object.keys(value).length !== 1
      : value.allow !== true || Object.keys(value).length !== 1)
      throw new Error('plugin.register must return { allow: true } or { refuse: reason }')
    if (refused) value.refuse = value.refuse.slice(0, 4096)
    return
  }
  // A model response as the hooks above read it.
  if (event === 'turn.step') {
    if (typeof value.answer !== 'string' || !Array.isArray(value.toolUses) ||
        value.toolUses.some((use: unknown) => !use || typeof use !== 'object' || typeof (use as ModRecord).name !== 'string') ||
        (value.stopReason !== null && value.stopReason !== undefined && typeof value.stopReason !== 'string') ||
        (value.usage !== null && value.usage !== undefined && (typeof value.usage !== 'object' || Array.isArray(value.usage))))
      throw new Error('turn.step must return { turnId, index, answer, toolUses, stopReason, usage }')
    return
  }
  // The sections of a system prompt: ids unique, every shared one first.
  if (event === 'prompt.compose') {
    const sections = value.sections
    if (!Array.isArray(sections) || Object.keys(value).some(key => key !== 'sections'))
      throw new Error('prompt.compose must return { sections }')
    if (sections.length > 256) throw new Error('prompt.compose returns at most 256 sections')
    const ids = new Set<string>()
    let total = 0, sessionSeen = false
    for (const section of sections) {
      if (!section || typeof section !== 'object' || typeof section.id !== 'string' || !section.id.trim() || typeof section.text !== 'string')
        throw new Error('a prompt.compose section is { id, text, scope }')
      if (section.scope === undefined) section.scope = 'session'
      if (section.scope !== 'shared' && section.scope !== 'session')
        throw new Error("a prompt.compose section's scope is 'shared' or 'session'")
      if (ids.has(section.id)) throw new Error(`prompt.compose section id ${JSON.stringify(section.id)} appears twice`)
      ids.add(section.id)
      if (section.scope === 'session') sessionSeen = true
      else if (sessionSeen) throw new Error('prompt.compose put a shared section after a session one')
      total += section.text.length
    }
    if (total > 2_000_000) throw new Error('prompt.compose sections hold at most 2,000,000 characters')
    return
  }
  // The worker hands `$` across as a table of noun descriptors.
  if (event === 'engine.create') {
    for (const [noun, entry] of Object.entries(value))
      if (!/^[a-z][A-Za-z0-9]*$/.test(noun) || !entry || typeof entry !== 'object' ||
          !['core', 'lent'].includes((entry as ModRecord).kind))
        throw new Error(`engine.create returned an invalid noun ${JSON.stringify(noun)}`)
    return
  }
  if (MOD_API_EVENTS.has(event)) {
    const denied = Object.hasOwn(value, 'deny')
    if (Object.keys(value).length !== 1 || (denied ? typeof value.deny !== 'string' || !value.deny.trim() : !Object.hasOwn(value, 'value')))
      throw new Error(`${event} must return { value } or { deny: reason }`)
    // A hook answering a $.state call answers it as the host would.
    const answer = value.value as ModRecord | undefined
    const version = (read: ModRecord | undefined) =>
      !!read && typeof read === 'object' && Number.isSafeInteger(read.version) && read.version >= 0
    if (!denied && event === 'state.get' && !version(answer))
      throw new Error('state.get must answer { value: { value, version } }')
    if (!denied && event === 'state.set' && (!version(answer) || typeof answer!.isSet !== 'boolean'))
      throw new Error('state.set must answer { value: { isSet, version } }')
  } else if (event.startsWith('classic.')) {
    validateClassicResult(event, value)
  } else if (event === 'prompt.submit') {
    const allowed = new Set(['text', 'context', 'drop', 'origin'])
    for (const key of Object.keys(value))
      if (!allowed.has(key)) throw new Error(`Unsupported prompt.submit result field: ${key}`)
    if (value.drop !== undefined) {
      if (typeof value.drop !== 'string' || !value.drop.trim() || value.text !== undefined || value.context !== undefined || value.origin !== undefined)
        throw new Error('prompt.submit drop must be a nonempty reason without text or context')
      value.drop = value.drop.slice(0, 4096)
    } else {
      if (typeof value.text !== 'string') throw new Error('prompt.submit must return { text } or { drop }')
      if (value.context !== undefined && (!Array.isArray(value.context) || value.context.some((text: unknown) => typeof text !== 'string')))
        throw new Error('Prompt context must be an array of strings')
    }
  } else if (event === 'skill.prompt') {
    if (typeof value.text !== 'string' || Object.keys(value).some(key => key !== 'text'))
      throw new Error('skill.prompt must return { text }')
  } else if (event === 'turn.start') {
    if (typeof value.turnId !== 'string' || Object.keys(value).some(key => key !== 'turnId'))
      throw new Error('turn.start must return { turnId }')
  } else if (event === 'turn.complete') {
    if (typeof value.text !== 'string' || Object.keys(value).some(key => key !== 'text'))
      throw new Error('turn.complete must return { text }')
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
  } else if (event === 'agent.spawn') {
    if (value.deny !== undefined) {
      if (typeof value.deny !== 'string' || !value.deny.trim() || Object.keys(value).some(key => key !== 'deny'))
        throw new Error('agent.spawn deny must be a nonempty reason')
    } else if (typeof value.model !== 'string' || Object.keys(value).some(key => key !== 'model' && key !== 'agentId'))
      throw new Error('agent.spawn must return { model } or { deny: reason }')
  } else if (event === 'session.start' && typeof value.cwd !== 'string')
    throw new Error('session.start must return { cwd }')
  else if (event === 'session.end' && typeof value.sessionId !== 'string')
    throw new Error('session.end must return { sessionId }')
}

/** `e` of `classic.<Event>`: the settings hook's stdin JSON, except that
 * `classic.PreToolUse` takes the tool call's envelope, `{ tool, ...input }`. */
export function classicModInput(event: string, hookInput: ModRecord): ModRecord {
  if (event !== 'PreToolUse') return hookInput
  return {
    ...(isRecord(hookInput.tool_input) ? hookInput.tool_input : {}),
    tool: hookInput.tool_name,
    tool_use_id: hookInput.tool_use_id,
  }
}

/** What the settings hooks beneath read after the mods rewrote `e`. The
 * session's identity fields and the tool a PreToolUse is for stay the host's. */
export function classicCoreInput(event: string, rewritten: ModRecord, original: ModRecord): ModRecord {
  const identity = {
    hook_event_name: original.hook_event_name,
    session_id: original.session_id,
    cwd: original.cwd,
    transcript_path: original.transcript_path,
  }
  if (event !== 'PreToolUse') return { ...rewritten, ...identity }
  const { tool: _tool, tool_use_id: _id, ...input } = rewritten
  return { ...original, ...identity, tool_input: input }
}

const joinBlock = (left: string | undefined, right: string) =>
  [left, right].filter(Boolean).join('\n')

function preToolUseResult(results: AggregatedHookResult[]): ModRecord {
  const value: ModRecord = {}
  let decision: 'allow' | 'ask' | 'deny' | undefined, reason: string | undefined
  for (const result of results) {
    const behavior = result.blockingError ? 'deny' : result.permissionBehavior
    if (behavior === 'allow' || behavior === 'ask' || behavior === 'deny') {
      // Claude Code settles several hooks' answers by deny, then ask, then allow.
      const rank = { allow: 1, ask: 2, deny: 3 }
      if (!decision || rank[behavior] > rank[decision]) {
        decision = behavior
        reason = result.blockingError?.blockingError ?? result.hookPermissionDecisionReason
      }
    }
    if (result.updatedInput) value.updatedInput = result.updatedInput
    if (result.additionalContexts?.length)
      value.additionalContext = [...(value.additionalContext ?? []), ...result.additionalContexts]
  }
  if (decision === 'allow') value.allow = true
  else if (decision) value[decision] = reason?.trim() || `PreToolUse hook ${decision === 'ask' ? 'asked about' : 'denied'} this call`
  return value
}

/** The settings hooks' answers, folded the way Claude Code folds them into the
 * event's result (last write wins, contexts concatenate). */
export function toClassicResult(event: string, results: AggregatedHookResult[]): ModRecord {
  if (event === 'PreToolUse') return preToolUseResult(results)
  const value: ModRecord = {}
  for (const result of results) {
    if (result.blockingError)
      value.block = joinBlock(value.block, result.blockingError.blockingError)
    if (result.additionalContexts?.length)
      value.additionalContext = [...(value.additionalContext ?? []), ...result.additionalContexts]
    if (result.watchPaths?.length)
      value.watchPaths = [...(value.watchPaths ?? []), ...result.watchPaths]
    for (const key of ['preventContinuation', 'reloadSkills', 'suppressOriginalPrompt', 'retry'] as const)
      if (result[key]) value[key] = true
    for (const key of ['stopReason', 'sessionTitle', 'initialUserMessage', 'updatedToolOutput', 'updatedMCPToolOutput', 'displayContent'] as const)
      if (result[key] !== undefined) value[key] = result[key]
    if (result.permissionRequestResult) value.decision = result.permissionRequestResult
    if (result.permissionBehavior === 'allow' || result.permissionBehavior === 'ask' || result.permissionBehavior === 'deny') {
      value.permissionDecision = result.permissionBehavior
      if (result.hookPermissionDecisionReason !== undefined)
        value.permissionDecisionReason = result.hookPermissionDecisionReason
    }
  }
  const allowed = new Set(['block', 'preventContinuation', 'stopReason', ...(fields[event] ?? [])])
  return Object.fromEntries(Object.entries(value).filter(([key]) => allowed.has(key)))
}

/** What no mod sees but the host still needs from the settings hooks that ran
 * (a deferral, classifier notes): kept whatever the mods answered. */
const HOST_FIELDS = ['deferTool', 'classifierContext', 'hookSource', 'elicitationResponse', 'elicitationResultResponse'] as const

/** A mod's answer as one aggregated hook result for the host's consumers. */
export function fromClassicResult(event: string, value: ModRecord, ran: AggregatedHookResult[] = []): AggregatedHookResult {
  const host: ModRecord = {}
  for (const result of ran)
    for (const key of HOST_FIELDS) if (result[key] !== undefined) host[key] = result[key]
  if (event === 'PreToolUse') {
    // A PreToolUse result has no block or stop of its own; keep the ones the
    // settings hooks beneath reported, whatever the mods decided.
    for (const result of ran) {
      if (result.preventContinuation) host.preventContinuation = true
      if (result.stopReason !== undefined) host.stopReason = result.stopReason
    }
    const behavior = value.allow ? 'allow' : value.ask !== undefined ? 'ask' : value.deny !== undefined ? 'deny' : undefined
    return {
      ...host,
      ...(behavior
        ? { permissionBehavior: behavior, hookSource: 'mod', ...(behavior !== 'allow' ? { hookPermissionDecisionReason: value[behavior] } : {}) }
        : {}),
      ...(value.updatedInput ? { updatedInput: value.updatedInput } : {}),
      ...(value.additionalContext?.length ? { additionalContexts: value.additionalContext } : {}),
    } as AggregatedHookResult
  }
  const {
    block, additionalContext, decision, permissionDecision, permissionDecisionReason,
    worktreePath: _path, ...rest
  } = value
  return {
    ...host,
    ...rest,
    ...(block !== undefined ? { blockingError: { blockingError: block, command: 'mod' } } : {}),
    ...(additionalContext?.length ? { additionalContexts: additionalContext } : {}),
    ...(decision ? { permissionRequestResult: decision } : {}),
    ...(permissionDecision
      ? { permissionBehavior: permissionDecision, ...(permissionDecisionReason !== undefined ? { hookPermissionDecisionReason: permissionDecisionReason } : {}) }
      : {}),
  } as AggregatedHookResult
}

/** Whether a managed settings hook's answer ends the chain above every mod. */
export function endsClassicChain(result: AggregatedHookResult): boolean {
  return !!result.blockingError || !!result.preventContinuation || result.permissionBehavior === 'deny'
}

/** The answers of hooks run outside a turn (notifications, compaction, config
 * and file changes, worktrees) as the event's result. */
export function outsideToClassic(event: string, results: HookOutsideReplResult[]): ModRecord {
  const value: ModRecord = {}
  for (const result of results)
    if (result.blocked)
      value.block = joinBlock(value.block, result.blockingReason || result.output.trim() || `${event} blocked by hook`)
  if (event === 'WorktreeCreate') {
    const created = results.find(result => result.succeeded && result.output.trim())
    if (created) value.worktreePath = created.output.trim()
  }
  return value
}

/** A mod's answer to an outside-the-turn event as the results its consumer
 * reads: the hooks' own outputs, with the blocks and path the mods decided. */
export function outsideFromClassic(event: string, value: ModRecord, ran: HookOutsideReplResult[]): HookOutsideReplResult[] {
  const results = ran.map(result => ({ ...result, blocked: false, blockingReason: undefined }))
  if (event === 'WorktreeCreate') {
    // The mods' path is the worktree; none leaves creation to git.
    const others = results.filter(result => !(result.succeeded && result.output.trim()))
    return value.worktreePath
      ? [{ command: 'mod', succeeded: true, output: value.worktreePath, blocked: false }, ...others]
      : others
  }
  if (value.block !== undefined)
    results.push({ command: 'mod', succeeded: false, output: value.block, blocked: true, blockingReason: value.block })
  return results
}
