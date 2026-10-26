import { z } from 'zod/v4'
import { createElement } from 'react'
import { OutputLine, tryJsonFormatContent } from '../../../components/shell/OutputLine.js'
import stripAnsi from 'strip-ansi'
import { isOutputLineTruncated } from '../../terminal.js'
import {
  buildTool,
  type Tool,
  type Tools,
  type ToolInputJSONSchema,
} from '../../../Tool.js'
import { buildMcpToolName } from '../../../services/mcp/mcpStringUtils.js'
import { checkMcpArguments } from '../../../services/mcp/contractValidation.js'
import { getToolSchemaCache } from '../../toolSchemaCache.js'

export type ModToolSpec = {
  name: string
  description: string
  inputSchema: ToolInputJSONSchema
  isDeferred?: boolean
}
export type ModToolInfo = { name: string; description: string; mcp: boolean }
export type ModToolRegistry = {
  readonly tools: Map<string, Tool>
  register(value: unknown): Promise<{ tool: string }>
}

type RegistryOptions = {
  plugin: string
  isCurrent(): boolean
  reserved: Map<string, ModToolRegistry>
  changed(): Promise<void>
}

const registeredTools = new WeakSet<Tool>()
const toolDefinitions = new WeakMap<Tool, string>()
let published: readonly ModToolRegistry[] = []
let revision = 0
const subscribers = new Set<() => void>()
const renderResult = (value: unknown): string =>
  typeof value === 'string' ? value : (JSON.stringify(value) ?? '')

function jsonCopy(value: unknown): unknown {
  const seen = new Set<object>()
  const visit = (item: unknown): void => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean')
      return
    if (typeof item === 'number' && Number.isFinite(item)) return
    if (!item || typeof item !== 'object')
      throw new Error('Tool inputSchema must contain JSON data')
    if (seen.has(item))
      throw new Error('Tool inputSchema cannot contain cycles')
    seen.add(item)
    if (Array.isArray(item)) item.forEach(visit)
    else for (const entry of Object.values(item)) visit(entry)
    seen.delete(item)
  }
  visit(value)
  const text = JSON.stringify(value)
  if (Buffer.byteLength(text) > 4 * 1024 * 1024)
    throw new Error('Tool inputSchema exceeds 4 MiB')
  return JSON.parse(text)
}

function normalizeSpec(value: unknown): ModToolSpec {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('tool.register requires a tool specification')
  const input = value as Record<string, unknown>
  if (
    typeof input.name !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,64}$/.test(input.name)
  )
    throw new Error(
      'Tool name must contain 1-64 letters, digits, underscores or hyphens',
    )
  if (typeof input.description !== 'string')
    throw new Error('Tool description must be a string')
  if (input.isDeferred !== undefined && typeof input.isDeferred !== 'boolean')
    throw new Error('Tool isDeferred must be a boolean')
  const schema =
    input.inputSchema === undefined
      ? { type: 'object' }
      : jsonCopy(input.inputSchema)
  if (
    !schema ||
    typeof schema !== 'object' ||
    Array.isArray(schema) ||
    ('type' in schema && schema.type !== 'object')
  )
    throw new Error('Tool inputSchema must describe an object')
  return {
    name: input.name,
    // Replace only invalid UTF-16 pairs; keep legitimate schema and prose bytes.
    description: input.description.replace(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
      '\uFFFD',
    ),
    inputSchema: { ...(schema as Record<string, unknown>), type: 'object' },
    ...(input.isDeferred !== undefined ? { isDeferred: input.isDeferred } : {}),
  }
}

export async function invalidateModToolMetadata(
  names: ReadonlySet<string>,
): Promise<void> {
  if (!names.size) return
  const cache = getToolSchemaCache()
  for (const [key, value] of cache)
    if (names.has(value.name) || names.has(key)) cache.delete(key)
  // This cache holds search descriptions only; its automatic invalidation
  // tracks names and cannot see a same-name description replacement.
  const { clearToolSearchDescriptionCache } =
    await import('../../../tools/ToolSearchTool/ToolSearchTool.js')
  clearToolSearchDescriptionCache()
}

function notify(): void {
  revision++
  for (const subscriber of subscribers) subscriber()
}

