/** Associates voice delegations with the actual REPL query that executes them.
 * Enqueueing is not completion: unrelated work may still be running. */
export function createLiveAgentTurnTracker({ progress, finish }: {
  progress(text: string, requestId: string): void
  finish(text: string, requestId: string): void
}) {
  const pending = new Map<string, string>()
  const active = new Map<string, string>()

  return {
    register(requestId: string, request: string) {
      if (!pending.has(requestId) && !active.has(requestId)) {
        pending.set(requestId, request.trim())
      }
    },
    discard(requestId: string) {
      pending.delete(requestId)
      active.delete(requestId)
    },
    beginTurn(userTexts: readonly string[]): string[] {
      const ids: string[] = []
      for (const text of userTexts) {
        const match = [...pending].find(([, request]) => request === text.trim())
        if (!match) continue
        pending.delete(match[0])
        active.set(match[0], '')
        ids.push(match[0])
      }
      return ids
    },
    progress(text: string | null, requestIds: readonly string[]) {
      if (!text?.trim()) return
      for (const id of requestIds) {
        if (!active.has(id)) continue
        const previous = active.get(id)
        if (previous === text) continue
        active.set(id, text)
        progress(text, id)
      }
    },
    finishTurn(requestIds: readonly string[], text: string) {
      for (const id of requestIds) {
        if (!active.has(id)) continue
        active.delete(id)
        finish(text, id)
      }
    },
    clear() {
      pending.clear()
      active.clear()
    },
  }
}
