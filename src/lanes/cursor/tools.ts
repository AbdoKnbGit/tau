import type { ProviderTool } from '../../services/api/providers/base_provider.js'
import type { LaneToolRegistration } from '../types.js'
import { windowsPathToPosixPath } from '../../utils/windowsPaths.js'
import { GEMINI_TOOL_REGISTRY } from '../gemini/tools.js'
import { WEB_SEARCH_NATIVE_DESCRIPTION } from '../../tools/WebSearchTool/prompt.js'

export const CURSOR_CLIENT_SIDE_TOOL_V2 = {
  READ_SEMSEARCH_FILES: 1,
  RIPGREP_SEARCH: 3,
  READ_FILE: 5,
  LIST_DIR: 6,
  EDIT_FILE: 7,
  FILE_SEARCH: 8,
  SEMANTIC_SEARCH_FULL: 9,
  DELETE_FILE: 11,
  REAPPLY: 12,
  RUN_TERMINAL_COMMAND_V2: 15,
  FETCH_RULES: 16,
  WEB_SEARCH: 18,
  MCP: 19,
  SEARCH_SYMBOLS: 23,
  BACKGROUND_COMPOSER_FOLLOWUP: 24,
  KNOWLEDGE_BASE: 25,
  FETCH_PULL_REQUEST: 26,
  DEEP_SEARCH: 27,
  CREATE_DIAGRAM: 28,
  FIX_LINTS: 29,
  READ_LINTS: 30,
  GO_TO_DEFINITION: 31,
  TASK: 32,
  AWAIT_TASK: 33,
  TODO_READ: 34,
  TODO_WRITE: 35,
  EDIT_FILE_V2: 38,
  LIST_DIR_V2: 39,
  READ_FILE_V2: 40,
  RIPGREP_RAW_SEARCH: 41,
  GLOB_FILE_SEARCH: 42,
  CREATE_PLAN: 43,
  LIST_MCP_RESOURCES: 44,
  READ_MCP_RESOURCE: 45,
  READ_PROJECT: 46,
  UPDATE_PROJECT: 47,
  TASK_V2: 48,
  CALL_MCP_TOOL: 49,
  APPLY_AGENT_DIFF: 50,
  ASK_QUESTION: 51,
  SWITCH_MODE: 52,
  GENERATE_IMAGE: 53,
  COMPUTER_USE: 54,
  WRITE_SHELL_STDIN: 55,
} as const

const CURSOR_NATIVE_TOOL_NAMES = new Set([
  'read_file',
  'write_file',
  'replace',
  'run_shell_command',
  'glob',
  'grep_search',
  'google_web_search',
  'web_fetch',
  'ask_user',
  'enter_plan_mode',
  'exit_plan_mode',
  'list_directory',
])

const CT = CURSOR_CLIENT_SIDE_TOOL_V2

const _stringifyToolOutput = (output: string | unknown): string =>
  typeof output === 'string' ? output : JSON.stringify(output)

type JsonSchema = Record<string, unknown>

export interface CursorToolResolutionOptions {
  toolSchemas?: ReadonlyMap<string, JsonSchema>
}

type AskUserOption = {
  label: string
  description: string
}

function _asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function _nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null
}

function _firstDefined(
  native: Record<string, unknown>,
  keys: readonly string[],
): unknown {
  for (const key of keys) {
    if (native[key] != null) return native[key]
  }
  return undefined
}

function _firstString(
  native: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = _nonEmptyString(native[key])
    if (value) return value
  }
  return undefined
}

function _askUserHeader(value: unknown, question: string, index: number): string {
  const explicit = _nonEmptyString(value)
  if (explicit) return explicit.slice(0, 12)
  const fromQuestion = question
    .replace(/[^\w\s]/g, ' ')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .join(' ')
  return (fromQuestion || `Q${index + 1}`).slice(0, 12)
}

function _askUserOptions(rawOptions: unknown, type: unknown): AskUserOption[] {
  const options: AskUserOption[] = []
  if (Array.isArray(rawOptions)) {
    for (let i = 0; i < rawOptions.length; i++) {
      const raw = rawOptions[i]
      if (typeof raw === 'string') {
        const label = raw.trim()
        if (label) options.push({ label, description: `Select ${label}.` })
        continue
      }

      const record = _asRecord(raw)
      if (!record) continue
      const label =
        _nonEmptyString(record.label) ??
        _nonEmptyString(record.text) ??
        _nonEmptyString(record.value) ??
        `Option ${i + 1}`
      const description =
        _nonEmptyString(record.description) ??
        _nonEmptyString(record.desc) ??
        `Select ${label}.`
      options.push({ label, description })
    }
  }

  const deduped: AskUserOption[] = []
  const seen = new Set<string>()
  for (const option of options) {
    const key = option.label.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(option)
    if (deduped.length >= 4) break
  }

  const fallback = String(type ?? '').toLowerCase() === 'yesno'
    ? [
        { label: 'Yes', description: 'Confirm this option.' },
        { label: 'No', description: 'Decline this option.' },
      ]
    : [
        { label: 'Answer', description: 'Provide a custom answer.' },
        { label: 'Skip', description: 'Do not answer this now.' },
      ]

  for (const option of fallback) {
    if (deduped.length >= 2) break
    if (!seen.has(option.label.toLowerCase())) {
      deduped.push(option)
      seen.add(option.label.toLowerCase())
    }
  }

  return deduped.slice(0, 4)
}

