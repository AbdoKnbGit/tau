// The MCP SDK's own copy, so this reads a command the way the SDK is going to start it.
import crossSpawn from 'cross-spawn'

// cmd.exe on Windows 11 build 26300 hangs on a /c line with 50 or more carets, before it starts anything.
// cross-spawn writes one for each quote and metacharacter given to a batch file, and three for a shim in
// node_modules/.bin, so a server launched through one with enough arguments never starts there. Read from a
// variable, the same line does not hang, and cmd.exe parses it the same way. Other builds are not affected.
const MOST_CARETS_CMD_ACCEPTS = 49
const LINE_VARIABLE = 'TAU_STDIO_LINE'

export type StdioLaunch = { command: string; args: string[]; env: Record<string, string> }

/**
 * How to start a stdio server. Everything goes through unchanged, with one exception: on Windows, a line too
 * long for cmd.exe to take directly reaches it through a variable, emptied before the server starts. Nothing
 * about the server changes, only how the line gets to cmd.exe.
 */
export function resolveStdioLaunch(
  command: string,
  args: string[],
  env: Record<string, string>,
): StdioLaunch {
  const requested = { command, args, env }
  if (process.platform !== 'win32') return requested
  try {
    const parsed = crossSpawn._parse(command, args, { env })
    if (!parsed.options.windowsVerbatimArguments) return requested
    const line = parsed.args.at(-1)!
    if (line.split('^').length - 1 <= MOST_CARETS_CMD_ACCEPTS) return requested
    return {
      command: parsed.command,
      args: ['/d', '/s', '/c', 'set', `${LINE_VARIABLE}=&%${LINE_VARIABLE}%`],
      // Without the outer quotes, which cross-spawn adds only for /s to take off again.
      env: { ...env, [LINE_VARIABLE]: line.slice(1, -1) },
    }
  } catch {
    return requested
  }
}
