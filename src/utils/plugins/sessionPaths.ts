import { homedir } from 'os'
import { delimiter, isAbsolute, join } from 'path'

/** Relative environment paths are deliberately ignored, unlike explicit CLI paths. */
export function getEnvironmentPluginPaths(): string[] {
  return (process.env.CLAUDE_CODE_PLUGIN_DIRS ?? '')
    .split(delimiter)
    .map((p) =>
      p === '~'
        ? homedir()
        : /^~[\\/]/.test(p)
          ? join(homedir(), p.slice(2))
          : p,
    )
    .filter((p) => isAbsolute(p))
}
