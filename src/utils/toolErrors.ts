import type { ZodError, ZodTypeAny } from 'zod/v4'
import { AbortError, ShellError } from './errors.js'
import { INTERRUPT_MESSAGE_FOR_TOOL_USE } from './messages.js'
import { surrogateSafeEnd, surrogateSafeStart } from './wellFormedText.js'
import { zodToJsonSchema } from './zodToJsonSchema.js'

export function formatError(error: unknown): string {
  if (error instanceof AbortError) {
    return error.message || INTERRUPT_MESSAGE_FOR_TOOL_USE
  }
  if (!(error instanceof Error)) {
    return String(error)
  }
  const parts = getErrorParts(error)
  const fullMessage =
    parts.filter(Boolean).join('\n').trim() || 'Command failed with no output'
  if (fullMessage.length <= 10000) {
    return fullMessage
  }
  const halfLength = 5000
  // Cut points step around surrogate pairs: half an emoji in a tool error
  // would make every later API request fail as invalid JSON.
  const start = fullMessage.slice(0, surrogateSafeEnd(fullMessage, halfLength))
  const end = fullMessage.slice(
    surrogateSafeStart(fullMessage, fullMessage.length - halfLength),
  )
  return `${start}\n\n... [${fullMessage.length - start.length - end.length} characters truncated] ...\n\n${end}`
}

export function getErrorParts(error: Error): string[] {
  if (error instanceof ShellError) {
    return [
      `Exit code ${error.code}`,
      error.interrupted ? INTERRUPT_MESSAGE_FOR_TOOL_USE : '',
      error.stderr,
      error.stdout,
    ]
  }
  const parts = [error.message]
  if ('stderr' in error && typeof error.stderr === 'string') {
    parts.push(error.stderr)
  }
  if ('stdout' in error && typeof error.stdout === 'string') {
    parts.push(error.stdout)
  }
  return parts
}

/**
 * Formats a Zod validation path into a readable string
 * e.g., ['todos', 0, 'activeForm'] => 'todos[0].activeForm'
 */
function formatValidationPath(path: PropertyKey[]): string {
  if (path.length === 0) return ''

  return path.reduce((acc, segment, index) => {
    const segmentStr = String(segment)
    if (typeof segment === 'number') {
      return `${String(acc)}[${segmentStr}]`
    }
    return index === 0 ? segmentStr : `${String(acc)}.${segmentStr}`
  }, '') as string
}

/**
 * Converts Zod validation errors into a human-readable and LLM friendly error message
 *
 * @param toolName The name of the tool that failed validation
 * @param error The Zod error object
 * @returns A formatted error message string
 */
export function formatZodValidationError(
  toolName: string,
  error: ZodError,
  schema?: ZodTypeAny,
  receivedInput?: unknown,
): string {
  const missingParams = error.issues
    .filter(
      err =>
        err.code === 'invalid_type' &&
        err.message.includes('received undefined'),
    )
    .map(err => formatValidationPath(err.path))

  const unexpectedParams = error.issues
    .filter(err => err.code === 'unrecognized_keys')
    .flatMap(err => err.keys)

  const typeMismatchParams = error.issues
    .filter(
      err =>
        err.code === 'invalid_type' &&
        !err.message.includes('received undefined'),
    )
    .map(err => {
      const typeErr = err as { expected: string }
      const receivedMatch = err.message.match(/received (\w+)/)
      const received = receivedMatch ? receivedMatch[1] : 'unknown'
      return {
        param: formatValidationPath(err.path),
        expected: typeErr.expected,
        received,
      }
    })

  // Default to original error message if we can't create a better one
  let errorContent = error.message

  // Build a human-readable error message
  const errorParts = []

  if (missingParams.length > 0) {
    const missingParamErrors = missingParams.map(
      param => `The required parameter \`${param}\` is missing`,
    )
    errorParts.push(...missingParamErrors)
  }

  if (unexpectedParams.length > 0) {
    const unexpectedParamErrors = unexpectedParams.map(
      param => `An unexpected parameter \`${param}\` was provided`,
    )
    errorParts.push(...unexpectedParamErrors)
  }

  if (typeMismatchParams.length > 0) {
    const typeErrors = typeMismatchParams.map(
      ({ param, expected, received }) =>
        `The parameter \`${param}\` type is expected as \`${expected}\` but provided as \`${received}\``,
    )
    errorParts.push(...typeErrors)
  }

  if (errorParts.length > 0) {
    errorContent = `${toolName} failed due to the following ${errorParts.length > 1 ? 'issues' : 'issue'}:\n${errorParts.join('\n')}`
  }

  const schemaSummary = schema ? summarizeSchema(schema) : null
  if (schemaSummary) {
    errorContent += `\nExpected input schema:\n${schemaSummary}`
  }

  const receivedSummary = summarizeReceivedInput(receivedInput)
  if (receivedSummary) {
    errorContent += `\nReceived input:\n${receivedSummary}`
  }

  return errorContent
}

function summarizeSchema(schema: ZodTypeAny): string | null {
  try {
    const jsonSchema = zodToJsonSchema(schema)
    const condensed = condenseSchema(jsonSchema)
    return limitSection(JSON.stringify(condensed, null, 2), 1500)
  } catch {
    return null
  }
}

function condenseSchema(schema: Record<string, unknown>, depth = 0): unknown {
  const summary: Record<string, unknown> = {}

  if (typeof schema.type === 'string') {
    summary.type = schema.type
  }
  if (typeof schema.format === 'string') {
    summary.format = schema.format
  }
  if (Array.isArray(schema.required) && schema.required.length > 0) {
    summary.required = schema.required
  }
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    summary.enum = schema.enum.slice(0, 10)
  }
  if (schema.additionalProperties !== undefined) {
    summary.additionalProperties = schema.additionalProperties
  }
  if (typeof schema.description === 'string' && depth === 0) {
    summary.description = schema.description
  }

  if (
    depth < 2 &&
    schema.properties &&
    typeof schema.properties === 'object' &&
    !Array.isArray(schema.properties)
  ) {
    summary.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([key, value]) => [
        key,
        condenseSchema(value as Record<string, unknown>, depth + 1),
      ]),
    )
  }

  if (
    depth < 2 &&
    schema.items &&
    typeof schema.items === 'object' &&
    !Array.isArray(schema.items)
  ) {
    summary.items = condenseSchema(
      schema.items as Record<string, unknown>,
      depth + 1,
    )
  }

  if (depth < 1 && Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
    summary.anyOf = schema.anyOf
      .slice(0, 3)
      .map(option => condenseSchema(option as Record<string, unknown>, depth + 1))
  }

  if (depth < 1 && Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    summary.oneOf = schema.oneOf
      .slice(0, 3)
      .map(option => condenseSchema(option as Record<string, unknown>, depth + 1))
  }

  return summary
}

function summarizeReceivedInput(receivedInput: unknown): string | null {
  if (receivedInput === undefined) {
    return null
  }

  try {
    return limitSection(JSON.stringify(receivedInput, null, 2), 1000)
  } catch {
    return null
  }
}

function limitSection(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value
  }

  return `${value.slice(0, maxChars)}\n... [truncated]`
}
