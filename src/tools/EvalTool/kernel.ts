import { type ChildProcess, spawn, spawnSync } from 'child_process'
import { randomUUID } from 'crypto'
import { connect } from 'net'

import { logForDebugging } from '../../utils/debug.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import {
  EVAL_TRACE_ENV,
  INTERRUPT_ESCALATION_MS,
  SHUTDOWN_GRACE_MS,
} from './constants.js'
import {
  buildKernelEnv,
  ensureRunnerOnDisk,
  resolvePythonInterpreter,
} from './pythonRuntime.js'
import type { DeadlineBudget } from './toolBridge.js'

export type KernelDisplay = { mime: string; data: string }
export type KernelStatus = { op: string; detail: string }

export type CellOutcome = {
  ok: boolean
  stdout: string
  stderr: string
  result?: string
  error?: { ename: string; evalue: string; traceback: string }
  displays: KernelDisplay[]
  statuses: KernelStatus[]
  executionCount: number
  cancelled: boolean
  timedOut: boolean
  /** The kernel died mid-cell and had to be discarded. */
  crashed: boolean
}

type Frame = Record<string, unknown>

export type KernelOptions = {
  cwd: string
  bridgeUrl: string
  bridgeToken: string
  bridgeSession: string
}

function trace(message: string): void {
  if (isEnvTruthy(process.env[EVAL_TRACE_ENV])) {
    logForDebugging(`[eval] ${message}`)
  }
}

/**
 * One persistent Python subprocess speaking NDJSON.
 *
 * Spawn flags are load-bearing on Windows and are explained inline; do not
 * "tidy" them without reading those comments.
 */
export class PythonKernel {
  #proc: ChildProcess | null = null
  #cancelPort = 0
  readonly #cancelToken = randomUUID()
  #buffer = ''
  #onFrame: ((frame: Frame) => void) | null = null
  #exited = false
  #startPromise: Promise<void> | null = null
  #starting = false
  #busy = false

  constructor(private readonly options: KernelOptions) {}

  isAlive(): boolean {
    return this.#proc !== null && !this.#exited && this.#proc.exitCode === null
  }

