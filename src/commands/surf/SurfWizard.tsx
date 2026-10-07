/**
 * Surf first-run wizard — walks the user through picking a
 * provider+model (+ optional native effort) for each of the 7 phases:
 * planning → building → reviewing → thinking → subagent → longContext →
 * background.
 *
 * Each phase is a two-step sub-flow:
 *   1. ProviderModelPicker — pick the provider + model (or press 's' to skip
 *      this phase entirely, leaving the user's manual model active when
 *      surf routes into it).
 *   2. Effort picker — shown only when the selected model supports
 *      provider-native effort/reasoning (Anthropic Opus 4.6, OpenAI
 *      reasoning models). ← / → to cycle, Enter to confirm, 's' to skip.
 *      Skipping effort keeps the model's default.
 *
 * Re-run /surf config to walk the wizard again without toggling.
 */

import * as React from 'react'
import { useMemo, useState } from 'react'
import chalk from 'chalk'
import { Box, Text, useInput } from '../../ink.js'
import { ProviderModelPicker } from '../../components/ProviderModelPicker.js'
import type { CommandResultDisplay } from '../../commands.js'
import { saveGlobalConfig } from '../../utils/config.js'
import type { BrowsableModelProvider } from '../../utils/model/providerCatalog.js'
import {
  PROVIDER_DISPLAY_NAMES,
  type APIProvider,
} from '../../utils/model/providers.js'
import {
  modelSupportsEffort,
  modelSupportsXHighEffort,
} from '../../utils/effort.js'
import {
  modelSupportsReasoning,
  getAllReasoningLevels,
  type OpenAIReasoningLevel,
} from '../../utils/model/openaiReasoning.js'
import {
  SURF_PHASES,
  setCurrentSurfPhase,
  setSurfEnabled,
  type PhaseEffort,
  type SurfPhase,
} from '../../utils/surf/state.js'

const PHASE_LABEL: Record<SurfPhase, string> = {
  planning: 'Planning',
  building: 'Building',
  reviewing: 'Reviewing',
  thinking: 'Thinking',
  subagent: 'Subagent',
  longContext: 'Long Context',
  background: 'Background',
}

const PHASE_DESCRIPTION: Record<SurfPhase, string> = {
  planning: 'strongest reasoning — planning, architecting, open-ended problems',
  building: 'fast code writer — edits, file creation, tool-heavy turns',
  reviewing: 'critical eye — review/audit/verification passes',
  thinking:
    'deep reasoning — "think hard"/ultrathink/root-cause analysis turns',
  subagent: 'spawns from AgentTool — exploration, parallel research',
  longContext:
    'transcript > 60k tokens — routes to a long-context-capable model',
  background: 'quick & cheap — short questions, confirmations, idle chat',
}

/** Ordered effort levels for each effort-aware provider family.
 *  null sentinel = "skip / use model default". */
const ANTHROPIC_STANDARD_EFFORTS = ['low', 'medium', 'high', 'max'] as const
const ANTHROPIC_OPUS_EFFORTS = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const

type Props = {
  onDone: (
    result?: string,
    options?: { display?: CommandResultDisplay },
  ) => void
  initialProvider: BrowsableModelProvider
}

type Pick = { provider: APIProvider; model: string; effort?: PhaseEffort }
type Picks = Partial<Record<SurfPhase, Pick>>
type Step = 'model' | 'effort'

/** Which effort taxonomy (if any) applies to the picked provider+model.
 *  Returns null when this combo has no user-selectable effort knob. */
function effortOptionsFor(
  provider: APIProvider,
  model: string,
): readonly string[] | null {
  // OpenAI reasoning models have their own reasoning_effort taxonomy.
  if (provider === 'openai' && modelSupportsReasoning(model)) return getAllReasoningLevels(model)
  // Anthropic low/medium/high/max — modelSupportsEffort already gates on
  // provider + model combo, so we reuse it here.
  if (provider === 'firstParty' && modelSupportsEffort(model)) {
    return modelSupportsXHighEffort(model)
      ? ANTHROPIC_OPUS_EFFORTS
      : ANTHROPIC_STANDARD_EFFORTS
  }
  // Other providers (Ollama, Gemini, Qwen, Codex-via-OpenAI-without-reasoning)
  // — no user-selectable effort in the surf wizard. Model default is used.
  return null
}

