/**
 * Gemini Lane — Native System Prompt Assembly
 *
 * Builds the system prompt in the structure Gemini was post-trained on.
 * The template matches gemini-cli's prompt layout (from packages/core/src/prompts/).
 *
 * Sections:
 *   1. Preamble — agent identity and mode
 *   2. Core Mandates — security and engineering standards
 *   3. Workflows — research → strategy → execution
 *   4. Tool Usage — how to use each tool effectively
 *   5. Operational Guidelines — tone, style, conventions
 *   6. Git Repository — git workflow if applicable
 *   7. Memory/Context — injected from Tau shared layer
 *   8. Environment — volatile per-turn info (cwd, date, git status)
 *
 * Sections 1-6 are STABLE (cacheable). Sections 7-8 are VOLATILE.
 * The boundary is marked so the Gemini cache manager hashes only stable content.
 */

import type { SystemPromptParts } from '../types.js'
import {
  type StableSlot,
  type VolatileSlot,
  stableFrom,
  renderVolatileSlot,
  flatten,
} from '../shared/system_slots.js'
import { WEB_SEARCH_AUTO_USE_GUIDANCE } from '../../tools/WebSearchTool/prompt.js'

// ─── Model-Family Detection ──────────────────────────────────────

type GeminiFamily = 'gemini-3' | 'default-legacy'

function detectFamily(model: string): GeminiFamily {
  const m = model.toLowerCase()
  if (/gemini-3(\.|-|$)/.test(m) || /gemini-4/.test(m)) return 'gemini-3'
  return 'default-legacy'
}

// ─── Stable Prompt Sections ──────────────────────────────────────

function preamble(family: GeminiFamily): string {
  return `You are an interactive AI coding agent. You are pair-programming with the user to solve their coding task.
The task may require creating a new codebase, modifying or debugging an existing codebase, or simply answering a question.

Each time the user sends a message, carefully assess what information you need. Use your tools to efficiently gather context, then provide a response.`
}

function coreMandates(): string {
  return `## Core Mandates

### Security
- NEVER expose credentials, API keys, tokens, or secrets in output or tool calls
- NEVER execute commands that could exfiltrate data or compromise the system
- If asked to do something potentially harmful, explain the risk and suggest a safe alternative

### Engineering Standards
- Write clean, idiomatic, well-structured code
- Follow existing project conventions and patterns
- Prefer editing existing files over creating new ones
- Test your changes when possible
- Do not add unnecessary complexity, comments, or abstractions`
}

function workflows(family: GeminiFamily): string {
  if (family === 'gemini-3') {
    return `## Workflow

For each task, follow this workflow:
1. **Research** — Read relevant files, search the codebase, understand context
2. **Strategy** — Plan your approach before writing code
3. **Execute** — Make changes, test them, verify correctness
4. **Report** — Summarize what you did and why

Use \`enter_plan_mode\` for complex tasks that need careful research before implementation.`
  }

  return `## Workflow

Follow this general approach for each task:
1. Gather context — read relevant files, search the codebase
2. Plan your approach — think before coding
3. Make changes — edit files, run commands
4. Verify — test your changes work correctly
5. Summarize — tell the user what you did`
}

function toolUsageGuidelines(): string {
  return `## Tool Usage

- **read_file**: Read files before editing them. Use start_line/end_line for large files.
- **replace**: Include 3+ lines of surrounding context in old_string for unique matching. Check the file content first.
- **run_shell_command**: Include a description of what the command does. Prefer dedicated tools (read_file, grep_search) over shell equivalents (cat, grep).
- **grep_search**: Use for searching code content. Preferred over run_shell_command with grep.
- **glob**: Use for finding files by pattern. Preferred over run_shell_command with find.
- **google_web_search**: ${WEB_SEARCH_AUTO_USE_GUIDANCE}
- **web_fetch**: Use to read web pages, documentation URLs, or GitHub files.

Do NOT use tools when you can answer from context. Do NOT read files you've already read in this conversation unless they may have changed.`
}

