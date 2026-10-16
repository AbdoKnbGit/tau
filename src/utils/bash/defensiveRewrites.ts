import { getPlatform } from '../platform.js'
import { rewriteWindowsNullRedirect } from './shellQuoting.js'

type Platform = ReturnType<typeof getPlatform>

/**
 * Defensive byte-level rewrites on bash command strings, applied before the
 * command is quoted into `eval '...'`. Each transform targets a pattern that
 * is broken-as-bash and almost certainly hallucinated from another dialect
 * or pasted with formatting artifacts. Rewrites are pure, OS-independent,
 * and idempotent.
 *
 * Limitation shared with rewriteWindowsNullRedirect: the redirect regexes do
 * not parse shell quoting, so a literal `>nul` or `>$null` inside an echoed
 * string will also be rewritten. Accepted collateral: the broken-as-bash
 * variants are far more common than literal occurrences inside strings.
 *
 * Exception: the typography normalizers (Unicode spaces, smart quotes) ARE
 * quote-aware — they only touch text OUTSIDE ASCII-quoted spans, so an
 * intentional NBSP or curly quote inside `"..."`/`'...'` is preserved. The
 * smart-quote pass additionally reverts itself if the swap would leave an
 * ASCII quote unbalanced, so it can never turn a valid command into a
 * syntax error.
 */

/**
 * Strip control bytes and invisible Unicode that have no purpose in a bash
 * command. Preserves TAB (\x09) and LF (\x0A).
 *
 * CR (\x0D) is the most important target: when a heredoc body contains CRLF
 * line endings, the closing token becomes `EOF\r` and never matches `EOF` —
 * the command hangs forever waiting for an end marker that won't arrive.
 *
 * Invisible Unicode (ZWSP, joiners, bidi marks, BOM, interlinear annotations)
 * sneaks in via copy-paste from chat clients or formatted docs and breaks
 * tokenization without any visible cue in the source.
 *
 * Ranges:
 *   \x00-\x08      C0 control bytes (NUL..BS) excluding TAB
 *   \x0B-\x1F      VT, FF, CR, SO..US — everything between LF and space
 *   \x7F           DEL
 *   ​-‏  zero-width space/joiners + LRM/RLM
 *    -   line/paragraph separators
 *   ‪-‮  bidi format chars (LRE/RLE/PDF/LRO/RLO)
 *   ⁠-⁯  invisible operators + deprecated format chars
 *   ﻿         BOM / zero-width no-break space
 *   ￹-￻  interlinear annotation anchor/separator/terminator
 *
 * Source is kept 100% ASCII via the RegExp constructor with \u escapes so
 * no editor or transport can mangle the literal control/invisible chars.
 */
const COMMAND_GARBAGE_REGEX = new RegExp(
  '[' +
    '\\x00-\\x08' +
    '\\x0b-\\x1f' +
    '\\x7f' +
    '\\u200B-\\u200F' +
    '\\u2028-\\u2029' +
    '\\u202A-\\u202E' +
    '\\u2060-\\u206F' +
    '\\uFEFF' +
    '\\uFFF9-\\uFFFB' +
    ']',
  'g',
)

export function stripCommandGarbage(command: string): string {
  return command.replace(COMMAND_GARBAGE_REGEX, '')
}

/**
 * Walk a command with bash quote-removal semantics and report, for every
 * index, whether that position lies inside an ASCII single- or double-quoted
 * span. Also reports whether the string ENDS while a quote is still open
 * (i.e. an unterminated quote — a syntax error in the eventual `eval`).
 *
 * The quote-delimiter chars themselves are marked in-quote so a normalizer
 * never rewrites a delimiter. Bash rules honored:
 *   - single quotes: everything literal until the next `'` (no escapes)
 *   - double quotes: `\"` and `\\` keep their following char inside the span
 *   - unquoted: `\` escapes the next char (so `\"` is NOT a quote opener)
 *
 * Pure and OS-independent. Used only by the typography normalizers below to
 * gate edits to unquoted regions; it makes no security decision.
 */
function scanAsciiQuotes(command: string): { mask: boolean[]; open: boolean } {
  const mask = new Array<boolean>(command.length).fill(false)
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!
    if (inSingle) {
      mask[i] = true
      if (c === "'") inSingle = false
      continue
    }
    if (inDouble) {
      mask[i] = true
      if (c === '\\' && (command[i + 1] === '"' || command[i + 1] === '\\')) {
        // Escaped " or \ stays inside the double-quoted span — consume both.
        i++
        if (i < command.length) mask[i] = true
        continue
      }
      if (c === '"') inDouble = false
      continue
    }
    // Unquoted context.
    if (c === '\\' && i + 1 < command.length) {
      // Backslash escapes the next char; neither is a quote delimiter.
      i++
      continue
    }
    if (c === "'") {
      inSingle = true
      mask[i] = true
    } else if (c === '"') {
      inDouble = true
      mask[i] = true
    }
  }
  return { mask, open: inSingle || inDouble }
}

/**
 * Unicode horizontal whitespace that bash does NOT treat as a word separator
 * (it splits only on $IFS — space/tab/newline). Pasted from rich text or
 * emitted by some keyboards/LLM tokenizers, an NBSP between two tokens fuses
 * them into one literal word (`echo<NBSP>hi` → command `echo hi` not found).
 *
 * Range excludes the zero-width and bidi chars (​-‏,  - )
 * already removed by stripCommandGarbage, and is built via the RegExp
 * constructor with \u escapes so the source stays 100% ASCII.
 *
 *      NBSP               Ogham space
 *    -   en/em/thin/hair spaces (zero-width ​ is excluded)
 *      narrow NBSP        medium math space    　  ideographic
 */
const UNICODE_SPACE_REGEX = new RegExp(
  '[\\u00A0\\u1680\\u2000-\\u200A\\u202F\\u205F\\u3000]',
)

/**
 * Replace Unicode spaces with a regular space, but ONLY outside ASCII-quoted
 * spans. Outside quotes a Unicode space can only be a (broken) word boundary,
 * so converting it to a real separator restores the obvious intent and can
 * never change quote/paren/brace balance — i.e. it cannot introduce a syntax
 * error. Inside quotes the char may be intentional content, so it is left as
 * is. Idempotent: a second pass finds nothing to change outside quotes.
 */
export function normalizeUnicodeSpacesOutsideQuotes(command: string): string {
  // Fast path: skip the per-char walk for the overwhelming ASCII-only case.
  if (!UNICODE_SPACE_REGEX.test(command)) return command
  const { mask } = scanAsciiQuotes(command)
  let out = ''
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!
    out += !mask[i] && UNICODE_SPACE_REGEX.test(c) ? ' ' : c
  }
  return out
}

