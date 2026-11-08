import { Worker } from 'worker_threads'
import { randomUUID } from 'crypto'
import type { CompiledMod } from './compiler.js'
import {
  MOD_METHODS,
  MOD_API_EVENTS,
  modEventPatternError,
  modHookSelects,
} from './contracts.js'
import { MOD_WORKER_SOURCE } from './worker.js'
import { MOD_REALM_PRELUDE } from './realmPrelude.js'
import { validateModResult } from './classic.js'
import { logForDebugging } from '../../debug.js'
import type { ModCallFrame } from './toolContext.js'
import { isModTurnAbort } from './sessionState.js'

export type ModRecord = Record<string, any>
const mutableEventFields: Record<string, ReadonlySet<string>> = {
  'prompt.submit': new Set(['text', 'context']),
  'skill.prompt': new Set(['text', 'frontmatter']),
  'session.compact': new Set(['instructions', 'messages']),
  'turn.start': new Set(),
  // Another model or effort goes down; the turn, index and count are pinned.
  'turn.step': new Set(['model', 'effort']),
  'turn.complete': new Set(),
  // A hook chooses the model of a subagent that is starting; nothing else.
  'agent.spawn': new Set(['model']),
  // A render hook may rewrite the site's props; the typing and the pick may
  // be rewritten before the control's own handler reads them.
  'ui.render': new Set(['props']),
  'ui.press': new Set(),
  'ui.input': new Set(['value']),
  'ui.select': new Set(['value']),
  'ui.close': new Set(),
  // Where the ring lands, where the window moves to: the rest is the engine's.
  'ui.focus': new Set(['element']),
  'ui.scroll': new Set(['offset']),
  // What a Client posted may be rewritten; every key of a fault is the engine's.
  'ui.message': new Set(['data']),
  'ui.fault': new Set(),
  // Every field is the engine's reading of the module, pinned.
  'plugin.register': new Set(),
  'engine.create': new Set(),
  // The facts a prompt is composed on that steer the engine's composition.
  'prompt.compose': new Set(['model', 'tools', 'traits']),
}
/** `off`: the host switched the hook off (why), so no event selects it. */
export type ModHook = { event: string; matcher?: ModRecord; hasCatch: boolean; off?: string }
export type ModHost = (
  method: string,
  args: any[],
  signal: AbortSignal,
  frame?: ModCallFrame,
) => Promise<unknown>
/** The chain's tiers, outermost first (Claude Code's TIERS). */
export const MOD_TIERS = ['prepend', 'user', 'append', 'builtin', 'core'] as const
export type ModTier = (typeof MOD_TIERS)[number]
/** One settled link beneath a hook's `next()`, as `next.trace` lists it. */
export type ModTraceEntry = {
  index: number
  plugin: string
  tier: string
  event: string
  outcome: 'caught' | 'expired' | 'kept' | 'passed' | 'rejected' | 'returned' | 'skipped'
  reason?: string
  ms: number
  /** A streaming link's chunks yielded up. */
  chunks?: number
  received: unknown
  returned: unknown
}
/** A `next.to(e, tier)`: continue at the first link of `to` or deeper. */
export type ModChainJump = { to: ModTier; by: string }
/** The collectors of the hooks above whose `next()` is in flight. */
export type ModTraceSinks = readonly ModTraceEntry[][]
export type ModContinuation = (event: ModRecord, jump?: ModChainJump, sinks?: ModTraceSinks) => Promise<unknown>
/** Where a streaming link's chunks go: the link above, or the engine. */
export type ModChunkSink = (chunk: unknown) => void
/** The rest of a streaming chain: it streams into `sink` and resolves with
 * the event's result; `signal` stops it (a hook stopped reading). */
export type ModStreamContinuation = (
  event: ModRecord,
  sink: ModChunkSink,
  signal: AbortSignal | undefined,
  jump?: ModChainJump,
  sinks?: ModTraceSinks,
) => Promise<unknown>
/** A streaming hook's calls on its `next`, and the chunks it yields. */
type ModStreamOps = {
  open(event: ModRecord, tier?: ModTier): { id: string }
  pull(id: string): Promise<{ chunks: unknown[]; done: boolean; result?: unknown; error?: string }>
  cancel(id: string): void
  chunk(chunk: unknown): void
}

/** One stream a hook opened with next(e): what it holds until pulled, and
 * how it ended. After the hook fails, `forward` sends the rest up. */
class ModChunkStream {
  readonly buffer: unknown[] = []
  readonly controller = new AbortController()
  done = false
  result: unknown
  error: unknown
  forward?: ModChunkSink
  private wake?: () => void
  push(chunk: unknown): void {
    if (this.forward) this.forward(chunk)
    else {
      this.buffer.push(chunk)
      this.wake?.()
    }
  }
  finish(error: unknown, result?: unknown): void {
    this.done = true
    this.error = error
    this.result = result
    this.wake?.()
  }
  async wait(): Promise<void> {
    while (!this.buffer.length && !this.done) await new Promise<void>(resolve => { this.wake = resolve })
    this.wake = undefined
  }
  async settled(): Promise<void> {
    while (!this.done) {
      await this.wait()
      if (!this.forward) this.buffer.length = 0
    }
  }
}
/** How one module takes part in one dispatch's chain. */
export type ModLinkOptions = {
  /** This module's tier, for next.origin's peers and next.to. */
  tier?: ModTier
  /** The chain index of this module's first selected hook. */
  base?: number
  sinks?: ModTraceSinks
  /** Every hook of this module is skipped: the event came from its own code
   * outside a hook (re-entry). */
  skipAll?: boolean
}
/** A `$` call made outside any running hook: a timer's callback, or work a
 * hook left running after it returned. It runs in the mod's own context. */