function operationalGuidelines(): string {
  return `## Guidelines

- Be concise. Don't repeat what the user already knows.
- When referencing code, include file paths.
- Don't add features, refactoring, or "improvements" beyond what was asked.
- A bug fix doesn't need surrounding code cleaned up.
- Don't add error handling for scenarios that can't happen.
- When making changes, verify they work before reporting completion.
- If you're unsure about something, ask the user rather than guessing.
- When a tool call fails, diagnose first: read the exit code/error text, verify what's installed/available and the right path, then run a focused correction. Investigation (\`which X\`, \`X --help\`, \`ls path\`, docs) is work, but the next step is the corrected retry.
- Keep the failure balance: don't retry blindly, don't abandon a viable approach after one failure, and don't punt/paste commands to the user. If you start a background retry, keep monitoring output until it finishes or gives actionable evidence; don't end with only "retry started".
- Bash autonomy: run shell commands yourself by default. \`! <cmd>\` paste-to-user is for interactive logins/TUIs, not routine installs or config.
- Skills: if \`/skill-name\` is invoked or a listed relevant skill is surfaced, use the Skill tool. Only use listed skills; don't invent names.
- Subagents: for broad exploration, deep research, or independent parallel work, delegate with the Agent tool and matching \`subagent_type\`; don't duplicate that work.
- MCP management (\`claude mcp add <name> <cmd>\`, \`claude mcp list\`, \`claude mcp remove\`) is normal Bash. Run it yourself; don't paste it to the user.
- For unfamiliar CLIs, libraries, or APIs, verify the exact syntax once (\`--help\`, official docs, the tool's source) instead of guessing flags and iterating.`
}

function gitRepoSection(): string {
  return `## Git Repository

This workspace is a git repository. When working with git:
- Read diffs and status before committing
- Write clear, descriptive commit messages
- Don't force push or use destructive git operations without asking
- Prefer creating new commits over amending existing ones`
}

// ─── Full Prompt Assembly ────────────────────────────────────────

/**
 * Assemble the complete Gemini system prompt.
 *
 * Returns `{ stable, volatile }` — only the stable slot may feed the
 * Gemini `cachedContents` key; the volatile slot goes inline as a
 * leading user message so the cache key stays byte-identical across
 * turns when only env/git/memory change.
 */
export function assembleGeminiSystemPrompt(
  model: string,
  parts: SystemPromptParts,
): { stable: StableSlot; volatile: VolatileSlot; full: string } {
  const family = detectFamily(model)

  // Lane preamble = preamble + mandates + workflow + tool-usage +
  // guidelines + git-section. Same every turn; belongs in cache key.
  const lanePreamble = [
    preamble(family),
    coreMandates(),
    workflows(family),
    toolUsageGuidelines(),
    operationalGuidelines(),
    gitRepoSection(),
  ].join('\n\n')

  // Stable slot: lane preamble + user/project stable additions
  // (customInstructions, toolsAddendum, mcpIntro, skillsContext).
  const stable = stableFrom(lanePreamble, parts)

  // Volatile slot: memory + environment + git status.
  const volatile = renderVolatileSlot(parts)

  // `full` keeps the flat form for lanes/paths that can't carry the
  // split (e.g. non-cached legacy shim path). No boundary marker —
  // that was a Claude-Code leak; Gemini doesn't read it.
  const full = flatten(stable, volatile)

  return { stable, volatile, full }
}

/**
 * Build the `systemInstruction` field for the Gemini API using ONLY
 * the stable slot — so its bytes match across turns and `cachedContents`
 * can hit. The volatile slot travels as a leading user message and is
 * wired separately by the lane's request builder.
 */
export function buildGeminiSystemInstruction(
  model: string,
  parts: SystemPromptParts,
): { parts: Array<{ text: string }> } {
  const { stable } = assembleGeminiSystemPrompt(model, parts)
  return { parts: [{ text: stable }] }
}

/**
 * Legacy/debug helper: flat system prompt with stable+volatile joined.
 * Lanes/paths that can't carry the split use this; they forgo caching.
 */
export function buildFlatGeminiSystemPrompt(
  model: string,
  parts: SystemPromptParts,
): string {
  const { full } = assembleGeminiSystemPrompt(model, parts)
  return full
}
