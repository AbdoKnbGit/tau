import {
  buildSearchingPastContextSection,
  DIRS_EXIST_GUIDANCE,
  ENTRYPOINT_NAME,
  MAX_ENTRYPOINT_LINES,
} from './memdir.js'
import {
  MEMORY_DRIFT_CAVEAT,
  MEMORY_FRONTMATTER_EXAMPLE,
  MEMORY_TYPES,
  TRUSTING_RECALL_SECTION,
  TYPES_SECTION_COMBINED,
  WHAT_NOT_TO_SAVE_SECTION,
} from './memoryTypes.js'
import { getAutoMemPath } from './paths.js'
import { getTeamMemPath } from './teamMemPaths.js'
import { isReplModeEnabled } from '../tools/REPLTool/constants.js'

/**
 * Build the combined prompt when both auto memory and team memory are enabled.
 * Closed four-type taxonomy (user / feedback / project / reference) with
 * per-type <scope> guidance embedded in XML-style <type> blocks.
 */
export function buildCombinedMemoryPrompt(
  extraGuidelines?: string[],
  skipIndex = false,
): string {
  const autoDir = getAutoMemPath()
  const teamDir = getTeamMemPath()

  const howToSave = skipIndex
    ? [
        '## How to save memories',
        '',
        "Write each memory to its own file in the chosen directory (private or team, per the type's scope guidance) using this frontmatter format:",
        '',
        ...MEMORY_FRONTMATTER_EXAMPLE,
        '',
        '- Keep the name, description, and type fields in memory files up-to-date with the content',
        '- Organize memory semantically by topic, not chronologically',
        '- Update or remove memories that turn out to be wrong or outdated',
        '- Do not write duplicate memories. First check if there is an existing memory you can update before writing a new one.',
      ]
    : [
        '## How to save memories',
        '',
        'Saving a memory is a two-step process:',
        '',
        "**Step 1** — write the memory to its own file in the chosen directory (private or team, per the type's scope guidance) using this frontmatter format:",
        '',
        ...MEMORY_FRONTMATTER_EXAMPLE,
        '',
        `**Step 2** — add a pointer to that file in the same directory's \`${ENTRYPOINT_NAME}\`. Each directory (private and team) has its own \`${ENTRYPOINT_NAME}\` index — each entry should be one line, under ~150 characters: \`- [Title](file.md) — one-line hook\`. They have no frontmatter. Never write memory content directly into a \`${ENTRYPOINT_NAME}\`.`,
        '',
        `- Both \`${ENTRYPOINT_NAME}\` indexes are loaded into your conversation context — lines after ${MAX_ENTRYPOINT_LINES} will be truncated, so keep them concise`,
        '- Keep the name, description, and type fields in memory files up-to-date with the content',
        '- Organize memory semantically by topic, not chronologically',
        '- Update or remove memories that turn out to be wrong or outdated',
        '- Do not write duplicate memories. First check if there is an existing memory you can update before writing a new one.',
      ]

  const lines = [
    '# Memory',
    '',
    `You have a persistent, file-based memory system with two directories: a private directory at \`${autoDir}\` and a shared team directory at \`${teamDir}\`. ${DIRS_EXIST_GUIDANCE}`,
    '',
    "You should build up this memory system over time so that future conversations can have a complete picture of who the user is, how they'd like to collaborate with you, what behaviors to avoid or repeat, and the context behind the work the user gives you.",
    '',
    'If the user explicitly asks you to remember something, save it immediately as whichever type fits best. If they ask you to forget something, find and remove the relevant entry.',
    '',
    '## Memory scope',
    '',
    'There are two scope levels:',
    '',
    `- private: memories that are private between you and the current user. They persist across conversations with only this specific user and are stored at the root \`${autoDir}\`.`,
    `- team: memories that are shared with and contributed by all of the users who work within this project directory. Team memories are synced at the beginning of every session and they are stored at \`${teamDir}\`.`,
    '',
    ...TYPES_SECTION_COMBINED,
    ...WHAT_NOT_TO_SAVE_SECTION,
    '- You MUST avoid saving sensitive data within shared team memories. For example, never save API keys or user credentials.',
    '',
    ...howToSave,
    '',
    '## When to access memories',
    '- When memories (personal or team) seem relevant, or the user references prior work with them or others in their organization.',
    '- You MUST access memory when the user explicitly asks you to check, recall, or remember.',
    '- If the user says to *ignore* or *not use* memory: proceed as if MEMORY.md were empty. Do not apply remembered facts, cite, compare against, or mention memory content.',
    MEMORY_DRIFT_CAVEAT,
    '',
    ...TRUSTING_RECALL_SECTION,
    '',
    '## Memory and other forms of persistence',
    'Memory is one of several persistence mechanisms available to you as you assist the user in a given conversation. The distinction is often that memory can be recalled in future conversations and should not be used for persisting information that is only useful within the scope of the current conversation.',
    '- When to use or update a plan instead of memory: If you are about to start a non-trivial implementation task and would like to reach alignment with the user on your approach you should use a Plan rather than saving this information to memory. Similarly, if you already have a plan within the conversation and you have changed your approach persist that change by updating the plan rather than saving a memory.',
    '- When to use or update tasks instead of memory: When you need to break your work in current conversation into discrete steps or keep track of your progress use tasks instead of saving to memory. Tasks are great for persisting information about the work that needs to be done in the current conversation, but memory should be reserved for information that will be useful in future conversations.',
    ...(extraGuidelines ?? []),
    '',
    ...buildSearchingPastContextSection(autoDir),
  ]

  return lines.join('\n')
}

