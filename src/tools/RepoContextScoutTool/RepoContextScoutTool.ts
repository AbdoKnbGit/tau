import { existsSync } from 'fs'
import { join } from 'path'
import { createElement } from 'react'
import { z } from 'zod/v4'

import { buildTool, type ToolDef } from '../../Tool.js'
import { Text } from '../../ink.js'
import { collectCoChangeCoupling } from '../../utils/changeCoupling.js'
import {
  assessChangeRisk,
  collectGitChangeSummary,
  resolveAnalysisRoot,
} from '../../utils/changeRisk.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { retrieveCodebase } from '../CodebaseRetrievalTool/CodebaseRetrievalTool.js'
import { detectProjectWorkflow } from '../ProjectWorkflowTool/ProjectWorkflowTool.js'
import { REPO_CONTEXT_SCOUT_TOOL_NAME } from './constants.js'

const DESCRIPTION =
  'Preflight a coding task by combining repo retrieval, workflow detection, git changes, and risk. Read-only.'

const PROMPT = `Run a lightweight preflight scout for a coding task. This combines Tau-native repo retrieval, project workflow detection, git change summary, and risk-based review guidance. It is read-only and does not edit files, run tests, or spawn agents.

Use before unfamiliar edits, broad refactors, provider/lane work, token/cache/tool-output changes, or agentic workflow changes. Keep follow-up reads focused on the returned files and checks.`

function renderText(message: string): React.ReactNode {
  return createElement(Text, null, message)
}

