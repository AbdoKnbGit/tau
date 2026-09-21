import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/messages/messages.mjs'
import * as React from 'react'
import { stripUnderlineAnsi } from 'src/components/shell/OutputLine.js'
import { Ansi, Box, Text } from '../ink.js'
import { useShortcutDisplay } from '../keybindings/useShortcutDisplay.js'
import { countCharInString } from '../utils/stringUtils.js'
import {
  normalizeToolError,
  redactToolErrorForNormalView,
} from './fallbackToolError.js'
import { MessageResponse } from './MessageResponse.js'

const MAX_RENDERED_LINES = 10

type Props = {
  result: ToolResultBlockParam['content']
  verbose: boolean
  /** Transcript (Ctrl+O) shows the original error; the normal view does not. */
  isTranscriptMode?: boolean
}

export function FallbackToolUseErrorMessage({
  result,
  verbose,
  isTranscriptMode,
}: Props): React.ReactNode {
  const transcriptShortcut = useShortcutDisplay(
    'app:toggleTranscript',
    'Global',
    'ctrl+o',
  )

  const error = normalizeToolError(result)
  // `verbose` lifts the line cap; it is not permission to show stack frames
  // and JSON bodies in the conversation view. Only transcript mode is.
  const shown = isTranscriptMode
    ? error
    : redactToolErrorForNormalView(error)
  const renderedError = stripUnderlineAnsi(
    verbose
      ? shown
      : shown.split('\n').slice(0, MAX_RENDERED_LINES).join('\n'),
  )
  const plusLines =
    countCharInString(shown, '\n') + 1 - MAX_RENDERED_LINES

  return (
    <MessageResponse>
      <Box flexDirection="column">
        <Text color="error">
          <Ansi>{renderedError}</Ansi>
        </Text>
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
