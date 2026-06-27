import { createElement } from 'react'
import { z } from 'zod/v4'

import { buildTool, type ToolDef } from '../../Tool.js'
import { Text } from '../../ink.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { TOOL_GUIDE_TOOL_NAME } from './constants.js'

const MODE_VALUES = [
  'auto',
  'browser',
  'codebase',
  'git_history',
  'spec',
  'workflow',
  'database',
  'deploy',
  'design',
  'test',
  'package',
  'memory',
  'multi_agent',
] as const

type Mode = (typeof MODE_VALUES)[number]

const DESCRIPTION =
  'Choose the right Tau-native workflow and tool sequence for a task. Read-only and does not execute actions.'

const PROMPT = `Return Tau-native guidance for choosing tools and behavior. This tool is read-only: it never edits files, runs commands, opens browsers, deploys code, or contacts services.

Use when the task could benefit from an explicit workflow decision before acting, especially browser/app verification, codebase exploration, git-history investigation, spec planning, workflow command detection, package work, database/integration work, deploy/expose work, design review, test selection, memory/skill work, or multi-agent delegation.

Prefer the workflow-specific Tau tools this guide recommends before falling back to generic Read, Grep, Glob, Bash, or Agent. Use generic tools after the workflow tool has narrowed the target, when the task is a trivial exact-file read/edit, or when the workflow tool is unavailable.

Do not use Cursor-specific tools, lane names, or behavior. Prefer portable Tau tools and deferred ToolSearch discovery.`

function renderText(message: string): React.ReactNode {
  return createElement(Text, null, message)
}

