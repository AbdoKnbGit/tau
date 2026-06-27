import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { createElement } from 'react'
import { isAbsolute, join, resolve } from 'path'
import { z } from 'zod/v4'

import { buildTool, type ToolDef } from '../../Tool.js'
import { Text } from '../../ink.js'
import { getCwd } from '../../utils/cwd.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { MERMAID_RENDER_TOOL_NAME } from './constants.js'

const DESCRIPTION =
  'Write a Mermaid diagram and standalone HTML preview artifact.'

const PROMPT = `Create a Mermaid .mmd file and a standalone HTML preview that renders it with Mermaid in the browser. This writes files under .tau/mermaid by default.

Use when a diagram should be reviewable visually in a browser or attached to a spec/report.`

const inputSchema = lazySchema(() =>
  z.strictObject({
    diagram: z.string().min(1).describe('Mermaid diagram source.'),
    title: z.string().optional().describe('Diagram title used for filenames and HTML title.'),
    outputDir: z.string().optional().describe('Output directory. Defaults to .tau/mermaid.'),
    overwrite: z.boolean().optional().describe('Overwrite an existing diagram with the same title. Defaults to false.'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    sourcePath: z.string(),
    htmlPath: z.string(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

function renderText(message: string): React.ReactNode {
  return createElement(Text, null, message)
}

function slugify(value: string): string {
  return (value || 'diagram')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'diagram'
}

function htmlEscape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function resolveDir(outputDir: string | undefined): string {
  if (!outputDir?.trim()) return join(getCwd(), '.tau', 'mermaid')
  return isAbsolute(outputDir) ? outputDir : resolve(getCwd(), outputDir)
}

function uniqueSlug(dir: string, baseSlug: string): string {
  let slug = baseSlug
  let index = 2
  while (existsSync(join(dir, `${slug}.mmd`)) || existsSync(join(dir, `${slug}.html`))) {
    slug = `${baseSlug}-${index}`
    index += 1
  }
  return slug
}

export const MermaidRenderTool = buildTool({
  name: MERMAID_RENDER_TOOL_NAME,
  searchHint: 'render mermaid diagram html',
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
    return 'Rendering Mermaid'
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
    return `${input.title ?? ''} ${input.outputDir ?? ''}`.trim()
  },
  renderToolUseMessage(input) {
    return renderText(`Rendering Mermaid ${input.title ?? 'diagram'}`)
  },
  renderToolResultMessage(output) {
    return renderText(`Wrote ${output.htmlPath}`)
  },
  async call(input) {
    const dir = resolveDir(input.outputDir)
    mkdirSync(dir, { recursive: true })
    const baseSlug = slugify(input.title ?? 'diagram')
    const slug = input.overwrite === true ? baseSlug : uniqueSlug(dir, baseSlug)
    const sourcePath = join(dir, `${slug}.mmd`)
    const htmlPath = join(dir, `${slug}.html`)
    writeFileSync(sourcePath, input.diagram, 'utf8')
    writeFileSync(
      htmlPath,
      `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>${htmlEscape(input.title ?? 'Mermaid diagram')}</title>
  <script type="module">
    import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';
    mermaid.initialize({ startOnLoad: true, securityLevel: 'strict' });
  </script>
  <style>body{font-family:system-ui,sans-serif;margin:32px;background:#fafafa;color:#111}.mermaid{background:white;border:1px solid #ddd;padding:24px;overflow:auto}</style>
</head>
<body>
  <h1>${htmlEscape(input.title ?? 'Mermaid diagram')}</h1>
  <pre class="mermaid">${htmlEscape(input.diagram)}</pre>
</body>
</html>
`,
      'utf8',
    )
    return { data: { sourcePath, htmlPath } }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return { type: 'tool_result', tool_use_id: toolUseID, content: `Mermaid source: ${output.sourcePath}\nHTML preview: ${output.htmlPath}` }
  },
} satisfies ToolDef<InputSchema, Output>)
