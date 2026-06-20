import * as React from 'react'
import { Box, Text } from '../ink.js'
import { useMainLoopModel } from '../hooks/useMainLoopModel.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { renderModelName } from '../utils/model/model.js'
import { getLogoDisplayData } from '../utils/logoV2Utils.js'
import { TauWordmark } from './tau-ui/TauWordmark.js'

/**
 * Studio welcome header: clean centered layout — version on top, animated
 * terminal wordmark, then "model · provider"
 * and the working directory. No outer frame, no email/organization line.
 *
 * Adapts to terminal size the opencode way: the design never changes — the
 * outer box is pinned to the real terminal width so the centered content
 * stays centered in the visible area (instead of being pushed off the right
 * edge as a stale wider width would do). The logo keeps its intrinsic size
 * (flexShrink={0}); model/cwd truncate rather than wrap.
 */
export function MinimalWelcome(): React.ReactNode {
  const model = useMainLoopModel()
  const { columns } = useTerminalSize()
  const { version, cwd, billingType } = getLogoDisplayData()
  const modelName = model ? renderModelName(model) : ''
  const modelLine =
    modelName && billingType
      ? `${modelName} · ${billingType}`
      : modelName || billingType

  return (
    <Box flexDirection="column" alignItems="center" width={columns} paddingY={1}>
      <Text dimColor>Tau v{version}</Text>
      <Box
        flexDirection="column"
        alignItems="center"
        marginTop={1}
        flexShrink={0}
      >
        <TauWordmark />
      </Box>
      <Box marginTop={1} flexDirection="column" alignItems="center">
        {modelLine ? (
          <Text dimColor wrap="truncate">
            {modelLine}
          </Text>
        ) : null}
        <Text dimColor wrap="truncate">
          {cwd}
        </Text>
      </Box>
    </Box>
  )
}
