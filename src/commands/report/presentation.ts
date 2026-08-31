import { marked } from 'marked'
import xss from 'xss'

export interface ReportPresentationSkill {
  extension: string
  instruction: string
}

export type ReportPresentationFormat = 'markdown' | 'html' | 'pdf'

export function buildReportPrompt({
  format,
  skill,
}: {
  format: ReportPresentationFormat
  skill: ReportPresentationSkill
}): string {
  return `Write a polished final report using the conversation context already provided.

The report will be delivered as ${format}. ${skill.instruction}

Editorial direction:
- Return only Markdown content. Do not wrap it in a code fence.
- Open with a specific, informative title derived from the work—not "Session Report".
- Follow the title with a two- or three-sentence overview that states the outcome directly.
- Organize the body around the actual story of the work. Use only sections that add information; do not force a template or include empty sections.
- Prefer precise prose. Use bullets for concrete results, decisions, open items, or next steps when they improve scanning.
- Vary sentence structure and avoid canned phrases such as "This session focused on," "delve," "robust," "comprehensive," or "Nothing specific came up."
- Preserve material decisions, constraints, blockers, file names, commands, and next actions when they matter to the reader.
- Do not mention the assistant, the transcript, prompts, tools, token usage, costs, timing, or report-generation process.
- Do not add statistics, percentages, charts, or numerical summaries unless a number is itself part of the work being reported.
- Be factual. Do not invent completed work, decisions, evidence, or follow-up actions.
`
}

export function assertValidGeneratedReport(
  markdown: string,
  options: { isApiErrorMessage?: boolean } = {},
): void {
  const firstLine = markdown.split(/\r?\n/).find(line => line.trim())?.trim() ?? ''
  const isProviderFailure =
    /^(?:api error\b|please run \/login\s*[·:-]\s*api error\b|failed to authenticate\b|request timed out\b|prompt is too long\b|antigravity request was\b|(?:gemini|qwen|codex|openai|kiro|kilo|cline|cursor|ollama|[\w.-]+)\s+(?:api|auth|connection)\s+error\b)/i
      .test(firstLine)
  if (!markdown || options.isApiErrorMessage === true || isProviderFailure) {
    const detail = firstLine ? ` ${firstLine.slice(0, 240)}` : ''
    throw new Error(`Report generation did not return report content.${detail}`)
  }
}

export function renderHtml(markdown: string): string {
  const body = xss(marked.parse(markdown, { async: false }) as string)
  const title = escapeHtml(extractReportTitle(markdown))
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>
    :root {
      color-scheme: light;
      --canvas: #edeae3;
      --ink: #202925;
      --muted: #637069;
      --rule: #d9d6cc;
      --accent: #276353;
      --paper: #fffefa;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--canvas);
      color: var(--ink);
      font: 16px/1.72 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    main {
      max-width: 900px;
      margin: 48px auto;
      padding: 64px 72px 72px;
      background: var(--paper);
      border: 1px solid var(--rule);
      border-radius: 3px;
      box-shadow: 0 18px 50px rgba(32, 41, 37, 0.08);
    }
    article { max-width: 720px; margin: 0 auto; }
    h1, h2, h3 {
      font-family: ui-serif, Georgia, Cambria, "Times New Roman", serif;
      line-height: 1.18;
    }
    h1 {
      margin: 0 0 22px;
      max-width: 18ch;
      font-size: clamp(2.25rem, 5vw, 3.6rem);
      font-weight: 650;
      letter-spacing: -0.035em;
    }
    h1 + p { color: var(--muted); font-size: 1.12rem; line-height: 1.65; }
    h2 {
      margin: 40px 0 14px;
      padding-top: 22px;
      border-top: 1px solid var(--rule);
      font-size: 1.55rem;
      letter-spacing: -0.012em;
    }
    h3 { margin: 28px 0 10px; font-size: 1.15rem; }
    p, ul, ol, blockquote { margin: 0 0 16px; }
    ul, ol { padding-left: 1.3rem; }
    li { margin: 7px 0; padding-left: 0.2rem; }
    li::marker { color: var(--accent); }
    strong { font-weight: 650; }
    a { color: var(--accent); text-underline-offset: 0.18em; }
    blockquote {
      padding: 2px 0 2px 18px;
      border-left: 3px solid var(--accent);
      color: var(--muted);
    }
    pre {
      overflow-x: auto;
      padding: 16px 18px;
      border: 1px solid var(--rule);
      border-radius: 4px;
      background: #f5f4ef;
    }
    code {
      font-family: "SFMono-Regular", Consolas, monospace;
      font-size: 0.92em;
    }
    :not(pre) > code { padding: 0.12em 0.32em; border-radius: 3px; background: #f0efe9; }
    @media (max-width: 720px) {
      main {
        margin: 0;
        padding: 38px 24px 48px;
        border: 0;
        border-radius: 0;
        box-shadow: none;
      }
    }
    @media print {
      body { background: #fff; }
      main { margin: 0; padding: 0; border: 0; box-shadow: none; }
    }
  </style>
</head>
<body>
  <main>
    <article>
${body}
    </article>
  </main>
</body>
</html>
`
}

export function extractReportTitle(markdown: string): string {
  const heading = markdown.match(/^#\s+(.+)$/m)?.[1]
  return heading ? stripInlineMarkdown(heading) : 'Session Report'
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function stripInlineMarkdown(value: string): string {
  return value
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
}
