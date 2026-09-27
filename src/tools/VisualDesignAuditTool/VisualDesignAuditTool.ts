import { existsSync, readFileSync, statSync } from 'fs'
import { createElement } from 'react'
import { extname, isAbsolute, resolve } from 'path'
import { z } from 'zod/v4'

import { buildTool, type ToolDef } from '../../Tool.js'
import { Text } from '../../ink.js'
import { getCwd } from '../../utils/cwd.js'
import { formatIgnoredNote, glob } from '../../utils/glob.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { semanticBoolean } from '../../utils/semanticBoolean.js'
import { VISUAL_DESIGN_AUDIT_TOOL_NAME } from './constants.js'

const DESCRIPTION =
  'Audit frontend files for design-system, responsiveness, assets, and visual verification signals. Read-only.'

const PROMPT = `Scan frontend source for visual design risks and verification suggestions. This is read-only.

Use for UI/frontend tasks before finishing: find styling files, detect one-note palettes, missing responsive hints, asset usage, and whether browser/screenshot verification should be run.`

const inputSchema = lazySchema(() =>
  z.strictObject({
    root: z.string().optional().describe('Directory to scan. Defaults to cwd.'),
    maxFiles: z.number().int().min(1).max(500).optional().describe('Max frontend files to scan. Defaults to 120.'),
    include_ignored: semanticBoolean(z.boolean().optional()).describe(
      'Also scan files excluded by .gitignore/.ignore rules. Defaults to false.',
    ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    root: z.string(),
    scannedFiles: z.number(),
    foundFiles: z.number().optional(),
    ignored: z
      .object({
        count: z.number().nullable(),
        places: z.array(z.object({ path: z.string(), count: z.number() })),
        morePlaces: z.number(),
      })
      .optional(),
    styleFiles: z.array(z.string()),
    assetSignals: z.array(z.string()),
    findings: z.array(z.string()),
    verification: z.array(z.string()),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

function renderText(message: string): React.ReactNode {
  return createElement(Text, null, message)
}

// Found with the same ignore-aware listing as Glob, so dependency and build
// folders drop out wherever the project's ignore files say they should.
const FRONTEND_FILES = '*.{tsx,jsx,vue,svelte,css,scss,html}'

function pickScannable(files: string[], maxFiles: number): string[] {
  const picked: string[] = []
  for (const path of files) {
    if (picked.length >= maxFiles) break
    try {
      if (statSync(path).size <= 180_000) picked.push(path)
    } catch {
      // ignore
    }
  }
  return picked
}

function resolveRoot(root: string | undefined): string {
  if (!root?.trim()) return getCwd()
  return isAbsolute(root) ? root : resolve(getCwd(), root)
}

export const VisualDesignAuditTool = buildTool({
  name: VISUAL_DESIGN_AUDIT_TOOL_NAME,
  searchHint: 'frontend visual design audit',
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
    return 'Auditing design'
  },
  isReadOnly() {
    return true
  },
  isConcurrencySafe() {
    return true
  },
  renderToolUseMessage() {
    return renderText('Auditing visual design')
  },
  renderToolResultMessage(output) {
    return renderText(`${output.findings.length} finding(s), ${output.scannedFiles} file(s)`)
  },
  async call(input, { abortController, getAppState }) {
    const root = resolveRoot(input.root)
    const listing = existsSync(root)
      ? await glob(
          FRONTEND_FILES,
          root,
          { limit: Number.MAX_SAFE_INTEGER, offset: 0 },
          abortController.signal,
          getAppState().toolPermissionContext,
          { includeIgnored: input.include_ignored === true },
        )
      : undefined
    const found = listing?.files ?? []
    const files = pickScannable(found, input.maxFiles ?? 120)
    const styleFiles = files.filter(f => ['.css', '.scss'].includes(extname(f).toLowerCase()))
    const findings: string[] = []
    const assetSignals: string[] = []
    let hasResponsive = false
    let hasHardcodedColors = 0
    let hasImages = false
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      if (/@media|\bsm:|\bmd:|\blg:|clamp\(|minmax\(/.test(text)) hasResponsive = true
      const colors = text.match(/#[0-9a-f]{3,8}\b|rgb\(|hsl\(/gi)
      hasHardcodedColors += colors?.length ?? 0
      if (/<img\b|background-image|url\(|next\/image|Image\s+from/.test(text)) {
        hasImages = true
        assetSignals.push(file)
      }
    }
    if (!hasResponsive) findings.push('No obvious responsive styling signals found in scanned files.')
    if (hasHardcodedColors > 20) findings.push(`Many hardcoded color values detected (${hasHardcodedColors}); check for design-token drift or one-note palette.`)
    if (!hasImages) findings.push('No obvious image/asset usage detected; visual tasks may need stronger real assets.')
    if (styleFiles.length === 0) findings.push('No standalone CSS/SCSS files found; styling may be inline or framework-based.')
    const verification = [
      'Run a browser/app check for desktop and mobile viewport behavior when a dev server is available.',
      'Check text fit, overlap, loading/error states, focus/hover states, and console/runtime errors.',
    ]
    return {
      data: {
        root,
        scannedFiles: files.length,
        foundFiles: found.length,
        ...(listing?.ignored && { ignored: listing.ignored }),
        styleFiles,
        assetSignals: [...new Set(assetSignals)].slice(0, 20),
        findings,
        verification,
      },
    }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    const ignoredNote = formatIgnoredNote(output.ignored, ['frontend file', 'frontend files'])
    const lines = [
      `Root: ${output.root}`,
      `Scanned files: ${output.scannedFiles}${
        output.foundFiles !== undefined && output.foundFiles > output.scannedFiles
          ? ` of ${output.foundFiles} found`
          : ''
      }`,
      ...(ignoredNote ? [ignoredNote] : []),
      'Style files:',
      ...(output.styleFiles.length ? output.styleFiles.slice(0, 20).map(f => `- ${f}`) : ['- none']),
      'Asset signals:',
      ...(output.assetSignals.length ? output.assetSignals.map(f => `- ${f}`) : ['- none']),
      'Findings:',
      ...(output.findings.length ? output.findings.map(f => `- ${f}`) : ['- none']),
      'Verification:',
      ...output.verification.map(v => `- ${v}`),
    ]
    return { type: 'tool_result', tool_use_id: toolUseID, content: lines.join('\n') }
  },
} satisfies ToolDef<InputSchema, Output>)
