import type { ProviderTool } from '../../services/api/providers/base_provider.js'
import type { OpenAITool } from '../../services/api/adapters/anthropic_to_openai.js'
import { recordToolSchema } from '../../services/api/adapters/tool_schema_cache.js'
import { sanitizeResponsesToolParametersForOpenAI } from '../../services/api/adapters/openai_responses_schema.js'
import { appendStrictParamsHint } from '../shared/mcp_bridge.js'

export function buildClineToolsForRequest(tools: ProviderTool[]): OpenAITool[] {
  return tools.map((tool) => {
    const parameters = sanitizeClineToolParameters(
      tool.input_schema ?? { type: 'object', properties: {} },
    )
    recordToolSchema(tool.name, parameters)

    return {
      type: 'function' as const,
      function: {
        name: tool.name,
        description: appendStrictParamsHint(tool.description ?? '', parameters),
        parameters,
      },
    }
  })
}

function sanitizeClineToolParameters(schema: unknown): Record<string, unknown> {
  const sanitized = sanitizeResponsesToolParametersForOpenAI(schema)
  return normalizeClineSchemaValue(sanitized) as Record<string, unknown>
}

function normalizeClineSchemaValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(item => normalizeClineSchemaValue(item))
  }
  if (!value || typeof value !== 'object') return value

  const input = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  const properties = isRecord(input.properties) ? input.properties : undefined
  const propertyNames = new Set(Object.keys(properties ?? {}))

  for (const [key, child] of Object.entries(input)) {
    if (child === undefined) continue

    if (key === 'properties' && properties) {
      out.properties = Object.fromEntries(
        Object.entries(properties).map(([name, propertySchema]) => [
          name,
          normalizeClineSchemaValue(propertySchema),
        ]),
      )
      continue
    }

    if (key === 'required') {
      if (!Array.isArray(child)) continue
      const required = child.filter((item): item is string =>
        typeof item === 'string' && propertyNames.has(item))
      if (required.length > 0) out.required = required
      continue
    }

    if (key === 'additionalProperties') {
      out.additionalProperties = typeof child === 'boolean' ? child : false
      continue
    }

    if (key === 'items') {
      out.items = normalizeClineSchemaValue(child)
      continue
    }

    if (key === 'anyOf' || key === 'oneOf' || key === 'allOf') {
      out[key] = Array.isArray(child)
        ? child.map(item => normalizeClineSchemaValue(item))
        : child
      continue
    }

    out[key] = normalizeClineSchemaValue(child)
  }

  if ((out.type === 'object' || out.properties) && !out.properties) {
    out.properties = {}
  }
  return out
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