// Typographic ("smart"/curly) quotes produced by autocorrect, word
// processors, and chat clients. As bash word characters they are literal,
// so `echo “hi”` prints the curly quotes instead of grouping an argument.
// Built from code points (not literal curly chars) so re-saving this file
// under a different encoding — or a tool that "helpfully" normalizes quotes —
// cannot silently change what we match. Same ASCII-source discipline as
// COMMAND_GARBAGE_REGEX above. U+201C/U+201D = “ ”; U+2018/U+2019 = ‘ ’.
const SMART_DOUBLE_QUOTES = String.fromCharCode(0x201c, 0x201d)
const SMART_SINGLE_QUOTES = String.fromCharCode(0x2018, 0x2019)

/**
 * Replace smart double/single quotes with their ASCII equivalents so they act
 * as real delimiters — but only OUTSIDE existing ASCII-quoted spans, and only
 * when the result stays syntactically balanced. Two safety rails make this
 * incapable of turning a valid command into a broken one:
 *
 *  1. Quote-awareness: a smart quote inside `"..."`/`'...'` is intentional
 *     content (e.g. an apostrophe in `"it’s fine"`) and is left untouched.
 *
 *  2. Balance verification: we build the candidate, then re-scan it; if the
 *     swap left an ASCII quote unterminated (e.g. a lone stray `“`, or smart
 *     quotes that interleave into `"'"'`), we discard the candidate and
 *     return the original. The original passed `bash -n` as literal curly
 *     chars, so reverting preserves its valid (if cosmetically wrong)
 *     behavior rather than risking a fabricated `unexpected EOF`.
 *
 * Per-type even-count gating short-circuits the common unbalanced case early
 * (an odd number of outside-quote smart quotes can't pair up). Pure,
 * OS-independent, idempotent.
 */
export function normalizeSmartQuotesOutsideQuotes(command: string): string {
  // Fast path: nothing to do without at least one smart quote char.
  let hasSmart = false
  for (const ch of SMART_DOUBLE_QUOTES + SMART_SINGLE_QUOTES) {
    if (command.includes(ch)) {
      hasSmart = true
      break
    }
  }
  if (!hasSmart) return command

  const { mask } = scanAsciiQuotes(command)

  // Count outside-quote occurrences per type. An odd count cannot form
  // balanced ASCII pairs, so we skip converting that type entirely.
  let doubles = 0
  let singles = 0
  for (let i = 0; i < command.length; i++) {
    if (mask[i]) continue
    const c = command[i]!
    if (SMART_DOUBLE_QUOTES.includes(c)) doubles++
    else if (SMART_SINGLE_QUOTES.includes(c)) singles++
  }
  const convertDoubles = doubles > 0 && doubles % 2 === 0
  const convertSingles = singles > 0 && singles % 2 === 0
  if (!convertDoubles && !convertSingles) return command

  let candidate = ''
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!
    if (!mask[i] && convertDoubles && SMART_DOUBLE_QUOTES.includes(c)) {
      candidate += '"'
    } else if (!mask[i] && convertSingles && SMART_SINGLE_QUOTES.includes(c)) {
      candidate += "'"
    } else {
      candidate += c
    }
  }

  // Rail #2: never emit a command whose ASCII quotes are left unbalanced.
  return scanAsciiQuotes(candidate).open ? command : candidate
}

/**
 * Rewrite PowerShell-style `$null` redirects to `/dev/null`. Mirrors the
 * existing `>nul` rewrite for the `$null` variable form the model emits
 * when its training surfaces PowerShell idioms inside a bash command.
 *
 * In bash, `$null` is an unset variable that expands to empty, producing
 * an "ambiguous redirect" error. Rewriting only repairs broken-as-bash.
 */
const PS_NULL_REDIRECT_REGEX = /(\d?&?>+\s*)\$null(?=\s|$|[|&;)\n])/gi

export function rewritePowerShellNullRedirect(command: string): string {
  return command.replace(PS_NULL_REDIRECT_REGEX, '$1/dev/null')
}

/**
 * Rewrite redirects to Windows reserved device names (con, prn, aux) to
 * `/dev/null`. Writing to these names on Windows creates undeletable files
 * that break `git add .` and `git clone`, in the same way `nul` does.
 *
 * Same redirect-position regex shape as rewriteWindowsNullRedirect — only
 * fires when the name appears as a redirect target, not as a filename
 * fragment like `con.txt` or `auxiliary.log`.
 */
const RESERVED_REDIRECT_REGEX =
  /(\d?&?>+\s*)(?:con|prn|aux)(?=\s|$|[|&;)\n])/gi

export function rewriteWindowsReservedRedirects(command: string): string {
  return command.replace(RESERVED_REDIRECT_REGEX, '$1/dev/null')
}

