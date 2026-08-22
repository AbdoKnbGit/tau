import { randomUUID, type UUID } from 'crypto'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { getOriginalCwd, getSessionId } from '../../bootstrap/state.js'
import type { LocalJSXCommandContext } from '../../commands.js'
import { logEvent } from '../../services/analytics/index.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import type {
  ContentReplacementEntry,
  Entry,
  LogOption,
  SerializedMessage,
  TranscriptMessage,
} from '../../types/logs.js'
import { parseJSONL } from '../../utils/json.js'
import {
  dedupeContentReplacementRecords,
  getFirstMeaningfulUserMessageTextContent,
  getProjectDir,
  getTranscriptPath,
  getTranscriptPathForSession,
  isTranscriptMessage,
  saveCustomTitle,
  searchSessionsByCustomTitle,
} from '../../utils/sessionStorage.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { escapeRegExp } from '../../utils/stringUtils.js'

type TranscriptEntry = TranscriptMessage & {
  forkedFrom?: {
    sessionId: string
    messageUuid: UUID
  }
}

/**
 * Derive a title seed from the LATEST meaningful user prompt — see the
 * detailed comment on branch.ts's deriveFirstPrompt for why "last" beats
 * "first" when the transcript is a copy of an existing session.
 */
function deriveFirstPrompt(transcript: SerializedMessage[]): string {
  const reversed = [...transcript].reverse()
  const text =
    getFirstMeaningfulUserMessageTextContent(reversed) ??
    getFirstMeaningfulUserMessageTextContent(transcript)
  if (!text) return 'Cloned conversation'
  return text.replace(/\s+/g, ' ').trim().slice(0, 100) || 'Cloned conversation'
}

function autoSuffix(label: string): string {
  const now = new Date()
  const hh = now.getHours().toString().padStart(2, '0')
  const mm = now.getMinutes().toString().padStart(2, '0')
  return `(${label} · ${hh}:${mm})`
}

/**
 * Mirror of branch.ts's createFork. We duplicate (rather than refactor /
 * import from) so that branch.ts stays byte-identical and any future change
 * to /branch can't accidentally regress /clone.
 *
 * Only intentional differences vs createFork:
 * - The fallback title is "Cloned conversation" instead of "Branched conversation".
 * - getUniqueCloneName uses "(Clone)" / "(Clone N)" instead of "(Branch)".
 */
async function createClone(customTitle?: string): Promise<{
  sessionId: UUID
  title: string | undefined
  clonePath: string
  serializedMessages: SerializedMessage[]
  contentReplacementRecords: ContentReplacementEntry['replacements']
}> {
  const cloneSessionId = randomUUID() as UUID
  const originalSessionId = getSessionId()
  const projectDir = getProjectDir(getOriginalCwd())
  const cloneSessionPath = getTranscriptPathForSession(cloneSessionId)
  const currentTranscriptPath = getTranscriptPath()

  await mkdir(projectDir, { recursive: true, mode: 0o700 })

  let transcriptContent: Buffer
  try {
    transcriptContent = await readFile(currentTranscriptPath)
  } catch {
    throw new Error('No conversation to clone')
  }

  if (transcriptContent.length === 0) {
    throw new Error('No conversation to clone')
  }

  const entries = parseJSONL<Entry>(transcriptContent)

  const mainConversationEntries = entries.filter(
    (entry): entry is TranscriptMessage =>
      isTranscriptMessage(entry) && !entry.isSidechain,
  )

  const contentReplacementRecords = dedupeContentReplacementRecords(
    entries
      .filter(
        (entry): entry is ContentReplacementEntry =>
          entry.type === 'content-replacement' &&
          entry.sessionId === originalSessionId,
      )
      .flatMap(entry => entry.replacements),
  )

  if (mainConversationEntries.length === 0) {
    throw new Error('No messages to clone')
  }

  let parentUuid: UUID | null = null
  const lines: string[] = []
  const serializedMessages: SerializedMessage[] = []

  for (const entry of mainConversationEntries) {
    const clonedEntry: TranscriptEntry = {
      ...entry,
      sessionId: cloneSessionId,
      parentUuid,
      isSidechain: false,
      forkedFrom: {
        sessionId: originalSessionId,
        messageUuid: entry.uuid,
      },
    }

    const serialized: SerializedMessage = {
      ...entry,
      sessionId: cloneSessionId,
    }

    serializedMessages.push(serialized)
    lines.push(jsonStringify(clonedEntry))
    if (entry.type !== 'progress') {
      parentUuid = entry.uuid
    }
  }

  if (contentReplacementRecords.length > 0) {
    const clonedReplacementEntry: ContentReplacementEntry = {
      type: 'content-replacement',
      sessionId: cloneSessionId,
      replacements: contentReplacementRecords,
    }
    lines.push(jsonStringify(clonedReplacementEntry))
  }

  await writeFile(cloneSessionPath, lines.join('\n') + '\n', {
    encoding: 'utf8',
    mode: 0o600,
  })

  return {
    sessionId: cloneSessionId,
    title: customTitle,
    clonePath: cloneSessionPath,
    serializedMessages,
    contentReplacementRecords,
  }
}

