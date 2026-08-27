import React from 'react'
import { stringWidth } from '../ink/stringWidth.js'
import { Box, Text } from '../ink.js'
import type { NormalizedMessage } from '../types/message.js'

type Props = {
  message: NormalizedMessage
  /**
   * Whether the message header is rendered for this row — transcript mode, or
   * any mode when `messageHeaderMode: 'always'`. See utils/messageHeader.ts.
   */
  showHeader: boolean
}

export function MessageModel({ message, showHeader }: Props): React.ReactNode {
  const shouldShowModel =
    showHeader &&
    message.type === 'assistant' &&
    message.message.model &&
    message.message.content.some(c => c.type === 'text')

  if (!shouldShowModel) {
    return null
  }

  return (
    <Box minWidth={stringWidth(message.message.model) + 8}>
      <Text dimColor>{message.message.model}</Text>
    </Box>
  )
}
