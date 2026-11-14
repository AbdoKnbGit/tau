/**
 * Centralized utilities for parsing slash commands
 */

export type ParsedSlashCommand = {
  commandName: string
  args: string
  isMcp: boolean
}

/**
 * Parses a slash command input string into its component parts
 *
 * @param input - The raw input string (should start with '/')
 * @returns Parsed command name, args, and MCP flag, or null if invalid
 *
 * @example
 * parseSlashCommand('/search foo bar')
 * // => { commandName: 'search', args: 'foo bar', isMcp: false }
 *
 * @example
 * parseSlashCommand('/mcp:tool (MCP) arg1 arg2')
 * // => { commandName: 'mcp:tool (MCP)', args: 'arg1 arg2', isMcp: true }
 *
 * @example
 * parseSlashCommand('/plan\nAdd a login page', name => name === 'plan')
 * // => { commandName: 'plan', args: 'Add a login page', isMcp: false }
 *
 * @param isCommand - Whether a name is a command the caller can run. With it,
 *   a line break or tab right after such a name ends the name as a space
 *   does, so "/plan" followed by a new line and pasted text runs /plan.
 *   Anything else keeps its old reading: text that only starts with a slash
 *   is still not a command.
 */
export function parseSlashCommand(
  input: string,
  isCommand?: (commandName: string) => boolean,
): ParsedSlashCommand | null {
  const trimmedInput = input.trim()

  // Check if input starts with '/'
  if (!trimmedInput.startsWith('/')) {
    return null
  }

  const withoutSlash = trimmedInput.slice(1)

  // A line break or tab right after a real command's name ends the name
  const firstBreak = withoutSlash.search(/\s/)
  if (
    isCommand &&
    firstBreak > 0 &&
    withoutSlash[firstBreak] !== ' ' &&
    isCommand(withoutSlash.slice(0, firstBreak))
  ) {
    // "\r\n" is one line break.
    const breakLength = withoutSlash.startsWith('\r\n', firstBreak) ? 2 : 1
    return {
      commandName: withoutSlash.slice(0, firstBreak),
      args: withoutSlash.slice(firstBreak + breakLength),
      isMcp: false,
    }
  }

  // Otherwise split by spaces
  const words = withoutSlash.split(' ')

  if (!words[0]) {
    return null
  }

  let commandName = words[0]
  let isMcp = false
  let argsStartIndex = 1

  // Check for MCP commands (second word is '(MCP)')
  if (words.length > 1 && words[1] === '(MCP)') {
    commandName = commandName + ' (MCP)'
    isMcp = true
    argsStartIndex = 2
  }

  // Extract arguments (everything after command name)
  const args = words.slice(argsStartIndex).join(' ')

  return {
    commandName,
    args,
    isMcp,
  }
}
