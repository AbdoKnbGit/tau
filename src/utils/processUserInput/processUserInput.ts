import { feature } from 'bun:bundle'
import type {
  Base64ImageSource,
  ContentBlockParam,
  ImageBlockParam,
} from '@anthropic-ai/sdk/resources/messages.mjs'
import { randomUUID } from 'crypto'
import {
  getHiddenBashCommand,
  isHiddenBashInput,
} from 'src/components/PromptInput/inputModes.js'
import type { QuerySource } from 'src/constants/querySource.js'
import { logEvent } from 'src/services/analytics/index.js'
import { getContentText } from 'src/utils/messages.js'
import {
  findCommand,
  getCommandName,
  isBridgeSafeCommand,
  type LocalJSXCommandContext,
} from '../../commands.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { IDESelection } from '../../hooks/useIdeSelection.js'
import type { SetToolJSXFn, ToolUseContext } from '../../Tool.js'
import type {
  AssistantMessage,
  AttachmentMessage,
  Message,
  ProgressMessage,
  SystemMessage,
  UserMessage,
} from '../../types/message.js'
import type { PermissionMode } from '../../types/permissions.js'
import {
  isValidImagePaste,
  type PromptInputMode,
} from '../../types/textInputTypes.js'
import {
  type AgentMentionAttachment,
  createAttachmentMessage,
  getAttachmentMessages,
} from '../attachments.js'
import type { PastedContent } from '../config.js'
import type { EffortValue } from '../effort.js'
import { toArray } from '../generators.js'
import {
  executeUserPromptSubmitHooks,
  getUserPromptSubmitHookBlockingMessage,
} from '../hooks.js'
import {
  createImageMetadataText,
  maybeResizeAndDownsampleImageBlock,
} from '../imageResizer.js'
import { storeImages } from '../imageStore.js'
import {
  createCommandInputMessage,
  createSystemMessage,
  createUserMessage,
} from '../messages.js'
import { queryCheckpoint } from '../queryProfiler.js'
import { parseSlashCommand } from '../slashCommandParsing.js'
import {
  hasUltraplanKeyword,
  replaceUltraplanKeyword,
} from '../ultraplan/keyword.js'
import { processTextPrompt } from './processTextPrompt.js'
import { applyHookSessionTitle, formatBlockedPrompt, takePendingLifecycleHookMessages, rememberLifecycleHookMessages, restorePendingLifecycleHookMessages } from '../hooks/lifecycleHooks.js'
import { setPromptId } from '../../bootstrap/state.js'
export type ProcessUserInputContext = ToolUseContext & LocalJSXCommandContext & {
  /** Context from submission hooks, also delivered to a directly forked skill. */
  userPromptHookMessages?: AttachmentMessage[]
  /** The id already reserved for this prompt, set before its hooks ran. */
  promptId?: string
}

export type ProcessUserInputBaseResult = {
  messages: (
    | UserMessage
    | AssistantMessage
    | AttachmentMessage
    | SystemMessage
    | ProgressMessage
  )[]
  shouldQuery: boolean
  allowedTools?: string[]
  model?: string
  effort?: EffortValue
  // Output text for non-interactive mode (e.g., forked commands)
  // When set, this is used as the result in -p mode instead of empty string
  resultText?: string
  // A hook refused the submission before a model turn. Headless callers must
  // surface the reason as an error result, without echoing the blocked prompt.
  resultError?: string
  // When set, prefills or submits the next input after command completes
  // Used by /discover to chain into the selected feature's command
  nextInput?: string
  submitNextInput?: boolean
}

