import type {
  ToolResultBlockParam,
  ToolUseBlockParam,
} from '@anthropic-ai/sdk/resources/index.mjs'
import * as React from 'react'
import { Box, Text } from '../../ink.js'
import { OutputLine } from '../shell/OutputLine.js'
import { ToolUseLoader } from '../ToolUseLoader.js'

/** Historical calls must stay readable after their plugin leaves the tool pool. */
export function RecordedToolUseMessage({
  param,
  addMargin,
  verbose,
  isError,
}: {
  param: ToolUseBlockParam
  addMargin: boolean
  verbose: boolean
  isError: boolean
}): React.ReactNode {
  const input = React.useMemo(() => JSON.stringify(param.input), [param.input])
  return (
    <Box flexDirection="row" marginTop={addMargin ? 1 : 0}>
      <ToolUseLoader shouldAnimate={false} isUnresolved={false} isError={isError} />
      <Text wrap={verbose ? 'wrap' : 'truncate-end'}>
        <Text bold>{param.name}</Text>
        {input ? `(${input})` : ''}
      </Text>
    </Box>
  )
}

function recordedContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content) || !content.length) return '(No content)'
  return content.map(block => {
    if (!block || typeof block !== 'object') return '[Tool output]'
    switch (block.type) {
      case 'text':
        return typeof block.text === 'string' ? block.text : '[Text]'
      case 'image':
        return '[Image]'
      case 'document':
        return '[Document]'
      case 'search_result':
        return [
          typeof block.title === 'string' ? block.title : '',
          typeof block.source === 'string' ? block.source : '',
          recordedContent(block.content),
        ].filter(Boolean).join('\n')
      case 'tool_reference':
        return typeof block.tool_name === 'string' ? `[Tool: ${block.tool_name}]` : '[Tool reference]'
      default:
        return '[Tool output]'
    }
  }).join('\n')
}

/** Render saved output without loading or executing an unavailable tool. */
export function RecordedToolResultMessage({
  param,
  verbose,
}: {
  param: ToolResultBlockParam
  verbose: boolean
}): React.ReactNode {
  const content = React.useMemo(() => recordedContent(param.content), [param.content])
  return <OutputLine content={content} verbose={verbose} />
}
