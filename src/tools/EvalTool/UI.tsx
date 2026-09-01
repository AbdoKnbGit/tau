import * as React from 'react'

import { HighlightedCode } from '../../components/HighlightedCode.js'
import { InlineImage } from '../../components/InlineImage.js'
import { MessageResponse } from '../../components/MessageResponse.js'
import { Box, Text } from '../../ink.js'
import type { EvalOutput } from './EvalTool.js'

/**
 * Transcript rendering for a Python cell.
 *
 * The first version of this file did not exist, and the tool rendered as a
 * bare `Python(title)` header with a `2 lines` summary underneath. Ctrl+O
 * expanded to nothing, because `renderToolResultMessage` ignored `verbose`.
 * You could not see what the cell actually ran — which for a tool whose entire
 * job is running model-authored code is the one thing that has to be visible.
 *
 * So: the code is always shown (collapsed to a few lines, in full when
 * expanded), the output is shown beneath it, figures render inline, and every
 * bridged tool call is listed so the file reads that happened inside the cell
 * are as visible as they would be as ordinary tool calls.
 */

/** Collapsed line budgets. Expanding (Ctrl+O / verbose) lifts both. */
const COLLAPSED_CODE_LINES = 8
const COLLAPSED_OUTPUT_LINES = 10

/**
 * `HighlightedCode` ships through the React compiler, which erases its prop
 * types down to `object`, so JSX against it does not type-check. Re-stating the
 * shape here is the same trade the other call sites make (FileWriteTool,
 * NotebookEditTool); it is checked against the component's own `Props` in
 * HighlightedCode.tsx.
 */
const Code = HighlightedCode as unknown as React.ComponentType<{
  code: string
  filePath: string
  width?: number
  dim?: boolean
}>

type RenderOptions = {
  verbose: boolean
  isTranscriptMode?: boolean
  input?: unknown
}

function codeFromInput(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const code = (input as { code?: unknown }).code
  return typeof code === 'string' ? code : ''
}

/** First line that is not a comment, a decorator, or blank. */
function headline(code: string): string {
  for (const raw of code.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith('@')) continue
    return line
  }
  return code.split('\n')[0]?.trim() ?? ''
}

function truncateLine(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function clampLines(
  text: string,
  limit: number,
): { shown: string; hidden: number } {
  const lines = text.split('\n')
  if (lines.length <= limit) return { shown: text, hidden: 0 }
  return {
    shown: lines.slice(0, limit).join('\n'),
    hidden: lines.length - limit,
  }
}

/**
 * The header line: `Python(…)`. Shows the title when the model gave one,
 * otherwise the first real statement, so the cell is identifiable at a glance
 * without expanding.
 */
export function renderToolUseMessage(
  input: { code?: string; title?: string },
  { verbose }: { verbose: boolean },
): React.ReactNode {
  const title = input.title?.trim()
  const code = input.code ?? ''
  if (verbose && code) {
    return truncateLine(title ? `${title} — ${headline(code)}` : headline(code), 120)
  }
  return truncateLine(title || headline(code) || 'cell', 72)
}

/** Transcript-search text: the code plus the output, which is what is visible. */
export function extractSearchText(output: EvalOutput): string {
  return `${output.text ?? ''}`
}

/** Gates the click-to-expand affordance: true when collapsing hides something. */
export function isResultTruncated(output: EvalOutput): boolean {
  const outputLines = (output.text ?? '').split('\n').length
  return outputLines > COLLAPSED_OUTPUT_LINES || output.bridgeCalls.length > 0
}

function BridgeCalls({
  calls,
  verbose,
}: {
  calls: EvalOutput['bridgeCalls']
  verbose: boolean
}): React.ReactNode {
  if (calls.length === 0) return null

  // Many calls collapse to a per-tool tally; a loop over 400 files must not
  // print 400 lines. Failures always stay visible.
  const failures = calls.filter(call => call.error)
  const shouldList = verbose ? calls.length <= 60 : calls.length <= 6

  if (shouldList) {
    return (
      <Box flexDirection="column">
        {calls.map((call, index) => (
          <Text key={`${call.name}-${index}`} dimColor>
            {'  '}
            {call.name}
            {call.detail ? ` ${truncateLine(call.detail, 60)}` : ''}
            {call.error ? ` — ${truncateLine(call.error, 60)}` : ''}
          </Text>
        ))}
      </Box>
    )
  }

  const counts = new Map<string, number>()
  for (const call of calls) counts.set(call.name, (counts.get(call.name) ?? 0) + 1)
  const tally = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `${count}× ${name}`)
    .join(', ')

  return (
    <Box flexDirection="column">
      <Text dimColor>
        {'  '}
        {tally}
      </Text>
      {failures.slice(0, 3).map((call, index) => (
        <Text key={`fail-${index}`} color="error">
          {'  '}
          {call.name} failed — {truncateLine(call.error ?? '', 60)}
        </Text>
      ))}
    </Box>
  )
}

export function renderToolResultMessage(
  output: EvalOutput,
  _progress: unknown[],
  { verbose, isTranscriptMode, input }: RenderOptions,
): React.ReactNode {
  const expanded = verbose || isTranscriptMode === true
  const code = codeFromInput(input)
  const text = output.text ?? ''

  const codeView = clampLines(code, expanded ? Number.MAX_SAFE_INTEGER : COLLAPSED_CODE_LINES)
  const outputView = clampLines(
    text,
    expanded ? Number.MAX_SAFE_INTEGER : COLLAPSED_OUTPUT_LINES,
  )

  const status: string[] = []
  if (output.timedOut) status.push('timed out — kernel still running')
  else if (output.cancelled) status.push('interrupted')
  if (output.kernelRestarted) status.push('kernel restarted, namespace empty')
  if (output.truncated) status.push('output truncated')
  if (output.durationMs >= 1000) status.push(`${(output.durationMs / 1000).toFixed(1)}s`)

  const body = (
    <Box flexDirection="column">
      {code ? (
        <Box flexDirection="column">
          <Code code={codeView.shown} filePath="cell.py" />
          {codeView.hidden > 0 ? (
            <Text dimColor>
              {'  … +'}
              {codeView.hidden} more line{codeView.hidden === 1 ? '' : 's'} of code
              {' (ctrl+o to expand)'}
            </Text>
          ) : null}
        </Box>
      ) : null}

      {outputView.shown.trim() ? (
        <Box flexDirection="column" marginTop={code ? 1 : 0}>
          <Text color={output.ok ? undefined : 'error'}>{outputView.shown}</Text>
          {outputView.hidden > 0 ? (
            <Text dimColor>
              {'… +'}
              {outputView.hidden} more line{outputView.hidden === 1 ? '' : 's'}
              {' (ctrl+o to expand)'}
            </Text>
          ) : null}
        </Box>
      ) : null}

      <BridgeCalls calls={output.bridgeCalls} verbose={expanded} />

      {status.length > 0 ? <Text dimColor>{status.join(' · ')}</Text> : null}
    </Box>
  )

  // Figures wrap the body so the picture sits directly above its own cell,
  // which is how InlineImage expects to be composed.
  const figures = output.images.filter(image => image.mime.startsWith('image/'))
  if (figures.length === 0) {
    return <MessageResponse>{body}</MessageResponse>
  }

  return (
    <MessageResponse>
      {figures.reduce<React.ReactNode>(
        (children, image, index) => (
          <InlineImage key={`figure-${index}`} base64={image.data}>
            {children}
          </InlineImage>
        ),
        body,
      )}
    </MessageResponse>
  )
}