function _normalizeAskUserInput(
  native: Record<string, unknown>,
): Record<string, unknown> {
  const rawQuestions = Array.isArray(native.questions) && native.questions.length > 0
    ? native.questions
    : [native]

  const questions = rawQuestions.map((raw, index) => {
    const record = _asRecord(raw) ?? {}
    const question =
      _nonEmptyString(record.question) ??
      _nonEmptyString(record.prompt) ??
      _nonEmptyString(native.question) ??
      _nonEmptyString(native.prompt) ??
      'Please choose an option.'
    const type = record.type ?? native.type
    return {
      question,
      header: _askUserHeader(record.header ?? native.header, question, index),
      options: _askUserOptions(record.options ?? native.options, type),
      multiSelect: Boolean(
        record.multiSelect ??
        record.multi_select ??
        native.multiSelect ??
        native.multi_select,
      ),
    }
  })

  return { questions }
}

function _schemaProperties(schema: JsonSchema | undefined): Record<string, JsonSchema> {
  const properties = _asRecord(schema?.properties)
  if (!properties) return {}
  const out: Record<string, JsonSchema> = {}
  for (const [key, value] of Object.entries(properties)) {
    const property = _asRecord(value)
    if (property) out[key] = property
  }
  return out
}

function _schemaRequired(schema: JsonSchema | undefined): string[] {
  return Array.isArray(schema?.required)
    ? schema.required.filter((value): value is string => typeof value === 'string')
    : []
}

function _schemaTypeIncludes(property: JsonSchema | undefined, type: string): boolean {
  const raw = property?.type
  if (raw === type) return true
  if (Array.isArray(raw)) return raw.includes(type)
  return false
}

function _schemaRequiredStringKeys(schema: JsonSchema | undefined): string[] {
  const properties = _schemaProperties(schema)
  return _schemaRequired(schema).filter(key => {
    const property = properties[key]
    return !property || _schemaTypeIncludes(property, 'string')
  })
}

function _camelToSnake(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
}

function _fieldAliases(key: string): string[] {
  const snake = _camelToSnake(key)
  const kebab = snake.replace(/_/g, '-')
  const lower = key.toLowerCase()
  const aliases = [
    key,
    snake,
    kebab,
    lower,
    'query',
    'q',
    'search',
    'searchQuery',
    'search_query',
    'term',
    'text',
    'value',
    'input',
  ]
  if (lower.includes('name')) aliases.push('name')
  if (lower.includes('id')) aliases.push('id')
  if (lower.includes('library')) aliases.push('library', 'library_name')
  if (lower.includes('path')) aliases.push('path', 'file_path')
  return [...new Set(aliases)]
}

function _structuralFieldAliases(key: string): string[] {
  const snake = _camelToSnake(key)
  const kebab = snake.replace(/_/g, '-')
  const lower = key.toLowerCase()
  const aliases = [key, snake, kebab, lower]
  if (lower.includes('name')) aliases.push('name')
  if (lower.includes('id')) aliases.push('id')
  if (lower.includes('path')) aliases.push('path', 'file_path')
  return [...new Set(aliases)]
}

function _schemaHasProperty(schema: JsonSchema | undefined, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(_schemaProperties(schema), key)
}

function _schemaAllowsAdditionalProperties(schema: JsonSchema | undefined): boolean {
  return schema?.additionalProperties !== false
}

function _singleStringCandidate(
  input: Record<string, unknown>,
  schema: JsonSchema | undefined,
): { key: string; value: string } | null {
  const candidates: Array<{ key: string; value: string }> = []
  for (const [key, value] of Object.entries(input)) {
    const text = _nonEmptyString(value)
    if (!text) continue
    if (schema && _schemaHasProperty(schema, key)) continue
    candidates.push({ key, value: text })
  }
  return candidates.length === 1 ? candidates[0]! : null
}

function _schemaForTool(
  toolName: string,
  options?: CursorToolResolutionOptions,
): JsonSchema | undefined {
  return options?.toolSchemas?.get(toolName)
}

function _normalizeMcpNamePart(value: string): string {
  return value.toLowerCase().replace(/[-_\s]+/g, '')
}

function _mcpNameParts(name: string): { server: string; toolName: string } | null {
  if (!name.startsWith('mcp__')) return null
  const rest = name.slice('mcp__'.length)
  const idx = rest.indexOf('__')
  if (idx < 0) return null
  return {
    server: rest.slice(0, idx),
    toolName: rest.slice(idx + 2),
  }
}

function _resolveMcpImplId(
  server: string,
  toolName: string,
  options?: CursorToolResolutionOptions,
): string {
  const exact = `mcp__${server}__${toolName}`
  if (options?.toolSchemas?.has(exact)) return exact

  const normalizedServer = _normalizeMcpNamePart(server)
  const normalizedToolName = _normalizeMcpNamePart(toolName)
  for (const candidate of options?.toolSchemas?.keys() ?? []) {
    const parts = _mcpNameParts(candidate)
    if (!parts) continue
    if (
      _normalizeMcpNamePart(parts.server) === normalizedServer &&
      _normalizeMcpNamePart(parts.toolName) === normalizedToolName
    ) {
      return candidate
    }
  }

  return exact
}

