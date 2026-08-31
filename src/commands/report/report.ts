import PDFDocument from 'pdfkit'
import { createWriteStream } from 'fs'
import { mkdir, writeFile } from 'fs/promises'
import { dirname, extname, isAbsolute, resolve } from 'path'
import type { LocalCommandCall } from '../../types/command.js'
import type { Message } from '../../types/message.js'
import { getCwd } from '../../utils/cwd.js'
import {
  createUserMessage,
  extractTextContent,
  getMessagesAfterCompactBoundary,
} from '../../utils/messages.js'
import {
  getLastCacheSafeParams,
  runForkedAgent,
} from '../../utils/forkedAgent.js'
import { buildSideQuestionFallbackParams } from '../../utils/queryContext.js'
import {
  assertValidGeneratedReport,
  buildReportPrompt,
  extractReportTitle,
  renderHtml,
} from './presentation.js'

type ReportFormat = 'markdown' | 'html' | 'pdf'

type ReportSkill = {
  extension: string
  instruction: string
}

const REPORT_SKILLS: Record<ReportFormat, ReportSkill> = {
  markdown: {
    extension: '.md',
    instruction:
      'Write clean Markdown with short sections, direct headings, and no decorative formatting.',
  },
  html: {
    extension: '.html',
    instruction:
      'Write source Markdown that converts well to HTML: clear hierarchy, compact paragraphs, and no tables unless essential.',
  },
  pdf: {
    extension: '.pdf',
    instruction:
      'Write source Markdown that reads well in paged PDF form: short paragraphs, concise lists, and stable heading structure.',
  },
}

const FORMAT_ALIASES: Record<string, ReportFormat> = {
  md: 'markdown',
  markdown: 'markdown',
  html: 'html',
  pdf: 'pdf',
}

export const call: LocalCommandCall = async (args, context) => {
  const parsed = parseReportArgs(args)
  if (parsed.kind === 'help') {
    return { type: 'text', value: usageText() }
  }

  const skill = REPORT_SKILLS[parsed.format]
  if (!hasReportableSessionContent(context.messages ?? [])) {
    return {
      type: 'text',
      value: 'No session content found to report on.',
    }
  }

  const markdown = await generateReportMarkdown({
    format: parsed.format,
    skill,
    context,
  })

  const outputPath = resolveOutputPath(parsed.filename, parsed.format)
  await mkdir(dirname(outputPath), { recursive: true })

  if (parsed.format === 'markdown') {
    await writeFile(outputPath, ensureTrailingNewline(markdown), {
      encoding: 'utf-8',
      mode: 0o600,
    })
  } else if (parsed.format === 'html') {
    await writeFile(outputPath, renderHtml(markdown), {
      encoding: 'utf-8',
      mode: 0o600,
    })
  } else {
    await writePdf(markdown, outputPath)
  }

  return {
    type: 'text',
    value: [
      `Report ready: ${outputPath}`,
      `Format: ${parsed.format}`,
    ].join('\n'),
  }
}

function parseReportArgs(
  args: string,
): { kind: 'run'; format: ReportFormat; filename?: string } | { kind: 'help' } {
  const tokens = tokenizeArgs(args)
  const first = tokens[0]?.toLowerCase()

  if (!first || first === 'help' || first === '--help' || first === '-h') {
    return first ? { kind: 'help' } : { kind: 'run', format: 'markdown' }
  }

  const explicitFormat = FORMAT_ALIASES[first]
  if (explicitFormat) {
    return {
      kind: 'run',
      format: explicitFormat,
      filename: tokens.slice(1).join(' ') || undefined,
    }
  }

  const inferredFormat = formatFromPath(first)
  if (inferredFormat) {
    return {
      kind: 'run',
      format: inferredFormat,
      filename: tokens.join(' '),
    }
  }

  return { kind: 'help' }
}

