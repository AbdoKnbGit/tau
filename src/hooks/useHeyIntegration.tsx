// Hey-mode integration: keybinding handler + audio capture + whisper
// transcription + auto-submit. Mirrors useVoiceIntegration but stripped
// down to what the conversational hold-Space flow actually needs:
//
//   • No interim transcript injection into the prompt input (we transcribe
//     once on release, not as you speak).
//   • No anchor/interim-range bookkeeping — the transcript submits through
//     the REPL's normal onSubmit path.
//   • No focus-mode auto-recording (always key-hold).
//
// What we *do* still need from the voice integration patterns: bare-key
// hold detection so binding Space doesn't break typing a single space
// (warmup flow-through + activation strip).

import * as React from 'react'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useNotifications } from '../context/notifications.js'
import { useIsModalOverlayActive } from '../context/overlayContext.js'
import { KeyboardEvent } from '../ink/events/keyboard-event.js'
// eslint-disable-next-line custom-rules/prefer-use-keybindings -- match useVoiceIntegration's bridge until handleKeyDown is wired through <Box onKeyDown>
import { useInput } from '../ink.js'
import { useOptionalKeybindingContext } from '../keybindings/KeybindingContext.js'
import { keystrokesEqual } from '../keybindings/resolver.js'
import type { ParsedKeystroke } from '../keybindings/types.js'
import { useHey, type HeyState } from './useHey.js'
import { useHeyEnabled } from './useHeyEnabled.js'

// Use the same thresholds as voice integration so the hold-feel is
// consistent across local hold-to-talk flows.
const RAPID_KEY_GAP_MS = 120
const HOLD_THRESHOLD = 5
const WARMUP_THRESHOLD = 2
const MODIFIER_FIRST_PRESS_FALLBACK_MS = 2000
const TRANSCRIPT_PREVIEW_CHARS = 180

function previewTranscript(text: string): string {
  const cleaned = text.replace(/\s+/g, ' ').trim()
  if (cleaned.length <= TRANSCRIPT_PREVIEW_CHARS) return cleaned
  return `${cleaned.slice(0, TRANSCRIPT_PREVIEW_CHARS - 3)}...`
}

function matchesKeyboardEvent(
  e: KeyboardEvent,
  target: ParsedKeystroke,
): boolean {
  const key =
    e.key === 'space'
      ? ' '
      : e.key === 'return'
        ? 'enter'
        : e.key.toLowerCase()
  if (key !== target.key) return false
  if (e.ctrl !== target.ctrl) return false
  if (e.shift !== target.shift) return false
  if (e.meta !== (target.alt || target.meta)) return false
  if (e.superKey !== target.super) return false
  return true
}

// Default to bare space if there's no KeybindingProvider at all (headless,
// tests). Mirrors DEFAULT_VOICE_KEYSTROKE in useVoiceIntegration.
const DEFAULT_HEY_KEYSTROKE: ParsedKeystroke = {
  key: ' ',
  ctrl: false,
  alt: false,
  shift: false,
  meta: false,
  super: false,
}

type InsertTextHandle = {
  insert: (text: string) => void
  setInputWithCursor: (value: string, cursor: number) => void
  cursorOffset: number
}

type UseHeyIntegrationArgs = {
  setInputValue: (value: string) => void
  inputValueRef: React.RefObject<string>
  insertTextRef: React.RefObject<InsertTextHandle | null>
  onSubmit: (text: string) => void
}

type StripCharFn = (maxStrip: number, char: string, floor?: number) => number

type UseHeyIntegrationResult = {
  stripTrailing: StripCharFn
  handleKeyEvent: (fallbackMs?: number) => void
  state: HeyState
}