const inputSchema = lazySchema(() =>
  z.strictObject({
    task: z.string().min(1).describe('Coding task, bug, or feature to scout.'),
    root: z
      .string()
      .optional()
      .describe('Repository root or file path to inspect. Defaults to the current working directory.'),
    changedFiles: z
      .array(z.string())
      .max(200)
      .optional()
      .describe('Optional explicit changed files when git status is unavailable or incomplete.'),
    maxFiles: z
      .number()
      .int()
      .min(1)
      .max(15)
      .optional()
      .describe('Maximum retrieved context files to include. Defaults to 8.'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const retrievedFileSchema = z.object({
  path: z.string(),
  relativePath: z.string(),
  score: z.number(),
  reason: z.string(),
  snippet: z.string().optional(),
})

const workflowCommandSchema = z.object({
  name: z.string(),
  command: z.string(),
  purpose: z.string(),
})

const workflowManifestSchema = z.object({
  type: z.string(),
  path: z.string(),
  commands: z.array(workflowCommandSchema),
})

const changedFileSchema = z.object({
  path: z.string(),
  status: z.string().optional(),
  additions: z.number().optional(),
  deletions: z.number().optional(),
})

const coChangePartnerSchema = z.object({
  path: z.string(),
  partnerOf: z.string(),
  score: z.number(),
  ratio: z.number(),
  lastCoChange: z.string().optional(),
})

const outputSchema = lazySchema(() =>
  z.object({
    task: z.string(),
    root: z.string(),
    hasCodeGraph: z.boolean(),
    retrievedFiles: z.array(retrievedFileSchema),
    searchedFiles: z.number(),
    retrievalTruncated: z.boolean(),
    workflow: z.object({
      root: z.string(),
      manifests: z.array(workflowManifestSchema),
      recommendations: z.array(z.string()),
      warnings: z.array(z.string()),
    }),
    changes: z.object({
      isGitRepo: z.boolean(),
      changedFiles: z.array(changedFileSchema),
      additions: z.number(),
      deletions: z.number(),
      warnings: z.array(z.string()),
    }),
    coupling: z
      .object({
        partners: z.array(coChangePartnerSchema),
        commitsScanned: z.number(),
        warnings: z.array(z.string()),
      })
      .optional(),
    risk: z.object({
      level: z.enum(['low', 'medium', 'high']),
      score: z.number(),
      triggers: z.array(z.string()),
      reviewRecommended: z.boolean(),
      verifyRecommended: z.boolean(),
      suggestedChecks: z.array(z.string()),
      notes: z.array(z.string()),
    }),
    contextPlan: z.array(z.string()),
    recommendedTools: z.array(z.string()),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

function buildContextPlan(output: Omit<Output, 'contextPlan'>): string[] {
  const plan: string[] = []
  if (output.hasCodeGraph) {
    plan.push('Use CodeGraph first for exact symbols and call paths, then read only the files it identifies.')
  } else {
    plan.push('Read the top retrieved files first, then use Grep/LSP for exact symbols and call paths.')
  }
  if (output.changes.changedFiles.length > 0) {
    plan.push('Anchor review around the detected changed files before widening context.')
  }
  if ((output.coupling?.partners.length ?? 0) > 0) {
    plan.push('Check the co-change partners below — files that historically ship with the ones being changed but are untouched so far.')
  }
  if (output.workflow.recommendations.length > 0) {
    plan.push('Use ProjectWorkflow recommendations for build, test, lint, or dev commands instead of guessing.')
  }
  if (output.risk.reviewRecommended || output.risk.verifyRecommended) {
    plan.push('Run focused review and verification because the change risk is not low.')
  } else {
    plan.push('Keep verification lightweight unless new evidence increases risk.')
  }
  return plan
}

function recommendedTools(hasCodeGraph: boolean, riskLevel: string): string[] {
  return [
    ...(hasCodeGraph ? ['CodeGraph'] : ['CodebaseRetrieval']),
    'Grep',
    'Read',
    'ProjectWorkflow',
    ...(riskLevel === 'low' ? [] : ['ChangeRisk']),
    'WorkflowRecipe',
    'ToolOutputRetrieve',
  ]
}

export const RepoContextScoutTool = buildTool({
  name: REPO_CONTEXT_SCOUT_TOOL_NAME,
  searchHint: 'preflight repo context risk',
  maxResultSizeChars: 120_000,
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
    return 'Scouting repo context'
  },
  isReadOnly() {
    return true
  },
  isConcurrencySafe() {
    return true
  },
  toAutoClassifierInput(input) {
    return `${input.task} ${input.root ?? ''} ${(input.changedFiles ?? []).join(' ')}`.trim()
  },
  async validateInput(input) {
    if (!input.task?.trim()) {
      return {
        result: false,
        message: 'RepoContextScout requires a non-empty task.',
        errorCode: 1,
      }
    }
    if (input.root !== undefined && !input.root.trim()) {
      return {
        result: false,
        message: 'RepoContextScout root must be non-empty when provided.',
        errorCode: 1,
      }
    }
    return { result: true }
  },
  renderToolUseMessage(input) {
    return renderText(`Scouting context for ${input.task}`)
  },
  renderToolResultMessage(output) {
    return renderText(
      `${output.retrievedFiles.length} context file(s), ${output.risk.level} risk`,
    )
  },
  async call(input) {
    const root = resolveAnalysisRoot(input.root)
    const retrieval = retrieveCodebase({
      query: input.task,
      root,
      maxResults: input.maxFiles ?? 8,
      includeSnippets: true,
    })
    const workflow = detectProjectWorkflow({ path: root, maxDepth: 2 })
    const changes = await collectGitChangeSummary(root, input.changedFiles)
    const risk = assessChangeRisk(changes)
    const hasCodeGraph = existsSync(join(changes.root, '.codegraph'))
    const coupling =
      changes.isGitRepo && changes.changedFiles.length > 0
        ? await collectCoChangeCoupling(
            changes.root,
            changes.changedFiles.map(file => file.path),
          )
        : { partners: [], commitsScanned: 0, warnings: [] }

    const partial = {
      task: input.task,
      root: changes.root,
      hasCodeGraph,
      retrievedFiles: retrieval.matches,
      searchedFiles: retrieval.searchedFiles,
      retrievalTruncated: retrieval.truncated,
      workflow,
      changes: {
        isGitRepo: changes.isGitRepo,
        changedFiles: changes.changedFiles,
        additions: changes.additions,
        deletions: changes.deletions,
        warnings: changes.warnings,
      },
      coupling,
      risk: {
        level: risk.level,
        score: risk.score,
        triggers: risk.triggers,
        reviewRecommended: risk.reviewRecommended,
        verifyRecommended: risk.verifyRecommended,
        suggestedChecks: risk.suggestedChecks,
        notes: risk.notes,
      },
      recommendedTools: recommendedTools(hasCodeGraph, risk.level),
    }

    return {
      data: {
        ...partial,
        contextPlan: buildContextPlan(partial),
      },
    }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    const lines = [
      `Task: ${output.task}`,
      `Root: ${output.root}`,
      `CodeGraph available: ${output.hasCodeGraph ? 'yes' : 'no'}`,
      `Searched files: ${output.searchedFiles}${output.retrievalTruncated ? ' (truncated)' : ''}`,
      `Changed files: ${output.changes.changedFiles.length} (+${output.changes.additions} -${output.changes.deletions})`,
      `Risk: ${output.risk.level} (score ${output.risk.score})`,
      '',
      'Context files:',
      ...(output.retrievedFiles.length > 0
        ? output.retrievedFiles.map(
            file => `- ${file.relativePath} (score ${file.score}): ${file.reason}`,
          )
        : ['- none found']),
      '',
      'Workflow recommendations:',
      ...(output.workflow.recommendations.length > 0
        ? output.workflow.recommendations.map(item => `- ${item}`)
        : ['- none']),
      '',
      'Risk triggers:',
      ...(output.risk.triggers.length > 0
        ? output.risk.triggers.map(trigger => `- ${trigger}`)
        : ['- none']),
      ...((output.coupling?.partners.length ?? 0) > 0
        ? [
            '',
            `Co-change partners (committed together historically over ${output.coupling!.commitsScanned} commits, NOT in the current change):`,
            ...output.coupling!.partners.map(
              partner =>
                `- ${partner.path} — ships with ${partner.partnerOf} in ${Math.round(partner.ratio * 100)}% of its commits (weight ${partner.score}${partner.lastCoChange ? `, last ${partner.lastCoChange}` : ''})`,
            ),
          ]
        : []),
      '',
      'Suggested checks:',
      ...(output.risk.suggestedChecks.length > 0
        ? output.risk.suggestedChecks.map(check => `- ${check}`)
        : ['- none']),
      '',
      'Context plan:',
      ...output.contextPlan.map(step => `- ${step}`),
      '',
      'Recommended tools:',
      ...output.recommendedTools.map(tool => `- ${tool}`),
      ...(output.workflow.warnings.length > 0 || output.changes.warnings.length > 0
        ? [
            '',
            'Warnings:',
            ...[...output.workflow.warnings, ...output.changes.warnings].map(
              warning => `- ${warning}`,
            ),
          ]
        : []),
    ]
    return { type: 'tool_result', tool_use_id: toolUseID, content: lines.join('\n') }
  },
} satisfies ToolDef<InputSchema, Output>)