const CMD_AUTORUN_SEGMENT_REGEX =
  /(^|(?:;|&&|\|\||\||\n|\()\s*)(cmd(?:\.exe)?)(?=\s+(?:(?:\/[a-z])\s+)*\/[cs]\b)(?![^\n;&|()]*\s\/d\b)/gi

/**
 * Add `cmd.exe /d` when a Bash command explicitly shells out through
 * Windows Command Processor. `/d` disables Command Processor AutoRun hooks
 * (Clink, Visual Studio probes, banners, etc.) so startup noise cannot appear
 * before the command's real output.
 */
export function rewriteWindowsCmdAutoRun(command: string): string {
  return command.replace(
    CMD_AUTORUN_SEGMENT_REGEX,
    (_match: string, prefix: string, executable: string) =>
      `${prefix}${executable} /d`,
  )
}

/**
 * Windows-native CLIs that take `/FLAG`-style arguments and have no MSYS
 * equivalent shadowing them in Git Bash. Deliberately excludes names that a
 * Unix tool or bash builtin shadows in Git Bash (whoami, sort, find, fc,
 * timeout, more) — for those, doubling slashes would not change which
 * program runs.
 */
const WINDOWS_SLASH_FLAG_TOOLS = [
  'tasklist', 'taskkill', 'ipconfig', 'netsh', 'reg', 'sc', 'schtasks',
  'wmic', 'icacls', 'attrib', 'takeown', 'robocopy', 'xcopy', 'findstr',
  'where', 'tree', 'driverquery', 'powercfg', 'certutil', 'wevtutil',
  'dism', 'sfc', 'chkdsk', 'systeminfo',
] as const

const WINDOWS_SLASH_FLAG_HEAD_REGEX = new RegExp(
  `(?:^|[;&|(\\n])[ \\t]*(?:${WINDOWS_SLASH_FLAG_TOOLS.join('|')})(?:\\.exe)?\\b`,
  'i',
)

const WINDOWS_SLASH_FLAG_SEGMENT_REGEX = new RegExp(
  `(^|(?:;|&&|\\|\\||\\||\\n|\\()[ \\t]*)((?:${WINDOWS_SLASH_FLAG_TOOLS.join('|')})(?:\\.exe)?\\b[^;&|\\n]*)`,
  'gi',
)

// A slash-flag token: whitespace, `/`, a flag word, optional `:value`/`=value`.
// `/dev/null`, `/c/Users/...` and other paths contain a second `/` before the
// token ends, so the trailing lookahead rejects them.
const SLASH_FLAG_TOKEN_REGEX = /([ \t])\/([A-Za-z?][A-Za-z0-9]*(?:[:=][^\s]*)?)(?=[ \t]|$)/g

/**
 * Double the slash on `/FLAG` arguments of Windows-native CLIs so Git Bash
 * passes them through intact. The MSYS runtime rewrites arguments that start
 * with `/` into Windows paths when exec'ing a native binary, so
 * `taskkill /PID 123 /F` reaches taskkill as garbage like
 * `taskkill C:/Program Files/Git/PID 123 F:/`. The documented escape is
 * doubling the slash: `//PID` arrives as `/PID`.
 *
 * Quote-aware (a `/text` inside a quoted argument is data, not a flag),
 * heredoc-safe (bails out entirely — bodies may contain `/FLAG` as file
 * content), and idempotent (`//FLAG` no longer matches). Only meaningful
 * under Git Bash, so the composing pipeline gates it to Windows hosts.
 */
export function rewriteWindowsNativeToolSlashFlags(command: string): string {
  if (command.includes('<<')) return command
  if (!WINDOWS_SLASH_FLAG_HEAD_REGEX.test(command)) return command
  const { mask } = scanAsciiQuotes(command)
  return command.replace(
    WINDOWS_SLASH_FLAG_SEGMENT_REGEX,
    (match: string, prefix: string, segment: string, offset: number) => {
      const segmentStart = offset + prefix.length
      const rewritten = segment.replace(
        SLASH_FLAG_TOKEN_REGEX,
        (token: string, ws: string, flag: string, tokenOffset: number) => {
          const slashIndex = segmentStart + tokenOffset + ws.length
          if (mask[slashIndex]) return token
          return `${ws}//${flag}`
        },
      )
      return `${prefix}${rewritten}`
    },
  )
}

export type ShellWord = {
  raw: string
  value: string
  start: number
  end: number
}

export type ShellSegment = {
  start: number
  end: number
}

/**
 * A heredoc operator (`<<`) immediately followed by a delimiter word — quoted
 * (`<<'EOF'` / `<<"EOF"`), escaped (`<<\EOF`), or bare (`<<EOF`). A leading `-`
 * (`<<-EOF`) is allowed. This is the ONLY shape treated as a heredoc opener.
 *
 * Non-global on purpose: `.exec` and `.test` both start from index 0 with no
 * lingering `lastIndex`, so the two call sites (the splitter's per-line `.exec`
 * and `hasHeredocOpener`'s `.test`) can never disagree.
 */
const HEREDOC_OPENER_RE =
  /<<(-)?\s*(?:'([^']+)'|"([^"]+)"|\\([A-Za-z_][A-Za-z0-9_]*)|([A-Za-z_][A-Za-z0-9_]*))/

/**
 * True only for a REAL heredoc opener — not any `<<` substring. The delegating
 * rewrites below gate on this rather than `includes('<<')` so a bare shift
 * operator (`$((1 << 2))`) or trailing content after a closed heredoc does NOT
 * route back through transformOutsideHeredocBodies. That mismatch was a hard
 * infinite recursion: the splitter leaves a non-opener `<<` in the `outside`
 * chunk, the transform sees `includes('<<')` and re-delegates on the exact same
 * string, and the pair ping-pong until the stack blows ("Maximum call stack
 * size exceeded"). Because `outside` is built only from lines the splitter
 * found NO opener on, hasHeredocOpener(outside) is always false there, so the
 * final transform(outside) can never re-enter.
 */
function hasHeredocOpener(command: string): boolean {
  return HEREDOC_OPENER_RE.test(command)
}

function transformOutsideHeredocBodies(
  command: string,
  transform: (chunk: string) => string,
): string {
  if (!hasHeredocOpener(command)) return transform(command)

  const lines = command.match(/[^\n]*\n|[^\n]+$/g) ?? [command]
  let out = ''
  let outside = ''
  let delimiter: string | null = null
  let stripTabs = false

  for (const line of lines) {
    if (delimiter !== null) {
      out += line
      const logicalLine = line.replace(/\n$/, '')
      const candidate = stripTabs ? logicalLine.replace(/^\t+/, '') : logicalLine
      if (candidate === delimiter) {
        delimiter = null
        stripTabs = false
      }
      continue
    }

    const opener = HEREDOC_OPENER_RE.exec(line)
    if (!opener) {
      outside += line
      continue
    }

    const placeholder = `__TAU_HEREDOC_${out.length}_${outside.length}__`
    const maskedLine =
      line.slice(0, opener.index) +
      placeholder +
      line.slice(opener.index + opener[0].length)
    outside += maskedLine
    out += transform(outside).replace(placeholder, opener[0])
    outside = ''
    delimiter =
      opener[2] ?? opener[3] ?? opener[4] ?? opener[5] ?? null
    stripTabs = opener[1] === '-'
  }

  out += transform(outside)
  return out
}

export function scanShellSegments(command: string): ShellSegment[] {
  const segments: ShellSegment[] = []
  let start = 0
  let inSingle = false
  let inDouble = false

  for (let i = 0; i < command.length; i++) {
    const char = command[i]!
    if (inSingle) {
      if (char === "'") inSingle = false
      continue
    }
    if (inDouble) {
      if (char === '\\' && i + 1 < command.length) {
        i++
        continue
      }
      if (char === '"') inDouble = false
      continue
    }
    if (char === '\\' && i + 1 < command.length) {
      i++
      continue
    }
    if (char === "'") {
      inSingle = true
      continue
    }
    if (char === '"') {
      inDouble = true
      continue
    }

    const isDoubleOperator =
      (char === '&' && command[i + 1] === '&') ||
      (char === '|' && command[i + 1] === '|')
    const isSingleOperator =
      char === ';' || char === '|' || char === '&' || char === '\n'
    if (!isDoubleOperator && !isSingleOperator) continue

    segments.push({ start, end: i })
    i += isDoubleOperator ? 1 : 0
    start = i + 1
  }
  segments.push({ start, end: command.length })
  return segments
}

