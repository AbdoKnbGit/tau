import { type ChildProcess, spawn } from 'node:child_process'
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
} from '@agentclientprotocol/sdk'

/** A model/thinking selector mirrored from the agent's ACP config options. */
export type ConfigOption = {
  id: string
  name: string
  category?: string
  currentValue: string
  options: { value: string; name: string; description?: string }[]
}

export type ToolCallEvent = {
  id: string
  title: string
  kind: string
  status: string
}

/** Callbacks the host wires to drive the webview. */
export interface AcpHandlers {
  onSessionReady(info: { configOptions: ConfigOption[] }): void
  onCommands(commands: { name: string; description: string; hint?: string }[]): void
  onText(text: string): void
  onThought(text: string): void
  onToolCall(call: ToolCallEvent): void
  onToolUpdate(update: { id: string; status: string; content?: string }): void
  onUsage(usage: { cachePct: number; cost?: string }): void
  onTurnEnd(stopReason: string): void
  onError(message: string): void
  onExit(code: number | null): void
}

export type AcpClientOptions = {
  command: string
  args: string[]
  cwd: string
  env?: NodeJS.ProcessEnv
}

/** A pure-usage "thought" we emit ourselves, e.g. "⚡ 92% cached · $0.15". */
const USAGE_THOUGHT = /^\s*⚡\s*(\d+)%\s*cached(?:\s*·\s*\$([\d.]+))?/

/**
 * Spawns `tau acp` and speaks the Agent Client Protocol over stdio, translating
 * ACP session updates into {@link AcpHandlers} callbacks the webview consumes.
 * This is a thin, UI-agnostic client; all rendering lives in the webview.
 */
export class AcpClient {
  private child?: ChildProcess
  private agent?: ClientSideConnection
  private sessionId?: string
  private turn?: AbortController
  private disposed = false

  constructor(
    private readonly opts: AcpClientOptions,
    private readonly handlers: AcpHandlers,
  ) {}

