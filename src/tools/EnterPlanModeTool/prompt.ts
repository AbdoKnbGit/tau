import { ASK_USER_QUESTION_TOOL_NAME } from '../AskUserQuestionTool/prompt.js'

export function getEnterPlanModeToolPrompt(): string {
  const policy =
    process.env.USER_TYPE === 'ant'
      ? `Use only when genuine ambiguity, unclear requirements, competing architectures, or high-impact restructuring could cause substantial rework. Skip clear or specifically instructed work, routine multi-file changes, small fixes, and pure research; start directly or ask a targeted ${ASK_USER_QUESTION_TOOL_NAME} question instead.`
      : `Use proactively for non-trivial implementation unless the task is simple or already specifies a clear approach. Prefer it for new features, behavior changes, architectural choices, multi-file work, unclear requirements, or choices where user preference matters. Skip small obvious fixes and pure research.`
  return `Request approval to enter read-only plan mode before implementation. ${policy} In plan mode, inspect the codebase, resolve requirements, write a concrete plan, then call ExitPlanMode for approval. Do not edit implementation files.

Plan "add authentication" — session vs JWT, token storage, and middleware are real choices. Start directly on "add a logout button following the existing pattern".`
}
