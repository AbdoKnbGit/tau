/**
 * UTF-16 well-formedness helpers.
 *
 * Slicing a JS string at a UTF-16 index can leave half of an astral character
 * (an emoji, a rare CJK ideograph) behind: a lone surrogate. JSON.stringify
 * escapes it as a bare \udXXX sequence and strict JSON parsers reject that —
 * the Anthropic API answers 400 "no low surrogate in string". Because the bad
 * text then sits in the conversation history, every later request fails the
 * same way until the message is removed.
 *
 * Tool results pass through toWellFormedText once, when they are created, so
 * the frozen history is always well-formed. That decision is made once per
 * result and never revisited, so it is prompt-cache safe on every provider.
 * The cut helpers keep truncation code from splitting pairs in the first
 * place, which avoids replacement characters in the output.
 *
 * Leaf module: no imports, directly unit-testable.
 */

const HIGH_SURROGATE_MIN = 0xd800
const HIGH_SURROGATE_MAX = 0xdbff
const LOW_SURROGATE_MIN = 0xdc00
const LOW_SURROGATE_MAX = 0xdfff
const REPLACEMENT_CHARACTER = String.fromCharCode(0xfffd)

/** ES2024 String methods; typed locally so older TS lib settings compile. */
type WellFormedMethods = {
  isWellFormed?: (this: string) => boolean
  toWellFormed?: (this: string) => string
}

const nativeMethods = String.prototype as unknown as WellFormedMethods

function isHighSurrogate(code: number): boolean {
  return code >= HIGH_SURROGATE_MIN && code <= HIGH_SURROGATE_MAX
}

function isLowSurrogate(code: number): boolean {
  return code >= LOW_SURROGATE_MIN && code <= LOW_SURROGATE_MAX
}

/** True when `text` holds no lone surrogate. */
export function isWellFormedText(text: string): boolean {
  if (typeof nativeMethods.isWellFormed === 'function') {
    return nativeMethods.isWellFormed.call(text)
  }
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (isHighSurrogate(code)) {
      if (i + 1 < text.length && isLowSurrogate(text.charCodeAt(i + 1))) {
        i++
        continue
      }
      return false
    }
    if (isLowSurrogate(code)) return false
  }
  return true
}

/**
 * Replace every lone surrogate with U+FFFD. Returns `text` itself (same
 * string, no copy) when it is already well-formed, which is the common case.
 */
export function toWellFormedText(text: string): string {
  if (isWellFormedText(text)) return text
  if (typeof nativeMethods.toWellFormed === 'function') {
    return nativeMethods.toWellFormed.call(text)
  }
  let out = ''
  let runStart = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (
      isHighSurrogate(code) &&
      i + 1 < text.length &&
      isLowSurrogate(text.charCodeAt(i + 1))
    ) {
      i++
      continue
    }
    if (isHighSurrogate(code) || isLowSurrogate(code)) {
      out += text.slice(runStart, i) + REPLACEMENT_CHARACTER
      runStart = i + 1
    }
  }
  return out + text.slice(runStart)
}

function splitsPair(text: string, index: number): boolean {
  return (
    index > 0 &&
    index < text.length &&
    isHighSurrogate(text.charCodeAt(index - 1)) &&
    isLowSurrogate(text.charCodeAt(index))
  )
}

/**
 * Clamp `index` into `text` and step back one unit if cutting there would
 * split a surrogate pair. `text.slice(0, result)` never ends in half a pair.
 */
export function surrogateSafeEnd(text: string, index: number): number {
  const clamped = Math.max(0, Math.min(Math.floor(index), text.length))
  return splitsPair(text, clamped) ? clamped - 1 : clamped
}

/**
 * Clamp `index` into `text` and step forward one unit if starting there would
 * split a surrogate pair. `text.slice(result)` never starts with half a pair.
 */
export function surrogateSafeStart(text: string, index: number): number {
  const clamped = Math.max(0, Math.min(Math.floor(index), text.length))
  return splitsPair(text, clamped) ? clamped + 1 : clamped
}
