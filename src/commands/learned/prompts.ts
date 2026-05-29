import { getAutoMemLearnedPath, getAutoMemPath } from '../../memdir/paths.js'

/**
 * Agent instructions for each /learned action. The native /learned menu
 * (learned.tsx) renders the navigable list; once the user picks an action it
 * hands off to the hidden /learned-run command, which injects the matching
 * prompt below so the main agent does the work with full session context.
 *
 * Save model (one-step): when the user Approves a lesson, it is written
 * straight to ACTIVE memory — a topic file marked `origin: learned` plus a
 * one-line MEMORY.md pointer — and used from the next session on. There is no
 * separate "promote" step; the interactive approval IS the gate.
 *
 * Lessons are ALWAYS a single bullet — critical, general, and reusable across
 * future projects. NEVER specific code, file paths, line numbers, or routine
 * fixes.
 */

export const ACTIONS = ['view', 'learn', 'edit', 'delete'] as const
export type LearnedAction = (typeof ACTIONS)[number]

export function isLearnedAction(s: string): s is LearnedAction {
  return (ACTIONS as readonly string[]).includes(s)
}

/** The bar every lesson must clear. Shared by the menu actions and the
 * end-of-task offer so "what counts as a lesson" is defined in one place. */
export const LESSON_QUALITY_BAR = `## What counts as a lesson
A lesson is a **single concentrated bullet** capturing something **critical and general** — a reusable principle you would want to carry into the NEXT project (same stack/template or a different one). It must be worth interrupting the user to save.

Save things like:
- **Framework / library judgement** — e.g. when to reach for plain HTML vs a React component, server- vs client-rendering, a hook/lifecycle pitfall, an idiom that should be the default.
- **A whole class of bug and how to avoid it** — e.g. stale closures in effects, timezone/locale handling, off-by-one in pagination, unescaped braces in a config format.
- **Hard-won constraints or gotchas** of a tool, API, runtime, or environment.
- **Architecture / workflow principles** that clearly paid off.
- **User preferences** — how this user likes things done (style, tooling, process, how they want you to communicate).

Do NOT save: project-specific trivia, one-off fixes, routine implementation steps, anything obvious from reading the code, or a restatement of the task. When in doubt, save nothing — a junk lesson is worse than no lesson.

A good lesson is **portable**: no file paths, symbol names, or line numbers — phrase it as a general rule. Pick \`type\`: \`user\`/\`feedback\` for preferences, \`project\`/\`reference\` for technical principles.`

/** Shared header with the live active-memory path. */
function header(): string {
  const activeDir = getAutoMemPath()
  return `# Self-Learning

Approved lessons live in the active memory dir: \`${activeDir}\` — as topic files marked \`origin: learned\` in their frontmatter, each with a one-line pointer in \`MEMORY.md\`. They are loaded and used from the NEXT session on (writing one mid-session never affects the current session's cache).

This command is **only** about managing learned lessons. Do NOT resume, continue, or offer to continue any other task from the conversation — even if one is pending. Do exactly the one action below, then stop.`
}

const SHARED_RULES = `## Rules
- Always confirm before deleting or overwriting.
- An approved lesson = a topic file in the active memory dir carrying \`origin: learned\` + a one-line \`MEMORY.md\` pointer (\`- [Title](file.md) — short hook\`, under ~150 chars). That pointer is what makes it active next session — never skip it.
- Only ever touch \`origin: learned\` files and their \`MEMORY.md\` pointer lines. Never modify the user's own (non-\`origin: learned\`) memories unless they explicitly ask.`

const PROMPTS: Record<LearnedAction, () => string> = {
  view: () => {
    const stagingDir = getAutoMemLearnedPath()
    return `${header()}

## Task: show what I've learned
List every active lesson — the \`origin: learned\` files in the active memory dir — as concise bullet points (one per lesson, its general takeaway). These are what Tau actually uses. If there are none, say so.

Then check \`${stagingDir}\` for any leftover staged proposals from the old two-step flow. If any exist, list them separately under **Leftover proposals** and offer to either **activate** them (move the file into the active dir + add a \`MEMORY.md\` pointer) or **delete** them. If the dir is empty or missing, ignore it. Otherwise change nothing.

${SHARED_RULES}`
  },

  learn: () => `${header()}

## Task: learn from this session
Reflect on the CURRENT conversation and extract only lessons that clear the bar below. If nothing clears it, say so plainly — that is the correct outcome most of the time; never invent a lesson to have one.

${LESSON_QUALITY_BAR}

For EACH candidate lesson, present it as a single concentrated bullet (a general principle) and use the **AskUserQuestion** tool with exactly these options — never more than 4:
- **Approve** — save it and use it from now on.
- **Edit wording** — let me reword it before saving.
- **Skip** — discard this one.

Handle ONE lesson per AskUserQuestion call (so options never exceed 4). For each approved (or edited) lesson, save it as a topic file in the active memory dir with frontmatter \`name\`, \`description\`, \`type\` (user/feedback/project/reference), \`origin: learned\`, \`learnedAt: <today's date, YYYY-MM-DD>\`, then the general takeaway as the body — AND add its one-line \`MEMORY.md\` pointer. It is active from the next session.

${SHARED_RULES}`,

  edit: () => `${header()}

## Task: edit a lesson
List the active lessons (\`origin: learned\` files) as a **numbered list**, one bullet each. Do NOT use the AskUserQuestion tool for this list — there may be more than 4 lessons, and AskUserQuestion is capped at 4 options. Ask the user to reply with the number (or name) of the lesson to edit. Then show its current content, apply the change they describe by rewriting that file, keep its \`MEMORY.md\` pointer in sync, and keep the result a concentrated, portable bullet that still clears the bar below.

${LESSON_QUALITY_BAR}

${SHARED_RULES}`,

  delete: () => `${header()}

## Task: delete a lesson
List the active lessons (\`origin: learned\` files) as a **numbered list**, one bullet each. Do NOT use the AskUserQuestion tool for this list — there may be more than 4 lessons, and AskUserQuestion is capped at 4 options. Ask the user which one(s) are not worth keeping. Confirm, then delete the file(s) AND remove their matching \`MEMORY.md\` pointer line(s).

${SHARED_RULES}`,
}

export const HELP_TEXT = `/learned — review and manage what Tau learns automatically.

Usage:
  /learned            open the menu (navigate with ↑/↓, Enter to pick, Esc to cancel)
  /learned view       show every saved lesson
  /learned learn      capture lessons from this session
  /learned edit       reword a saved lesson
  /learned delete     remove a lesson
  /learned toggle     turn self-learning on/off (on|off also work)

Approve a lesson and it's saved and used from the next session — no extra promote step.
Lessons are always a single critical, general, reusable bullet — never specific code or file paths.`

/** Build the agent prompt for a given action, or help text for an unknown one. */
export function buildLearnedPrompt(action: string): string {
  const key = action.trim().toLowerCase()
  if (isLearnedAction(key)) {
    return PROMPTS[key]()
  }
  return `Unknown /learned action: \`${action}\`.\n\n${HELP_TEXT}`
}
