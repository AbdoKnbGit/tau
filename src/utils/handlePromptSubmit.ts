import type { UUID } from 'crypto'
import { logEvent } from 'src/services/analytics/index.js'
import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from 'src/services/analytics/metadata.js'
import { type Command, getCommandName, isCommandEnabled } from '../commands.js'
import { selectableUserMessagesFilter } from '../components/MessageSelector.js'
import type { SpinnerMode } from '../components/Spinner/types.js'
import type { QuerySource } from '../constants/querySource.js'
import { expandPastedTextRefs, parseReferences } from '../history.js'
import type { CanUseToolFn } from '../hooks/useCanUseTool.js'
import type { IDESelection } from '../hooks/useIdeSelection.js'
import type { AppState } from '../state/AppState.js'
import type { SetToolJSXFn } from '../Tool.js'
import type { LocalJSXCommandOnDone } from '../types/command.js'
import type { Message } from '../types/message.js'
import {
  isValidImagePaste,
  type PromptInputMode,
  type QueuedCommand,
} from '../types/textInputTypes.js'
import { createAbortController } from './abortController.js'
import type { PastedContent } from './config.js'
import { logForDebugging } from './debug.js'
import type { EffortValue } from './effort.js'
import type { FileHistoryState } from './fileHistory.js'
import { fileHistoryEnabled, fileHistoryMakeSnapshot } from './fileHistory.js'
import { gracefulShutdownSync } from './gracefulShutdown.js'
import { enqueue } from './messageQueueManager.js'
import { resolveSkillModelOverride } from './model/model.js'
import type { ProcessUserInputContext } from './processUserInput/processUserInput.js'
import { processUserInput } from './processUserInput/processUserInput.js'
import type { QueryGuard } from './QueryGuard.js'
import { queryCheckpoint, startQueryProfile } from './queryProfiler.js'
import { createSystemMessage } from './messages.js'
import { buildSurfCacheBanner, runSurfPhaseHook } from './surf/applyPhase.js'
import {
  estimateTranscriptTokens,
  extractLastUserText,
  extractRecentToolNames,
} from './surf/extract.js'
import { isEffortLevel, type EffortLevel } from './effort.js'
import { runWithWorkload } from './workloadContext.js'

function exit(): void {
  gracefulShutdownSync(0)
}

const VOICE_MODE_RESPONSE_HINT = [
  'Voice mode instruction for the immediately preceding user request:',
  'Reply like a concise spoken conversation.',
  'Start with the practical short version in natural language.',
  'If the user asks about files or code, explain the main roles and relationships first; keep exhaustive file lists, code, and line-by-line detail for the screen.',
  'Do not answer with only "details are on screen".',
].join(' ')

type BaseExecutionParams = {
  queuedCommands?: QueuedCommand[]
  messages: Message[]
  mainLoopModel: string
  ideSelection: IDESelection | undefined
  querySource: QuerySource
  commands: Command[]
  queryGuard: QueryGuard
  /**
   * True when external loading (remote session, foregrounded background task)
   * is active. These don't route through queryGuard, so the queue check must
   * account for them separately. Omit (defaults to false) for the dequeue path
   * (executeQueuedInput) — dequeued items were already queued past this check.
   */
  isExternalLoading?: boolean
  setToolJSX: SetToolJSXFn
  getToolUseContext: (
    messages: Message[],
    newMessages: Message[],
    abortController: AbortController,
    mainLoopModel: string,
  ) => ProcessUserInputContext
  setUserInputOnProcessing: (prompt?: string) => void
  setAbortController: (abortController: AbortController | null) => void
  onQuery: (
    newMessages: Message[],
    abortController: AbortController,
    shouldQuery: boolean,
    additionalAllowedTools: string[],
    mainLoopModel: string,
    onBeforeQuery?: (input: string, newMessages: Message[]) => Promise<boolean>,
    input?: string,
    effort?: EffortValue,
  ) => Promise<void>
  setAppState: (updater: (prev: AppState) => AppState) => void
  onBeforeQuery?: (input: string, newMessages: Message[]) => Promise<boolean>
  canUseTool?: CanUseToolFn
  /**
   * Append messages to the REPL transcript. Used by the surf phase router
   * to inject a one-line banner when the active model switches. Optional
   * so headless paths (print.ts, tests) can skip passing it.
   */
  setMessages?: (updater: (prev: Message[]) => Message[]) => void
  voiceMode?: boolean
}