function _unwrapCursorToolInput(
  nativeInput: Record<string, unknown>,
  schema?: JsonSchema,
): Record<string, unknown> {
  for (const key of ['tool_args', 'arguments', 'args', 'input', 'parameters']) {
    if (_schemaHasProperty(schema, key)) continue
    const nested = _asRecord(nativeInput[key])
    if (nested) return nested
  }
  return nativeInput
}

function _schemaArrayItem(schema: JsonSchema | undefined): JsonSchema | undefined {
  return _asRecord(schema?.items) ?? undefined
}

function _coerceStringValue(value: unknown): unknown {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return value
}

function _coerceArrayItemValue(value: unknown, itemSchema: JsonSchema | undefined): unknown {
  if (_schemaTypeIncludes(itemSchema, 'string')) return _coerceStringValue(value)
  if (_schemaTypeIncludes(itemSchema, 'number') || _schemaTypeIncludes(itemSchema, 'integer')) {
    return _coerceNumberValue(value)
  }
  if (_schemaTypeIncludes(itemSchema, 'boolean')) return _coerceBooleanValue(value)
  if (_schemaTypeIncludes(itemSchema, 'object')) return _coerceObjectValue(value)
  return value
}

function _coerceArrayValue(value: unknown, property: JsonSchema | undefined): unknown[] {
  const itemSchema = _schemaArrayItem(property)
  if (Array.isArray(value)) {
    return value.map(item => _coerceArrayItemValue(item, itemSchema))
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return []
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed) as unknown
        if (Array.isArray(parsed)) {
          return parsed.map(item => _coerceArrayItemValue(item, itemSchema))
        }
      } catch {
        // Fall through to delimiter handling.
      }
    }
    const parts = trimmed
      .split(/[,\n]/)
      .map(part => part.trim())
      .filter(Boolean)
    const raw = parts.length > 1 ? parts : [trimmed]
    return raw.map(item => _coerceArrayItemValue(item, itemSchema))
  }
  return value == null ? [] : [_coerceArrayItemValue(value, itemSchema)]
}

function _coerceObjectValue(value: unknown): unknown {
  if (_asRecord(value)) return value
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  if (!trimmed.startsWith('{')) return value
  try {
    const parsed = JSON.parse(trimmed) as unknown
    return _asRecord(parsed) ?? value
  } catch {
    return value
  }
}

function _coerceBooleanValue(value: unknown): unknown {
  if (typeof value !== 'string') return value
  const lower = value.trim().toLowerCase()
  if (lower === 'true') return true
  if (lower === 'false') return false
  return value
}

function _coerceNumberValue(value: unknown): unknown {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  if (!trimmed) return value
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : value
}

function _coerceSchemaPropertyValue(
  value: unknown,
  property: JsonSchema | undefined,
): unknown {
  if (_schemaTypeIncludes(property, 'array')) return _coerceArrayValue(value, property)
  if (_schemaTypeIncludes(property, 'object')) return _coerceObjectValue(value)
  if (_schemaTypeIncludes(property, 'boolean')) return _coerceBooleanValue(value)
  if (_schemaTypeIncludes(property, 'number') || _schemaTypeIncludes(property, 'integer')) {
    return _coerceNumberValue(value)
  }
  if (_schemaTypeIncludes(property, 'string')) return _coerceStringValue(value)
  return value
}

export function normalizeCursorSchemaToolInput(
  nativeInput: Record<string, unknown>,
  schema?: JsonSchema,
): Record<string, unknown> {
  const input: Record<string, unknown> = { ..._unwrapCursorToolInput(nativeInput, schema) }
  const properties = _schemaProperties(schema)
  const requiredStringKeys = _schemaRequiredStringKeys(schema)

  for (const key of Object.keys(properties)) {
    if (input[key] != null) continue
    for (const alias of _structuralFieldAliases(key)) {
      if (alias === key || input[alias] == null) continue
      input[key] = input[alias]
      if (!_schemaHasProperty(schema, alias)) delete input[alias]
      break
    }
  }

  for (const key of requiredStringKeys) {
    if (input[key] != null) continue

    let mappedFrom: string | null = null
    for (const alias of _fieldAliases(key)) {
      if (alias === key) continue
      const value = _nonEmptyString(input[alias])
      if (!value) continue
      input[key] = value
      mappedFrom = alias
      break
    }

    if (!mappedFrom) {
      const single = _singleStringCandidate(input, schema)
      if (single) {
        input[key] = single.value
        mappedFrom = single.key
      }
    }

    if (
      mappedFrom &&
      mappedFrom !== key &&
      !_schemaHasProperty(schema, mappedFrom)
    ) {
      delete input[mappedFrom]
    }
  }

  for (const [key, property] of Object.entries(properties)) {
    if (input[key] == null) continue
    input[key] = _coerceSchemaPropertyValue(input[key], property)
  }

  if (!_schemaAllowsAdditionalProperties(schema)) {
    for (const key of Object.keys(input)) {
      if (!_schemaHasProperty(schema, key)) delete input[key]
    }
  }

  return input
}