export function useHeyIntegration({
  setInputValue,
  inputValueRef,
  insertTextRef,
  onSubmit,
}: UseHeyIntegrationArgs): UseHeyIntegrationResult {
  const { addNotification } = useNotifications()

  // Strip trailing chars (leaked V's) from the input. Hey mode auto-submits
  // without touching the input box, so we never need to capture an anchor —
  // strip-only is enough.
  const stripTrailing = useCallback<StripCharFn>(
    (maxStrip: number, char: string, floor = 0): number => {
      const prev = inputValueRef.current
      const offset = insertTextRef.current?.cursorOffset ?? prev.length
      const beforeCursor = prev.slice(0, offset)
      const afterCursor = prev.slice(offset)
      let trailing = 0
      while (
        trailing < beforeCursor.length &&
        beforeCursor[beforeCursor.length - 1 - trailing] === char
      ) {
        trailing++
      }
      const stripCount = Math.max(0, Math.min(trailing - floor, maxStrip))
      const remaining = trailing - stripCount
      if (stripCount === 0) return remaining
      const stripped = beforeCursor.slice(0, beforeCursor.length - stripCount)
      const newValue = stripped + afterCursor
      if (insertTextRef.current) {
        insertTextRef.current.setInputWithCursor(newValue, stripped.length)
      } else {
        setInputValue(newValue)
      }
      return remaining
    },
    [setInputValue, inputValueRef, insertTextRef],
  )

  const heyEnabled = useHeyEnabled()

  const hey = useHey({
    enabled: heyEnabled,
    onTranscript: (text: string) => {
      addNotification({
        key: 'hey-transcript',
        text: `Heard: ${previewTranscript(text)}`,
        invalidates: ['hey-error'],
        priority: 'immediate',
        timeoutMs: 4000,
      })
    },
    onSubmit,
    onError: (message: string) => {
      addNotification({
        key: 'hey-error',
        text: message,
        color: 'error',
        priority: 'immediate',
        timeoutMs: 10_000,
      })
    },
  })

  return {
    stripTrailing,
    handleKeyEvent: hey.handleKeyEvent,
    state: hey.state,
  }
}

