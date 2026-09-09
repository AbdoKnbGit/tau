import { buildDelegationContextAppend, buildSessionContextAppend, chunkLiveContext, type LiveClientMessage, type LiveServerEvent } from './liveProtocol.js'

export type LiveVoicePhase = 'off' | 'connecting' | 'ready' | 'recording' | 'working' | 'speaking' | 'error'
export interface LiveVoiceSnapshot {
  phase: LiveVoicePhase
  inputLevel: number
  error: string | null
  transcript: string
  transcriptId: number
}
export interface LiveVoiceBridge {
  submit(request: string, requestId: string): void | Promise<void>
  getContext?(): string
}
export interface VoiceTransport {
  connect(): Promise<void>
  close(): Promise<void>
  setMuted(muted: boolean): void
  clearOutput(): void
  pushAudio(samples: Float32Array): void
  send(message: LiveClientMessage): Promise<void>
}
export interface VoiceSessionDependencies {
  createTransport(
    callbacks: { onEvent(event: LiveServerEvent): void; onOutputLevel(level: number): void },
    signal: AbortSignal,
    stage?: (label: string) => void,
  ): Promise<VoiceTransport> | VoiceTransport
  capture(onAudio: (error: Error | null, samples: Float32Array) => void): { stop(): void; drain?(): Promise<void> }
}

/** Every individual step is bounded, but their worst cases sum to minutes, so
 * startup also gets one overall deadline. Without it a single stalled step
 * leaves the prompt apparently frozen with no way to tell which one it was. */
export const STARTUP_TIMEOUT_MS = Number(process.env.TAU_VOICE_CONNECT_TIMEOUT_MS) || 30_000

/** A delegation is only completed by the REPL turn that claims it, matched by
 * exact request text. A turn that never matches -- rewritten text, a request
 * that routes elsewhere -- completes nothing, and the delegation stays pending
 * forever: the phase sticks on `working` and the voice model waits for a result
 * that cannot arrive. Idle time, not total time, bounds it, so a genuinely long
 * turn that keeps reporting progress is never cut short. */
export const DELEGATION_IDLE_TIMEOUT_MS = Number(process.env.TAU_VOICE_DELEGATION_TIMEOUT_MS) || 600_000