function tokenizeArgs(args: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null

  for (let i = 0; i < args.length; i++) {
    const char = args[i]!
    if (quote) {
      if (char === quote) {
        quote = null
      } else {
        current += char
      }
      continue
    }

    if (char === '"' || char === "'") {
      quote = char
      continue
    }

    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current)
        current = ''
      }
      continue
    }

    current += char
  }

  if (current) {
    tokens.push(current)
  }

  return tokens
}

function usageText(): string {
  return [
    'Usage: /report <markdown|html|pdf> [filename]',
    '',
    'Examples:',
    '/report markdown',
    '/report html session-report.html',
    '/report pdf final-report.pdf',
    '',
    'This is a final-session content report. It does not include usage, token, tool-call, or statistics sections.',
  ].join('\n')
}

function formatFromPath(path: string): ReportFormat | null {
  switch (extname(path).toLowerCase()) {
    case '.md':
    case '.markdown':
      return 'markdown'
    case '.html':
    case '.htm':
      return 'html'
    case '.pdf':
      return 'pdf'
    default:
      return null
  }
}

function resolveOutputPath(
  filename: string | undefined,
  format: ReportFormat,
): string {
  const skill = REPORT_SKILLS[format]
  const rawFilename =
    filename?.trim() ||
    `session-report-${formatTimestamp(new Date())}${skill.extension}`
  const withExtension = normalizeExtension(rawFilename, skill.extension)
  return isAbsolute(withExtension) ? withExtension : resolve(getCwd(), withExtension)
}

function normalizeExtension(filename: string, extension: string): string {
  const current = extname(filename)
  if (!current) return `${filename}${extension}`
  return filename.slice(0, -current.length) + extension
}

function formatTimestamp(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  const seconds = String(date.getSeconds()).padStart(2, '0')
  return `${year}-${month}-${day}-${hours}${minutes}${seconds}`
}

function hasReportableSessionContent(messages: Message[]): boolean {
  const visibleMessages = getMessagesAfterCompactBoundary(messages)

  for (const message of visibleMessages) {
    if (message.type === 'user') {
      const text = userMessageText(message)
      if (text) return true
      continue
    }

    if (message.type === 'assistant') {
      const text = extractTextContent(message.message.content, '\n').trim()
      if (text && text !== '[No content]') {
        return true
      }
    }
  }

  return false
}

function userMessageText(message: Extract<Message, { type: 'user' }>): string {
  const userMessage = message as typeof message & {
    isMeta?: boolean
    isVirtual?: boolean
    toolUseResult?: unknown
  }
  if (
    userMessage.isMeta ||
    userMessage.isVirtual ||
    userMessage.toolUseResult !== undefined
  ) {
    return ''
  }

  const content = message.message.content
  const text =
    typeof content === 'string'
      ? content
      : content
          .filter(
            (block): block is Extract<typeof block, { type: 'text' }> =>
              block.type === 'text',
          )
          .map(block => block.text)
          .join('\n')

  const trimmed = text.trim()
  if (
    !trimmed ||
    trimmed.startsWith('<local-command-') ||
    trimmed.startsWith('<command-')
  ) {
    return ''
  }
  return trimmed
}

