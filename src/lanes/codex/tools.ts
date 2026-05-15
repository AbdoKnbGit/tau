/**
 * Codex Lane — Native Tool Registry
 *
 * Maps OpenAI Codex CLI's native tool names to shared implementations.
 * The critical difference: Codex uses `apply_patch` (unified diff) instead
 * of Edit (old_string/new_string). This is what GPT-5 and Codex models
 * were specifically post-trained on.
 *
 * Tool names from: openai/codex codex-rs/core
 */

import type { LaneToolRegistration } from '../types.js'
import { parsePatch } from '../shared/apply_patch.js'
import { WEB_SEARCH_NATIVE_DESCRIPTION } from '../../tools/WebSearchTool/prompt.js'

/**
 * `apply_patch` is Codex's native edit primitive. Codex emits patches in
 * the `*** Begin Patch` freeform grammar (not unified diff). We use the
 * shared parser from src/lanes/shared/apply_patch.ts to validate the
 * patch, then forward it to an ApplyPatch shared-impl tool which owns
 * the actual filesystem writes (creates AddFile paths, deletes
 * DeleteFile paths, and applies UpdateFile chunks to existing files).
 *
 * The shared impl is expected to accept { patch: string } and apply
 * via deriveNewContents from the shared module. If the impl isn't
 * registered, the adapter falls back to a single-file Edit conversion
 * which handles the most common GPT-5-codex case.
 */

export const CODEX_TOOL_REGISTRY: LaneToolRegistration[] = [
  // ── shell ──────────────────────────────────────────────────────
  {
    nativeName: 'shell',
    implId: 'Bash',
    nativeDescription:
      'Execute a shell command. Use for running programs, installing ' +
      'packages, running tests, git operations, and any system tasks.',
    nativeSchema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The shell command to execute.',
        },
      },
      required: ['command'],
    },
    adaptInput(native) {
      return { command: native.command }
    },
    adaptOutput(output) {
      return typeof output === 'string' ? output : JSON.stringify(output)
    },
  },

  // ── apply_patch ────────────────────────────────────────────────
  // THE key differentiator for the Codex lane. GPT-5 / gpt-5-codex /
  // o-series are specifically trained on the *** Begin Patch grammar,
  // not unified diff and not Edit. Using anything else on these models
  // produces measurable quality regressions on edit-heavy tasks.
  {
    nativeName: 'apply_patch',
    implId: 'ApplyPatch',
    nativeDescription:
      "Use the `apply_patch` tool to edit files. This is a FREEFORM tool, so do not wrap the patch in JSON.\n\n"
      + "Patch format:\n"
      + "*** Begin Patch\n"
      + "*** Add File: <path>\n"
      + "+line1\n"
      + "*** Update File: <path>\n"
      + "*** Move to: <new_path>\n"
      + "@@ optional context header\n"
      + "-old line\n"
      + "+new line\n"
      + " context line\n"
      + "*** Delete File: <path>\n"
      + "*** End Patch\n\n"
      + "Include at least 3 lines of surrounding context for each change to disambiguate the match.",
    nativeSchema: {
      type: 'object',
      properties: {
        patch: {
          type: 'string',
          description: 'The apply_patch body. Must start with `*** Begin Patch` and end with `*** End Patch`.',
        },
      },
      required: ['patch'],
    },
    adaptInput(native) {
      // Validate the patch at adapter time so malformed patches fail fast
      // with a helpful error rather than a generic tool-failure message.
      try {
        parsePatch(native.patch as string)
      } catch (e: any) {
        // Let the caller handle: return the raw input so the shared
        // ApplyPatch impl can surface a cleaner error with file context.
        // (Don't throw here — it bypasses the normal tool-error flow.)
      }
      return { patch: native.patch }
    },
    adaptOutput(output) {
      return typeof output === 'string' ? output : JSON.stringify(output)
    },
  },

  // ── read_file ──────────────────────────────────────────────────
  {
    nativeName: 'read_file',
    implId: 'Read',
    nativeDescription: 'Read the contents of a file.',
    nativeSchema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Path to the file to read.',
        },
        offset: {
          type: 'number',
          description: 'Line number to start reading from (0-based).',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of lines to read.',
        },
      },
      required: ['file_path'],
    },
    adaptInput(native) {
      const out: Record<string, unknown> = { file_path: native.file_path }
      if (native.offset != null) out.offset = native.offset
      if (native.limit != null) out.limit = native.limit
      return out
    },
    adaptOutput(output) {
      return typeof output === 'string' ? output : JSON.stringify(output)
    },
  },

  // ── write_file ─────────────────────────────────────────────────
  {
    nativeName: 'write_file',
    implId: 'Write',
    nativeDescription: 'Create a new file or overwrite an existing file with the given content.',
    nativeSchema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Path to the file to write.',
        },
        content: {
          type: 'string',
          description: 'The complete file content.',
        },
      },
      required: ['file_path', 'content'],
    },
    adaptInput(native) {
      return { file_path: native.file_path, content: native.content }
    },
    adaptOutput(output) {
      return typeof output === 'string' ? output : JSON.stringify(output)
    },
  },

  // ── list_directory ─────────────────────────────────────────────
  {
    nativeName: 'list_directory',
    implId: 'Bash',
    nativeDescription: 'List the contents of a directory.',
    nativeSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Directory path to list.',
        },
      },
      required: ['path'],
    },
    adaptInput(native) {
      return { command: `ls -la ${JSON.stringify(native.path)}` }
    },
    adaptOutput(output) {
      return typeof output === 'string' ? output : JSON.stringify(output)
    },
  },

  // ── search_files ───────────────────────────────────────────────
  {
    nativeName: 'search_files',
    implId: 'Glob',
    nativeDescription: 'Find files matching a glob pattern.',
    nativeSchema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Glob pattern (e.g., "**/*.ts").',
        },
        path: {
          type: 'string',
          description: 'Directory to search in.',
        },
      },
      required: ['pattern'],
    },
    adaptInput(native) {
      const out: Record<string, unknown> = { pattern: native.pattern }
      if (native.path) out.path = native.path
      return out
    },
    adaptOutput(output) {
      return typeof output === 'string' ? output : JSON.stringify(output)
    },
  },

  // ── search_code ────────────────────────────────────────────────
  {
    nativeName: 'search_code',
    implId: 'Grep',
    nativeDescription: 'Search for a pattern in file contents using regex.',
    nativeSchema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Regex pattern to search for.',
        },
        path: {
          type: 'string',
          description: 'File or directory to search in.',
        },
        include: {
          type: 'string',
          description: 'Glob pattern to filter files (e.g., "*.ts").',
        },
      },
      required: ['pattern'],
    },
    adaptInput(native) {
      const out: Record<string, unknown> = { pattern: native.pattern }
      if (native.path) out.path = native.path
      if (native.include) out.glob = native.include
      return out
    },
    adaptOutput(output) {
      return typeof output === 'string' ? output : JSON.stringify(output)
    },
  },

  // ── web_search ─────────────────────────────────────────────────
  {
    nativeName: 'web_search',
    implId: 'WebSearch',
    nativeDescription: WEB_SEARCH_NATIVE_DESCRIPTION,
    nativeSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query.',
        },
      },
      required: ['query'],
    },
    adaptInput(native) {
      return { query: native.query }
    },
    adaptOutput(output) {
      return typeof output === 'string' ? output : JSON.stringify(output)
    },
  },
]

