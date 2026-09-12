import type { AssistantMessage } from 'src/types/message.js'
import type { ToolUseContext } from '../../Tool.js'
import { resolveEffectiveAPIProvider } from '../../services/api/providerRouting.js'
import { resolveAppliedEffort } from '../effort.js'
import { getRuntimeMainLoopModel } from '../model/model.js'
import { getAPIProvider, isAnthropicNativeProvider } from '../model/providers.js'
import { doesMostRecentAssistantMessageExceed200k } from '../tokens.js'
import type { AgentModelEnv } from './agentEnv.js'

/**
 * Provider, model and effort for a shell command the model asked for through
 * its own Bash/PowerShell tool call, resolved when the command starts and for
 * the agent that made the call (a subagent reports its own).
 *
 * Returns undefined, leaving those variables unset, for every other command:
 * `!`/`!!` commands the user typed, skill and slash-command `!` blocks, and
 * `tau mcp serve` calls from another program. Only the tool runner passes the
 * assistant message that holds this call's tool_use block.
 */
export function getAgentModelEnv(
  context: ToolUseContext,
  parentMessage: AssistantMessage | undefined,
): AgentModelEnv | undefined {
  if (!isModelToolCall(context.toolUseId, parentMessage)) {
    return undefined
  }
  try {
    const appState = context.getAppState()
    const permissionMode = appState.toolPermissionContext.mode
    // The inputs query.ts gives getRuntimeMainLoopModel for the request that
    // produced this call (tools run with messages === messagesForQuery).
    const model = getRuntimeMainLoopModel({
      permissionMode,
      mainLoopModel: context.options.mainLoopModel,
      exceeds200kTokens:
        permissionMode === 'plan' &&
        doesMostRecentAssistantMessageExceed200k(context.messages),
    })
    if (!model) {
      return undefined
    }
    // The provider the request goes to: getAPIProvider() returns a subagent's
    // own provider inside its run, and the model-based routing is the same
    // call client.ts and claude.ts make.
    const provider = resolveEffectiveAPIProvider(getAPIProvider(), model)
    // Only Anthropic-native requests carry one effort level Tau can name;
    // other providers keep their own per-model reasoning settings.
    const effort = isAnthropicNativeProvider(provider)
      ? resolveAppliedEffort(model, appState.effortValue)
      : undefined
    return effort === undefined
      ? { provider, model }
      : { provider, model, effort: String(effort) }
  } catch {
    // Attribution must never break the command itself.
    return undefined
  }
}

function isModelToolCall(
  toolUseId: string | undefined,
  parentMessage: AssistantMessage | undefined,
): boolean {
  if (!toolUseId) {
    return false
  }
  const content: unknown = parentMessage?.message?.content
  return (
    Array.isArray(content) &&
    content.some(
      block =>
        typeof block === 'object' &&
        block !== null &&
        (block as { type?: unknown }).type === 'tool_use' &&
        (block as { id?: unknown }).id === toolUseId,
    )
  )
}
