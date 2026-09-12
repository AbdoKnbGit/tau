import { randomUUID } from 'crypto'
import { BASH_INPUT_TAG } from '../constants/xml.js'
import type { SystemMessage } from '../types/message.js'

const HIDDEN_BASH_SUBTYPE = 'hidden_bash'

/**
 * Shows a `!!cmd` shell command and its output in the transcript without
 * sending either to the model: normalizeMessagesForAPI drops every system
 * message except local_command, on every request and after /resume.
 * `output` is tagged like a `!cmd` output message (<bash-stdout>,
 * <bash-stderr>), so both render the same way.
 */
export function createHiddenBashMessage({
  command,
  output = '',
  interrupted = false,
}: {
  command: string
  output?: string
  interrupted?: boolean
}): SystemMessage {
  return {
    type: 'system',
    subtype: HIDDEN_BASH_SUBTYPE,
    content: `<${BASH_INPUT_TAG}>${command}</${BASH_INPUT_TAG}>${output}`,
    level: 'info',
    isMeta: false,
    timestamp: new Date().toISOString(),
    uuid: randomUUID(),
    ...(interrupted && { interrupted: true }),
  }
}

export function isHiddenBashMessage(message: {
  type: string
  subtype?: string
}): boolean {
  return message.type === 'system' && message.subtype === HIDDEN_BASH_SUBTYPE
}
