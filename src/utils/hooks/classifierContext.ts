import { getSessionId } from '../../bootstrap/state.js'

export type HookClassifierNote = { text: string; trusted: boolean }
export type HookClassifierAnnotation = {
  toolUseId: string
  toolName: string
  toolInput: unknown
  text: string
}

// Trust is live-process provenance, never a claim loaded from a transcript.
const trustedAnnotations = new WeakMap<HookClassifierAnnotation, string>()

export function createHookClassifierAnnotation(
  toolUseId: string, toolName: string, toolInput: unknown, notes: readonly HookClassifierNote[],
): HookClassifierAnnotation | undefined {
  const nonempty = notes.filter(note => note.text.length > 0)
  if (!nonempty.length) return undefined
  const annotation = { toolUseId, toolName, toolInput, text: nonempty.map(note => note.text).join('\n').slice(0, 2000) }
  if (nonempty.every(note => note.trusted)) trustedAnnotations.set(annotation, getSessionId())
  return annotation
}

export function readHookClassifierAnnotation(message: unknown): HookClassifierAnnotation | undefined {
  if (!message || typeof message !== 'object' || !('hookClassifierContext' in message)) return
  const note = message.hookClassifierContext
  if (!note || typeof note !== 'object' || !('text' in note) || typeof note.text !== 'string' ||
    !('toolName' in note) || typeof note.toolName !== 'string' ||
    !('toolUseId' in note) || typeof note.toolUseId !== 'string' || !('toolInput' in note)) return
  return note as HookClassifierAnnotation
}

export function hookClassifierAnnotations(message: unknown): HookClassifierAnnotation[] {
  if (!message || typeof message !== 'object') return []
  if ('hookClassifierContexts' in message && Array.isArray(message.hookClassifierContexts)) {
    return message.hookClassifierContexts.flatMap(note => {
      const valid = readHookClassifierAnnotation({ hookClassifierContext: note })
      return valid ? [valid] : []
    })
  }
  const note = readHookClassifierAnnotation(message)
  return note ? [note] : []
}

/** Keep hook-only metadata when transcript messages split or merge. */
export function hookClassifierMetadata(messages: readonly unknown[], toolUseId?: string) {
  const notes = messages.flatMap(hookClassifierAnnotations)
    .filter(note => toolUseId === undefined || note.toolUseId === toolUseId)
  if (!notes.length) return {}
  return { hookClassifierContexts: [...new Map(notes.map(note => [note.toolUseId, note])).values()] }
}

export function classifierAnnotationIsTrusted(note: HookClassifierAnnotation): boolean {
  return trustedAnnotations.get(note) === getSessionId()
}
