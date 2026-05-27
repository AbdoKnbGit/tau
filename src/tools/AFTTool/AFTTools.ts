import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import { z } from 'zod/v4'
import type { Tool, ToolDef, ToolPermissionContext } from '../../Tool.js'
import { buildTool } from '../../Tool.js'
import { getCwd } from '../../utils/cwd.js'
import { isENOENT } from '../../utils/errors.js'
import { getFsImplementation } from '../../utils/fsOperations.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { expandPath } from '../../utils/path.js'
import { checkReadPermissionForTool } from '../../utils/permissions/filesystem.js'
import type { PermissionDecision } from '../../utils/permissions/PermissionResult.js'
import { callAftCommand, formatAftUnavailable } from './bridge.js'
import {
  AFT_AST_SEARCH_TOOL_NAME,
  AFT_DIAGNOSTICS_TOOL_NAME,
  AFT_NAVIGATE_TOOL_NAME,
  AFT_OUTLINE_TOOL_NAME,
  AFT_ZOOM_TOOL_NAME,
  isAftEnabled,
} from './constants.js'
import {
  formatAftError,
  formatAstSearchResponse,
  formatJsonResponse,
  formatOutlineResponse,
  formatZoomResponse,
} from './format.js'
import {
  renderAftToolResultMessage,
  renderAftToolUseMessage,
  userFacingName,
} from './UI.js'

export type AftOutput = {
  command: string
  text: string
}

