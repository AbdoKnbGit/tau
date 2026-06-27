/**
 * OpenAI-Compatible Lane — Tool Registry
 *
 * Clean, standard tool names that work well with any model trained on
 * OpenAI's function-calling format. DeepSeek, Groq, NIM, Ollama,
 * OpenRouter, Mistral, xAI, etc. all speak this format.
 *
 * Tool names are deliberately generic and descriptive — these models
 * don't have a specific CLI they were trained against, so clear names
 * that match common coding-assistant patterns work best.
 *
 * Three edit primitives are exposed, with per-model selection handled
 * in `capabilities.ts` / per-provider transformers:
 *
 *   - `str_replace`   — simplest; frontier-agnostic, single exact swap.
 *   - `edit_block`    — SEARCH/REPLACE format; Aider-trained models
 *                       (DeepSeek-Coder, Codestral, Qwen-Coder, Kimi).
 *   - `edit_file`     — the classic old_text/new_text style, kept for
 *                       backward compatibility.
 *
 * The lane selects ONE edit tool per request based on the transformer's
 * `preferredEditFormat(model)` so the model sees one clear way to edit
 * rather than three overlapping options.
 */

import type { LaneToolRegistration } from '../types.js'
import { applyShellWorkdir } from '../shared/shell_workdir.js'
import { WEB_SEARCH_NATIVE_DESCRIPTION } from '../../tools/WebSearchTool/prompt.js'

export const OPENAI_COMPAT_TOOL_REGISTRY: LaneToolRegistration[] = [
  {
    nativeName: 'execute_command',
    implId: 'Bash',
    nativeDescription:
      'Execute a shell command and return its output. For long-running servers, watchers, port-forwards, tunnels, or foreground container runs, set run_in_background=true and do not put "&", "nohup", "disown", "echo $!", "docker compose up -d", or "docker run -d" in the command.',
    nativeSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to execute. Do not include raw shell backgrounding with &, nohup, disown, echo $!, docker compose up -d, or docker run -d.' },
        description: { type: 'string', description: 'Brief description of what the command does.' },
        run_in_background: {
          type: 'boolean',
          description: 'Set true for long-running servers/watchers, port-forwards, tunnels, and foreground container runs. Tau runs the whole command as a tracked background task; remove any shell-level detaching from command.',
        },
      },
      required: ['command'],
    },
    adaptInput(native) {
      const out: Record<string, unknown> = { command: native.command }
      if (native.description) out.description = native.description
      if (native.run_in_background) out.run_in_background = native.run_in_background
      return applyShellWorkdir(out, native)
    },
    adaptOutput(output) { return typeof output === 'string' ? output : JSON.stringify(output) },
  },
  {
    nativeName: 'read_file',
    implId: 'Read',
    nativeDescription: 'Read the contents of a file.',
    nativeSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file.' },
        start_line: { type: 'number', description: 'Start line (1-based). Optional.' },
        end_line: { type: 'number', description: 'End line (1-based, inclusive). Optional.' },
      },
      required: ['path'],
    },
    adaptInput(native) {
      const result: Record<string, unknown> = { file_path: native.path }
      if (native.start_line != null) {
        result.offset = (native.start_line as number) - 1
        if (native.end_line != null) {
          result.limit = (native.end_line as number) - (native.start_line as number) + 1
        }
      }
      return result
    },
    adaptOutput(output) { return typeof output === 'string' ? output : JSON.stringify(output) },
  },
  {
    nativeName: 'write_file',
    implId: 'Write',
    nativeDescription: 'Write content to a file. Creates the file if it does not exist. Overwrites otherwise. Use str_replace/edit_block/edit_file for targeted edits to existing files.',
    nativeSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file.' },
        content: { type: 'string', description: 'The complete file content to write.' },
      },
      required: ['path', 'content'],
    },
    adaptInput(native) {
      return { file_path: native.path, content: native.content }
    },
    adaptOutput(output) { return typeof output === 'string' ? output : JSON.stringify(output) },
  },
  // ── Edit primitive #1 ── str_replace (simplest, frontier-agnostic) ──
  {
    nativeName: 'str_replace',
    implId: 'Edit',
    nativeDescription:
      'Replace exactly one occurrence of a string in a file. The string must match EXACTLY (whitespace, newlines, punctuation). Include enough surrounding context in `old_str` to make the match unique. For multiple edits to the same file, call this tool multiple times in sequence.',
    nativeSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file.' },
        old_str: { type: 'string', description: 'Exact string to find. Include surrounding context for uniqueness.' },
        new_str: { type: 'string', description: 'Replacement string.' },
      },
      required: ['path', 'old_str', 'new_str'],
    },
    adaptInput(native) {
      return { file_path: native.path, old_string: native.old_str, new_string: native.new_str }
    },
    adaptOutput(output) { return typeof output === 'string' ? output : JSON.stringify(output) },
  },
  // ── Edit primitive #2 ── edit_block (SEARCH/REPLACE; Aider-trained) ──
  {
    nativeName: 'edit_block',
    implId: 'Edit',
    nativeDescription:
      'Apply a SEARCH/REPLACE edit to a file. Use this when your training includes Aider-style edit blocks. The `search` text must match exactly (including indentation); include 3+ lines of surrounding context when possible so the match is unique. Call multiple times for multiple edits.',
    nativeSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file.' },
        search: { type: 'string', description: 'The exact block to find (the content between <<<<<<< SEARCH and =======).' },
        replace: { type: 'string', description: 'The replacement block (the content between ======= and >>>>>>> REPLACE).' },
      },
      required: ['path', 'search', 'replace'],
    },
    adaptInput(native) {
      return { file_path: native.path, old_string: native.search, new_string: native.replace }
    },
    adaptOutput(output) { return typeof output === 'string' ? output : JSON.stringify(output) },
  },
  // ── Edit primitive #3 ── edit_file (legacy old_text/new_text) ──
  {
    nativeName: 'edit_file',
    implId: 'Edit',
    nativeDescription: 'Replace text in a file. The old_text must match exactly. Kept for models trained on this name; str_replace is preferred for new deployments.',
    nativeSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file.' },
        old_text: { type: 'string', description: 'The exact text to find and replace.' },
        new_text: { type: 'string', description: 'The replacement text.' },
      },
      required: ['path', 'old_text', 'new_text'],
    },
    adaptInput(native) {
      return { file_path: native.path, old_string: native.old_text, new_string: native.new_text }
    },
    adaptOutput(output) { return typeof output === 'string' ? output : JSON.stringify(output) },
  },
  {
    nativeName: 'find_files',
    implId: 'Glob',
    nativeDescription: 'Find files matching a glob pattern.',
    nativeSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern (e.g., "**/*.ts").' },
        directory: { type: 'string', description: 'Directory to search in.' },
      },
      required: ['pattern'],
    },
    adaptInput(native) {
      const out: Record<string, unknown> = { pattern: native.pattern }
      if (native.directory) out.path = native.directory
      return out
    },
    adaptOutput(output) { return typeof output === 'string' ? output : JSON.stringify(output) },
  },
  {
    nativeName: 'search_text',
    implId: 'Grep',
    nativeDescription: 'Search for a regex pattern in file contents.',
    nativeSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex pattern to search for.' },
        directory: { type: 'string', description: 'Directory to search in.' },
        file_pattern: { type: 'string', description: 'Glob to filter files (e.g., "*.py").' },
      },
      required: ['pattern'],
    },
    adaptInput(native) {
      const out: Record<string, unknown> = { pattern: native.pattern }
      if (native.directory) out.path = native.directory
      if (native.file_pattern) out.glob = native.file_pattern
      return out
    },
    adaptOutput(output) { return typeof output === 'string' ? output : JSON.stringify(output) },
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
    adaptInput(native) { return { query: native.query } },
    adaptOutput(output) { return typeof output === 'string' ? output : JSON.stringify(output) },
  },
]

