import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/messages/messages.mjs'

export function normalizeToolError(result: ToolResultBlockParam['content']): string {
  if (typeof result !== 'string') {
    return 'Tool execution failed'
  }

  const extractedError = extractTag(result, 'tool_use_error') ?? result
  const withoutSandboxViolations = removeSandboxViolationTags(extractedError)
  const withoutErrorTags = withoutSandboxViolations.replace(/<\/?error>/g, '')
  const trimmed = withoutErrorTags.trim()

  if (
    trimmed.startsWith('InputValidationError: ') ||
    trimmed.includes('Expected input schema:')
  ) {
    return summarizeToolInputValidationError(trimmed)
  }

  if (
    trimmed.startsWith('Error: ') ||
    trimmed.startsWith('Cancelled: ') ||
    trimmed.startsWith('InputValidationError: ')
  ) {
    return trimmed
  }

  return `Error: ${trimmed}`
}

function summarizeToolInputValidationError(error: string): string {
  const withoutPrefix = error.replace(/^InputValidationError:\s*/, '')
  const issueText = withoutPrefix.split('\nExpected input schema:')[0]?.trim() || withoutPrefix
  const toolMatch = issueText.match(/^([A-Za-z0-9_.:-]+)\s+failed due to/)
  const toolName = toolMatch?.[1]
  const missing = [...issueText.matchAll(/required parameter `([^`]+)` is missing/g)]
    .map(match => match[1])
    .filter((value): value is string => !!value)
  const received = compactReceivedInput(error)

  const head = toolName
    ? `Tool input validation failed: ${toolName}`
    : 'Tool input validation failed'
  const issue = missing.length > 0
    ? ` missing required ${missing.map(name => `\`${name}\``).join(', ')}`
    : compactIssueText(issueText, toolName)
  const receivedText = received ? ` Received ${received}.` : ''

  return `${head}${issue}.${receivedText} Schema details hidden.`
}

function compactIssueText(issueText: string, toolName?: string): string {
  const cleaned = issueText
    .replace(/^InputValidationError:\s*/, '')
    .replace(toolName ? new RegExp(`^${escapeRegExp(toolName)}\\s+`) : /^/, '')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .slice(0, 2)
    .join('; ')

  return cleaned ? `: ${limitInline(cleaned, 160)}` : ''
}

function compactReceivedInput(error: string): string | null {
  const match = error.match(/\nReceived input:\n([\s\S]*)$/)
  if (!match?.[1]) return null
  const raw = match[1].trim()
  if (!raw) return null
  try {
    return limitInline(JSON.stringify(JSON.parse(raw)), 140)
  } catch {
    return limitInline(raw.replace(/\s+/g, ' '), 140)
  }
}

function limitInline(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}...`
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function extractTag(value: string, tagName: string): string | null {
  const pattern = new RegExp(`<${escapeRegExp(tagName)}>([\\s\\S]*?)</${escapeRegExp(tagName)}>`)
  return pattern.exec(value)?.[1] ?? null
}

function removeSandboxViolationTags(value: string): string {
  return value
    .replace(/<\/?sandbox_violation>/g, '')
    .replace(/<\/?permission_denied>/g, '')
}