export function tokenizeShellSegment(segment: string): ShellWord[] {
  const words: ShellWord[] = []
  let i = 0
  while (i < segment.length) {
    while (i < segment.length && /\s/.test(segment[i]!)) i++
    if (i >= segment.length) break

    const start = i
    let value = ''
    let inSingle = false
    let inDouble = false
    while (i < segment.length) {
      const char = segment[i]!
      if (inSingle) {
        if (char === "'") {
          inSingle = false
        } else {
          value += char
        }
        i++
        continue
      }
      if (inDouble) {
        if (char === '"') {
          inDouble = false
          i++
          continue
        }
        if (char === '\\' && i + 1 < segment.length) {
          value += segment[i + 1]!
          i += 2
          continue
        }
        value += char
        i++
        continue
      }
      if (/\s/.test(char)) break
      if (char === "'") {
        inSingle = true
        i++
        continue
      }
      if (char === '"') {
        inDouble = true
        i++
        continue
      }
      if (char === '\\' && i + 1 < segment.length) {
        value += segment[i + 1]!
        i += 2
        continue
      }
      value += char
      i++
    }
    words.push({
      raw: segment.slice(start, i),
      value,
      start,
      end: i,
    })
  }
  return words
}

function commandBasename(value: string): string {
  return value.split(/[\\/]/).pop()!.replace(/\.exe$/i, '').toLowerCase()
}

function countUnescaped(value: string, needle: string): number {
  let count = 0
  for (let index = 0; index < value.length; index++) {
    if (value[index] !== needle) continue
    let backslashes = 0
    for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor--) {
      backslashes++
    }
    if (backslashes % 2 === 0) count++
  }
  return count
}

function looksLikeInlineCodeFlag(flag: string): boolean {
  if (/^--[a-z0-9-]*(?:code|eval|evaluate|execute|expression)[a-z0-9-]*$/i.test(flag)) {
    return true
  }
  // Short evaluator switches vary by runtime. Only ambiguous nested-quote
  // payloads reach the rewrite, so treating these common switches uniformly
  // avoids executable-specific tables without touching normal simple patterns.
  return /^-[cepr]$/i.test(flag)
}

function quoteLiteralBashArgument(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function rewriteAmbiguousInlineWord(raw: string): string | null {
  if (raw.length < 2 || raw[0] !== '"' || raw.at(-1) !== '"') return null
  if (countUnescaped(raw, '"') <= 2) return null

  // The first/last quotes are the intended shell delimiters. Any additional
  // unescaped double quotes are code/data delimiters that Bash would otherwise
  // remove by repeatedly closing and reopening the outer string.
  return quoteLiteralBashArgument(raw.slice(1, -1))
}

function findLastUnescapedDoubleQuote(value: string): number {
  for (let index = value.length - 1; index > 0; index--) {
    if (value[index] !== '"') continue
    let backslashes = 0
    for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor--) {
      backslashes++
    }
    if (backslashes % 2 === 0) return index
  }
  return -1
}

/**
 * Repair the common "inline program inside double quotes contains its own
 * double quotes" failure across evaluator CLIs.
 *
 * Example:
 *   tool --eval "fn({_id:"value"})"
 *
 * Bash accepts this syntax but removes the inner quotes before the evaluator
 * sees it. Re-rendering the complete payload as one single-quoted Bash argument
 * preserves the intended code bytes. Clean escaped or single-quoted payloads
 * remain untouched. If Bash's tokenization split a malformed outer
 * double-quoted payload into several words, the rewrite rejoins the complete
 * quoted span instead of rejecting the command.
 */
export function rewriteAmbiguousInlineCodeQuoting(command: string): string {
  if (hasHeredocOpener(command)) {
    return transformOutsideHeredocBodies(
      command,
      rewriteAmbiguousInlineCodeQuoting,
    )
  }
  if (command.includes('$(') || command.includes('`')) {
    return command
  }

  const replacements: Array<{ start: number; end: number; text: string }> = []
  for (const segment of scanShellSegments(command)) {
    const text = command.slice(segment.start, segment.end)
    const words = tokenizeShellSegment(text)
    const executableIndex = findWrappedExecutable(words)

    for (let index = executableIndex + 1; index < words.length; index++) {
      const word = words[index]!
      const equals = word.value.indexOf('=')
      const flag = equals === -1 ? word.value : word.value.slice(0, equals)
      if (!looksLikeInlineCodeFlag(flag)) continue

      if (equals !== -1) {
        const rawEquals = word.raw.indexOf('=')
        if (rawEquals === -1) continue
        // A complete quoted argument has no broken inline quotes to repair.
        // Do not absorb a later argument (e.g. --eval="code" "input file").
        if (/^"(?:\\.|[^"\\])*"$/.test(word.raw.slice(rawEquals + 1))) continue
        const rawStart = word.start + rawEquals + 1
        const rawTail = text.slice(rawStart)
        const close = rawTail.startsWith('"')
          ? findLastUnescapedDoubleQuote(rawTail)
          : -1
        const rawValue =
          close > 0 ? rawTail.slice(0, close + 1) : word.raw.slice(rawEquals + 1)
        const rewritten = rewriteAmbiguousInlineWord(rawValue)
        if (rewritten) {
          replacements.push({
            start: segment.start + word.start,
            end:
              close > 0
                ? segment.start + rawStart + close + 1
                : segment.start + word.end,
            text: `${word.raw.slice(0, rawEquals + 1)}${rewritten}`,
          })
        }
        continue
      }

      const argument = words[index + 1]
      if (!argument) continue
      // Short flags also belong to ordinary commands such as mkdir -p.
      if (/^"(?:\\.|[^"\\])*"$/.test(argument.raw)) {
        index++
        continue
      }
      const rawTail = text.slice(argument.start)
      const close = rawTail.startsWith('"')
        ? findLastUnescapedDoubleQuote(rawTail)
        : -1
      const rawArgument =
        close > 0 ? rawTail.slice(0, close + 1) : argument.raw
      const rewritten = rewriteAmbiguousInlineWord(rawArgument)
      if (rewritten) {
        replacements.push({
          start: segment.start + argument.start,
          end:
            close > 0
              ? segment.start + argument.start + close + 1
              : segment.start + argument.end,
          text: rewritten,
        })
      }
      index++
    }
  }

  let out = command
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
    out =
      out.slice(0, replacement.start) +
      replacement.text +
      out.slice(replacement.end)
  }
  return out
}

