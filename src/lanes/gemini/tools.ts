/**
 * Gemini Lane — Native Tool Registry
 *
 * Maps Gemini CLI's native tool names (what the model was post-trained on)
 * to Tau's shared tool implementations.
 *
 * The model sees these exact names and schemas. They come from:
 *   google-gemini/gemini-cli packages/core/src/tools/definitions/
 *
 * Each registration has:
 *   - nativeName: what Gemini sees (e.g., 'read_file')
 *   - implId: shared implementation key (e.g., 'Read')
 *   - nativeSchema: JSON Schema the model was trained against
 *   - adaptInput: converts Gemini's params → shared impl params
 *   - adaptOutput: converts shared impl output → Gemini's expected format
 */

import type { LaneToolRegistration } from '../types.js'
import { windowsPathToPosixPath } from '../../utils/windowsPaths.js'
import { WEB_SEARCH_NATIVE_DESCRIPTION } from '../../tools/WebSearchTool/prompt.js'

type AskUserOption = {
  label: string
  description: string
}

type AskUserQuestion = {
  question: string
  header: string
  options: AskUserOption[]
  multiSelect: boolean
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null
}

function askUserHeader(value: unknown, question: string, index: number): string {
  const explicit = nonEmptyString(value)
  if (explicit) return explicit.slice(0, 12)
  const fromQuestion = question
    .replace(/[^\w\s]/g, ' ')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .join(' ')
  return (fromQuestion || `Q${index + 1}`).slice(0, 12)
}

function askUserOptions(rawOptions: unknown, type: unknown): AskUserOption[] {
  const options: AskUserOption[] = []
  if (Array.isArray(rawOptions)) {
    for (let i = 0; i < rawOptions.length; i++) {
      const raw = rawOptions[i]
      if (typeof raw === 'string') {
        const label = raw.trim()
        if (label) options.push({ label, description: `Select ${label}.` })
        continue
      }

      const record = asRecord(raw)
      if (!record) continue
      const label = nonEmptyString(record.label)
        ?? nonEmptyString(record.text)
        ?? nonEmptyString(record.value)
        ?? `Option ${i + 1}`
      const description = nonEmptyString(record.description)
        ?? nonEmptyString(record.desc)
        ?? `Select ${label}.`
      options.push({ label, description })
    }
  }

  const deduped: AskUserOption[] = []
  const seen = new Set<string>()
  for (const option of options) {
    const key = option.label.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(option)
    if (deduped.length >= 4) break
  }

  const fallback = String(type ?? '').toLowerCase() === 'yesno'
    ? [
        { label: 'Yes', description: 'Confirm this option.' },
        { label: 'No', description: 'Decline this option.' },
      ]
    : [
        { label: 'Answer', description: 'Provide a custom answer.' },
        { label: 'Skip', description: 'Do not answer this now.' },
      ]

  for (const option of fallback) {
    if (deduped.length >= 2) break
    if (!seen.has(option.label.toLowerCase())) {
      deduped.push(option)
      seen.add(option.label.toLowerCase())
    }
  }

  return deduped.slice(0, 4)
}

function normalizeAskUserInput(native: Record<string, unknown>): { questions: AskUserQuestion[] } {
  const rawQuestions = Array.isArray(native.questions) && native.questions.length > 0
    ? native.questions
    : [native]

  const questions = rawQuestions.map((raw, index) => {
    const record = asRecord(raw) ?? {}
    const question = nonEmptyString(record.question)
      ?? nonEmptyString(native.question)
      ?? 'Please choose an option.'
    const type = record.type ?? native.type
    return {
      question,
      header: askUserHeader(record.header ?? native.header, question, index),
      options: askUserOptions(record.options ?? native.options, type),
      multiSelect: Boolean(record.multiSelect ?? record.multi_select ?? native.multiSelect ?? native.multi_select),
    }
  })

  return { questions }
}

// ─── Native Tool Definitions ─────────────────────────────────────
//
// These are the EXACT tool names and schemas from gemini-cli.
// Do not rename them. Do not add Anthropic-style tool names.
// The model was post-trained on these specific strings.

