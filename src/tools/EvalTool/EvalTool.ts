import { z } from 'zod/v4'

import { buildTool, type ToolDef } from '../../Tool.js'
import { getCwd } from '../../utils/cwd.js'
import { lazySchema } from '../../utils/lazySchema.js'
import type { PermissionResult } from '../../utils/permissions/PermissionResult.js'
import { EVAL_TOOL_NAME } from './constants.js'
import { clampOutput, resolveTimeoutMs, summarizeBridgeCalls } from './format.js'
import { DESCRIPTION, PROMPT } from './prompt.js'
import { isEvalToolEnabled } from './pythonRuntime.js'
import { acquireKernel, discardKernel } from './registry.js'
import { DeadlineBudget, registerBridgeSession } from './toolBridge.js'
import {
  extractSearchText,
  isResultTruncated,
  renderToolResultMessage,
  renderToolUseMessage,
} from './UI.js'
import type { BridgeCallRecord } from './format.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    code: z
      .string()
      .min(1)
      .describe('Python source for this cell. Runs in the persistent kernel.'),
    title: z
      .string()
      .optional()
      .describe('Short label for what this cell does, shown to the user.'),
    timeout: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        'Seconds before the cell is interrupted. Default 60. 0 disables the deadline.',
      ),
    reset: z
      .boolean()
      .optional()
      .describe(
        'Restart the kernel with an empty namespace before running. Discards all state.',
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    ok: z.boolean(),
    text: z.string(),
    images: z.array(z.object({ mime: z.string(), data: z.string() })),
    bridgeCalls: z.array(
      z.object({
        name: z.string(),
        detail: z.string(),
        ms: z.number(),
        error: z.string().optional(),
      }),
    ),
    durationMs: z.number(),
    cancelled: z.boolean(),
    timedOut: z.boolean(),
    kernelRestarted: z.boolean(),
    truncated: z.boolean(),
    syntaxError: z.boolean(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type EvalOutput = z.infer<OutputSchema>

export const EvalTool = buildTool({
  name: EVAL_TOOL_NAME,
  searchHint: 'python kernel notebook data analysis chart',
  /**
   * Never persist the result to disk. Two reasons: the cell output is already
   * self-bounded by `clampOutput`, and a captured figure is a base64 image
   * block — spilling that to a file would replace the picture with a path and
   * defeat the inline rendering the whole feature exists to feed. Same
   * reasoning FileReadTool uses for its own Infinity.
   */
  maxResultSizeChars: Number.POSITIVE_INFINITY,
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
  isEnabled() {
    return isEvalToolEnabled()
  },
  userFacingName() {
    return 'Python'
  },
  isReadOnly() {
    return false
  },
  /**
   * Exclusive. One kernel, one namespace, one cell at a time — two cells
   * running concurrently against the same globals would interleave
   * unpredictably. `StreamingToolExecutor` honors this by running the tool
   * alone.
   */
  isConcurrencySafe() {
    return false
  },
  isDestructive() {
    return false
  },
  /** A new user message should stop the cell rather than queue behind it. */
  interruptBehavior() {
    return 'cancel' as const
  },
  /**
   * The cell source IS the classifier input. `permissions.ts` states the
   * requirement directly: kernel code can do things between its tool calls, so
   * the classifier must see the glue, not just the calls.
   */
  toAutoClassifierInput(input) {
    return input.code
  },
  /**
   * Deliberately `passthrough`, not the `allow` default.
   *
   * The default would auto-approve arbitrary code execution without ever
   * prompting. `passthrough` becomes `ask` at step 3 of the permission
   * pipeline — the same treatment an unrecognized Bash command gets. Users who
   * want it silent can allowlist `Eval`; bypass modes still short-circuit at
   * step 2a.
   */
  async checkPermissions(): Promise<PermissionResult> {
    return {
      behavior: 'passthrough',
      message: 'Run Python in the persistent kernel',
    }
  },
  // Rendering lives in UI.tsx: the header line, the cell source, its output,
  // captured figures, and the bridged tool calls. Keeping it here would mean a
  // .ts file importing JSX.
  renderToolUseMessage,
  renderToolResultMessage,
  extractSearchText,
  isResultTruncated,
  async call(input, toolUseContext, canUseTool, parentMessage) {
    const startedAt = Date.now()
    const cwd = getCwd()
    const agentId = toolUseContext.agentId
    const { kernel, sessionKey, restarted } = await acquireKernel({
      agentId,
      cwd,
      reset: input.reset === true,
    })

    const bridgeCalls: BridgeCallRecord[] = []
    const budget = new DeadlineBudget()
    const unregister = registerBridgeSession(sessionKey, {
      tools: toolUseContext.options.tools,
      toolUseContext,
      canUseTool,
      parentMessage,
      signal: toolUseContext.abortController.signal,
      onCall: record => bridgeCalls.push(record),
      budget,
    })

    try {
      const outcome = await kernel.execute(input.code, {
        timeoutMs: resolveTimeoutMs(input.timeout),
        signal: toolUseContext.abortController.signal,
        budget,
      })

      if (outcome.crashed) {
        // The kernel is unusable; make sure the next call gets a fresh one
        // instead of retrying against a corpse.
        discardKernel(agentId, cwd)
      }

      const segments: string[] = []
      if (outcome.stdout) segments.push(outcome.stdout.replace(/\n+$/, ''))
      if (outcome.stderr) segments.push(outcome.stderr.replace(/\n+$/, ''))
      if (outcome.result !== undefined) segments.push(`=> ${outcome.result}`)
      if (outcome.error) {
        segments.push(
          outcome.error.traceback ||
            `${outcome.error.ename}: ${outcome.error.evalue}`,
        )
      }
      for (const status of outcome.statuses) {
        if (status.op === 'log') segments.push(`[log] ${status.detail}`)
      }
      const textDisplays = outcome.displays.filter(
        display => !display.mime.startsWith('image/'),
      )
      for (const display of textDisplays) segments.push(display.data)

      const joined = segments.join('\n').trim()
      const withBridge = `${joined}${summarizeBridgeCalls(bridgeCalls)}`
      const clamped = clampOutput(
        withBridge.trim() ||
          (outcome.ok
            ? '(cell produced no output — print() what you want to see)'
            : '(no output)'),
      )

      return {
        data: {
          ok: outcome.ok,
          text: clamped.text,
          images: outcome.displays
            .filter(display => display.mime.startsWith('image/'))
            .map(display => ({ mime: display.mime, data: display.data })),
          bridgeCalls,
          durationMs: Date.now() - startedAt,
          cancelled: outcome.cancelled,
          timedOut: outcome.timedOut,
          kernelRestarted: restarted || outcome.crashed,
          truncated: clamped.truncated,
          syntaxError: outcome.error?.ename === 'SyntaxError' ||
            outcome.error?.ename === 'IndentationError',
        } satisfies EvalOutput,
      }
    } finally {
      unregister()
    }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    const notes: string[] = []
    if (output.timedOut) {
      notes.push(
        'The cell hit its deadline and was interrupted. The kernel is still running and its variables survive — raise `timeout` or do less per cell.',
      )
    } else if (output.cancelled) {
      notes.push('The cell was interrupted before it finished.')
    }
    if (output.kernelRestarted) {
      notes.push(
        'The kernel was restarted, so the namespace is empty. Re-run your setup before continuing.',
      )
    }
    if (output.syntaxError) {
      // A cell is parsed in full before any of it runs, so a single stray
      // character aborts the whole thing. Without saying so, the model tends
      // to re-send its setup along with the fix, paying for it twice.
      notes.push(
        'The cell failed to parse, so NOTHING in it ran and the kernel namespace is unchanged. Fix the syntax and re-send only this cell — do not repeat setup from earlier cells.',
      )
    }

    const text = notes.length > 0 ? `${output.text}\n\n${notes.join('\n')}` : output.text

    if (output.images.length === 0) {
      return { type: 'tool_result', tool_use_id: toolUseID, content: text }
    }
    return {
      type: 'tool_result',
      tool_use_id: toolUseID,
      content: [
        { type: 'text' as const, text },
        ...output.images.map(image => ({
          type: 'image' as const,
          source: {
            type: 'base64' as const,
            data: image.data,
            media_type: image.mime as 'image/png' | 'image/jpeg',
          },
        })),
      ],
    }
  },
} satisfies ToolDef<InputSchema, EvalOutput>)
