import React, { useMemo, useState } from 'react'
import { Box, Text, useInput } from '../../ink.js'
import {
  isAutoCompactEnabled,
  previewAutoCompaction,
} from '../../services/compact/autoCompact.js'
import {
  COMPACT_THRESHOLD_MAX_PERCENT,
  COMPACT_THRESHOLD_MIN_PERCENT,
  COMPACT_THRESHOLD_STEP_PERCENT,
  COMPACT_WINDOW_CAP_CHOICES,
  describeThresholdPercent,
  describeWindowCap,
  formatTokenCount,
} from '../../utils/compactionSettings.js'
import {
  getConfiguredThresholdPercent,
  getConfiguredWindowCap,
  setConfiguredThresholdPercent,
  setConfiguredWindowCap,
} from '../../utils/compactionConfig.js'
import { getMainLoopModel } from '../../utils/model/model.js'
import { getTheme } from '../../utils/theme.js'

/**
 * `undefined` occupies the last slot of each track and means "auto". It sits on
 * the right because on both controls auto is the most permissive end: compact
 * as late as possible, and no ceiling.
 */
type Choice = number | undefined

const THRESHOLD_CHOICES: Choice[] = [
  ...Array.from(
    {
      length:
        (COMPACT_THRESHOLD_MAX_PERCENT - COMPACT_THRESHOLD_MIN_PERCENT) /
          COMPACT_THRESHOLD_STEP_PERCENT +
        1,
    },
    (_, i) =>
      COMPACT_THRESHOLD_MIN_PERCENT + i * COMPACT_THRESHOLD_STEP_PERCENT,
  ),
  undefined,
]

const CAP_CHOICES: Choice[] = [...COMPACT_WINDOW_CAP_CHOICES, undefined]

const TRACK_WIDTH = 40

function indexOfChoice(choices: Choice[], value: Choice): number {
  const found = choices.indexOf(value)
  return found === -1 ? choices.length - 1 : found
}

/**
 * One control: its current value, a filled track, and the track's endpoints.
 *
 * Endpoints label the track rather than a tick under every step. Sixteen ticks
 * do not fit in a terminal-width track — padding each to the two columns that
 * remain collapses them into an unreadable run of digits — so the selected
 * value is shown in the header instead, which also covers the steps that would
 * never have had a tick of their own.
 */
function Control({
  label,
  value,
  position,
  total,
  minLabel,
  maxLabel,
  focused,
  theme,
}: {
  label: string
  value: string
  position: number
  total: number
  minLabel: string
  maxLabel: string
  focused: boolean
  theme: ReturnType<typeof getTheme>
}): React.ReactNode {
  const filled = Math.max(1, Math.round(((position + 1) / total) * TRACK_WIDTH))
  const accent = focused ? theme.suggestion : theme.subtle
  return (
    <Box flexDirection="column">
      <Text>
        <Text bold color={focused ? theme.suggestion : undefined}>
          {focused ? '❯ ' : '  '}
          {label}
        </Text>
        <Text bold color={accent}>
          {'   '}
          {value}
        </Text>
      </Text>
      <Text>
        {'  '}
        <Text color={theme.inactive}>{minLabel.padEnd(6)}</Text>
        <Text color={accent}>{'▉'.repeat(filled)}</Text>
        <Text color={theme.inactive}>
          {'░'.repeat(Math.max(0, TRACK_WIDTH - filled))}
        </Text>
        <Text color={theme.inactive}> {maxLabel}</Text>
      </Text>
    </Box>
  )
}