  /** Spawn the agent and complete the ACP initialize handshake. */
  async start(): Promise<void> {
    // tau is a `.cmd` shim on Windows, so a shell is needed to resolve it on
    // PATH. Under a shell, Node does NOT auto-quote, so a command or arg with a
    // space (e.g. "C:\Program Files\nodejs\node.exe") must be quoted ourselves.
    const isWin = process.platform === 'win32'
    const q = (s: string) => (isWin && /\s/.test(s) ? `"${s}"` : s)
    const command = isWin ? q(this.opts.command) : this.opts.command
    const args = isWin ? this.opts.args.map(q) : this.opts.args

    const child = spawn(command, args, {
      cwd: this.opts.cwd,
      env: this.opts.env ?? process.env,
      shell: isWin,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child = child

    child.on('error', err =>
      this.handlers.onError(`Failed to start "${this.opts.command}": ${err.message}`),
    )
    child.on('exit', code => {
      if (!this.disposed) this.handlers.onExit(code)
    })
    // Surface the agent's stderr as errors (kept off the protocol channel).
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      const text = chunk.trim()
      if (text) console.error('[tau acp]', text)
    })

    const toAgent = new WritableStream<Uint8Array>({
      write(chunk) {
        return new Promise<void>((res, rej) =>
          child.stdin!.write(chunk, err => (err ? rej(err) : res())),
        )
      },
    })
    const fromAgent = new ReadableStream<Uint8Array>({
      start(controller) {
        child.stdout!.on('data', (d: Buffer) =>
          controller.enqueue(new Uint8Array(d)),
        )
        child.stdout!.on('end', () => {
          try {
            controller.close()
          } catch {
            /* already closed */
          }
        })
        child.stdout!.on('error', err => controller.error(err))
      },
    })

    const stream = ndJsonStream(toAgent, fromAgent)
    this.agent = new ClientSideConnection(() => this.makeClient(), stream)

    await this.agent.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    })
  }

  /** Open a fresh session; emits config options + commands when ready. */
  async newSession(): Promise<void> {
    if (!this.agent) throw new Error('Agent not started')
    const res = await this.agent.newSession({
      cwd: this.opts.cwd,
      mcpServers: [],
    })
    this.sessionId = res.sessionId
    const configOptions = (res.configOptions ?? []).map(toConfigOption)
    this.handlers.onSessionReady({ configOptions })
  }

  /** Send a user turn; resolves (via onTurnEnd) when the agent stops. */
  async prompt(text: string): Promise<void> {
    if (!this.agent || !this.sessionId) {
      this.handlers.onError('No active session.')
      return
    }
    this.turn = new AbortController()
    try {
      const res = await this.agent.prompt({
        sessionId: this.sessionId,
        prompt: [{ type: 'text', text }],
      })
      this.handlers.onTurnEnd(res.stopReason)
    } catch (err) {
      if (!this.turn?.signal.aborted) {
        this.handlers.onError(err instanceof Error ? err.message : String(err))
      }
      this.handlers.onTurnEnd('cancelled')
    }
  }

  /** Cancel the in-flight turn. */
  async cancel(): Promise<void> {
    if (!this.agent || !this.sessionId) return
    this.turn?.abort()
    try {
      await this.agent.cancel({ sessionId: this.sessionId })
    } catch {
      /* connection may be gone */
    }
  }

  /** Apply a model/thinking selection from the webview dropdowns. */
  async setConfig(configId: string, value: string): Promise<void> {
    if (!this.agent || !this.sessionId) return
    try {
      const res = await this.agent.setSessionConfigOption({
        sessionId: this.sessionId,
        configId,
        value,
      })
      const configOptions = (res.configOptions ?? []).map(toConfigOption)
      this.handlers.onSessionReady({ configOptions })
    } catch (err) {
      this.handlers.onError(err instanceof Error ? err.message : String(err))
    }
  }

  dispose(): void {
    this.disposed = true
    try {
      this.child?.kill()
    } catch {
      /* already gone */
    }
    this.child = undefined
    this.agent = undefined
    this.sessionId = undefined
  }

  /** The ACP Client implementation handed to the connection. */
  private makeClient() {
    const h = this.handlers
    return {
      async sessionUpdate(params: { update: Record<string, any> }) {
        const u = params.update
        switch (u.sessionUpdate) {
          case 'agent_message_chunk':
            h.onText(u.content?.text ?? '')
            break
          case 'agent_thought_chunk': {
            const text: string = u.content?.text ?? ''
            const m = USAGE_THOUGHT.exec(text)
            if (m) {
              h.onUsage({
                cachePct: Number(m[1]),
                cost: m[2] ? `$${m[2]}` : undefined,
              })
            } else {
              h.onThought(text)
            }
            break
          }
          case 'tool_call':
            h.onToolCall({
              id: u.toolCallId,
              title: u.title ?? 'tool',
              kind: u.kind ?? 'other',
              status: u.status ?? 'pending',
            })
            break
          case 'tool_call_update':
            h.onToolUpdate({
              id: u.toolCallId,
              status: u.status ?? 'in_progress',
              content: extractToolContent(u.content),
            })
            break
          case 'available_commands_update':
            h.onCommands(
              (u.availableCommands ?? []).map((c: any) => ({
                name: c.name,
                description: c.description ?? '',
                hint: c.input?.hint,
              })),
            )
            break
          case 'config_option_update':
            h.onSessionReady({
              configOptions: (u.configOptions ?? []).map(toConfigOption),
            })
            break
        }
      },
      async requestPermission() {
        // tau runs with skip-permissions, so this rarely fires; auto-allow.
        return { outcome: { outcome: 'selected', optionId: 'allow_once' } }
      },
    }
  }
}

function toConfigOption(o: any): ConfigOption {
  return {
    id: o.id,
    name: o.name,
    category: o.category ?? undefined,
    currentValue: o.currentValue,
    options: (o.options ?? []).map((v: any) => ({
      value: v.value,
      name: v.name,
      description: v.description ?? undefined,
    })),
  }
}

function extractToolContent(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const block of content as any[]) {
    if (block?.type === 'content' && block.content?.type === 'text') {
      parts.push(block.content.text)
    }
  }
  return parts.length ? parts.join('\n') : undefined
}