export type ModBackgroundHost = (
  method: string,
  args: any[],
  signal: AbortSignal,
) => Promise<unknown>
type ModInvocationResult =
  { matched: true; value: unknown } | { matched: false }
// Claude Code's HookBudget: a hook's own time per dispatch (waits on `next`
// and on `$` calls other than `$.clock.sleep` are free), and a `.catch`
// handler's grace.
const HOOK_BUDGET_MS = 10_000
const CATCH_BUDGET_MS = 1_000
const MOD_HOOK_TIMED_OUT = 'Mod hook timed out'
// A worker whose event loop stays blocked this long while it has timers or
// background calls is a runaway: no hook is pending to time it out. Longer
// than a hook's own budget, whose watchdog handles code running in a hook.
const BACKGROUND_STALL_MS = 35_000

/** One isolated worker per module; no Node globals or host objects enter its realm. */
export class ModRuntime {
  readonly hooks: ModHook[] = []
  private worker: Worker
  private pending = new Map<
    string,
    {
      resolve(value: ModInvocationResult): void
      reject(error: Error): void
      host: ModHost
      next: (event: ModRecord, tier?: ModTier) => Promise<unknown>
      /** A streaming event's next(e) streams, and the chunks the hook yields. */
      stream?: ModStreamOps
      /** What settled beneath on the hook's latest next(). */
      trace(): ModTraceEntry[]
      signal: AbortSignal
      pause(): () => void
      heartbeat(): void
      deferSelfAbort(): () => void
    }
  >()
  private cancellations = new Map<string, {
    watchdog: ReturnType<typeof setTimeout>
    done: Promise<void>
    acknowledge(): void
  }>()
  private dead = false
  // A submitted prompt belongs to the loaded mod, not the hook invocation
  // which queued it. Normal hook completion must not cancel that next turn.
  private lifetime = new AbortController()
  private ready: Promise<void>
  private backgroundHost?: ModBackgroundHost
  private background = new Map<string, AbortController>()
  private stall?: ReturnType<typeof setTimeout>
  private handled = new Map<string, { resolve(): void; reject(error: Error): void }>()
  /** Lent-method runs in flight: their answers, and the context their own
   * `$` calls are served in (the calling hook's). */
  private lent = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>()
  private lentHosts = new Map<string, ModBackgroundHost>()
  /** Prefixes the references to this module's drawn controls. */
  token?: string
  private personRuns = 0
  constructor(
    readonly plugin: { name: string; root: string },
    compiled: CompiledMod,
    options: ModRecord = {},
  ) {
    this.worker = new Worker(MOD_WORKER_SOURCE, {
      eval: true,
      workerData: { plugin, compiled, options, methods: [...MOD_METHODS], prelude: MOD_REALM_PRELUDE },
      resourceLimits: { maxOldGenerationSizeMb: 64, stackSizeMb: 4 },
    })
    this.ready = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Mod registration timed out'))
        void this.dispose()
      }, 5000)
      const finish = (error?: Error) => {
        clearTimeout(timeout)
        error ? reject(error) : resolve()
      }
      this.worker.on('error', (error) => {
        finish(error)
        this.fail(error)
      })
      this.worker.on('exit', () => {
        if (!this.dead) {
          const error = new Error('Mod worker exited')
          finish(error)
          this.fail(error)
        }
      })
      this.worker.on('message', (message) => {
        if (message.type === 'ready') {
          if (
            !Array.isArray(message.hooks) ||
            message.hooks.some(
              (hook: unknown) =>
                !hook ||
                typeof hook !== 'object' ||
                typeof (hook as ModHook).event !== 'string' ||
                typeof (hook as ModHook).hasCatch !== 'boolean',
            )
          ) {
            finish(new Error('Invalid mod registration metadata'))
            void this.dispose()
            return
          }
          const refusal = message.hooks
            .map((hook: ModHook) => modEventPatternError(hook.event))
            .find(Boolean)
          if (refusal) {
            finish(new Error(refusal))
            void this.dispose()
            return
          }
          this.hooks.push(...message.hooks)
          if (typeof message.token === 'string') this.token = message.token
          finish()
          return
        }
        if (message.type === 'failed') {
          finish(new Error(message.error))
          void this.dispose()
          return
        }
        if (message.type === 'result') {
          const invocation = this.pending.get(message.id)
          if (message.error) invocation?.reject(new Error(message.error))
          else if (message.matched === false)
            invocation?.resolve({ matched: false })
          else {
            if (message.voidAPIValue && message.value && typeof message.value === 'object') message.value.value = undefined
            invocation?.resolve({ matched: true, value: message.value })
          }
        }
        if (message.type === 'aborted') {
          const cancellation = this.cancellations.get(message.invocation)
          if (cancellation) {
            clearTimeout(cancellation.watchdog)
            this.cancellations.delete(message.invocation)
            cancellation.acknowledge()
          }
          this.releaseWorker()
        }
        if (message.type === 'call') void this.handleCall(message)
        if (message.type === 'chunk') this.pending.get(message.invocation)?.stream?.chunk(message.chunk)
        if (message.type === 'heartbeat')
          this.pending.get(message.invocation)?.heartbeat()
        if (message.type === 'cancel')
          this.background.get(message.id)?.abort(new Error('Mod timer cancelled'))
        if (message.type === 'debug' && typeof message.text === 'string')
          logForDebugging(`${this.plugin.name}: ${message.text}`, { level: 'warn' })
        // The worker reports liveness while it holds timers or background
        // calls. Silence past the limit means plugin code blocked its loop.
        if (message.type === 'alive' && !this.dead) {
          clearTimeout(this.stall)
          this.stall = setTimeout(() => {
            logForDebugging(`${this.plugin.name}: mod worker stopped responding outside a hook; unloading it`, { level: 'warn' })
            void this.dispose()
          }, BACKGROUND_STALL_MS)
          this.stall.unref()
        }
        if (message.type === 'idle') clearTimeout(this.stall)
        if (message.type === 'lentDone') {
          const waiting = this.lent.get(message.id)
          this.lent.delete(message.id)
          if (message.error) waiting?.reject(new Error(message.error))
          else waiting?.resolve(message.value)
        }
        if (message.type === 'handled') {
          const waiting = this.handled.get(message.id)
          this.handled.delete(message.id)
          if (message.error) waiting?.reject(new Error(message.error))
          else waiting?.resolve()
        }
      })
    })
  }
  async initialize(): Promise<void> {
    await this.ready
    this.worker.unref()
  }
  /** Serves `$` calls made outside a running hook, in the mod's own context. */
  setBackgroundHost(host: ModBackgroundHost): void {
    this.backgroundHost = host
  }
  /** Runs a drawn control's own closure (`onPress`, `onSubmit`, ...) in the
   * module, as a press or an input reached it. */
  runHandler(handler: string, args: unknown[]): Promise<void> {
    if (this.dead) return Promise.reject(new Error('Mod is unloaded'))
    const id = randomUUID()
    this.personRuns++
    // The worker is unref'd when idle; an unref'd worker must not be the only
    // thing keeping an awaited reply possible (Node may exit the process).
    this.worker.ref()
    return new Promise<void>((resolve, reject) => {
      this.handled.set(id, { resolve, reject })
      this.worker.postMessage({ type: 'handler', id, handler, args })
    }).finally(() => { this.personRuns--; this.releaseWorker() })
  }
  /** A control's closure is running: what it does, the person asked for. */
  servingPerson(): boolean {
    return this.personRuns > 0
  }
  /** The `$` every hook of this module sees once the engine.create fold
   * settled: the nouns other mods added, and the ones withheld. */
  setEngine(state: { lent: Record<string, Record<string, string>>; withheld: Record<string, string> }): void {
    if (!this.dead) this.worker.postMessage({ type: 'engine', state })
  }
  /**
   * Runs a method this module lent to `$` for another module's call. The
   * method's own `$` calls are served by `host`, in the calling hook's
   * context, until it settles; afterwards in this module's own.
   */
  runLent(id: string, args: unknown[], host: ModBackgroundHost): Promise<unknown> {
    if (this.dead) return Promise.reject(new Error('Mod is unloaded'))
    const callId = randomUUID()
    this.lentHosts.set(callId, host)
    this.worker.ref()
    return new Promise<unknown>((resolve, reject) => {
      this.lent.set(callId, { resolve, reject })
      this.worker.postMessage({ type: 'lent', id: callId, lent: id, args, ctx: callId })
    }).finally(() => { this.lentHosts.delete(callId); this.releaseWorker() })
  }
  private fail(error: Error): void {
    this.dead = true
    clearTimeout(this.stall)
    for (const waiting of this.handled.values()) waiting.reject(error)
    this.handled.clear()
    for (const waiting of this.lent.values()) waiting.reject(error)
    this.lent.clear()
    this.lentHosts.clear()
    this.lifetime.abort(error)
    for (const cancellation of this.cancellations.values()) {
      clearTimeout(cancellation.watchdog)
      cancellation.acknowledge()
    }
    this.cancellations.clear()
    for (const invocation of this.pending.values()) invocation.reject(error)
    this.pending.clear()
  }
  private releaseWorker(): void {
    if (!this.pending.size && !this.cancellations.size && !this.handled.size && !this.lent.size)
      this.worker.unref()
  }
  async dispose(): Promise<void> {
    this.fail(new Error('Mod unloaded'))
    await this.worker.terminate()
  }
  private async handleBackgroundCall(message: ModRecord): Promise<void> {
    const controller = new AbortController()
    const abort = () => controller.abort(this.lifetime.signal.reason)
    this.lifetime.signal.addEventListener('abort', abort, { once: true })
    this.background.set(message.id, controller)
    try {
      if (this.dead || this.lifetime.signal.aborted) throw new Error('Mod is unloaded')
      if (message.method === 'next' || String(message.method).startsWith('next.'))
        throw new Error('next() was called after its hook returned')
      // A call a lent method made while it ran for another module's hook.
      const host = (typeof message.ctx === 'string' && this.lentHosts.get(message.ctx)) || this.backgroundHost
      if (!host)
        throw new Error(`$.${message.method} needs a running hook in this session`)
      const value = await host(message.method, message.args, controller.signal)
      this.worker.postMessage({ type: 'reply', id: message.id, value,
        voidAPIValue: false })
    } catch (error) {
      logForDebugging(
        `${this.plugin.name}: mod API ${message.method} outside a hook failed: ${error instanceof Error ? error.message : String(error)}`,
      )
      this.worker.postMessage({
        type: 'reply',
        id: message.id,
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      this.background.delete(message.id)
      this.lifetime.signal.removeEventListener('abort', abort)
    }
  }
  private async handleCall(message: ModRecord): Promise<void> {
    if (message.invocation === null) return this.handleBackgroundCall(message)
    const invocation = this.pending.get(message.invocation)
    if (!invocation || invocation.signal.aborted || this.dead) {
      this.worker.postMessage({
        type: 'reply',
        id: message.id,
        error: 'Mod invocation is no longer active',
      })
      return
    }
    // Awaiting a next-turn receipt from a blocking hook cannot make progress.
    // Keep its normal execution budget running; fire-and-forget submission
    // returns from the hook immediately and retains the mod's lifetime signal.
    // A hook's own sleep is its own time, as in Claude Code: the clock keeps
    // running through `$.clock.sleep`, unlike any other `$` call.
    // A call the module itself may stop (a clip its AbortSignal ends).
    const own = new AbortController()
    this.background.set(message.id, own)
    const resume = message.method === 'prompt.submit' || message.method === 'clock.sleep'
      ? () => {}
      : invocation.pause()
    const releaseSelfAbort = message.method === 'turn.abort' ? invocation.deferSelfAbort() : () => {}
    // What settled beneath a next(), for next.trace: sent with its answer,
    // or its rejection.
    const traced = () => message.method === 'next' || message.method === 'next.pull'
      ? { trace: [...invocation.trace()].sort((a, b) => a.index - b.index) }
      : {}
    try {
      // A call outlives a hook that returns without awaiting it, as the mod's
      // own work: it stops when the event is abandoned or the mod unloads.
      const streamCall = (method: string, args: any[]) => {
        const stream = invocation.stream
        if (!stream) throw new Error('next() of this event is not a stream')
        if (method === 'next.open') return stream.open(args[0], args[1])
        if (method === 'next.pull') return stream.pull(String(args[0]?.id))
        return stream.cancel(String(args[0]?.id))
      }
      const value = await (message.method === 'next'
        ? invocation.next(message.args[0], message.args[1])
        : message.method === 'next.open' || message.method === 'next.pull' || message.method === 'next.cancel'
          ? streamCall(message.method, message.args)
        : invocation.host(message.method, message.args,
          message.method === 'prompt.submit'
            ? this.lifetime.signal
            : AbortSignal.any([invocation.signal, this.lifetime.signal, own.signal])))
      this.worker.postMessage({ type: 'reply', id: message.id, value,
        voidAPIValue: message.method === 'next' && value !== null && typeof value === 'object' && Object.hasOwn(value, 'value') && value.value === undefined,
        ...traced(),
      })
    } catch (error) {
      logForDebugging(
        `${this.plugin.name}: mod API ${message.method} failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
      )
      this.worker.postMessage({
        type: 'reply',
        id: message.id,
        error: error instanceof Error ? error.message : String(error),
        ...traced(),
      })
    } finally {
      this.background.delete(message.id)
      releaseSelfAbort()
      resume()
    }
  }
  private async invoke(
    index: number,
    input: ModRecord,
    meta: ModRecord,
    host: ModHost,
    next: (event: ModRecord, tier?: ModTier) => Promise<unknown>,
    signal?: AbortSignal,
    trace: () => ModTraceEntry[] = () => [],
    stream?: ModStreamOps,
  ): Promise<ModInvocationResult> {
    // Let cancelled continuations settle before another hook starts. Its own
    // execution budget must not include the cancellation acknowledgement wait.
    if (this.cancellations.size) {
      const waitingAt = Date.now()
      while (this.cancellations.size)
        await Promise.all([...this.cancellations.values()].map(item => item.done))
      meta = { ...meta, deadline: meta.deadline + Date.now() - waitingAt }
    }
    if (this.dead) return Promise.reject(new Error('Mod is unloaded'))
    if (signal?.aborted) return Promise.reject(new Error('Mod event aborted'))
    const id = randomUUID(),
      controller = new AbortController()
    this.worker.ref()
    return new Promise((resolve, reject) => {
      // A responsive worker can cancel this invocation and retain its module
      // state for completion and future hooks. Synchronous loops cannot receive
      // the cancellation message, so keep the worker alive until ack or kill.
      let selfAbort = 0
      let deferredAbort: ReturnType<typeof setTimeout> | undefined
      // Cancels this hook in the worker. One that cannot acknowledge within a
      // second is blocked in synchronous code, and its module is unloaded.
      const abortNow = (reason = 'Mod event aborted') => {
        let acknowledge!: () => void
        const done = new Promise<void>(resolve => { acknowledge = resolve })
        this.cancellations.set(id, {
          watchdog: setTimeout(() => void this.dispose(), 1000), done, acknowledge,
        })
        this.worker.postMessage({ type: 'abort', invocation: id })
        finish(() => reject(new Error(reason)), true)
      }
      const abort = () => {
        // An own-turn abort must acknowledge its API reply before cancelling
        // the caller. Bound the grace period so a handler cannot hold shutdown.
        if (selfAbort && isModTurnAbort(signal)) deferredAbort ??= setTimeout(abortNow, 1000)
        else abortNow()
      }
      let remaining = Math.max(1, meta.deadline - Date.now()),
        started = Date.now(),
        waiting = 0
      let timeout: ReturnType<typeof setTimeout>
      let watchdog: ReturnType<typeof setTimeout> | undefined
      let finished = false
      // Out of budget: the hook is skipped (its .catch asked with kind
      // 'timeout') and the module stays loaded, unless the worker is too
      // blocked to acknowledge the cancellation.
      const expired = () => abortNow(MOD_HOOK_TIMED_OUT)
      // No heartbeat while host work is pending: plugin code blocks the worker.
      const blocked = () => {
        finish(() => reject(new Error(MOD_HOOK_TIMED_OUT)), true)
        void this.dispose()
      }
      // Pending host work can pause the active budget, but must never mask
      // synchronous worker code that stopped yielding to its event loop.
      const heartbeat = () => {
        if (!waiting || finished) return
        clearTimeout(watchdog)
        watchdog = setTimeout(blocked, Math.max(1, meta.budget))
      }
      const arm = () => {
        started = Date.now()
        timeout = setTimeout(expired, remaining)
      }
      // `abandoned`: the event gave up on this hook (an interrupt, its budget),
      // so the calls it started stop too. A hook that returned or threw
      // leaves them running in the mod's lifetime, as Claude Code does.
      const finish = (action: () => void, abandoned = false) => {
        if (finished) return
        finished = true
        clearTimeout(timeout)
        clearTimeout(watchdog)
        clearTimeout(deferredAbort)
        signal?.removeEventListener('abort', abort)
        if (abandoned) controller.abort()
        this.pending.delete(id)
        this.releaseWorker()
        action()
      }
      signal?.addEventListener('abort', abort, { once: true })
      this.pending.set(id, {
        resolve: (value) => finish(() => resolve(value)),
        reject: (error) => finish(() => reject(error)),
        host: (method, args, signal) =>
          host(method, args, signal, {
            runtime: this,
            hook: index,
            event: meta.event,
          }),
        next,
        trace,
        stream,
        signal: controller.signal,
        heartbeat,
        deferSelfAbort: () => { selfAbort++; return () => { selfAbort-- } },
        pause: () => {
          if (waiting++ === 0) {
            remaining = Math.max(1, remaining - (Date.now() - started))
            clearTimeout(timeout)
            heartbeat()
          }
          let resumed = false
          return () => {
            if (resumed) return
            resumed = true
            if (--waiting === 0 && !finished) {
              clearTimeout(watchdog)
              arm()
            }
          }
        },
      })
      arm()
      this.worker.postMessage({
        type: 'invoke',
        index,
        invocation: id,
        input,
        meta,
      })
    })
  }
  async dispatch(
    event: string,
    input: ModRecord,
    core: ModContinuation,
    host: ModHost,
    options: {
      signal?: AbortSignal
      timeoutMs?: number
      origin?: { plugin: string; tier: string }
      skipHook?: number
      validateResult?: (result: ModRecord) => void
      validateInput?: (input: ModRecord) => void
      warn?: (message: string) => void
    } & ModLinkOptions = {},
  ): Promise<unknown> {
    await this.ready
    const selected = this.hooks.flatMap((hook, index) =>
      modHookSelects(hook, event) ? [index] : [],
    )
    const base = options.base ?? 0
    const tier: ModTier = options.tier ?? 'user'
    const plugin = this.plugin.name
    const settle = (sinks: ModTraceSinks, entry: Omit<ModTraceEntry, 'plugin' | 'tier' | 'event'>) => {
      const full: ModTraceEntry = { ...entry, plugin, tier, event }
      for (const sink of sinks) sink.push(full)
    }
    // This module's links a next.to above went beneath, traced as skipped.
    const bypass = (from: number, received: ModRecord, sinks: ModTraceSinks, reason: string) => {
      for (let position = from; position < selected.length; position++)
        settle(sinks, { index: base + position, outcome: 'skipped', reason, ms: 0, received, returned: undefined })
    }
    const run = async (
      position: number,
      current: ModRecord,
      sinks: ModTraceSinks,
    ): Promise<unknown> => {
      if (options.signal?.aborted) throw new Error('Mod event aborted')
      const index = selected[position]
      if (index === undefined) return core(current, undefined, sinks)
      const link = base + position
      // Re-entry: the event came from this hook's own $ call, or from the
      // module's code outside its hooks. The hook is skipped; a .catch handler
      // of it is asked with kind 're-entry'.
      const reentry = options.skipAll === true || index === options.skipHook
      if (reentry && !this.hooks[index]?.hasCatch) {
        settle(sinks, { index: link, outcome: 'skipped', reason: 're-entry', ms: 0, received: current, returned: undefined })
        return run(position + 1, current, sinks)
      }
      const started = Date.now()
      let inNext = 0
      let called: Promise<unknown> | undefined
      let downstreamFailure: unknown
      const latest = { trace: [] as ModTraceEntry[] }
      const next = (rewritten: ModRecord, target?: ModTier) => {
        if (
          !rewritten ||
          typeof rewritten !== 'object' ||
          Array.isArray(rewritten)
        )
          return Promise.reject(new Error('next() requires an event object'))
        if (recovering && called) return called
        if (MOD_API_EVENTS.has(event) && called)
          return Promise.reject(new Error('next() has already been called'))
        const mutable = Object.hasOwn(mutableEventFields, event) ? mutableEventFields[event] : undefined
        if (mutable) {
          if (called) return Promise.reject(new Error('next() has already been called'))
          for (const key of new Set([...Object.keys(current), ...Object.keys(rewritten)])) {
            if (!mutable.has(key) && rewritten[key] !== undefined && JSON.stringify(rewritten[key]) !== JSON.stringify(current[key]))
              return Promise.reject(new Error(`${event} cannot rewrite ${key}`))
          }
          rewritten = { ...current, ...Object.fromEntries(Object.entries(rewritten).filter(([key]) => mutable.has(key))) }
          if (event === 'prompt.submit' && (typeof rewritten.text !== 'string' || (rewritten.context !== undefined && (!Array.isArray(rewritten.context) || rewritten.context.some((text: unknown) => typeof text !== 'string')))))
            return Promise.reject(new Error('prompt.submit requires text and optional string context'))
          if (event === 'skill.prompt' && (typeof rewritten.text !== 'string' || !rewritten.frontmatter || typeof rewritten.frontmatter !== 'object' || Array.isArray(rewritten.frontmatter)))
            return Promise.reject(new Error('skill.prompt requires text and a frontmatter object'))
        }
        if (event === 'command.run') {
          for (const key of ['command', 'origin', 'presentation']) {
            if (
              rewritten[key] !== undefined &&
              JSON.stringify(rewritten[key]) !== JSON.stringify(current[key])
            )
              return Promise.reject(
                new Error(`command.run cannot rewrite ${key}`),
              )
          }
          rewritten = {
            ...rewritten,
            command: current.command,
            origin: current.origin,
            presentation: current.presentation,
          }
        }
        if (event === 'tool.call' || event === 'tool.check') {
          const keys =
            event === 'tool.call'
              ? ['tool', 'tool_use_id', 'agentId', 'consent']
              : ['tool', 'input', 'tool_use_id', 'isReadOnly', 'ceiling']
          for (const key of keys) {
            if (
              rewritten[key] !== undefined &&
              JSON.stringify(rewritten[key]) !== JSON.stringify(current[key])
            )
              return Promise.reject(new Error(`${event} cannot rewrite ${key}`))
          }
          rewritten = { ...rewritten }
          for (const key of keys) {
            if (current[key] === undefined) delete rewritten[key]
            else rewritten[key] = current[key]
          }
        }
        // next.to: an org mod continues at a deeper tier, never one with more
        // authority; its own remaining hooks and every link above that tier
        // are skipped.
        if (target !== undefined) {
          if (tier !== 'prepend' && tier !== 'append')
            return Promise.reject(new Error('next.to is for mods in prependPlugins or appendPlugins'))
          if (!(MOD_TIERS as readonly string[]).includes(target) || target === 'prepend' ||
              MOD_TIERS.indexOf(target) <= MOD_TIERS.indexOf(tier))
            return Promise.reject(new Error(`next.to cannot continue at ${String(target)} from the ${tier} tier`))
        }
        try {
          options.validateInput?.(rewritten)
        } catch (error) {
          return Promise.reject(error)
        }
        const sink: ModTraceEntry[] = []
        latest.trace = sink
        const below: ModTraceSinks = [...sinks, sink]
        const startedNext = Date.now()
        let downstream: Promise<unknown>
        if (target === undefined) downstream = run(position + 1, rewritten, below)
        else {
          bypass(position + 1, rewritten, below, `bypassed by ${plugin}`)
          downstream = core(rewritten, { to: target, by: plugin }, below)
        }
        return (called = downstream
          .finally(() => { inNext += Date.now() - startedNext })
          .catch(error => {
            downstreamFailure = error
            throw error
          }))
      }
      let recovering = false
      const budget = options.timeoutMs ?? HOOK_BUDGET_MS
      const meta = {
        deadline: Date.now() + budget,
        budget,
        origin: options.origin ?? { plugin: 'engine', tier: 'core' },
        event,
      }
      const normalizeResult = async (value: unknown): Promise<ModRecord> => {
        validateModResult(event, value)
        if (event === 'prompt.submit' && value.drop !== undefined && called) {
          const downstream = await called as ModRecord
          if (downstream.drop === undefined)
            throw new Error('prompt.submit returned a drop after its next() was answered')
        }
        // A write beneath landed: refusing it now would tell the caller it
        // failed. The hook fails instead, and what landed stands.
        if (event === 'state.set' && value.deny !== undefined && called &&
            await called.then(() => true, () => false))
          throw new Error('state.set returned a deny after its next() was answered')
        if (event === 'prompt.submit' && value.origin !== undefined && JSON.stringify(value.origin) !== JSON.stringify(input.origin))
          throw new Error('prompt.submit cannot rewrite origin')
        if (event === 'turn.start' && value.turnId !== input.turnId)
          throw new Error('turn.start cannot rewrite turnId')
        let result = value
        if (event === 'tool.call' && !result.deny && called) {
          const downstream = (await called) as ModRecord
          const own = result.context ?? []
          const inherited = (downstream.context ?? []).filter(
            (text: string) => !own.includes(text),
          )
          if (inherited.length)
            result = { ...result, context: [...inherited, ...own] }
        }
        options.validateResult?.(result)
        return result
      }
      // Its own time: the time its next() calls were in flight taken out.
      const record = (outcome: ModTraceEntry['outcome'], returned: unknown, reason?: string) =>
        settle(sinks, {
          index: link, outcome, ...(reason ? { reason } : {}),
          ms: Math.max(0, Date.now() - started - inNext), received: current, returned,
        })
      let failure: { kind: 'throw' | 'timeout' | 're-entry'; message?: string } | undefined
      let thrown: unknown
      if (reentry) failure = { kind: 're-entry', message: 'the event came from this mod\'s own mods API call' }
      else {
        try {
          const invocation = await this.invoke(
            index,
            current,
            meta,
            host,
            next,
            options.signal,
            () => latest.trace,
          )
          // Matcher execution belongs to the worker and shares the handler's
          // timeout. A hook its matcher passes over is no link of this chain.
          if (!invocation.matched) return run(position + 1, current, sinks)
          const value = await normalizeResult(invocation.value)
          record('returned', value)
          return value
        } catch (error) {
          if (options.signal?.aborted) {
            record('rejected', undefined)
            throw error
          }
          thrown = error
          const message = error instanceof Error ? error.message : String(error)
          // A transparent middleware forwarding a refused/stale API call has
          // not failed. Preserve the core error without a misleading hook warning.
          const forwardedFailure = downstreamFailure !== undefined && message === (downstreamFailure instanceof Error ? downstreamFailure.message : String(downstreamFailure))
          if (!forwardedFailure) options.warn?.(`${plugin}: ${event} hook skipped: ${message}`)
          failure = { kind: message === MOD_HOOK_TIMED_OUT ? 'timeout' : 'throw', message }
        }
      }
      recovering = true
      if (this.hooks[index]?.hasCatch && this.dead) {
        record('rejected', undefined)
        throw thrown ?? new Error('Mod is unloaded')
      }
      if (this.hooks[index]?.hasCatch && !this.dead) {
        try {
          const recovery = await this.invoke(
            index,
            current,
            {
              ...meta,
              deadline: Date.now() + CATCH_BUDGET_MS,
              budget: CATCH_BUDGET_MS,
              called: !!called,
              error: { ...failure, budget: CATCH_BUDGET_MS },
            },
            host,
            next,
            options.signal,
            () => latest.trace,
          )
          if (!recovery.matched)
            throw new Error('Mod catch handler was unexpectedly skipped')
          // An undefined answer is the hook absent: what beneath gives stands.
          if (recovery.value !== undefined) {
            const value = await normalizeResult(recovery.value)
            record('caught', value)
            return value
          }
        } catch (caught) {
          options.warn?.(
            `${plugin}: ${event} catch failed: ${String(caught)}`,
          )
        }
      }
      // What stands: the result of its last next(), or beneath, run in its place.
      const expired = failure?.kind === 'timeout'
      if (called) {
        try {
          const value = await called
          record(expired ? 'expired' : 'kept', value)
          return value
        } catch (error) {
          record('rejected', undefined)
          throw error
        }
      }
      record(expired ? 'expired' : 'skipped', undefined, failure?.kind === 're-entry' ? 're-entry' : undefined)
      return next(current)
    }
    return run(0, input, options.sinks ?? [])
  }

  /**
   * A streaming event's chain through this module (turn.step): each hook is
   * an async generator whose chunks go to `sink` as it yields them, its
   * `next(e)` the stream of everything beneath. A hook that fails is left:
   * what it yielded stays, the rest comes from beneath it.
   */
  async dispatchStream(
    event: string,
    input: ModRecord,
    sink: ModChunkSink,
    core: ModStreamContinuation,
    host: ModHost,
    options: {
      signal?: AbortSignal
      timeoutMs?: number
      origin?: { plugin: string; tier: string }
      skipHook?: number
      validateResult?: (result: ModRecord) => void
      validateInput?: (input: ModRecord) => void
      warn?: (message: string) => void
      /** The result of a hook that answered alone and returned nothing. */
      resultOf?: (chunks: unknown[], input: ModRecord) => unknown
    } & ModLinkOptions = {},
  ): Promise<unknown> {
    await this.ready
    const selected = this.hooks.flatMap((hook, index) =>
      modHookSelects(hook, event) ? [index] : [],
    )
    const base = options.base ?? 0
    const tier: ModTier = options.tier ?? 'user'
    const plugin = this.plugin.name
    const settle = (sinks: ModTraceSinks, entry: Omit<ModTraceEntry, 'plugin' | 'tier' | 'event'>) => {
      const full: ModTraceEntry = { ...entry, plugin, tier, event }
      for (const sink of sinks) sink.push(full)
    }
    const bypass = (from: number, received: ModRecord, sinks: ModTraceSinks, reason: string) => {
      for (let position = from; position < selected.length; position++)
        settle(sinks, { index: base + position, outcome: 'skipped', reason, ms: 0, received, returned: undefined })
    }
    const mutable = Object.hasOwn(mutableEventFields, event) ? mutableEventFields[event] : undefined
    const run = async (
      position: number,
      current: ModRecord,
      sink: ModChunkSink,
      sinks: ModTraceSinks,
      signal: AbortSignal | undefined,
    ): Promise<unknown> => {
      if (signal?.aborted) throw new Error('Mod event aborted')
      const index = selected[position]
      if (index === undefined) return core(current, sink, signal, undefined, sinks)
      const link = base + position
      if (options.skipAll === true || index === options.skipHook) {
        settle(sinks, { index: link, outcome: 'skipped', reason: 're-entry', ms: 0, received: current, returned: undefined })
        return run(position + 1, current, sink, sinks, signal)
      }
      const started = Date.now()
      let inNext = 0
      let yielded = 0
      const own: unknown[] = []
      const streams = new Map<string, ModChunkStream>()
      let last: ModChunkStream | undefined
      const latest = { trace: [] as ModTraceEntry[] }
      const open = (requested: ModRecord, target?: ModTier): { id: string } => {
        if (!requested || typeof requested !== 'object' || Array.isArray(requested))
          throw new Error('next() requires an event object')
        let rewritten = requested
        if (mutable) {
          for (const key of new Set([...Object.keys(current), ...Object.keys(rewritten)])) {
            if (!mutable.has(key) && rewritten[key] !== undefined && JSON.stringify(rewritten[key]) !== JSON.stringify(current[key]))
              throw new Error(`${event} cannot rewrite ${key}`)
          }
          rewritten = { ...current, ...Object.fromEntries(Object.entries(rewritten).filter(([key]) => mutable.has(key))) }
        }
        if (target !== undefined) {
          if (tier !== 'prepend' && tier !== 'append')
            throw new Error('next.to is for mods in prependPlugins or appendPlugins')
          if (!(MOD_TIERS as readonly string[]).includes(target) || target === 'prepend' ||
              MOD_TIERS.indexOf(target) <= MOD_TIERS.indexOf(tier))
            throw new Error(`next.to cannot continue at ${String(target)} from the ${tier} tier`)
        }
        options.validateInput?.(rewritten)
        const stream = new ModChunkStream()
        const id = randomUUID()
        streams.set(id, stream)
        last = stream
        const trace: ModTraceEntry[] = []
        latest.trace = trace
        const below: ModTraceSinks = [...sinks, trace]
        const streamSignal = signal ? AbortSignal.any([signal, stream.controller.signal]) : stream.controller.signal
        const startedNext = Date.now()
        let downstream: Promise<unknown>
        if (target === undefined) downstream = run(position + 1, rewritten, chunk => stream.push(chunk), below, streamSignal)
        else {
          bypass(position + 1, rewritten, below, `bypassed by ${plugin}`)
          downstream = core(rewritten, chunk => stream.push(chunk), streamSignal, { to: target, by: plugin }, below)
        }
        downstream
          .then(value => stream.finish(undefined, value), error => stream.finish(error ?? new Error('the stream beneath failed')))
          .finally(() => { inNext += Date.now() - startedNext })
        return { id }
      }
      const ops: ModStreamOps = {
        open,
        async pull(id) {
          const stream = streams.get(id)
          if (!stream) throw new Error('That stream is closed')
          await stream.wait()
          const chunks = stream.buffer.splice(0)
          if (!stream.done) return { chunks, done: false }
          return stream.error !== undefined
            ? { chunks, done: true, error: stream.error instanceof Error ? stream.error.message : String(stream.error) }
            : { chunks, done: true, result: stream.result }
        },
        cancel(id) {
          const stream = streams.get(id)
          if (stream && !stream.done) stream.controller.abort(new Error('the hook stopped reading'))
        },
        chunk(chunk) {
          yielded++
          own.push(chunk)
          sink(chunk)
        },
      }
      // Streams a hook left unread when it finished stop: their requests end.
      const closeOthers = (keep?: ModChunkStream) => {
        for (const stream of streams.values())
          if (stream !== keep && !stream.done) stream.controller.abort(new Error('the hook finished'))
      }
      const record = (outcome: ModTraceEntry['outcome'], returned: unknown, reason?: string) =>
        settle(sinks, {
          index: link, outcome, ...(reason ? { reason } : {}),
          ms: Math.max(0, Date.now() - started - inNext), chunks: yielded, received: current, returned,
        })
      const budget = options.timeoutMs ?? HOOK_BUDGET_MS
      const meta = {
        deadline: Date.now() + budget,
        budget,
        origin: options.origin ?? { plugin: 'engine', tier: 'core' },
        event,
        stream: true,
      }
      try {
        const invocation = await this.invoke(
          index, current, meta, host,
          async () => { throw new Error('next() of a streaming event is a stream') },
          signal, () => latest.trace, ops,
        )
        if (!invocation.matched) return run(position + 1, current, sink, sinks, signal)
        let value = invocation.value
        if (value === undefined && last) {
          // Returning nothing lets its last next(e)'s result stand.
          closeOthers(last)
          await last.settled()
          if (last.error !== undefined) throw last.error
          value = last.result
        } else {
          closeOthers()
          if (value === undefined) value = options.resultOf?.(own, current)
        }
        validateModResult(event, value)
        options.validateResult?.(value as ModRecord)
        record('returned', value)
        return value
      } catch (error) {
        if (signal?.aborted) {
          record('rejected', undefined)
          throw error
        }
        const message = error instanceof Error ? error.message : String(error)
        // A hook that only passed on a failure beneath it has not failed.
        const forwarded = !!last?.done && last.error !== undefined &&
          message === (last.error instanceof Error ? last.error.message : String(last.error))
        if (!forwarded) options.warn?.(`${plugin}: ${event} hook skipped: ${message}`)
        const expired = message === MOD_HOOK_TIMED_OUT
        // What it yielded stays; the rest comes from beneath it: the stream
        // it opened, else everything beneath run now.
        if (last) {
          closeOthers(last)
          for (const chunk of last.buffer.splice(0)) sink(chunk)
          last.forward = sink
          await last.settled()
          if (last.error !== undefined) {
            record('rejected', undefined)
            throw last.error
          }
          record(expired ? 'expired' : 'kept', last.result)
          return last.result
        }
        record(expired ? 'expired' : 'skipped', undefined)
        return run(position + 1, current, sink, sinks, signal)
      }
    }
    return run(0, input, sink, options.sinks ?? [], options.signal)
  }
}
