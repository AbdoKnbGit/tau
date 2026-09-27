import * as path from 'path'
import { literalGlob } from '../../utils/searchGlobs.js'

/**
 * The keys a file routes by: its extension, plus its whole name when it is
 * a dotfile (`.bashrc`), both lowercased.
 */
export function getFileLookupKeys(filePath: string): string[] {
  const ext = path.extname(filePath).toLowerCase()
  const baseName = path.basename(filePath).toLowerCase()
  const keys = ext ? [ext] : []

  if (baseName.startsWith('.') && !keys.includes(baseName)) {
    keys.push(baseName)
  }

  return keys
}

/**
 * Name globs covering every file that {@link getFileLookupKeys} routes by
 * these keys (`.ts`, or a dotfile name such as `.bashrc`), ignoring case the
 * same way. A walk filtered by them lists nothing the router would reject.
 */
export function lspFileNameGlobs(keys: Iterable<string>): string[] {
  return [...new Set(keys)].map(key => `*${literalGlob(key, true)}`)
}