// ─── Edit-primitive filtering ────────────────────────────────────
//
// Models that see THREE overlapping edit tools (str_replace,
// edit_block, edit_file) pick randomly between them and the
// resulting diff quality is worse than if they see ONE tool that
// matches their post-training. Before sending tools to the model we
// filter to a single edit primitive per the transformer's
// `preferredEditFormat(model)` decision.

const EDIT_TOOL_NAMES: Record<'apply_patch' | 'edit_block' | 'str_replace', string> = {
  // apply_patch is NOT in this registry — the compat lane doesn't
  // expose it (apply_patch's grammar needs Codex's Freeform tool
  // type which Chat-Completions providers don't support). Transformers
  // that select apply_patch will fall through to str_replace here.
  apply_patch: 'str_replace',
  edit_block: 'edit_block',
  str_replace: 'str_replace',
}

const ALL_EDIT_TOOL_NAMES = new Set(['str_replace', 'edit_block', 'edit_file'])

/**
 * Filter the registry to expose ONE edit tool matching the preferred
 * format. Non-edit tools are always passed through unchanged.
 */
export function selectEditToolSet(
  preferred: 'apply_patch' | 'edit_block' | 'str_replace',
): LaneToolRegistration[] {
  const keepName = EDIT_TOOL_NAMES[preferred] ?? 'str_replace'
  return OPENAI_COMPAT_TOOL_REGISTRY.filter(r =>
    !ALL_EDIT_TOOL_NAMES.has(r.nativeName) || r.nativeName === keepName,
  )
}

// ─── Exports ─────────────────────────────────────────────────────

export function buildOpenAICompatFunctions(): Array<{
  name: string
  description: string
  parameters: Record<string, unknown>
}> {
  return OPENAI_COMPAT_TOOL_REGISTRY.map(r => ({
    name: r.nativeName, description: r.nativeDescription, parameters: r.nativeSchema,
  }))
}

const _byName = new Map<string, LaneToolRegistration>()
function idx(): void {
  if (_byName.size > 0) return
  for (const r of OPENAI_COMPAT_TOOL_REGISTRY) _byName.set(r.nativeName, r)
}

export function resolveToolCall(
  name: string, args: Record<string, unknown>,
): { implId: string; input: Record<string, unknown> } | null {
  idx()
  const r = _byName.get(name)
  if (!r) return null
  return { implId: r.implId, input: r.adaptInput(args) }
}

export function formatToolResult(name: string, output: string | unknown): string {
  idx()
  const r = _byName.get(name)
  if (!r) return typeof output === 'string' ? output : JSON.stringify(output)
  return r.adaptOutput(output)
}

export function getCompatRegistrationByNativeName(name: string): LaneToolRegistration | undefined {
  idx()
  return _byName.get(name)
}
