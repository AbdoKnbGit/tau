// Speaks completed assistant text aloud while hey-mode is enabled.
//
// We watch isLoading transition from true → false (turn finished) and grab
// the latest assistant message at that moment. Text blocks are
// concatenated, tool-use blocks are silently dropped (announcing every
// tool name out loud is noisy and doesn't help conversation flow), and
// the result is sent to ttsLocal.speak. Subsequent identical messages are
// skipped via uuid tracking — without this, edits/retries that re-fire
// turn-complete would re-speak the same response.
//
// Toggle off mid-speech is honored: stopSpeaking() interrupts the active
// TTS process so disabling /hey does not leave Tau speaking.

import { useEffect, useRef } from 'react'
import { logForDebugging } from '../utils/debug.js'
import { toError } from '../utils/errors.js'
import { logError } from '../utils/log.js'
import { getLastAssistantMessage } from '../utils/messages.js'
import type { AssistantMessage, Message } from '../types/message.js'
import { isHeyTtsEnabled } from '../voice/heyTtsEnabled.js'

type TtsModule = typeof import('../services/ttsLocal.js')
let ttsModule: TtsModule | null = null
async function loadTts(): Promise<TtsModule> {
  if (ttsModule) return ttsModule
  ttsModule = await import('../services/ttsLocal.js')
  return ttsModule
}

// Strip markdown so we don't read out asterisks, backticks, hash signs,
// and link URLs literally. Conservative: strips emphasis markers,
// headings, fenced/inline code, list bullets, and link syntax. Keeps
// the link text. Block-level newlines collapse to spaces so the prosody
// flows naturally instead of pausing on each markdown break.
export function plainifyForSpeech(markdown: string): string {
  let text = markdown
  // Fenced code blocks — replace with a short verbal placeholder so the
  // listener knows code was elided rather than just silenced.
  text = text.replace(/```[\s\S]*?```/g, ' (code block) ')
  // Inline code
  text = text.replace(/`([^`]+)`/g, '$1')
  // Images (![alt](url)) → alt
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
  // Links ([text](url)) → text
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  // Headings, blockquotes, list bullets at start of line
  text = text.replace(/^[ \t]*#{1,6}[ \t]*/gm, '')
  text = text.replace(/^[ \t]*>[ \t]?/gm, '')
  text = text.replace(/^[ \t]*[-*+][ \t]+/gm, '')
  text = text.replace(/^[ \t]*\d+\.[ \t]+/gm, '')
  // Bold / italic / strikethrough markers
  text = text.replace(/(\*\*|__)(.*?)\1/g, '$2')
  text = text.replace(/(\*|_)(.*?)\1/g, '$2')
  text = text.replace(/~~(.*?)~~/g, '$1')
  // Horizontal rules
  text = text.replace(/^[ \t]*-{3,}[ \t]*$/gm, '')
  // Collapse whitespace
  text = text.replace(/\s+/g, ' ').trim()
  return text
}

const STRUCTURED_LINE_THRESHOLD = 4
const LONG_SPEECH_THRESHOLD_CHARS = 900
const SHORT_SPEECH_MAX_CHARS = 850
const DENSE_SPEECH_LEAD_CHARS = 420
const STRUCTURED_DETAIL_COUNT = 3
const STRUCTURED_DETAIL_CHARS = 130
const DENSE_SPEECH_SUFFIX = 'The full detail is on screen.'

function isStructuredLine(line: string): boolean {
  const trimmed = line.trim()
  return (
    /^([-*+]|\d+[.)])\s+/.test(trimmed) ||
    /^#{1,6}\s+/.test(trimmed) ||
    /[`'"]?[\w@./\\-]+\.(?:ts|tsx|js|jsx|json|md|css|scss|html|py|rs|go|java|cpp|c|h|cs|sh|ps1)\b/i.test(
      trimmed,
    )
  )
}

