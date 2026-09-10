/**
 * GitHub Copilot transformer.
 *
 * Copilot exposes an OpenAI-compatible chat completions endpoint at
 * https://api.githubcopilot.com/chat/completions. The wire format is
 * canonical OpenAI Chat Completions; the quirks are auth (the bearer is
 * the Copilot internal token, NOT the GitHub OAuth access token — see
 * oauth_services.ts::completeCopilotOAuth) and a handful of editor-shaped
 * headers the gateway uses to gate requests.
 *
 * Reference: reference/9router-master/open-sse/executors/github.js.
 */

import type { HeaderContext, Transformer, TransformContext } from './base.js'
import type { OpenAIChatMessage, OpenAIChatRequest } from './shared_types.js'
import { isCopilotModelAllowedForCurrentPlan } from '../../../utils/model/copilotAccount.js'

// Headers below mirror the reference executor exactly. The chat gateway
// gates non-VSCode UAs hard, so don't tweak these unless GitHub bumps
// the editor-version expected on api.githubcopilot.com.
const COPILOT_INTEGRATION_ID = 'vscode-chat'
const COPILOT_VSCODE_VERSION = '1.110.0'
const COPILOT_CHAT_VERSION = '0.38.0'
const COPILOT_USER_AGENT = `GitHubCopilotChat/${COPILOT_CHAT_VERSION}`
const COPILOT_API_VERSION = '2025-04-01'
const COPILOT_INTERNAL_ROUTER_PREFIX = 'accounts/msft/routers/'
const COPILOT_SUPPORTED_MODELS = new Set<string>([
  'gpt-4.1',
  'gpt-5-mini',
  'gpt-5.2',
  'gpt-5.2-codex',
  'gpt-5.3-codex',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.5',
  'claude-haiku-4.5',
  'claude-sonnet-4',
  'claude-sonnet-4.5',
  'claude-sonnet-4.6',
  'claude-opus-4.5',
  'claude-opus-4.6',
  'claude-opus-4.7',
])

const COPILOT_RETIRED_MODEL_PATTERNS = [
  /^claude-opus-4\.1$/i,
  /^claude-opus-4$/i,
  /^claude-sonnet-3\.5$/i,
  /^claude-sonnet-3\.7(?:-thinking)?$/i,
  /^gpt-5$/i,
  /^gpt-5-codex$/i,
  /^gpt-5\.1(?:-codex(?:-mini|-max)?)?$/i,
  /^o1-mini$/i,
  /^o3(?:-mini)?$/i,
  /^o4-mini$/i,
]

const COPILOT_NAME_OVERRIDES: Record<string, string> = {
  'claude-haiku-4.5': 'Claude Haiku 4.5',
  'claude-opus-4.5': 'Claude Opus 4.5',
  'claude-opus-4.6': 'Claude Opus 4.6',
  'claude-opus-4.7': 'Claude Opus 4.7',
  'claude-sonnet-4': 'Claude Sonnet 4',
  'claude-sonnet-4.5': 'Claude Sonnet 4.5',
  'claude-sonnet-4.6': 'Claude Sonnet 4.6',
  'gpt-4.1': 'GPT-4.1',
  'gpt-5-mini': 'GPT-5 mini',
  'gpt-5.2': 'GPT-5.2',
  'gpt-5.2-codex': 'GPT-5.2-Codex',
  'gpt-5.3-codex': 'GPT-5.3-Codex',
  'gpt-5.4': 'GPT-5.4',
  'gpt-5.4-mini': 'GPT-5.4 mini',
}

