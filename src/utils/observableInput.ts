/**
 * Keep observer-only tool input fields out of API requests.
 *
 * A tool may backfill legacy or derived fields into a tool_use input for its
 * observers (SDK stream, transcript, hooks). query.ts applies that backfill to
 * a clone and yields the clone, and the yielded clone is what the REPL keeps.
 * From the next turn on, the provider would receive a tool call the model
 * never wrote, which changes the bytes of an already-cached turn.
 *
 * Only keys outside the tool's input schema are candidates, and they are
 * dropped only when re-running the tool's own backfill on what remains
 * reproduces the input exactly. Anything the model itself sent is kept.
 */

type BackfillingTool = {
  backfillObservableInput?(input: Record<string, unknown>): void
  inputSchema?: unknown
}

export function stripObservableBackfill<I>(tool: BackfillingTool, input: I): I {
  if (!tool.backfillObservableInput) return input
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input
  const shape = (tool.inputSchema as { shape?: unknown } | undefined)?.shape
  if (!shape || typeof shape !== 'object') return input

  const record = input as Record<string, unknown>
  const extraKeys = Object.keys(record).filter(key => !Object.hasOwn(shape, key))
  if (extraKeys.length === 0) return input

  const original: Record<string, unknown> = { ...record }
  for (const key of extraKeys) delete original[key]
  const rebuilt: Record<string, unknown> = { ...original }
  try {
    tool.backfillObservableInput(rebuilt)
  } catch {
    return input
  }
  return JSON.stringify(rebuilt) === JSON.stringify(record) ? (original as I) : input
}