export const GEMINI_TOOL_REGISTRY: LaneToolRegistration[] = [
  // ── read_file ──────────────────────────────────────────────────
  {
    nativeName: 'read_file',
    implId: 'Read',
    nativeDescription:
      "Reads and returns the content of a specified file. To maintain context efficiency, you MUST use 'start_line' and 'end_line' for targeted, surgical reads of specific sections. For your safety, the tool will automatically truncate output exceeding 2000 lines, 1000 characters per line, or 10MB in size; however, triggering these limits is considered token-inefficient. Always retrieve only the minimum content necessary for your next step. Handles text, images (PNG, JPG, GIF, WEBP, SVG, BMP), audio files (MP3, WAV, AIFF, AAC, OGG, FLAC), and PDF files.",
    nativeSchema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'The path to the file to read.',
        },
        start_line: {
          type: 'number',
          description: 'Optional: The 1-based line number to start reading from.',
        },
        end_line: {
          type: 'number',
          description: 'Optional: The 1-based line number to end reading at (inclusive).',
        },
      },
      required: ['file_path'],
    },
    adaptInput(native) {
      const result: Record<string, unknown> = {
        file_path: native.file_path,
      }
      // Gemini uses 1-based start_line/end_line
      // Shared Read uses 0-based offset + limit
      if (native.start_line != null) {
        result.offset = (native.start_line as number) - 1
        if (native.end_line != null) {
          result.limit = (native.end_line as number) - (native.start_line as number) + 1
        }
      }
      return result
    },
    adaptOutput(output) {
      return typeof output === 'string' ? output : JSON.stringify(output)
    },
  },

  // ── write_file ─────────────────────────────────────────────────
  {
    nativeName: 'write_file',
    implId: 'Write',
    nativeDescription:
      "Writes the complete content to a file, automatically creating missing parent directories. Overwrites existing files. The user has the ability to modify 'content' before it is saved. Best for new or small files; use 'replace' for targeted edits to large files.",
    nativeSchema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Path to the file.',
        },
        content: {
          type: 'string',
          description: "The complete content to write. Provide the full file; do not use placeholders like '// ... rest of code'.",
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

  // ── replace (Edit) ─────────────────────────────────────────────
  {
    nativeName: 'replace',
    implId: 'Edit',
    nativeDescription:
      "Replaces text within a file. By default, the tool expects to find and replace exactly ONE occurrence of `old_string`. If you want to replace multiple occurrences of the exact same string, set `allow_multiple` to true. This tool requires providing significant context around the change to ensure precise targeting.\nThe user has the ability to modify the `new_string` content. If modified, this will be stated in the response.",
    nativeSchema: {
      type: 'object',
      properties: {
        file_path: {
          description: 'The path to the file to modify.',
          type: 'string',
        },
        instruction: {
          description: 'A clear, semantic instruction for the code change, acting as a high-quality prompt for an expert LLM assistant. It must be self-contained and explain the goal of the change.',
          type: 'string',
        },
        old_string: {
          description: 'The exact literal text to replace, unescaped. If this string is not the exact literal text (i.e. you escaped it) or does not match exactly, the tool will fail.',
          type: 'string',
        },
        new_string: {
          description: "The exact literal text to replace `old_string` with, unescaped. Provide the EXACT text. Ensure the resulting code is correct and idiomatic. Do not use omission placeholders like '(rest of methods ...)', '...', or 'unchanged code'; provide exact literal code.",
          type: 'string',
        },
        allow_multiple: {
          type: 'boolean',
          description: 'If true, the tool will replace all occurrences of `old_string`. If false (default), it will only succeed if exactly one occurrence is found.',
        },
      },
      required: ['file_path', 'instruction', 'old_string', 'new_string'],
    },
    adaptInput(native) {
      return {
        file_path: native.file_path,
        old_string: native.old_string,
        new_string: native.new_string,
        replace_all: native.allow_multiple ?? false,
      }
    },
    adaptOutput(output) {
      return typeof output === 'string' ? output : JSON.stringify(output)
    },
  },

  // ── run_shell_command (Bash) ────────────────────────────────────
  {
    nativeName: 'run_shell_command',
    implId: 'Bash',
    nativeDescription:
      'This tool executes a given shell command using Bash/POSIX syntax. To run a command in the background, set the `is_background` parameter to true. Do NOT use `&` to background commands.\n\n      The following information is returned:\n\n      Output: Combined stdout/stderr. Can be `(empty)` or partial on error and for any unwaited background processes.\n      Exit Code: Only included if non-zero (command failed).\n      Error: Only included if a process-level error occurred (e.g., spawn failure).\n      Signal: Only included if process was terminated by a signal.\n      Background PIDs: Only included if background processes were started.',
    nativeSchema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'Exact Bash/POSIX command to execute.',
        },
        description: {
          type: 'string',
          description: 'Brief description of the command for the user. Be specific and concise. Ideally a single sentence. Can be up to 3 sentences for clarity. No line breaks.',
        },
        dir_path: {
          type: 'string',
          description: '(OPTIONAL) The path of the directory to run the command in. If not provided, the project root directory is used. Must be a directory within the workspace and must already exist.',
        },
        is_background: {
          type: 'boolean',
          description: 'Set to true if this command should be run in the background (e.g. for long-running servers or watchers). The command will be started, allowed to run for a brief moment to check for immediate errors, and then moved to the background.',
        },
      },
      required: ['command'],
    },
    adaptInput(native) {
      const result: Record<string, unknown> = {
        command: native.command,
      }
      if (native.description) result.description = native.description
      if (native.is_background) result.run_in_background = native.is_background
      // dir_path: the shared Bash impl uses cwd from context, but
      // if Gemini specifies dir_path we prepend a cd
      if (native.dir_path) {
        result.command = `cd ${JSON.stringify(native.dir_path)} && ${native.command}`
      }
      return result
    },
    adaptOutput(output) {
      return typeof output === 'string' ? output : JSON.stringify(output)
    },
  },

  // ── glob ───────────────────────────────────────────────────────
  {
    nativeName: 'glob',
    implId: 'Glob',
    nativeDescription:
      'Efficiently finds files matching specific glob patterns (e.g., `src/**/*.ts`, `**/*.md`), returning absolute paths sorted by modification time (newest first). Ideal for quickly locating files based on their name or path structure, especially in large codebases.',
    nativeSchema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: "The glob pattern to match against (e.g., '**/*.py', 'docs/*.md').",
        },
        dir_path: {
          type: 'string',
          description: 'Optional: The absolute path to the directory to search within. If omitted, searches the root directory.',
        },
      },
      required: ['pattern'],
    },
    adaptInput(native) {
      const out: Record<string, unknown> = { pattern: native.pattern }
      if (native.dir_path) out.path = native.dir_path
      return out
    },
    adaptOutput(output) {
      return typeof output === 'string' ? output : JSON.stringify(output)
    },
  },

  // ── grep_search ────────────────────────────────────────────────
  {
    nativeName: 'grep_search',
    implId: 'Grep',
    nativeDescription:
      'Searches for a regular expression pattern within file contents. This tool is FAST and optimized, powered by ripgrep. PREFERRED over standard `run_shell_command("grep ...")` due to better performance and automatic output limiting (defaults to 100 matches, but can be increased via `total_max_matches`).',
    nativeSchema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: "The pattern to search for. By default, treated as a Rust-flavored regular expression. Use '\\b' for precise symbol matching (e.g., '\\bMatchMe\\b').",
        },
        dir_path: {
          type: 'string',
          description: "Directory or file to search. Directories are searched recursively. Relative paths are resolved against current working directory. Defaults to current working directory ('.') if omitted.",
        },
        include_pattern: {
          type: 'string',
          description: "Glob pattern to filter files (e.g., '*.ts', 'src/**'). Recommended for large repositories to reduce noise. Defaults to all files if omitted.",
        },
        names_only: {
          type: 'boolean',
          description: 'Optional: If true, only the file paths of the matches will be returned, without the line content or line numbers. This is useful for gathering a list of files.',
        },
        total_max_matches: {
          type: 'integer',
          description: 'Optional: Maximum number of total matches to return. Use this to limit the overall size of the response. Defaults to 100 if omitted.',
        },
      },
      required: ['pattern'],
    },
    adaptInput(native) {
      const out: Record<string, unknown> = { pattern: native.pattern }
      if (native.dir_path) out.path = native.dir_path
      if (native.include_pattern) out.glob = native.include_pattern
      if (native.names_only) out.output_mode = 'files_with_matches'
      if (native.total_max_matches) out.head_limit = native.total_max_matches
      return out
    },
    adaptOutput(output) {
      return typeof output === 'string' ? output : JSON.stringify(output)
    },
  },

  // ── google_web_search ──────────────────────────────────────────
  {
    nativeName: 'google_web_search',
    implId: 'WebSearch',
    nativeDescription: WEB_SEARCH_NATIVE_DESCRIPTION,
    nativeSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query to use.',
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

  // ── web_fetch ──────────────────────────────────────────────────
  {
    nativeName: 'web_fetch',
    implId: 'WebFetch',
    nativeDescription:
      "Processes content from URL(s) embedded in the 'prompt' parameter, up to 20. Extracts information, summarizes, or answers questions per the prompt's instructions. Ideal for deep-diving into a known URL. Use 'google_web_search' first if you don't have a specific URL. Private/local network URLs (e.g., localhost) are supported.",
    nativeSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: "A comprehensive prompt that includes the URL(s) (up to 20) to fetch and specific instructions on how to process their content (e.g., 'Summarize https://example.com/article and extract key points from https://another.com/data'). Must contain as least one URL starting with http:// or https://.",
        },
      },
      required: ['prompt'],
    },
    adaptInput(native) {
      // Shared WebFetch expects { url, prompt } — extract URL from prompt.
      // Tolerate a missing/empty prompt (invariants tests pass {}).
      const prompt = typeof native.prompt === 'string' ? native.prompt : ''
      const urlMatch = prompt.match(/https?:\/\/[^\s]+/)
      return {
        url: urlMatch ? urlMatch[0] : prompt,
        prompt,
      }
    },
    adaptOutput(output) {
      return typeof output === 'string' ? output : JSON.stringify(output)
    },
  },

  // ── list_directory ─────────────────────────────────────────────
  // Gemini-specific tool — no direct Tau equivalent. Maps to Bash ls.
  {
    nativeName: 'list_directory',
    implId: 'Bash',
    nativeDescription:
      'Lists the names of files and subdirectories directly within a specified directory path. Can optionally ignore entries matching provided glob patterns.',
    nativeSchema: {
      type: 'object',
      properties: {
        dir_path: {
          type: 'string',
          description: 'The path to the directory to list',
        },
      },
      required: ['dir_path'],
    },
    adaptInput(native) {
      const dirPath = typeof native.dir_path === 'string'
        ? native.dir_path
        : String(native.dir_path ?? '.')
      const bashPath = process.platform === 'win32' ? windowsPathToPosixPath(dirPath) : dirPath
      return { command: `ls -la -- ${JSON.stringify(bashPath)}` }
    },
    adaptOutput(output) {
      return typeof output === 'string' ? output : JSON.stringify(output)
    },
  },

  // ── ask_user ───────────────────────────────────────────────────
  {
    nativeName: 'ask_user',
    implId: 'AskUserQuestion',
    nativeDescription:
      "Asks the user one or more questions to gather preferences or clarify requirements. Prefer multiple-choice questions (type='choice') with clear, concise options and explanatory descriptions. Use type='text' for free-form answers and type='yesno' for binary decisions. At least one question is required.",
    nativeSchema: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              question: { type: 'string', description: 'The question text.' },
              header: { type: 'string', description: 'Short label.' },
              type: {
                type: 'string',
                enum: ['choice', 'text', 'yesno'],
              },
              options: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    label: { type: 'string' },
                    description: { type: 'string' },
                  },
                  required: ['label', 'description'],
                },
              },
            },
            required: ['question', 'header', 'type'],
          },
          minItems: 1,
          maxItems: 4,
        },
      },
      required: ['questions'],
    },
    adaptInput(native) {
      return normalizeAskUserInput(native)
    },
    adaptOutput(output) {
      return typeof output === 'string' ? output : JSON.stringify(output)
    },
  },

  // ── enter_plan_mode ────────────────────────────────────────────
  {
    nativeName: 'enter_plan_mode',
    implId: 'EnterPlanMode',
    nativeDescription:
      'Enters Plan Mode — a constrained research and design state. Only safe, read-only tools are available until you formally finalize the plan via `exit_plan_mode`. Use this when the user asks you to plan, design, or research before making code changes.',
    nativeSchema: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: 'Brief reason for entering plan mode (e.g., "investigate the auth bug before fixing").',
        },
      },
    },
    adaptInput(native) {
      return { reason: native.reason }
    },
    adaptOutput(output) {
      return typeof output === 'string' ? output : JSON.stringify(output)
    },
  },

  // ── exit_plan_mode ─────────────────────────────────────────────
  {
    nativeName: 'exit_plan_mode',
    implId: 'ExitPlanMode',
    nativeDescription:
      'Finalizes the planning phase and transitions to implementation by presenting the plan for formal user approval. You MUST reach an informal agreement with the user in the chat regarding the proposed strategy BEFORE calling this tool. This tool MUST be used to exit Plan Mode before any source code edits can be performed.',
    nativeSchema: {
      type: 'object',
      properties: {
        plan_filename: {
          type: 'string',
          description: 'The filename of the finalized plan (e.g., "feature-x.md"). Do not provide an absolute path.',
        },
      },
      required: ['plan_filename'],
    },
    adaptInput(native) {
      return { plan_filename: native.plan_filename }
    },
    adaptOutput(output) {
      return typeof output === 'string' ? output : JSON.stringify(output)
    },
  },

  // ── save_memory ────────────────────────────────────────────────
  // Gemini-specific. Maps to a file write to the memory directory.
  {
    nativeName: 'save_memory',
    implId: 'Bash',
    nativeDescription:
      "Saves a specific piece of information or fact to long-term memory. Use this when the user explicitly asks to remember something (e.g., 'remember that X'), or states a clear, concise fact that seems important to retain for future interactions (e.g., personal preferences, project details).",
    nativeSchema: {
      type: 'object',
      properties: {
        fact: {
          type: 'string',
          description: 'The specific fact or piece of information to remember. Should be a clear, self-contained statement.',
        },
        scope: {
          type: 'string',
          enum: ['global', 'project'],
          description: "The scope of the memory. 'global' persists across all projects; 'project' is scoped to the current workspace only. Defaults to 'project'.",
        },
      },
      required: ['fact'],
    },
    adaptInput(native) {
      // Map to an echo-append to the appropriate memory file
      const scope = (native.scope as string) || 'project'
      const target = scope === 'global' ? '~/.gemini/memory.md' : '.gemini/memory.md'
      return {
        command: `mkdir -p "$(dirname ${target})" && echo ${JSON.stringify(native.fact)} >> ${target}`,
      }
    },
    adaptOutput(output) {
      return typeof output === 'string' ? output : 'Memory saved.'
    },
  },
]

