import { toolMatchesName } from '../../Tool.js'
import { AGENT_TOOL_NAME } from '../../tools/AgentTool/constants.js'
import { registerBundledSkill } from '../bundledSkills.js'

const INTRO = `You are improving the quality of the changed code, not hunting for bugs. Review it for reuse, simplification, efficiency, and altitude issues, then fix what you find. Do not look for correctness bugs; that is a separate review.`

const NO_AGENT_TOOL = `The ${AGENT_TOOL_NAME} tool isn't available in this context, so the usual 4-agent fan-out can't run. Work through all four angles below yourself, in this same context, in one pass — do not skip an angle for lack of fan-out.`

// '@{upstream}' is quoted because PowerShell reads a bare @{...} as a hashtable.
function gatherDiff(args: string): string {
  const argument = args.trim()
  const argumentNote = argument
    ? `\n\nArgument: ${argument}\nIf it is a PR number, an existing branch, or an existing file path, review that instead: the PR's or branch's diff against the default branch, or that file. Anything else is extra focus only, and the scope stays the diff.`
    : ''
  return `## Phase 0 — Gather the diff

Run \`git diff '@{upstream}...HEAD'\` to get the unified diff under review. Without an upstream, use \`git diff main...HEAD\` (\`master...HEAD\` where that is the default branch) or \`git diff HEAD~1 HEAD\` (the last commit). If there are uncommitted changes, or the range diff is empty, also run \`git diff HEAD\` and include the working-tree changes in scope — the review often runs before the commit. Add \`--irreversible-delete\` (\`-D\`) so deleted files are listed without their contents, and check the size with \`--stat\` first: if the diff is too large to read in one go, read it one file at a time with \`git diff -D <range> -- <file>\`. Outside a git repository, or with no changes at all, review the files you edited earlier in this conversation or that the user named.${argumentNote}

That is the review scope. Read other project files only for context — never review or edit them, and never search outside the project.`
}

const FINDING_FIELDS =
  '`file`, `line`, a one-line `summary`, and the concrete cost (what is duplicated, wasted, or harder to maintain)'

const ANGLES = `### Reuse

Flag new code that re-implements something the codebase already has — Grep shared/utility modules and files adjacent to the change, and name the existing helper, constant, or type to use instead.

### Simplification

Flag unnecessary complexity the diff adds: redundant or derivable state, copy-paste with slight variation, deep nesting, dead code left behind, comments that narrate the change or restate the code. Name the simpler form that does the same job.

### Efficiency

Flag wasted work the diff introduces: redundant computation or repeated I/O, independent operations run sequentially, blocking work added to startup or hot paths, memory that only grows (unbounded caches or queues, missing cleanup, listener leaks). Also flag long-lived objects built from closures or captured environments — they keep the entire enclosing scope alive for the object's lifetime (a memory leak when that scope holds large values); prefer a class/struct that copies only the fields it needs. Name the cheaper alternative.

### Altitude (root cause, not symptom)

Check that each change fixes the root cause at the right depth rather than patching a symptom with a fragile bandaid. Special cases layered on shared infrastructure are a sign the fix isn't deep enough — prefer the simpler, more general change to the underlying mechanism over adding special cases, and name that change.`

const FIX_RULES = `Before removing or renaming anything, find every use of it. Skip any finding whose fix would change observable behavior (what users or callers see or get), reach outside the review scope, or that you judge to be a false positive — note the skip rather than arguing with it. Finish with a brief summary of what was fixed and what was skipped (or confirm the code was already clean).`

function fanOutPrompt(args: string): string {
  return [
    INTRO,
    gatherDiff(args),
    `## Phase 1 — Review (4 cleanup agents in parallel)

Launch **4 independent review agents** via the ${AGENT_TOOL_NAME} tool, all in a single message so they run concurrently. Do it as soon as you have the diff: the agents do the reading. Give each a complete, self-contained brief: the diff, one of the four angles below copied in full, the scope rule above, and this rule: report findings only, never edit files or run skills. When the diff is too large to paste, give the changed files and the per-file command (\`git diff -D <range> -- <file>\`) instead of a saved copy. Each returns its findings with ${FINDING_FIELDS}.`,
    ANGLES,
    `## Phase 2 — Apply the fixes

Wait for all four agents to complete. If an agent fails or returns no report, review its angle yourself and say so in your summary. Dedup findings that point at the same line or mechanism, and fix each remaining one directly. ${FIX_RULES}`,
  ].join('\n\n')
}

function singlePassPrompt(args: string): string {
  return [
    INTRO,
    NO_AGENT_TOOL,
    gatherDiff(args),
    `## Phase 1 — Review (4 cleanup angles, single pass)

Review the diff against each angle below in turn. For each, note findings with ${FINDING_FIELDS}.`,
    ANGLES,
    `## Phase 2 — Apply the fixes

Dedup findings that point at the same line or mechanism, and fix each remaining one directly. ${FIX_RULES} State clearly in your summary that this was a single-pass review done without the ${AGENT_TOOL_NAME} tool, not the full 4-agent fan-out, so whoever reads it isn't misled about what actually ran.`,
  ].join('\n\n')
}

export function registerSimplifySkill(): void {
  registerBundledSkill({
    name: 'simplify',
    description:
      'Review the changed code for reuse, simplification, efficiency, and altitude cleanups, then apply the fixes. Quality only — it does not hunt for bugs.',
    userInvocable: true,
    async getPromptForCommand(args, context) {
      // Keyed on the tool, not the power mode: subagents such as /batch
      // workers lack the Agent tool too, not only cheap mode.
      const canFanOut = context.options.tools.some(tool =>
        toolMatchesName(tool, AGENT_TOOL_NAME),
      )
      const text = canFanOut ? fanOutPrompt(args) : singlePassPrompt(args)
      return [{ type: 'text', text }]
    },
  })
}
