import chalk from 'chalk'
import * as React from 'react'
import { useMemo, useState } from 'react'

import {
  getPrebuiltToolToggleItem,
  PREBUILT_TOOL_TOGGLE_GROUPS,
  PREBUILT_TOOL_TOGGLE_ITEMS,
  type PrebuiltToolToggleGroup,
  type PrebuiltToolToggleItem,
} from '../../constants/prebuiltToolToggles.js'
import { Box, Text, useInput } from '../../ink.js'
import { clearToolSchemaCache as clearAdapterToolSchemaCache } from '../../services/api/adapters/tool_schema_cache.js'
import { getTools } from '../../tools.js'
import type {
  CommandResultDisplay,
  LocalJSXCommandCall,
  LocalJSXCommandContext,
} from '../../types/command.js'
import {
  getPowerModeFromSettings,
  isNormalToolingMode,
} from '../../utils/powerMode.js'
import {
  getDisabledPrebuiltToolIds,
  normalizeDisabledPrebuiltToolIds,
  setPrebuiltToolToggleEnabled,
} from '../../utils/prebuiltToolToggles.js'
import {
  getInitialSettings,
  updateSettingsForSource,
} from '../../utils/settings/settings.js'
import { clearToolSearchDescriptionCache } from '../../tools/ToolSearchTool/ToolSearchTool.js'
import { clearToolSchemaCache } from '../../utils/toolSchemaCache.js'

type OnDone = (
  result?: string,
  options?: { display?: CommandResultDisplay },
) => void

type Action = 'on' | 'off' | 'reset' | 'status' | 'help' | 'invalid'

type ParsedArgs =
  | { action: 'interactive' }
  | { action: Exclude<Action, 'invalid'>; name?: string }
  | { action: 'invalid'; message: string }

type ToolRow =
  | { kind: 'group'; group: PrebuiltToolToggleGroup }
  | { kind: 'tool'; item: PrebuiltToolToggleItem }

type PersistResult = {
  error: string | null
  disabled: string[]
  changed: boolean
}

const VISIBLE_ROWS = 14

function initialDisabledTools(): string[] {
  return normalizeDisabledPrebuiltToolIds(
    getInitialSettings().disabledPrebuiltTools,
  )
}

function disabledKey(disabled: readonly string[]): string {
  return disabled.join('\0')
}

function persistDisabledTools(
  disabledPrebuiltTools: readonly string[],
  context: LocalJSXCommandContext,
): PersistResult {
  const normalized = normalizeDisabledPrebuiltToolIds(disabledPrebuiltTools)
  const current = normalizeDisabledPrebuiltToolIds(
    getInitialSettings().disabledPrebuiltTools,
  )

  if (disabledKey(normalized) === disabledKey(current)) {
    return { error: null, disabled: normalized, changed: false }
  }

  const { error } = updateSettingsForSource('userSettings', {
    disabledPrebuiltTools: normalized.length > 0 ? normalized : undefined,
  })
  if (error) {
    return { error: error.message, disabled: current, changed: false }
  }

  clearToolSchemaCache()
  clearAdapterToolSchemaCache()
  clearToolSearchDescriptionCache()

  context.setAppState(prev => ({
    ...prev,
    settings: {
      ...prev.settings,
      disabledPrebuiltTools: normalized.length > 0 ? normalized : undefined,
    },
  }))

  return { error: null, disabled: normalized, changed: true }
}

function flattenRows(): ToolRow[] {
  return PREBUILT_TOOL_TOGGLE_GROUPS.flatMap(group => [
    { kind: 'group' as const, group },
    ...group.items.map(item => ({ kind: 'tool' as const, item })),
  ])
}

function firstToolIndex(rows: readonly ToolRow[]): number {
  return Math.max(0, rows.findIndex(row => row.kind === 'tool'))
}

function lastToolIndex(rows: readonly ToolRow[]): number {
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i]?.kind === 'tool') return i
  }
  return 0
}