/** Cheap-mode combined private/team contract; normal keeps the eval-tuned prompt. */
export function buildCompactCombinedMemoryPrompt(
  extraGuidelines?: string[],
  skipIndex = false,
  replMode = isReplModeEnabled(),
): string {
  const autoDir = getAutoMemPath()
  const teamDir = getTeamMemPath()
  const indexGuidance = skipIndex
    ? '- Store each memory in its own topic file; this configuration does not require index updates.'
    : `- After writing a topic file, add/update one pointer in that directory's \`${ENTRYPOINT_NAME}\`: \`- [Title](file.md) — one-line hook\`. Indexes have no frontmatter; keep pointers under ~150 characters, never put memory content there, and keep each index within ${MAX_ENTRYPOINT_LINES} lines.`

  return [
    '# Memory',
    replMode
      ? `Private directory: \`${autoDir}\`. Shared team directory: \`${teamDir}\`. Both exist; write through the REPL's documented file interface—do not call hidden primitive tools, probe for the directories, or run mkdir.`
      : `Private directory: \`${autoDir}\`. Shared team directory: \`${teamDir}\`. Both exist; write directly with Write—do not probe or run mkdir.`,
    '',
    '## Save and scope contract',
    '- Explicit remember request: save immediately under the best type/scope. Forget request: remove or update the relevant entry.',
    '- Save only durable context not reliably derivable from current code or git:',
    '  - `user`: role/goals/knowledge; always private.',
    '  - `feedback`: correction, preference, or confirmed non-obvious success; private by default, team only for a project-wide convention.',
    '  - `invariant`: explicitly absolute gate; team by default, private only for a personal hard line; surface conflicts rather than overriding it.',
    '  - `decision`: significant choice, alternatives, and rationale; usually team; mark superseded decisions.',
    '  - `project`: non-code goals/deadlines/incidents/coordination; strongly prefer team and make dates absolute.',
    '  - `reference`: location of current external information; usually team.',
    '- Never put secrets/credentials or sensitive personal data in team memory. Never save negative personal judgments, code patterns/architecture/paths, git history, fix recipes, CLAUDE.md content, or current-task/conversation/temporary state. These exclusions still apply when asked; isolate the surprising durable lesson or ask what it is.',
    '',
    '## File contract',
    'Use one semantic topic file per memory in the chosen directory, with:',
    '```markdown',
    '---',
    'name: <specific name>',
    'description: <one-line relevance hook>',
    `type: <${MEMORY_TYPES.join('|')}>`,
    '---',
    '<rule or fact; for feedback/invariant/decision/project include **Why:** and **How to apply:**>',
    '```',
    '- Search first and update instead of duplicating. Keep frontmatter accurate; update/remove stale or wrong memories.',
    indexGuidance,
    '',
    '## Recall contract',
    '- Access relevant private/team memory and always access it when explicitly asked to check, recall, or remember.',
    '- If told to ignore/not use memory, act as if both indexes were empty: do not apply, cite, compare against, or mention memory.',
    '- Memory is historical, not current truth. Before advice/action, verify paths, functions/flags, and external resources. Current evidence wins; update/remove stale memory. Use code/git for recent repo state.',
    '- Plans and tasks track this conversation; memory is only durable future context.',
    ...(extraGuidelines && extraGuidelines.length > 0
      ? ['', ...extraGuidelines]
      : []),
    '',
    ...buildSearchingPastContextSection(autoDir),
  ].join('\n')
}
