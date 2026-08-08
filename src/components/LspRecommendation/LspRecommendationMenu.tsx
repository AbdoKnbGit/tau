import * as React from 'react'
import { Box, Text } from '../../ink.js'
import type { LspRecommendationAction } from '../../utils/plugins/lspRecommendation.js'
import { Select } from '../CustomSelect/select.js'
import { PermissionDialog } from '../permissions/PermissionDialog.js'

type Props = {
  pluginName: string
  pluginDescription?: string
  fileExtension: string
  action: LspRecommendationAction
  serverReady: boolean
  canAutoInstallServer: boolean
  onResponse: (response: 'yes' | 'no' | 'never' | 'disable') => void
}

const AUTO_DISMISS_MS = 30_000

function setupLabel({
  pluginName,
  action,
  serverReady,
  canAutoInstallServer,
}: Pick<
  Props,
  'pluginName' | 'action' | 'serverReady' | 'canAutoInstallServer'
>): React.ReactNode {
  if (action === 'install-server') {
    return canAutoInstallServer
      ? 'Install the rust-analyzer component'
      : 'Show rust-analyzer setup guidance'
  }

  const verb = action === 'enable-plugin' ? 'Enable' : 'Install'
  if (!serverReady && canAutoInstallServer) {
    return (
      <Text>
        {verb} <Text bold>{pluginName}</Text> and rust-analyzer
      </Text>
    )
  }
  return (
    <Text>
      {verb} <Text bold>{pluginName}</Text>
    </Text>
  )
}

export function LspRecommendationMenu(props: Props): React.ReactNode {
  const {
    pluginName,
    pluginDescription,
    fileExtension,
    action,
    serverReady,
    canAutoInstallServer,
    onResponse,
  } = props
  const onResponseRef = React.useRef(onResponse)
  onResponseRef.current = onResponse

  React.useEffect(() => {
    const timeoutId = setTimeout(
      (ref) => ref.current('no'),
      AUTO_DISMISS_MS,
      onResponseRef,
    )
    return () => clearTimeout(timeoutId)
  }, [])

  const options = [
    {
      label: setupLabel({
        pluginName,
        action,
        serverReady,
        canAutoInstallServer,
      }),
      value: 'yes',
    },
    { label: 'No, not now', value: 'no' },
    {
      label: (
        <Text>
          Never for <Text bold>{pluginName}</Text>
        </Text>
      ),
      value: 'never',
    },
    { label: 'Disable all LSP recommendations', value: 'disable' },
  ]

  return (
    <PermissionDialog title="LSP Setup">
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Box marginBottom={1}>
          <Text dimColor>
            LSP provides diagnostics, code navigation, and completion
          </Text>
        </Box>
        <Box>
          <Text dimColor>Plugin:</Text>
          <Text> {pluginName}</Text>
        </Box>
        {pluginDescription && (
          <Box>
            <Text dimColor>{pluginDescription}</Text>
          </Box>
        )}
        <Box>
          <Text dimColor>Triggered by:</Text>
          <Text> {fileExtension} files</Text>
        </Box>
        <Box marginTop={1}>
          <Text>Would you like Tau to configure this LSP?</Text>
        </Box>
        <Box>
          <Select
            options={options}
            onChange={(value: string) => {
              if (
                value === 'yes' ||
                value === 'no' ||
                value === 'never' ||
                value === 'disable'
              ) {
                onResponse(value)
              }
            }}
            onCancel={() => onResponse('no')}
          />
        </Box>
      </Box>
    </PermissionDialog>
  )
}
