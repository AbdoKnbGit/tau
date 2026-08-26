import chalk from 'chalk'
import * as React from 'react'
import { useMainLoopModel } from '../../hooks/useMainLoopModel.js'
import { useAppState, useSetAppState } from '../../state/AppState.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import {
  modelSupportsThinking,
} from '../../utils/thinking.js'
import {
  getAPIProvider,
  isThirdPartyProvider,
} from '../../utils/model/providers.js'

/**
 * Static whitelist of third-party models known to support a
 * thinking/reasoning parameter. When thinking is enabled for a model
 * NOT in this list, the request is sent normally without the thinking
 * param — no crash, no error.
 */
const THIRD_PARTY_THINKING_MODELS: Record<string, string[]> = {
  // V4 thinking is owned by the model picker (utils/model/deepseekThinking.ts),
  // not this command, and deepseek-reasoner was retired on 2026-07-24.
  deepseek: [],
  moonshot: ['kimi-k2.6', 'kimi-k2.5', 'kimi-k2-thinking', 'kimi-k2-thinking-turbo'],
  nim: ['moonshotai/kimi-k2-thinking', 'kimi-k2-thinking'],
  openrouter: [
    'anthropic/claude-opus-4-6',
    'anthropic/claude-sonnet-4-6',
    'anthropic/claude-sonnet-4-5',
    'deepseek/deepseek-r1',
  ],
  groq: ['deepseek-r1-distill-llama-70b', 'deepseek-r1-distill-qwen-32b'],
}

function currentModelSupportsThinking(model: string): boolean {
  const provider = getAPIProvider()
  if (!isThirdPartyProvider(provider)) {
    return modelSupportsThinking(model)
  }
  const models = THIRD_PARTY_THINKING_MODELS[provider]
  if (!models) return false
  return models.some(m => model.includes(m))
}

function showHelp(
  onDone: (result?: string, options?: { display?: 'system' }) => void,
) {
  const lines = [
    `${chalk.bold('/thinking')} - Toggle thinking mode`,
    '',
    chalk.bold('Usage:'),
    `  ${chalk.cyan('/thinking')}       Toggle thinking on/off`,
    `  ${chalk.cyan('/thinking on')}    Enable thinking`,
    `  ${chalk.cyan('/thinking off')}   Disable thinking`,
    '',
    chalk.bold('Decision matrix:'),
    `  ${chalk.dim('thinking=on  + model supports it')}    ${chalk.green('->')} Thinking enabled`,
    `  ${chalk.dim('thinking=on  + model lacks support')}  ${chalk.yellow('->')} Sent normally (param omitted)`,
    `  ${chalk.dim('thinking=off + any model')}            ${chalk.blue('->')} No thinking param sent`,
    '',
    chalk.dim('Thinking allows the model to reason step-by-step before answering.'),
    chalk.dim('Supported: Tau 4+ (1P), DeepSeek Reasoner, Kimi K2 Thinking.'),
  ]
  onDone(lines.join('\n'), { display: 'system' })
}

function parseTargetState(
  args: string,
  currentEnabled: boolean,
): boolean | null {
  switch (args) {
    case 'on':
    case 'true':
    case '1':
      return true
    case 'off':
    case 'false':
    case '0':
      return false
    case '':
      return !currentEnabled
    default:
      return null // invalid
  }
}

