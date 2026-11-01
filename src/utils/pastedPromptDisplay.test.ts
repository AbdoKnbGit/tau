import { describe, expect, test } from 'bun:test'
import { createUserMessage, normalizeMessages, normalizeMessagesForAPI } from './messages.js'
import {
  foldPastedCommandArgs,
  getFoldedCommandArgs,
  getPastedPromptDisplay,
} from './pastedPromptDisplay.js'

const FOLDED = '[Pasted text #1 +39 lines] summarize this'
const FULL = `${Array.from({ length: 40 }, (_, i) => `pasted ${i}`).join('\n')} summarize this`

describe('getPastedPromptDisplay', () => {
  test('gives the prompt as the prompt bar showed it', () => {
    expect(getPastedPromptDisplay(FOLDED, FULL)).toBe(FOLDED)
    expect(getPastedPromptDisplay(`  ${FOLDED}\n`, FULL)).toBe(FOLDED)
    expect(getPastedPromptDisplay('[Pasted text #2]', 'a very long single line')).toBe('[Pasted text #2]')
    expect(
      getPastedPromptDisplay('[...Truncated text #3 +500 lines...]', 'the middle of a huge input'),
    ).toBe('[...Truncated text #3 +500 lines...]')
  })

  test('stays out of the way when nothing was folded', () => {
    expect(getPastedPromptDisplay(undefined, FULL)).toBeUndefined()
    expect(getPastedPromptDisplay('', FULL)).toBeUndefined()
    expect(getPastedPromptDisplay('typed by hand', 'typed by hand')).toBeUndefined()
    expect(getPastedPromptDisplay('typed by hand ', 'typed by hand')).toBeUndefined()
    // An image chip is no fold: the text is the same on both sides.
    expect(getPastedPromptDisplay('[Image #1] look', '[Image #1] look')).toBeUndefined()
    // A hook rewrote the prompt, so there is no chip to show.
    expect(getPastedPromptDisplay('rewritten by a hook', FULL)).toBeUndefined()
    // Bridge and SDK input can be content blocks.
    expect(getPastedPromptDisplay(FOLDED, [{ type: 'text', text: FULL }])).toBeUndefined()
    expect(getPastedPromptDisplay(FOLDED, null)).toBeUndefined()
  })

  test('typing the words of a chip by hand changes nothing', () => {
    const typed = '[Pasted text #9 +9 lines]'
    expect(getPastedPromptDisplay(typed, typed)).toBeUndefined()
  })
})

describe('slash commands', () => {
  test('getFoldedCommandArgs takes what follows the command name', () => {
    expect(getFoldedCommandArgs('/foo [Pasted text #1 +3 lines]')).toBe('[Pasted text #1 +3 lines]')
    expect(getFoldedCommandArgs('/foo  two words [Pasted text #1]')).toBe('two words [Pasted text #1]')
    expect(getFoldedCommandArgs('/foo')).toBeUndefined()
    expect(getFoldedCommandArgs('/foo   ')).toBeUndefined()
    expect(getFoldedCommandArgs(undefined)).toBeUndefined()
  })

  test('foldPastedCommandArgs marks only the message that echoes the command', () => {
    const echo = createUserMessage({
      content: '<command-message>foo</command-message><command-name>/foo</command-name><command-args>the whole text</command-args>',
    })
    const body = createUserMessage({ content: 'the prompt with the whole text', isMeta: true })
    const second = createUserMessage({ content: '<command-args>not this one</command-args>' })
    const result = foldPastedCommandArgs({ messages: [body, echo, second], shouldQuery: true }, '/foo [Pasted text #1 +3 lines]')
    expect(result.shouldQuery).toBe(true)
    expect(result.messages[0]).toBe(body)
    expect(result.messages[1].pastedDisplayText).toBe('/foo [Pasted text #1 +3 lines]')
    expect(result.messages[1].message).toBe(echo.message)
    expect(result.messages[2]).toBe(second)
    expect('pastedDisplayText' in echo).toBe(false)
  })

  test('foldPastedCommandArgs leaves results alone when nothing was folded', () => {
    const result = { messages: [createUserMessage({ content: '<command-args>x</command-args>' })] }
    expect(foldPastedCommandArgs(result, undefined)).toBe(result)
  })
})

describe('the folded form on a message', () => {
  test('a message with nothing folded has no such field at all', () => {
    expect('pastedDisplayText' in createUserMessage({ content: 'plain' })).toBe(false)
    expect('pastedDisplayText' in createUserMessage({ content: 'plain', pastedDisplayText: undefined })).toBe(false)
  })

  test('display normalization keeps it for a plain prompt', () => {
    const [normalized] = normalizeMessages([createUserMessage({ content: FULL, pastedDisplayText: FOLDED })])
    expect(normalized.pastedDisplayText).toBe(FOLDED)
    expect(normalized.message.content).toEqual([{ type: 'text', text: FULL }])
  })

  test('display normalization gives it to the text block, not to the image', () => {
    const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } } as const
    const blocks = normalizeMessages([
      createUserMessage({
        content: [{ type: 'text', text: FULL }, image],
        imagePasteIds: [2],
        pastedDisplayText: FOLDED,
      }),
    ])
    expect(blocks).toHaveLength(2)
    expect(blocks[0].pastedDisplayText).toBe(FOLDED)
    expect(blocks[1].pastedDisplayText).toBeUndefined()
    expect(blocks[1].imagePasteIds).toEqual([2])
  })

  test('it never reaches a request: the body matches a prompt with no fold', () => {
    const uuid = '00000000-0000-4000-8000-000000000001'
    const timestamp = '2026-10-31T00:00:00.000Z'
    const folded = createUserMessage({ content: FULL, pastedDisplayText: FOLDED, uuid, timestamp })
    const plain = createUserMessage({ content: FULL, uuid, timestamp })
    const toWire = message => normalizeMessagesForAPI([message], []).map(m => m.message)
    expect(JSON.stringify(toWire(folded))).toBe(JSON.stringify(toWire(plain)))
    expect(JSON.stringify(toWire(folded))).not.toContain('Pasted text')
    expect(JSON.stringify(toWire(folded))).toContain('pasted 39')
  })
})