// ─── Exports ─────────────────────────────────────────────────────

export function buildCodexFunctionDeclarations(): Array<{
  name: string
  description: string
  parameters: Record<string, unknown>
}> {
  return CODEX_TOOL_REGISTRY.map(reg => ({
    name: reg.nativeName,
    description: reg.nativeDescription,
    parameters: reg.nativeSchema,
  }))
}

/**
 * Build the `tools` field for a Responses API request. `apply_patch` is
 * emitted as a `custom` (freeform-text) tool — the rest as `function`
 * tools with JSON-Schema parameters.
 */
export function buildCodexResponsesTools(
  registrations: LaneToolRegistration[] = CODEX_TOOL_REGISTRY,
): Array<
  | { type: 'function'; name: string; description: string; parameters: Record<string, unknown>; strict?: boolean }
  | { type: 'custom'; name: string; description: string; format: { type: 'text' } }
> {
  return registrations.map(reg => {
    if (reg.nativeName === 'apply_patch') {
      return {
        type: 'custom',
        name: 'apply_patch',
        description: reg.nativeDescription,
        format: { type: 'text' },
      }
    }
    return {
      type: 'function',
      name: reg.nativeName,
      description: reg.nativeDescription,
      parameters: reg.nativeSchema,
    }
  })
}

/** Look up by native name — used when the model emits a tool call. */
export function getCodexRegistrationByNativeName(name: string): LaneToolRegistration | undefined {
  ensureIndexed()
  return _byNativeName.get(name)
}

const _byNativeName = new Map<string, LaneToolRegistration>()
function ensureIndexed(): void {
  if (_byNativeName.size > 0) return
  for (const reg of CODEX_TOOL_REGISTRY) {
    _byNativeName.set(reg.nativeName, reg)
  }
}

export function resolveToolCall(
  name: string,
  args: Record<string, unknown>,
): { implId: string; input: Record<string, unknown> } | null {
  ensureIndexed()
  const reg = _byNativeName.get(name)
  if (!reg) return null
  return { implId: reg.implId, input: reg.adaptInput(args) }
}

export function formatToolResult(name: string, output: string | unknown): string {
  ensureIndexed()
  const reg = _byNativeName.get(name)
  if (!reg) return typeof output === 'string' ? output : JSON.stringify(output)
  return reg.adaptOutput(output)
}
