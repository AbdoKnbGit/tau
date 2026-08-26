import * as React from 'react'
import { Box, Text } from 'src/ink.js'
import { getSdkBetas } from '../../bootstrap/state.js'
import { useSettings } from '../../hooks/useSettings.js'
import { sessionStatusBarShouldDisplay } from '../StatusLine.js'
import { useMainLoopModel } from '../../hooks/useMainLoopModel.js'
import { analyzeContext } from '../../utils/contextAnalysis.js'
import { getContextWindowForModel } from '../../utils/context.js'
import { getCwd } from '../../utils/cwd.js'
import { modelDisplayStringForProvider } from '../../utils/model/display.js'
import {
  getAPIProvider,
  PROVIDER_DISPLAY_NAMES,
} from '../../utils/model/providers.js'
import {
  calculateConsumedContextPercentage,
  formatSessionStatus,
  shortenSessionCwd,
} from './sessionStatus.js'

type Props = {
  messages: Parameters<typeof analyzeContext>[0]
  columns: number
}

export function PromptInputStatusBar({
  messages,
  columns,
}: Props): React.ReactNode {
  // Hidden when the user runs a custom statusLine command instead, or turns
  // the bar off with sessionStatusBar: false. See statusLineDisplay.ts.
  const settings = useSettings()
  const visible = sessionStatusBarShouldDisplay(settings)
  const mainLoopModel = useMainLoopModel()
  const provider = getAPIProvider()
  const contextWindow = getContextWindowForModel(mainLoopModel, getSdkBetas())
  const usedContextTokens = React.useMemo(() => {
    // Skip the scan entirely while hidden - it walks every message.
    if (!visible) return null
    try {
      // Count only conversation content that consumes the initially free
      // portion of the window. System prompts, tool schemas, and skill
      // frontmatter are injected separately and are deliberately excluded.
      return analyzeContext(messages).total
    } catch {
      // A status-only estimate must never make the prompt unusable.
      return null
    }
  }, [messages, visible])
  // Every hook above runs unconditionally; the rest is plain formatting work
  // there is no reason to do while the bar is hidden.
  if (!visible) return null

  const cwd = shortenSessionCwd(getCwd())
  const status = formatSessionStatus(
    {
      cwd,
      provider: PROVIDER_DISPLAY_NAMES[provider],
      model: modelDisplayStringForProvider(mainLoopModel, provider),
      usedContextTokens,
      contextWindowTokens: contextWindow,
      consumedContextPercentage:
        usedContextTokens === null
          ? null
          : calculateConsumedContextPercentage(usedContextTokens, contextWindow),
    },
    columns,
  )
  if (!status) return null

  return (
    <Box flexDirection="row" paddingX={2} flexShrink={0} overflowX="hidden">
      <Text color="textMuted" dimColor wrap="truncate">
        {status}
      </Text>
    </Box>
  )
}
