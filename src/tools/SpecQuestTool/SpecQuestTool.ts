import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { createElement } from 'react'
import { join } from 'path'
import { z } from 'zod/v4'

import { buildTool, type ToolDef } from '../../Tool.js'
import { Text } from '../../ink.js'
import { getCwd } from '../../utils/cwd.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { SPEC_QUEST_TOOL_NAME } from './constants.js'

const DESCRIPTION =
  'Create a repo-local spec/quest scaffold with requirements, design, and task plan files.'

const PROMPT = `Create a persistent repo-local spec workflow under .tau/specs/<slug> with requirements.md, design.md, and tasks.md.

Use for large features, ambiguous work, or user requests for /spec, /quest, requirements, design, or implementation plans. This writes files and should only be used when the user wants a persistent spec artifact.`

const inputSchema = lazySchema(() =>
  z.strictObject({
    title: z.string().min(1).describe('Spec/quest title.'),
    summary: z.string().optional().describe('Short feature summary or user request.'),
    slug: z.string().optional().describe('Optional filesystem slug. Generated from title if omitted.'),
    requirements: z.array(z.string()).optional().describe('Known requirements or acceptance criteria.'),
    tasks: z.array(z.string()).optional().describe('Initial implementation tasks.'),
    overwrite: z.boolean().optional().describe('Overwrite an existing spec scaffold. Defaults to false.'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    dir: z.string(),
    files: z.array(z.string()),
    created: z.boolean(),
    overwritten: z.boolean(),
    warnings: z.array(z.string()),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

function renderText(message: string): React.ReactNode {
  return createElement(Text, null, message)
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
  return slug || 'spec'
}

function frontMatter(title: string): string {
  return `---\ntitle: ${title}\nstatus: draft\n---\n\n`
}

export const SpecQuestTool = buildTool({
  name: SPEC_QUEST_TOOL_NAME,
  searchHint: 'create spec quest files',
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
    return 'Creating spec'
  },
  isReadOnly() {
    return false
  },
  isConcurrencySafe() {
    return false
  },
  isDestructive() {
    return false
  },
  toAutoClassifierInput(input) {
    return `${input.title} ${input.slug ?? ''}`.trim()
  },
  renderToolUseMessage(input) {
    return renderText(`Creating spec for ${input.title ?? 'feature'}`)
  },
  renderToolResultMessage(output) {
    const action = output.created ? 'Created' : output.overwritten ? 'Updated' : 'Found existing'
    return renderText(`${action} ${output.files.length} spec file(s)`)
  },
  async call(input) {
    const dir = join(getCwd(), '.tau', 'specs', slugify(input.slug ?? input.title))
    mkdirSync(dir, { recursive: true })
    const files = [
      join(dir, 'requirements.md'),
      join(dir, 'design.md'),
      join(dir, 'tasks.md'),
    ]
    const existingFiles = files.filter(existsSync)
    if (existingFiles.length > 0 && input.overwrite !== true) {
      return {
        data: {
          dir,
          files,
          created: false,
          overwritten: false,
          warnings: ['Spec files already exist. Pass overwrite=true to replace them.'],
        },
      }
    }
    const created = existingFiles.length === 0
    const requirements = input.requirements?.length
      ? input.requirements.map(item => `- ${item}`).join('\n')
      : '- [ ] Define user-visible acceptance criteria\n- [ ] Define edge cases and non-goals\n'
    const tasks = input.tasks?.length
      ? input.tasks.map(item => `- [ ] ${item}`).join('\n')
      : '- [ ] Locate affected code paths\n- [ ] Implement the smallest coherent change\n- [ ] Add or update focused verification\n- [ ] Run the agreed checks\n'

    writeFileSync(
      files[0],
      `${frontMatter(input.title)}# Requirements\n\n${input.summary ?? ''}\n\n## Acceptance Criteria\n\n${requirements}\n`,
      'utf8',
    )
    writeFileSync(
      files[1],
      `${frontMatter(input.title)}# Design\n\n## Context\n\n${input.summary ?? ''}\n\n## Approach\n\n- Describe the chosen implementation path.\n\n## Risks\n\n- Capture compatibility, migration, performance, and rollback notes.\n`,
      'utf8',
    )
    writeFileSync(files[2], `${frontMatter(input.title)}# Tasks\n\n${tasks}\n`, 'utf8')
    return { data: { dir, files, created, overwritten: !created, warnings: [] } }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      type: 'tool_result',
      tool_use_id: toolUseID,
      content: [
        `Directory: ${output.dir}`,
        'Files:',
        ...output.files.map(f => `- ${f}`),
        ...(output.warnings.length ? ['', 'Warnings:', ...output.warnings.map(w => `- ${w}`)] : []),
      ].join('\n'),
    }
  },
} satisfies ToolDef<InputSchema, Output>)