const CURSOR_EXTRA_TOOL_REGISTRY: LaneToolRegistration[] = [
  {
    nativeName: 'run_terminal_cmd',
    implId: 'Bash',
    nativeDescription:
      'Execute a shell command in the workspace. Use this for running commands, tests, git, and development workflows.',
    nativeSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute.' },
        cwd: { type: 'string', description: 'Optional working directory override.' },
        description: { type: 'string', description: 'Brief description for the command.' },
        is_background: { type: 'boolean', description: 'Whether the command should keep running in the background.' },
      },
      required: ['command'],
    },
    adaptInput(native) {
      const command = native.command
      const cwd = native.cwd
      const input: Record<string, unknown> = { command }
      if (native.description) input.description = native.description
      if (native.is_background) input.run_in_background = native.is_background
      if (cwd) input.command = `cd ${JSON.stringify(cwd)} && ${command}`
      return input
    },
    adaptOutput: _stringifyToolOutput,
  },
  {
    nativeName: 'glob_file_search',
    implId: 'Glob',
    nativeDescription: 'Find files matching a glob pattern.',
    nativeSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern to match.' },
        path: { type: 'string', description: 'Optional path to search within.' },
      },
      required: ['pattern'],
    },
    adaptInput(native) {
      const pattern =
        native.pattern ??
        native.glob_pattern ??
        native.query
      const path =
        native.path ??
        native.target_directory ??
        native.dir_path
      const input: Record<string, unknown> = { pattern }
      if (path) input.path = path
      return input
    },
    adaptOutput: _stringifyToolOutput,
  },
  {
    nativeName: 'web_search',
    implId: 'WebSearch',
    nativeDescription: WEB_SEARCH_NATIVE_DESCRIPTION,
    nativeSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query.' },
      },
      required: ['query'],
    },
    adaptInput(native) {
      return { query: native.query ?? native.search_term }
    },
    adaptOutput: _stringifyToolOutput,
  },
  {
    nativeName: 'ask_question',
    implId: 'AskUserQuestion',
    nativeDescription: 'Ask the user a structured clarification question.',
    nativeSchema: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          description: 'Structured questions to present to the user.',
        },
      },
      required: ['questions'],
    },
    adaptInput(native) {
      return {
        question: native.question ?? native.prompt,
        questions: native.questions,
      }
    },
    adaptOutput: _stringifyToolOutput,
  },
  {
    nativeName: 'create_plan',
    implId: 'EnterPlanMode',
    nativeDescription: 'Enter planning mode before implementation.',
    nativeSchema: { type: 'object', properties: {} },
    adaptInput(native) {
      return native
    },
    adaptOutput: _stringifyToolOutput,
  },
  {
    nativeName: 'list_mcp_resources',
    implId: 'ListMcpResourcesTool',
    nativeDescription: 'List MCP resources from configured servers.',
    nativeSchema: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'Optional MCP server name.' },
      },
    },
    adaptInput(native) {
      const input: Record<string, unknown> = { ...native }
      if (input.path == null && native.target_directory != null) {
        input.path = native.target_directory
      }
      if (input.pattern == null && native.query != null) {
        input.pattern = native.query
      }
      if (input.glob == null && native.glob_pattern != null) {
        input.glob = native.glob_pattern
      }
      return input
    },
    adaptOutput: _stringifyToolOutput,
  },
  {
    nativeName: 'read_mcp_resource',
    implId: 'ReadMcpResourceTool',
    nativeDescription: 'Read a specific MCP resource by URI.',
    nativeSchema: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'MCP server name.' },
        uri: { type: 'string', description: 'Resource URI.' },
      },
      required: ['server', 'uri'],
    },
    adaptInput(native) {
      return native
    },
    adaptOutput: _stringifyToolOutput,
  },
  {
    nativeName: 'task',
    implId: 'Agent',
    nativeDescription: 'Spawn a delegated subagent for a bounded task.',
    nativeSchema: {
      type: 'object',
      properties: {
        description: { type: 'string' },
        prompt: { type: 'string' },
      },
      required: ['description', 'prompt'],
    },
    adaptInput(native) {
      return native
    },
    adaptOutput: _stringifyToolOutput,
  },
]