/**
 * Parameters for core execution logic (no UI concerns).
 */
type ExecuteUserInputParams = BaseExecutionParams & {
  resetHistory: () => void
  onInputChange: (value: string) => void
}

export type PromptInputHelpers = {
  setCursorOffset: (offset: number) => void
  clearBuffer: () => void
  resetHistory: () => void
}

export type HandlePromptSubmitParams = BaseExecutionParams & {
  // Direct user input path (set when called from onSubmit, absent for queue processor)
  input?: string
  mode?: PromptInputMode
  pastedContents?: Record<number, PastedContent>
  helpers: PromptInputHelpers
  onInputChange: (value: string) => void
  setPastedContents: React.Dispatch<
    React.SetStateAction<Record<number, PastedContent>>
  >
  abortController?: AbortController | null
  addNotification?: (notification: {
    key: string
    text: string
    priority: 'low' | 'medium' | 'high' | 'immediate'
  }) => void
  streamMode?: SpinnerMode
  hasInterruptibleToolInProgress?: boolean
  uuid?: UUID
  /**
   * When true, input starting with `/` is treated as plain text.
   * Used for remotely-received messages (bridge/CCR) that should not
   * trigger local slash commands or skills.
   */
  skipSlashCommands?: boolean
}

export async function handlePromptSubmit(
  params: HandlePromptSubmitParams,
): Promise<void> {
  const {
    helpers,
    queryGuard,
    isExternalLoading = false,
    commands,
    onInputChange,
    setPastedContents,
    setToolJSX,
    getToolUseContext,
    messages,
    mainLoopModel,
    ideSelection,
    setUserInputOnProcessing,
    setAbortController,
    onQuery,
    setAppState,
    onBeforeQuery,
    canUseTool,
    queuedCommands,
    uuid,
    skipSlashCommands,
  } = params

  const { setCursorOffset, clearBuffer, resetHistory } = helpers

  // Queue processor path: commands are pre-validated and ready to execute.
  // Skip all input validation, reference parsing, and queuing logic.
  if (queuedCommands?.length) {
    startQueryProfile()
    await executeUserInput({
      queuedCommands,
      messages,
      mainLoopModel,
      ideSelection,
      querySource: params.querySource,
      commands,
      queryGuard,
      setToolJSX,
      getToolUseContext,
      setUserInputOnProcessing,
      setAbortController,
      onQuery,
      setAppState,
      onBeforeQuery,
      resetHistory,
      canUseTool,
      onInputChange,
      setMessages: params.setMessages,
    })
    return
  }

  const input = params.input ?? ''
  const mode = params.mode ?? 'prompt'
  const rawPastedContents = params.pastedContents ?? {}

  // Images are only sent if their [Image #N] placeholder is still in the text.
  // Deleting the inline pill drops the image; orphaned entries are filtered here.
  const referencedIds = new Set(parseReferences(input).map(r => r.id))
  const pastedContents = Object.fromEntries(
    Object.entries(rawPastedContents).filter(
      ([, c]) => c.type !== 'image' || referencedIds.has(c.id),
    ),
  )

  const hasImages = Object.values(pastedContents).some(isValidImagePaste)
  if (input.trim() === '') {
    return
  }

  // Handle exit commands by triggering the exit command instead of direct process.exit
  // Skip for remote bridge messages — "exit" typed on iOS shouldn't kill the local session
  if (
    !skipSlashCommands &&
    ['exit', 'quit', ':q', ':q!', ':wq', ':wq!'].includes(input.trim())
  ) {
    // Trigger the exit command which will show the feedback dialog
    const exitCommand = commands.find(cmd => cmd.name === 'exit')
    if (exitCommand) {
      // Submit the /exit command instead - recursive call needs to be handled
      void handlePromptSubmit({
        ...params,
        input: '/exit',
      })
    } else {
      // Fallback to direct exit if exit command not found
      exit()
    }
    return
  }

  // Parse references and replace with actual content early, before queueing
  // or immediate-command dispatch, so queued commands and immediate commands
  // both receive the expanded text from when it was submitted.
  const finalInput = expandPastedTextRefs(input, pastedContents)
  const pastedTextRefs = parseReferences(input).filter(
    r => pastedContents[r.id]?.type === 'text',
  )
  const pastedTextCount = pastedTextRefs.length
  const pastedTextBytes = pastedTextRefs.reduce(
    (sum, r) => sum + (pastedContents[r.id]?.content.length ?? 0),
    0,
  )
  logEvent('tengu_paste_text', { pastedTextCount, pastedTextBytes })

  // Handle local-jsx immediate commands (e.g., /config, /doctor)
  // Skip for remote bridge messages — slash commands from CCR clients are plain text
  if (!skipSlashCommands && finalInput.trim().startsWith('/')) {
    const trimmedInput = finalInput.trim()
    const spaceIndex = trimmedInput.indexOf(' ')
    const commandName =
      spaceIndex === -1
        ? trimmedInput.slice(1)
        : trimmedInput.slice(1, spaceIndex)
    const commandArgs =
      spaceIndex === -1 ? '' : trimmedInput.slice(spaceIndex + 1).trim()

    const immediateCommand = commands.find(
      cmd =>
        cmd.immediate &&
        isCommandEnabled(cmd) &&
        (cmd.name === commandName ||
          cmd.aliases?.includes(commandName) ||
          getCommandName(cmd) === commandName),
    )

    if (
      immediateCommand &&
      immediateCommand.type === 'local-jsx' &&
      (queryGuard.isActive || isExternalLoading)
    ) {
      logEvent('tengu_immediate_command_executed', {
        commandName:
          immediateCommand.name as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })

      // Clear input
      onInputChange('')
      setCursorOffset(0)
      setPastedContents({})
      clearBuffer()

      const context = getToolUseContext(
        messages,
        [],
        createAbortController(),
        mainLoopModel,
      )

      let doneWasCalled = false
      const onDone: LocalJSXCommandOnDone = (result, options) => {
        doneWasCalled = true
        // Use clearLocalJSX to explicitly clear the local JSX command
        setToolJSX({
          jsx: null,
          shouldHidePromptInput: false,
          clearLocalJSX: true,
        })
        if (result && options?.display !== 'skip' && params.addNotification) {
          params.addNotification({
            key: `immediate-${immediateCommand.name}`,
            text: result,
            priority: 'immediate',
          })
        }
        if (options?.nextInput) {
          if (options.submitNextInput) {
            enqueue({ value: options.nextInput, mode: 'prompt' })
          } else {
            onInputChange(options.nextInput)
          }
        }
      }

      const impl = await immediateCommand.load()
      const jsx = await impl.call(onDone, context, commandArgs)

      // Skip if onDone already fired — prevents stuck isLocalJSXCommand
      // (see processSlashCommand.tsx local-jsx case for full mechanism).
      if (jsx && !doneWasCalled) {
        setToolJSX({
          jsx,
          shouldHidePromptInput: false,
          isLocalJSXCommand: true,
          isImmediate: true,
        })
      }
      return
    }
  }

  if (queryGuard.isActive || isExternalLoading) {
    // Only allow prompt and bash mode commands to be queued
    if (mode !== 'prompt' && mode !== 'bash') {
      return
    }

    // Interrupt the current turn when all executing tools have
    // interruptBehavior 'cancel' (e.g. SleepTool).
    if (params.hasInterruptibleToolInProgress) {
      logForDebugging(
        `[interrupt] Aborting current turn: streamMode=${params.streamMode}`,
      )
      logEvent('tengu_cancel', {
        source:
          'interrupt_on_submit' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        streamMode:
          params.streamMode as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
      params.abortController?.abort('interrupt')
    }

    const shouldAddVoiceMeta =
      params.voiceMode && mode === 'prompt' && !finalInput.trim().startsWith('/')

    // Enqueue with string value + raw pastedContents. Images will be resized
    // at execution time when processUserInput runs (not baked in here).
    enqueue({
      value: finalInput.trim(),
      preExpansionValue: input.trim(),
      mode,
      pastedContents: hasImages ? pastedContents : undefined,
      skipSlashCommands,
      uuid,
    })
    if (shouldAddVoiceMeta) {
      enqueue({
        value: VOICE_MODE_RESPONSE_HINT,
        mode: 'prompt',
        skipSlashCommands: true,
        isMeta: true,
      })
    }

    onInputChange('')
    setCursorOffset(0)
    setPastedContents({})
    resetHistory()
    clearBuffer()
    return
  }

  // Start query profiling for this query
  startQueryProfile()

  // Construct a QueuedCommand from the direct user input so both paths
  // go through the same executeUserInput loop. This ensures images get
  // resized via processUserInput regardless of how the command arrives.
  const cmd: QueuedCommand = {
    value: finalInput,
    preExpansionValue: input,
    mode,
    pastedContents: hasImages ? pastedContents : undefined,
    skipSlashCommands,
    uuid,
  }
  const shouldAddVoiceMeta =
    params.voiceMode && mode === 'prompt' && !finalInput.trim().startsWith('/')
  const queuedCommandsForTurn: QueuedCommand[] = shouldAddVoiceMeta
    ? [
        cmd,
        {
          value: VOICE_MODE_RESPONSE_HINT,
          mode: 'prompt',
          skipSlashCommands: true,
          isMeta: true,
        },
      ]
    : [cmd]

  await executeUserInput({
    queuedCommands: queuedCommandsForTurn,
    messages,
    mainLoopModel,
    ideSelection,
    querySource: params.querySource,
    commands,
    queryGuard,
    setToolJSX,
    getToolUseContext,
    setUserInputOnProcessing,
    setAbortController,
    onQuery,
    setAppState,
    onBeforeQuery,
    resetHistory,
    canUseTool,
    onInputChange,
    setMessages: params.setMessages,
  })
}

/**
 * Core logic for executing user input without UI side effects.
 *
 * All commands arrive as `queuedCommands`. First command gets full treatment
 * (attachments, ideSelection, pastedContents with image resizing). Commands 2-N
 * get `skipAttachments` to avoid duplicating turn-level context.
 */
async function executeUserInput(params: ExecuteUserInputParams): Promise<void> {
  const {
    messages,
    mainLoopModel,
    ideSelection,
    querySource,
    queryGuard,
    setToolJSX,
    getToolUseContext,
    setUserInputOnProcessing,
    setAbortController,
    onQuery,
    setAppState,
    onBeforeQuery,
    resetHistory,
    canUseTool,
    queuedCommands,
    setMessages,
  } = params

  // Note: paste references are already processed before calling this function
  // (either in handlePromptSubmit before queuing, or before initial execution).
  // Always create a fresh abort controller — queryGuard guarantees no concurrent
  // executeUserInput call, so there's no prior controller to inherit.
  const abortController = createAbortController()
  setAbortController(abortController)

  function makeContext(): ProcessUserInputContext {
    return getToolUseContext(messages, [], abortController, mainLoopModel)
  }

  // Wrap in try-finally so the guard is released even if processUserInput
  // throws or onQuery is skipped. onQuery's finally calls queryGuard.end(),
  // which transitions running→idle; cancelReservation() below is a no-op in
  // that case (only acts on dispatching state).
  try {
    // Reserve the guard BEFORE processUserInput — processBashCommand awaits
    // BashTool.call() and processSlashCommand awaits getMessagesForSlashCommand,
    // so the guard must be active during those awaits to ensure concurrent
    // handlePromptSubmit calls queue (via the isActive check above) instead
    // of starting a second executeUserInput. This call is a no-op if the
    // guard is already in dispatching (legacy queue-processor path).
    queryGuard.reserve()
    queryCheckpoint('query_process_user_input_start')

    const newMessages: Message[] = []
    let shouldQuery = false
    let allowedTools: string[] | undefined
    let model: string | undefined
    let effort: EffortValue | undefined
    let nextInput: string | undefined
    let submitNextInput: boolean | undefined

    // Iterate all commands uniformly. First command gets attachments +
    // ideSelection + pastedContents, rest skip attachments to avoid
    // duplicating turn-level context (IDE selection, todos, diffs).
    const commands = queuedCommands ?? []

    // Compute the workload tag for this turn. queueProcessor can batch a
    // cron prompt with a same-tick human prompt; only tag when EVERY
    // command agrees on the same non-undefined workload — a human in the
    // mix is actively waiting.
    const firstWorkload = commands[0]?.workload
    const turnWorkload =
      firstWorkload !== undefined &&
      commands.every(c => c.workload === firstWorkload)
        ? firstWorkload
        : undefined

    // Wrap the entire turn (processUserInput loop + onQuery) in an
    // AsyncLocalStorage context. This is the ONLY way to correctly
    // propagate workload across await boundaries: void-detached bg agents
    // (executeForkedSlashCommand, AgentTool) capture the ALS context at
    // invocation time, and every await inside them resumes in that
    // context — isolated from the parent's continuation. A process-global
    // mutable slot would be clobbered at the detached closure's first
    // await by this function's synchronous return path. See state.ts.
    await runWithWorkload(turnWorkload, async () => {
      for (let i = 0; i < commands.length; i++) {
        const cmd = commands[i]!
        const isFirst = i === 0
        const result = await processUserInput({
          input: cmd.value,
          preExpansionInput: cmd.preExpansionValue,
          mode: cmd.mode,
          setToolJSX,
          context: makeContext(),
          pastedContents: isFirst ? cmd.pastedContents : undefined,
          messages,
          setUserInputOnProcessing: isFirst
            ? setUserInputOnProcessing
            : undefined,
          isAlreadyProcessing: !isFirst,
          querySource,
          canUseTool,
          uuid: cmd.uuid,
          ideSelection: isFirst ? ideSelection : undefined,
          skipSlashCommands: cmd.skipSlashCommands,
          bridgeOrigin: cmd.bridgeOrigin,
          isMeta: cmd.isMeta,
          skipAttachments: !isFirst,
        })
        // Stamp origin here rather than threading another arg through
        // processUserInput → processUserInputBase → processTextPrompt → createUserMessage.
        // Derive origin from mode for task-notifications — mirrors the origin
        // derivation at messages.ts (case 'queued_command'); intentionally
        // does NOT mirror its isMeta:true so idle-dequeued notifications stay
        // visible in the transcript via UserAgentNotificationMessage.
        const origin =
          cmd.origin ??
          (cmd.mode === 'task-notification'
            ? ({ kind: 'task-notification' } as const)
            : undefined)
        if (origin) {
          for (const m of result.messages) {
            if (m.type === 'user') m.origin = origin
          }
        }
        newMessages.push(...result.messages)
        if (isFirst) {
          shouldQuery = result.shouldQuery
          allowedTools = result.allowedTools
          model = result.model
          effort = result.effort
          nextInput = result.nextInput
          submitNextInput = result.submitNextInput
        }
      }

      queryCheckpoint('query_process_user_input_end')
      if (fileHistoryEnabled()) {
        queryCheckpoint('query_file_history_snapshot_start')
        newMessages.filter(selectableUserMessagesFilter).forEach(message => {
          void fileHistoryMakeSnapshot(
            (updater: (prev: FileHistoryState) => FileHistoryState) => {
              setAppState(prev => ({
                ...prev,
                fileHistory: updater(prev.fileHistory),
              }))
            },
            message.uuid,
          )
        })
        queryCheckpoint('query_file_history_snapshot_end')
      }

      if (newMessages.length) {
        // History is now added in the caller (onSubmit) for direct user submissions.
        // This ensures queued command processing (notifications, already-queued user input)
        // doesn't add to history, since those either shouldn't be in history or were
        // already added when originally queued.
        resetHistory()
        setToolJSX({
          jsx: null,
          shouldHidePromptInput: false,
          clearLocalJSX: true,
        })

        const primaryCmd = commands[0]
        const primaryMode = primaryCmd?.mode ?? 'prompt'
        const primaryInput =
          primaryCmd && typeof primaryCmd.value === 'string'
            ? primaryCmd.value
            : undefined
        const shouldCallBeforeQuery = primaryMode === 'prompt'

        // Surf phase router — auto-switch the main-loop model based on the
        // detected work phase (planning / building / reviewing / background).
        // Only fires when a skill-level model override isn't already taking
        // priority: skills are explicit user intent and always win.
        let effectiveMainLoopModel = model
          ? resolveSkillModelOverride(model, mainLoopModel)
          : mainLoopModel
        let surfResult: ReturnType<typeof runSurfPhaseHook> = null
        if (!model) {
          const ctx = makeContext()
          surfResult = runSurfPhaseHook({
            permissionMode: ctx.getAppState().toolPermissionContext.mode,
            recentToolNames: extractRecentToolNames(messages),
            lastUserMessage: extractLastUserText(newMessages),
            messageCount: messages.length + newMessages.length,
            transcriptTokens: estimateTranscriptTokens(messages),
          })
          if (surfResult) {
            effectiveMainLoopModel = surfResult.modelToApply
            // Apply Anthropic-style effort via AppState (OpenAI reasoning
            // level is already pushed into its own global store by
            // applySurfPhaseSwitch). Only trust recognised levels — the
            // schema allows arbitrary strings/numbers for other providers,
            // and we don't want to write garbage into appState.effortValue.
            const effort = surfResult.effortToApply
            if (typeof effort === 'string' && isEffortLevel(effort)) {
              const level: EffortLevel = effort
              setAppState(prev => ({ ...prev, effortValue: level }))
            } else if (typeof effort === 'number') {
              setAppState(prev => ({ ...prev, effortValue: effort }))
            }
            // Only print the banner when the phase actually changed — every
            // turn would be noise. runSurfPhaseHook still updated module
            // state + bootstrap override so the model routes correctly.
            if (surfResult.changed && setMessages) {
              setMessages(prev => [
                ...prev,
                createSystemMessage(surfResult!.bannerLine, 'info'),
              ])
            }
          }
        }

        await onQuery(
          newMessages,
          abortController,
          shouldQuery,
          allowedTools ?? [],
          effectiveMainLoopModel,
          shouldCallBeforeQuery ? onBeforeQuery : undefined,
          primaryInput,
          effort,
        )

        // Post-turn cache hit rate banner — only when surf actually ran
        // this turn (no skill override, config in place). Reads the
        // per-turn delta captured by recordSurfUsage during onQuery.
        if (surfResult && setMessages) {
          const line = buildSurfCacheBanner(surfResult.newPhase)
          if (line) {
            setMessages(prev => [
              ...prev,
              createSystemMessage(line, 'info'),
            ])
          }
        }
      } else {
        // Local slash commands that skip messages (e.g., /model, /theme).
        // Release the guard BEFORE clearing toolJSX to prevent spinner flash —
        // the spinner formula checks: (!toolJSX || showSpinner) && isLoading.
        // If we clear toolJSX while the guard is still reserved, spinner briefly
        // shows. The finally below also calls cancelReservation (no-op if idle).
        queryGuard.cancelReservation()
        setToolJSX({
          jsx: null,
          shouldHidePromptInput: false,
          clearLocalJSX: true,
        })
        resetHistory()
        setAbortController(null)
      }

      // Handle nextInput from commands that want to chain (e.g., /discover activation)
      if (nextInput) {
        if (submitNextInput) {
          enqueue({ value: nextInput, mode: 'prompt' })
        } else {
          params.onInputChange(nextInput)
        }
      }
    }) // end runWithWorkload — ALS context naturally scoped, no finally needed
  } finally {
    // Safety net: release the guard reservation if processUserInput threw
    // or onQuery was skipped. No-op if onQuery already ran (guard is idle
    // via end(), or running — cancelReservation only acts on dispatching).
    // This is the single source of truth for releasing the reservation;
    // useQueueProcessor no longer needs its own .finally().
    queryGuard.cancelReservation()
    // Safety net: clear the placeholder if processUserInput produced no
    // messages or threw — otherwise it would stay visible until the next
    // turn's resetLoadingState. Harmless when onQuery ran: setMessages grew
    // displayedMessages past the baseline, so REPL.tsx already hid it.
    setUserInputOnProcessing(undefined)
  }
}