/** Owns microphone lifetime independently of terminal key handling and networking. */
export class LiveVoiceSession {
  private snapshot: LiveVoiceSnapshot = { phase: 'off', inputLevel: 0, error: null, transcript: '', transcriptId: 0 }
  private listeners = new Set<() => void>()
  private transport?: VoiceTransport
  private capture?: { stop(): void; drain?(): Promise<void> }
  private captureEpoch = 0
  private drainingEpoch = 0
  private controller?: AbortController
  private starting?: Promise<void>
  private closing: Promise<void> = Promise.resolve()
  private generation = 0
  private bridge: LiveVoiceBridge | null = null
  private pending: string[] = []
  private seen = new Set<string>()
  private outputTimer?: ReturnType<typeof setTimeout>
  private levelAt = 0
  private lastProgress = new Map<string, string>()
  private progressPending = new Map<string, string>()
  private progressTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private delegationTimers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(private readonly deps: VoiceSessionDependencies) {}
  getSnapshot = (): LiveVoiceSnapshot => this.snapshot
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  setBridge(bridge: LiveVoiceBridge | null): () => void {
    this.bridge = bridge
    return () => { if (this.bridge === bridge) this.bridge = null }
  }
  private update(patch: Partial<LiveVoiceSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch }
    for (const listener of this.listeners) listener()
  }
  private idlePhase(): LiveVoicePhase { return this.pending.length ? 'working' : 'ready' }

  start(): Promise<void> {
    if (this.starting) return this.starting
    if (this.transport && this.snapshot.phase !== 'error') return Promise.resolve()
    const generation = ++this.generation
    const controller = new AbortController()
    this.controller = controller
    this.update({ phase: 'connecting', error: null, inputLevel: 0, transcript: '' })
    // The label names the step still outstanding, so a timeout reports where it
    // stalled instead of only that it did.
    let stage = 'waiting for the previous call to close'
    const work = (async () => {
      await this.closing
      controller.signal.throwIfAborted()
      stage = 'opening audio and authorizing'
      const transport = await this.deps.createTransport({
        onEvent: event => { if (generation === this.generation) this.onEvent(event) },
        onOutputLevel: level => { if (generation === this.generation) this.onOutputLevel(level) },
      }, controller.signal, label => { stage = label })
      if (generation !== this.generation) { await transport.close(); throw new DOMException('Voice stopped', 'AbortError') }
      this.transport = transport
      await transport.connect()
      controller.signal.throwIfAborted()
      if (generation !== this.generation) return
      transport.setMuted(true)
      this.update({ phase: this.idlePhase() })
      const context = this.bridge?.getContext?.()?.trim()
      if (context) {
        for (const chunk of chunkLiveContext(context)) await transport.send(buildSessionContextAppend(chunk, 'commentary'))
      }
    })()
    // Aborting only unblocks steps that watch the signal; the native offer,
    // answer and open calls take none. So the deadline settles the caller's
    // promise itself rather than trusting the stalled step to notice, and the
    // prompt comes back even when the stall is inside the addon.
    const operation = new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => {
        const timeout = new DOMException(`Voice gave up after ${Math.round(STARTUP_TIMEOUT_MS / 1000)}s while ${stage}.`, 'TimeoutError')
        controller.abort(timeout)
        reject(timeout)
      }, STARTUP_TIMEOUT_MS)
      // Deliberately not unref'd: this timer is the only guarantee that start()
      // settles, so it must hold the event loop open until it fires or is
      // cleared. Unref'd, a process with nothing else pending exits with the
      // promise unresolved. It is cleared the moment the work settles, so it
      // never delays shutdown.
      const done = () => clearTimeout(deadline)
      work.then(value => { done(); resolve(value) }, error => { done(); reject(error) })
    }).catch(async error => {
      if (generation === this.generation) await this.fail(error)
      throw error
    }).finally(() => { if (this.starting === operation) this.starting = undefined })
    // The abandoned step may still reject later; keep that from going unhandled.
    work.catch(() => {})
    this.starting = operation
    return operation
  }

  async stop(): Promise<void> {
    ++this.generation
    this.controller?.abort(new DOMException('Voice stopped', 'AbortError'))
    this.controller = undefined
    this.starting = undefined
    this.releaseCapture()
    clearTimeout(this.outputTimer)
    this.pending = []
    this.seen.clear()
    this.lastProgress.clear()
    this.progressPending.clear()
    for (const timer of this.progressTimers.values()) clearTimeout(timer)
    this.progressTimers.clear()
    for (const timer of this.delegationTimers.values()) clearTimeout(timer)
    this.delegationTimers.clear()
    const transport = this.transport
    this.transport = undefined
    this.update({ phase: 'off', inputLevel: 0, error: null })
    this.closing = this.closing.then(async () => { await transport?.close() }).catch(() => {})
    await this.closing
  }

  async beginRecording(): Promise<void> {
    if (this.capture) return
    if (!this.transport || ['off', 'connecting', 'error'].includes(this.snapshot.phase)) return
    const generation = this.generation
    const transport = this.transport
    const captureEpoch = ++this.captureEpoch
    try {
      transport.clearOutput()
      transport.setMuted(false)
      // Opening the device is synchronous. REC is published only after success.
      const capture = this.deps.capture((error, samples) => {
        if (generation !== this.generation || captureEpoch !== this.captureEpoch || (!this.capture && this.drainingEpoch !== captureEpoch)) return
        if (error) { void this.fail(error); return }
        if (!samples.length) return // The native drain barrier carries no audio.
        try { transport.pushAudio(samples) } catch (failure) { void this.fail(failure); return }
        const now = Date.now()
        if (now - this.levelAt < 75) return
        this.levelAt = now
        let squares = 0
        for (const value of samples) squares += value * value
        if (this.capture) this.update({ inputLevel: Math.min(1, Math.sqrt(squares / Math.max(1, samples.length)) * 4) })
      })
      this.capture = capture
      clearTimeout(this.outputTimer)
      this.update({ phase: 'recording', error: null })
    } catch (error) {
      this.releaseCapture()
      this.update({ phase: this.idlePhase(), inputLevel: 0, error: `Microphone: ${error instanceof Error ? error.message : String(error)}` })
      throw error
    }
  }
  endRecording(): void {
    if (!this.capture) return
    this.releaseCapture(false)
    this.update({ phase: this.idlePhase(), inputLevel: 0 })
  }
  private releaseCapture(immediate = true): void {
    const capture = this.capture
    this.capture = undefined
    const epoch = this.captureEpoch
    const generation = this.generation
    this.drainingEpoch = !immediate && capture?.drain ? epoch : 0
    if (immediate) ++this.captureEpoch
    try { capture?.stop() } catch {}
    if (this.drainingEpoch) {
      // The microphone is already closed, so REC turns off immediately. Keep
      // admitting its queued JS callbacks until the native FIFO barrier resolves.
      void capture!.drain!().then(() => {
        if (generation !== this.generation || epoch !== this.captureEpoch) return
        this.drainingEpoch = 0
        this.transport?.setMuted(true)
      }).catch(error => {
        if (generation === this.generation && epoch === this.captureEpoch) void this.fail(error)
      })
      return
    }
    // Native transport drains the final queued frame before sending silence.
    try { this.transport?.setMuted(true) } catch {}
  }
  private async fail(error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error)
    const teardownGeneration = this.generation + 1
    await this.stop()
    // A newer /hey or explicit /bye owns the state after this teardown began.
    if (this.generation === teardownGeneration && this.snapshot.phase === 'off') {
      this.update({ phase: 'error', error: message })
    }
  }
  private onOutputLevel(level: number): void {
    if (this.capture || !Number.isFinite(level) || level < 0.01 || !this.transport) return
    if (this.snapshot.phase === 'connecting') return
    if (this.snapshot.phase !== 'speaking') this.update({ phase: 'speaking' })
    clearTimeout(this.outputTimer)
    this.outputTimer = setTimeout(() => {
      if (this.snapshot.phase === 'speaking') this.update({ phase: this.idlePhase() })
    }, 250)
    this.outputTimer.unref?.()
  }
  private onEvent(event: LiveServerEvent): void {
    if (event.type === 'error') { void this.fail(new Error(event.message)); return }
    if (event.type === 'turn.done' && event.turn.role === 'user') {
      this.update({ transcript: event.turn.transcript, transcriptId: this.snapshot.transcriptId + 1 })
    }
    if (event.type !== 'delegation.created' || this.seen.has(event.item.id)) return
    const request = event.item.content.map(item => item.text).join('\n').trim()
    if (!request || !event.item.id) return
    this.seen.add(event.item.id)
    if (this.seen.size > 4096) this.seen.delete(this.seen.values().next().value!)
    this.pending.push(event.item.id)
    this.armDelegationTimeout(event.item.id)
    if (!this.capture) this.update({ phase: 'working' })
    if (!this.bridge) {
      this.finish('Tau is not ready to accept this request. Ask again once the prompt is ready.', event.item.id)
      return
    }
    try {
      Promise.resolve(this.bridge.submit(request, event.item.id)).catch(error => {
        this.finish(`Tau could not submit the request: ${error instanceof Error ? error.message : String(error)}`, event.item.id)
      })
    } catch (error) {
      this.finish(`Tau could not submit the request: ${error instanceof Error ? error.message : String(error)}`, event.item.id)
    }
  }
  private armDelegationTimeout(requestId: string): void {
    clearTimeout(this.delegationTimers.get(requestId))
    const timer = setTimeout(() => {
      this.delegationTimers.delete(requestId)
      this.finish('Tau never reported a result for this request, so it was given up on. Tell the user to check the terminal and ask again.', requestId)
    }, DELEGATION_IDLE_TIMEOUT_MS)
    timer.unref?.()
    this.delegationTimers.set(requestId, timer)
  }
  progress(text: string, requestId = this.pending[0]): void {
    if (!requestId || !this.pending.includes(requestId) || !text.trim() || this.lastProgress.get(requestId) === text) return
    // Progress proves the turn is alive; the idle clock restarts.
    this.armDelegationTimeout(requestId)
    this.progressPending.set(requestId, text)
    if (this.progressTimers.has(requestId)) return
    const timer = setTimeout(() => {
      this.progressTimers.delete(requestId)
      const current = this.progressPending.get(requestId)
      this.progressPending.delete(requestId)
      if (!current || !this.pending.includes(requestId)) return
      const previous = this.lastProgress.get(requestId) ?? ''
      const delta = current.startsWith(previous) ? current.slice(previous.length) : current
      this.lastProgress.set(requestId, current)
      if (delta) this.append(requestId, delta, 'commentary')
    }, 200)
    timer.unref?.()
    this.progressTimers.set(requestId, timer)
  }
  finish(text: string, requestId = this.pending[0]): void {
    if (!requestId || !this.pending.includes(requestId)) return
    this.pending = this.pending.filter(id => id !== requestId)
    this.lastProgress.delete(requestId)
    clearTimeout(this.progressTimers.get(requestId))
    this.progressTimers.delete(requestId)
    this.progressPending.delete(requestId)
    clearTimeout(this.delegationTimers.get(requestId))
    this.delegationTimers.delete(requestId)
    this.append(requestId, `"Agent Final Message":\n\n${text.trim() || 'The agent turn ended without a text response.'}`)
    if (!this.capture && this.snapshot.phase === 'working') this.update({ phase: this.idlePhase() })
  }
  private append(id: string, text: string, channel?: 'commentary'): void {
    const transport = this.transport
    const generation = this.generation
    if (!transport) return
    // Transport serializes sends, including across progress/final calls.
    for (const chunk of chunkLiveContext(text)) {
      void transport.send(buildDelegationContextAppend(id, chunk, channel)).catch(error => {
        if (generation === this.generation) void this.fail(error)
      })
    }
  }
}
