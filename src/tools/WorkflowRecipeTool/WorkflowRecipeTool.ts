import { createElement } from 'react'
import { z } from 'zod/v4'

import { buildTool, type ToolDef } from '../../Tool.js'
import { Text } from '../../ink.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { WORKFLOW_RECIPE_TOOL_NAME } from './constants.js'

const RECIPE_VALUES = [
  'auto',
  'repo-context-scout',
  'implement-feature',
  'fix-bug',
  'review-diff',
  'verify-change',
  'multi-agent-team',
  'token-safe-investigation',
] as const

type Recipe = (typeof RECIPE_VALUES)[number]

const DESCRIPTION =
  'Return a plug-and-play Tau workflow recipe for coding or agentic work. Read-only.'

const PROMPT = `Choose a concise Tau-native workflow recipe. This tool is read-only: it does not edit files, run commands, spawn agents, or contact services.

Use when a task needs orchestration but not a custom plan from scratch. Recipes should keep context bounded, prefer native tools, and scale review/verification only when risk justifies it.`

function renderText(message: string): React.ReactNode {
  return createElement(Text, null, message)
}

const inputSchema = lazySchema(() =>
  z.strictObject({
    task: z.string().min(1).describe('Task or workflow need.'),
    recipe: z
      .enum(RECIPE_VALUES)
      .optional()
      .describe('Recipe to return. Use auto when unsure.'),
    risk: z
      .enum(['low', 'medium', 'high'])
      .optional()
      .describe('Optional known risk level from ChangeRisk or user context.'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    recipe: z.enum(RECIPE_VALUES),
    title: z.string(),
    goal: z.string(),
    suggestedTools: z.array(z.string()),
    steps: z.array(z.string()),
    costControls: z.array(z.string()),
    reviewAndVerify: z.array(z.string()),
    stopConditions: z.array(z.string()),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

function inferRecipe(task: string, requested: Recipe | undefined): Recipe {
  if (requested && requested !== 'auto') return requested
  const text = task.toLowerCase()
  if (/\b(review|diff|pr|regression|risk)\b/.test(text)) return 'review-diff'
  if (/\b(verify|test|build|lint|typecheck)\b/.test(text)) return 'verify-change'
  if (/\b(agent|team|parallel|delegate|role|orchestrate)\b/.test(text)) {
    return 'multi-agent-team'
  }
  if (/\b(token|context|cache|large output|compressed|log)\b/.test(text)) {
    return 'token-safe-investigation'
  }
  if (/\b(bug|fix|failing|error|crash)\b/.test(text)) return 'fix-bug'
  if (/\b(feature|add|implement|native|workflow)\b/.test(text)) {
    return 'implement-feature'
  }
  return 'repo-context-scout'
}

function reviewSteps(risk: 'low' | 'medium' | 'high' | undefined): string[] {
  if (risk === 'high') {
    return [
      'Run ChangeRisk after edits and treat high-risk triggers as blockers until reviewed.',
      'Use a reviewer/verifier pass or equivalent manual diff review plus focused build/test verification.',
      'Do not finish on caveats alone; record any unverified surface explicitly.',
    ]
  }
  if (risk === 'medium') {
    return [
      'Run ChangeRisk after edits and review the changed files before finalizing.',
      'Run the narrowest verification command that covers the touched behavior.',
    ]
  }
  return [
    'Use lightweight self-review for tiny changes.',
    'Run focused verification only when source behavior changed or the user requested it.',
  ]
}

function recipeFor(
  recipe: Recipe,
  risk: 'low' | 'medium' | 'high' | undefined,
): Output {
  switch (recipe) {
    case 'implement-feature':
      return {
        recipe,
        title: 'Implement Feature',
        goal: 'Add behavior with preflight context, scoped edits, and proportional verification.',
        suggestedTools: ['RepoContextScout', 'Read', 'Grep', 'Edit', 'ProjectWorkflow', 'ChangeRisk'],
        steps: [
          'Call RepoContextScout with the feature request and target root.',
          'Read only the top context files and exact symbols needed for the change.',
          'Implement in the smallest existing ownership boundary that fits the repo.',
          'Use ProjectWorkflow to choose focused checks.',
          'Run ChangeRisk before final response and scale review/verify from its result.',
        ],
        costControls: [
          'Keep broad retrieval to RepoContextScout/CodebaseRetrieval before opening files.',
          'Do not spawn agents unless work can be split into independent deliverables.',
          'Use ToolOutputRetrieve ranges for compressed logs instead of re-reading whole outputs.',
        ],
        reviewAndVerify: reviewSteps(risk),
        stopConditions: [
          'The scoped implementation is done.',
          'Relevant checks passed or their failure is understood and reported.',
          'No medium/high risk trigger is left without a review or verification answer.',
        ],
      }
    case 'fix-bug':
      return {
        recipe,
        title: 'Fix Bug',
        goal: 'Reproduce or localize the failure, patch the narrow cause, and verify the failing path.',
        suggestedTools: ['RepoContextScout', 'ProjectWorkflow', 'Read', 'Grep', 'ChangeRisk'],
        steps: [
          'Scout the bug report, stack trace, or failing behavior with RepoContextScout.',
          'Find the closest failing test or source/test counterpart with Grep.',
          'Trace the minimal failing path before editing.',
          'Patch the root cause without unrelated cleanup.',
          'Verify the failing path first, then run broader checks only if risk requires it.',
        ],
        costControls: [
          'Prefer focused failing-output ranges over full logs.',
          'Avoid repeated broad grep once a file owner or symbol is identified.',
        ],
        reviewAndVerify: reviewSteps(risk),
        stopConditions: [
          'The original failure path is addressed.',
          'Focused verification has passed or the remaining failure is clearly unrelated.',
        ],
      }
    case 'review-diff':
      return {
        recipe,
        title: 'Review Diff',
        goal: 'Assess changed behavior, risk, and missing verification before shipping.',
        suggestedTools: ['ChangeRisk', 'Read', 'FileDiff', 'ProjectWorkflow'],
        steps: [
          'Run ChangeRisk to classify the current diff.',
          'Review changed files and nearby tests or call paths.',
          'Look for behavior regressions, unsafe assumptions, missing tests, and cache/token impacts.',
          'Recommend the narrowest checks that cover the risk triggers.',
        ],
        costControls: [
          'Review file summaries first; expand only files with behavior or contract changes.',
          'Do not run heavy verification for low-risk text-only changes.',
        ],
        reviewAndVerify: reviewSteps(risk),
        stopConditions: [
          'Findings are listed by severity, or no issues are found.',
          'Residual test gaps are explicit.',
        ],
      }
    case 'verify-change':
      return {
        recipe,
        title: 'Verify Change',
        goal: 'Choose and run checks that prove the changed behavior without wasting tokens or time.',
        suggestedTools: ['ProjectWorkflow', 'ChangeRisk', 'Bash'],
        steps: [
          'Use ProjectWorkflow to identify repo-native build/test/lint commands.',
          'Use Grep to find focused tests around changed files.',
          'Use ChangeRisk to decide whether focused checks are enough.',
          'Run focused checks first; widen only for medium/high risk or shared contracts.',
        ],
        costControls: [
          'Summarize long command output and retrieve exact saved ranges only when needed.',
          'Do not rerun the same failing command without a new hypothesis or change.',
        ],
        reviewAndVerify: reviewSteps(risk),
        stopConditions: [
          'A relevant check passed.',
          'Or a failing check is reported with the failure cause and next action.',
        ],
      }
    case 'multi-agent-team':
      return {
        recipe,
        title: 'Multi-Agent Team',
        goal: 'Split independent work across roles while keeping final ownership in the main thread.',
        suggestedTools: ['RepoContextScout', 'Agent', 'ChangeRisk', 'ProjectWorkflow'],
        steps: [
          'Run RepoContextScout first so spawned agents receive focused context.',
          'Spawn agents only for independent research, review, verification, or implementation deliverables.',
          'Give each agent explicit files, constraints, and output format.',
          'Integrate agent output in the main thread before final edits or response.',
          'Use ChangeRisk after integration to decide if reviewer/verifier agents are justified.',
        ],
        costControls: [
          'Do not spawn multiple agents for the same question.',
          'Keep agent prompts scoped to the files and decisions from RepoContextScout.',
          'Prefer one reviewer and one verifier only for medium/high risk changes.',
        ],
        reviewAndVerify: reviewSteps(risk),
        stopConditions: [
          'Each spawned agent returned a concrete deliverable.',
          'Main thread reconciled disagreements and completed verification.',
        ],
      }
    case 'token-safe-investigation':
      return {
        recipe,
        title: 'Token-Safe Investigation',
        goal: 'Investigate large outputs or broad code areas without blowing context.',
        suggestedTools: ['RepoContextScout', 'CodebaseRetrieval', 'ToolOutputRetrieve', 'Grep', 'Read'],
        steps: [
          'Start with RepoContextScout or CodebaseRetrieval instead of opening many files.',
          'For compressed tool output, use ToolOutputRetrieve with byte or line ranges.',
          'Expand context only around exact errors, symbols, or changed files.',
          'Persist conclusions in a concise todo or final summary rather than copying raw logs.',
        ],
        costControls: [
          'Default to small retrieval ranges.',
          'Do not request full saved outputs unless the range result proves it is necessary.',
          'Prefer one precise grep over repeated broad reads.',
        ],
        reviewAndVerify: reviewSteps(risk),
        stopConditions: [
          'The relevant evidence is identified with bounded context.',
          'The next edit or verification step is specific.',
        ],
      }
    case 'repo-context-scout':
    case 'auto':
    default:
      return {
        recipe: 'repo-context-scout',
        title: 'Repo Context Scout',
        goal: 'Build the smallest useful map of files, commands, and risk before acting.',
        suggestedTools: ['RepoContextScout', 'CodebaseRetrieval', 'Grep', 'Read', 'ProjectWorkflow', 'ChangeRisk'],
        steps: [
          'Call RepoContextScout with the task and root.',
          'Use CodeGraph first when available; otherwise read the top retrieved files.',
          'Use LSP/Grep for exact symbols after the scout narrows likely locations.',
          'Use ProjectWorkflow for command choices and ChangeRisk for review/verify gating.',
        ],
        costControls: [
          'Avoid broad file reads until the scout returns ranked context.',
          'Keep snippets and retrieved files capped.',
          'Use deferred tools through ToolSearch when they are not currently loaded.',
        ],
        reviewAndVerify: reviewSteps(risk),
        stopConditions: [
          'The likely owner files and commands are known.',
          'Risk level is known enough to decide the next action.',
        ],
      }
  }
}

export const WorkflowRecipeTool = buildTool({
  name: WORKFLOW_RECIPE_TOOL_NAME,
  searchHint: 'plug and play workflows',
  maxResultSizeChars: 80_000,
  shouldDefer: true,
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return PROMPT
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return 'Choosing workflow recipe'
  },
  isReadOnly() {
    return true
  },
  isConcurrencySafe() {
    return true
  },
  toAutoClassifierInput(input) {
    return `${input.task} ${input.recipe ?? ''} ${input.risk ?? ''}`.trim()
  },
  async validateInput(input) {
    if (!input.task?.trim()) {
      return {
        result: false,
        message: 'WorkflowRecipe requires a non-empty task.',
        errorCode: 1,
      }
    }
    return { result: true }
  },
  renderToolUseMessage(input) {
    return renderText(`Choosing workflow for ${input.task}`)
  },
  renderToolResultMessage(output) {
    return renderText(output.title)
  },
  async call(input) {
    const recipe = inferRecipe(input.task, input.recipe)
    return { data: recipeFor(recipe, input.risk) }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    const lines = [
      `${output.title}: ${output.goal}`,
      '',
      'Suggested tools:',
      ...output.suggestedTools.map(tool => `- ${tool}`),
      '',
      'Steps:',
      ...output.steps.map((step, index) => `${index + 1}. ${step}`),
      '',
      'Cost controls:',
      ...output.costControls.map(item => `- ${item}`),
      '',
      'Review and verify:',
      ...output.reviewAndVerify.map(item => `- ${item}`),
      '',
      'Stop conditions:',
      ...output.stopConditions.map(item => `- ${item}`),
    ]
    return { type: 'tool_result', tool_use_id: toolUseID, content: lines.join('\n') }
  },
} satisfies ToolDef<InputSchema, Output>)
