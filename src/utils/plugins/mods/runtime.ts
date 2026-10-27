import { Worker } from 'worker_threads'
import { randomUUID } from 'crypto'
import type { CompiledMod } from './compiler.js'
import { MOD_EVENTS, MOD_METHODS } from './contracts.js'
import { MOD_WORKER_SOURCE } from './worker.js'
import { validateModResult } from './classic.js'
import { logForDebugging } from '../../debug.js'
import type { ModCallFrame } from './toolContext.js'

export type ModRecord = Record<string, any>
export type ModHook = { event: string; matcher?: ModRecord; hasCatch: boolean }
export type ModHost = (
  method: string,
  args: any[],
  signal: AbortSignal,
  frame?: ModCallFrame,
) => Promise<unknown>
export type ModContinuation = (event: ModRecord) => Promise<unknown>
type ModInvocationResult =
  { matched: true; value: unknown } | { matched: false }

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
      next: ModContinuation
      signal: AbortSignal
      pause(): () => void
      heartbeat(): void
    }
  >()
  private cancellations = new Map<string, {
    watchdog: ReturnType<typeof setTimeout>
    done: Promise<void>
    acknowledge(): void
  }>()
  private dead = false
  private ready: Promise<void>
  constructor(
    readonly plugin: { name: string; root: string },
    compiled: CompiledMod,
    options: ModRecord = {},
  ) {
    this.worker = new Worker(MOD_WORKER_SOURCE, {
      eval: true,
      workerData: { plugin, compiled, options, methods: [...MOD_METHODS] },
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
          const unsupported = message.hooks.find(
            (hook: ModHook) => !MOD_EVENTS.has(hook.event),
          )
          if (unsupported) {
            finish(
              new Error(
                `Tau does not yet support mod event "${unsupported.event}"`,
              ),
            )
            void this.dispose()
            return
          }
          this.hooks.push(...message.hooks)
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
          else invocation?.resolve({ matched: true, value: message.value })
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
        if (message.type === 'heartbeat')
          this.pending.get(message.invocation)?.heartbeat()
      })
    })
  }
  async initialize(): Promise<void> {
    await this.ready
    this.worker.unref()
  }
  private fail(error: Error): void {
    this.dead = true
    for (const cancellation of this.cancellations.values()) {
      clearTimeout(cancellation.watchdog)
      cancellation.acknowledge()
    }
    this.cancellations.clear()
    for (const invocation of this.pending.values()) invocation.reject(error)
    this.pending.clear()
  }
  private releaseWorker(): void {
    if (!this.pending.size && !this.cancellations.size) this.worker.unref()
  }
  async dispose(): Promise<void> {
    this.fail(new Error('Mod unloaded'))
    await this.worker.terminate()
  }
  private async handleCall(message: ModRecord): Promise<void> {
    const invocation = this.pending.get(message.invocation)
    if (!invocation || invocation.signal.aborted || this.dead) {
      this.worker.postMessage({
        type: 'reply',
        id: message.id,
        error: 'Mod invocation is no longer active',
      })
      return
    }
    const resume = invocation.pause()
    try {
      const value = await (message.method === 'next'
        ? invocation.next(message.args[0])
        : invocation.host(message.method, message.args, invocation.signal))
      this.worker.postMessage({ type: 'reply', id: message.id, value })
    } catch (error) {
      logForDebugging(
        `${this.plugin.name}: mod API ${message.method} failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
      )
      this.worker.postMessage({
        type: 'reply',
        id: message.id,
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      resume()
    }
  }
  private async invoke(
    index: number,
    input: ModRecord,
    meta: ModRecord,
    host: ModHost,
    next: ModContinuation,
    signal?: AbortSignal,
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
      const abort = () => {
        let acknowledge!: () => void
        const done = new Promise<void>(resolve => { acknowledge = resolve })
        this.cancellations.set(id, {
          watchdog: setTimeout(() => void this.dispose(), 1000), done, acknowledge,
        })
        this.worker.postMessage({ type: 'abort', invocation: id })
        finish(() => reject(new Error('Mod event aborted')))
      }
      let remaining = Math.max(1, meta.deadline - Date.now()),
        started = Date.now(),
        waiting = 0
      let timeout: ReturnType<typeof setTimeout>
      let watchdog: ReturnType<typeof setTimeout> | undefined
      let finished = false
      const expired = () => {
        finish(() => reject(new Error('Mod hook timed out')))
        void this.dispose()
      }
      // Pending host work can pause the active budget, but must never mask
      // synchronous worker code that stopped yielding to its event loop.
      const heartbeat = () => {
        if (!waiting || finished) return
        clearTimeout(watchdog)
        watchdog = setTimeout(expired, Math.max(1, meta.budget))
      }
      const arm = () => {
        started = Date.now()
        timeout = setTimeout(expired, remaining)
      }
      const finish = (action: () => void) => {
        if (finished) return
        finished = true
        clearTimeout(timeout)
        clearTimeout(watchdog)
        signal?.removeEventListener('abort', abort)
        controller.abort()
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
        signal: controller.signal,
        heartbeat,
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
      warn?: (message: string) => void
    } = {},
  ): Promise<unknown> {
    await this.ready
    const indexes = this.hooks.flatMap((hook, index) =>
      hook.event === event && index !== options.skipHook ? [index] : [],
    )
    const run = async (
      position: number,
      current: ModRecord,
    ): Promise<unknown> => {
      if (options.signal?.aborted) throw new Error('Mod event aborted')
      const index = indexes[position]
      if (index === undefined) return core(current)
      let called: Promise<unknown> | undefined
      const next = (rewritten: ModRecord) => {
        if (
          !rewritten ||
          typeof rewritten !== 'object' ||
          Array.isArray(rewritten)
        )
          return Promise.reject(new Error('next() requires an event object'))
        if (recovering && called) return called
        if (event === 'prompt.submit' || event === 'skill.prompt' || event === 'turn.start' || event === 'turn.complete') {
          if (called) return Promise.reject(new Error('next() has already been called'))
          const mutable = event === 'prompt.submit' ? new Set(['text', 'context']) : event === 'skill.prompt' ? new Set(['text', 'frontmatter']) : new Set<string>()
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
        return (called = run(position + 1, rewritten))
      }
      let recovering = false
      const budget = options.timeoutMs ?? 30_000
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
      try {
        const invocation = await this.invoke(
          index,
          current,
          meta,
          host,
          next,
          options.signal,
        )
        // Matcher execution belongs to the worker and shares the handler's
        // timeout. Its transport metadata is separate from a mod's return value.
        if (!invocation.matched) return run(position + 1, current)
        return await normalizeResult(invocation.value)
      } catch (error) {
        if (options.signal?.aborted) throw error
        const message = error instanceof Error ? error.message : String(error)
        options.warn?.(`${this.plugin.name}: ${event} hook skipped: ${message}`)
        recovering = true
        if (this.hooks[index]?.hasCatch && this.dead) throw error
        if (this.hooks[index]?.hasCatch && !this.dead) {
          try {
            const recovery = await this.invoke(
              index,
              current,
              {
                ...meta,
                deadline: Date.now() + budget,
                called: !!called,
                error: { kind: 'throw', message },
              },
              host,
              next,
              options.signal,
            )
            if (!recovery.matched)
              throw new Error('Mod catch handler was unexpectedly skipped')
            return await normalizeResult(recovery.value)
          } catch (failure) {
            options.warn?.(
              `${this.plugin.name}: ${event} catch failed: ${String(failure)}`,
            )
          }
        }
        return called ?? next(current)
      }
    }
    return run(0, input)
  }
}
