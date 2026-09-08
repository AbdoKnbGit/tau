// Codex live wire protocol adapted from OMP (MIT); see native/tau-voice/LICENSE-OMP.
import { randomUUID } from 'node:crypto'
import { request } from 'node:https'
import WebSocket from 'ws'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { getProxyUrl, shouldBypassProxy } from '../utils/proxy.js'
import { buildLiveSessionPayload, parseLiveServerEvent, type LiveClientMessage, type LiveServerEvent } from './liveProtocol.js'
import type { VoiceTransport } from './liveSession.js'

export interface NativeVoicePeer {
  createOffer(): Promise<string>
  acceptAnswer(sdp: string): Promise<void>
  waitForOpen(timeoutMs?: number): Promise<void>
  close(): Promise<void>
  setMuted(muted: boolean): void
  clearOutput(): void
  pushAudio(samples: Float32Array): void
}
export interface NativeVoiceModule {
  AudioCapture: new (sampleRate: number, callback: (error: Error | null, samples: Float32Array) => void) => { stop(): void; drain(): Promise<void> }
  LiveWebRtcPeer: new (
    onEvent: (error: Error | null, payload: string) => void,
    onLevel: (error: Error | null, level: number) => void,
    onFailure: (error: Error | null, message: string) => void,
  ) => NativeVoicePeer
}
export interface LiveAccess { accessToken: string; accountId?: string }
export interface SignalResponse { status: number; body: string; location: string | null }
export interface LiveTransportOptions {
  native: NativeVoiceModule
  access(forceRefresh: boolean): Promise<LiveAccess>
  sessionId: string
  instructions: string
  voice: string
  signal: AbortSignal
  callbacks: { onEvent(event: LiveServerEvent): void; onOutputLevel(level: number): void }
  // Dependency injection keeps lifecycle/authorization tests offline.
  post?: typeof postLiveOffer
  socket?: (url: string, headers: Record<string, string>) => WebSocket
}

export const SIGNALING_URL = 'https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas'
export function parseLiveCallId(location: string | null): string | undefined {
  return location?.split('?')[0]?.split('/').find(part => /^rtc_[\w-]+$/.test(part))
}
export function liveSessionHeaders(access: LiveAccess, sessionId: string, realtimeId: string): Record<string, string> {
  return {
    Authorization: `Bearer ${access.accessToken}`,
    'OpenAI-Alpha': 'quicksilver=v2',
    'User-Agent': 'Codex Desktop/0.144.1',
    originator: 'Codex Desktop', version: '0.144.1',
    'x-session-id': realtimeId, 'session-id': sessionId, 'thread-id': sessionId,
    ...(access.accountId ? { 'chatgpt-account-id': access.accountId } : {}),
  }
}
function proxyAgent(url: string): HttpsProxyAgent<string> | undefined {
  const proxy = getProxyUrl()
  return proxy && !shouldBypassProxy(url.replace(/^wss:/, 'https:')) ? new HttpsProxyAgent(proxy) : undefined
}
export function postLiveOffer(body: string, headers: Record<string, string>, signal: AbortSignal): Promise<SignalResponse> {
  return new Promise((resolve, reject) => {
    const req = request(SIGNALING_URL, {
      method: 'POST', signal, agent: proxyAgent(SIGNALING_URL),
      headers: { ...headers, Accept: '*/*', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, response => {
      const chunks: Buffer[] = []
      let bytes = 0
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes > 1024 * 1024) { req.destroy(new Error('Voice signaling response exceeded 1 MiB')); return }
        chunks.push(chunk)
      })
      response.on('error', reject)
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), location: response.headers.location ?? null }))
    })
    req.setTimeout(30_000, () => req.destroy(new Error('Voice connection timed out')))
    req.on('error', reject)
    req.end(body)
  })
}