function clampToTool(
  rows: readonly ToolRow[],
  desired: number,
  direction: 1 | -1,
): number {
  if (rows.length === 0) return 0
  let index = desired
  while (index >= 0 && index < rows.length && rows[index]?.kind !== 'tool') {
    index += direction
  }
  if (index < 0 || index >= rows.length) {
    return direction === 1 ? firstToolIndex(rows) : lastToolIndex(rows)
  }
  return index
}

function renderKnownToolsLine(): string {
  return `Toggleable tools: ${PREBUILT_TOOL_TOGGLE_ITEMS.map(item => item.id).join(', ')}`
}

function renderHelp(): string {
  return [
    `${chalk.bold('/tools')} - optional prebuilt tool toggles`,
    '',
    chalk.bold('Usage:'),
    `  ${chalk.cyan('/tools')}                 Open the interactive picker`,
    `  ${chalk.cyan('/tools on <name>')}       Turn one optional tool on`,
    `  ${chalk.cyan('/tools off <name>')}      Turn one optional tool off`,
    `  ${chalk.cyan('/tools on all')}          Turn all optional tools on`,
    `  ${chalk.cyan('/tools off all')}         Turn all optional tools off`,
    `  ${chalk.cyan('/tools status')}          Print current state`,
    `  ${chalk.cyan('/tools reset')}           Turn all optional tools on`,
    '',
    renderKnownToolsLine(),
    '',
    chalk.dim('Basic agent tools are fixed and are not toggleable.'),
  ].join('\n')
}

function renderStatus(context: LocalJSXCommandContext): string {
  const settings = getInitialSettings()
  const disabled = getDisabledPrebuiltToolIds(settings)
  const activeToolNames = new Set(
    getTools(context.getAppState().toolPermissionContext).map(tool => tool.name),
  )
  const lines: string[] = [
    'Optional prebuilt tools:',
    '  Use /tools for the interactive picker, /tools on <name>, or /tools off <name>.',
    '',
  ]

  for (const group of PREBUILT_TOOL_TOGGLE_GROUPS) {
    lines.push(`${group.label} (${group.items.length})`)
    for (const item of group.items) {
      const enabled = !disabled.has(item.id)
      const active = item.toolNames.some(name => activeToolNames.has(name))
      const inactiveNote =
        enabled && !active ? ' (not active in this environment)' : ''
      const switchText = enabled ? '\u25C0 on  \u25B6' : '\u25C0 off \u25B6'
      lines.push(`  ${switchText} ${pad(item.id, 20)} ${item.purpose}${inactiveNote}`)
    }
    lines.push('')
  }

  lines.push('Basic tools are fixed and are not listed here.')
  return lines.join('\n').trimEnd()
}

function parseArgs(args: string): ParsedArgs {
  const parts = args.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return { action: 'interactive' }

  const first = parts[0]!.toLowerCase()
  if (['help', '-h', '--help', '?'].includes(first)) return { action: 'help' }
  if (['list', 'status'].includes(first)) return { action: 'status' }
  if (first === 'reset') return { action: 'reset' }
  if (['enable', 'enabled', 'on'].includes(first)) {
    return { action: 'on', name: parts.slice(1).join(' ') }
  }
  if (['disable', 'disabled', 'off'].includes(first)) {
    return { action: 'off', name: parts.slice(1).join(' ') }
  }
  if (first === 'toggle') {
    return {
      action: 'invalid',
      message: 'Use /tools for interactive toggling, or /tools on <name> and /tools off <name>.',
    }
  }

  return {
    action: 'invalid',
    message: `Unknown /tools command "${parts[0]}".`,
  }
}