function countStructuredLines(markdown: string): number {
  return markdown.split(/\r?\n/).filter(isStructuredLine).length
}

function stripCodeBlocks(markdown: string): string {
  return markdown.replace(/```[\s\S]*?```/g, '\n')
}

function getLeadMarkdown(markdown: string): string {
  const lines = stripCodeBlocks(markdown).split(/\r?\n/)
  const lead: string[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) {
      if (lead.length > 0) break
      continue
    }
    if (isStructuredLine(line)) {
      if (lead.length > 0) break
      continue
    }
    lead.push(line)
    if (lead.join(' ').length >= DENSE_SPEECH_LEAD_CHARS) break
  }
  return lead.join('\n').trim()
}

function getStructuredSpeechDetails(markdown: string): string[] {
  const details: string[] = []
  for (const line of stripCodeBlocks(markdown).split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || /^#{1,6}\s+/.test(trimmed) || !isStructuredLine(line)) {
      continue
    }

    const withoutMarker = trimmed.replace(/^([-*+]|\d+[.)])\s+/, '')
    const plain = plainifyForSpeech(withoutMarker)
    if (plain.length < 8) continue
    details.push(truncateAtWord(plain, STRUCTURED_DETAIL_CHARS))
    if (details.length >= STRUCTURED_DETAIL_COUNT) break
  }
  return details
}

function splitSentences(text: string): string[] {
  return (
    text
      .match(/[^.!?]+[.!?]+|[^.!?]+$/g)
      ?.map(sentence => sentence.trim())
      .filter(Boolean) ?? []
  )
}

function endAsSentence(text: string): string {
  const trimmed = text.trim()
  if (!trimmed) return ''
  if (/[.!?]$/.test(trimmed)) return trimmed
  return `${trimmed.replace(/[,:;]+$/, '')}.`
}

function truncateAtWord(text: string, maxChars: number): string {
  const trimmed = text.trim()
  if (trimmed.length <= maxChars) return trimmed
  const slice = trimmed.slice(0, maxChars)
  const breakAt = slice.lastIndexOf(' ')
  const cutoff = breakAt > maxChars * 0.6 ? breakAt : slice.length
  return endAsSentence(slice.slice(0, cutoff))
}

function limitToSentences(
  text: string,
  maxChars: number,
  maxSentences: number,
): string {
  const sentences = splitSentences(text)
  if (sentences.length === 0) return truncateAtWord(text, maxChars)

  const picked: string[] = []
  for (const sentence of sentences) {
    const next = [...picked, sentence].join(' ')
    if (picked.length >= maxSentences || next.length > maxChars) break
    picked.push(sentence)
  }
  return picked.length > 0
    ? endAsSentence(picked.join(' '))
    : truncateAtWord(sentences[0] ?? text, maxChars)
}

