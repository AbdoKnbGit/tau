import { resolve } from 'node:path'

export type SkillMetadata = {
  path?: string
  frontmatter: Record<string, unknown>
  frontmatterProblem?: string
}

/** Snapshot file metadata without exposing YAML aliases or non-JSON values to mods. */
export function createSkillMetadata(
  frontmatter: Record<string, unknown>,
  path?: string,
  problem?: string,
): SkillMetadata {
  let remaining = 10_000
  const ancestors = new Set<object>()
  function copy(value: unknown, depth: number): unknown {
    if (--remaining < 0 || depth > 64)
      throw new Error('exceeds the plain-data size or nesting limit')
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'boolean'
    )
      return value
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value !== 'object' || !value)
      throw new Error('contains a value that is not plain data')
    if (ancestors.has(value)) throw new Error('contains a circular YAML alias')
    if (
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    )
      throw new Error('contains a value that is not a plain object')
    ancestors.add(value)
    try {
      return Array.isArray(value)
        ? value.map(item => copy(item, depth + 1))
        : Object.fromEntries(
            Object.entries(value).map(([key, item]) => [
              key,
              copy(item, depth + 1),
            ]),
          )
    } finally {
      ancestors.delete(value)
    }
  }
  const entries: [string, unknown][] = []
  for (const [key, value] of Object.entries(frontmatter)) {
    try {
      entries.push([key, copy(value, 0)])
    } catch (error) {
      problem ??= `Key ${JSON.stringify(key)} ${error instanceof Error ? error.message : String(error)}`
    }
  }
  return {
    ...(path ? { path: resolve(path) } : {}),
    frontmatter: Object.fromEntries(entries),
    ...(problem ? { frontmatterProblem: problem } : {}),
  }
}