export function CompactSettings({
  onDone,
}: {
  onDone: (message: string) => void
}): React.ReactNode {
  const theme = getTheme()
  const model = getMainLoopModel()

  const [row, setRow] = useState<0 | 1>(0)
  const [thresholdIndex, setThresholdIndex] = useState(() =>
    indexOfChoice(THRESHOLD_CHOICES, getConfiguredThresholdPercent()),
  )
  const [capIndex, setCapIndex] = useState(() =>
    indexOfChoice(CAP_CHOICES, getConfiguredWindowCap()),
  )

  const percent = THRESHOLD_CHOICES[thresholdIndex]
  const cap = CAP_CHOICES[capIndex]

  // Recomputed from the live model window on every keystroke, so the numbers
  // shown are the numbers this setting would actually produce right now.
  const preview = useMemo(
    () => previewAutoCompaction(model, percent, cap),
    [model, percent, cap],
  )

  useInput((input, key) => {
    if (key.escape) {
      onDone('Compaction settings unchanged')
      return
    }
    if (key.return) {
      setConfiguredThresholdPercent(percent)
      setConfiguredWindowCap(cap)
      onDone(
        `Auto-compaction set to ${percent === undefined ? 'auto' : `${percent}%`}` +
          `${cap === undefined ? '' : ` with a ${formatTokenCount(cap)} context cap`}` +
          ` — fires at ${preview.threshold.toLocaleString()} tokens on ${model}`,
      )
      return
    }
    if (key.upArrow || key.downArrow || input === 'k' || input === 'j') {
      setRow(current => (current === 0 ? 1 : 0))
      return
    }
    const delta = key.leftArrow ? -1 : key.rightArrow ? 1 : 0
    if (delta === 0) return
    if (row === 0) {
      setThresholdIndex(i =>
        Math.min(THRESHOLD_CHOICES.length - 1, Math.max(0, i + delta)),
      )
    } else {
      setCapIndex(i => Math.min(CAP_CHOICES.length - 1, Math.max(0, i + delta)))
    }
  })

  const capIsInert = cap !== undefined && cap >= preview.contextWindow

  return (
    <Box flexDirection="column" gap={1} paddingX={1}>
      <Box flexDirection="column">
        <Text bold>Compaction settings</Text>
        <Text color={theme.subtle} wrap="wrap">
          When context fills up, older history is summarized so the session can
          continue. Both controls are relative to the active model, so one
          choice behaves sensibly on any window size.
        </Text>
        <Text color={theme.subtle}>
          {model} · {formatTokenCount(preview.contextWindow)} context window
        </Text>
      </Box>

      {!isAutoCompactEnabled() && (
        <Text color={theme.warning} wrap="wrap">
          Auto-compaction is off, so these take effect only once it is
          re-enabled. Tool-result pruning keeps running either way.
        </Text>
      )}

      <Box flexDirection="column">
        <Control
          label="Compact at"
          value={percent === undefined ? 'auto' : `${percent}%`}
          position={thresholdIndex}
          total={THRESHOLD_CHOICES.length}
          minLabel={`${COMPACT_THRESHOLD_MIN_PERCENT}%`}
          maxLabel="auto"
          focused={row === 0}
          theme={theme}
        />
        <Box paddingLeft={2} flexDirection="column">
          <Text color={theme.subtle} wrap="wrap">
            {describeThresholdPercent(percent)}
          </Text>
          <Text wrap="wrap">
            <Text color={theme.success}>
              Fires at {preview.threshold.toLocaleString()} tokens
            </Text>
            <Text color={theme.subtle}>
              {' '}
              ({preview.thresholdShareOfWindow.toFixed(0)}% of the window),
              leaving {preview.headroomTokens.toLocaleString()} — of which{' '}
              {preview.reservedTokens.toLocaleString()} is held back for the
              summary itself.
            </Text>
          </Text>
          {preview.clampedByReserve && (
            <Text color={theme.warning} wrap="wrap">
              Capped: a higher percentage cannot go further on this window
              without eating the reserve compaction needs to run.
            </Text>
          )}
        </Box>
      </Box>

      <Box flexDirection="column">
        <Control
          label="Context cap"
          value={cap === undefined ? 'auto' : formatTokenCount(cap)}
          position={capIndex}
          total={CAP_CHOICES.length}
          minLabel={formatTokenCount(COMPACT_WINDOW_CAP_CHOICES[0] ?? 100_000)}
          maxLabel="auto"
          focused={row === 1}
          theme={theme}
        />
        <Box paddingLeft={2} flexDirection="column">
          <Text color={theme.subtle} wrap="wrap">
            {describeWindowCap(cap)}
          </Text>
          {capIsInert && (
            <Text color={theme.warning} wrap="wrap">
              No effect on {model}: its window is already{' '}
              {formatTokenCount(preview.contextWindow)}, smaller than this cap.
              It applies only on larger models.
            </Text>
          )}
        </Box>
      </Box>

      <Text color={theme.subtle}>
        ←/→ adjust · ↑/↓ switch control · Enter save · Esc cancel
      </Text>
    </Box>
  )
}
