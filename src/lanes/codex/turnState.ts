/** Server-issued routing state belongs to one agent turn, not a conversation. */
export const CODEX_TURN_STATE_HEADER = 'x-codex-turn-state'

export class CodexTurnState {
  private token: string | undefined

  get value(): string | undefined { return this.token }

  capture(value: unknown): void {
    // Match native Codex's OnceLock: keep the first valid value unchanged.
    // Reject values that cannot safely be replayed as an HTTP header.
    if (this.token === undefined && typeof value === 'string' && value.length > 0 &&
      /^[\x20-\x7e]+$/.test(value)) this.token = value
  }

  captureHeaders(headers: unknown): void {
    if (!headers || typeof headers !== 'object') return
    for (const [name, value] of Object.entries(headers)) {
      if (name.toLowerCase() === CODEX_TURN_STATE_HEADER) {
        this.capture(Array.isArray(value) ? value.find(item => typeof item === 'string') : value)
        return
      }
    }
  }

  captureEvent(event: { type?: unknown; headers?: unknown }): void {
    if (event.type === 'response.metadata') this.captureHeaders(event.headers)
  }
}

export class CodexTurnStates {
  private readonly states = new Map<string, CodexTurnState>()

  get(sessionId: string, turnId?: string): CodexTurnState {
    // Standalone calls have no known turn boundary: never borrow another call's token.
    if (!turnId) return new CodexTurnState()
    // Forks can share cache affinity with their parent while using a different
    // query chain. Keep both tokens so a side request cannot erase the parent.
    const key = JSON.stringify([sessionId, turnId])
    const state = this.states.get(key) ?? new CodexTurnState()
    this.states.delete(key)
    this.states.set(key, state)
    while (this.states.size > 64) this.states.delete(this.states.keys().next().value!)
    return state
  }

  clear(): void { this.states.clear() }
}