  /**
   * Start the kernel, or restart it if the previous process died.
   *
   * The restart branch is not theoretical: a segfault in a native extension, an
   * OOM kill, or a `killTree()` escalation all leave a resolved start promise
   * pointing at a corpse. Without discarding it, every later `execute()` would
   * write into a closed stdin and report a crash forever.
   */
  async start(): Promise<void> {
    if (this.#startPromise && !this.#starting && !this.isAlive()) {
      this.#startPromise = null
      this.#proc = null
      this.#exited = false
      this.#cancelPort = 0
      // A partial line left by the dead process would corrupt the first frame
      // of the new one.
      this.#buffer = ''
      this.#onFrame = null
    }
    if (!this.#startPromise) {
      this.#starting = true
      this.#startPromise = this.#doStart().finally(() => {
        this.#starting = false
      })
    }
    try {
      await this.#startPromise
    } catch (error) {
      this.#startPromise = null
      throw error
    }
  }

  async #doStart(): Promise<void> {
    const interpreter = resolvePythonInterpreter()
    if (!interpreter) throw new Error('No Python interpreter available.')
    const runner = ensureRunnerOnDisk()

    const proc = spawn(interpreter, ['-u', runner], {
      cwd: this.options.cwd,
      env: buildKernelEnv({
        TAU_EVAL_CWD: this.options.cwd,
        TAU_EVAL_CANCEL_TOKEN: this.#cancelToken,
        TAU_EVAL_BRIDGE_URL: this.options.bridgeUrl,
        TAU_EVAL_BRIDGE_TOKEN: this.options.bridgeToken,
        TAU_EVAL_BRIDGE_SESSION: this.options.bridgeSession,
      }),
      stdio: ['pipe', 'pipe', 'pipe'],
      // NOT windowsHide. CREATE_NO_WINDOW detaches the child from the console,
      // and NumPy's native extensions (OpenBLAS thread-pool init inside
      // LoadLibraryExW) can deadlock on Windows with no console attached. Node
      // defaults this to false; it is spelled out so nobody "optimizes" the
      // console flash away and reintroduces a hang that looks like a timeout.
      windowsHide: false,
      // POSIX: own process group, so a shutdown kills anything the cell
      // spawned. Windows has no process groups; killTree() uses taskkill /T.
      detached: process.platform !== 'win32',
    })

    this.#proc = proc
    this.#exited = false
    proc.stdout?.setEncoding('utf8')
    proc.stderr?.setEncoding('utf8')
    proc.stdout?.on('data', (chunk: string) => this.#ingest(chunk))
    proc.stderr?.on('data', (chunk: string) => {
      // Interpreter-level noise (a segfault message, a warning before our
      // proxies are installed). Never protocol; log and move on.
      trace(`kernel stderr: ${chunk.trim()}`)
    })
    proc.on('exit', code => {
      this.#exited = true
      trace(`kernel exited with ${code}`)
    })
    proc.on('error', error => {
      this.#exited = true
      logForDebugging(`Eval kernel failed to spawn: ${String(error)}`, {
        level: 'error',
      })
    })

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#onFrame = null
        reject(new Error('Python kernel did not report ready within 20s.'))
      }, 20_000)
      this.#onFrame = frame => {
        if (frame.type !== 'ready') return
        clearTimeout(timer)
        this.#cancelPort = Number(frame.cancelPort) || 0
        this.#onFrame = null
        resolve()
      }
      proc.on('exit', () => {
        clearTimeout(timer)
        reject(new Error('Python kernel exited before reporting ready.'))
      })
    })
  }

  #ingest(chunk: string): void {
    this.#buffer += chunk
    let index = this.#buffer.indexOf('\n')
    while (index !== -1) {
      const line = this.#buffer.slice(0, index).trim()
      this.#buffer = this.#buffer.slice(index + 1)
      if (line) {
        try {
          const frame = JSON.parse(line) as Frame
          trace(`<- ${line.slice(0, 200)}`)
          this.#onFrame?.(frame)
        } catch {
          trace(`unparseable kernel line: ${line.slice(0, 200)}`)
        }
      }
      index = this.#buffer.indexOf('\n')
    }
  }

  #send(payload: Record<string, unknown>): void {
    const line = `${JSON.stringify(payload)}\n`
    trace(`-> ${line.trim().slice(0, 200)}`)
    this.#proc?.stdin?.write(line)
  }

  /**
   * Interrupt the running cell without killing the kernel.
   *
   * Connects to the kernel's loopback cancel socket and presents the shared
   * token; the kernel's listener thread calls `_thread.interrupt_main()`.
   * Signals are not used: on Windows, Node's documented behavior is to ignore
   * the signal argument and terminate the process, so a SIGINT-based design
   * would destroy the namespace on every Ctrl+C.
   */
  cancel(): void {
    if (!this.#cancelPort || !this.isAlive()) return
    try {
      const socket = connect(this.#cancelPort, '127.0.0.1')
      socket.setTimeout(2_000)
      socket.on('connect', () => socket.end(this.#cancelToken))
      socket.on('timeout', () => socket.destroy())
      socket.on('error', error => trace(`cancel socket error: ${String(error)}`))
    } catch (error) {
      trace(`cancel failed: ${String(error)}`)
    }
  }

  /**
   * Run one cell. Resolves with an outcome even for a failed or interrupted
   * cell; it rejects only when the kernel itself is unusable.
   */
  async execute(
    code: string,
    opts: { timeoutMs: number; signal?: AbortSignal; budget?: DeadlineBudget },
  ): Promise<CellOutcome> {
    if (!this.isAlive()) await this.start()
    // `#onFrame` is a single slot, so two overlapping cells would steal each
    // other's frames. The tool is exclusive, so this should be unreachable —
    // fail loudly rather than corrupt an unrelated cell's output.
    if (this.#busy) {
      throw new Error('This kernel is already running a cell.')
    }
    this.#busy = true

    const id = randomUUID()
    const stdout: string[] = []
    const stderr: string[] = []
    const displays: KernelDisplay[] = []
    const statuses: KernelStatus[] = []
    let result: string | undefined
    let error: CellOutcome['error']
    let timedOut = false
    let cancelRequested = false

    return await new Promise<CellOutcome>((resolve, reject) => {
      let settled = false
      let escalation: NodeJS.Timeout | undefined
      let deadline: NodeJS.Timeout | undefined

      const finish = (outcome: CellOutcome) => {
        if (settled) return
        settled = true
        this.#busy = false
        clearInterval(deadline)
        clearTimeout(escalation)
        this.#onFrame = null
        opts.signal?.removeEventListener('abort', onAbort)
        this.#proc?.removeListener('exit', onExit)
        resolve(outcome)
      }

      const requestCancel = (wasTimeout: boolean) => {
        if (settled || cancelRequested) return
        cancelRequested = true
        timedOut = wasTimeout
        this.cancel()
        // If the interpreter is wedged in native code holding the GIL, the
        // interrupt never lands. Give it a bounded grace period, then throw
        // the kernel away so the next cell gets a clean one.
        escalation = setTimeout(() => {
          void this.shutdown()
          finish({
            ok: false,
            stdout: stdout.join(''),
            stderr: stderr.join(''),
            result,
            error: {
              ename: 'KernelUnresponsive',
              evalue:
                'The cell did not stop after an interrupt and the kernel was terminated. State is gone; re-run your setup.',
              traceback: '',
            },
            displays,
            statuses,
            executionCount: 0,
            cancelled: true,
            timedOut: wasTimeout,
            crashed: true,
          })
        }, INTERRUPT_ESCALATION_MS)
      }

      const onAbort = () => requestCancel(false)
      const onExit = () => {
        if (settled) return
        settled = true
        this.#busy = false
        clearInterval(deadline)
        clearTimeout(escalation)
        this.#onFrame = null
        opts.signal?.removeEventListener('abort', onAbort)
        resolve({
          ok: false,
          stdout: stdout.join(''),
          stderr: stderr.join(''),
          result,
          error: {
            ename: 'KernelDied',
            evalue:
              'The Python kernel exited while the cell was running. It will be restarted on the next call; state is gone.',
            traceback: '',
          },
          displays,
          statuses,
          executionCount: 0,
          cancelled: false,
          timedOut,
          crashed: true,
        })
      }

      this.#onFrame = frame => {
        if (frame.id !== undefined && frame.id !== id && frame.type !== 'ready') {
          return
        }
        switch (frame.type) {
          case 'stdout':
            stdout.push(String(frame.data ?? ''))
            return
          case 'stderr':
            stderr.push(String(frame.data ?? ''))
            return
          case 'display':
            displays.push({
              mime: String(frame.mime ?? 'text/plain'),
              data: String(frame.data ?? ''),
            })
            return
          case 'status':
            statuses.push({
              op: String(frame.op ?? ''),
              detail: String(frame.detail ?? ''),
            })
            return
          case 'result':
            result = String(frame.text ?? '')
            return
          case 'error':
            error = {
              ename: String(frame.ename ?? 'Error'),
              evalue: String(frame.evalue ?? ''),
              traceback: String(frame.traceback ?? ''),
            }
            return
          case 'done':
            finish({
              ok: Boolean(frame.ok),
              stdout: stdout.join(''),
              stderr: stderr.join(''),
              result,
              error,
              displays,
              statuses,
              executionCount: Number(frame.count ?? 0),
              cancelled: Boolean(frame.cancelled),
              timedOut,
              crashed: false,
            })
            return
          default:
            return
        }
      }

      this.#proc?.once('exit', onExit)

      if (opts.signal?.aborted) {
        queueMicrotask(() => requestCancel(false))
      } else {
        opts.signal?.addEventListener('abort', onAbort, { once: true })
      }
      if (opts.timeoutMs > 0) {
        // Not a plain setTimeout: time spent inside a bridge call — a slow
        // Bash command, a network fetch, or a permission prompt waiting on the
        // user — is not the cell hanging, so it must not count against the
        // deadline. Poll instead, subtracting whatever the budget has parked.
        const startedAt = Date.now()
        deadline = setInterval(() => {
          const paused = opts.budget?.pausedMs() ?? 0
          if (Date.now() - startedAt - paused >= opts.timeoutMs) {
            requestCancel(true)
          }
        }, 250)
        deadline.unref?.()
      }

      try {
        this.#send({ type: 'exec', id, code })
      } catch (sendError) {
        // The timers are armed above; without clearing them here the poll
        // interval would outlive the rejected call and tick forever.
        settled = true
        this.#busy = false
        clearInterval(deadline)
        clearTimeout(escalation)
        this.#onFrame = null
        opts.signal?.removeEventListener('abort', onAbort)
        this.#proc?.removeListener('exit', onExit)
        reject(sendError)
      }
    })
  }

  async reset(): Promise<void> {
    if (!this.isAlive()) {
      await this.start()
      return
    }
    await new Promise<void>(resolve => {
      const id = randomUUID()
      const timer = setTimeout(() => {
        this.#onFrame = null
        resolve()
      }, 5_000)
      this.#onFrame = frame => {
        if (frame.type !== 'done' || frame.id !== id) return
        clearTimeout(timer)
        this.#onFrame = null
        resolve()
      }
      this.#send({ type: 'reset', id })
    })
  }

  /**
   * Close the control pipe without killing anything. Test-only: this is what a
   * hard-killed parent looks like from the kernel's side, and the kernel must
   * exit on its own when it happens — otherwise every crashed session leaks a
   * python.exe on Windows, where there are no process groups to clean up.
   */
  closeStdinForTests(): void {
    this.#proc?.stdin?.end()
  }

  /** Test-only: resolve true if the process exits within `timeoutMs`. */
  async waitForExit(timeoutMs: number): Promise<boolean> {
    if (!this.isAlive()) return true
    return await new Promise<boolean>(resolve => {
      const timer = setTimeout(() => resolve(false), timeoutMs)
      this.#proc?.once('exit', () => {
        clearTimeout(timer)
        resolve(true)
      })
    })
  }

  /** Kill the kernel and everything it spawned. */
  killTree(): void {
    const proc = this.#proc
    if (!proc?.pid) return
    if (process.platform === 'win32') {
      // Windows has no process groups, so signalling the direct pid leaves
      // grandchildren (a `%pip install`, a subprocess.run) holding the pipes
      // open for the rest of the host's life. taskkill /T walks the tree.
      try {
        spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        })
      } catch {
        /* the process is already gone, which is the outcome we wanted */
      }
      return
    }
    try {
      process.kill(-proc.pid, 'SIGKILL')
    } catch {
      try {
        proc.kill('SIGKILL')
      } catch {
        /* already gone */
      }
    }
  }

  async shutdown(): Promise<void> {
    const proc = this.#proc
    this.#startPromise = null
    this.#busy = false
    if (!proc || this.#exited) {
      this.#proc = null
      return
    }
    try {
      this.#send({ type: 'exit' })
    } catch {
      /* the pipe is already closed */
    }
    const exited = await new Promise<boolean>(resolve => {
      const timer = setTimeout(() => resolve(false), SHUTDOWN_GRACE_MS)
      proc.once('exit', () => {
        clearTimeout(timer)
        resolve(true)
      })
    })
    if (!exited) this.killTree()
    this.#proc = null
    this.#exited = true
  }
}
