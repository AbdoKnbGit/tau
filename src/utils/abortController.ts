import { setMaxListeners } from 'events'

/**
 * Default max listeners for standard operations
 */
const DEFAULT_MAX_LISTENERS = 50

/**
 * Creates an AbortController with proper event listener limits set.
 * This prevents MaxListenersExceededWarning when multiple listeners
 * are attached to the abort signal.
 *
 * @param maxListeners - Maximum number of listeners (default: 50)
 * @returns AbortController with configured listener limit
 */
export function createAbortController(
  maxListeners: number = DEFAULT_MAX_LISTENERS,
): AbortController {
  const controller = new AbortController()
  setMaxListeners(maxListeners, controller.signal)
  return controller
}

/**
 * Propagates abort from a parent to a weakly-referenced child controller.
 * Both parent and child are weakly held — neither direction creates a
 * strong reference that could prevent GC.
 * Module-scope function avoids per-call closure allocation.
 */
function propagateAbort(
  this: WeakRef<AbortController>,
  weakChild: WeakRef<AbortController>,
): void {
  const parent = this.deref()
  weakChild.deref()?.abort(parent?.signal.reason)
}

/**
 * Removes an abort handler from a weakly-referenced parent signal.
 * Both parent and handler are weakly held — if either has been GC'd
 * or the parent already aborted ({once: true}), this is a no-op.
 * Module-scope function avoids per-call closure allocation.
 */
function removeAbortHandler(
  this: WeakRef<AbortController>,
  weakHandler: WeakRef<(...args: unknown[]) => void>,
): void {
  const parent = this.deref()
  const handler = weakHandler.deref()
  if (parent && handler) {
    parent.signal.removeEventListener('abort', handler)
  }
}

/**
 * Creates a child AbortController that aborts when its parent aborts.
 * Aborting the child does NOT affect the parent.
 *
 * Memory-safe: Uses WeakRef so the parent doesn't retain abandoned children.
 * If the child is dropped without being aborted, it can still be GC'd.
 * When the child IS aborted, the parent listener is removed to prevent
 * accumulation of dead handlers.
 *
 * @param parent - The parent AbortController
 * @param maxListeners - Maximum number of listeners (default: 50)
 * @returns Child AbortController
 */
export function createChildAbortController(
  parent: AbortController,
  maxListeners?: number,
): AbortController {
  const child = createAbortController(maxListeners)

  // Fast path: parent already aborted, no listener setup needed
  if (parent.signal.aborted) {
    child.abort(parent.signal.reason)
    return child
  }

  // WeakRef prevents the parent from keeping an abandoned child alive.
  // If all strong references to child are dropped without aborting it,
  // the child can still be GC'd — the parent only holds a dead WeakRef.
  const weakChild = new WeakRef(child)
  const weakParent = new WeakRef(parent)
  const handler = propagateAbort.bind(weakParent, weakChild)

  parent.signal.addEventListener('abort', handler, { once: true })

  // Auto-cleanup: remove parent listener when child is aborted (from any source).
  // Both parent and handler are weakly held — if either has been GC'd or the
  // parent already aborted ({once: true}), the cleanup is a harmless no-op.
  child.signal.addEventListener(
    'abort',
    removeAbortHandler.bind(weakParent, new WeakRef(handler)),
    { once: true },
  )

  return child
}

/**
 * An AbortController that stands in for `parent` until it is moved: aborting
 * either one aborts the other, exactly as if they were one controller.
 * `moveTo(next)` cuts that link; from then on only `next` aborting aborts it.
 *
 * A foreground agent runs on it so Esc (and Esc on the agent's permission
 * prompt) still stops the whole turn. Moved to the background with Ctrl+B,
 * the agent follows its own task instead: it outlives the turn and stops when
 * the task is killed.
 */
export function createMovableAbortController(parent: AbortController): {
  controller: AbortController
  moveTo(next: AbortController): void
  dispose(): void
} {
  const controller = createAbortController()
  let unlink = (): void => {}
  const link = (other: AbortController, twoWay: boolean): void => {
    unlink()
    unlink = () => {}
    if (other.signal.aborted) {
      controller.abort(other.signal.reason)
      return
    }
    const down = (): void => controller.abort(other.signal.reason)
    const up = (): void => other.abort(controller.signal.reason)
    other.signal.addEventListener('abort', down, { once: true })
    if (twoWay) controller.signal.addEventListener('abort', up, { once: true })
    unlink = () => {
      other.signal.removeEventListener('abort', down)
      if (twoWay) controller.signal.removeEventListener('abort', up)
    }
  }
  link(parent, true)
  return {
    controller,
    moveTo: next => link(next, false),
    dispose: () => {
      unlink()
      unlink = () => {}
    },
  }
}