function ApplyThinkingAndClose({
  newEnabled,
  onDone,
}: {
  newEnabled: boolean
  onDone: (result?: string) => void
}) {
  const setAppState = useSetAppState()
  const model = useMainLoopModel()

  // Capture latest refs so the effect deps can stay empty — prevents
  // re-fires when the parent re-renders with a new `onDone` closure.
  const onDoneRef = React.useRef(onDone)
  const modelRef = React.useRef(model)
  const setAppStateRef = React.useRef(setAppState)
  const newEnabledRef = React.useRef(newEnabled)
  onDoneRef.current = onDone
  modelRef.current = model
  setAppStateRef.current = setAppState
  newEnabledRef.current = newEnabled

  const hasFiredRef = React.useRef(false)

  React.useEffect(() => {
    if (hasFiredRef.current) return
    hasFiredRef.current = true

    const enabled = newEnabledRef.current
    const currentModel = modelRef.current
    setAppStateRef.current(prev => ({ ...prev, thinkingEnabled: enabled }))

    const supportsIt = currentModelSupportsThinking(currentModel)
    const stateLabel = enabled ? chalk.green('ON') : chalk.red('OFF')
    const modelLabel = chalk.bold(currentModel || 'unknown')

    const lines = [`Thinking mode: ${stateLabel}`]

    if (enabled && !supportsIt) {
      lines.push(
        chalk.yellow(
          `Note: ${modelLabel} does not support thinking. Requests will be sent normally.`,
        ),
      )
      const provider = getAPIProvider()
      if (isThirdPartyProvider(provider)) {
        lines.push(
          chalk.dim(
            'Thinking-capable models: DeepSeek Reasoner, Kimi K2 Thinking, Tau 4+ (via OpenRouter).',
          ),
        )
      }
    } else if (enabled && supportsIt) {
      lines.push(
        chalk.dim(
          `${modelLabel} supports thinking — the model will reason step-by-step.`,
        ),
      )
    }

    onDoneRef.current(lines.join('\n'))
  }, [])

  return null
}

function ShowCurrentThinking({
  onDone,
}: {
  onDone: (result?: string) => void
}) {
  const thinkingEnabled = useAppState((s: any) => s.thinkingEnabled)
  const model = useMainLoopModel()

  const onDoneRef = React.useRef(onDone)
  onDoneRef.current = onDone
  const thinkingEnabledRef = React.useRef(thinkingEnabled)
  thinkingEnabledRef.current = thinkingEnabled
  const modelRef = React.useRef(model)
  modelRef.current = model

  const hasFiredRef = React.useRef(false)

  React.useEffect(() => {
    if (hasFiredRef.current) return
    hasFiredRef.current = true

    const currentModel = modelRef.current
    const supportsIt = currentModelSupportsThinking(currentModel)
    const stateLabel = thinkingEnabledRef.current
      ? chalk.green('ON')
      : chalk.red('OFF')
    const supportLabel = supportsIt
      ? chalk.green('supported')
      : chalk.yellow('not supported')

    onDoneRef.current(
      `Thinking: ${stateLabel} | Current model (${chalk.bold(currentModel)}): ${supportLabel}`,
    )
  }, [])

  return null
}

export const call: LocalJSXCommandCall = async (onDone, _context, args) => {
  const trimmedArgs = args?.trim().toLowerCase() || ''

  if (['help', '-h', '--help', '?'].includes(trimmedArgs)) {
    showHelp(onDone)
    return
  }

  if (trimmedArgs === 'status') {
    return <ShowCurrentThinking onDone={onDone} />
  }

  // We need access to current thinkingEnabled to toggle, so use a React component
  return <ThinkingToggler args={trimmedArgs} onDone={onDone} />
}

function InvalidArgsNotice({
  args,
  onDone,
}: {
  args: string
  onDone: (result?: string, options?: { display?: 'system' }) => void
}) {
  const onDoneRef = React.useRef(onDone)
  onDoneRef.current = onDone
  const hasFiredRef = React.useRef(false)

  React.useEffect(() => {
    if (hasFiredRef.current) return
    hasFiredRef.current = true
    onDoneRef.current(
      `Unknown argument "${args}". Use ${chalk.cyan('/thinking on')}, ${chalk.cyan('/thinking off')}, or ${chalk.cyan('/thinking')} to toggle.`,
    )
  }, [])

  return null
}

function ThinkingToggler({
  args,
  onDone,
}: {
  args: string
  onDone: (result?: string, options?: { display?: 'system' }) => void
}) {
  const currentEnabled = (useAppState((s: any) => s.thinkingEnabled) ?? true) as boolean

  const newEnabled = parseTargetState(args, currentEnabled)
  if (newEnabled === null) {
    return <InvalidArgsNotice args={args} onDone={onDone} />
  }

  return <ApplyThinkingAndClose newEnabled={newEnabled} onDone={onDone} />
}
