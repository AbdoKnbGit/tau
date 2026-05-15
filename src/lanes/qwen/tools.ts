/**
 * Qwen tool registry — OpenAI function-calling schema shape.
 *
 * Qwen (and Qwen3-Coder in particular) was post-trained on Qwen Code's
 * tool surface, which inherits from gemini-cli for file/shell ops but
 * delivered via OpenAI function-calling wire format (tools[] with
 * {type:'function', function:{name,description,parameters}}).
 *
 * Tool names match qwen-code reference where available; adaptInput /
 * adaptOutput bridge the native parameter shape to Tau's shared
 * tool implementations.
 */

import type { LaneToolRegistration } from '../types.js'
import { WEB_SEARCH_NATIVE_DESCRIPTION } from '../../tools/WebSearchTool/prompt.js'

export const QWEN_TOOL_REGISTRY: LaneToolRegistration[] = [
  {
    nativeName: 'read_file',
    implId: 'Read',
    nativeDescription:
      "Read the content of a file from disk. Supports text, images, PDFs, and common code formats. Use 'offset' + 'limit' for targeted slicing of large files to save context.",
    nativeSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file.' },
        offset: { type: 'number', description: '1-based line number to start reading from.' },
        limit: { type: 'number', description: 'Number of lines to read.' },
      },
      required: ['file_path'],
    },
    adaptInput(native) {
      const out: Record<string, unknown> = { file_path: native.file_path }
      if (typeof native.offset === 'number') out.offset = Math.max(0, (native.offset as number) - 1)
      if (typeof native.limit === 'number') out.limit = native.limit
      return out
    },
    adaptOutput(output) {
      return typeof output === 'string' ? output : JSON.stringify(output)
    },
  },

  {
    nativeName: 'write_file',
    implId: 'Write',
    nativeDescription:
      "Write full content to a file. Creates parent directories. Overwrites if exists. For targeted edits, prefer 'edit_file'.",
    nativeSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        content: { type: 'string' },
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

  {
    nativeName: 'edit_file',
    implId: 'Edit',
    nativeDescription:
      "Edit a file by replacing exact text. Provide unique 'old_string' context to target the right occurrence. Set 'replace_all' to true for global rewrites.",
    nativeSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
        replace_all: { type: 'boolean' },
      },
      required: ['file_path', 'old_string', 'new_string'],
    },
    adaptInput(native) {
      return {
        file_path: native.file_path,
        old_string: native.old_string,
        new_string: native.new_string,
        replace_all: native.replace_all ?? false,
      }
    },
    adaptOutput(output) {
      return typeof output === 'string' ? output : JSON.stringify(output)
    },
  },

  {
    nativeName: 'run_shell_command',
    implId: 'Bash',
    nativeDescription:
      'Run a Bash/POSIX shell command. Set is_background=true for long-running processes. Do NOT use "&" to background.',
    nativeSchema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        description: { type: 'string' },
        is_background: { type: 'boolean' },
      },
      required: ['command'],
    },
    adaptInput(native) {
      const out: Record<string, unknown> = { command: native.command }
      if (native.description) out.description = native.description
      if (native.is_background) out.run_in_background = native.is_background
      return out
    },
    adaptOutput(output) {
      return typeof output === 'string' ? output : JSON.stringify(output)
    },
  },

  {
    nativeName: 'glob',
    implId: 'Glob',
    nativeDescription:
      'Find files by glob pattern (e.g., "**/*.ts"). Returns paths sorted by modification time.',
    nativeSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        path: { type: 'string', description: 'Optional directory to search in.' },
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

  {
    nativeName: 'search_file_content',
    implId: 'Grep',
    nativeDescription:
      'Search file contents with a regex (ripgrep-powered). Optional glob filter and per-file head limit.',
    nativeSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        path: { type: 'string' },
        glob: { type: 'string' },
        output_mode: { type: 'string', enum: ['content', 'files_with_matches', 'count'] },
        head_limit: { type: 'number' },
      },
      required: ['pattern'],
    },
    adaptInput(native) {
      return { ...native }
    },
    adaptOutput(output) {
      return typeof output === 'string' ? output : JSON.stringify(output)
    },
  },

  {
    nativeName: 'web_search',
    implId: 'WebSearch',
    nativeDescription: WEB_SEARCH_NATIVE_DESCRIPTION,
    nativeSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
    adaptInput(native) {
      return { query: native.query }
    },
    adaptOutput(output) {
      return typeof output === 'string' ? output : JSON.stringify(output)
    },
  },

  {
    nativeName: 'web_fetch',
    implId: 'WebFetch',
    nativeDescription:
      "Fetch and process one or more URLs embedded in 'prompt'. Up to 20 URLs.",
    nativeSchema: {
      type: 'object',
      properties: { prompt: { type: 'string' } },
      required: ['prompt'],
    },
    adaptInput(native) {
      const prompt = typeof native.prompt === 'string' ? native.prompt : ''
      const urlMatch = prompt.match(/https?:\/\/[^\s]+/)
      return { url: urlMatch ? urlMatch[0] : prompt, prompt }
    },
    adaptOutput(output) {
      return typeof output === 'string' ? output : JSON.stringify(output)
    },
  },
]

// ─── Lookup ──────────────────────────────────────────────────────

const _byNative = new Map<string, LaneToolRegistration>()
const _byImpl = new Map<string, LaneToolRegistration[]>()
function _ensureIndexed(): void {
  if (_byNative.size > 0) return
  for (const reg of QWEN_TOOL_REGISTRY) {
    _byNative.set(reg.nativeName, reg)
    const list = _byImpl.get(reg.implId) ?? []
    list.push(reg)
    _byImpl.set(reg.implId, list)
  }
}

export function getQwenRegistrationByNativeName(name: string): LaneToolRegistration | undefined {
  _ensureIndexed()
  return _byNative.get(name)
}

export function getQwenRegistrationsByImplId(implId: string): LaneToolRegistration[] {
  _ensureIndexed()
  return _byImpl.get(implId) ?? []
}

/** Build Qwen-format function tool defs from the registry. */
export function buildQwenTools(): Array<{
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}> {
  return QWEN_TOOL_REGISTRY.map(reg => ({
    type: 'function' as const,
    function: {
      name: reg.nativeName,
      description: reg.nativeDescription,
      parameters: reg.nativeSchema,
    },
  }))
}