async function getUniqueCloneName(baseName: string): Promise<string> {
  const candidateName = `${baseName} (Clone)`
  const existingWithExactName = await searchSessionsByCustomTitle(
    candidateName,
    { exact: true },
  )
  if (existingWithExactName.length === 0) {
    return candidateName
  }

  const existingClones = await searchSessionsByCustomTitle(`${baseName} (Clone`)
  const usedNumbers = new Set<number>([1])
  const cloneNumberPattern = new RegExp(
    `^${escapeRegExp(baseName)} \\(Clone(?: (\\d+))?\\)$`,
  )
  for (const session of existingClones) {
    const match = session.customTitle?.match(cloneNumberPattern)
    if (match) {
      if (match[1]) usedNumbers.add(parseInt(match[1], 10))
      else usedNumbers.add(1)
    }
  }

  let nextNumber = 2
  while (usedNumbers.has(nextNumber)) nextNumber++
  return `${baseName} (Clone ${nextNumber})`
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
  args: string,
): Promise<React.ReactNode> {
  const customSuffix = args?.trim() || undefined
  const originalSessionId = getSessionId()

  try {
    const {
      sessionId,
      clonePath,
      serializedMessages,
      contentReplacementRecords,
    } = await createClone(customSuffix)

    const now = new Date()
    const firstPrompt = deriveFirstPrompt(serializedMessages)

    // Naming policy:
    //   /clone           -> "<lastPrompt> (Clone · HH:MM)" — time stamp keeps
    //                       multiple clones of the same conversation distinct
    //                       in /tree without forcing the user to remember
    //                       arbitrary "(Clone 2)" / "(Clone 3)" suffixes.
    //   /clone safe-x    -> "<lastPrompt> (Clone safe-x)" — explicit label
    //                       wins; the user told us what to call it.
    const baseName = firstPrompt
    const effectiveTitle = customSuffix
      ? `${baseName} (Clone ${customSuffix})`
      : `${baseName} ${autoSuffix('Clone')}`
    await saveCustomTitle(sessionId, effectiveTitle, clonePath)

    logEvent('tengu_conversation_forked', {
      message_count: serializedMessages.length,
      has_custom_title: !!customSuffix,
    })

    const cloneLog: LogOption = {
      date: now.toISOString().split('T')[0]!,
      messages: serializedMessages,
      fullPath: clonePath,
      value: now.getTime(),
      created: now,
      modified: now,
      firstPrompt,
      messageCount: serializedMessages.length,
      isSidechain: false,
      sessionId,
      customTitle: effectiveTitle,
      contentReplacements: contentReplacementRecords,
    }

    const successMessage = `Cloned conversation. You are now in the clone — the original is preserved as a backup. Resume it with: tau -r ${originalSessionId}`

    if (context.resume) {
      await context.resume(sessionId, cloneLog, 'fork')
      onDone(successMessage, { display: 'system' })
    } else {
      onDone(`Cloned conversation. Resume the clone with: /resume ${sessionId}`)
    }
    return null
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unknown error occurred'
    onDone(`Failed to clone conversation: ${message}`)
    return null
  }
}