export function useHeyKeybindingHandler({
  heyHandleKeyEvent,
  heyState,
  stripTrailing,
  isActive,
}: {
  heyHandleKeyEvent: (fallbackMs?: number) => void
  heyState: HeyState
  stripTrailing: StripCharFn
  isActive: boolean
}): { handleKeyDown: (e: KeyboardEvent) => void } {
  const keybindingContext = useOptionalKeybindingContext()
  const isModalOverlayActive = useIsModalOverlayActive()
  const heyEnabled = useHeyEnabled()

  // Resolve the configured key for hey:pushToTalk by walking Chat-context
  // bindings forward — last wins so an override after the default is
  // respected. A null-unbind (binding without a target action) returns
  // null and disables hold-to-talk for hey-mode (toggle the feature itself
  // via /hey).
  const heyKeystroke = useMemo((): ParsedKeystroke | null => {
    if (!keybindingContext) return DEFAULT_HEY_KEYSTROKE
    let result: ParsedKeystroke | null = null
    for (const binding of keybindingContext.bindings) {
      if (binding.context !== 'Chat') continue
      if (binding.chord.length !== 1) continue
      const ks = binding.chord[0]
      if (!ks) continue
      if (binding.action === 'hey:pushToTalk') {
        result = ks
      } else if (result !== null && keystrokesEqual(ks, result)) {
        result = null
      }
    }
    return result
  }, [keybindingContext])

  const bareChar =
    heyKeystroke !== null &&
    heyKeystroke.key.length === 1 &&
    !heyKeystroke.ctrl &&
    !heyKeystroke.alt &&
    !heyKeystroke.shift &&
    !heyKeystroke.meta &&
    !heyKeystroke.super
      ? heyKeystroke.key
      : null

  const rapidCountRef = useRef(0)
  const charsInInputRef = useRef(0)
  const recordingFloorRef = useRef(0)
  const isHoldActiveRef = useRef(false)
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Reset hold state once hey-mode toggles off or returns to idle, so the
  // next hold key press goes through the normal hold threshold again.
  useEffect(() => {
    if (!heyEnabled || heyState === 'idle') {
      isHoldActiveRef.current = false
      rapidCountRef.current = 0
      charsInInputRef.current = 0
      recordingFloorRef.current = 0
    }
  }, [heyEnabled, heyState])

  const handleKeyDown = (e: KeyboardEvent): void => {
    if (!heyEnabled) return
    if (!isActive || isModalOverlayActive) return
    if (heyKeystroke === null) return

    let repeatCount: number
    if (bareChar !== null) {
      if (e.ctrl || e.meta || e.shift) return
      const normalized = e.key
      if (normalized[0] !== bareChar) return
      if (
        normalized.length > 1 &&
        normalized !== bareChar.repeat(normalized.length)
      ) {
        return
      }
      repeatCount = normalized.length
    } else {
      if (!matchesKeyboardEvent(e, heyKeystroke)) return
      repeatCount = 1
    }

    if (isHoldActiveRef.current && heyState !== 'idle') {
      // Already recording — swallow continued hold-key repeats (so they don't
      // type spaces into the input) and forward to hey for release detection.
      e.stopImmediatePropagation()
      if (bareChar !== null) {
        stripTrailing(repeatCount, bareChar, recordingFloorRef.current)
      }
      heyHandleKeyEvent()
      return
    }

    const countBefore = rapidCountRef.current
    rapidCountRef.current += repeatCount

    // ── Activation ─────────────────────────────────────────────
    // Modifier combos activate on the first press (can't be typed
    // accidentally). Bare chars need the hold threshold so a single
    // 'v' tap still types 'v' normally.
    if (bareChar === null || rapidCountRef.current >= HOLD_THRESHOLD) {
      e.stopImmediatePropagation()
      if (resetTimerRef.current) {
        clearTimeout(resetTimerRef.current)
        resetTimerRef.current = null
      }
      rapidCountRef.current = 0
      isHoldActiveRef.current = true
      if (bareChar !== null) {
        // Strip the warmup-flowed chars (charsInInputRef) plus this
        // event's potential leak. The remaining count becomes the floor
        // so genuine pre-existing V's that happen to be at the boundary
        // (e.g. user typed "implementv" and then started holding) are
        // preserved.
        recordingFloorRef.current = stripTrailing(
          charsInInputRef.current + repeatCount,
          bareChar,
        )
        charsInInputRef.current = 0
        heyHandleKeyEvent()
      } else {
        heyHandleKeyEvent(MODIFIER_FIRST_PRESS_FALLBACK_MS)
      }
      return
    }

    // ── Warmup: flow-through + swallow ────────────────────────
    // First WARMUP_THRESHOLD chars flow into the input so a single key
    // tap types the key normally. Beyond that, swallow + strip so the input
    // stays clean as the hold reaches activation.
    if (countBefore >= WARMUP_THRESHOLD) {
      e.stopImmediatePropagation()
      if (bareChar !== null) {
        stripTrailing(repeatCount, bareChar, charsInInputRef.current)
      }
    } else if (bareChar !== null) {
      charsInInputRef.current += repeatCount
    }

    if (resetTimerRef.current) {
      clearTimeout(resetTimerRef.current)
    }
    resetTimerRef.current = setTimeout(() => {
      resetTimerRef.current = null
      rapidCountRef.current = 0
      charsInInputRef.current = 0
    }, RAPID_KEY_GAP_MS)
  }

  // Backward-compat bridge mirroring useVoiceKeybindingHandler — REPL.tsx
  // doesn't yet wire <Box onKeyDown>, so we listen via useInput and forward
  // the event into our handler.
  useInput(
    (_input, _key, event) => {
      const kbEvent = new KeyboardEvent(event.keypress)
      handleKeyDown(kbEvent)
      if (kbEvent.didStopImmediatePropagation()) {
        event.stopImmediatePropagation()
      }
    },
    { isActive },
  )

  return { handleKeyDown }
}

// JSX wrapper so REPL.tsx can mount the keybinding handler alongside the
// existing <VoiceKeybindingHandler /> without restructuring REPL itself.
type HeyKeybindingHandlerProps = {
  heyHandleKeyEvent: (fallbackMs?: number) => void
  heyState: HeyState
  stripTrailing: StripCharFn
  isActive: boolean
}
export function HeyKeybindingHandler(
  props: HeyKeybindingHandlerProps,
): null {
  useHeyKeybindingHandler(props)
  return null
}