async function generateReportMarkdown({
  format,
  skill,
  context,
}: {
  format: ReportFormat
  skill: ReportSkill
  context: Parameters<LocalCommandCall>[1]
}): Promise<string> {
  // Reuse the exact live-conversation prefix instead of serializing the
  // transcript into a separate cold request. This keeps the current provider,
  // model, Antigravity OAuth identity, root provider session, system prompt,
  // tools schema, thinking configuration, and prompt-cache prefix intact.
  const savedCacheSafeParams = getLastCacheSafeParams()
  const cacheSafeParams =
    savedCacheSafeParams?.toolUseContext.options.mainLoopModel ===
    context.options.mainLoopModel
      ? savedCacheSafeParams
      : await buildSideQuestionFallbackParams({
          tools: context.options.tools,
          commands: context.options.commands,
          mcpClients: context.options.mcpClients,
          messages: context.messages,
          readFileState: context.readFileState,
          getAppState: context.getAppState,
          setAppState: context.setAppState,
          customSystemPrompt: context.options.customSystemPrompt,
          appendSystemPrompt: context.options.appendSystemPrompt,
          thinkingConfig: context.options.thinkingConfig,
          agents: context.options.agentDefinitions.activeAgents,
        })

  const result = await runForkedAgent({
    promptMessages: [
      createUserMessage({ content: buildReportPrompt({ format, skill }) }),
    ],
    cacheSafeParams,
    canUseTool: async () => ({
      behavior: 'deny' as const,
      message: 'Report generation does not run tools.',
      decisionReason: {
        type: 'other' as const,
        reason: 'report generation is read-only',
      },
    }),
    querySource: 'report',
    forkLabel: 'report',
    maxTurns: 1,
    skipTranscript: true,
    skipCacheWrite: true,
    overrides: {
      abortController: context.abortController,
      // This is a side read of the current conversation, not a new agent.
      // Keeping the root identity is what makes Antigravity reuse the current
      // user's provider session instead of deriving a separate agent route.
      preserveParentAgentId: true,
    },
  })

  const assistantMessages = result.messages.filter(
    (message): message is Extract<Message, { type: 'assistant' }> =>
      message.type === 'assistant',
  )
  const text = extractTextContent(
    assistantMessages.flatMap(message => message.message.content),
    '\n',
  ).trim()
  const markdown = stripMarkdownFence(text)
  assertValidGeneratedReport(markdown, {
    isApiErrorMessage: assistantMessages.some(
      message => message.isApiErrorMessage === true,
    ),
  })
  return markdown
}

function stripMarkdownFence(value: string): string {
  const trimmed = value.trim()
  const match = trimmed.match(/^```(?:markdown|md)?\s*([\s\S]*?)\s*```$/i)
  return match ? match[1]!.trim() : trimmed
}

async function writePdf(markdown: string, path: string): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: 62,
      info: {
        Title: extractReportTitle(markdown),
      },
    })
    const stream = createWriteStream(path)

    stream.on('finish', resolvePromise)
    stream.on('error', reject)
    doc.on('error', reject)

    doc.pipe(stream)
    renderMarkdownToPdf(doc, markdown)
    doc.end()
  })
}

function renderMarkdownToPdf(doc: PDFKit.PDFDocument, markdown: string): void {
  doc.fillColor('#202925')

  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) {
      doc.moveDown(0.45)
      continue
    }

    if (line.startsWith('# ')) {
      doc.moveDown(0.2)
      doc.font('Times-Bold').fontSize(27).fillColor('#202925')
      doc.text(stripInlineMarkdown(line.slice(2)), { lineGap: 5 })
      doc.moveDown(0.35)
      doc.strokeColor('#276353').lineWidth(2)
      doc.moveTo(doc.x, doc.y).lineTo(doc.x + 72, doc.y).stroke()
      doc.moveDown(1.1)
      continue
    }

    if (line.startsWith('## ')) {
      doc.moveDown(0.8)
      doc.font('Times-Bold').fontSize(15).fillColor('#276353')
      doc.text(stripInlineMarkdown(line.slice(3)), { lineGap: 2 })
      doc.moveDown(0.35)
      doc.fillColor('#202925')
      continue
    }

    if (line.startsWith('### ')) {
      doc.moveDown(0.5)
      doc.font('Helvetica-Bold').fontSize(12)
      doc.text(stripInlineMarkdown(line.slice(4)), { lineGap: 2 })
      doc.moveDown(0.2)
      continue
    }

    const listMatch = line.match(/^[-*]\s+(.*)$/)
    if (listMatch) {
      doc.font('Helvetica').fontSize(10.5).fillColor('#202925')
      doc.text(`•  ${stripInlineMarkdown(listMatch[1]!)}`, {
        indent: 14,
        hangingIndent: 10,
        lineGap: 2,
      })
      continue
    }

    doc.font('Helvetica').fontSize(10.5).fillColor('#202925')
    doc.text(stripInlineMarkdown(line), { lineGap: 3 })
  }
}

function stripInlineMarkdown(value: string): string {
  return value
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith('\n') ? value : `${value}\n`
}
