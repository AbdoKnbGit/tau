import { accessSync, constants, statSync } from 'fs'
import { delimiter, isAbsolute, join, resolve } from 'path'

/** Match Node's case-sensitive POSIX and case-insensitive Windows environment. */
function environmentValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  if (process.platform !== 'win32') return env[name]
  const key = Object.keys(env).sort().find(key => key.toUpperCase() === name)
  return key === undefined ? undefined : env[key]
}

/** Native lookup avoids decoding localized `where.exe` output as UTF-8. */
export function executablePaths(command: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const windows = process.platform === 'win32'
  let cwd: string | undefined
  try { cwd = process.cwd() } catch { /* Absolute PATH entries still work after cwd removal. */ }
  const explicit = isAbsolute(command) || command.includes('/') || (windows && command.includes('\\'))
  const directories = explicit ? [''] : [
    ...(windows && cwd ? [cwd] : []),
    ...(environmentValue(env, 'PATH') ?? (windows ? '' : '/usr/bin:/bin')).split(delimiter),
  ]
  const extensions = windows
    ? ['', ...(environmentValue(env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)]
    : ['']
  const paths: string[] = []
  const seen = new Set<string>()
  for (const directory of directories) {
    const entry = windows ? directory.replace(/^"(.*)"$/, '$1') : directory
    const candidate = explicit ? command : join(entry, command)
    if (!cwd && !isAbsolute(candidate)) continue
    const base = resolve(cwd ?? '', candidate)
    for (const extension of extensions) {
      const path = base + extension
      const key = windows ? path.toLowerCase() : path
      if (seen.has(key)) continue
      seen.add(key)
      try {
        if (!statSync(path).isFile()) continue
        if (!windows) accessSync(path, constants.X_OK)
        paths.push(path)
      } catch { /* Missing or inaccessible candidates do not stop PATH lookup. */ }
    }
  }
  return paths
}