const inputSchema = lazySchema(() =>
  z.strictObject({
    task: z.string().min(1).describe('Short description of the task.'),
    mode: z
      .enum(MODE_VALUES)
      .optional()
      .describe('Optional workflow mode. Use auto when unsure.'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    mode: z.enum(MODE_VALUES),
    summary: z.string(),
    recommendedTools: z.array(z.string()),
    steps: z.array(z.string()),
    cautions: z.array(z.string()),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

function inferMode(task: string, mode: Mode | undefined): Mode {
  if (mode && mode !== 'auto') return mode

  const text = task.toLowerCase()
  if (
    /\b(browser|chrome|playwright|screenshot|dom|console|network|localhost|web app|ui)\b/.test(
      text,
    )
  ) {
    return 'browser'
  }
  if (/\b(test|spec|coverage|jest|vitest|pytest|unit|e2e)\b/.test(text)) {
    return 'test'
  }
  if (/\b(package|dependency|npm|pnpm|bun|yarn|pip|cargo|upgrade|install)\b/.test(text)) {
    return 'package'
  }
  if (/\b(git|commit|history|regression|blame|bisect|changed when)\b/.test(text)) {
    return 'git_history'
  }
  if (/\b(plan|spec|requirements|design doc|architecture proposal)\b/.test(text)) {
    return 'spec'
  }
  if (/\b(build|lint|dev server|run app|workflow|script|command)\b/.test(text)) {
    return 'workflow'
  }
  if (/\b(database|db|sql|migration|schema|supabase|postgres|redis)\b/.test(text)) {
    return 'database'
  }
  if (/\b(deploy|preview|production|vercel|netlify|fly|railway|expose|tunnel)\b/.test(text)) {
    return 'deploy'
  }
  if (/\b(design|visual|layout|responsive|css|figma|pixel)\b/.test(text)) {
    return 'design'
  }
  if (/\b(memory|skill|learned|preference|instruction)\b/.test(text)) {
    return 'memory'
  }
  if (/\b(agent|subagent|parallel|delegate|background|research)\b/.test(text)) {
    return 'multi_agent'
  }
  return 'codebase'
}

function workflowFor(mode: Mode): Pick<
  Output,
  'summary' | 'recommendedTools' | 'steps' | 'cautions'
> {
  switch (mode) {
    case 'browser':
      return {
        summary: 'Verify web/app behavior with the lightest browser-capable surface available.',
        recommendedTools: ['ToolSearch', 'ProjectWorkflow', 'InspectSite', 'VisualDesignAudit', 'WebFetch', 'WebSearch', 'Computer', 'Bash'],
        steps: [
          'Load ProjectWorkflow first to identify the dev/start command, then use InspectSite once a URL is available.',
          'Use ToolSearch to discover any installed browser automation tool before falling back to generic surfaces.',
          'Use WebFetch/WebSearch for public text pages and Computer or shell-driven local browser automation for rendered UI checks.',
          'Capture console, network, screenshot, and interaction evidence when debugging UI behavior.',
        ],
        cautions: [
          'Do not rely on static code inspection alone when the request is about visible browser behavior.',
          'Ask before using credentials or authenticated external sites unless the user already authorized it.',
        ],
      }
    case 'git_history':
      return {
        summary: 'Use git history to explain regressions or provenance before editing.',
        recommendedTools: ['GitHistorySearch', 'Bash', 'Read', 'Grep'],
        steps: [
          'Start with GitHistorySearch for semantic commit discovery before manual git log/show commands.',
          'Trace the smallest relevant file or symbol history before proposing a fix.',
          'Confirm current worktree changes before applying edits.',
        ],
        cautions: [
          'Do not reset, checkout, rebase, amend, or force-push unless explicitly requested.',
        ],
      }
    case 'spec':
      return {
        summary: 'Turn ambiguous work into an executable plan before implementation.',
        recommendedTools: ['SpecQuest', 'TodoWrite', 'TaskCreate', 'EnterPlanMode', 'Read', 'Grep'],
        steps: [
          'Use SpecQuest when the plan should persist in the repo as requirements, design, and tasks.',
          'Restate constraints, affected files, and acceptance checks.',
          'Break substantial work into visible tasks and update status as each task completes.',
          'Move from plan to implementation once uncertainty is low enough to act.',
        ],
        cautions: [
          'Keep planning proportional; simple edits do not need a long plan.',
        ],
      }
    case 'workflow':
      return {
        summary: 'Detect project commands before running build, lint, test, or dev workflows.',
        recommendedTools: ['ProjectWorkflow', 'PackageManager', 'Read', 'Bash'],
        steps: [
          'Call ProjectWorkflow near the target directory to identify manifests and scripts.',
          'Prefer repo-defined scripts over guessed commands.',
          'Run the narrowest verification command that proves the change.',
        ],
        cautions: [
          'Do not install or downgrade dependencies just to make a command pass without user approval.',
        ],
      }
    case 'database':
      return {
        summary: 'Handle data and integration work with explicit safety boundaries.',
        recommendedTools: ['IntegrationHub', 'ToolSearch', 'ListMcpResources', 'ReadMcpResource', 'Read', 'Bash'],
        steps: [
          'Load IntegrationHub before choosing providers, schemas, migrations, or environment variables.',
          'Use ToolSearch and MCP resource tools to find any connected database or integration server.',
          'Inspect schemas and migrations before writing queries or code.',
          'Prefer read-only checks first and ask before mutating shared data.',
        ],
        cautions: [
          'Never expose secrets in chat or store them in code.',
          'Ask before changing production data, credentials, or infrastructure.',
        ],
      }
    case 'deploy':
      return {
        summary: 'Treat deploy and expose actions as shared-state operations.',
        recommendedTools: ['DeployPreview', 'ProjectWorkflow', 'ToolSearch', 'Bash', 'WebFetch'],
        steps: [
          'Load DeployPreview before running deploy, expose, tunnel, or preview commands.',
          'Detect deploy scripts and hosting config before choosing commands.',
          'Use preview or dry-run commands when available.',
          'Verify the resulting URL or health check after deployment.',
        ],
        cautions: [
          'Ask before publishing, pushing, exposing local ports, or modifying CI/CD settings.',
        ],
      }
    case 'design':
      return {
        summary: 'Pair code inspection with visual verification for UI and design tasks.',
        recommendedTools: ['VisualDesignAudit', 'InspectSite', 'Read', 'Grep', 'ProjectWorkflow', 'ToolSearch', 'Computer'],
        steps: [
          'Load VisualDesignAudit before finishing frontend work; pair it with InspectSite or browser tools when the app can run.',
          'Find the relevant UI components and styling system first.',
          'Run or open the app and inspect at desktop and mobile sizes when possible.',
          'Check text fit, overlap, assets, and interaction states before finishing.',
        ],
        cautions: [
          'Do not ship UI changes based only on source diffs when rendered verification is feasible.',
        ],
      }
    case 'test':
      return {
        summary: 'Find related tests and project test commands before editing or verifying.',
        recommendedTools: ['TestSearch', 'ProjectWorkflow', 'Read', 'Grep', 'Bash'],
        steps: [
          'Call TestSearch for the changed source or failing test file.',
          'Use ProjectWorkflow to identify the repo-preferred test command.',
          'Run focused tests first, then broader tests when the blast radius justifies it.',
        ],
        cautions: [
          'Do not treat a passing unrelated test as verification for the requested change.',
        ],
      }
    case 'package':
      return {
        summary: 'Use manifest-aware package behavior and keep dependency changes explicit.',
        recommendedTools: ['PackageManager', 'ProjectWorkflow', 'Read', 'Bash'],
        steps: [
          'Load PackageManager before adding, removing, installing, or running package-manager-specific commands.',
          'Inspect package manifests and lockfiles before choosing a package manager.',
          'Use the package manager already used by the repo.',
          'Update lockfiles consistently when dependencies actually change.',
        ],
        cautions: [
          'Ask before major upgrades, downgrades, package removals, or registry/auth changes.',
        ],
      }
    case 'memory':
      return {
        summary: 'Use durable instructions and skills only for reusable behavior.',
        recommendedTools: ['Skill', 'Read', 'Write', 'Edit'],
        steps: [
          'Distinguish one-off task context from durable user or repo preferences.',
          'Use existing skill discovery when specialized workflows are available.',
          'Keep new memory or skill content concise and scoped.',
        ],
        cautions: [
          'Do not store secrets, transient debugging facts, or guesses as durable memory.',
        ],
      }
    case 'multi_agent':
      return {
        summary: 'Delegate only independent work that benefits from separate context.',
        recommendedTools: ['Agent', 'TaskCreate', 'TaskGet', 'TaskUpdate', 'TaskList'],
        steps: [
          'Split research, broad scans, or parallel investigations into clear independent tasks.',
          'Give each agent concrete files, goals, and output expectations.',
          'Integrate results in the main thread before editing shared files.',
        ],
        cautions: [
          'Do not delegate the same task repeatedly or lose ownership of final verification.',
        ],
      }
    case 'codebase':
    case 'auto':
    default:
      return {
        summary: 'Understand the repo with semantic and text search before changing code.',
        recommendedTools: ['ToolSearch', 'CodebaseRetrieval', 'LSP', 'Grep', 'Glob', 'Read', 'Agent'],
        steps: [
          'Use CodeGraph first when the repo has a .codegraph directory; otherwise load CodebaseRetrieval before broad Grep/Glob/Read exploration.',
          'Use LSP for exact symbols and Grep/Glob for literal evidence after CodebaseRetrieval narrows the likely files.',
          'Read the smallest relevant files and call paths before editing.',
          'Use Agent for broad independent exploration when it would keep the main context cleaner.',
        ],
        cautions: [
          'Do not rely on one text hit when symbol semantics or call hierarchy matter.',
        ],
      }
  }
}

export const ToolGuideTool = buildTool({
  name: TOOL_GUIDE_TOOL_NAME,
  searchHint: 'choose workflow tools behavior',
  maxResultSizeChars: 50_000,
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
    return 'Tool guide'
  },
  isReadOnly() {
    return true
  },
  isConcurrencySafe() {
    return true
  },
  toAutoClassifierInput(input) {
    return input.task
  },
  async validateInput(input) {
    if (!input.task?.trim()) {
      return {
        result: false,
        message: 'ToolGuide requires a non-empty task.',
        errorCode: 1,
      }
    }
    return { result: true }
  },
  renderToolUseMessage(input) {
    return renderText(
      input.mode ? `Choosing ${input.mode} workflow` : 'Choosing workflow',
    )
  },
  renderToolResultMessage(output) {
    return renderText(output.summary)
  },
  async call(input) {
    const mode = inferMode(input.task, input.mode)
    const workflow = workflowFor(mode)
    return {
      data: {
        mode,
        ...workflow,
      },
    }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    const lines = [
      `Mode: ${output.mode}`,
      `Summary: ${output.summary}`,
      '',
      'Recommended tools:',
      ...output.recommendedTools.map(tool => `- ${tool}`),
      '',
      'Steps:',
      ...output.steps.map(step => `- ${step}`),
      '',
      'Cautions:',
      ...output.cautions.map(caution => `- ${caution}`),
    ]
    return {
      type: 'tool_result',
      tool_use_id: toolUseID,
      content: lines.join('\n'),
    }
  },
} satisfies ToolDef<InputSchema, Output>)