export function makeConversationalSpeech(markdown: string): string {
  const plain = plainifyForSpeech(markdown)
  if (!plain) return ''

  const structuredLines = countStructuredLines(markdown)
  const dense =
    plain.length > LONG_SPEECH_THRESHOLD_CHARS ||
    structuredLines >= STRUCTURED_LINE_THRESHOLD ||
    /```/.test(markdown)

  if (!dense) {
    return limitToSentences(plain, SHORT_SPEECH_MAX_CHARS, 6)
  }

  const leadMarkdown = getLeadMarkdown(markdown)
  const details = getStructuredSpeechDetails(markdown)
  const detailSpeech =
    details.length > 0
      ? `The useful parts are: ${details.map(endAsSentence).join(' ')}`
      : ''

  if (!leadMarkdown) {
    return detailSpeech
      ? `${detailSpeech} ${DENSE_SPEECH_SUFFIX}`
      : DENSE_SPEECH_SUFFIX
  }
  const leadPlain = plainifyForSpeech(leadMarkdown)
  const lead = limitToSentences(leadPlain, DENSE_SPEECH_LEAD_CHARS, 2)
  if (!lead) {
    return detailSpeech
      ? `${detailSpeech} ${DENSE_SPEECH_SUFFIX}`
      : DENSE_SPEECH_SUFFIX
  }
  if (/details? (?:are|is|on) screen/i.test(lead)) return lead
  return detailSpeech
    ? `${lead} ${detailSpeech} ${DENSE_SPEECH_SUFFIX}`
    : `${lead} ${DENSE_SPEECH_SUFFIX}`
}

function extractAssistantText(msg: AssistantMessage): string {
  const content = msg.message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (block && typeof block === 'object' && 'type' in block) {
      // Only read out plain text blocks. Tool calls, tool results,
      // thinking blocks etc. are noise when spoken aloud.
      if (block.type === 'text' && typeof (block as { text?: unknown }).text === 'string') {
        parts.push((block as { text: string }).text)
      }
    }
  }
  return parts.join('\n').trim()
}

type UseHeyResponseSpeakerArgs = {
  enabled: boolean
  messages: Message[]
  isLoading: boolean
}

export function useHeyResponseSpeaker({
  enabled,
  messages,
  isLoading,
}: UseHeyResponseSpeakerArgs): void {
  // Track which assistant message id we've already spoken so we don't
  // re-speak on every re-render or when downstream effects mutate the
  // messages array (compaction, edits) without producing a new turn.
  const lastSpokenIdRef = useRef<string | null>(null)
  const wasLoadingRef = useRef(isLoading)

  useEffect(() => {
    if (!enabled) {
      // If hey was just toggled off and TTS is mid-sentence, kill it so
      // Tau does not keep speaking after the user disabled the feature.
      void loadTts()
        .then(mod => mod.stopSpeaking())
        .catch(err => logError(toError(err)))
    }
  }, [enabled])

  useEffect(() => {
    try {
      const wasLoading = wasLoadingRef.current
      wasLoadingRef.current = isLoading
      if (!enabled || !isHeyTtsEnabled()) return
      // Only fire on the loading-to-idle edge. Without this guard a fresh
      // render mid-stream would speak partial output, then re-speak the
      // full output on completion.
      if (!(wasLoading && !isLoading)) return

      const last = getLastAssistantMessage(messages)
      if (!last) {
        logForDebugging('[hey] TTS skipped: no assistant message found')
        return
      }
      const id = last.uuid
      if (id === lastSpokenIdRef.current) {
        logForDebugging(`[hey] TTS skipped: assistant message ${id} already spoken`)
        return
      }

      const raw = extractAssistantText(last)
      const content = last.message.content
      const contentShape = Array.isArray(content) ? 'array' : typeof content
      logForDebugging(
        `[hey] TTS candidate ${id}: messages=${messages.length} content=${contentShape} rawChars=${raw.length}`,
      )
      if (!raw) {
        logForDebugging(`[hey] TTS skipped: assistant message ${id} has no text blocks`)
        return
      }
      const speakable = makeConversationalSpeech(raw)
      if (!speakable) {
        logForDebugging(`[hey] TTS skipped: assistant message ${id} plainified to empty text`)
        return
      }

      lastSpokenIdRef.current = id
      logForDebugging(
        `[hey] speaking assistant message ${id} (rawChars=${raw.length}, speakChars=${speakable.length}, structuredLines=${countStructuredLines(raw)})`,
      )
      void loadTts()
        .then(mod => mod.speak(speakable))
        .catch(err => {
          const error = toError(err)
          logForDebugging(`[hey] TTS speak failed: ${error.stack ?? error.message}`, {
            level: 'error',
          })
          logError(error)
        })
    } catch (err) {
      const error = toError(err)
      logForDebugging(`[hey] TTS response effect failed: ${error.stack ?? error.message}`, {
        level: 'error',
      })
      logError(error)
    }
  }, [enabled, isLoading, messages])
}
