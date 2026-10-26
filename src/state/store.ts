type Listener = () => void
type OnChange<T> = (args: { newState: T; oldState: T }) => void

export type Store<T> = {
  getState: () => T
  setState: (updater: (prev: T) => T) => void
  subscribe: (listener: Listener) => () => void
}

export function createStore<T>(
  initialState: T,
  onChange?: OnChange<T>,
  /**
   * Runs the change handler and the listeners. The app's store passes one
   * that leaves any provider scope: a sub-agent updating it must not carry its
   * provider into the re-render that update triggers.
   */
  notify: (run: () => void) => void = run => run(),
): Store<T> {
  let state = initialState
  const listeners = new Set<Listener>()

  return {
    getState: () => state,

    setState: (updater: (prev: T) => T) => {
      const prev = state
      const next = updater(prev)
      if (Object.is(next, prev)) return
      state = next
      notify(() => {
        onChange?.({ newState: next, oldState: prev })
        for (const listener of listeners) listener()
      })
    },

    subscribe: (listener: Listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
