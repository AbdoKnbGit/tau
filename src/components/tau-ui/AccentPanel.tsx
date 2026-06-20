import * as React from 'react'
import { Box, Text } from '../../ink.js'
import type { Theme } from '../../utils/theme.js'

/**
 * The signature tau panel: a single teal left-bar with padded content and no
 * top/right/bottom border. This is the same construction the prompt input uses
 * (`borderLeft` only) — promoted to a primitive so the welcome screen, the
 * prompt box, and every tool/edit block share one visual language.
 */
type AccentPanelProps = {
  children?: React.ReactNode
  /** Theme token for the left bar. Defaults to the teal brand accent. */
  barColor?: keyof Theme
  paddingY?: number
}

export function AccentPanel({
  children,
  barColor = 'brand',
  paddingY = 0,
}: AccentPanelProps): React.ReactNode {
  return (
    <Box flexDirection="column">
      <Box
        borderStyle="round"
        borderColor={barColor}
        borderTop={false}
        borderRight={false}
        borderBottom={false}
        paddingLeft={1}
        paddingY={paddingY}
        flexDirection="column"
      >
        {children}
      </Box>
    </Box>
  )
}

/**
 * A compact header line for a panel: `◆ Label · detail`. The diamond + label
 * carry the accent; the detail (file path, etc.) stays muted.
 */
type PanelHeaderProps = {
  label: string
  detail?: string
  icon?: string
  accent?: keyof Theme
}

export function PanelHeader({
  label,
  detail,
  icon = '◆',
  accent = 'brand',
}: PanelHeaderProps): React.ReactNode {
  return (
    <Box>
      <Text color={accent} bold>
        {icon} {label}
      </Text>
      {detail != null && <Text color="textMuted"> · {detail}</Text>}
    </Box>
  )
}
