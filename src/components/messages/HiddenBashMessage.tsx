import * as React from 'react'
import { BASH_INPUT_TAG } from '../../constants/xml.js'
import { Box, Text } from '../../ink.js'
import { extractTag } from '../../utils/messages.js'
import { InterruptedByUser } from '../InterruptedByUser.js'
import { MessageResponse } from '../MessageResponse.js'
import { UserBashOutputMessage } from './UserBashOutputMessage.js'

/**
 * The input line of a `!!cmd` shell command: dimmed and labelled, since
 * neither the command nor its output is sent to the model.
 */
export function HiddenBashInputMessage({
  command,
  addMargin,
}: {
  command: string
  addMargin: boolean
}): React.ReactNode {
  return (
    <Box flexDirection="row" marginTop={addMargin ? 1 : 0} paddingRight={1}>
      <Text dimColor>! </Text>
      <Text dimColor>
        {command} <Text italic>(not sent to model)</Text>
      </Text>
    </Box>
  )
}

/** A `!!cmd` shell command and its output (see createHiddenBashMessage). */
export function HiddenBashMessage({
  content,
  interrupted,
  addMargin,
  verbose,
}: {
  content: string
  interrupted: boolean
  addMargin: boolean
  verbose: boolean
}): React.ReactNode {
  return (
    <Box flexDirection="column">
      <HiddenBashInputMessage
        command={extractTag(content, BASH_INPUT_TAG) ?? ''}
        addMargin={addMargin}
      />
      {interrupted ? (
        <MessageResponse height={1}>
          <InterruptedByUser />
        </MessageResponse>
      ) : (
        <UserBashOutputMessage content={content} verbose={verbose} />
      )}
    </Box>
  )
}
