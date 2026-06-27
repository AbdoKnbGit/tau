import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/messages/messages.mjs'
import * as React from 'react'
import { stripUnderlineAnsi } from 'src/components/shell/OutputLine.js'
import { Box, Text } from '../ink.js'
import { useShortcutDisplay } from '../keybindings/useShortcutDisplay.js'
import { countCharInString } from '../utils/stringUtils.js'
import { normalizeToolError } from './fallbackToolError.js'
import { MessageResponse } from './MessageResponse.js'

const MAX_RENDERED_LINES = 10

type Props = {
  result: ToolResultBlockParam['content']
  verbose: boolean
}

export function FallbackToolUseErrorMessage({
  result,
  verbose,
}: Props): React.ReactNode {
  const transcriptShortcut = useShortcutDisplay(
    'app:toggleTranscript',
    'Global',
    'ctrl+o',
  )

  const error = normalizeToolError(result)
  const renderedError = stripUnderlineAnsi(
    verbose
      ? error
      : error.split('\n').slice(0, MAX_RENDERED_LINES).join('\n'),
  )
  const plusLines =
    countCharInString(error, '\n') + 1 - MAX_RENDERED_LINES

  return (
    <MessageResponse>
      <Box flexDirection="column">
        <Text color="error">{renderedError}</Text>
        {!verbose && plusLines > 0 && (
          <Box>
            <Text dimColor>
              ... +{plusLines} {plusLines === 1 ? 'line' : 'lines'} (
            </Text>
            <Text dimColor bold>
              {transcriptShortcut}
            </Text>
            <Text> </Text>
            <Text dimColor>to see all)</Text>
          </Box>
        )}
      </Box>
    </MessageResponse>
  )
}
