import { describe, expect, test } from 'bun:test'
import {
  getHiddenBashCommand,
  getModeFromInput,
  getModeSwitchFromInput,
  getValueFromInput,
  isHiddenBashInput,
  prependModeCharacterToInput,
} from './inputModes.js'

describe('isHiddenBashInput', () => {
  test('is true as soon as the second ! is typed', () => {
    expect(isHiddenBashInput('!')).toBe(true)
    expect(isHiddenBashInput('!git status')).toBe(true)
  })

  test('is false for a normal bash command', () => {
    expect(isHiddenBashInput('git status')).toBe(false)
    expect(isHiddenBashInput('')).toBe(false)
  })
})

describe('getHiddenBashCommand', () => {
  test('a second ! hides the command, with or without a space', () => {
    expect(getHiddenBashCommand('!git status')).toBe('git status')
    expect(getHiddenBashCommand('! git status')).toBe('git status')
  })

  test('keeps a multi-line command intact', () => {
    expect(getHiddenBashCommand('!echo a\necho b')).toBe('echo a\necho b')
  })

  test('normal bash commands stay visible', () => {
    expect(getHiddenBashCommand('git status')).toBeNull()
    expect(getHiddenBashCommand(' !git status')).toBeNull()
  })

  test('!! with nothing after it has no command to run', () => {
    expect(getHiddenBashCommand('!')).toBeNull()
    expect(getHiddenBashCommand('!  ')).toBeNull()
  })
})

describe('getModeSwitchFromInput', () => {
  test('! switches the prompt to bash mode', () => {
    expect(getModeSwitchFromInput('!', 'prompt')).toBe('bash')
    expect(getModeSwitchFromInput('!git status', 'prompt')).toBe('bash')
  })

  test('! typed in bash mode is text', () => {
    expect(getModeSwitchFromInput('!', 'bash')).toBeNull()
    expect(getModeSwitchFromInput('!git status', 'bash')).toBeNull()
  })

  test('text without a mode character never switches', () => {
    expect(getModeSwitchFromInput('git status', 'prompt')).toBeNull()
    expect(getModeSwitchFromInput('git status', 'bash')).toBeNull()
  })

  test('inputs without a mode keep switching on !', () => {
    expect(getModeSwitchFromInput('!', undefined)).toBe('bash')
  })
})

describe('history entries', () => {
  test('!!cmd is stored and restored as a hidden bash command', () => {
    const display = prependModeCharacterToInput('!git status', 'bash')
    expect(display).toBe('!!git status')
    expect(getModeFromInput(display)).toBe('bash')
    expect(getHiddenBashCommand(getValueFromInput(display))).toBe('git status')
  })

  test('!cmd is unchanged', () => {
    const display = prependModeCharacterToInput('git status', 'bash')
    expect(display).toBe('!git status')
    expect(getHiddenBashCommand(getValueFromInput(display))).toBeNull()
  })
})
