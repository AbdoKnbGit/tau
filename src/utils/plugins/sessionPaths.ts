import { homedir } from 'os'
import { delimiter, isAbsolute, join } from 'path'

let sessionPluginUrls: string[] = []

export function setSessionPluginUrls(urls: string[]): void {
  sessionPluginUrls = [
    ...new Set(urls.flatMap(url => url.trim().split(/\s+/)).filter(Boolean)),
  ]
}

export function getSessionPluginUrls(): string[] {
  return sessionPluginUrls
}

/** Relative environment paths are deliberately ignored, unlike explicit CLI paths. */
export function getEnvironmentPluginPaths(): string[] {
  return (process.env.CLAUDE_CODE_PLUGIN_DIRS ?? '')
    .split(delimiter)
    .map(p =>
      p === '~'
        ? homedir()
        : /^~[\\/]/.test(p)
          ? join(homedir(), p.slice(2))
          : p,
    )
    .filter(p => isAbsolute(p))
}