export async function processUserInput({
  input,
  preExpansionInput,
  mode,
  setToolJSX,
  context,
  pastedContents,
  ideSelection,
  messages,
  setUserInputOnProcessing,
  uuid,
  isAlreadyProcessing,
  querySource,
  canUseTool,
  skipSlashCommands,
  bridgeOrigin,
  isMeta,
  skipAttachments,
}: {
  input: string | Array<ContentBlockParam>
  /**
   * Input before [Pasted text #N] expansion. Used for ultraplan keyword
   * detection so pasted content containing the word cannot trigger. Falls
   * back to the string `input` when unset.
   */
  preExpansionInput?: string
  mode: PromptInputMode
  setToolJSX: SetToolJSXFn
  context: ProcessUserInputContext
  pastedContents?: Record<number, PastedContent>
  ideSelection?: IDESelection
  messages?: Message[]
  setUserInputOnProcessing?: (prompt?: string) => void
  uuid?: string
  isAlreadyProcessing?: boolean
  querySource?: QuerySource
  canUseTool?: CanUseToolFn
  /**
   * When true, input starting with `/` is treated as plain text.
   * Used for remotely-received messages (bridge/CCR) that should not
   * trigger local slash commands or skills.
   */
  skipSlashCommands?: boolean
  /**
   * When true, slash commands matching isBridgeSafeCommand() execute even
   * though skipSlashCommands is set. See QueuedCommand.bridgeOrigin.
   */
  bridgeOrigin?: boolean
  /**
   * When true, the resulting UserMessage gets `isMeta: true` (user-hidden,
   * model-visible). Propagated from `QueuedCommand.isMeta` for queued
   * system-generated prompts.
   */
  isMeta?: boolean
  skipAttachments?: boolean
}): Promise<ProcessUserInputBaseResult> {
  const inputString = typeof input === 'string' ? input : null
  // Immediately show the user input prompt while we are still processing the input.
  // Skip for isMeta (system-generated prompts like scheduled tasks) — those
  // should run invisibly.
  if (mode === 'prompt' && inputString !== null && !isMeta) {
    setUserInputOnProcessing?.(inputString)
  }

  queryCheckpoint('query_process_user_input_base_start')

  const appState = context.getAppState()
  rememberLifecycleHookMessages(context.messages)

  const processBase = (
    submission: Pick<
      ProcessUserInputContext,
      'userPromptHookMessages' | 'promptId'
    > = {},
  ) =>
    processUserInputBase(
      input,
      mode,
      setToolJSX,
      { ...context, ...submission },
      pastedContents,
      ideSelection,
      messages,
      uuid,
      isAlreadyProcessing,
      querySource,
      canUseTool,
      appState.toolPermissionContext.mode,
      skipSlashCommands,
      bridgeOrigin,
      isMeta,
      skipAttachments,
      preExpansionInput,
    )
  const inputMessage = getContentText(input) || ''

  // UserPromptSubmit hooks run once for every submission that reaches the
  // model, on the text as typed. `kept` is what a hook's continue:false
  // leaves in the conversation.
  const runSubmitHooks = async (
    kept: ProcessUserInputBaseResult,
  ): Promise<
    | { stopped: ProcessUserInputBaseResult }
    | { hookMessages: ProcessUserInputBaseResult['messages'] }
  > => {
    const hookMessages: ProcessUserInputBaseResult['messages'] = []
    queryCheckpoint('query_hooks_start')
    for await (const hookResult of executeUserPromptSubmitHooks(
      inputMessage,
      appState.toolPermissionContext.mode,
      context,
      context.requestPrompt,
    )) {
      if (hookResult.sessionTitle) {
        await applyHookSessionTitle(hookResult.sessionTitle, context)
      }
      // We only care about the result
      if (hookResult.message?.type === 'progress') {
        continue
      }

      // Return only a system-level error message, erasing the original user input
      if (hookResult.blockingError) {
        const blockingMessage = getUserPromptSubmitHookBlockingMessage(
          hookResult.blockingError,
        )
        return {
          stopped: {
            messages: [
              // TODO: Make this an attachment message
              createSystemMessage(
                formatBlockedPrompt(
                  blockingMessage,
                  inputMessage,
                  hookResult.suppressOriginalPrompt,
                ),
                'warning',
              ),
            ],
            shouldQuery: false,
            resultError: blockingMessage,
            allowedTools: kept.allowedTools,
          },
        }
      }

      // If preventContinuation is set, stop processing but keep the original
      // prompt in context.
      if (hookResult.preventContinuation) {
        const message = hookResult.stopReason
          ? `Operation stopped by hook: ${hookResult.stopReason}`
          : 'Operation stopped by hook'
        return {
          stopped: {
            ...kept,
            messages: [
              ...kept.messages,
              ...hookMessages,
              createUserMessage({
                content: message,
              }),
            ],
            shouldQuery: false,
            resultError: message,
          },
        }
      }

      // Collect additional contexts
      if (
        hookResult.additionalContexts &&
        hookResult.additionalContexts.length > 0
      ) {
        hookMessages.push(
          createAttachmentMessage({
            type: 'hook_additional_context',
            content: hookResult.additionalContexts.map(applyTruncation),
            hookName: 'UserPromptSubmit',
            toolUseID: `hook-${randomUUID()}`,
            hookEvent: 'UserPromptSubmit',
          }),
        )
      }

      // TODO: Clean this up
      if (hookResult.message) {
        switch (hookResult.message.attachment.type) {
          case 'hook_success':
            if (!hookResult.message.attachment.content) {
              // Skip if there is no content
              break
            }
            hookMessages.push({
              ...hookResult.message,
              attachment: {
                ...hookResult.message.attachment,
                content: applyTruncation(
                  hookResult.message.attachment.content,
                ),
              },
            })
            break
          default:
            hookMessages.push(hookResult.message)
            break
        }
      }
    }
    queryCheckpoint('query_hooks_end')
    return { hookMessages }
  }

  // Plain text and commands that expand into a prompt are known to submit
  // before expansion, so their hooks run first and a block also stops skill
  // interpolation and forked agents. Everything else (other modes, other
  // commands, unknown /input that may be a path) is checked once processing
  // shows it queries.
  const parsedCommand =
    mode === 'prompt' && inputString?.startsWith('/')
      ? parseSlashCommand(inputString)
      : undefined
  const command = parsedCommand
    ? findCommand(parsedCommand.commandName, context.options.commands)
    : undefined
  const sentAsText =
    !!skipSlashCommands &&
    !(bridgeOrigin && command && isBridgeSafeCommand(command))
  const submitsBeforeExpansion =
    mode === 'prompt' &&
    (!parsedCommand ||
      // A known command a bridge cannot run is refused, not submitted.
      (sentAsText ? !(bridgeOrigin && command) : command?.type === 'prompt'))

  if (!submitsBeforeExpansion) {
    const result = await processBase()
    queryCheckpoint('query_process_user_input_base_end')
    if (!result.shouldQuery) {
      return result
    }
    const hooks = await runSubmitHooks(result)
    if ('stopped' in hooks) {
      return hooks.stopped
    }
    result.messages.push(
      ...hooks.hookMessages,
      ...(await takePendingLifecycleHookMessages()),
    )
    return result
  }

  // The prompt's id exists before its hooks run, so they and their telemetry
  // carry it; processing reuses it instead of starting another.
  const promptId = randomUUID()
  setPromptId(promptId)
  const hooks = await runSubmitHooks({
    messages: [
      createUserMessage({
        content: input,
        uuid,
        permissionMode: appState.toolPermissionContext.mode,
        isMeta: isMeta || undefined,
      }),
    ],
    shouldQuery: true,
  })
  if ('stopped' in hooks) {
    return hooks.stopped
  }
  const pendingMessages = await takePendingLifecycleHookMessages()
  const expandedResult = await processBase({
    userPromptHookMessages: [...hooks.hookMessages, ...pendingMessages].filter(
      (message): message is AttachmentMessage => message.type === 'attachment',
    ),
    promptId,
  })
  queryCheckpoint('query_process_user_input_base_end')
  if (!expandedResult.shouldQuery) {
    // Background hook context is for the next prompt that reaches the model.
    restorePendingLifecycleHookMessages(pendingMessages)
    return expandedResult
  }
  expandedResult.messages.push(...hooks.hookMessages, ...pendingMessages)

  // Happy path: onQuery will clear userInputOnProcessing via startTransition
  // so it resolves in the same frame as deferredMessages (no flicker gap).
  // Error paths are handled by handlePromptSubmit's finally block.
  return expandedResult
}

