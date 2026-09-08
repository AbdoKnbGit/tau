/** Terminals generally report key repeats, not key-up. Silence after a repeat
 * therefore releases the microphone. Modifier keys allow for OS repeat delay. */
export const HOLD_RELEASE_MS = 200

export type HoldClock = {
  setTimeout(callback: () => void, milliseconds: number): unknown
  clearTimeout(timer: unknown): void
}

const systemClock: HoldClock = {
  setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimeout: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
}

export function createPushToTalkHold({ begin, end, onError, clock = systemClock }: {
  begin(): Promise<void>
  end(): void
  onError(error: unknown): void
  clock?: HoldClock
}) {
  let holding = false
  let starting = false
  let timer: unknown
  let disposed = false

  function cancel(): void {
    if (timer !== undefined) clock.clearTimeout(timer)
    timer = undefined
    if (!holding && !starting) return
    holding = false
    // Also cancel an in-flight native start. Its continuation closes a late
    // device before another hold can begin.
    end()
  }

  function arm(milliseconds: number): void {
    if (timer !== undefined) clock.clearTimeout(timer)
    timer = clock.setTimeout(cancel, milliseconds)
  }

  function press(firstRepeatAllowanceMs = HOLD_RELEASE_MS): void {
    if (disposed) return
    if (holding) {
      arm(HOLD_RELEASE_MS)
      return
    }
    if (starting) return
    holding = true
    starting = true
    // Release detection must remain live while native startup is pending.
    arm(firstRepeatAllowanceMs)
    let began = false
    void Promise.resolve().then(() => {
      if (!holding || disposed) return
      began = true
      return begin()
    }).then(() => {
      if (began && (!holding || disposed)) end()
    }).catch(error => {
      cancel()
      if (!disposed) onError(error)
    }).finally(() => {
      starting = false
    })
  }

  return {
    press,
    cancel,
    isHolding: () => holding,
    dispose() {
      disposed = true
      cancel()
    },
  }
}
