import React from 'react'
import { stringWidth } from '../ink/stringWidth.js'
import { Box, Text } from '../ink.js'
import type { NormalizedMessage } from '../types/message.js'
import { formatMessageHeaderTimestamp } from '../utils/messageHeader.js'

type Props = {
  message: NormalizedMessage
  /**
   * Whether the message header is rendered for this row — transcript mode, or
   * any mode when messageHeaderMode is one of the always:* values.
   * See utils/messageHeader.ts.
   */
  showHeader: boolean
  /** Prefix the time with the date ("27 Aug 2026 10:00 AM"). */
  showDate: boolean
}

export function MessageTimestamp({
  message,
  showHeader,
  showDate,
}: Props): React.ReactNode {
  const shouldShowTimestamp =
    showHeader &&
    message.timestamp &&
    message.type === 'assistant' &&
    message.message.content.some(c => c.type === 'text')

  if (!shouldShowTimestamp) {
    return null
  }

  const formattedTimestamp = formatMessageHeaderTimestamp(
    message.timestamp,
    showDate,
  )
  if (!formattedTimestamp) {
    return null
  }

  return (
    <Box minWidth={stringWidth(formattedTimestamp)}>
      <Text dimColor>{formattedTimestamp}</Text>
    </Box>
  )
}
