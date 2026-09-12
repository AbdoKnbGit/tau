import type { HistoryMode } from 'src/hooks/useArrowKeyHistory.js'
import type { PromptInputMode } from 'src/types/textInputTypes.js'

export function prependModeCharacterToInput(
  input: string,
  mode: PromptInputMode,
): string {
  switch (mode) {
    case 'bash':
      return `!${input}`
    default:
      return input
  }
}

export function getModeFromInput(input: string): HistoryMode {
  if (input.startsWith('!')) {
    return 'bash'
  }
  return 'prompt'
}

export function getValueFromInput(input: string): string {
  const mode = getModeFromInput(input)
  if (mode === 'prompt') {
    return input
  }
  return input.slice(1)
}

export function isInputModeCharacter(input: string): boolean {
  return input === '!'
}

/**
 * The mode that `text`, typed or inserted at the start of the input,
 * switches to. Null when it doesn't start with a mode character, or when the
 * input is already in that mode: a second `!` in bash mode is plain text
 * (see getHiddenBashCommand).
 */
export function getModeSwitchFromInput(
  text: string,
  currentMode: PromptInputMode | undefined,
): PromptInputMode | null {
  const mode = getModeFromInput(text)
  return mode === 'prompt' || mode === currentMode ? null : mode
}

/**
 * `!!cmd`: a bash-mode command that itself starts with the bash mode
 * character runs without its output being sent to the model. True as soon
 * as that second `!` is there, before anything is typed after it.
 */
export function isHiddenBashInput(bashCommand: string): boolean {
  return getModeFromInput(bashCommand) === 'bash'
}

/**
 * The command a hidden (`!!cmd`) bash input runs, or null when there is none:
 * not a hidden input, or nothing typed after `!!`.
 */
export function getHiddenBashCommand(bashCommand: string): string | null {
  if (!isHiddenBashInput(bashCommand)) {
    return null
  }
  const command = getValueFromInput(bashCommand).trimStart()
  return command === '' ? null : command
}
