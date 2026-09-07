/**
 * Rule-file dialects written by other coding agents, read in place.
 *
 * Each tool spells "which files does this rule apply to" differently, and each
 * has its own answer for what an *unscoped* rule means. Getting that second
 * half wrong is the expensive mistake: tau's memory loader treats a rule with
 * no globs as unconditional and puts it in the cached system prompt, so a
 * dialect whose unscoped rules are meant to stay dormant would have every one
 * of them injected into every request forever.
 *
 * Cursor and Copilot both have dormant-by-default rules, so they are marked
 * `inert` and skipped rather than promoted. The model can still read those
 * files on request — they are ordinary files in the repo — they just are not
 * force-fed.
 *
 * Project-scoped only. The user-level locations these tools also support
 * (~/.cursor/rules, ~/.codeium/windsurf/memories, ...) are deliberately not
 * read: they are edited for a different tool's benefit, and letting them move
 * tau's cached prompt prefix would be both surprising and expensive.
 */

import { splitPathInFrontmatter } from './frontmatterParser.js'

/** What a rule file's frontmatter says about when it applies. */
export type ForeignRuleActivation =
  /** Always in context — joins the unconditional memory set. */
  | { kind: 'always' }
  /** Applies to matching files — loaded lazily, costs nothing until matched. */
  | { kind: 'conditional'; paths: string[] }
  /** Dormant by this tool's own rules — not loaded at all. */
  | { kind: 'inert'; reason: string }

/**
 * A rule dialect: the frontmatter keys that scope a rule, and what this tool
 * does with a rule that declares no scope at all.
 */
export type ForeignRuleDialect = {
  id: string
  /** Frontmatter keys that carry path globs, checked in order. */
  pathKeys: readonly string[]
  /**
   * Meaning of a file with no usable scope key.
   * 'always'  — the tool applies it unconditionally (Cline, Windsurf).
   * 'inert'   — the tool leaves it dormant until asked for (Cursor, Copilot).
   */
  unscoped: 'always' | 'inert'
  /**
   * Whether `alwaysApply` / `trigger` in this dialect mean anything. Native tau
   * rules are scoped by `paths:` alone, so those keys stay inert data there —
   * a CLAUDE.md rule that happens to carry `alwaysApply: true` alongside
   * `paths:` must keep behaving exactly as it did before this existed.
   */
  honorsActivationMarkers: boolean
}

/** Native tau rules: only `paths:`, unscoped means unconditional. */
export const NATIVE_DIALECT: ForeignRuleDialect = {
  id: 'claude',
  pathKeys: ['paths'],
  unscoped: 'always',
  honorsActivationMarkers: false,
}

/**
 * Cursor `.cursor/rules/*.mdc`.
 *
 * Four rule types share one file format. `alwaysApply: true` is Always;
 * `globs` is Auto-Attached. The other two — Agent Requested (description only)
 * and Manual (@-mention only) — are deliberately kept out of context by Cursor,
 * so they are inert here.
 */
export const CURSOR_DIALECT: ForeignRuleDialect = {
  id: 'cursor',
  pathKeys: ['globs'],
  unscoped: 'inert',
  honorsActivationMarkers: true,
}

/**
 * Copilot `.github/instructions/*.instructions.md`.
 *
 * GitHub's documentation is explicit that omitting `applyTo` means the file
 * "does nothing automatically", so an unscoped instruction file is inert.
 */
export const COPILOT_INSTRUCTIONS_DIALECT: ForeignRuleDialect = {
  id: 'copilot-instructions',
  pathKeys: ['applyTo'],
  unscoped: 'inert',
  honorsActivationMarkers: true,
}

/**
 * Cline `.clinerules/*.md`.
 *
 * Cline merges every file in the folder by default, so unscoped means always;
 * a file may narrow itself with path frontmatter.
 */
export const CLINE_DIALECT: ForeignRuleDialect = {
  id: 'cline',
  pathKeys: ['paths', 'globs'],
  unscoped: 'always',
  honorsActivationMarkers: true,
}

/**
 * Windsurf `.windsurf/rules/*.md`.
 *
 * Activation is driven by a `trigger` field (always_on / glob / manual /
 * model_decision) which `classifyForeignRule` handles before the path keys.
 * A file with neither trigger nor globs follows Windsurf's unfrontmattered
 * behavior and is always on.
 */
export const WINDSURF_DIALECT: ForeignRuleDialect = {
  id: 'windsurf',
  pathKeys: ['globs'],
  unscoped: 'always',
  honorsActivationMarkers: true,
}

/**
 * Normalizes raw frontmatter glob input into tau's pattern shape.
 *
 * Mirrors the normalization `parseFrontmatterPaths` applies to `paths:`: a
 * trailing `/**` is dropped because the matcher already treats a directory as
 * covering its contents, and an all-`**` pattern set means "everything", which
 * is unconditional rather than conditional.
 */
export function normalizeRulePatterns(
  input: unknown,
): { kind: 'none' } | { kind: 'all' } | { kind: 'patterns'; paths: string[] } {
  if (input === undefined || input === null || input === '') {
    return { kind: 'none' }
  }
  if (typeof input !== 'string' && !Array.isArray(input)) {
    return { kind: 'none' }
  }
  const patterns = splitPathInFrontmatter(input as string | string[])
    .map(pattern => (pattern.endsWith('/**') ? pattern.slice(0, -3) : pattern))
    .filter(pattern => pattern.length > 0)

  if (patterns.length === 0) {
    return { kind: 'none' }
  }
  if (patterns.every(pattern => pattern === '**')) {
    return { kind: 'all' }
  }
  return { kind: 'patterns', paths: patterns }
}

