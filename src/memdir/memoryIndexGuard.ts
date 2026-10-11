import { feature } from 'bun:bundle'
import { Marked } from 'marked'
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'path'
import { getKairosActive } from '../bootstrap/state.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import { isENOENT } from '../utils/errors.js'
import { getFsImplementation } from '../utils/fsOperations.js'
import { expandPath } from '../utils/path.js'
import { getAutoMemPath, isAutoMemoryEnabled, LEARNED_SUBDIR } from './paths.js'

// A private parser avoids changing (or inheriting) terminal Markdown extensions.
const markdown = new Marked()

function comparableName(name: string): string {
  return process.platform === 'win32' ? name.toLowerCase() : name
}

function hasPointer(index: string, memoryDir: string, filePath: string): boolean {
  let found = false
  markdown.walkTokens(markdown.lexer(index), token => {
    if (found || token.type !== 'link') return
    try {
      // Decode after dropping URL fragments, so an encoded '#' in a filename
      // remains part of the filename. Compare paths, not basename substrings.
      const target = decodeURIComponent(token.href.split(/[?#]/, 1)[0]!)
      if (target && relative(filePath, resolve(memoryDir, target)) === '') {
        found = true
      }
    } catch {
      // A malformed link must not stop checking the remaining index entries.
    }
  })
  return found
}

/**
 * Result-only reminder for a successful auto-memory Write/Edit, including
 * calls through Eval's bridge. Never writes files or changes prompt/schema
 * text. Recheck disk each time: touching an index does not prove it links to
 * this topic, and an already-indexed topic needs no reminder.
 */
export function getMemoryIndexWarning(filePath: string): string | undefined {
  try {
    if (extname(filePath.trim()).toLowerCase() !== '.md') return
    if (!isAutoMemoryEnabled()) return

    const fullPath = expandPath(filePath)
    let memoryDir = getAutoMemPath()
    const topic = relative(memoryDir, fullPath)
    if (
      !topic ||
      isAbsolute(topic) ||
      topic === '..' ||
      topic.startsWith(`..${sep}`)
    ) return
    if (comparableName(basename(fullPath)) === comparableName('MEMORY.md')) return

    const parts = topic.split(sep)
    const first = comparableName(parts[0]!)
    if (first === LEARNED_SUBDIR || first === 'logs') return
    if (getFeatureValue_CACHED_MAY_BE_STALE('tengu_moth_copse', false)) return
    if (feature('KAIROS') && getKairosActive()) return

    if (first === 'team') {
      if (
        !feature('TEAMMEM') ||
        !getFeatureValue_CACHED_MAY_BE_STALE('tengu_herring_clock', false)
      ) return
      memoryDir = join(memoryDir, parts[0]!)
      const child = comparableName(parts[1] ?? '')
      if (child === LEARNED_SUBDIR || child === 'logs') return
    }

    const indexPath = join(memoryDir, 'MEMORY.md')
    let index = ''
    try {
      // Result mapping is synchronous; this read is limited to memory writes.
      // eslint-disable-next-line custom-rules/no-sync-fs
      index = getFsImplementation().readFileSync(indexPath, { encoding: 'utf8' })
    } catch (error) {
      if (!isENOENT(error)) return
    }
    if (hasPointer(index, memoryDir, fullPath)) return

    const indexFromTopic = relative(dirname(fullPath), indexPath).split(sep).join('/')
    return `<system-reminder>Add this memory's missing one-line link to ${JSON.stringify(indexFromTopic)} (relative to this file) before finishing.</system-reminder>`
  } catch {
    // Advisory only: a failed check must never turn a successful save into an error.
    return
  }
}
