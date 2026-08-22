/**
 * Repair the small set of common discovery-call aliases in code. The public
 * schema stays `{query, max_results}`; accepting these aliases does not teach
 * the model another dialect or add them to every request.
 */
export function normalizeToolSearchInput(input: unknown): unknown {
  if (typeof input === 'string' && input.trim()) {
    return { query: input.trim() }
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input

  const record = input as Record<string, unknown>
  if (typeof record.query === 'string' && record.query.trim()) return record

  for (const key of ['search', 'keywords'] as const) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) {
      return { ...record, query: value.trim() }
    }
  }

  for (const key of ['tool_name', 'tool', 'name', 'tool_names', 'tools'] as const) {
    const value = record[key]
    const names = Array.isArray(value)
      ? value.filter((v): v is string => typeof v === 'string' && !!v.trim())
      : typeof value === 'string' && value.trim()
        ? value.split(',').map(v => v.trim()).filter(Boolean)
        : []
    if (names.length > 0) {
      return { ...record, query: `select:${names.join(',')}` }
    }
  }

  return record
}
