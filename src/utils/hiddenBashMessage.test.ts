import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  createHiddenBashMessage,
  isHiddenBashMessage,
} from './hiddenBashMessage.js'

const output =
  '<bash-stdout>On branch master</bash-stdout><bash-stderr></bash-stderr>'

describe('hidden bash output (!!cmd)', () => {
  test('is a system message with the command and its tagged output', () => {
    const message = createHiddenBashMessage({ command: 'git status', output })
    expect(message.type).toBe('system')
    expect(message.content).toBe(`<bash-input>git status</bash-input>${output}`)
    expect(isHiddenBashMessage(message)).toBe(true)
  })

  test('is not a local_command message, the one system type sent to the API', () => {
    const message = createHiddenBashMessage({ command: 'ls' })
    expect((message as { subtype?: string }).subtype).not.toBe('local_command')
  })

  test('an interrupted command carries no output', () => {
    const message = createHiddenBashMessage({
      command: 'sleep 60',
      interrupted: true,
    })
    expect(message.content).toBe('<bash-input>sleep 60</bash-input>')
    expect((message as { interrupted?: boolean }).interrupted).toBe(true)
  })

  test('other messages are not hidden bash output', () => {
    expect(
      isHiddenBashMessage({ type: 'system', subtype: 'informational' }),
    ).toBe(false)
    expect(isHiddenBashMessage({ type: 'system', subtype: 'local_command' })).toBe(
      false,
    )
    expect(isHiddenBashMessage({ type: 'user' })).toBe(false)
  })

  test('normalizeMessagesForAPI still drops non-local_command system messages', () => {
    // messages.ts can't be imported in this tree (optional native and
    // generated modules are missing; see EvalTool/evalTool.test.ts), so guard
    // the rule this feature relies on in the source instead.
    // CRLF checkouts (Windows) would hide where the function ends.
    const source = readFileSync(
      join(import.meta.dir, 'messages.ts'),
      'utf8',
    ).replace(/\r\n/g, '\n')
    const start = source.indexOf('export function normalizeMessagesForAPI(')
    expect(start).not.toBe(-1)
    const body = source.slice(start, source.indexOf('\n}\n', start))
    expect(body).toContain(
      "(_.type === 'system' && !isSystemLocalCommandMessage(_))",
    )
  })
})