const CURSOR_COMPAT_ALIAS_REGISTRY: LaneToolRegistration[] = [
  {
    nativeName: 'Shell',
    implId: 'Bash',
    nativeDescription: 'Execute a shell command in the workspace.',
    nativeSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute.' },
        cwd: { type: 'string', description: 'Optional working directory override.' },
        description: { type: 'string', description: 'Brief description for the command.' },
      },
      required: ['command'],
    },
    adaptInput(native) {
      const command = native.command
      const cwd = native.cwd ?? native.dir_path
      const input: Record<string, unknown> = { command }
      if (native.description) input.description = native.description
      if (cwd) input.command = `cd ${JSON.stringify(cwd)} && ${command}`
      return input
    },
    adaptOutput: _stringifyToolOutput,
  },
  {
    nativeName: 'list_dir',
    implId: 'Bash',
    nativeDescription: 'List directory contents.',
    nativeSchema: {
      type: 'object',
      properties: {
        dir_path: { type: 'string', description: 'Optional directory path to list.' },
      },
    },
    adaptInput(native) {
      const dirPath = typeof native.dir_path === 'string' ? native.dir_path : undefined
      return {
        command: _cursorListDirCommand(dirPath),
        description: dirPath ? `List directory contents for ${dirPath}` : 'List directory contents',
      }
    },
    adaptOutput: _stringifyToolOutput,
  },
  {
    nativeName: 'list_dir_v2',
    implId: 'Bash',
    nativeDescription: 'List directory contents.',
    nativeSchema: {
      type: 'object',
      properties: {
        dir_path: { type: 'string', description: 'Optional directory path to list.' },
      },
    },
    adaptInput(native) {
      const dirPath = typeof native.dir_path === 'string' ? native.dir_path : undefined
      return {
        command: _cursorListDirCommand(dirPath),
        description: dirPath ? `List directory contents for ${dirPath}` : 'List directory contents',
      }
    },
    adaptOutput: _stringifyToolOutput,
  },
  {
    nativeName: 'grep',
    implId: 'Grep',
    nativeDescription: 'Search file contents with a regular expression.',
    nativeSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        path: { type: 'string' },
      },
      required: ['pattern'],
    },
    adaptInput(native) {
      return native
    },
    adaptOutput: _stringifyToolOutput,
  },
  {
    nativeName: 'search_replace',
    implId: 'Edit',
    nativeDescription: 'Edit a file by replacing exact text.',
    nativeSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
      },
      required: ['file_path', 'old_string', 'new_string'],
    },
    adaptInput(native) {
      return {
        file_path: native.file_path,
        old_string: native.old_string,
        new_string: native.new_string,
        replace_all: native.replace_all ?? native.allow_multiple ?? false,
      }
    },
    adaptOutput: _stringifyToolOutput,
  },
  {
    nativeName: 'write',
    implId: 'Write',
    nativeDescription: 'Write a file in one shot.',
    nativeSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['file_path', 'content'],
    },
    adaptInput(native) {
      return {
        file_path: native.file_path,
        content: native.content,
      }
    },
    adaptOutput: _stringifyToolOutput,
  },
]

export const CURSOR_TOOL_REGISTRY: LaneToolRegistration[] = [
  ...CURSOR_EXTRA_TOOL_REGISTRY,
  ...GEMINI_TOOL_REGISTRY.filter(reg => CURSOR_NATIVE_TOOL_NAMES.has(reg.nativeName)),
  ...CURSOR_COMPAT_ALIAS_REGISTRY,
]

const CURSOR_PRESERVE_SHARED_SCHEMA_IMPL_IDS = new Set([
  'Agent',
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
  'ListMcpResourcesTool',
  'ReadMcpResourceTool',
])

const CURSOR_MCP_TOOL_ENUMS = [
  CT.MCP,
  CT.CALL_MCP_TOOL,
] as const

const CURSOR_TOOL_ENUMS_BY_NAME: Record<string, readonly number[]> = {
  Read: [CT.READ_FILE, CT.READ_FILE_V2],
  read_file: [CT.READ_FILE, CT.READ_FILE_V2],
  FileReadTool: [CT.READ_FILE, CT.READ_FILE_V2],

  Glob: [CT.GLOB_FILE_SEARCH, CT.FILE_SEARCH],
  glob: [CT.GLOB_FILE_SEARCH, CT.FILE_SEARCH],
  file_search: [CT.FILE_SEARCH],
  glob_file_search: [CT.GLOB_FILE_SEARCH],

  Grep: [CT.RIPGREP_SEARCH, CT.RIPGREP_RAW_SEARCH],
  grep: [CT.RIPGREP_SEARCH, CT.RIPGREP_RAW_SEARCH],
  grep_search: [CT.RIPGREP_SEARCH, CT.RIPGREP_RAW_SEARCH],
  ripgrep_search: [CT.RIPGREP_SEARCH],
  ripgrep_raw_search: [CT.RIPGREP_RAW_SEARCH],

  Bash: [CT.RUN_TERMINAL_COMMAND_V2],
  Shell: [CT.RUN_TERMINAL_COMMAND_V2],
  PowerShell: [CT.RUN_TERMINAL_COMMAND_V2],
  list_dir: [CT.LIST_DIR, CT.LIST_DIR_V2],
  list_dir_v2: [CT.LIST_DIR_V2],
  run_shell_command: [CT.RUN_TERMINAL_COMMAND_V2],
  run_terminal_cmd: [CT.RUN_TERMINAL_COMMAND_V2],
  run_terminal_command_v2: [CT.RUN_TERMINAL_COMMAND_V2],

  WebSearch: [CT.WEB_SEARCH],
  google_web_search: [CT.WEB_SEARCH],
  web_search: [CT.WEB_SEARCH],

  Agent: [CT.TASK, CT.TASK_V2, CT.AWAIT_TASK],
  task: [CT.TASK, CT.TASK_V2, CT.AWAIT_TASK],
  task_v2: [CT.TASK_V2, CT.AWAIT_TASK],

  AskUserQuestion: [CT.ASK_QUESTION],
  ask_user: [CT.ASK_QUESTION],
  ask_question: [CT.ASK_QUESTION],

  EnterPlanMode: [CT.CREATE_PLAN, CT.SWITCH_MODE],
  enter_plan_mode: [CT.CREATE_PLAN, CT.SWITCH_MODE],
  create_plan: [CT.CREATE_PLAN, CT.SWITCH_MODE],
  ExitPlanMode: [CT.CREATE_PLAN, CT.SWITCH_MODE],
  exit_plan_mode: [CT.CREATE_PLAN, CT.SWITCH_MODE],

  ListMcpResourcesTool: [CT.LIST_MCP_RESOURCES],
  list_mcp_resources: [CT.LIST_MCP_RESOURCES],
  ReadMcpResourceTool: [CT.READ_MCP_RESOURCE],
  read_mcp_resource: [CT.READ_MCP_RESOURCE],
  LSP: [CT.SEARCH_SYMBOLS, CT.GO_TO_DEFINITION],
  TodoWrite: [CT.TODO_READ, CT.TODO_WRITE],
}

