import { createElement } from 'react'
import { z } from 'zod/v4'

import { buildTool, type ToolDef } from '../../Tool.js'
import { Text } from '../../ink.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { INSPECT_SITE_TOOL_NAME } from './constants.js'

const DESCRIPTION =
  'Inspect a web page over HTTP: title, headings, forms, same-origin assets, and text search. Read-only.'

const PROMPT = `Inspect a local or public web page without a full browser engine. This is read-only.

Use for quick app verification after starting a dev server: page reachable, expected text present, forms detectable, and referenced same-origin scripts/styles/images returning successful HTTP status. For console errors, screenshots, clicks, or authenticated browser state, use browser MCP/WebBrowser/Chrome tools if available.`

const inputSchema = lazySchema(() =>
  z.strictObject({
    url: z.string().url().describe('Page URL to inspect, for example http://localhost:3000.'),
    findText: z.string().optional().describe('Optional text to search for in the page HTML.'),
    checkAssets: z.boolean().optional().describe('Check same-origin scripts, stylesheets, and images. Defaults to true.'),
    maxAssets: z.number().int().min(0).max(50).optional().describe('Maximum assets to check. Defaults to 20.'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const assetSchema = z.object({
  url: z.string(),
  status: z.number(),
  ok: z.boolean(),
})

const outputSchema = lazySchema(() =>
  z.object({
    url: z.string(),
    status: z.number(),
    ok: z.boolean(),
    title: z.string().optional(),
    headings: z.array(z.string()),
    forms: z.number(),
    findTextFound: z.boolean().optional(),
    assets: z.array(assetSchema),
    warnings: z.array(z.string()),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

function renderText(message: string): React.ReactNode {
  return createElement(Text, null, message)
}

function stripTags(text: string): string {
  return text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}

function firstMatch(html: string, pattern: RegExp): string | undefined {
  const match = html.match(pattern)
  return match?.[1] ? stripTags(match[1]) : undefined
}

function allMatches(html: string, pattern: RegExp): string[] {
  return [...html.matchAll(pattern)]
    .map(match => stripTags(match[1] ?? ''))
    .filter(Boolean)
    .slice(0, 12)
}

function collectAssetUrls(base: URL, html: string, maxAssets: number): string[] {
  const attrs = [
    ...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi),
    ...html.matchAll(/<link[^>]+href=["']([^"']+)["'][^>]*rel=["'][^"']*stylesheet[^"']*["']/gi),
    ...html.matchAll(/<img[^>]+src=["']([^"']+)["']/gi),
  ]
  const urls: string[] = []
  for (const match of attrs) {
    const raw = match[1]
    if (!raw || raw.startsWith('data:') || raw.startsWith('blob:')) continue
    try {
      const u = new URL(raw, base)
      if (u.origin === base.origin && !urls.includes(u.toString())) urls.push(u.toString())
    } catch {
      // ignore malformed asset refs
    }
    if (urls.length >= maxAssets) break
  }
  return urls
}

export const InspectSiteTool = buildTool({
  name: INSPECT_SITE_TOOL_NAME,
  searchHint: 'inspect local web app page',
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
    return 'Inspecting site'
  },
  isReadOnly() {
    return true
  },
  isConcurrencySafe() {
    return true
  },
  toAutoClassifierInput(input) {
    return `${input.url} ${input.findText ?? ''}`.trim()
  },
  renderToolUseMessage(input) {
    return renderText(`Inspecting ${input.url ?? 'site'}`)
  },
  renderToolResultMessage(output) {
    return renderText(`${output.status} ${output.title ?? output.url}`)
  },
  async call(input, ctx) {
    const warnings: string[] = []
    const response = await fetch(input.url, { signal: ctx.abortController.signal })
    const html = await response.text()
    const base = new URL(input.url)
    const title = firstMatch(html, /<title[^>]*>([\s\S]*?)<\/title>/i)
    const headings = allMatches(html, /<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi)
    const forms = [...html.matchAll(/<form\b/gi)].length
    const findTextFound = input.findText ? html.toLowerCase().includes(input.findText.toLowerCase()) : undefined
    const assetUrls = input.checkAssets === false ? [] : collectAssetUrls(base, html, input.maxAssets ?? 20)
    const assets = []
    for (const url of assetUrls) {
      try {
        const r = await fetch(url, { method: 'HEAD', signal: ctx.abortController.signal })
        assets.push({ url, status: r.status, ok: r.ok })
      } catch (e) {
        warnings.push(`Asset check failed for ${url}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    return {
      data: {
        url: input.url,
        status: response.status,
        ok: response.ok,
        ...(title ? { title } : {}),
        headings,
        forms,
        ...(findTextFound !== undefined ? { findTextFound } : {}),
        assets,
        warnings,
      },
    }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    const lines = [
      `URL: ${output.url}`,
      `Status: ${output.status} ${output.ok ? 'OK' : 'FAILED'}`,
      ...(output.title ? [`Title: ${output.title}`] : []),
      ...(output.findTextFound !== undefined ? [`Find text: ${output.findTextFound ? 'found' : 'not found'}`] : []),
      `Forms: ${output.forms}`,
      '',
      'Headings:',
      ...(output.headings.length ? output.headings.map(h => `- ${h}`) : ['- none']),
      '',
      'Assets:',
      ...(output.assets.length ? output.assets.map(a => `- ${a.status} ${a.ok ? 'OK' : 'FAILED'} ${a.url}`) : ['- not checked or none found']),
      ...(output.warnings.length ? ['', 'Warnings:', ...output.warnings.map(w => `- ${w}`)] : []),
    ]
    return { type: 'tool_result', tool_use_id: toolUseID, content: lines.join('\n'), is_error: output.ok ? undefined : true }
  },
} satisfies ToolDef<InputSchema, Output>)
