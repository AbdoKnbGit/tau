/**
 * Detect files that can benefit from an LSP plugin and offer a one-time,
 * consent-based setup. Rust recommendations also verify the actual
 * rust-analyzer executable because a rustup proxy alone is not sufficient.
 */

import figures from 'figures'
import { extname, join } from 'path'
import * as React from 'react'
import {
  hasShownLspRecommendationThisSession,
  setLspRecommendationShownThisSession,
} from '../bootstrap/state.js'
import { useNotifications } from '../context/notifications.js'
import { Text } from '../ink.js'
import {
  installRustAnalyzerWithRustup,
  RUST_ANALYZER_PLUGIN_ID,
} from '../services/lsp/rustAnalyzerSetup.js'
import {
  type AppState,
  useAppState,
  useSetAppState,
} from '../state/AppState.js'
import { saveGlobalConfig } from '../utils/config.js'
import { logForDebugging } from '../utils/debug.js'
import { logError } from '../utils/log.js'
import {
  addToNeverSuggest,
  getMatchingLspPlugins,
  incrementIgnoredCount,
  type LspRecommendationAction,
} from '../utils/plugins/lspRecommendation.js'
import { cacheAndRegisterPlugin } from '../utils/plugins/pluginInstallationHelpers.js'
import { getPluginById } from '../utils/plugins/marketplaceManager.js'
import { isPluginBlockedByPolicy } from '../utils/plugins/pluginPolicy.js'
import { refreshActivePlugins } from '../utils/plugins/refresh.js'
import {
  getSettingsForSource,
  updateSettingsForSource,
} from '../utils/settings/settings.js'
import { usePluginRecommendationBase } from './usePluginRecommendationBase.js'

const TIMEOUT_THRESHOLD_MS = 28_000

export type LspRecommendationState = {
  pluginId: string
  pluginName: string
  pluginDescription?: string
  fileExtension: string
  action: LspRecommendationAction
  serverReady: boolean
  canAutoInstallServer: boolean
  shownAt: number
} | null

type Response = 'yes' | 'no' | 'never' | 'disable'

type UseLspPluginRecommendationResult = {
  recommendation: LspRecommendationState
  handleResponse: (response: Response) => void
}

