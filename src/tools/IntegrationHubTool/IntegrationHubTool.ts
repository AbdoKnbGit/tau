import { existsSync, readFileSync, readdirSync } from 'fs'
import { createElement } from 'react'
import { isAbsolute, join, resolve } from 'path'
import { z } from 'zod/v4'

import { buildTool, type ToolDef } from '../../Tool.js'
import { Text } from '../../ink.js'
import { getCwd } from '../../utils/cwd.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { INTEGRATION_HUB_TOOL_NAME } from './constants.js'

const DESCRIPTION =
  'Scan local full-stack integration signals: env requirements, database tooling, migrations, and service configs. Read-only.'

const PROMPT = `Inspect local project files for integration and database setup without revealing secret values or executing SQL.

Use before adding auth, database, storage, payments, email, or third-party APIs. Use check_secret to report whether a named environment variable exists without printing its value.`

const inputSchema = lazySchema(() =>
  z.strictObject({
    operation: z.enum(['scan', 'check_secret']).optional().describe('Operation. Defaults to scan.'),
    names: z.array(z.string()).optional().describe('Environment variable names for check_secret.'),
    root: z.string().optional().describe('Project root. Defaults to cwd.'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    root: z.string(),
    envFiles: z.array(z.string()),
    integrations: z.array(z.string()),
    migrations: z.array(z.string()),
    secretChecks: z.array(z.object({ name: z.string(), present: z.boolean() })),
    recommendations: z.array(z.string()),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

function renderText(message: string): React.ReactNode {
  return createElement(Text, null, message)
}

function safeList(path: string): string[] {
  try {
    return readdirSync(path)
  } catch {
    return []
  }
}

function fileIncludes(path: string, patterns: RegExp[]): boolean {
  try {
    const text = readFileSync(path, 'utf8')
    return patterns.some(p => p.test(text))
  } catch {
    return false
  }
}

function resolveRoot(root: string | undefined): string {
  if (!root?.trim()) return getCwd()
  return isAbsolute(root) ? root : resolve(getCwd(), root)
}

export const IntegrationHubTool = buildTool({
  name: INTEGRATION_HUB_TOOL_NAME,
  searchHint: 'scan integrations secrets database',
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
    return 'Scanning integrations'
  },
  isReadOnly() {
    return true
  },
  isConcurrencySafe() {
    return true
  },
  toAutoClassifierInput(input) {
    return `${input.operation ?? ''} ${(input.names ?? []).join(' ')}`.trim()
  },
  renderToolUseMessage() {
    return renderText('Scanning integrations')
  },
  renderToolResultMessage(output) {
    return renderText(`${output.integrations.length} integration signal(s), ${output.migrations.length} migration path(s)`)
  },
  async call(input) {
    const root = resolveRoot(input.root)
    const rootEntries = safeList(root)
    const envFiles = rootEntries.filter(name => /^\.env/.test(name)).map(name => join(root, name))
    const integrations: string[] = []
    const migrations: string[] = []
    const recommendations: string[] = []
    const pkg = join(root, 'package.json')

    if (existsSync(join(root, 'prisma', 'schema.prisma'))) {
      integrations.push('prisma')
      migrations.push(join(root, 'prisma', 'migrations'))
    }
    if (existsSync(join(root, 'drizzle.config.ts')) || existsSync(join(root, 'drizzle.config.js'))) {
      integrations.push('drizzle')
      migrations.push(join(root, 'drizzle'))
    }
    if (existsSync(join(root, 'supabase'))) {
      integrations.push('supabase')
      migrations.push(join(root, 'supabase', 'migrations'))
    }
    if (existsSync(pkg)) {
      if (fileIncludes(pkg, [/stripe/i])) integrations.push('stripe')
      if (fileIncludes(pkg, [/next-auth|auth\.js/i])) integrations.push('auth')
      if (fileIncludes(pkg, [/resend|sendgrid|nodemailer/i])) integrations.push('email')
      if (fileIncludes(pkg, [/firebase/i])) integrations.push('firebase')
    }
    if (integrations.length === 0) recommendations.push('No integration framework detected; inspect requirements before choosing a provider.')
    if (envFiles.length === 0) recommendations.push('No .env file detected. Ask the user before creating or requesting secrets.')
    if (migrations.length === 0) recommendations.push('No migration directory detected. Create migrations through the project DB toolchain, not ad hoc SQL files.')

    const secretChecks = (input.names ?? []).map(name => ({
      name,
      present: process.env[name] !== undefined && process.env[name] !== '',
    }))

    return { data: { root, envFiles, integrations: [...new Set(integrations)], migrations, secretChecks, recommendations } }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    const lines = [
      `Root: ${output.root}`,
      `Env files: ${output.envFiles.length ? output.envFiles.join(', ') : 'none'}`,
      `Integrations: ${output.integrations.length ? output.integrations.join(', ') : 'none'}`,
      'Migrations:',
      ...(output.migrations.length ? output.migrations.map(m => `- ${m}`) : ['- none']),
      ...(output.secretChecks.length ? ['', 'Secret checks:', ...output.secretChecks.map(s => `- ${s.name}: ${s.present ? 'present' : 'missing'}`)] : []),
      ...(output.recommendations.length ? ['', 'Recommendations:', ...output.recommendations.map(r => `- ${r}`)] : []),
    ]
    return { type: 'tool_result', tool_use_id: toolUseID, content: lines.join('\n') }
  },
} satisfies ToolDef<InputSchema, Output>)