/** Normalizes a Windsurf `trigger` value; returns undefined when absent. */
function readTrigger(frontmatter: Record<string, unknown>): string | undefined {
  const raw = frontmatter.trigger
  return typeof raw === 'string' && raw.trim().length > 0
    ? raw.trim().toLowerCase()
    : undefined
}

/**
 * Decides when a rule file applies, from its frontmatter and its dialect.
 *
 * Order matters. An explicit always-on marker outranks a glob list (Cursor
 * documents Always as winning over Auto-Attached), and an explicit dormant
 * marker outranks the dialect's unscoped default.
 */
export function classifyForeignRule(
  frontmatter: Record<string, unknown>,
  dialect: ForeignRuleDialect,
): ForeignRuleActivation {
  const markers = dialect.honorsActivationMarkers
  if (markers && frontmatter.alwaysApply === true) {
    return { kind: 'always' }
  }

  const trigger = markers ? readTrigger(frontmatter) : undefined
  if (trigger === 'always_on' || trigger === 'always') {
    return { kind: 'always' }
  }
  if (trigger === 'manual') {
    return { kind: 'inert', reason: 'trigger: manual' }
  }
  if (trigger === 'model_decision') {
    return { kind: 'inert', reason: 'trigger: model_decision' }
  }

  for (const key of dialect.pathKeys) {
    const normalized = normalizeRulePatterns(frontmatter[key])
    if (normalized.kind === 'all') {
      // `applyTo: "**"` is Copilot's way of saying "every file".
      return { kind: 'always' }
    }
    if (normalized.kind === 'patterns') {
      return { kind: 'conditional', paths: normalized.paths }
    }
  }

  // `trigger: glob` with no usable globs scopes to nothing; treat it as
  // dormant rather than silently promoting it to always-on.
  if (trigger === 'glob') {
    return { kind: 'inert', reason: 'trigger: glob with no globs' }
  }

  if (dialect.unscoped === 'inert') {
    return {
      kind: 'inert',
      reason: `no ${dialect.pathKeys.join('/')} and not alwaysApply`,
    }
  }
  return { kind: 'always' }
}

/**
 * A directory of rule files another tool maintains, relative to a project
 * directory. Every file found is classified by its dialect, so scoped rules
 * land in the lazy set and unscoped ones follow the dialect's default.
 */
export type ForeignRuleDirSource = {
  /** Path segments below the project directory. */
  segments: readonly string[]
  /** Filename suffixes to accept. */
  extensions: readonly string[]
  dialect: ForeignRuleDialect
}

export const FOREIGN_RULE_DIR_SOURCES: readonly ForeignRuleDirSource[] = [
  {
    segments: ['.cursor', 'rules'],
    extensions: ['.mdc', '.md'],
    dialect: CURSOR_DIALECT,
  },
  {
    segments: ['.github', 'instructions'],
    extensions: ['.instructions.md'],
    dialect: COPILOT_INSTRUCTIONS_DIALECT,
  },
  {
    segments: ['.windsurf', 'rules'],
    extensions: ['.md'],
    dialect: WINDSURF_DIALECT,
  },
]

/**
 * Whole-project instruction files other tools keep at the project root.
 *
 * Read as a fallback chain — the first hit in a directory wins and the rest are
 * skipped — and only when that directory produced no native instructions
 * (CLAUDE.md, .claude/rules, AGENTS.md) of its own. These files all mean "apply
 * to the entire project", so a repo that accumulated several across tool
 * migrations would otherwise pay for near-identical copies of the same guidance
 * in its cached prompt prefix on every request. The maintained file is the one
 * the current tool reads; the leftovers are usually stale.
 */
export type ForeignGenericSource = {
  /** Path segments below the project directory. */
  segments: readonly string[]
  /**
   * 'file' — read the path itself.
   * 'file-or-dir' — a path that may be a single file or a directory of rules.
   */
  shape: 'file' | 'file-or-dir'
  /** Filename suffixes accepted when the path turns out to be a directory. */
  extensions: readonly string[]
  dialect: ForeignRuleDialect
}

export const FOREIGN_GENERIC_SOURCES: readonly ForeignGenericSource[] = [
  {
    segments: ['.github', 'copilot-instructions.md'],
    shape: 'file',
    extensions: [],
    dialect: NATIVE_DIALECT,
  },
  {
    segments: ['.clinerules'],
    shape: 'file-or-dir',
    extensions: ['.md', '.txt'],
    dialect: CLINE_DIALECT,
  },
  {
    segments: ['.windsurfrules'],
    shape: 'file',
    extensions: [],
    dialect: NATIVE_DIALECT,
  },
]

/**
 * Picks the dialect a file should be read with, from where it sits.
 *
 * A file's location is what identifies its author tool, so detection is by
 * path rather than by threading a dialect through the loader. Anything that
 * matches no foreign location reads as native, which keeps CLAUDE.md and
 * .claude/rules behavior byte-identical.
 */
export function dialectForPath(filePath: string): ForeignRuleDialect {
  const parts = filePath.replaceAll('\\', '/').split('/')
  // Walk the ancestors so a rule nested inside a source directory still
  // resolves (Cursor and Windsurf both allow subfolders of rules).
  for (const source of FOREIGN_RULE_DIR_SOURCES) {
    const [dirName, subDirName] = source.segments
    for (let i = 0; i < parts.length - 1; i++) {
      if (parts[i] !== dirName) continue
      if (subDirName !== undefined && parts[i + 1] !== subDirName) continue
      return source.dialect
    }
  }
  if (parts.length >= 2 && parts[parts.length - 2] === '.clinerules') {
    return CLINE_DIALECT
  }
  return NATIVE_DIALECT
}