function applyNamedAction(
  parsed: Exclude<ParsedArgs, { action: 'interactive' | 'invalid' }>,
  context: LocalJSXCommandContext,
): string {
  if (parsed.action === 'help') return renderHelp()
  if (parsed.action === 'status') return renderStatus(context)

  if (parsed.action === 'reset') {
    const result = persistDisabledTools([], context)
    if (result.error) return result.error
    return [
      result.changed
        ? 'All optional prebuilt tools are ON.'
        : 'All optional prebuilt tools were already ON.',
      '',
      renderStatus(context),
    ].join('\n')
  }

  if (!parsed.name) {
    return [
      `Usage: /tools ${parsed.action} <tool-name>`,
      '',
      renderKnownToolsLine(),
    ].join('\n')
  }

  const normalizedName = parsed.name.toLowerCase()
  const nextDisabled =
    normalizedName === 'all'
      ? parsed.action === 'on'
        ? []
        : PREBUILT_TOOL_TOGGLE_ITEMS.map(item => item.id)
      : setPrebuiltToolToggleEnabled(
          getInitialSettings().disabledPrebuiltTools,
          parsed.name,
          parsed.action === 'on',
        )

  if (!nextDisabled) {
    return [
      `Cannot toggle "${parsed.name}". Basic agent tools are not toggleable.`,
      renderKnownToolsLine(),
    ].join('\n')
  }

  const item =
    normalizedName === 'all'
      ? null
      : getPrebuiltToolToggleItem(parsed.name)
  const result = persistDisabledTools(nextDisabled, context)
  if (result.error) return result.error

  const target =
    normalizedName === 'all' ? 'All optional prebuilt tools' : item?.id
  if (!result.changed) {
    return [
      `${target} ${normalizedName === 'all' ? 'were' : 'was'} already ${parsed.action === 'on' ? 'ON' : 'OFF'}.`,
      '',
      renderStatus(context),
    ].join('\n')
  }

  return [
    `${target} ${normalizedName === 'all' ? 'are' : 'is'} now ${parsed.action === 'on' ? 'ON' : 'OFF'}.`,
    '',
    renderStatus(context),
  ].join('\n')
}

