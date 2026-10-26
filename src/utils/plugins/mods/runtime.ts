import { Worker } from 'worker_threads'
import { randomUUID } from 'crypto'
import type { CompiledMod } from './compiler.js'
import { MOD_EVENTS, MOD_METHODS } from './contracts.js'
import { MOD_WORKER_SOURCE } from './worker.js'
import { validateModResult } from './classic.js'
import { logForDebugging } from '../../debug.js'

export type ModRecord = Record<string, any>
export type ModHook = { event: string; matcher?: ModRecord; hasCatch: boolean }
export type ModHost = (
  method: string,
  args: any[],
  signal: AbortSignal,
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
    }
  >()
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
        if (message.type === 'call') void this.handleCall(message)
      })
    })
  }
  async initialize(): Promise<void> {
    await this.ready
    this.worker.unref()
  }
  private fail(error: Error): void {
    this.dead = true
    for (const invocation of this.pending.values()) invocation.reject(error)
    this.pending.clear()
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
    }
  }
  private invoke(
    index: number,
    input: ModRecord,
    meta: ModRecord,
    host: ModHost,
    next: ModContinuation,
    signal?: AbortSignal,
  ): Promise<ModInvocationResult> {
    if (this.dead) return Promise.reject(new Error('Mod is unloaded'))
    if (signal?.aborted) return Promise.reject(new Error('Mod event aborted'))
    const id = randomUUID(),
      controller = new AbortController()
    this.worker.ref()
    return new Promise((resolve, reject) => {
      // Termination also stops synchronous loops, which cannot receive an abort message.
      const abort = () => {
        finish(() => reject(new Error('Mod event aborted')))
        void this.dispose()
      }
      const timeout = setTimeout(
        () => {
          finish(() => reject(new Error('Mod hook timed out')))
          void this.dispose()
        },
        Math.max(1, meta.deadline - Date.now()),
      )
      const finish = (action: () => void) => {
        clearTimeout(timeout)
        signal?.removeEventListener('abort', abort)
        controller.abort()
        this.pending.delete(id)
        if (!this.pending.size) this.worker.unref()
        action()
      }
      signal?.addEventListener('abort', abort, { once: true })
      this.pending.set(id, {
        resolve: (value) => finish(() => resolve(value)),
        reject: (error) => finish(() => reject(error)),
        host,
        next,
        signal: controller.signal,
      })
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
      warn?: (message: string) => void
    } = {},
  ): Promise<unknown> {
    await this.ready
    const indexes = this.hooks.flatMap((hook, index) =>
      hook.event === event ? [index] : [],
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
        return (called = run(position + 1, rewritten))
      }
      let recovering = false
      const budget = options.timeoutMs ?? 30_000
      const meta = {
        deadline: Date.now() + budget,
        budget,
        origin: options.origin ?? { plugin: 'engine', tier: 'core' },
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
        const result = invocation.value
        validateModResult(event, result)
        return result
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
            const result = recovery.value
            validateModResult(event, result)
            return result
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
