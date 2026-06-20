import * as React from 'react'
import path from 'path'
import { homedir } from 'os'
import { Box, Text } from 'src/ink.js'
import { getCwd } from '../../utils/cwd.js'
import type { MCPServerConnection } from '../../services/mcp/types.js'

type Props = {
  mcpClients?: MCPServerConnection[]
}

function shortenCwd(cwd: string): string {
  const home = homedir()
  if (home && (cwd === home || cwd.startsWith(home + path.sep))) {
    return '~' + cwd.slice(home.length)
  }
  return cwd
}

export function PromptInputStatusBar(_props: Props): React.ReactNode {
  const cwd = shortenCwd(getCwd())

  return (
    <Box flexDirection="row" paddingX={2} flexShrink={0}>
      <Text color="textMuted" wrap="truncate">
        {cwd}
      </Text>
    </Box>
  )
}
