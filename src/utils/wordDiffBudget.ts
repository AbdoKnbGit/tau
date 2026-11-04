import { diffArrays } from 'diff'

export type WordDiffPart = { value: string; added?: boolean; removed?: boolean }

const MAX_SOURCE_CHARS = 16_384
const MAX_TOKENS = 2_048
const MAX_TOKEN_CELLS = 250_000
const MAX_EDIT_LENGTH = 256

export function tokenizeWordsForDiff(text: string): string[] {
  const tokens: string[] = []
  let i = 0
  while (i < text.length) {
    const ch = text[i]!
    if (/[\p{L}\p{N}_]/u.test(ch)) {
      let j = i + 1
      while (j < text.length && /[\p{L}\p{N}_]/u.test(text[j]!)) j++
      tokens.push(text.slice(i, j))
      i = j
    } else if (/\s/.test(ch)) {
      let j = i + 1
      while (j < text.length && /\s/.test(text[j]!)) j++
      tokens.push(text.slice(i, j))
      i = j
    } else {
      const length = text.codePointAt(i)! > 0xffff ? 2 : 1
      tokens.push(text.slice(i, i + length))
      i += length
    }
  }
  return tokens
}

/** Refine a line pair only while deterministic input/work limits permit it. */
export function boundedWordDiff(oldText: string, newText: string): WordDiffPart[] | null {
  if (oldText === newText) return oldText ? [{ value: oldText }] : []
  if (oldText.length + newText.length > MAX_SOURCE_CHARS) return null

  const oldTokens = tokenizeWordsForDiff(oldText)
  const newTokens = tokenizeWordsForDiff(newText)
  if (oldTokens.length + newTokens.length > MAX_TOKENS ||
      oldTokens.length * newTokens.length > MAX_TOKEN_CELLS) return null

  const changes = diffArrays(oldTokens, newTokens, { maxEditLength: MAX_EDIT_LENGTH })
  return changes?.map(part => ({
    value: part.value.join(''),
    ...(part.added ? { added: true } : {}),
    ...(part.removed ? { removed: true } : {}),
  })) ?? null
}