export function SurfWizard({ onDone, initialProvider }: Props) {
  const [stepIndex, setStepIndex] = useState(0)
  const [step, setStep] = useState<Step>('model')
  const [picks, setPicks] = useState<Picks>({})
  const [pendingPick, setPendingPick] = useState<Pick | null>(null)
  const [effortIndex, setEffortIndex] = useState(0)

  const currentPhase = SURF_PHASES[stepIndex]
  if (!currentPhase) return null

  const effortOptions = useMemo(() => {
    if (!pendingPick) return null
    return effortOptionsFor(pendingPick.provider, pendingPick.model)
  }, [pendingPick])

  function advance(nextPicks: Picks) {
    if (stepIndex < SURF_PHASES.length - 1) {
      setPicks(nextPicks)
      setStepIndex(stepIndex + 1)
      setStep('model')
      setPendingPick(null)
      setEffortIndex(0)
      return
    }
    finalize(nextPicks)
  }

  function finalize(nextPicks: Picks) {
    // Only save phases the user actually configured — skipped phases stay
    // undefined in the saved map so the runtime keeps the user's manual
    // model when routing into them (partial configs are a supported mode).
    const fullTargets: Record<
      string,
      { provider: string; model: string; effort?: string | number }
    > = {}
    for (const phase of SURF_PHASES) {
      const pick = nextPicks[phase]
      if (pick) {
        fullTargets[phase] = {
          provider: pick.provider,
          model: pick.model,
          ...(pick.effort !== undefined ? { effort: pick.effort } : {}),
        }
      }
    }

    saveGlobalConfig(current => ({
      ...current,
      surfPhaseTargets: fullTargets as typeof current.surfPhaseTargets,
    }))
    setSurfEnabled(true)
    setCurrentSurfPhase(null)

    const configuredPhases = SURF_PHASES.filter(p => nextPicks[p])
    const lines = [
      `${chalk.bold('🌊 Surf enabled.')} Phase router will switch models each turn.`,
      '',
      ...configuredPhases.map(phase => {
        const pick = nextPicks[phase]!
        const effortLabel =
          pick.effort !== undefined ? chalk.dim(` · ${pick.effort}`) : ''
        return `  ${chalk.cyan(PHASE_LABEL[phase].padEnd(13))} ${chalk.bold(
          PROVIDER_DISPLAY_NAMES[pick.provider as APIProvider],
        )} · ${pick.model}${effortLabel}`
      }),
      ...(configuredPhases.length < SURF_PHASES.length
        ? [
            '',
            chalk.dim(
              `Skipped: ${SURF_PHASES.filter(p => !nextPicks[p])
                .map(p => PHASE_LABEL[p])
                .join(', ')} (keep current model when surf detects these)`,
            ),
          ]
        : []),
      '',
      chalk.dim(
        'Run /surf to toggle off, /surf status to inspect, /surf config to re-pick.',
      ),
    ]
    onDone(lines.join('\n'))
  }

  function handleModelSelected(
    provider: BrowsableModelProvider,
    modelId: string,
    openaiEffort?: OpenAIReasoningLevel,
  ) {
    const pick: Pick = { provider, model: modelId }
    const options = effortOptionsFor(provider, modelId)
    if (!options) {
      // No effort knob for this model — record the pick as-is and move on.
      advance({ ...picks, [currentPhase!]: pick })
      return
    }
    // Move to effort picker; default to 'medium' (or index 1).
    const defaultIdx = Math.max(0, options.indexOf(openaiEffort ?? 'medium'))
    setPendingPick(pick)
    setEffortIndex(defaultIdx)
    setStep('effort')
  }

  function handleModelCancel() {
    // 's' to skip is handled inside useInput below; Esc from the
    // ProviderModelPicker lands here and cancels the whole wizard.
    onDone('Surf setup cancelled', { display: 'system' })
  }

  function handleSkipPhase() {
    // Record nothing for this phase — leaves it undefined in saved config.
    advance({ ...picks })
  }

  useInput((input, key) => {
    if (step === 'model') {
      // 's' while on the model step = skip this phase. The inner picker
      // owns arrow/enter handling; we only intercept the skip shortcut.
      if (input.toLowerCase() === 's') {
        handleSkipPhase()
      }
      return
    }

    if (step === 'effort' && effortOptions && pendingPick) {
      if (key.leftArrow) {
        setEffortIndex(prev => (prev - 1 + effortOptions.length) % effortOptions.length)
        return
      }
      if (key.rightArrow) {
        setEffortIndex(prev => (prev + 1) % effortOptions.length)
        return
      }
      if (key.return) {
        const chosen = effortOptions[effortIndex]
        advance({
          ...picks,
          [currentPhase!]: { ...pendingPick, effort: chosen },
        })
        return
      }
      if (input.toLowerCase() === 's' || key.escape) {
        advance({ ...picks, [currentPhase!]: pendingPick })
        return
      }
    }
  })

  return (
    <Box flexDirection="column" paddingLeft={1}>
      <Box marginBottom={1} flexDirection="column">
        <Text bold color="claude">
          🌊 Surf setup — step {stepIndex + 1} of {SURF_PHASES.length}
        </Text>
        <Text>
          Pick the model for <Text bold>{PHASE_LABEL[currentPhase]}</Text>{' '}
          <Text dimColor>({PHASE_DESCRIPTION[currentPhase]})</Text>
        </Text>
        {step === 'model' && (
          <Text dimColor>
            Press <Text bold>s</Text> to skip this phase (keep current model
            when surf detects it).
          </Text>
        )}
      </Box>

      {step === 'model' && (
        <ProviderModelPicker
          initialProvider={initialProvider}
          onSelect={handleModelSelected}
          onCancel={handleModelCancel}
        />
      )}

      {step === 'effort' && pendingPick && effortOptions && (
        <Box flexDirection="column">
          <Text>
            Native effort for <Text bold>{pendingPick.model}</Text>:{' '}
            {effortOptions.map((opt, i) => (
              <Text key={opt} bold={i === effortIndex} inverse={i === effortIndex}>
                {' '}
                {opt}{' '}
              </Text>
            ))}
          </Text>
          <Text dimColor>
            ← / → cycle · Enter confirm · s / Esc skip (use model default)
          </Text>
        </Box>
      )}
    </Box>
  )
}