function looksLikePathValue(value: string): boolean {
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) return false
  return (
    /^~?(?:[./\\]|[A-Za-z]:[\\/])/.test(value) ||
    value.includes('/') ||
    value.includes('\\')
  )
}

/**
 * Prefer the broadly portable `--option value` form for static path-bearing
 * long options. Some CLIs accept both spellings while others parse
 * `--file=/path` differently from `--file /path`. Non-path options and dynamic
 * values are left untouched.
 */
export function rewritePortablePathOptionSpacing(command: string): string {
  if (hasHeredocOpener(command)) {
    return transformOutsideHeredocBodies(
      command,
      rewritePortablePathOptionSpacing,
    )
  }
  const replacements: Array<{ start: number; end: number; text: string }> = []

  for (const segment of scanShellSegments(command)) {
    const text = command.slice(segment.start, segment.end)
    for (const word of tokenizeShellSegment(text)) {
      const equals = word.value.indexOf('=')
      if (equals <= 0) continue
      const name = word.value.slice(0, equals)
      const value = word.value.slice(equals + 1)
      if (
        !/^--[A-Za-z][A-Za-z0-9-]*$/.test(name) ||
        !value ||
        value.includes('$') ||
        value.includes('`') ||
        !looksLikePathValue(value)
      ) {
        continue
      }

      const rawEquals = word.raw.indexOf('=')
      if (rawEquals <= 0) continue
      replacements.push({
        start: segment.start + word.start,
        end: segment.start + word.end,
        text: `${word.raw.slice(0, rawEquals)} ${word.raw.slice(rawEquals + 1)}`,
      })
    }
  }

  let out = command
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
    out =
      out.slice(0, replacement.start) +
      replacement.text +
      out.slice(replacement.end)
  }
  return out
}

function isShellAssignment(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(value)
}

function findWrappedExecutable(words: ShellWord[]): number {
  let index = 0
  while (index < words.length && isShellAssignment(words[index]!.value)) index++

  for (let depth = 0; depth < 4 && index < words.length; depth++) {
    const base = commandBasename(words[index]!.value)
    if (base === 'command' || base === 'builtin' || base === 'winpty') {
      index++
      while (words[index]?.value.startsWith('-')) index++
      continue
    }
    if (base === 'env') {
      index++
      while (
        index < words.length &&
        (words[index]!.value.startsWith('-') ||
          isShellAssignment(words[index]!.value))
      ) {
        index++
      }
      continue
    }
    break
  }
  return index
}

function isStaticRemotePosixArgument(value: string): boolean {
  if (
    !value ||
    value.includes('\0') ||
    value.includes('\n') ||
    value.includes(';') ||
    value.includes('$') ||
    value.includes('`')
  ) {
    return false
  }
  if (/^[A-Za-z]:[\\/]/.test(value)) return false
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) return false
  if (/^\/(?:[^/]|$)/.test(value) || /^\/\/[^/]/.test(value)) return true
  if (/(?:^|=)\/(?:[^/]|$)/.test(value)) return true
  // Remote copy specs: container:/path, user@host:/path, pod:/path.
  return isRemoteCopySpec(value)
}

function isRemoteCopySpec(value: string): boolean {
  if (/^[A-Za-z]:[\\/]/.test(value)) return false
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) return false
  return (
    /^[^/\\:\s][^:\s]*:\/(?!\/)/.test(value) ||
    /^(?:[^@\s]+@)?\[[^\]]+\]:\/(?!\/)/.test(value)
  )
}

function collectRemoteArgument(
  exclusions: Set<string>,
  word: ShellWord | undefined,
): void {
  if (word && isStaticRemotePosixArgument(word.value)) {
    exclusions.add(word.value)
  }
}

const EXEC_VALUE_OPTIONS = new Set([
  '-e', '--env',
  '--env-file',
  '--detach-keys',
  '-u', '--user',
  '-w', '--workdir',
])

const EXEC_REMOTE_PATH_OPTIONS = new Set(['-w', '--workdir'])

const RUN_VALUE_OPTIONS = new Set([
  '-a', '--attach',
  '--add-host',
  '--annotation',
  '--blkio-weight',
  '--cap-add',
  '--cap-drop',
  '--cgroup-parent',
  '--cidfile',
  '--cpu-period',
  '--cpu-quota',
  '--cpu-rt-period',
  '--cpu-rt-runtime',
  '--cpu-shares',
  '--cpus',
  '--cpuset-cpus',
  '--cpuset-mems',
  '--device',
  '--device-cgroup-rule',
  '--device-read-bps',
  '--device-read-iops',
  '--device-write-bps',
  '--device-write-iops',
  '--dns',
  '--dns-option',
  '--dns-search',
  '-e', '--env',
  '--env-file',
  '--entrypoint',
  '--expose',
  '--gpus',
  '--group-add',
  '-h', '--hostname',
  '--ip',
  '--ip6',
  '--ipc',
  '--isolation',
  '-l', '--label',
  '--label-file',
  '--link',
  '--link-local-ip',
  '--log-driver',
  '--log-opt',
  '--mac-address',
  '-m', '--memory',
  '--memory-reservation',
  '--memory-swap',
  '--memory-swappiness',
  '--mount',
  '--name',
  '--network',
  '--network-alias',
  '--oom-score-adj',
  '--pid',
  '--platform',
  '-p', '--publish',
  '--pull',
  '--restart',
  '--runtime',
  '--security-opt',
  '--shm-size',
  '--stop-signal',
  '--stop-timeout',
  '--storage-opt',
  '--sysctl',
  '--tmpfs',
  '-u', '--user',
  '--ulimit',
  '-v', '--volume',
  '--volume-driver',
  '--volumes-from',
  '-w', '--workdir',
])

const RUN_REMOTE_PATH_OPTIONS = new Set([
  '--entrypoint',
  '-w',
  '--workdir',
])

function optionName(value: string): string {
  const equals = value.indexOf('=')
  return equals === -1 ? value : value.slice(0, equals)
}

function collectInlineRemoteOption(
  exclusions: Set<string>,
  word: ShellWord,
  remotePathOptions: Set<string>,
): void {
  const name = optionName(word.value)
  if (name !== word.value && remotePathOptions.has(name)) {
    collectRemoteArgument(exclusions, word)
  }
}

