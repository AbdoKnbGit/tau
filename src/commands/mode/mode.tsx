import * as React from 'react'
import { useEffect, useState } from 'react'
import { Select } from '../../components/CustomSelect/index.js'
import { Pane } from '../../components/design-system/Pane.js'
import { Box, Text } from '../../ink.js'
import { clearSystemPromptSections } from '../../constants/systemPromptSections.js'
import { clearToolSchemaCache as clearAdapterToolSchemaCache } from '../../services/api/adapters/tool_schema_cache.js'
import {
  initializeLspServerManager,
  shutdownLspServerManager,
} from '../../services/lsp/manager.js'
import { getAgentDefinitionsWithOverrides } from '../../tools/AgentTool/loadAgentsDir.js'
import { clearToolSearchDescriptionCache } from '../../tools/ToolSearchTool/ToolSearchTool.js'
import type {
  CommandResultDisplay,
  LocalJSXCommandCall,
  LocalJSXCommandContext,
} from '../../types/command.js'
import { setPowerModeTheme } from '../../utils/modeTheme.js'
import {
  getPowerModeFromSettings,
  normalizePowerMode,
  POWER_MODE_DESCRIPTIONS,
  POWER_MODE_LABELS,
  SELECTABLE_POWER_MODES,
  setSessionPowerMode,
  type PowerMode,
} from '../../utils/powerMode.js'
import {
  getInitialSettings,
  updateSettingsForSource,
} from '../../utils/settings/settings.js'
import { skillChangeDetector } from '../../utils/skills/skillChangeDetector.js'
import { clearToolSchemaCache } from '../../utils/toolSchemaCache.js'

type OnDone = (
  result?: string,
  options?: { display?: CommandResultDisplay },
) => void

const MODE_SUMMARY: Record<PowerMode, string> = {
  cheap:
    'core tools only — optional tools, skills, agents, plugins, MCP, and LSP are off and hidden from the model',
  normal: 'default behavior — your /tools toggles, MCP, skills, and LSP apply',
  full: 'everything on — all optional tools enabled (/tools hidden; saved toggles return in normal mode)',
}

function currentPowerMode(): PowerMode {
  return getPowerModeFromSettings(getInitialSettings())
}

/**
 * Apply a power mode change end-to-end: persist the setting, refresh the
 * reactive app state, drop every tool/command cache derived from the old
 * mode, start/stop LSP, and cross-fade the theme accents.
 *
 * The tool list changes once per switch (like toggling /tools), so the
 * prompt cache re-warms on the next message and then stays stable — the
 * mode itself never mutates request shape mid-conversation.
 */
function applyPowerMode(
  next: PowerMode,
  context: LocalJSXCommandContext,
): { error: string | null; changed: boolean } {
  const previous = currentPowerMode()
  if (next === previous) {
    return { error: null, changed: false }
  }

  const { error } = updateSettingsForSource('userSettings', {
    powerMode: next === 'normal' ? undefined : next,
  })
  if (error) {
    return { error: error.message, changed: false }
  }

  // Pin the new mode for THIS session. Persisting above sets the default for
  // the next launch; the pin makes the switch authoritative here and now so a
  // later external settings-file change (another session's /mode, delivered by
  // the file watcher) can't override it. Must run before setAppState so every
  // getPowerModeFromSettings reader — reactive or not — agrees immediately.
  setSessionPowerMode(next)

  // Reactive settings for hooks (tool pool, MCP connections, footer chip).
  context.setAppState(prev => ({
    ...prev,
    settings: {
      ...prev.settings,
      powerMode: next === 'normal' ? undefined : next,
    },
  }))

  // Tool-list-derived caches (same set /tools clears on toggle).
  clearToolSchemaCache()
  clearAdapterToolSchemaCache()
  clearToolSearchDescriptionCache()

  // System prompt sections are memoized until /clear|/compact; session
  // guidance embeds skills/agents/Skill-tool bullets derived from the tool
  // pool, so a mode switch must rebuild them or the model keeps seeing (or
  // missing) capabilities from the previous mode. This is part of the single
  // expected cache re-warm per switch.
  clearSystemPromptSections()

  // Command/skill/agent sources are memoized per session — drop them and
  // notify subscribers (REPL re-fetches the slash-command list).
  getAgentDefinitionsWithOverrides.cache?.clear?.()
  skillChangeDetector.notifyManualReload()

  // LSP lifecycle: cheap never runs language servers.
  if (next === 'cheap') {
    void shutdownLspServerManager()
  } else if (previous === 'cheap') {
    initializeLspServerManager()
  }

  // Cross-fade the accent palette (bronze / base / gold).
  setPowerModeTheme(next)

  return { error: null, changed: true }
}

