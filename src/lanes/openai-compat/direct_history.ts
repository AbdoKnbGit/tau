import type { ProviderContentBlock, ProviderMessage } from '../../services/api/providers/base_provider.js'
import type { OpenAIChatMessage } from './transformers/shared_types.js'
import { freezeSessionVolatileText, volatileFreezeKey } from '../shared/volatile_freeze.js'

export function buildDirectHistory(
  messages: ProviderMessage[],
  system: string,
  provider: 'glm' | 'moonshot' | 'minimax',
  model: string,
  sessionId: string | undefined,
  convert: (messages: ProviderMessage[]) => OpenAIChatMessage[],
): OpenAIChatMessage[] {
  const boundary = '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__'
  const marker = system.indexOf(boundary)
  const dynamic = marker >= 0 ? marker : system.search(/# Session-specific guidance\b|<env>|# Environment\b|# currentDate\n|# gitStatus\b/)
  const split = dynamic >= 0
  const stable = split ? system.slice(0, dynamic).trimEnd() : system
  const volatile = split ? system.slice(dynamic + (marker >= 0 ? boundary.length : 0)).trimStart() : ''
  const frozen = freezeSessionVolatileText(volatileFreezeKey(provider, model, sessionId, messages), volatile).trim()
  return [
    ...(stable ? [{ role: 'system' as const, content: stable }] : []),
    ...(frozen ? [{ role: 'user' as const, content: `<dynamic_context>\n${frozen}\n</dynamic_context>` }] : []),
    ...convertDirectHistory(messages, convert),
  ]
}

/** Keep complete assistant turns, including final-answer reasoning. The IR can
 * split one upstream assistant message into separate thinking/text/tool messages.
 * Reassemble those before replay, without changing DeepSeek's existing converter.
 */
export function convertDirectHistory(
  messages: ProviderMessage[],
  convert: (messages: ProviderMessage[]) => OpenAIChatMessage[],
): OpenAIChatMessage[] {
  const out: OpenAIChatMessage[] = []
  let assistant: ProviderContentBlock[] = []
  function flush(): void {
    if (!assistant.length) return
    const reasoning = assistant.filter(b => b.type === 'thinking').map(b => b.thinking ?? '').join('')
    const converted = convert([{ role: 'assistant', content: assistant }])
    for (const msg of converted) {
      if (msg.role === 'assistant' && reasoning) msg.reasoning_content = reasoning
    }
    out.push(...converted)
    assistant = []
  }
  for (const msg of messages) {
    if (msg.role === 'assistant') {
      assistant.push(...(typeof msg.content === 'string' ? [{ type: 'text' as const, text: msg.content }] : msg.content))
      // A tool call ends this upstream assistant message even if a subsequent
      // IR assistant message contains a separate tool call.
      if (assistant.some(b => b.type === 'tool_use')) flush()
    } else {
      flush()
      out.push(...convert([msg]))
    }
  }
  flush()
  return out
}