// ─── Lookup Helpers ──────────────────────────────────────────────

const _byNativeName = new Map<string, LaneToolRegistration>()
const _byImplId = new Map<string, LaneToolRegistration[]>()

function _ensureIndexed(): void {
  if (_byNativeName.size > 0) return
  for (const reg of GEMINI_TOOL_REGISTRY) {
    _byNativeName.set(reg.nativeName, reg)
    const list = _byImplId.get(reg.implId) ?? []
    list.push(reg)
    _byImplId.set(reg.implId, list)
  }
}

/** Look up a registration by native tool name (what the model calls). */
export function getRegistrationByNativeName(name: string): LaneToolRegistration | undefined {
  _ensureIndexed()
  return _byNativeName.get(name)
}

/** Look up registrations by shared implementation ID. */
export function getRegistrationsByImplId(implId: string): LaneToolRegistration[] {
  _ensureIndexed()
  return _byImplId.get(implId) ?? []
}

/**
 * Build Gemini-format function declarations from the registry.
 * This is what gets sent in the API request's `tools` field.
 */
export function buildGeminiFunctionDeclarations(): Array<{
  name: string
  description: string
  parameters: Record<string, unknown>
}> {
  return GEMINI_TOOL_REGISTRY.map(reg => ({
    name: reg.nativeName,
    description: reg.nativeDescription,
    parameters: reg.nativeSchema,
  }))
}

/**
 * Convert a native Gemini tool call into a shared-layer executeTool() call.
 * Returns { implId, input } ready for context.executeTool().
 */
export function resolveToolCall(
  nativeName: string,
  nativeArgs: Record<string, unknown>,
): { implId: string; input: Record<string, unknown> } | null {
  const reg = getRegistrationByNativeName(nativeName)
  if (!reg) return null
  return {
    implId: reg.implId,
    input: reg.adaptInput(nativeArgs),
  }
}

/**
 * Format a tool result back into Gemini's expected shape.
 */
export function formatToolResult(
  nativeName: string,
  output: string | unknown,
): string {
  const reg = getRegistrationByNativeName(nativeName)
  if (!reg) return typeof output === 'string' ? output : JSON.stringify(output)
  return reg.adaptOutput(output)
}