const CURSOR_TOOL_ALIAS_BY_NAME: Record<string, string> = {
  Read: 'read_file',
  Write: 'write',
  Edit: 'search_replace',
  Bash: 'run_terminal_cmd',
  Shell: 'run_terminal_cmd',
  Glob: 'glob_file_search',
  Grep: 'grep',
  WebSearch: 'web_search',
  Agent: 'task',
  AskUserQuestion: 'ask_question',
  EnterPlanMode: 'create_plan',
  ExitPlanMode: 'create_plan',
  ListMcpResourcesTool: 'list_mcp_resources',
  ReadMcpResourceTool: 'read_mcp_resource',
  read_file_v2: 'read_file',
  list_dir: 'list_directory',
  list_dir_v2: 'list_directory',
  file_search: 'glob',
  glob_file_search: 'glob',
  ripgrep_search: 'grep_search',
  ripgrep_raw_search: 'grep_search',
  task: 'Agent',
  task_v2: 'Agent',
  run_terminal_cmd: 'run_shell_command',
  run_terminal_command_v2: 'run_shell_command',
  web_search: 'google_web_search',
  ask_question: 'ask_user',
  create_plan: 'enter_plan_mode',
  switch_mode: 'enter_plan_mode',
}

const _byNativeName = new Map<string, LaneToolRegistration>()
const _byImplId = new Map<string, LaneToolRegistration>()

function _ensureIndexed(): void {
  if (_byNativeName.size > 0) return
  for (const reg of CURSOR_TOOL_REGISTRY) {
    _byNativeName.set(reg.nativeName, reg)
    if (!_byImplId.has(reg.implId)) {
      _byImplId.set(reg.implId, reg)
    }
  }
}

export function getCursorRegistrationByNativeName(
  name: string,
): LaneToolRegistration | undefined {
  _ensureIndexed()
  return _byNativeName.get(name)
}

export function getCursorRegistrationByImplId(
  implId: string,
): LaneToolRegistration | undefined {
  _ensureIndexed()
  return _byImplId.get(implId)
}

export function buildCursorToolDefinitions(tools: ProviderTool[]): ProviderTool[] {
  const out: ProviderTool[] = []
  const seen = new Set<string>()

  for (const tool of tools) {
    const reg =
      getCursorRegistrationByImplId(tool.name) ??
      getCursorRegistrationByNativeName(tool.name)

    if (reg) {
      if (seen.has(reg.nativeName)) continue
      seen.add(reg.nativeName)
      const preserveSharedShape = CURSOR_PRESERVE_SHARED_SCHEMA_IMPL_IDS.has(reg.implId)
      out.push({
        name: reg.nativeName,
        description: preserveSharedShape
          ? ((tool.description && tool.description.trim()) || reg.nativeDescription)
          : reg.nativeDescription,
        input_schema: preserveSharedShape
          ? ((tool.input_schema ?? {}) as Record<string, unknown>)
          : reg.nativeSchema,
      })
      continue
    }

    if (seen.has(tool.name)) continue
    seen.add(tool.name)
    out.push(tool)
  }

  return out
}

export function buildCursorSupportedToolEnums(tools: ProviderTool[]): number[] {
  const enums = new Set<number>()

  if (tools.length > 0) {
    for (const toolEnum of CURSOR_MCP_TOOL_ENUMS) {
      enums.add(toolEnum)
    }
  }

  for (const tool of tools) {
    for (const toolEnum of _cursorToolEnumsForName(tool.name)) {
      enums.add(toolEnum)
    }

    const reg =
      getCursorRegistrationByImplId(tool.name) ??
      getCursorRegistrationByNativeName(tool.name)
    if (reg) {
      for (const toolEnum of _cursorToolEnumsForName(reg.nativeName)) {
        enums.add(toolEnum)
      }
    }

    if (tool.name.startsWith('mcp__')) {
      for (const toolEnum of CURSOR_MCP_TOOL_ENUMS) {
        enums.add(toolEnum)
      }
    }
  }

  return [...enums]
}