function findPositionalAfterOptions(
  words: ShellWord[],
  start: number,
  valueOptions: Set<string>,
  remotePathOptions: Set<string>,
  exclusions: Set<string>,
): number | null {
  for (let index = start; index < words.length; index++) {
    const word = words[index]!
    const value = word.value
    if (value === '--') return index + 1 < words.length ? index + 1 : null
    if (!value.startsWith('-') || value === '-') return index

    const name = optionName(value)
    collectInlineRemoteOption(exclusions, word, remotePathOptions)
    if (name === value && valueOptions.has(name)) {
      if (remotePathOptions.has(name)) {
        collectRemoteArgument(exclusions, words[index + 1])
      }
      index++
    }
  }
  return null
}

function collectAfter(
  exclusions: Set<string>,
  words: ShellWord[],
  start: number,
): void {
  for (let index = start; index < words.length; index++) {
    collectRemoteArgument(exclusions, words[index])
  }
}

function collectRemoteSpecs(
  exclusions: Set<string>,
  words: ShellWord[],
  start: number,
): void {
  for (let index = start; index < words.length; index++) {
    const word = words[index]!
    if (isRemoteCopySpec(word.value)) {
      collectRemoteArgument(exclusions, word)
    }
  }
}

function findWord(
  words: ShellWord[],
  value: string,
  start: number,
): number {
  for (let index = start; index < words.length; index++) {
    if (words[index]!.value.toLowerCase() === value) return index
  }
  return -1
}

function collectContainerBoundaryExclusions(
  exclusions: Set<string>,
  words: ShellWord[],
  executableIndex: number,
  executable: string,
): void {
  const composeIndex =
    executable === 'docker-compose'
      ? executableIndex
      : findWord(words, 'compose', executableIndex + 1)
  const searchStart =
    composeIndex >= executableIndex ? composeIndex + 1 : executableIndex + 1
  const execIndex = findWord(words, 'exec', searchStart)
  if (execIndex !== -1) {
    const targetIndex = findPositionalAfterOptions(
      words,
      execIndex + 1,
      EXEC_VALUE_OPTIONS,
      EXEC_REMOTE_PATH_OPTIONS,
      exclusions,
    )
    if (targetIndex !== null) collectAfter(exclusions, words, targetIndex + 1)
    return
  }

  const runIndex = findWord(words, 'run', searchStart)
  if (runIndex !== -1) {
    const imageOrServiceIndex = findPositionalAfterOptions(
      words,
      runIndex + 1,
      RUN_VALUE_OPTIONS,
      RUN_REMOTE_PATH_OPTIONS,
      exclusions,
    )
    if (imageOrServiceIndex !== null) {
      collectAfter(exclusions, words, imageOrServiceIndex + 1)
    }
    return
  }

  const cpIndex = findWord(words, 'cp', searchStart)
  if (cpIndex !== -1) {
    collectRemoteSpecs(exclusions, words, cpIndex + 1)
  }
}

const SSH_VALUE_OPTIONS = new Set([
  '-B', '-b', '-c', '-D', '-E', '-e', '-F', '-I', '-i', '-J', '-L', '-l',
  '-m', '-O', '-o', '-p', '-Q', '-R', '-S', '-W', '-w',
])

function findSshDestination(words: ShellWord[], start: number): number | null {
  for (let index = start; index < words.length; index++) {
    const value = words[index]!.value
    if (value === '--') return index + 1 < words.length ? index + 1 : null
    if (!value.startsWith('-') || value === '-') return index
    const shortName = value.slice(0, 2)
    if (value.length === 2 && SSH_VALUE_OPTIONS.has(shortName)) index++
  }
  return null
}