export function useLspPluginRecommendation(): UseLspPluginRecommendationResult {
  const trackedFiles = useAppState(
    (s: AppState) => s.fileHistory.trackedFiles,
  ) as ReadonlySet<string>
  const setAppState = useSetAppState()
  const { addNotification } = useNotifications()
  const checkedFilesRef = React.useRef<Set<string>>(new Set())
  const base = usePluginRecommendationBase() as {
    recommendation: LspRecommendationState
    clearRecommendation: () => void
    tryResolve: (
      resolve: () => Promise<NonNullable<LspRecommendationState> | null>,
    ) => void
  }
  const { recommendation, clearRecommendation, tryResolve } = base

  React.useEffect(() => {
    tryResolve(async () => {
      if (hasShownLspRecommendationThisSession()) return null

      const newFiles: string[] = []
      for (const file of trackedFiles) {
        if (!checkedFilesRef.current.has(file)) {
          checkedFilesRef.current.add(file)
          newFiles.push(file)
        }
      }

      for (const filePath of newFiles) {
        try {
          const match = (await getMatchingLspPlugins(filePath))[0]
          if (!match) continue

          logForDebugging(
            `[useLspPluginRecommendation] Found ${match.action}: ${match.pluginName} for ${filePath}`,
          )
          setLspRecommendationShownThisSession(true)
          return {
            pluginId: match.pluginId,
            pluginName: match.pluginName,
            pluginDescription: match.description,
            fileExtension: extname(filePath),
            action: match.action,
            serverReady: match.serverReady,
            canAutoInstallServer: match.canAutoInstallServer,
            shownAt: Date.now(),
          }
        } catch (error) {
          logError(error)
        }
      }
      return null
    })
  }, [trackedFiles, tryResolve])

  const configureLsp = React.useCallback(
    async (current: NonNullable<LspRecommendationState>): Promise<void> => {
      const {
        pluginId,
        pluginName,
        action,
        serverReady,
        canAutoInstallServer,
      } = current
      const isRust = pluginId === RUST_ANALYZER_PLUGIN_ID

      addNotification({
        key: 'lsp-setup-running',
        jsx: <Text>Configuring {pluginName}...</Text>,
        priority: 'immediate',
        timeoutMs: 5 * 60_000,
      })

      try {
        if (isPluginBlockedByPolicy(pluginId)) {
          throw new Error('this plugin is disabled by organization policy')
        }

        if (action === 'install-plugin') {
          const pluginData = await getPluginById(pluginId)
          if (!pluginData) {
            throw new Error(`Plugin ${pluginId} was not found in a marketplace`)
          }
          const localSourcePath =
            typeof pluginData.entry.source === 'string'
              ? join(
                  pluginData.marketplaceInstallLocation,
                  pluginData.entry.source,
                )
              : undefined
          await cacheAndRegisterPlugin(
            pluginId,
            pluginData.entry,
            'user',
            undefined,
            localSourcePath,
          )
        }

        if (action === 'install-plugin' || action === 'enable-plugin') {
          const settings = getSettingsForSource('userSettings')
          updateSettingsForSource('userSettings', {
            enabledPlugins: {
              ...settings?.enabledPlugins,
              [pluginId]: true,
            },
          })
        }

        let rustReady = serverReady
        if (isRust && !rustReady && canAutoInstallServer) {
          const result = await installRustAnalyzerWithRustup()
          rustReady = result.ready
          if (!rustReady) {
            throw new Error(
              result.detail ?? 'rust-analyzer component setup failed',
            )
          }
        }

        if (isRust && !rustReady) {
          await refreshActivePlugins(setAppState)
          addNotification({
            key: 'rust-lsp-manual-setup',
            invalidates: ['lsp-setup-running'],
            jsx: (
              <Text color="warning">
                {pluginName} enabled - install rust-analyzer with your Rust
                distribution, then retry
              </Text>
            ),
            priority: 'immediate',
            timeoutMs: 10_000,
          })
          return
        }

        await refreshActivePlugins(setAppState)
        addNotification({
          key: 'lsp-setup-ready',
          invalidates: ['lsp-setup-running'],
          jsx: (
            <Text color="success">
              {figures.tick} {pluginName} is ready in this session
            </Text>
          ),
          priority: 'immediate',
          timeoutMs: 6_000,
        })
      } catch (error) {
        logError(error)
        const rawDetail = error instanceof Error ? error.message : String(error)
        const detail =
          rawDetail.length > 240 ? `${rawDetail.slice(0, 237)}...` : rawDetail
        addNotification({
          key: 'lsp-setup-failed',
          invalidates: ['lsp-setup-running'],
          jsx: (
            <Text color="error">
              {figures.cross} Failed to configure {pluginName}: {detail}
            </Text>
          ),
          priority: 'immediate',
          timeoutMs: 10_000,
        })
      }
    },
    [addNotification, setAppState],
  )

  const handleResponse = React.useCallback(
    (response: Response): void => {
      if (!recommendation) return

      const { pluginId, pluginName, shownAt } = recommendation
      logForDebugging(
        `[useLspPluginRecommendation] User response: ${response} for ${pluginName}`,
      )

      switch (response) {
        case 'yes':
          void configureLsp(recommendation)
          break
        case 'no':
          if (Date.now() - shownAt >= TIMEOUT_THRESHOLD_MS) {
            incrementIgnoredCount()
          }
          break
        case 'never':
          addToNeverSuggest(pluginId)
          break
        case 'disable':
          saveGlobalConfig((current) => ({
            ...current,
            lspRecommendationDisabled: true,
          }))
          break
      }
      clearRecommendation()
    },
    [clearRecommendation, configureLsp, recommendation],
  )

  return { recommendation, handleResponse }
}