const outputSchema = lazySchema(() =>
  z.object({
    command: z.string(),
    text: z.string(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

const outlineInputSchema = lazySchema(() =>
  z.strictObject({
    target: z
      .union([z.string(), z.array(z.string())])
      .describe(
        'File or directory to outline, relative to the current project or absolute. Arrays outline multiple files/directories.',
      ),
    files: z
      .boolean()
      .optional()
      .describe(
        'Optional file-tree mode for directory targets. Leave unset for code understanding and symbol outlines; use true only when you specifically need a file listing instead of symbols.',
      ),
  }),
)
type OutlineInputSchema = ReturnType<typeof outlineInputSchema>

const zoomTargetSchema = z.strictObject({
  filePath: z.string().describe('File containing the symbol'),
  symbol: z.string().describe('Symbol name in that file'),
})

const zoomInputSchema = lazySchema(() =>
  z.strictObject({
    filePath: z
      .string()
      .optional()
      .describe('File to inspect, relative to the current project or absolute'),
    symbols: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .describe('Symbol name or names to read from filePath'),
    targets: z
      .union([zoomTargetSchema, z.array(zoomTargetSchema)])
      .optional()
      .describe(
        'Cross-file batch of { filePath, symbol }. Mutually exclusive with filePath/symbols.',
      ),
    contextLines: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Lines of context before and after the symbol. Default: 3.'),
  }),
)
type ZoomInputSchema = ReturnType<typeof zoomInputSchema>

const astSearchInputSchema = lazySchema(() =>
  z.strictObject({
    pattern: z
      .string()
      .describe(
        'AST pattern with meta-variables like $VAR or $$$. Must be valid code shape, not regex.',
      ),
    lang: z
      .enum([
        'typescript',
        'tsx',
        'javascript',
        'python',
        'rust',
        'go',
        'c',
        'cpp',
        'zig',
        'csharp',
        'solidity',
        'vue',
      ])
      .describe('Language to search'),
    paths: z
      .array(z.string())
      .optional()
      .describe('Files or directories to search. Defaults to current project.'),
    globs: z
      .array(z.string())
      .optional()
      .describe('Include/exclude globs. Prefix exclusions with !.'),
    contextLines: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Number of context lines around each match.'),
  }),
)
type AstSearchInputSchema = ReturnType<typeof astSearchInputSchema>

const navigateInputSchema = lazySchema(() =>
  z.strictObject({
    op: z
      .enum([
        'call_tree',
        'callers',
        'trace_to',
        'trace_to_symbol',
        'impact',
        'trace_data',
      ])
      .describe('Code navigation operation'),
    filePath: z.string().describe('File containing the source symbol'),
    symbol: z.string().describe('Symbol to analyze'),
    depth: z.number().int().positive().optional().describe('Traversal depth'),
    expression: z
      .string()
      .optional()
      .describe('Expression to track. Required for trace_data.'),
    toSymbol: z
      .string()
      .optional()
      .describe('Target symbol. Required for trace_to_symbol.'),
    toFile: z
      .string()
      .optional()
      .describe('Target file to disambiguate trace_to_symbol.'),
  }),
)
type NavigateInputSchema = ReturnType<typeof navigateInputSchema>

const diagnosticsInputSchema = lazySchema(() =>
  z.strictObject({
    filePath: z.string().optional().describe('File to check'),
    directory: z
      .string()
      .optional()
      .describe('Directory to check. Mutually exclusive with filePath.'),
    severity: z
      .enum(['error', 'warning', 'information', 'hint', 'all'])
      .optional()
      .describe('Severity filter. Default: all.'),
    waitMs: z
      .number()
      .int()
      .positive()
      .max(10_000)
      .optional()
      .describe('Wait up to this many milliseconds for diagnostics.'),
  }),
)
type DiagnosticsInputSchema = ReturnType<typeof diagnosticsInputSchema>

function makeOutput(command: string, text: string): { data: AftOutput } {
  return { data: { command, text } }
}

function mapOutput(
  output: AftOutput,
  toolUseID: string,
): ToolResultBlockParam {
  return {
    tool_use_id: toolUseID,
    type: 'tool_result',
    content: output.text,
  }
}

function isHttpUrl(value: string): boolean {
  return value.startsWith('http://') || value.startsWith('https://')
}

function uniquePaths(paths: string[]): string[] {
  return Array.from(new Set(paths.filter(path => path.length > 0)))
}

function permissionForPath(
  tool: Tool,
  input: Record<string, unknown>,
  permissionContext: ToolPermissionContext,
  filePath: string,
): PermissionDecision {
  const proxyTool = {
    ...tool,
    getPath: () => filePath,
  } as Tool
  return checkReadPermissionForTool(proxyTool, input, permissionContext)
}

function checkReadPermissionsForPaths(
  tool: Tool,
  input: Record<string, unknown>,
  permissionContext: ToolPermissionContext,
  paths: string[],
): PermissionDecision {
  for (const filePath of uniquePaths(paths)) {
    if (isHttpUrl(filePath)) {
      return {
        behavior: 'deny',
        message:
          'AFT URL fetching is disabled in tau. Use WebFetch for remote URLs.',
      }
    }
    const decision = permissionForPath(tool, input, permissionContext, filePath)
    if (decision.behavior !== 'allow') return decision
  }
  return { behavior: 'allow', updatedInput: input }
}

async function validateExistingPath(
  rawPath: string | undefined,
  label: string,
): Promise<{ result: true } | { result: false; message: string; errorCode: number }> {
  if (!rawPath || isHttpUrl(rawPath)) return { result: true }
  const absolutePath = expandPath(rawPath)
  if (absolutePath.startsWith('\\\\') || absolutePath.startsWith('//')) {
    return { result: true }
  }
  try {
    await getFsImplementation().stat(absolutePath)
    return { result: true }
  } catch (error) {
    if (isENOENT(error)) {
      return {
        result: false,
        message: `${label} does not exist: ${rawPath}`,
        errorCode: 1,
      }
    }
    throw error
  }
}

async function pathIsDirectory(rawPath: string): Promise<boolean> {
  if (isHttpUrl(rawPath)) return false
  const absolutePath = expandPath(rawPath)
  if (absolutePath.startsWith('\\\\') || absolutePath.startsWith('//')) {
    return false
  }
  try {
    return (await getFsImplementation().stat(absolutePath)).isDirectory()
  } catch (error) {
    if (isENOENT(error)) return false
    throw error
  }
}

async function runAftText(
  command: string,
  params: Record<string, unknown>,
  formatter: (response: Record<string, unknown>) => string,
): Promise<{ data: AftOutput }> {
  try {
    const response = await callAftCommand(command, params)
    if (response.success === false) {
      return makeOutput(command, formatAftError(command, response))
    }
    return makeOutput(command, formatter(response))
  } catch (error) {
    return makeOutput(command, formatAftUnavailable(error))
  }
}

function isEmptyOutlineResponse(response: Record<string, unknown>): boolean {
  const text =
    typeof response.text === 'string' ? response.text.trim() : undefined
  const hasFiles = Array.isArray(response.files) && response.files.length > 0
  return text === '' && !hasFiles
}

async function runAftOutline(
  params: Record<string, unknown>,
  fallbackParams?: Record<string, unknown>,
): Promise<{ data: AftOutput }> {
  try {
    const response = await callAftCommand('outline', params)
    if (response.success === false) {
      return makeOutput('outline', formatAftError('outline', response))
    }

    if (fallbackParams && isEmptyOutlineResponse(response)) {
      const fallbackResponse = await callAftCommand('outline', fallbackParams)
      if (
        fallbackResponse.success !== false &&
        !isEmptyOutlineResponse(fallbackResponse)
      ) {
        return makeOutput('outline', formatOutlineResponse(fallbackResponse))
      }
    }

    return makeOutput('outline', formatOutlineResponse(response))
  } catch (error) {
    return makeOutput('outline', formatAftUnavailable(error))
  }
}

const OUTLINE_DESCRIPTION =
  'Read-only AFT code outline. Use this first when exploring a repository, package, directory, or file: it returns symbols, headings, file trees, and line ranges without reading full bodies. Prefer this before Read/Grep for architecture questions, locating likely files, or deciding which symbol to inspect next. Leave the files option unset unless you specifically need a file listing.'

export const AFTOutlineTool = buildTool({
  name: AFT_OUTLINE_TOOL_NAME,
  searchHint: 'symbol outline code structure file tree',
  alwaysLoad: true,
  maxResultSizeChars: 100_000,
  isEnabled: isAftEnabled,
  async description() {
    return OUTLINE_DESCRIPTION
  },
  async prompt() {
    return OUTLINE_DESCRIPTION
  },
  get inputSchema(): OutlineInputSchema {
    return outlineInputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  getPath(input) {
    const target = input.target
    return typeof target === 'string'
      ? expandPath(target)
      : target[0]
        ? expandPath(target[0])
        : getCwd()
  },
  async validateInput(input) {
    const first = Array.isArray(input.target) ? input.target[0] : input.target
    return validateExistingPath(first, 'Target')
  },
  async checkPermissions(input, context) {
    const paths = Array.isArray(input.target) ? input.target : [input.target]
    return checkReadPermissionsForPaths(
      AFTOutlineTool,
      input,
      context.getAppState().toolPermissionContext,
      paths,
    )
  },
  userFacingName,
  renderToolUseMessage: renderAftToolUseMessage,
  renderToolResultMessage: renderAftToolResultMessage,
  async call(input) {
    const target = input.target
    const params: Record<string, unknown> = {}
    let fallbackParams: Record<string, unknown> | undefined
    if (Array.isArray(target)) {
      if (input.files === true) {
        params.directories = target
        params.files = true
        fallbackParams = { files: target }
      } else {
        params.files = target
      }
    } else if (input.files === true) {
      params.directory = target
      params.files = true
      if (await pathIsDirectory(target)) fallbackParams = { directory: target }
    } else if (await pathIsDirectory(target)) {
      params.directory = target
    } else {
      params.file = target
    }
    return runAftOutline(params, fallbackParams)
  },
  mapToolResultToToolResultBlockParam: mapOutput,
} satisfies ToolDef<OutlineInputSchema, AftOutput>)

const ZOOM_DESCRIPTION =
  'Read-only AFT symbol zoom. Use after AFTOutline, Grep, or diagnostics identifies a file and symbol: it reads the exact function, class, method, or symbol with nearby context instead of reading the whole file. Prefer this over Read when you need implementation details for a known symbol; use targets for batch symbol inspection.'

export const AFTZoomTool = buildTool({
  name: AFT_ZOOM_TOOL_NAME,
  searchHint: 'read exact function class symbol body',
  alwaysLoad: true,
  maxResultSizeChars: 100_000,
  isEnabled: isAftEnabled,
  async description() {
    return ZOOM_DESCRIPTION
  },
  async prompt() {
    return ZOOM_DESCRIPTION
  },
  get inputSchema(): ZoomInputSchema {
    return zoomInputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  getPath(input) {
    if (input.filePath) return expandPath(input.filePath)
    const targets = input.targets
    const first = Array.isArray(targets) ? targets[0] : targets
    return first?.filePath ? expandPath(first.filePath) : getCwd()
  },
  async validateInput(input) {
    if (input.targets !== undefined && input.filePath !== undefined) {
      return {
        result: false,
        message: 'targets is mutually exclusive with filePath/symbols',
        errorCode: 2,
      }
    }
    if (input.targets === undefined && !input.filePath) {
      return {
        result: false,
        message: 'Provide filePath with symbols, or provide targets.',
        errorCode: 3,
      }
    }
    const first = input.filePath ?? (Array.isArray(input.targets) ? input.targets[0]?.filePath : input.targets?.filePath)
    return validateExistingPath(first, 'File')
  },
  async checkPermissions(input, context) {
    const paths =
      input.targets === undefined
        ? input.filePath
          ? [input.filePath]
          : []
        : Array.isArray(input.targets)
          ? input.targets.map(target => target.filePath)
          : [input.targets.filePath]
    return checkReadPermissionsForPaths(
      AFTZoomTool,
      input,
      context.getAppState().toolPermissionContext,
      paths,
    )
  },
  userFacingName,
  renderToolUseMessage: renderAftToolUseMessage,
  renderToolResultMessage: renderAftToolResultMessage,
  async call(input) {
    const contextLines = input.contextLines
    if (input.targets !== undefined) {
      const targets = Array.isArray(input.targets) ? input.targets : [input.targets]
      const sections: string[] = []
      for (const target of targets) {
        const params: Record<string, unknown> = {
          file: target.filePath,
          symbol: target.symbol,
          ...(contextLines ? { context_lines: contextLines } : {}),
        }
        const result = await runAftText('zoom', params, response =>
          formatZoomResponse(target.filePath, response),
        )
        sections.push(result.data.text)
      }
      return makeOutput('zoom', sections.join('\n\n'))
    }

    const symbols = input.symbols
    if (symbols === undefined) {
      return runAftText(
        'zoom',
        {
          file: input.filePath,
          ...(contextLines ? { context_lines: contextLines } : {}),
        },
        response => formatZoomResponse(input.filePath ?? 'file', response),
      )
    }

    const symbolList = Array.isArray(symbols) ? symbols : [symbols]
    const sections: string[] = []
    for (const symbol of symbolList) {
      const result = await runAftText(
        'zoom',
        {
          file: input.filePath,
          symbol,
          ...(contextLines ? { context_lines: contextLines } : {}),
        },
        response => formatZoomResponse(input.filePath ?? 'file', response),
      )
      sections.push(result.data.text)
    }
    return makeOutput('zoom', sections.join('\n\n'))
  },
  mapToolResultToToolResultBlockParam: mapOutput,
} satisfies ToolDef<ZoomInputSchema, AftOutput>)

const AST_SEARCH_DESCRIPTION =
  'Read-only AFT AST search. Use when you need syntax-aware matches such as function calls, imports, JSX props, class methods, or refactor targets where plain Grep would be noisy. Patterns must be valid code shapes with ast-grep meta variables like $VAR or $$$; use Grep instead for simple literal text.'

export const AFTAstSearchTool = buildTool({
  name: AFT_AST_SEARCH_TOOL_NAME,
  searchHint: 'AST structural code pattern search',
  alwaysLoad: true,
  maxResultSizeChars: 100_000,
  isEnabled: isAftEnabled,
  async description() {
    return AST_SEARCH_DESCRIPTION
  },
  async prompt() {
    return AST_SEARCH_DESCRIPTION
  },
  get inputSchema(): AstSearchInputSchema {
    return astSearchInputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  getPath(input) {
    return input.paths?.[0] ? expandPath(input.paths[0]) : getCwd()
  },
  async checkPermissions(input, context) {
    return checkReadPermissionsForPaths(
      AFTAstSearchTool,
      input,
      context.getAppState().toolPermissionContext,
      input.paths?.length ? input.paths : [getCwd()],
    )
  },
  userFacingName,
  renderToolUseMessage: renderAftToolUseMessage,
  renderToolResultMessage: renderAftToolResultMessage,
  async call(input) {
    return runAftText(
      'ast_search',
      {
        pattern: input.pattern,
        lang: input.lang,
        ...(input.paths ? { paths: input.paths } : {}),
        ...(input.globs ? { globs: input.globs } : {}),
        ...(input.contextLines ? { context: input.contextLines } : {}),
      },
      formatAstSearchResponse,
    )
  },
  mapToolResultToToolResultBlockParam: mapOutput,
} satisfies ToolDef<AstSearchInputSchema, AftOutput>)

const NAVIGATE_DESCRIPTION =
  'Read-only AFT call-graph navigation. Use after you know the filePath and symbol and need callers, call trees, impact, traces, or data-flow context across the codebase. Do not use this for simple text search; first identify the symbol with AFTOutline, AFTZoom, Grep, or diagnostics, then choose the specific navigation op.'

export const AFTNavigateTool = buildTool({
  name: AFT_NAVIGATE_TOOL_NAME,
  searchHint: 'call graph callers impact trace symbol',
  alwaysLoad: true,
  maxResultSizeChars: 100_000,
  isEnabled: isAftEnabled,
  async description() {
    return NAVIGATE_DESCRIPTION
  },
  async prompt() {
    return NAVIGATE_DESCRIPTION
  },
  get inputSchema(): NavigateInputSchema {
    return navigateInputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  getPath(input) {
    return expandPath(input.filePath)
  },
  async validateInput(input) {
    if (input.op === 'trace_data' && !input.expression) {
      return {
        result: false,
        message: 'expression is required for trace_data',
        errorCode: 2,
      }
    }
    if (input.op === 'trace_to_symbol' && !input.toSymbol) {
      return {
        result: false,
        message: 'toSymbol is required for trace_to_symbol',
        errorCode: 3,
      }
    }
    return validateExistingPath(input.filePath, 'File')
  },
  async checkPermissions(input, context) {
    return checkReadPermissionsForPaths(
      AFTNavigateTool,
      input,
      context.getAppState().toolPermissionContext,
      [input.filePath],
    )
  },
  userFacingName,
  renderToolUseMessage: renderAftToolUseMessage,
  renderToolResultMessage: renderAftToolResultMessage,
  async call(input) {
    return runAftText(
      input.op,
      {
        file: input.filePath,
        symbol: input.symbol,
        ...(input.depth ? { depth: input.depth } : {}),
        ...(input.expression ? { expression: input.expression } : {}),
        ...(input.toSymbol ? { toSymbol: input.toSymbol } : {}),
        ...(input.toFile ? { toFile: input.toFile } : {}),
      },
      formatJsonResponse,
    )
  },
  mapToolResultToToolResultBlockParam: mapOutput,
} satisfies ToolDef<NavigateInputSchema, AftOutput>)

const DIAGNOSTICS_DESCRIPTION =
  'Read-only AFT diagnostics. Use to ask available language servers for errors, warnings, and hints in a file or directory, especially after edits or when investigating type/lint-like problems. This is not a replacement for tests or builds; use it as a fast static check and fall back to normal commands when runtime verification is needed.'

export const AFTDiagnosticsTool = buildTool({
  name: AFT_DIAGNOSTICS_TOOL_NAME,
  searchHint: 'LSP diagnostics errors warnings code',
  alwaysLoad: true,
  maxResultSizeChars: 100_000,
  isEnabled: isAftEnabled,
  async description() {
    return DIAGNOSTICS_DESCRIPTION
  },
  async prompt() {
    return DIAGNOSTICS_DESCRIPTION
  },
  get inputSchema(): DiagnosticsInputSchema {
    return diagnosticsInputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  getPath(input) {
    return expandPath(input.filePath ?? input.directory ?? getCwd())
  },
  async validateInput(input) {
    if (input.filePath && input.directory) {
      return {
        result: false,
        message: 'filePath and directory are mutually exclusive',
        errorCode: 2,
      }
    }
    return validateExistingPath(input.filePath ?? input.directory, 'Path')
  },
  async checkPermissions(input, context) {
    return checkReadPermissionsForPaths(
      AFTDiagnosticsTool,
      input,
      context.getAppState().toolPermissionContext,
      [input.filePath ?? input.directory ?? getCwd()],
    )
  },
  userFacingName,
  renderToolUseMessage: renderAftToolUseMessage,
  renderToolResultMessage: renderAftToolResultMessage,
  async call(input) {
    return runAftText(
      'lsp_diagnostics',
      {
        ...(input.filePath ? { file: input.filePath } : {}),
        ...(input.directory ? { directory: input.directory } : {}),
        ...(input.severity ? { severity: input.severity } : {}),
        ...(input.waitMs ? { wait_ms: input.waitMs } : {}),
      },
      formatJsonResponse,
    )
  },
  mapToolResultToToolResultBlockParam: mapOutput,
} satisfies ToolDef<DiagnosticsInputSchema, AftOutput>)

export const AFT_READ_ONLY_TOOLS = [
  AFTOutlineTool,
  AFTZoomTool,
  AFTAstSearchTool,
  AFTNavigateTool,
  AFTDiagnosticsTool,
] as const