function collectRemotePathExclusions(
  words: ShellWord[],
): Set<string> {
  const exclusions = new Set<string>()
  const executableIndex = findWrappedExecutable(words)
  const executableWord = words[executableIndex]
  if (!executableWord) return exclusions
  const executable = commandBasename(executableWord.value)

  // Endpoint-qualified paths (`target:/path`, `user@host:/path`) are remote by
  // syntax, independent of the transport executable that happens to carry
  // them. Protect these first so new copy/sync clients work without a tool row.
  collectRemoteSpecs(exclusions, words, executableIndex + 1)

  if (
    executable === 'docker' ||
    executable === 'docker-compose' ||
    executable === 'podman' ||
    executable === 'nerdctl'
  ) {
    collectContainerBoundaryExclusions(
      exclusions,
      words,
      executableIndex,
      executable,
    )
    return exclusions
  }

  if (executable === 'kubectl' || executable === 'oc') {
    const execIndex = findWord(words, 'exec', executableIndex + 1)
    if (execIndex !== -1) {
      const separatorIndex = findWord(words, '--', execIndex + 1)
      if (separatorIndex !== -1) {
        collectAfter(exclusions, words, separatorIndex + 1)
      } else {
        const podIndex = findPositionalAfterOptions(
          words,
          execIndex + 1,
          new Set(['-c', '--container', '-n', '--namespace']),
          new Set(),
          exclusions,
        )
        if (podIndex !== null) collectAfter(exclusions, words, podIndex + 1)
      }
      return exclusions
    }
    const cpIndex = findWord(words, 'cp', executableIndex + 1)
    if (cpIndex !== -1) {
      collectRemoteSpecs(exclusions, words, cpIndex + 1)
    }
    return exclusions
  }

  if (executable === 'ssh') {
    const destinationIndex = findSshDestination(words, executableIndex + 1)
    if (destinationIndex !== null) {
      collectAfter(exclusions, words, destinationIndex + 1)
    }
    return exclusions
  }

  if (
    executable === 'scp' ||
    executable === 'sftp' ||
    executable === 'rsync'
  ) {
    collectRemoteSpecs(exclusions, words, executableIndex + 1)
    return exclusions
  }

  if (executable === 'wsl') {
    for (let index = executableIndex + 1; index < words.length; index++) {
      const name = optionName(words[index]!.value)
      if (name !== '--cd') continue
      if (name === words[index]!.value) {
        collectRemoteArgument(exclusions, words[index + 1])
        index++
      } else {
        collectInlineRemoteOption(
          exclusions,
          words[index]!,
          new Set(['--cd']),
        )
      }
    }

    const separatorIndex = findWord(words, '--', executableIndex + 1)
    if (separatorIndex !== -1) {
      collectAfter(exclusions, words, separatorIndex + 1)
      return exclusions
    }

    const managementOptions = new Set([
      '--export', '--import', '--import-in-place', '--install', '--list',
      '--mount', '--set-default', '--set-default-version', '--set-version',
      '--shutdown', '--status', '--terminate', '--unmount', '--unregister',
      '--update',
    ])
    if (
      words
        .slice(executableIndex + 1)
        .some(word => managementOptions.has(optionName(word.value)))
    ) {
      return exclusions
    }

    for (let index = executableIndex + 1; index < words.length; index++) {
      const name = optionName(words[index]!.value)
      if (name === '--cd') {
        if (name === words[index]!.value) index++
        continue
      }
      if (
        (name === '-d' ||
          name === '--distribution' ||
          name === '-u' ||
          name === '--user') &&
        name === words[index]!.value
      ) {
        index++
        continue
      }
      if (!words[index]!.value.startsWith('-')) {
        collectAfter(exclusions, words, index)
        break
      }
    }
    return exclusions
  }

  if (executable === 'adb') {
    const shellIndex = findWord(words, 'shell', executableIndex + 1)
    if (shellIndex !== -1) {
      collectAfter(exclusions, words, shellIndex + 1)
      return exclusions
    }
    const pushIndex = findWord(words, 'push', executableIndex + 1)
    if (pushIndex !== -1) {
      collectRemoteArgument(exclusions, words.at(-1))
      return exclusions
    }
    const pullIndex = findWord(words, 'pull', executableIndex + 1)
    if (pullIndex !== -1) {
      collectRemoteArgument(exclusions, words[pullIndex + 1])
    }
    return exclusions
  }

  function collectHadoopFsArguments(markerIndex: number): void {
    const operationIndex = markerIndex + 1
    const operation = words[operationIndex]?.value.toLowerCase()
    const args = words.slice(operationIndex + 1)
    const positional = args.filter(word => !word.value.startsWith('-'))
    if (
      operation === '-put' ||
      operation === '-copyfromlocal' ||
      operation === '-movefromlocal' ||
      operation === '-appendtofile'
    ) {
      collectRemoteArgument(exclusions, positional.at(-1))
      return
    }
    if (operation === '-get' || operation === '-copytolocal') {
      collectRemoteArgument(exclusions, positional[0])
      return
    }
    if (operation === '-getmerge') {
      for (const word of positional.slice(0, -1)) {
        collectRemoteArgument(exclusions, word)
      }
      return
    }
    collectAfter(exclusions, words, operationIndex + 1)
  }

  if (executable === 'hadoop') {
    const fsIndex = findWord(words, 'fs', executableIndex + 1)
    if (fsIndex !== -1) collectHadoopFsArguments(fsIndex)
    return exclusions
  }

  if (executable === 'hdfs') {
    const dfsIndex = findWord(words, 'dfs', executableIndex + 1)
    if (dfsIndex !== -1) collectHadoopFsArguments(dfsIndex)
    return exclusions
  }

  // Generic process-boundary topology. Many clients use:
  //   transport exec TARGET COMMAND /foreign/path
  //   transport run  IMAGE  COMMAND /foreign/path
  //   transport shell TARGET COMMAND /foreign/path
  // This fallback is intentionally based on argv shape, not executable name.
  for (const boundaryVerb of ['exec', 'run', 'shell']) {
    const boundaryIndex = findWord(words, boundaryVerb, executableIndex + 1)
    if (boundaryIndex === -1) continue
    const separatorIndex = findWord(words, '--', boundaryIndex + 1)
    if (separatorIndex !== -1) {
      collectAfter(exclusions, words, separatorIndex + 1)
      return exclusions
    }
    const targetIndex = words.findIndex(
      (word, index) =>
        index > boundaryIndex &&
        (!word.value.startsWith('-') || word.value === '-'),
    )
    if (targetIndex !== -1) {
      collectAfter(exclusions, words, targetIndex + 1)
    }
    return exclusions
  }

  // Filesystem-style CLIs conventionally expose `fs`/`dfs` followed by an
  // operation and path arguments. This catches equivalent clients without
  // depending on a product executable name.
  const fsMarker = ['fs', 'dfs']
    .map(marker => findWord(words, marker, executableIndex + 1))
    .filter(index => index !== -1)
    .sort((a, b) => a - b)[0]
  if (fsMarker !== undefined) {
    collectHadoopFsArguments(fsMarker)
  }
  return exclusions
}

