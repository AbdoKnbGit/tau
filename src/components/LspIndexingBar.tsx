import * as React from 'react'
import { useRef, useState } from 'react'
import { useInterval } from 'usehooks-ts'
import { Box, Text } from '../ink.js'
import { getLspIndexingStatus } from '../services/lsp/manager.js'

const BAR_WIDTH = 16
// Show 100% for this long AFTER indexing finishes, so the bar always visibly
// completes (regardless of how long the index took) instead of vanishing
// mid-fill.
const COMPLETE_HOLD_MS = 1200
// Total minimum visible time, so a fast (warm-cache) index doesn't just flicker.
const MIN_DISPLAY_MS = 1500
// Poll often enough to never miss a short indexing window.
const POLL_MS = 250

/**
 * Soft, transient progress bar shown while a language server loads the project.
 * Renders nothing once idle. The percentage is time-estimated (servers report
 * begin/end but no %); it creeps toward 99 while indexing, then holds at 100%
 * briefly once the real "done" signal arrives.
 */
export function LspIndexingBar(): React.ReactNode {
  const [view, setView] = useState<{ visible: boolean; pct: number }>(() => ({
    visible: false,
    pct: 0,
  }))
  const shownAtRef = useRef<number | undefined>(undefined)
  const endedAtRef = useRef<number | undefined>(undefined)

  useInterval(() => {
    const status = getLspIndexingStatus()
    const now = Date.now()
    let visible: boolean
    let pct: number

    if (status.indexing) {
      if (shownAtRef.current === undefined) shownAtRef.current = now
      endedAtRef.current = undefined
      visible = true
      pct = Math.max(1, Math.min(99, status.percent))
    } else if (shownAtRef.current !== undefined) {
      // Indexing just finished — show a completed bar, then hold briefly so the
      // 100% is actually seen, honoring the minimum total display too.
      if (endedAtRef.current === undefined) endedAtRef.current = now
      const completeHeldEnough = now - endedAtRef.current >= COMPLETE_HOLD_MS
      const minShownEnough = now - shownAtRef.current >= MIN_DISPLAY_MS
      if (completeHeldEnough && minShownEnough) {
        shownAtRef.current = undefined
        endedAtRef.current = undefined
        visible = false
      } else {
        visible = true
      }
      pct = 100
    } else {
      visible = false
      pct = 0
    }

    setView(prev =>
      prev.visible === visible && prev.pct === pct ? prev : { visible, pct },
    )
  }, POLL_MS)

  if (!view.visible) return null

  const filled = Math.round((view.pct / 100) * BAR_WIDTH)
  const bar = '█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled)
  return (
    <Box paddingX={2}>
      <Text dimColor>
        {`indexing project for fast queries  ${bar} ${view.pct}%`}
      </Text>
    </Box>
  )
}