export function resolveCursorToolCall(
  nativeName: string,
  nativeInput: Record<string, unknown>,
  options?: CursorToolResolutionOptions,
): { implId: string; input: Record<string, unknown> } | null {
  const normalizedName = CURSOR_TOOL_ALIAS_BY_NAME[nativeName] ?? nativeName

  if (nativeName === 'task' || nativeName === 'task_v2') {
    return { implId: 'Agent', input: nativeInput }
  }

  if (normalizedName === 'read_file') {
    return {
      implId: 'Read',
      input: _adaptCursorReadInput(nativeInput),
    }
  }

  if (normalizedName === 'write_file' || normalizedName === 'write') {
    return {
      implId: 'Write',
      input: _adaptCursorWriteInput(nativeInput),
    }
  }

  if (nativeName === 'file_search') {
    const query = typeof nativeInput.query === 'string' ? nativeInput.query : '*'
    return {
      implId: 'Glob',
      input: { pattern: query.includes('*') ? query : `**/*${query}*` },
    }
  }

  if (normalizedName === 'google_web_search') {
    return {
      implId: 'WebSearch',
      input: {
        query: nativeInput.query ?? nativeInput.search_term,
      },
    }
  }

  if (normalizedName === 'ask_user') {
    return {
      implId: 'AskUserQuestion',
      input: _normalizeAskUserInput(nativeInput),
    }
  }

  if (normalizedName === 'enter_plan_mode') {
    return { implId: 'EnterPlanMode', input: {} }
  }

  if (normalizedName === 'run_shell_command') {
    const command = nativeInput.command
    const cwd = nativeInput.dir_path ?? nativeInput.cwd
    const input: Record<string, unknown> = { command }
    if (nativeInput.description) input.description = nativeInput.description
    if (nativeInput.is_background) input.run_in_background = nativeInput.is_background
    if (cwd) input.command = `cd ${JSON.stringify(cwd)} && ${command}`
    return { implId: 'Bash', input }
  }

  if (nativeName === 'list_mcp_resources') {
    return { implId: 'ListMcpResourcesTool', input: nativeInput }
  }

  if (nativeName === 'read_mcp_resource') {
    return { implId: 'ReadMcpResourceTool', input: nativeInput }
  }

  if (nativeName === 'call_mcp_tool') {
    const server =
      typeof nativeInput.server === 'string'
        ? nativeInput.server
        : typeof nativeInput.server_name === 'string'
          ? nativeInput.server_name
          : typeof nativeInput.serverName === 'string'
            ? nativeInput.serverName
            : typeof nativeInput.mcp_server === 'string'
              ? nativeInput.mcp_server
              : ''
    const toolName =
      typeof nativeInput.tool_name === 'string'
        ? nativeInput.tool_name
        : typeof nativeInput.toolName === 'string'
          ? nativeInput.toolName
          : typeof nativeInput.name === 'string'
            ? nativeInput.name
            : ''
    if (server && toolName) {
      const implId = _resolveMcpImplId(server, toolName, options)
      const toolArgs =
        _asRecord(nativeInput.tool_args) ??
        _asRecord(nativeInput.arguments) ??
        _asRecord(nativeInput.args) ??
        _asRecord(nativeInput.input) ??
        nativeInput
      return {
        implId,
        input: normalizeCursorSchemaToolInput(
          toolArgs,
          _schemaForTool(implId, options),
        ),
      }
    }
  }

  if (normalizedName === 'replace' || nativeName === 'edit_file' || nativeName === 'edit_file_v2') {
    return _adaptCursorEditInput(nativeInput)
  }

  if (nativeName === 'NotebookEdit') {
    return {
      implId: 'NotebookEdit',
      input: _adaptCursorNotebookEditInput(nativeInput),
    }
  }

  // ── TaskCreate ───────────────────────────────────────────────────
  // The model sometimes wraps multiple tasks in a `tasks` array instead
  // of sending `{subject, description}` as the flat schema requires.
  if (nativeName === 'TaskCreate') {
    if (Array.isArray(nativeInput.tasks) && (nativeInput.tasks as Array<Record<string, unknown>>).length > 0) {
      const first = (nativeInput.tasks as Array<Record<string, unknown>>)[0]!
      return {
        implId: 'TaskCreate',
        input: {
          subject: first.subject ?? '',
          description: first.description ?? '',
          ...(first.activeForm ? { activeForm: first.activeForm } : {}),
        },
      }
    }
    return { implId: 'TaskCreate', input: nativeInput }
  }

  // ── WebFetch ─────────────────────────────────────────────────────
  // The model sometimes puts the prompt text in the `url` field or omits
  // the `url` entirely. Detect these cases and fix them.
  if (nativeName === 'WebFetch' || normalizedName === 'web_fetch') {
    const rawUrl = typeof nativeInput.url === 'string' ? nativeInput.url : ''
    const rawPrompt = typeof nativeInput.prompt === 'string' ? nativeInput.prompt : ''

    // Case 1: url field contains prompt text (no URL), prompt also has same text
    // Case 2: url is a valid URL, prompt is a valid prompt — pass through
    // Case 3: prompt contains a URL but url doesn't — extract from prompt
    const urlInUrl = rawUrl.match(/https?:\/\/[^\s]+/)
    const urlInPrompt = rawPrompt.match(/https?:\/\/[^\s]+/)

    let finalUrl = rawUrl
    let finalPrompt = rawPrompt

    if (!urlInUrl && urlInPrompt) {
      // URL is in the prompt field instead of url field
      finalUrl = urlInPrompt[0]
      finalPrompt = rawPrompt
    } else if (!urlInUrl && !urlInPrompt) {
      // Neither field has a URL — pass through as-is for error reporting
      finalUrl = rawUrl || rawPrompt
      finalPrompt = rawPrompt || rawUrl
    }

    return {
      implId: 'WebFetch',
      input: { url: finalUrl, prompt: finalPrompt },
    }
  }

  // ── MCP tools called by direct mcp__* name ──────────────────────
  // When the model calls an MCP tool directly (e.g. mcp__context7__resolve-library-id)
  // instead of going through call_mcp_tool, pass through with the native input.
  if (nativeName.startsWith('mcp__')) {
    return {
      implId: nativeName,
      input: normalizeCursorSchemaToolInput(
        nativeInput,
        _schemaForTool(nativeName, options),
      ),
    }
  }

  const reg = getCursorRegistrationByNativeName(normalizedName)
  if (!reg) {
    const schema = _schemaForTool(nativeName, options)
    if (schema) {
      return {
        implId: nativeName,
        input: normalizeCursorSchemaToolInput(nativeInput, schema),
      }
    }
    return null
  }
  return {
    implId: reg.implId,
    input: reg.adaptInput(nativeInput),
  }
}

