import { setMainLoopModelOverride } from '../../bootstrap/state.js'
import { parseEffortValue, type EffortValue } from '../effort.js'
import {
  modelSupportsReasoning,
  setOpenAIReasoningLevel,
  type OpenAIReasoningLevel,
} from '../model/openaiReasoning.js'
import { getAPIProvider, setActiveProvider } from '../model/providers.js'
import type { FallbackTarget } from './state.js'

const OPENAI_REASONING_LEVELS: readonly OpenAIReasoningLevel[] = [
  'none',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]

function isOpenAIReasoningLevel(
  value: EffortValue | undefined,
): value is OpenAIReasoningLevel {
  return (
    typeof value === 'string' &&
    (OPENAI_REASONING_LEVELS as readonly string[]).includes(value)
  )
}

export function applyFallbackTargetToRuntime(
  target: FallbackTarget,
): EffortValue | undefined {
  if (getAPIProvider() !== target.provider) {
    setActiveProvider(target.provider)
  }
  setMainLoopModelOverride(target.model)

  const effort = parseEffortValue(target.effort)
  if (target.provider === 'openai' && isOpenAIReasoningLevel(effort) && modelSupportsReasoning(target.model)) {
    setOpenAIReasoningLevel(effort)
  }
  return effort
}