function _requestId(): string {
  // crypto.randomUUID exists on Node 16+; fall back for older runtimes.
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  return c?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function _requiresMaxCompletionTokens(model: string): boolean {
  // gpt-5*, o1*, o3*, o4* reject `max_tokens`; they want max_completion_tokens.
  return /gpt-5|o[134]-/i.test(model)
}

function _supportsTemperature(model: string): boolean {
  // gpt-5.4 (and any future variant matching the pattern) rejects temperature.
  return !/gpt-5\.4/i.test(model)
}

function _isCopilotSnapshotModel(model: string): boolean {
  return /-\d{4}-\d{2}-\d{2}$/i.test(model) || /-\d{4}$/i.test(model)
}

function _isRetiredCopilotModel(model: string): boolean {
  return COPILOT_RETIRED_MODEL_PATTERNS.some(pattern => pattern.test(model))
}

function _isChatCapableCopilotModel(model: string): boolean {
  const m = model.toLowerCase()
  if (m.startsWith(COPILOT_INTERNAL_ROUTER_PREFIX)) return false
  if (m.startsWith('text-embedding-')) return false
  if (m.startsWith('whisper-') || m.startsWith('tts-') || m.startsWith('omni-moderation-')) return false
  if (_isCopilotSnapshotModel(m)) return false
  if (_isRetiredCopilotModel(m)) return false
  return COPILOT_SUPPORTED_MODELS.has(m)
}

function _isCurrentPlanEligibleCopilotModel(model: string): boolean {
  return isCopilotModelAllowedForCurrentPlan(model)
}

type PendingToolCalls = {
  assistantIndex: number
  pendingIds: Set<string>
  answeredIds: Set<string>
}

function _finalizePendingToolCalls(messages: OpenAIChatMessage[], pending: PendingToolCalls): void {
  const assistant = messages[pending.assistantIndex]
  if (!assistant?.tool_calls?.length) return

  const seen = new Set<string>()
  const keptToolCalls = assistant.tool_calls.filter(call => {
    if (!pending.answeredIds.has(call.id) || seen.has(call.id)) return false
    seen.add(call.id)
    return true
  })

  if (keptToolCalls.length > 0) {
    assistant.tool_calls = keptToolCalls
  } else {
    delete assistant.tool_calls
    if (assistant.content == null) assistant.content = ''
  }
}

function _dedupeToolCalls(message: OpenAIChatMessage): OpenAIChatMessage {
  if (!message.tool_calls?.length) return message

  const seen = new Set<string>()
  const toolCalls = message.tool_calls.filter(call => {
    if (!call.id || seen.has(call.id)) return false
    seen.add(call.id)
    return true
  })

  if (toolCalls.length > 0) {
    return { ...message, tool_calls: toolCalls }
  }

  const next = { ...message }
  delete next.tool_calls
  if (next.content == null) next.content = ''
  return next
}

// Copilot uses OpenAI's strict adjacency rule: assistant tool_calls must be
// immediately followed by tool messages for every id. Interrupted or compacted
// histories can replay unresolved tool calls, so trim only the invalid tail.
function _sanitizeToolCallAdjacency(messages: OpenAIChatMessage[]): OpenAIChatMessage[] {
  const out: OpenAIChatMessage[] = []
  let pending: PendingToolCalls | null = null

  for (const message of messages) {
    if (message.role === 'tool') {
      const toolCallId = message.tool_call_id
      if (pending && toolCallId && pending.pendingIds.has(toolCallId)) {
        out.push(message.content == null ? { ...message, content: '' } : message)
        pending.pendingIds.delete(toolCallId)
        pending.answeredIds.add(toolCallId)
        if (pending.pendingIds.size === 0) pending = null
      }
      continue
    }

    if (pending) {
      _finalizePendingToolCalls(out, pending)
      pending = null
    }

    if (message.role === 'assistant' && message.tool_calls?.length) {
      const assistant = _dedupeToolCalls(message)
      out.push(assistant)

      if (assistant.tool_calls?.length) {
        pending = {
          assistantIndex: out.length - 1,
          pendingIds: new Set(assistant.tool_calls.map(call => call.id)),
          answeredIds: new Set<string>(),
        }
      }
      continue
    }

    out.push(message)
  }

  if (pending) _finalizePendingToolCalls(out, pending)
  return out
}

function _copilotDisplayName(id: string): string {
  const lowered = id.toLowerCase()
  const override = COPILOT_NAME_OVERRIDES[lowered]
  if (override) return override
  return id
}

export const copilotTransformer: Transformer = {
  id: 'copilot',
  displayName: 'GitHub Copilot',
  defaultBaseUrl: 'https://api.githubcopilot.com',

  supportsStrictMode: () => false,

  clampMaxTokens(requested: number): number {
    return requested
  },

  buildHeaders(_apiKey: string, ctx?: HeaderContext): Record<string, string> {
    const headers: Record<string, string> = {
      'copilot-integration-id': COPILOT_INTEGRATION_ID,
      'editor-version': `vscode/${COPILOT_VSCODE_VERSION}`,
      'editor-plugin-version': `copilot-chat/${COPILOT_CHAT_VERSION}`,
      'user-agent': COPILOT_USER_AGENT,
      'openai-intent': 'conversation-panel',
      'x-github-api-version': COPILOT_API_VERSION,
      'x-vscode-user-agent-library-version': 'electron-fetch',
      'X-Initiator': 'user',
      'x-request-id': _requestId(),
    }
    if (ctx?.sessionId) {
      headers.session_id = ctx.sessionId
      headers['x-client-request-id'] = ctx.sessionId
      headers['x-session-affinity'] = ctx.sessionId
    }
    return headers
  },

  transformRequest(body: OpenAIChatRequest, ctx: TransformContext): OpenAIChatRequest {
    if (ctx.sessionId) {
      body.prompt_cache_key = ctx.sessionId
    }
    if (_requiresMaxCompletionTokens(ctx.model) && body.max_tokens !== undefined) {
      const v = body.max_tokens
      delete body.max_tokens
      ;(body as unknown as Record<string, unknown>).max_completion_tokens = v
    }
    if (!_supportsTemperature(ctx.model) && body.temperature !== undefined) {
      delete body.temperature
    }
    // Chat-completions endpoint rejects thinking/reasoning_effort. The
    // /responses route handles those, but we don't ship a /responses path
    // in v0.4.1 — the few Codex-class models that need it can be added later.
    delete body.thinking
    delete body.reasoning_effort
    delete body.reasoning
    body.messages = _sanitizeToolCallAdjacency(body.messages)
    return body
  },

  schemaDropList(): Set<string> {
    return new Set(['$schema', '$id', '$ref', '$comment'])
  },

  contextExceededMarkers(): string[] {
    return ['context length', 'context_length_exceeded', 'prompt is too long', 'too long']
  },

  preferredEditFormat(model: string): 'apply_patch' | 'edit_block' | 'str_replace' {
    const m = model.toLowerCase()
    if (m.includes('claude-')) return 'apply_patch'
    if (m.startsWith('gpt-5') || m.startsWith('o1') || m.startsWith('o3')) return 'apply_patch'
    if (m.includes('gemini-3') || m.includes('gemini-2.5')) return 'apply_patch'
    return 'edit_block'
  },

  smallFastModel(_model: string): string | null {
    return 'gpt-5-mini'
  },

  cacheControlMode(model: string): 'none' | 'passthrough' | 'last-only' {
    const m = model.toLowerCase()
    if (m.includes('claude-')) return 'last-only'
    return 'none'
  },

  // Copilot's supported model set changes often. Prefer the live `/models`
  // response when possible, then fall back to a docs-aligned catalog.
  preferLiveModelCatalog(): boolean {
    return true
  },

  filterModelCatalog(models: Array<{ id: string; name?: string }>): Array<{ id: string; name?: string }> {
    const deduped = new Map<string, { id: string; name?: string; contextWindow?: number }>()
    for (const model of models) {
      if (!_isChatCapableCopilotModel(model.id)) continue
      if (!_isCurrentPlanEligibleCopilotModel(model.id)) continue
      // Carry the context window through: it is the only place Copilot's own
      // limit for a model arrives, and rebuilding the row from its id alone
      // dropped it, so every Copilot model fell through to tables describing
      // other hosts. Nothing else is carried - an owner or tags here would
      // regroup and re-badge the picker, which sorts by owner first.
      const { contextWindow } = model as { contextWindow?: number }
      deduped.set(model.id, {
        id: model.id,
        name: _copilotDisplayName(model.id),
        ...(typeof contextWindow === 'number' && contextWindow > 0 && { contextWindow }),
      })
    }
    return Array.from(deduped.values())
  },

  // Fallback catalog aligned with GitHub's supported-model docs as of
  // April 22, 2026. IDs stay on the Copilot/openai-compat path; OpenAI's
  // native Codex lane remains separate.
  staticCatalog() {
    return [
      // OpenAI
      { id: 'gpt-4.1', name: 'GPT-4.1' },
      { id: 'gpt-5-mini', name: 'GPT-5 mini' },
      { id: 'gpt-5.2', name: 'GPT-5.2' },
      { id: 'gpt-5.2-codex', name: 'GPT-5.2-Codex' },
      { id: 'gpt-5.3-codex', name: 'GPT-5.3-Codex' },
      { id: 'gpt-5.4', name: 'GPT-5.4' },
      { id: 'gpt-5.4-mini', name: 'GPT-5.4 mini' },
      // Anthropic
      { id: 'claude-haiku-4.5', name: 'Claude Haiku 4.5' },
      { id: 'claude-opus-4.5', name: 'Claude Opus 4.5' },
      { id: 'claude-opus-4.6', name: 'Claude Opus 4.6' },
      { id: 'claude-opus-4.7', name: 'Claude Opus 4.7' },
      { id: 'claude-sonnet-4', name: 'Claude Sonnet 4' },
      { id: 'claude-sonnet-4.5', name: 'Claude Sonnet 4.5' },
      { id: 'claude-sonnet-4.6', name: 'Claude Sonnet 4.6' },
    ].filter(model => _isCurrentPlanEligibleCopilotModel(model.id))
  },
}
