import { existsSync, readFileSync } from 'fs'
import { createElement } from 'react'
import { isAbsolute, join, resolve } from 'path'
import { z } from 'zod/v4'

import { buildTool, type ToolDef } from '../../Tool.js'
import { Text } from '../../ink.js'
import { getCwd } from '../../utils/cwd.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { DEPLOY_PREVIEW_TOOL_NAME } from './constants.js'

const DESCRIPTION =
  'Detect deploy and preview configuration, scripts, and likely local ports. Read-only.'

const PROMPT = `Inspect deploy/preview readiness without publishing anything. This tool never exposes ports or deploys code.

Use before deploy, expose, preview URL, hosting config, or "ship it" requests. Ask before running any command that publishes, pushes, or exposes local services.`

const inputSchema = lazySchema(() =>
  z.strictObject({
    root: z.string().optional().describe('Project root. Defaults to cwd.'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    root: z.string(),
    configs: z.array(z.string()),
    scripts: z.array(z.string()),
    ports: z.array(z.number()),
    recommendations: z.array(z.string()),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

function renderText(message: string): React.ReactNode {
  return createElement(Text, null, message)
}

function readPackageScripts(root: string): Record<string, string> {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts?: Record<string, string> }
    return pkg.scripts ?? {}
  } catch {
    return {}
  }
}

function resolveRoot(root: string | undefined): string {
  if (!root?.trim()) return getCwd()
  return isAbsolute(root) ? root : resolve(getCwd(), root)
}

export const DeployPreviewTool = buildTool({
  name: DEPLOY_PREVIEW_TOOL_NAME,
  searchHint: 'deploy expose preview config',
  maxResultSizeChars: 60_000,
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
    return 'Checking deploy preview'
  },
  isReadOnly() {
    return true
  },
  isConcurrencySafe() {
    return true
  },
  renderToolUseMessage() {
    return renderText('Checking deploy preview')
  },
  renderToolResultMessage(output) {
    return renderText(`${output.configs.length} deploy config(s), ${output.scripts.length} script(s)`)
  },
  async call(input) {
    const root = resolveRoot(input.root)
    const configs = [
      'vercel.json',
      'netlify.toml',
      'wrangler.toml',
      'fly.toml',
      'railway.json',
      'Dockerfile',
      'docker-compose.yml',
      '.github/workflows',
    ].filter(name => existsSync(join(root, name))).map(name => join(root, name))
    const scriptsObj = readPackageScripts(root)
    const scripts = Object.entries(scriptsObj)
      .filter(([name, cmd]) => /(deploy|preview|start|dev|serve|build)/i.test(`${name} ${cmd}`))
      .map(([name, cmd]) => `${name}: ${cmd}`)
    const ports = [...new Set(Object.values(scriptsObj).flatMap(cmd => [...cmd.matchAll(/(?:--port|PORT=|localhost:|:)(\d{3,5})/g)].map(m => Number(m[1]))).filter(n => n > 0))]
    const recommendations = [
      configs.length ? 'Use the detected hosting config before adding a new deploy path.' : 'No hosting config detected; ask target platform before creating one.',
      scripts.some(s => /^build:/.test(s)) ? 'Run the build script before deploy.' : 'No build script detected.',
      'Ask before exposing a port or publishing a deployment.',
    ]
    return { data: { root, configs, scripts, ports, recommendations } }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    const lines = [
      `Root: ${output.root}`,
      'Configs:',
      ...(output.configs.length ? output.configs.map(c => `- ${c}`) : ['- none']),
      'Scripts:',
      ...(output.scripts.length ? output.scripts.map(s => `- ${s}`) : ['- none']),
      `Ports: ${output.ports.length ? output.ports.join(', ') : 'none detected'}`,
      'Recommendations:',
      ...output.recommendations.map(r => `- ${r}`),
    ]
    return { type: 'tool_result', tool_use_id: toolUseID, content: lines.join('\n') }
  },
} satisfies ToolDef<InputSchema, Output>)
