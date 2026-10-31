// The MCP SDK's own copy, so this reads a command the way the SDK is going to start it.
import crossSpawn from 'cross-spawn'
import { existsSync, readFileSync } from 'fs'
import { dirname, join } from 'path'

// cmd.exe on Windows 11 build 26300 hangs on a /c line with 50 or more carets, before it starts anything.
// cross-spawn writes three for each quote and metacharacter given to a node_modules/.bin shim, so a server
// launched through one with about 8 arguments never starts there. Other builds are not affected.
const MOST_CARETS_CMD_ACCEPTS = 49

export type StdioLaunch = { command: string; args: string[] }

/** What an npm-style .cmd shim ends up running, or null when this is some other batch file. */
export function readNpmShim(shimPath: string, source: string): StdioLaunch | null {
  const line = /"%_prog%"\s+(.*?)\s*%\*\s*$/im.exec(source)
  if (!line) return null
  const expand = (text: string) => text.replace(/%dp0%\\?/gi, () => join(dirname(shimPath), '/'))
  const fixedArgs = [...line[1]!.matchAll(/"([^"]*)"|(\S+)/g)].map(match => expand(match[1] ?? match[2]!))
  // Anything cmd.exe would still have to expand or interpret means this is not the plain shape.
  if (fixedArgs.some(arg => /[%^&|<>]/.test(arg))) return null
  // npm's shim prefers a node.exe beside it, then whichever is on PATH.
  const programs = [...source.matchAll(/set\s+"_prog=([^"]*)"/gi)].map(match => expand(match[1]!))
  const command = programs.find(program => !/[\\/]/.test(program) || existsSync(program))
  return command ? { command, args: fixedArgs } : null
}

/**
 * The program to start for a stdio server. Everything goes through unchanged, with one exception: on
 * Windows, a line too long for cmd.exe to take, when the shim only runs one program that can be started
 * without cmd.exe at all. Nothing about the server changes, only how it is reached.
 */
export function resolveStdioLaunch(
  command: string,
  args: string[],
  env: Record<string, string>,
): StdioLaunch {
  const requested = { command, args }
  if (process.platform !== 'win32') return requested
  try {
    const parsed = crossSpawn._parse(command, args, { env })
    if (!parsed.options.windowsVerbatimArguments || !parsed.file) return requested
    const carets = parsed.args.join(' ').split('^').length - 1
    if (carets <= MOST_CARETS_CMD_ACCEPTS) return requested
    const shim = readNpmShim(parsed.file, readFileSync(parsed.file, 'utf8'))
    return shim ? { command: shim.command, args: [...shim.args, ...args] } : requested
  } catch {
    return requested
  }
}