export class CodexLiveTransport implements VoiceTransport {
  private peer?: NativeVoicePeer
  private sideband?: WebSocket
  private closed = false
  private connected = false
  private muted = true
  private sendTail: Promise<void> = Promise.resolve()
  private closePromise?: Promise<void>
  private controller = new AbortController()
  private readonly abort = () => { void this.close() }
  constructor(private readonly options: LiveTransportOptions) {
    options.signal.addEventListener('abort', this.abort, { once: true })
    if (options.signal.aborted) this.controller.abort()
  }
  async connect(): Promise<void> {
    try {
      this.controller.signal.throwIfAborted()
      const peer = new this.options.native.LiveWebRtcPeer(
        (error, payload) => {
          if (error) this.failure(error.message)
          else this.event(payload, false)
        },
        (error, level) => {
          if (error) this.failure(error.message)
          else if (!this.closed) this.options.callbacks.onOutputLevel(level)
        },
        (error, message) => this.failure(error?.message ?? message),
      )
      this.peer = peer
      peer.setMuted(true)
      const offer = await peer.createOffer()
      this.controller.signal.throwIfAborted()
      const realtimeId = randomUUID()
      const body = JSON.stringify({ sdp: offer, session: buildLiveSessionPayload(this.options.instructions, this.options.voice) })
      let headers: Record<string, string> = {}
      let response: SignalResponse | undefined
      for (let attempt = 0; attempt < 2; attempt++) {
        const access = await this.options.access(attempt === 1)
        this.controller.signal.throwIfAborted()
        headers = liveSessionHeaders(access, this.options.sessionId, realtimeId)
        response = await (this.options.post ?? postLiveOffer)(body, headers, this.controller.signal)
        if (![401, 403].includes(response.status)) break
      }
      if (!response || response.status < 200 || response.status >= 300) {
        const status = response?.status ?? 0
        const detail = response?.body.replace(/\s+/g, ' ').slice(0, 600) || 'No response'
        throw new Error([401, 403].includes(status)
          ? `Codex voice access was refused (${status}). Sign in with ChatGPT OAuth in /login; your account must have access to Codex voice.`
          : `Codex voice connection failed (${status}): ${detail}`)
      }
      const callId = parseLiveCallId(response.location)
      if (!callId || !response.body.startsWith('v=')) throw new Error('Codex voice returned an invalid call or SDP answer')
      await peer.acceptAnswer(response.body)
      this.controller.signal.throwIfAborted()
      await peer.waitForOpen(20_000)
      this.controller.signal.throwIfAborted()
      for (let attempt = 0; ; attempt++) {
        try { await this.openSideband(callId, headers); break } catch (error) {
          this.controller.signal.throwIfAborted()
          if (attempt === 4) throw error
          await new Promise<void>((resolve, reject) => {
            const signal = this.controller.signal
            const abort = () => { clearTimeout(timer); reject(signal.reason) }
            const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, 200 * 2 ** attempt)
            signal.addEventListener('abort', abort, { once: true })
          })
        }
      }
      this.controller.signal.throwIfAborted()
      this.connected = true
    } catch (error) { await this.close(); throw error }
  }
  private openSideband(callId: string, headers: Record<string, string>): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = `wss://api.openai.com/v1/live/${encodeURIComponent(callId)}`
      const socket = this.options.socket?.(url, headers) ?? new WebSocket(url, { headers, agent: proxyAgent(url), handshakeTimeout: 15_000, maxPayload: 4 * 1024 * 1024 })
      this.sideband = socket
      let opened = false
      let settled = false
      const signal = this.controller.signal
      const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort) }
      const fail = (error: Error) => {
        if (settled) return
        settled = true
        cleanup()
        if (this.sideband === socket) this.sideband = undefined
        socket.terminate()
        reject(error)
      }
      const abort = () => fail(new DOMException('Voice stopped', 'AbortError'))
      const timer = setTimeout(() => fail(new Error('Codex voice sideband timed out')), 15_000)
      signal.addEventListener('abort', abort, { once: true })
      socket.on('open', () => {
        if (settled) return
        opened = true
        settled = true
        cleanup()
        resolve()
      })
      socket.on('message', (data, binary) => { if (!binary && this.sideband === socket) this.event(data.toString(), true) })
      socket.on('error', error => {
        if (!opened) fail(error)
        else if (this.sideband === socket) this.failure(`Codex voice connection: ${error.message}`)
      })
      socket.on('close', code => {
        if (!opened) fail(new Error(`Codex voice sideband closed (${code})`))
        else if (this.sideband === socket) this.failure(`Codex voice disconnected (${code}). Run /hey to reconnect.`)
      })
      if (signal.aborted) abort()
    })
  }
  private event(payload: string, sideband: boolean): void {
    if (this.closed) return
    const event = parseLiveServerEvent(payload)
    if (!event || (!sideband && this.sideband?.readyState === WebSocket.OPEN && event.type !== 'error')) return
    this.options.callbacks.onEvent(event)
  }
  private failure(message: string): void {
    if (!this.closed) this.options.callbacks.onEvent({ type: 'error', message })
  }
  setMuted(muted: boolean): void { this.muted = muted; this.peer?.setMuted(muted) }
  clearOutput(): void { this.peer?.clearOutput() }
  pushAudio(samples: Float32Array): void { if (this.connected && !this.muted && samples.length) this.peer?.pushAudio(samples) }
  send(message: LiveClientMessage): Promise<void> {
    const operation = this.sendTail.then(() => new Promise<void>((resolve, reject) => {
      const socket = this.sideband
      if (!this.connected || this.closed || socket?.readyState !== WebSocket.OPEN) { reject(new Error('Codex voice is disconnected')); return }
      socket.send(JSON.stringify(message), error => error ? reject(error) : resolve())
    }))
    this.sendTail = operation.catch(() => {})
    return operation
  }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.closed = true
    this.connected = false
    this.options.signal.removeEventListener('abort', this.abort)
    this.controller.abort(new DOMException('Voice stopped', 'AbortError'))
    const socket = this.sideband
    this.sideband = undefined
    // terminate also cancels an in-flight handshake; no orphan sockets on /bye.
    socket?.terminate()
    const peer = this.peer
    this.peer = undefined
    this.closePromise = peer?.close().catch(() => {}) ?? Promise.resolve()
    return this.closePromise
  }
}
