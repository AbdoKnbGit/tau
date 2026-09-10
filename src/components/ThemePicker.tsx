import { feature } from 'bun:bundle'
import * as React from 'react'
import { useExitOnCtrlCDWithKeybindings } from '../hooks/useExitOnCtrlCDWithKeybindings.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import {
  Box,
  Text,
  usePreviewTheme,
  useTheme,
  useThemeSetting,
} from '../ink.js'
import { useRegisterKeybindingContext } from '../keybindings/KeybindingContext.js'
import { useKeybinding } from '../keybindings/useKeybinding.js'
import { useShortcutDisplay } from '../keybindings/useShortcutDisplay.js'
import { useAppState, useSetAppState } from '../state/AppState.js'
import { gracefulShutdown } from '../utils/gracefulShutdown.js'
import { updateSettingsForSource } from '../utils/settings/settings.js'
import { THEME_LABELS, THEME_NAMES, type ThemeSetting } from '../utils/theme.js'
import { Select } from './CustomSelect/index.js'
import { Byline } from './design-system/Byline.js'
import { KeyboardShortcutHint } from './design-system/KeyboardShortcutHint.js'
import {
  getColorModuleUnavailableReason,
  getSyntaxTheme,
} from './StructuredDiff/colorDiff.js'
import { StructuredDiff } from './StructuredDiff.js'

export type ThemePickerProps = {
  onThemeSelect: (setting: ThemeSetting) => void
  showIntroText?: boolean
  helpText?: string
  showHelpTextBelow?: boolean
  hideEscToCancel?: boolean
  showPreview?: boolean
  /** Skip exit handling when running in a context that already has it (e.g. onboarding). */
  skipExitHandling?: boolean
  /** Called when the user cancels with Escape. */
  onCancel?: () => void
}

export function ThemePicker({
  onThemeSelect,
  showIntroText = false,
  helpText = '',
  showHelpTextBelow = false,
  hideEscToCancel = false,
  showPreview = true,
  skipExitHandling = false,
  onCancel: onCancelProp,
}: ThemePickerProps): React.ReactNode {
  const [theme] = useTheme()
  const themeSetting = useThemeSetting()
  const { columns } = useTerminalSize()
  const colorModuleUnavailableReason = getColorModuleUnavailableReason()
  const syntaxTheme =
    colorModuleUnavailableReason === null ? getSyntaxTheme(theme) : null
  const { setPreviewTheme, savePreview, cancelPreview } = usePreviewTheme()
  const syntaxHighlightingDisabled =
    useAppState(s => s.settings.syntaxHighlightingDisabled) ?? false
  const setAppState = useSetAppState()

  useRegisterKeybindingContext('ThemePicker')

  const syntaxToggleShortcut = useShortcutDisplay(
    'theme:toggleSyntaxHighlighting',
    'ThemePicker',
    'ctrl+t',
  )

  useKeybinding(
    'theme:toggleSyntaxHighlighting',
    () => {
      if (colorModuleUnavailableReason === null) {
        const newValue = !syntaxHighlightingDisabled
        updateSettingsForSource('userSettings', {
          syntaxHighlightingDisabled: newValue,
        })
        setAppState(prev => ({
          ...prev,
          settings: {
            ...prev.settings,
            syntaxHighlightingDisabled: newValue,
          },
        }))
      }
    },
    { context: 'ThemePicker' },
  )

  const exitState = useExitOnCtrlCDWithKeybindings(
    skipExitHandling ? () => {} : undefined,
  )

  const themeOptions = [
    ...(feature('AUTO_THEME') ? [{ label: THEME_LABELS.auto, value: 'auto' as const }] : []),
    ...THEME_NAMES.map(value => ({ label: THEME_LABELS[value], value })),
  ]
  const selectedTheme = themeSetting === 'auto' ? theme : themeSetting

  const syntaxStatus =
    colorModuleUnavailableReason === 'env'
      ? `Syntax highlighting disabled (via CLAUDE_CODE_SYNTAX_HIGHLIGHT=${process.env.CLAUDE_CODE_SYNTAX_HIGHLIGHT})`
      : syntaxHighlightingDisabled
        ? `Syntax highlighting disabled (${syntaxToggleShortcut} to enable)`
        : syntaxTheme
          ? `Syntax theme: ${syntaxTheme.theme}${
              syntaxTheme.source ? ` (from ${syntaxTheme.source})` : ''
            } (${syntaxToggleShortcut} to disable)`
          : `Syntax highlighting enabled (${syntaxToggleShortcut} to disable)`

  const content = (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column" gap={1}>
        {showIntroText ? (
          <Text>Configure Tau.</Text>
        ) : (
          <Text bold color="permission">
            Theme
          </Text>
        )}
        <Box flexDirection="column">
          <Text bold>Choose the terminal theme for Tau</Text>
          {helpText && !showHelpTextBelow && <Text dimColor>{helpText}</Text>}
        </Box>
        <Select
          options={themeOptions}
          onFocus={setting => {
            setPreviewTheme(setting as ThemeSetting)
          }}
          onChange={(setting: string) => {
            savePreview()
            onThemeSelect(setting as ThemeSetting)
          }}
          onCancel={
            skipExitHandling
              ? () => {
                  cancelPreview()
                  onCancelProp?.()
                }
              : async () => {
                  cancelPreview()
                  await gracefulShutdown(0)
                }
          }
          visibleOptionCount={themeOptions.length}
          defaultValue={themeSetting}
          defaultFocusValue={selectedTheme}
        />
      </Box>

      {showPreview && (
        <Box flexDirection="column" width="100%">
          <Box borderStyle="round" borderColor="brand" paddingX={1} marginBottom={1}>
            <Text color="brand">❯ </Text>
            <Text color="text">Your prompt stays readable </Text>
            <Text color="text" inverse> </Text>
          </Box>
          <Text dimColor>Transparent input · silver, bronze, and gold mode accents</Text>
          <Box
            flexDirection="column"
            borderTop
            borderBottom
            borderLeft={false}
            borderRight={false}
            borderStyle="dashed"
            borderColor="subtle"
          >
            <StructuredDiff
              patch={{
                oldStart: 1,
                newStart: 1,
                oldLines: 4,
                newLines: 4,
                lines: [
                  ' const project = "tau"',
                  ' function previewTheme() {',
                  '-  console.log("default theme")',
                  '+  console.log("selected tau theme")',
                  ' }',
                ],
              }}
              dim={false}
              filePath="theme-preview.js"
              firstLine={null}
              width={columns}
            />
          </Box>
          <Text dimColor> {syntaxStatus}</Text>
        </Box>
      )}
    </Box>
  )

  if (!showIntroText) {
    return (
      <>
        <Box flexDirection="column">{content}</Box>
        <Box marginTop={1}>
          {showHelpTextBelow && helpText && (
            <Box marginLeft={3}>
              <Text dimColor>{helpText}</Text>
            </Box>
          )}
          {!hideEscToCancel && (
            <Box>
              <Text dimColor italic>
                {exitState.pending ? (
                  <>Press {exitState.keyName} again to exit</>
                ) : (
                  <Byline>
                    <KeyboardShortcutHint shortcut="Enter" action="select" />
                    <KeyboardShortcutHint shortcut="Esc" action="cancel" />
                  </Byline>
                )}
              </Text>
            </Box>
          )}
        </Box>
      </>
    )
  }

  return content
}
