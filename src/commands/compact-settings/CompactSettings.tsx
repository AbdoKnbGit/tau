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
 * `undefined` occupies the last slot of each track and means "auto". It sits
 * on the right because on both controls auto is the most permissive end:
 * compact as late as possible, and no ceiling.
 */
type Choice<T> = T | undefined

const THRESHOLD_CHOICES: Choice<number>[] = [
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

const CAP_CHOICES: Choice<number>[] = [...COMPACT_WINDOW_CAP_CHOICES, undefined]

const TRACK_WIDTH = 46

function indexOfChoice<T>(choices: Choice<T>[], value: Choice<T>): number {
  const found = choices.indexOf(value)
  return found === -1 ? choices.length - 1 : found
}

/** Filled/partial/empty track showing where the cursor sits on the range. */
function Track({
  position,
  total,
  color,
  dim,
}: {
  position: number
  total: number
  color: string
  dim: string
}): React.ReactNode {
  const filled = Math.max(
    1,
    Math.round(((position + 1) / total) * TRACK_WIDTH),
  )
  return (
    <Text>
      <Text color={color}>{'▉'.repeat(filled)}</Text>
      <Text color={dim}>{'░'.repeat(Math.max(0, TRACK_WIDTH - filled))}</Text>
    </Text>
  )
}

/** Evenly spaced tick labels under a track, with the active one highlighted. */
function Ticks({
  labels,
  active,
  color,
  dim,
}: {
  labels: string[]
  active: number
  color: string
  dim: string
}): React.ReactNode {
  const slot = Math.max(1, Math.floor(TRACK_WIDTH / labels.length))
  return (
    <Text>
      {labels.map((label, i) => (
        <Text key={label} color={i === active ? color : dim} bold={i === active}>
          {label.padEnd(slot).slice(0, Math.max(slot, label.length + 1))}
        </Text>
      ))}
    </Text>
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

  const autoOff = !isAutoCompactEnabled()

  return (
    <Box flexDirection="column" gap={1} paddingX={1}>
      <Box flexDirection="column">
        <Text bold>Compaction settings</Text>
        <Text color={theme.subtle}>
          When context fills up, older history is summarized so the session can
          continue. These control when that happens — both scale to whatever
          model you are on.
        </Text>
      </Box>

      {autoOff && (
        <Text color={theme.warning}>
          Auto-compaction is currently off, so these only take effect once it is
          re-enabled. Tool-result pruning keeps running either way.
        </Text>
      )}

      {/* ── Threshold ─────────────────────────────────────────────── */}
      <Box flexDirection="column">
        <Box justifyContent="space-between">
          <Text bold color={row === 0 ? theme.suggestion : undefined}>
            {row === 0 ? '❯ ' : '  '}Compact at
          </Text>
          <Text color={theme.subtle}>
            {model} · {formatTokenCount(preview.contextWindow)} window
          </Text>
        </Box>
        <Box paddingLeft={2} flexDirection="column">
          <Track
            position={thresholdIndex}
            total={THRESHOLD_CHOICES.length}
            color={row === 0 ? theme.suggestion : theme.subtle}
            dim={theme.inactive}
          />
          <Ticks
            labels={THRESHOLD_CHOICES.map(c =>
              c === undefined ? 'Auto' : `${c}`,
            )}
            active={thresholdIndex}
            color={theme.suggestion}
            dim={theme.inactive}
          />
          <Text color={theme.subtle}>
            {describeThresholdPercent(percent)}
          </Text>
          <Text>
            <Text color={theme.success}>
              Fires at {preview.threshold.toLocaleString()} tokens
            </Text>
            <Text color={theme.subtle}>
              {' '}
              ({preview.thresholdShareOfWindow.toFixed(0)}% of the window) ·{' '}
              {preview.headroomTokens.toLocaleString()} left for the summary and
              your next turn
            </Text>
          </Text>
          {preview.clampedByReserve && (
            <Text color={theme.warning}>
              Capped by the {preview.reservedTokens.toLocaleString()}-token
              reserve compaction needs to run — a higher percentage cannot go
              further on this window.
            </Text>
          )}
        </Box>
      </Box>

      {/* ── Context cap ───────────────────────────────────────────── */}
      <Box flexDirection="column">
        <Text bold color={row === 1 ? theme.suggestion : undefined}>
          {row === 1 ? '❯ ' : '  '}Context cap
        </Text>
        <Box paddingLeft={2} flexDirection="column">
          <Track
            position={capIndex}
            total={CAP_CHOICES.length}
            color={row === 1 ? theme.suggestion : theme.subtle}
            dim={theme.inactive}
          />
          <Ticks
            labels={CAP_CHOICES.map(c =>
              c === undefined ? 'Auto' : formatTokenCount(c),
            )}
            active={capIndex}
            color={theme.suggestion}
            dim={theme.inactive}
          />
          <Text color={theme.subtle}>{describeWindowCap(cap)}</Text>
          {cap !== undefined && cap >= preview.contextWindow && (
            <Text color={theme.subtle}>
              No effect here — this model&apos;s window is already smaller.
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
