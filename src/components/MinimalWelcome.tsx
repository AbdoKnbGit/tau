import * as React from 'react'
import { Box, Text } from '../ink.js'
import { useMainLoopModel } from '../hooks/useMainLoopModel.js'
import { renderModelName } from '../utils/model/model.js'
import { getLogoDisplayData } from '../utils/logoV2Utils.js'

const TAU_LOGO: readonly string[] = [
  '████████╗ █████╗ ██╗   ██╗',
  '╚══██╔══╝██╔══██╗██║   ██║',
  '   ██║   ███████║██║   ██║',
  '   ██║   ██╔══██║██║   ██║',
  '   ██║   ██║  ██║╚██████╔╝',
  '   ╚═╝   ╚═╝  ╚═╝ ╚═════╝ ',
]

/**
 * Studio welcome header: clean centered layout — version on top, big
 * block-letter "TAU" logo in primary color, then "model · provider"
 * and the working directory. No outer frame, no email/organization line.
 */
export function MinimalWelcome(): React.ReactNode {
  const model = useMainLoopModel()
  const { version, cwd, billingType } = getLogoDisplayData()
  const modelName = model ? renderModelName(model) : ''
  const modelLine =
    modelName && billingType
      ? `${modelName} · ${billingType}`
      : modelName || billingType

  return (
    <Box flexDirection="column" alignItems="center" width="100%" paddingY={1}>
      <Text dimColor>Tau v{version}</Text>
      <Box flexDirection="column" alignItems="center" marginTop={1}>
        {TAU_LOGO.map((line, i) => (
          <Text key={i} color="primary" bold>
            {line}
          </Text>
        ))}
      </Box>
      <Box marginTop={1} flexDirection="column" alignItems="center">
        {modelLine ? <Text dimColor>{modelLine}</Text> : null}
        <Text dimColor>{cwd}</Text>
      </Box>
    </Box>
  )
}
