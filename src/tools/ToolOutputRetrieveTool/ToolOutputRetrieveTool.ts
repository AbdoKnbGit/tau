import { createElement } from 'react'
import { z } from 'zod/v4'

import { buildTool, type ToolDef } from '../../Tool.js'
import { Text } from '../../ink.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { retrievePersistedToolResult } from '../../utils/toolResultStorage.js'
import { TOOL_OUTPUT_RETRIEVE_TOOL_NAME } from './constants.js'

const DESCRIPTION =
  'Recover a bounded range from a persisted Tau tool output, background task output, or artifact. Read-only.'

const PROMPT = `Read a bounded range from persisted Tau tool/background output or a project .tau artifact. For ordinary files use Read. Use only a path or id an earlier result reported (e.g. a "Full output saved to:" line); never build one from a tool_use id in history. Supply path or toolUseId; when both are set, path is tried first and the id is fallback. Prefer the smallest byte/line range. Cheap mode caps each returned page/search at 8000 bytes; continue from the reported range when needed. To find a known string, use query: it is literal and case-insensitive, searches the whole output, returns matching numbered lines, and overrides range fields. After zero matches, use the reported line count to choose one range instead of probing repeatedly.`

function renderText(message: string): React.ReactNode {
  return createElement(Text, null, message)
}

const inputSchema = lazySchema(() =>
  z.strictObject({
    path: z
      .string()
      .optional()
      .describe('Saved-output, task .output, or .tau artifact path'),
    toolUseId: z
      .string()
      .optional()
      .describe('Tool/background task id; fallback when path is also set'),
    startByte: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Zero-based byte offset; default 0'),
    maxBytes: z
      .number()
      .int()
      .min(1)
      .max(100_000)
      .optional()
      .describe('Max bytes; normal default 20000/max 100000; cheap caps 8000'),
    startLine: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('One-based first line; enables line mode'),
    lineCount: z
      .number()
      .int()
      .min(1)
      .max(2_000)
      .optional()
      .describe('Max lines; default 200, max 2000'),
    query: z
      .string()
      .optional()
      .describe('Literal case-insensitive search; overrides ranges'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    ok: z.boolean(),
    path: z.string().optional(),
    totalBytes: z.number().optional(),
    range: z.string().optional(),
    content: z.string().optional(),
    truncated: z.boolean().optional(),
    error: z.string().optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

export const ToolOutputRetrieveTool = buildTool({
  name: TOOL_OUTPUT_RETRIEVE_TOOL_NAME,
  searchHint: 'recover compressed tool output',
  maxResultSizeChars: 130_000,
  shouldDefer: true,
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return PROMPT
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return 'Reading saved tool output'
  },
  isReadOnly() {
    return true
  },
  isConcurrencySafe() {
    return true
  },
  toAutoClassifierInput(input) {
    return `${input.path ?? ''} ${input.toolUseId ?? ''}`.trim()
  },
  async validateInput(input) {
    if (!input.path?.trim() && !input.toolUseId?.trim()) {
      return {
        result: false,
        message: 'ToolOutputRetrieve requires either path or toolUseId.',
        errorCode: 1,
      }
    }
    if (input.query !== undefined && !input.query.trim()) {
      return {
        result: false,
        message: 'query must not be empty. Omit it to read a byte or line range.',
        errorCode: 1,
      }
    }
    // Both provided is fine: resolution tries the path first, then falls back
    // to the toolUseId. Hard-erroring here just made models loop on retries.
    return { result: true }
  },
  renderToolUseMessage(input) {
    const source = input.path ?? input.toolUseId
    return renderText(
      input.query?.trim()
        ? `Searching saved output from ${source} for "${input.query.trim()}"`
        : `Reading saved output from ${source}`,
    )
  },
  renderToolResultMessage(output) {
    if (!output.ok) return renderText(output.error ?? 'Unable to read saved output')
    return renderText(
      `${output.range ?? 'range'} from ${output.totalBytes ?? 0} byte saved output`,
    )
  },
  async call(input) {
    const result = await retrievePersistedToolResult(input)
    return { data: result }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    if (!output.ok) {
      return {
        type: 'tool_result',
        tool_use_id: toolUseID,
        is_error: true,
        content: output.error ?? 'Unable to read saved output.',
      }
    }
    const lines = [
      `Path: ${output.path}`,
      `Total bytes: ${output.totalBytes}`,
      `Range: ${output.range}`,
      `Truncated: ${output.truncated ? 'yes' : 'no'}`,
      '',
      output.content ?? '',
    ]
    return { type: 'tool_result', tool_use_id: toolUseID, content: lines.join('\n') }
  },
} satisfies ToolDef<InputSchema, Output>)