function singleQuoteAssignmentValue(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * Stop Git Bash/MSYS from greedily converting remote POSIX paths into Windows
 * paths before a native boundary client receives them.
 *
 * Example:
 *   docker exec namenode hadoop fs -cat /bigdata/hello.txt
 *
 * Without an exclusion, MSYS may pass a C:/... spelling and Hadoop reports
 * `No FileSystem for scheme "C"`. The narrow per-argument assignment below:
 *
 *   MSYS2_ARG_CONV_EXCL='/bigdata/hello.txt' docker exec ...
 *
 * protects only the remote path. Legitimate host paths elsewhere in the same
 * command (`/c/Users/...`, bind mounts, kubeconfig files, SSH identity files)
 * keep their normal conversion. Each compound/pipeline segment is handled
 * independently. Heredocs and nested command substitutions are left untouched
 * because rewriting their shell grammar would be less safe than preserving it.
 */
export function rewriteWindowsRemotePosixPaths(command: string): string {
  if (hasHeredocOpener(command)) {
    return transformOutsideHeredocBodies(
      command,
      rewriteWindowsRemotePosixPaths,
    )
  }
  if (command.includes('$(') || command.includes('`') || !command.includes('/')) {
    return command
  }

  const insertions: Array<{ index: number; text: string }> = []
  for (const segment of scanShellSegments(command)) {
    const text = command.slice(segment.start, segment.end)
    if (
      /\bMSYS(?:2_ARG_CONV_EXCL|_NO_PATHCONV)=/.test(text)
    ) {
      continue
    }
    const words = tokenizeShellSegment(text)
    const exclusions = collectRemotePathExclusions(words)
    if (exclusions.size === 0) continue

    const firstWord = words[0]
    if (!firstWord) continue
    const value = [...exclusions].join(';')
    insertions.push({
      index: segment.start + firstWord.start,
      text: `MSYS2_ARG_CONV_EXCL=${singleQuoteAssignmentValue(value)} `,
    })
  }

  let out = command
  for (const insertion of insertions.sort((a, b) => b.index - a.index)) {
    out =
      out.slice(0, insertion.index) +
      insertion.text +
      out.slice(insertion.index)
  }
  return out
}

const UNSAFE_NODE_TASKKILL_SEGMENT_REGEX =
  /(^|(?:;|&&|\|\||\n)[ \t]*)([ \t]*taskkill(?:\.exe)?\b(?:(?!(?:;|&&|\|\||\n)).)*)/gi

const TASKKILL_NODE_IMAGE_REGEX =
  /(?:^|\s)(?:\/{1,2}|-)(?:im|imagename)(?:\s+|=)(?:"node\.exe"|'node\.exe'|node\.exe)(?=\s|$)/i

const BLOCKED_NODE_TASKKILL_COMMAND =
  "(printf '%s\\n' 'Blocked unsafe taskkill /IM node.exe; stop the specific dev server PID or port instead.' >&2 && false)"

/**
 * Block broad Windows process kills that target every `node.exe` by image
 * name. On Windows the CLI itself, MCP helpers, frontend dev servers, and
 * package scripts commonly all run as node.exe, so `taskkill /IM node.exe /F`
 * can terminate the active session instead of only cleaning up a project
 * server. PID-scoped taskkill commands are intentionally left alone.
 */
export function rewriteUnsafeGlobalNodeTaskkill(command: string): string {
  return command.replace(
    UNSAFE_NODE_TASKKILL_SEGMENT_REGEX,
    (match: string, prefix: string, segment: string) => {
      if (!TASKKILL_NODE_IMAGE_REGEX.test(segment)) return match
      return `${prefix}${BLOCKED_NODE_TASKKILL_COMMAND}`
    },
  )
}

// A scheme-prefixed URL whose query string may carry an unquoted `&` separator
// (`?a=1&b=2`). `&(?!&)` lets a single `&` extend the token but stops before a
// real `&&` operator; the char class stops at whitespace/quotes so trailing
// shell syntax is never swallowed.
const URL_WITH_AMP_REGEX = /\bhttps?:\/\/(?:[^\s'"&]|&(?!&))+/g

/**
 * Single-quote a URL that carries an unquoted `&` query separator so bash does
 * not read it as a background operator. `curl http://x?a=1&b=2` otherwise runs
 * `curl http://x?a=1` in the BACKGROUND and `b=2` as a second command — the
 * classic detached-process footgun for a URL the model meant as one argument.
 *
 * Quote-aware (an already-quoted URL is left alone), heredoc-safe, and
 * idempotent. A genuine trailing background `&` (after whitespace) is NOT part
 * of the URL token, so it is preserved and still correctly flagged by the
 * detach validator.
 */
export function rewriteUnquotedUrlAmpersand(command: string): string {
  if (hasHeredocOpener(command)) {
    return transformOutsideHeredocBodies(command, rewriteUnquotedUrlAmpersand)
  }
  if (!command.includes('&') || !/https?:\/\//.test(command)) {
    return command
  }
  const { mask } = scanAsciiQuotes(command)
  return command.replace(URL_WITH_AMP_REGEX, (match: string, offset: number) => {
    if (!match.includes('&')) return match // no query separator → nothing to fix
    if (mask[offset]) return match // already inside an ASCII-quoted span
    return `'${match}'`
  })
}

const PIPED_DOCKER_EXEC_REGEX =
  /\|([ \t]*(?:docker|podman|nerdctl)(?:\.exe)?[ \t]+exec)\b/gi

/**
 * Preserve stdin when a pipeline feeds `docker exec`.
 *
 * Docker does not attach the exec process's stdin unless `-i`/`--interactive`
 * is present, so `printf ... | docker exec container command` silently gives
 * the container command EOF. Adding `-i` is semantics-preserving here because
 * the command is already the direct consumer of a real pipeline.
 *
 * The rewrite only recognizes an unquoted pipeline whose right-hand command
 * starts with `docker exec`. It ignores heredocs, `||`, quoted text, nested
 * shell text, and commands where an interactive flag is already the first
 * Docker option. The inserted `-i` becomes the first option, making the rewrite
 * idempotent.
 */
export function rewritePipedDockerExecStdin(command: string): string {
  if (hasHeredocOpener(command)) {
    return transformOutsideHeredocBodies(command, rewritePipedDockerExecStdin)
  }
  if (
    !command.includes('|') ||
    !/\b(?:docker|podman|nerdctl)(?:\.exe)?[ \t]+exec\b/i.test(command)
  ) {
    return command
  }
  const { mask } = scanAsciiQuotes(command)
  return command.replace(
    PIPED_DOCKER_EXEC_REGEX,
    (match: string, invocation: string, offset: number) => {
      if (mask[offset]) return match
      // This is the second `|` in `||`, not a pipeline.
      if (offset > 0 && command[offset - 1] === '|') return match

      const afterInvocation = command.slice(offset + match.length)
      const firstOption = /^[ \t]+(\S+)/.exec(afterInvocation)?.[1]
      if (
        firstOption === '--interactive' ||
        firstOption === '--interactive=true' ||
        (firstOption?.startsWith('-') &&
          !firstOption.startsWith('--') &&
          firstOption.slice(1).includes('i'))
      ) {
        return match
      }
      return `|${invocation} -i`
    },
  )
}

/**
 * Compose every defensive rewrite into a single entry point. Order matters:
 * garbage-strip first (so subsequent passes see clean text with zero-width
 * and control bytes already gone), then the quote-aware typography
 * normalizers (which depend on accurate ASCII-quote scanning), then the
 * dialect/redirect rewrites.
 *
 * All rewrites are OS-independent except the native slash-flag pass, which
 * only applies on Windows hosts: on Linux/macOS a `/F` argument is a real
 * path (e.g. `tree /F` lists the /F directory) and must not be touched —
 * there the native Unix tools run untouched, exactly as written.
 */
export function applyBashDefensiveRewrites(
  command: string,
  platform: Platform = getPlatform(),
): string {
  let out = command
  out = stripCommandGarbage(out)
  out = normalizeUnicodeSpacesOutsideQuotes(out)
  out = normalizeSmartQuotesOutsideQuotes(out)
  out = rewriteAmbiguousInlineCodeQuoting(out)
  out = rewritePortablePathOptionSpacing(out)
  out = rewriteUnquotedUrlAmpersand(out)
  out = rewritePipedDockerExecStdin(out)
  out = rewriteWindowsNullRedirect(out)
  out = rewritePowerShellNullRedirect(out)
  out = rewriteWindowsReservedRedirects(out)
  out = rewriteWindowsCmdAutoRun(out)
  if (platform === 'windows') {
    out = rewriteWindowsRemotePosixPaths(out)
    out = rewriteWindowsNativeToolSlashFlags(out)
  }
  out = rewriteUnsafeGlobalNodeTaskkill(out)
  return out
}