export function getModToolRevision(): number {
  return revision
}
export function subscribeModTools(subscriber: () => void): () => void {
  subscribers.add(subscriber)
  return () => subscribers.delete(subscriber)
}
export function getModTools(): Tools {
  return published.flatMap((registry) =>
    [...registry.tools.values()].filter((tool) => tool.isEnabled()),
  )
}
/** Drop old startup snapshots; current mod definitions come from the registry. */
export function filterCurrentModTools(tools: Tools): Tools {
  return tools.filter((tool) => !registeredTools.has(tool))
}
export async function publishModToolRegistries(
  registries: readonly ModToolRegistry[],
): Promise<void> {
  const old = new Map(
    published
      .flatMap((registry) => [...registry.tools.values()])
      .map((tool) => [tool.name, tool]),
  )
  published = [...registries]
  const next = new Map(getModTools().map((tool) => [tool.name, tool]))
  const changed = new Set(
    [...old.keys(), ...next.keys()].filter((name) => {
      const before = old.get(name),
        after = next.get(name)
      return (
        !before ||
        !after ||
        toolDefinitions.get(before) !== toolDefinitions.get(after)
      )
    }),
  )
  const poolChanged =
    old.size !== next.size ||
    [...old.keys()].some((name) => old.get(name) !== next.get(name))
  await invalidateModToolMetadata(changed)
  if (poolChanged) notify()
}

export function createModToolRegistry(
  options: RegistryOptions,
): ModToolRegistry {
  const specs = new Map<string, string>()
  const tools = new Map<string, Tool>()
  const registry: ModToolRegistry = {
    tools,
    async register(value) {
      const spec = normalizeSpec(value)
      const name = buildMcpToolName(options.plugin, spec.name)
      const owner = options.reserved.get(name)
      if (owner && owner !== registry)
        throw new Error(
          `Tool ${name} is already registered by another mod module`,
        )
      const encoded = JSON.stringify(spec)
      if (specs.get(name) === encoded) return { tool: name }
      const available = () => options.isCurrent() && tools.get(name) === tool
      const tool: Tool = buildTool({
        name,
        isMcp: true,
        mcpInfo: { serverName: options.plugin, toolName: spec.name },
        inputSchema: z.object({}).passthrough(),
        inputJSONSchema: spec.inputSchema,
        alwaysLoad: spec.isDeferred === false,
        shouldDefer: spec.isDeferred !== false,
        isEnabled: available,
        isReadOnly: () => false,
        isConcurrencySafe: () => false,
        toAutoClassifierInput: (input) => ({ tool: name, input }),
        maxResultSizeChars: 100_000,
        async description() {
          return spec.description
        },
        async prompt() {
          return spec.description
        },
        async checkPermissions() {
          if (!available())
            return {
              behavior: 'deny' as const,
              message: `Tool ${name} is no longer available`,
              decisionReason: {
                type: 'other' as const,
                reason: 'The plugin tool registration is no longer active.',
              },
            }
          return {
            behavior: 'passthrough' as const,
            message: 'Plugin tool requires permission.',
          }
        },
        async call() {
          if (!available())
            throw new Error(`Tool ${name} is no longer available`)
          throw new Error(`No mod answered registered tool ${name}`)
        },
        userFacingName: () => name,
        renderToolUseMessage: (input) => renderResult(input),
        renderToolResultMessage: (output, _progress, { verbose }) =>
          createElement(OutputLine, { content: renderResult(output), verbose }),
        extractSearchText: output => stripAnsi(tryJsonFormatContent(renderResult(output))),
        isResultTruncated: output => isOutputLineTruncated(tryJsonFormatContent(renderResult(output))),
        mapToolResultToToolResultBlockParam: (output, toolUseID) => ({
          type: 'tool_result',
          tool_use_id: toolUseID,
          content: renderResult(output),
        }),
      })
      const check = checkMcpArguments(tool, {})
      if (!check.ok && check.reason === 'unsupported_contract')
        throw new Error(check.message)
      specs.set(name, encoded)
      tools.set(name, tool)
      registeredTools.add(tool)
      toolDefinitions.set(tool, encoded)
      options.reserved.set(name, registry)
      if (options.isCurrent()) {
        await invalidateModToolMetadata(new Set([name]))
        notify()
      }
      await options.changed()
      return { tool: name }
    },
  }
  return registry
}