function ToolsPicker({
  context,
  onDone,
}: {
  context: LocalJSXCommandContext
  onDone: OnDone
}) {
  const rows = useMemo(() => flattenRows(), [])
  const [selectedIndex, setSelectedIndex] = useState(() => firstToolIndex(rows))
  const [disabled, setDisabled] = useState<string[]>(initialDisabledTools)
  const [error, setError] = useState<string | null>(null)
  const [changed, setChanged] = useState(false)

  const disabledSet = useMemo(() => new Set(disabled), [disabled])
  const activeToolNames = useMemo(
    () =>
      new Set(
        getTools(context.getAppState().toolPermissionContext).map(
          tool => tool.name,
        ),
      ),
    [context, disabled],
  )

  const scrollOffset = useMemo(() => {
    const halfWindow = Math.floor(VISIBLE_ROWS / 2)
    const start = Math.max(0, selectedIndex - halfWindow)
    return Math.min(start, Math.max(0, rows.length - VISIBLE_ROWS))
  }, [rows.length, selectedIndex])

  const visibleRows = rows.slice(scrollOffset, scrollOffset + VISIBLE_ROWS)

  function persist(nextDisabled: readonly string[]): boolean {
    const result = persistDisabledTools(nextDisabled, context)
    if (result.error) {
      setError(result.error)
      return false
    }
    setError(null)
    if (result.changed) setChanged(true)
    setDisabled(result.disabled)
    return true
  }

  function setSelectedToolEnabled(enabled: boolean): void {
    const row = rows[selectedIndex]
    if (!row || row.kind !== 'tool') return

    const nextDisabled = setPrebuiltToolToggleEnabled(
      disabled,
      row.item.id,
      enabled,
    )
    if (nextDisabled) persist(nextDisabled)
  }

  function toggleSelectedTool(): void {
    const row = rows[selectedIndex]
    if (!row || row.kind !== 'tool') return
    setSelectedToolEnabled(disabledSet.has(row.item.id))
  }

  useInput((input, key) => {
    if (key.escape || input === 'q') {
      onDone(changed ? 'Tool toggles updated.' : 'Tool toggles unchanged.', {
        display: 'system',
      })
      return
    }

    if (key.upArrow) {
      setSelectedIndex(index => {
        let next = index - 1
        if (next < 0) next = rows.length - 1
        return clampToTool(rows, next, -1)
      })
      return
    }

    if (key.downArrow) {
      setSelectedIndex(index => {
        let next = index + 1
        if (next >= rows.length) next = 0
        return clampToTool(rows, next, 1)
      })
      return
    }

    if (key.pageUp) {
      setSelectedIndex(index =>
        clampToTool(rows, Math.max(0, index - VISIBLE_ROWS), -1),
      )
      return
    }

    if (key.pageDown) {
      setSelectedIndex(index =>
        clampToTool(
          rows,
          Math.min(rows.length - 1, index + VISIBLE_ROWS),
          1,
        ),
      )
      return
    }

    if (key.leftArrow) {
      setSelectedToolEnabled(false)
      return
    }

    if (key.rightArrow) {
      setSelectedToolEnabled(true)
      return
    }

    if (key.return || input === ' ') {
      toggleSelectedTool()
      return
    }

    if (input === 'r') {
      persist([])
    }
  })

  return (
    <Box flexDirection="column" paddingLeft={1}>
      <Box marginBottom={1} flexDirection="column">
        <Text bold color="claude">
          Optional Prebuilt Tools
        </Text>
        <Text dimColor>
          Up/Down navigate | Enter/Space toggle | Left off | Right on | r reset all | Esc close
        </Text>
      </Box>

      {error && (
        <Box marginBottom={1}>
          <Text color="error">{error}</Text>
        </Box>
      )}

      <Box flexDirection="column">
        {visibleRows.map((row, offset) => {
          const actualIndex = scrollOffset + offset
          if (row.kind === 'group') {
            return (
              <Box key={`group-${row.group.label}`} marginTop={actualIndex === 0 ? 0 : 1}>
                <Text bold color="claude">
                  {row.group.label}
                </Text>
                <Text dimColor> ({row.group.items.length})</Text>
              </Box>
            )
          }

          const selected = actualIndex === selectedIndex
          const enabled = !disabledSet.has(row.item.id)
          const active = row.item.toolNames.some(name => activeToolNames.has(name))
          const switchText = enabled ? '\u25C0 on  \u25B6' : '\u25C0 off \u25B6'

          return (
            <Box key={row.item.id}>
              <Text bold={selected} color={selected ? 'claude' : undefined} dimColor={!selected}>
                {selected ? '> ' : '  '}
                {switchText} {pad(row.item.id, 20)}
              </Text>
              <Text dimColor={!selected}> {row.item.purpose}</Text>
              {enabled && !active && (
                <Text color="warning"> not active here</Text>
              )}
            </Box>
          )
        })}
      </Box>

      <Box marginTop={1}>
        <Text dimColor>
          Showing {scrollOffset + 1}-{Math.min(scrollOffset + visibleRows.length, rows.length)} of {rows.length}. Basic tools are fixed.
        </Text>
      </Box>
    </Box>
  )
}

function pad(value: string, width: number): string {
  return value + ' '.repeat(Math.max(0, width - value.length))
}

export const call: LocalJSXCommandCall = async (onDone, context, args) => {
  // /tools applies in normal-compatible modes; cheap/full force the toggle
  // state wholesale. Guard direct invocation in forcing modes too (e.g. typed
  // before the command list refreshed after a /mode switch).
  const powerMode = getPowerModeFromSettings(getInitialSettings())
  if (!isNormalToolingMode(powerMode)) {
    onDone(
      `Mode '${powerMode}' forces all optional tools ${powerMode === 'cheap' ? 'OFF' : 'ON'} — /tools applies in normal mode. Switch with /mode normal.`,
      { display: 'system' },
    )
    return
  }

  const parsed = parseArgs(args ?? '')

  if (parsed.action === 'interactive') {
    return <ToolsPicker context={context} onDone={onDone} />
  }

  if (parsed.action === 'invalid') {
    onDone([parsed.message, '', renderHelp()].join('\n'), { display: 'system' })
    return
  }

  onDone(applyNamedAction(parsed, context), { display: 'system' })
}
