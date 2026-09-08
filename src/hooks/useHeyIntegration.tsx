// Hold-Space input for the realtime /hey session. A tap remains ordinary text;
// only a sustained hold opens the microphone. Speech goes to the live backend.

import * as React from 'react'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useNotifications } from '../context/notifications.js'
import { useIsModalOverlayActive } from '../context/overlayContext.js'
import { KeyboardEvent } from '../ink/events/keyboard-event.js'
// eslint-disable-next-line custom-rules/prefer-use-keybindings -- hold-key repeats need raw input events
import { useInput } from '../ink.js'
import { useOptionalKeybindingContext } from '../keybindings/KeybindingContext.js'
import { keystrokesEqual } from '../keybindings/resolver.js'
import type { ParsedKeystroke } from '../keybindings/types.js'
import { useHey, type HeyState } from './useHey.js'
import { useHeyEnabled } from './useHeyEnabled.js'
import { getLiveVoiceSnapshot, subscribeLiveVoice } from '../services/liveVoice.js'
import { createHoldKeyGesture } from '../voice/holdKeyGesture.js'

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
// tests).
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
}

type StripCharFn = (maxStrip: number, char: string, floor?: number) => number

type UseHeyIntegrationResult = {
  stripTrailing: StripCharFn
  handleKeyEvent: (fallbackMs?: number) => void
  cancelHold: () => void
  isHolding: () => boolean
  state: HeyState
}

export function useHeyIntegration({
  setInputValue,
  inputValueRef,
  insertTextRef,
}: UseHeyIntegrationArgs): UseHeyIntegrationResult {
  const { addNotification } = useNotifications()

  // Remove only hold-key characters, preserving the cursor and existing text.
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

  // Transcript updates are informational. Only explicit backend delegations
  // submit agent work, otherwise every utterance would run twice.
  useEffect(() => {
    let lastId = getLiveVoiceSnapshot().transcriptId
    return subscribeLiveVoice(() => {
      const snapshot = getLiveVoiceSnapshot()
      if (snapshot.transcriptId === lastId) return
      lastId = snapshot.transcriptId
      if (!snapshot.transcript.trim()) return
      addNotification({
        key: 'hey-transcript',
        text: `Heard: ${previewTranscript(snapshot.transcript)}`,
        invalidates: ['hey-error'],
        priority: 'immediate',
        timeoutMs: 4000,
      })
    })
  }, [addNotification])

  return {
    stripTrailing,
    handleKeyEvent: hey.handleKeyEvent,
    cancelHold: hey.cancelHold,
    isHolding: hey.isHolding,
    state: hey.state,
  }
}

export function useHeyKeybindingHandler({
  heyHandleKeyEvent,
  heyState,
  heyCancelHold,
  heyIsHolding,
  stripTrailing,
  isActive,
}: {
  heyHandleKeyEvent: (fallbackMs?: number) => void
  heyState: HeyState
  heyCancelHold: () => void
  heyIsHolding: () => boolean
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

  const callbacksRef = useRef({ heyHandleKeyEvent, heyIsHolding, stripTrailing })
  callbacksRef.current = { heyHandleKeyEvent, heyIsHolding, stripTrailing }
  const gesture = useMemo(() => createHoldKeyGesture({
    activate: milliseconds => callbacksRef.current.heyHandleKeyEvent(milliseconds),
    isHolding: () => callbacksRef.current.heyIsHolding(),
    stripTrailing: (count, char, floor) => callbacksRef.current.stripTrailing(count, char, floor),
    clock: {
      setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
      clearTimeout: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
    },
  }), [])

  useEffect(() => {
    if (!heyEnabled || heyState === 'off' || heyState === 'error' || !isActive || isModalOverlayActive) {
      heyCancelHold()
      gesture.reset()
    }
  }, [heyEnabled, heyState, isActive, isModalOverlayActive, heyCancelHold, gesture])

  useEffect(() => () => {
    gesture.reset()
    heyCancelHold()
  }, [gesture, heyCancelHold])

  const handleKeyDown = (e: KeyboardEvent): void => {
    if (!heyEnabled) return
    if (!isActive || isModalOverlayActive) return
    if (heyKeystroke === null) return
    if (heyState === 'off' || heyState === 'error' || heyState === 'connecting') return

    const cancelGesture = () => {
      gesture.reset()
      heyCancelHold()
    }

    let repeatCount: number
    if (bareChar !== null) {
      if (e.ctrl || e.meta || e.shift || e.superKey) { cancelGesture(); return }
      const normalized = e.key === 'space' ? ' ' : e.key
      if (normalized[0] !== bareChar) { cancelGesture(); return }
      if (
        normalized.length > 1 &&
        normalized !== bareChar.repeat(normalized.length)
      ) {
        cancelGesture()
        return
      }
      repeatCount = normalized.length
    } else {
      if (!matchesKeyboardEvent(e, heyKeystroke)) { cancelGesture(); return }
      repeatCount = 1
    }

    if (gesture.press(repeatCount, bareChar)) e.stopImmediatePropagation()
  }

  // The raw input listener runs before PromptInput and can swallow repeats.
  useInput(
    (_input, _key, event) => {
      if (event.keypress.isPasted) {
        gesture.reset()
        heyCancelHold()
        return
      }
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

// Mount before PromptInput so swallowed hold-key repeats never enter text.
type HeyKeybindingHandlerProps = {
  heyHandleKeyEvent: (fallbackMs?: number) => void
  heyState: HeyState
  heyCancelHold: () => void
  heyIsHolding: () => boolean
  stripTrailing: StripCharFn
  isActive: boolean
}
export function HeyKeybindingHandler(
  props: HeyKeybindingHandlerProps,
): null {
  useHeyKeybindingHandler(props)
  return null
}