const MAX_HOOK_OUTPUT_LENGTH = 10000

function applyTruncation(content: string): string {
  if (content.length > MAX_HOOK_OUTPUT_LENGTH) {
    return `${content.substring(0, MAX_HOOK_OUTPUT_LENGTH)}… [output truncated - exceeded ${MAX_HOOK_OUTPUT_LENGTH} characters]`
  }
  return content
}

async function processUserInputBase(
  input: string | Array<ContentBlockParam>,
  mode: PromptInputMode,
  setToolJSX: SetToolJSXFn,
  context: ProcessUserInputContext,
  pastedContents?: Record<number, PastedContent>,
  ideSelection?: IDESelection,
  messages?: Message[],
  uuid?: string,
  isAlreadyProcessing?: boolean,
  querySource?: QuerySource,
  canUseTool?: CanUseToolFn,
  permissionMode?: PermissionMode,
  skipSlashCommands?: boolean,
  bridgeOrigin?: boolean,
  isMeta?: boolean,
  skipAttachments?: boolean,
  preExpansionInput?: string,
): Promise<ProcessUserInputBaseResult> {
  let inputString: string | null = null
  let precedingInputBlocks: ContentBlockParam[] = []

  // Collect image metadata texts for isMeta message
  const imageMetadataTexts: string[] = []

  // Normalized view of `input` with image blocks resized. For string input
  // this is just `input`; for array input it's the processed blocks. We pass
  // this (not raw `input`) to processTextPrompt so resized/normalized image
  // blocks actually reach the API — otherwise the resize work above is
  // discarded for the regular prompt path. Also normalizes bridge inputs
  // where iOS may send `mediaType` instead of `media_type` (mobile-apps#5825).
  let normalizedInput: string | ContentBlockParam[] = input

  if (typeof input === 'string') {
    inputString = input
  } else if (input.length > 0) {
    queryCheckpoint('query_image_processing_start')
    const processedBlocks: ContentBlockParam[] = []
    for (const block of input) {
      if (block.type === 'image') {
        const resized = await maybeResizeAndDownsampleImageBlock(block)
        // Collect image metadata for isMeta message
        if (resized.dimensions) {
          const metadataText = createImageMetadataText(resized.dimensions)
          if (metadataText) {
            imageMetadataTexts.push(metadataText)
          }
        }
        processedBlocks.push(resized.block)
      } else {
        processedBlocks.push(block)
      }
    }
    normalizedInput = processedBlocks
    queryCheckpoint('query_image_processing_end')
    // Extract the input string from the last content block if it is text,
    // and keep track of the preceding content blocks
    const lastBlock = processedBlocks[processedBlocks.length - 1]
    if (lastBlock?.type === 'text') {
      inputString = lastBlock.text
      precedingInputBlocks = processedBlocks.slice(0, -1)
    } else {
      precedingInputBlocks = processedBlocks
    }
  }

  if (inputString === null && mode !== 'prompt') {
    throw new Error(`Mode: ${mode} requires a string input.`)
  }

  // `!!cmd` runs a shell command whose output never reaches the model. Return
  // before pasted images and attachments are collected: some attachments are
  // marked as delivered when they're built (e.g. the skill list), so building
  // them for a hidden command would lose them.
  if (mode === 'bash' && inputString !== null && isHiddenBashInput(inputString)) {
    const hiddenBashCommand = getHiddenBashCommand(inputString)
    // `!!` with nothing after it: nothing to run, nothing to record.
    if (hiddenBashCommand === null) {
      return { messages: [], shouldQuery: false }
    }
    const { processBashCommand } = await import('./processBashCommand.js')
    return processBashCommand(hiddenBashCommand, [], [], context, setToolJSX, {
      hidden: true,
    })
  }

  // Extract and convert image content to content blocks early
  // Keep track of IDs in order for message storage
  const imageContents = pastedContents
    ? Object.values(pastedContents).filter(isValidImagePaste)
    : []
  const imagePasteIds = imageContents.map(img => img.id)

  // Store images to disk so Claude can reference the path in context
  // (for manipulation with CLI tools, uploading to PRs, etc.)
  const storedImagePaths = pastedContents
    ? await storeImages(pastedContents)
    : new Map<number, string>()

  // Resize pasted images to ensure they fit within API limits (parallel processing)
  queryCheckpoint('query_pasted_image_processing_start')
  const imageProcessingResults = await Promise.all(
    imageContents.map(async pastedImage => {
      const imageBlock: ImageBlockParam = {
        type: 'image',
        source: {
          type: 'base64',
          media_type: (pastedImage.mediaType ||
            'image/png') as Base64ImageSource['media_type'],
          data: pastedImage.content,
        },
      }
      logEvent('tengu_pasted_image_resize_attempt', {
        original_size_bytes: pastedImage.content.length,
      })
      const resized = await maybeResizeAndDownsampleImageBlock(imageBlock)
      return {
        resized,
        originalDimensions: pastedImage.dimensions,
        sourcePath:
          pastedImage.sourcePath ?? storedImagePaths.get(pastedImage.id),
      }
    }),
  )
  // Collect results preserving order
  const imageContentBlocks: ContentBlockParam[] = []
  for (const {
    resized,
    originalDimensions,
    sourcePath,
  } of imageProcessingResults) {
    // Collect image metadata for isMeta message (prefer resized dimensions)
    if (resized.dimensions) {
      const metadataText = createImageMetadataText(
        resized.dimensions,
        sourcePath,
      )
      if (metadataText) {
        imageMetadataTexts.push(metadataText)
      }
    } else if (originalDimensions) {
      // Fall back to original dimensions if resize didn't provide them
      const metadataText = createImageMetadataText(
        originalDimensions,
        sourcePath,
      )
      if (metadataText) {
        imageMetadataTexts.push(metadataText)
      }
    } else if (sourcePath) {
      // If we have a source path but no dimensions, still add source info
      imageMetadataTexts.push(`[Image source: ${sourcePath}]`)
    }
    imageContentBlocks.push(resized.block)
  }
  queryCheckpoint('query_pasted_image_processing_end')

  // Bridge-safe slash command override: mobile/web clients set bridgeOrigin
  // with skipSlashCommands still true (defense-in-depth against exit words and
  // immediate-command fast paths). Resolve the command here — if it passes
  // isBridgeSafeCommand, clear the skip so the gate below opens. If it's a
  // known-but-unsafe command (local-jsx UI or terminal-only), short-circuit
  // with a helpful message rather than letting the model see raw "/config".
  let effectiveSkipSlash = skipSlashCommands
  if (bridgeOrigin && inputString !== null && inputString.startsWith('/')) {
    const parsed = parseSlashCommand(inputString)
    const cmd = parsed
      ? findCommand(parsed.commandName, context.options.commands)
      : undefined
    if (cmd) {
      if (isBridgeSafeCommand(cmd)) {
        effectiveSkipSlash = false
      } else {
        const msg = `/${getCommandName(cmd)} isn't available over Remote Control.`
        return {
          messages: [
            createUserMessage({ content: inputString, uuid }),
            createCommandInputMessage(
              `<local-command-stdout>${msg}</local-command-stdout>`,
            ),
          ],
          shouldQuery: false,
          resultText: msg,
        }
      }
    }
    // Unknown /foo or unparseable — fall through to plain text, same as
    // pre-#19134. A mobile user typing "/shrug" shouldn't see "Unknown skill".
  }

  // Ultraplan keyword — route through /ultraplan. Detect on the
  // pre-expansion input so pasted content containing the word cannot
  // trigger a CCR session; replace with "plan" in the expanded input so
  // the CCR prompt receives paste contents and stays grammatical. See
  // keyword.ts for the quote/path exclusions. Interactive prompt mode +
  // non-slash-prefixed only:
  // headless/print mode filters local-jsx commands out of context.options,
  // so routing to /ultraplan there yields "Unknown skill" — and there's no
  // rainbow animation in print mode anyway.
  // Runs before attachment extraction so this path matches the slash-command
  // path below (no await between setUserInputOnProcessing and setAppState —
  // React batches both into one render, no flash).
  if (
    feature('ULTRAPLAN') &&
    mode === 'prompt' &&
    !context.options.isNonInteractiveSession &&
    inputString !== null &&
    !effectiveSkipSlash &&
    !inputString.startsWith('/') &&
    !context.getAppState().ultraplanSessionUrl &&
    !context.getAppState().ultraplanLaunching &&
    hasUltraplanKeyword(preExpansionInput ?? inputString)
  ) {
    logEvent('tengu_ultraplan_keyword', {})
    const rewritten = replaceUltraplanKeyword(inputString).trim()
    const { processSlashCommand } = await import('./processSlashCommand.js')
    const slashResult = await processSlashCommand(
      `/ultraplan ${rewritten}`,
      precedingInputBlocks,
      imageContentBlocks,
      [],
      context,
      setToolJSX,
      uuid,
      isAlreadyProcessing,
      canUseTool,
    )
    return addImageMetadataMessage(slashResult, imageMetadataTexts)
  }

  // For slash commands, attachments will be extracted within getMessagesForSlashCommand
  const shouldExtractAttachments =
    !skipAttachments &&
    inputString !== null &&
    (mode !== 'prompt' || effectiveSkipSlash || !inputString.startsWith('/'))

  queryCheckpoint('query_attachment_loading_start')
  const attachmentMessages = shouldExtractAttachments
    ? await toArray(
        getAttachmentMessages(
          inputString,
          context,
          ideSelection ?? null,
          [], // queuedCommands - handled by query.ts for mid-turn attachments
          messages,
          querySource,
        ),
      )
    : []
  queryCheckpoint('query_attachment_loading_end')

  // Bash commands
  if (inputString !== null && mode === 'bash') {
    const { processBashCommand } = await import('./processBashCommand.js')
    return addImageMetadataMessage(
      await processBashCommand(
        inputString,
        precedingInputBlocks,
        attachmentMessages,
        context,
        setToolJSX,
      ),
      imageMetadataTexts,
    )
  }

  // Slash commands
  // Skip for remote bridge messages — input from CCR clients is plain text
  if (
    inputString !== null &&
    !effectiveSkipSlash &&
    inputString.startsWith('/')
  ) {
    const { processSlashCommand } = await import('./processSlashCommand.js')
    const slashResult = await processSlashCommand(
      inputString,
      precedingInputBlocks,
      imageContentBlocks,
      attachmentMessages,
      context,
      setToolJSX,
      uuid,
      isAlreadyProcessing,
      canUseTool,
    )
    return addImageMetadataMessage(slashResult, imageMetadataTexts)
  }

  // Log agent mention queries for analysis
  if (inputString !== null && mode === 'prompt') {
    const trimmedInput = inputString.trim()

    const agentMention = attachmentMessages.find(
      (m): m is AttachmentMessage<AgentMentionAttachment> =>
        m.attachment.type === 'agent_mention',
    )

    if (agentMention) {
      const agentMentionString = `@agent-${agentMention.attachment.agentType}`
      const isSubagentOnly = trimmedInput === agentMentionString
      const isPrefix =
        trimmedInput.startsWith(agentMentionString) && !isSubagentOnly

      // Log whenever users use @agent-<name> syntax
      logEvent('tengu_subagent_at_mention', {
        is_subagent_only: isSubagentOnly,
        is_prefix: isPrefix,
      })
    }
  }

  // Regular user prompt
  return addImageMetadataMessage(
    processTextPrompt(
      normalizedInput,
      imageContentBlocks,
      imagePasteIds,
      attachmentMessages,
      uuid,
      permissionMode,
      isMeta,
      context.promptId,
    ),
    imageMetadataTexts,
  )
}

// Adds image metadata texts as isMeta message to result
function addImageMetadataMessage(
  result: ProcessUserInputBaseResult,
  imageMetadataTexts: string[],
): ProcessUserInputBaseResult {
  if (imageMetadataTexts.length > 0) {
    result.messages.push(
      createUserMessage({
        content: imageMetadataTexts.map(text => ({ type: 'text', text })),
        isMeta: true,
      }),
    )
  }
  return result
}
