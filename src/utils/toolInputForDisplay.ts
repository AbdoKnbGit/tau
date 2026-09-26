/**
 * The input a tool call is shown with: the one it runs with.
 *
 * Execution repairs what a model sent before validating it (see
 * toolExecution: coerceToolInput, then optional placeholders the schema
 * rejects read as omitted). The display parsed the raw input instead, so a
 * call that ran fine failed to parse there — a strict-mode lane's
 * `{"skill": "x", "args": null}` — lost its `● Skill(x)` row, and left its
 * result line under the previous tool's, naming nothing.
 *
 * A raw input that parses is shown as it is. Only a failing one goes through
 * the same repair as execution; if that fails too, the raw result stands.
 */

import type { ZodTypeAny } from 'zod/v4'
import { coerceToolInput } from './coerceToolInput.js'
import {
  dropInvalidPlaceholderArguments,
  zodArgumentJudge,
} from './placeholderArguments.js'

type DisplayParse =
  | { success: true; data: unknown }
  | { success: false; error?: { issues?: unknown } }

type DisplayTool = {
  inputSchema: { safeParse(input: unknown): DisplayParse }
  inputJSONSchema?: unknown
  advisoryInputFields?: readonly string[]
}

export function parseToolInputForDisplay<T extends DisplayTool>(
  tool: T,
  input: unknown,
): ReturnType<T['inputSchema']['safeParse']> {
  const raw = tool.inputSchema.safeParse(input) as ReturnType<T['inputSchema']['safeParse']>
  if (raw.success || !input || typeof input !== 'object' || Array.isArray(input)) {
    return raw
  }
  try {
    // Same schema execution validates with: unknown top-level keys dropped,
    // except for tools whose real contract is a JSON Schema.
    const schema = tool.inputSchema as DisplayTool['inputSchema'] & { strip?: () => DisplayTool['inputSchema'] }
    const stripped = !tool.inputJSONSchema && typeof schema.strip === 'function' ? schema.strip() : schema
    const coerced = coerceToolInput(
      input as Record<string, unknown>,
      tool.inputSchema as unknown as ZodTypeAny,
    )
    const repaired = dropInvalidPlaceholderArguments(coerced, zodArgumentJudge(stripped), {
      advisoryFields: tool.advisoryInputFields,
    }).input
    const parsed = stripped.safeParse(repaired)
    return (parsed.success ? parsed : raw) as ReturnType<T['inputSchema']['safeParse']>
  } catch {
    return raw
  }
}
