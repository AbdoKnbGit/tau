import { existsSync, readFileSync } from 'fs'
import { createElement } from 'react'
import { dirname, isAbsolute, join, resolve } from 'path'
import { z } from 'zod/v4'

import { buildTool, type ToolDef } from '../../Tool.js'
import { Text } from '../../ink.js'
import { getCwd } from '../../utils/cwd.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { PACKAGE_MANAGER_TOOL_NAME } from './constants.js'

const DESCRIPTION =
  'Detect package manager and produce safe dependency/script commands. Read-only.'

const PROMPT = `Detect the package manager from lockfiles and manifests, then return safe commands for install, add, remove, test, build, lint, or dev. This tool is read-only and does not modify manifests or install packages.

Use before changing dependencies or running package scripts in unfamiliar projects.`

const inputSchema = lazySchema(() =>
  z.strictObject({
    path: z.string().optional().describe('Project directory or file. Defaults to cwd.'),
    action: z
      .enum(['detect', 'install', 'add', 'remove', 'test', 'build', 'lint', 'dev'])
      .optional()
      .describe('Command family to recommend. Defaults to detect.'),
    packages: z.array(z.string()).optional().describe('Packages for add/remove actions.'),
    dev: z.boolean().optional().describe('For add action, recommend dev dependency flag.'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    root: z.string(),
    manager: z.string(),
    manifest: z.string().optional(),
    scripts: z.array(z.string()),
    commands: z.array(z.string()),
    warnings: z.array(z.string()),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

function renderText(message: string): React.ReactNode {
  return createElement(Text, null, message)
}

function rootFor(path: string | undefined): string {
  const cwd = getCwd()
  const target = path?.trim() ? path.trim() : cwd
  const absolute = isAbsolute(target) ? target : resolve(cwd, target)
  return /\.[a-z0-9]+$/i.test(absolute) ? dirname(absolute) : absolute
}

function detectManager(root: string): string {
  if (existsSync(join(root, 'bun.lock')) || existsSync(join(root, 'bun.lockb'))) return 'bun'
  if (existsSync(join(root, 'pnpm-lock.yaml'))) return 'pnpm'
  if (existsSync(join(root, 'yarn.lock'))) return 'yarn'
  if (existsSync(join(root, 'package-lock.json'))) return 'npm'
  return 'npm'
}

function readScripts(root: string): string[] {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts?: Record<string, unknown> }
    return Object.keys(pkg.scripts ?? {})
  } catch {
    return []
  }
}

function run(manager: string, script: string): string {
  if (manager === 'npm') return `npm run ${script}`
  if (manager === 'yarn') return `yarn ${script}`
  if (manager === 'pnpm') return `pnpm ${script}`
  return `bun run ${script}`
}

export const PackageManagerTool = buildTool({
  name: PACKAGE_MANAGER_TOOL_NAME,
  searchHint: 'package manager dependency commands',
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
    return 'Checking package manager'
  },
  isReadOnly() {
    return true
  },
  isConcurrencySafe() {
    return true
  },
  toAutoClassifierInput(input) {
    return `${input.action ?? ''} ${(input.packages ?? []).join(' ')} ${input.path ?? ''}`.trim()
  },
  renderToolUseMessage(input) {
    return renderText(`Checking package manager${input.path ? ` for ${input.path}` : ''}`)
  },
  renderToolResultMessage(output) {
    return renderText(`${output.manager}: ${output.commands.length} command(s)`)
  },
  async call(input) {
    const root = rootFor(input.path)
    const manager = detectManager(root)
    const scripts = readScripts(root)
    const action = input.action ?? 'detect'
    const packages = input.packages ?? []
    const commands: string[] = []
    const warnings: string[] = []
    if (!existsSync(join(root, 'package.json'))) warnings.push('No package.json found at the detected root.')

    if (action === 'install') commands.push(manager === 'npm' ? 'npm install' : `${manager} install`)
    if (action === 'add') {
      if (packages.length) {
        const dev = input.dev ? (manager === 'npm' ? ' --save-dev' : ' -D') : ''
        commands.push(manager === 'npm' ? `npm install${dev} ${packages.join(' ')}` : `${manager} add${dev} ${packages.join(' ')}`)
      } else warnings.push('No packages provided for add action.')
    }
    if (action === 'remove') {
      if (packages.length) commands.push(manager === 'npm' ? `npm uninstall ${packages.join(' ')}` : `${manager} remove ${packages.join(' ')}`)
      else warnings.push('No packages provided for remove action.')
    }
    for (const script of ['test', 'build', 'lint', 'dev']) {
      if (action === script) {
        if (scripts.includes(script)) commands.push(run(manager, script))
        else warnings.push(`No "${script}" script found.`)
      }
    }
    if (action === 'detect') {
      for (const script of ['test', 'build', 'lint', 'dev']) {
        if (scripts.includes(script)) commands.push(`${script}: ${run(manager, script)}`)
      }
    }
    return {
      data: {
        root,
        manager,
        ...(existsSync(join(root, 'package.json')) ? { manifest: join(root, 'package.json') } : {}),
        scripts,
        commands,
        warnings,
      },
    }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    const lines = [
      `Root: ${output.root}`,
      `Manager: ${output.manager}`,
      ...(output.manifest ? [`Manifest: ${output.manifest}`] : []),
      `Scripts: ${output.scripts.length ? output.scripts.join(', ') : 'none'}`,
      '',
      'Commands:',
      ...(output.commands.length ? output.commands.map(c => `- ${c}`) : ['- none']),
      ...(output.warnings.length ? ['', 'Warnings:', ...output.warnings.map(w => `- ${w}`)] : []),
    ]
    return { type: 'tool_result', tool_use_id: toolUseID, content: lines.join('\n') }
  },
} satisfies ToolDef<InputSchema, Output>)