function _cursorToolEnumsForName(name: string): readonly number[] {
  return CURSOR_TOOL_ENUMS_BY_NAME[name] ?? []
}

function _adaptCursorReadInput(native: Record<string, unknown>): Record<string, unknown> {
  const filePath =
    _firstDefined(native, [
      'file_path',
      'relative_workspace_path',
      'relativeWorkspacePath',
      'target_file',
      'targetFile',
      'path',
      'absolute_path',
      'absolutePath',
      'filename',
      'file',
      'uri',
    ])
  const start =
    _asNumber(native.start_line) ??
    _asNumber(native.start_line_one_indexed) ??
    (_asNumber(native.offset) != null ? _asNumber(native.offset)! + 1 : undefined)
  const end =
    _asNumber(native.end_line) ??
    _asNumber(native.end_line_one_indexed_inclusive) ??
    (start != null && _asNumber(native.limit) != null ? start + _asNumber(native.limit)! - 1 : undefined)

  const result: Record<string, unknown> = { file_path: filePath }
  if (start != null) {
    result.offset = Math.max(0, start - 1)
    if (end != null) result.limit = Math.max(1, end - start + 1)
  }
  return result
}

function _adaptCursorWriteInput(native: Record<string, unknown>): Record<string, unknown> {
  return {
    file_path: _firstDefined(native, [
      'file_path',
      'relative_workspace_path',
      'relativeWorkspacePath',
      'target_file',
      'targetFile',
      'path',
      'absolute_path',
      'absolutePath',
      'filename',
      'file',
    ]),
    content: _firstDefined(native, [
      'content',
      'contents',
      'text',
      'source',
      'new_source',
      'newSource',
      'data',
    ]),
  }
}

function _adaptCursorEditInput(
  native: Record<string, unknown>,
): { implId: string; input: Record<string, unknown> } | null {
  const filePath =
    _firstDefined(native, [
      'file_path',
      'relative_workspace_path',
      'relativeWorkspacePath',
      'target_file',
      'targetFile',
      'path',
      'absolute_path',
      'absolutePath',
      'filename',
      'file',
    ])

  if (native.old_string != null || native.new_string != null) {
    return {
      implId: 'Edit',
      input: {
        file_path: filePath,
        old_string: native.old_string,
        new_string: native.new_string,
        replace_all: native.allow_multiple ?? false,
      },
    }
  }

  const content = native.content ?? native.contents ?? native.contents_after_edit
  if (content != null) {
    return {
      implId: 'Write',
      input: {
        file_path: filePath,
        content,
      },
    }
  }

  const reg = getCursorRegistrationByNativeName('replace')
  return reg
    ? { implId: reg.implId, input: reg.adaptInput(native) }
    : null
}

function _adaptCursorNotebookEditInput(
  native: Record<string, unknown>,
): Record<string, unknown> {
  const editMode =
    _firstString(native, ['edit_mode', 'editMode', 'mode', 'operation']) ??
    'replace'
  const input: Record<string, unknown> = {
    notebook_path: _firstDefined(native, [
      'notebook_path',
      'notebookPath',
      'file_path',
      'path',
      'absolute_path',
      'absolutePath',
      'filename',
      'file',
    ]),
    new_source: _firstDefined(native, [
      'new_source',
      'newSource',
      'source',
      'cell_source',
      'cellSource',
      'content',
      'text',
    ]),
    edit_mode: editMode,
  }

  if (input.new_source == null && editMode === 'delete') {
    input.new_source = ''
  }

  const cellId = _cursorNotebookCellId(native)
  if (cellId != null) input.cell_id = cellId

  const cellType = _firstString(native, ['cell_type', 'cellType', 'type'])
  if (cellType === 'code' || cellType === 'markdown') {
    input.cell_type = cellType
  } else if (editMode === 'insert') {
    input.cell_type = 'code'
  }

  return input
}

function _cursorNotebookCellId(native: Record<string, unknown>): unknown {
  const explicit = _firstDefined(native, [
    'cell_id',
    'cellId',
    'target_cell_id',
    'targetCellId',
    'after_cell_id',
    'afterCellId',
    'insert_after',
    'insertAfter',
    'id',
  ])
  if (explicit != null) return explicit

  const index = _firstDefined(native, [
    'cell_index',
    'cellIndex',
    'cell_number',
    'cellNumber',
    'index',
  ])
  const numericIndex =
    typeof index === 'number'
      ? index
      : typeof index === 'string' && index.trim() !== ''
        ? Number(index.trim())
        : NaN
  return Number.isInteger(numericIndex) && numericIndex >= 0
    ? `cell-${numericIndex}`
    : undefined
}

function _asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function _cursorListDirCommand(dirPath: string | undefined): string {
  if (!dirPath) return 'ls -la'
  const bashPath = process.platform === 'win32' ? windowsPathToPosixPath(dirPath) : dirPath
  return `ls -la -- ${JSON.stringify(bashPath)}`
}