function doneMessage(mode: PowerMode, changed: boolean): string {
  const label = POWER_MODE_LABELS[mode].toLowerCase()
  if (!changed) {
    return `Mode already set to ${label} — ${MODE_SUMMARY[mode]}`
  }
  return `Mode set to ${label} — ${MODE_SUMMARY[mode]}. Tool set updated; the prompt cache re-warms once on your next message.`
}

function PowerModePicker({
  onDone,
  context,
}: {
  onDone: OnDone
  context: LocalJSXCommandContext
}): React.ReactNode {
  const [initialMode] = useState<PowerMode>(currentPowerMode)
  const [focused, setFocused] = useState<PowerMode>(initialMode)

  // Cheap/normal are offered; 'full' is retired from the UI. If the
  // session is somehow still on 'full' (persisted setting), surface it as the
  // current option so the user can move off it — but never present it as a new
  // choice.
  const selectable = SELECTABLE_POWER_MODES as readonly PowerMode[]
  const visibleModes: PowerMode[] = selectable.includes(initialMode)
    ? [...selectable]
    : [initialMode, ...selectable]

  const options = visibleModes.map(mode => ({
    label:
      mode === initialMode
        ? `${POWER_MODE_LABELS[mode]} (current)`
        : POWER_MODE_LABELS[mode],
    value: mode,
  }))

  return (
    <Pane color="permission">
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text bold color="permission">
            Tau mode
          </Text>
          <Text dimColor>
            Choose how Tau operates — the identity and accent color preview as
            you move
          </Text>
        </Box>
        <Select
          options={options}
          defaultValue={initialMode}
          defaultFocusValue={initialMode}
          visibleOptionCount={options.length}
          onFocus={(value: string) => {
            const mode = value as PowerMode
            setFocused(mode)
            // Live palette preview — visual only, nothing persists until Enter.
            setPowerModeTheme(mode)
          }}
          onChange={(value: string) => {
            const mode = value as PowerMode
            const result = applyPowerMode(mode, context)
            if (result.error) {
              // Persist failed — restore the real palette before reporting.
              setPowerModeTheme(initialMode)
              onDone(`Failed to save power mode: ${result.error}`)
              return
            }
            onDone(doneMessage(mode, result.changed))
          }}
          onCancel={() => {
            setPowerModeTheme(initialMode)
            onDone('Power mode unchanged', { display: 'system' })
          }}
        />
        <Text dimColor>{POWER_MODE_DESCRIPTIONS[focused]}</Text>
      </Box>
    </Pane>
  )
}

/** Applies a directly-passed mode argument on mount, rendering nothing. */
function ApplyPowerMode({
  mode,
  onDone,
  context,
}: {
  mode: PowerMode
  onDone: OnDone
  context: LocalJSXCommandContext
}): React.ReactNode {
  useEffect(() => {
    const result = applyPowerMode(mode, context)
    if (result.error) {
      onDone(`Failed to save power mode: ${result.error}`)
      return
    }
    onDone(doneMessage(mode, result.changed))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- apply once on mount
  }, [])
  return null
}

export const call: LocalJSXCommandCall = async (onDone, context, args) => {
  const trimmed = (args ?? '').trim()
  if (trimmed.length > 0 && trimmed.toLowerCase() !== 'status') {
    const mode = normalizePowerMode(trimmed)
    if (!mode) {
      onDone(
        `Unknown mode '${trimmed}'. Use cheap or normal.`,
        { display: 'system' },
      )
      return null
    }
    return <ApplyPowerMode mode={mode} onDone={onDone} context={context} />
  }
  return <PowerModePicker onDone={onDone} context={context} />
}
