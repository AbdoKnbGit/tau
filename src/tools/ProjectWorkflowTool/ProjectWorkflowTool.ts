import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'fs'
import { dirname, isAbsolute, join, resolve } from 'path'
import { createElement } from 'react'
import { z } from 'zod/v4'

import { buildTool, type ToolDef } from '../../Tool.js'
import { Text } from '../../ink.js'
import { getCwd } from '../../utils/cwd.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { PROJECT_WORKFLOW_TOOL_NAME } from './constants.js'

const DESCRIPTION =
  'Detect project manifests and likely build, test, lint, dev, start, and deploy commands. Read-only.'

const PROMPT = `Inspect project manifests and return repo-native workflow commands. This tool is read-only and never executes commands.

Use before running build, lint, test, dev-server, package, or deploy commands in an unfamiliar project. Prefer the returned project scripts over guessed shell commands.`

function renderText(message: string): React.ReactNode {
  return createElement(Text, null, message)
}

const inputSchema = lazySchema(() =>
  z.strictObject({
    path: z
      .string()
      .optional()
      .describe('Directory or file path to inspect. Defaults to the current working directory.'),
    maxDepth: z
      .number()
      .int()
      .min(0)
      .max(4)
      .optional()
      .describe('How many parent directories to inspect upward. Defaults to 2.'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const commandSchema = z.object({
  name: z.string(),
  command: z.string(),
  purpose: z.string(),
})

const manifestSchema = z.object({
  type: z.string(),
  path: z.string(),
  commands: z.array(commandSchema),
})

const outputSchema = lazySchema(() =>
  z.object({
    root: z.string(),
    manifests: z.array(manifestSchema),
    recommendations: z.array(z.string()),
    warnings: z.array(z.string()),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>
type Command = z.infer<typeof commandSchema>
type Manifest = z.infer<typeof manifestSchema>

function safeStat(path: string) {
  try {
    return statSync(path)
  } catch {
    return null
  }
}

function resolveStartPath(inputPath: string | undefined): string {
  const cwd = getCwd()
  const target = inputPath?.trim() ? inputPath.trim() : cwd
  const absolute = isAbsolute(target) ? target : resolve(cwd, target)
  const stat = safeStat(absolute)
  if (stat?.isFile()) return dirname(absolute)
  return absolute
}

function candidateDirs(start: string, maxDepth: number): string[] {
  const dirs: string[] = []
  let current = start
  for (let i = 0; i <= maxDepth; i++) {
    dirs.push(current)
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return dirs
}

function fileExists(path: string): boolean {
  return existsSync(path) && safeStat(path)?.isFile() === true
}

function hasDir(path: string): boolean {
  return existsSync(path) && safeStat(path)?.isDirectory() === true
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

function scriptPurpose(name: string): string {
  const lower = name.toLowerCase()
  if (lower.includes('test')) return 'test'
  if (lower.includes('lint')) return 'lint'
  if (lower.includes('build')) return 'build'
  if (lower.includes('dev')) return 'dev'
  if (lower === 'start' || lower.includes('serve')) return 'start'
  if (lower.includes('deploy') || lower.includes('preview')) return 'deploy'
  if (lower.includes('typecheck') || lower.includes('type-check')) return 'typecheck'
  return 'script'
}

function detectPackageManager(dir: string): string {
  if (fileExists(join(dir, 'bun.lockb')) || fileExists(join(dir, 'bun.lock'))) {
    return 'bun'
  }
  if (fileExists(join(dir, 'pnpm-lock.yaml'))) return 'pnpm'
  if (fileExists(join(dir, 'yarn.lock'))) return 'yarn'
  return 'npm'
}

function packageRun(manager: string, script: string): string {
  if (manager === 'npm') return `npm run ${script}`
  if (manager === 'yarn') return `yarn ${script}`
  if (manager === 'pnpm') return `pnpm ${script}`
  return `bun run ${script}`
}

function inspectPackageJson(dir: string): Manifest | null {
  const path = join(dir, 'package.json')
  if (!fileExists(path)) return null

  const json = readJson(path)
  const scripts =
    json && typeof json.scripts === 'object' && json.scripts !== null
      ? (json.scripts as Record<string, unknown>)
      : {}
  const manager = detectPackageManager(dir)
  const commands: Command[] = Object.entries(scripts)
    .filter(([, value]) => typeof value === 'string')
    .map(([name]) => ({
      name,
      command: packageRun(manager, name),
      purpose: scriptPurpose(name),
    }))

  return {
    type: 'package.json',
    path,
    commands,
  }
}

function inspectPython(dir: string): Manifest | null {
  const markers = ['pyproject.toml', 'pytest.ini', 'tox.ini', 'requirements.txt']
  const marker = markers.find(name => fileExists(join(dir, name)))
  if (!marker) return null

  const commands: Command[] = []
  if (hasDir(join(dir, 'tests')) || fileExists(join(dir, 'pytest.ini'))) {
    commands.push({
      name: 'pytest',
      command: 'python -m pytest',
      purpose: 'test',
    })
  }
  if (fileExists(join(dir, 'tox.ini'))) {
    commands.push({ name: 'tox', command: 'tox', purpose: 'test' })
  }

  return {
    type: 'python',
    path: join(dir, marker),
    commands,
  }
}

function inspectCargo(dir: string): Manifest | null {
  const path = join(dir, 'Cargo.toml')
  if (!fileExists(path)) return null
  return {
    type: 'cargo',
    path,
    commands: [
      { name: 'test', command: 'cargo test', purpose: 'test' },
      { name: 'build', command: 'cargo build', purpose: 'build' },
      { name: 'check', command: 'cargo check', purpose: 'typecheck' },
    ],
  }
}

function inspectGo(dir: string): Manifest | null {
  const path = join(dir, 'go.mod')
  if (!fileExists(path)) return null
  return {
    type: 'go',
    path,
    commands: [
      { name: 'test', command: 'go test ./...', purpose: 'test' },
      { name: 'build', command: 'go build ./...', purpose: 'build' },
    ],
  }
}

function inspectJvm(dir: string): Manifest | null {
  const pom = join(dir, 'pom.xml')
  if (fileExists(pom)) {
    return {
      type: 'maven',
      path: pom,
      commands: [
        { name: 'test', command: 'mvn test', purpose: 'test' },
        { name: 'package', command: 'mvn package', purpose: 'build' },
      ],
    }
  }

  const gradle = ['build.gradle', 'build.gradle.kts'].find(name =>
    fileExists(join(dir, name)),
  )
  if (!gradle) return null
  const wrapper = fileExists(join(dir, 'gradlew')) ? './gradlew' : 'gradle'
  return {
    type: 'gradle',
    path: join(dir, gradle),
    commands: [
      { name: 'test', command: `${wrapper} test`, purpose: 'test' },
      { name: 'build', command: `${wrapper} build`, purpose: 'build' },
    ],
  }
}

function inspectDir(dir: string): Manifest[] {
  return [
    inspectPackageJson(dir),
    inspectPython(dir),
    inspectCargo(dir),
    inspectGo(dir),
    inspectJvm(dir),
  ].filter((m): m is Manifest => m !== null)
}

function buildRecommendations(manifests: Manifest[]): string[] {
  const recommendations: string[] = []
  const allCommands = manifests.flatMap(manifest => manifest.commands)
  for (const purpose of ['test', 'lint', 'typecheck', 'build', 'dev', 'start', 'deploy']) {
    const command = allCommands.find(c => c.purpose === purpose)
    if (command) {
      recommendations.push(`${purpose}: ${command.command}`)
    }
  }
  return recommendations
}

function previewDir(path: string): string {
  try {
    return readdirSync(path).slice(0, 12).join(', ')
  } catch {
    return ''
  }
}

export const ProjectWorkflowTool = buildTool({
  name: PROJECT_WORKFLOW_TOOL_NAME,
  searchHint: 'detect project scripts commands',
  maxResultSizeChars: 100_000,
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
    return 'Detecting workflow'
  },
  isReadOnly() {
    return true
  },
  isConcurrencySafe() {
    return true
  },
  toAutoClassifierInput(input) {
    return input.path ?? ''
  },
  async validateInput(input) {
    if (input.path !== undefined && !input.path.trim()) {
      return {
        result: false,
        message: 'ProjectWorkflow path must be non-empty when provided.',
        errorCode: 1,
      }
    }
    return { result: true }
  },
  renderToolUseMessage(input) {
    return renderText(
      input.path
        ? `Detecting project workflow for ${input.path}`
        : 'Detecting project workflow',
    )
  },
  renderToolResultMessage(output) {
    if (output.manifests.length === 0) {
      return renderText('No project manifests found')
    }
    return renderText(
      `${output.manifests.length} manifest(s), ${output.recommendations.length} recommendation(s)`,
    )
  },
  async call(input) {
    const start = resolveStartPath(input.path)
    const maxDepth = input.maxDepth ?? 2
    const dirs = candidateDirs(start, maxDepth)
    const manifests = dirs.flatMap(inspectDir)
    const warnings: string[] = []

    if (!existsSync(start)) {
      warnings.push(`Path does not exist: ${start}`)
    } else if (manifests.length === 0) {
      const preview = previewDir(start)
      warnings.push(
        preview
          ? `No supported manifests found near ${start}. Directory entries: ${preview}`
          : `No supported manifests found near ${start}.`,
      )
    }

    return {
      data: {
        root: start,
        manifests,
        recommendations: buildRecommendations(manifests),
        warnings,
      },
    }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    const lines = [
      `Root: ${output.root}`,
      '',
      'Manifests:',
      ...(output.manifests.length > 0
        ? output.manifests.flatMap(manifest => [
            `- ${manifest.type}: ${manifest.path}`,
            ...manifest.commands.map(
              command =>
                `  - ${command.purpose}/${command.name}: ${command.command}`,
            ),
          ])
        : ['- none found']),
      '',
      'Recommendations:',
      ...(output.recommendations.length > 0
        ? output.recommendations.map(item => `- ${item}`)
        : ['- none']),
      ...(output.warnings.length > 0
        ? ['', 'Warnings:', ...output.warnings.map(item => `- ${item}`)]
        : []),
    ]
    return {
      type: 'tool_result',
      tool_use_id: toolUseID,
      content: lines.join('\n'),
    }
  },
} satisfies ToolDef<InputSchema, Output>)
