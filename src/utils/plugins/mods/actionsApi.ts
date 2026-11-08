import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { execa } from 'execa'
import { getOriginalCwd } from '../../../bootstrap/state.js'
import { killModProcessTree } from './host.js'
import type { ModRecord } from './runtime.js'

const MAX_BYTES = 4 * 1024 * 1024
const isRecord = (value: unknown): value is ModRecord =>
  !!value && typeof value === 'object' && !Array.isArray(value)

type Spawned = {
  owner: object
  chunks: Array<{ stream: 'stdout' | 'stderr'; text: string }>
  buffered: { stdout: number; stderr: number }
  truncated: { stdout: boolean; stderr: boolean }
  result?: ModRecord
  error?: string
  wake?: () => void
  stop(): Promise<void>
}
const spawned = new Map<string, Spawned>()

/**
 * `$.process.spawn`: starts a long-running command by its argument vector (no
 * shell) and streams its output to the mod, which reads it chunk by chunk.
 * Output the mod has not read yet is held up to 4 MiB a stream; more is
 * dropped and reported as truncated. The command stops with the mod.
 */
export function startModSpawn(argv: unknown, init: unknown, owner: object, lifetime: AbortSignal): ModRecord {
  if (!Array.isArray(argv) || !argv.length || argv.some(arg => typeof arg !== 'string' || arg.includes('\0')))
    throw new Error('process.spawn requires a nonempty string argv array')
  const options = init === undefined ? {} : init
  if (!isRecord(options)) throw new Error('process.spawn init must be an object')
  if (options.env !== undefined && (!isRecord(options.env) || Object.values(options.env).some(value => typeof value !== 'string')))
    throw new Error('process.spawn env values must be strings')
  if (options.stdin !== undefined && typeof options.stdin !== 'string') throw new Error('process.spawn stdin must be text')
  if (options.cwd !== undefined && typeof options.cwd !== 'string') throw new Error('process.spawn cwd must be a path')
  const timeout = options.timeoutMs
  if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0 || timeout > 24 * 60 * 60 * 1000))
    throw new Error('process.spawn timeoutMs must be a positive number of milliseconds')
  lifetime.throwIfAborted()
  const child = execa(argv[0] as string, argv.slice(1) as string[], {
    cwd: resolve(getOriginalCwd(), options.cwd ?? '.'),
    env: { ...process.env, ...(options.env as Record<string, string> | undefined) },
    detached: process.platform !== 'win32',
    windowsHide: true,
    buffer: false,
    encoding: 'utf8',
    input: options.stdin ?? '',
    stripFinalNewline: false,
    reject: false,
  })
  const id = 'spawn_' + randomUUID()
  let stopping: Promise<void> | undefined
  const entry: Spawned = {
    owner,
    chunks: [],
    buffered: { stdout: 0, stderr: 0 },
    truncated: { stdout: false, stderr: false },
    stop: () => (stopping ??= killModProcessTree(child)),
  }
  spawned.set(id, entry)
  const wake = () => { const done = entry.wake; entry.wake = undefined; done?.() }
  const collect = (stream: 'stdout' | 'stderr') => (data: Buffer | string) => {
    const text = typeof data === 'string' ? data : data.toString('utf8')
    const size = Buffer.byteLength(text)
    if (entry.buffered[stream] + size > MAX_BYTES) {
      entry.truncated[stream] = true
      return
    }
    entry.buffered[stream] += size
    entry.chunks.push({ stream, text })
    wake()
  }
  child.stdout?.on('data', collect('stdout'))
  child.stderr?.on('data', collect('stderr'))
  const stop = () => void entry.stop()
  lifetime.addEventListener('abort', stop, { once: true })
  const timer = timeout === undefined ? undefined : setTimeout(stop, timeout)
  timer?.unref()
  child.then(result => {
    entry.result = {
      // A child ended by a signal reads as exit code 1, as Claude Code reports it.
      exitCode: typeof result.exitCode === 'number' ? result.exitCode : 1,
      ...(entry.truncated.stdout ? { isStdoutTruncated: true } : {}),
      ...(entry.truncated.stderr ? { isStderrTruncated: true } : {}),
    }
    if (result.exitCode === undefined && result.failed && !result.isTerminated && !result.signal)
      entry.error = result.shortMessage ?? 'the command could not start'
  }, (error: unknown) => {
    entry.error = error instanceof Error ? error.message : String(error)
  }).finally(() => {
    clearTimeout(timer)
    lifetime.removeEventListener('abort', stop)
    // Nobody reads a command whose mod unloaded or whose hook was abandoned.
    if (lifetime.aborted) spawned.delete(id)
    wake()
  })
  return { id }
}

/** The next output of a spawned command, waiting until there is some or it
 * ended; `done` carries its exit, and the entry is released then. */
export async function readModSpawn(input: unknown, owner: object, signal: AbortSignal): Promise<ModRecord> {
  const id = isRecord(input) ? input.id : undefined
  const entry = typeof id === 'string' ? spawned.get(id) : undefined
  if (!entry || entry.owner !== owner) throw new Error('process.spawn: no such running command')
  while (!entry.chunks.length && !entry.result && !entry.error) {
    await new Promise<void>((done, reject) => {
      const abort = () => reject(signal.reason ?? new Error('Mod event aborted'))
      entry.wake = () => { signal.removeEventListener('abort', abort); done() }
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })
  }
  const chunks = entry.chunks.splice(0)
  entry.buffered.stdout = entry.buffered.stderr = 0
  if (chunks.length) return { chunks, done: false }
  spawned.delete(id as string)
  if (entry.error) return { chunks: [], done: true, error: entry.error }
  return { chunks: [], done: true, result: entry.result }
}

export async function stopModSpawn(input: unknown, owner: object): Promise<void> {
  const id = isRecord(input) ? input.id : undefined
  const entry = typeof id === 'string' ? spawned.get(id) : undefined
  if (entry && entry.owner === owner) await entry.stop()
}

// Agent types a mod registered, by full name `<plugin>:<name>`.
const modAgents = new Map<string, { owner: object; definition: ModRecord }>()
const AGENT_NAME = /^[A-Za-z0-9_-]{1,64}$/

/** `$.agent.register`: an agent type the Agent tool offers from the next
 * request on. Like a plugin's agent file, it cannot carry hooks, MCP servers
 * or a permission mode of its own. */
export function registerModAgent(spec: unknown, plugin: { name: string; root: string }, owner: object): ModRecord {
  if (!isRecord(spec) || typeof spec.name !== 'string' || !AGENT_NAME.test(spec.name))
    throw new Error('agent.register name is 1-64 letters, digits, _ or -')
  if (typeof spec.description !== 'string' || !spec.description.trim())
    throw new Error('agent.register needs a description of when to delegate')
  if (typeof spec.prompt !== 'string' || !spec.prompt.trim())
    throw new Error('agent.register needs a prompt (the agent\'s system prompt)')
  const list = (key: string) => {
    const value = spec[key]
    if (value === undefined) return undefined
    if (!Array.isArray(value) || value.some(item => typeof item !== 'string'))
      throw new Error(`agent.register ${key} must be a list of names`)
    return value as string[]
  }
  for (const key of ['permissionMode', 'hooks', 'mcpServers'])
    if (spec[key] !== undefined) throw new Error(`agent.register cannot set ${key} for a plugin's agent`)
  const tools = list('tools'), disallowedTools = list('disallowedTools'), skills = list('skills')
  if (spec.model !== undefined && typeof spec.model !== 'string') throw new Error('agent.register model must be a string')
  if (spec.maxTurns !== undefined && (!Number.isInteger(spec.maxTurns) || spec.maxTurns < 1))
    throw new Error('agent.register maxTurns must be a positive whole number')
  if (spec.background !== undefined && typeof spec.background !== 'boolean')
    throw new Error('agent.register background must be a boolean')
  if (spec.effort !== undefined && typeof spec.effort !== 'string' && !Number.isInteger(spec.effort))
    throw new Error('agent.register effort must be a level name or a whole number')
  const agentType = `${plugin.name}:${spec.name}`
  const prompt = spec.prompt
  const definition: ModRecord = {
    agentType,
    whenToUse: spec.description,
    ...(tools ? { tools } : {}),
    ...(disallowedTools ? { disallowedTools } : {}),
    ...(skills ? { skills } : {}),
    ...(spec.model !== undefined ? { model: spec.model } : {}),
    ...(spec.effort !== undefined ? { effort: spec.effort } : {}),
    ...(spec.maxTurns !== undefined ? { maxTurns: spec.maxTurns } : {}),
    ...(spec.background === true ? { background: true } : {}),
    ...(spec.omitClaudeMd === true ? { omitClaudeMd: true } : {}),
    getSystemPrompt: () => prompt,
    source: 'plugin',
    baseDir: plugin.root,
    filename: spec.name,
    plugin: plugin.name,
  }
  modAgents.set(agentType, { owner, definition })
  return { agent: agentType }
}

/** Drops the agent types of a mod that unloaded. */
export function forgetModAgents(owner: object): void {
  for (const [name, entry] of modAgents) if (entry.owner === owner) modAgents.delete(name)
}

/** The session's agent types plus those the loaded mods registered; a type
 * the session already defines keeps its own definition. */
export function withModAgents<T extends { agentType: string }>(agents: readonly T[]): T[] {
  if (!modAgents.size) return agents as T[]
  const known = new Set(agents.map(agent => agent.agentType))
  return [...agents, ...[...modAgents.values()].map(entry => entry.definition as unknown as T)
    .filter(agent => !known.has(agent.agentType))]
}

/** `$.agent.list`: the session's subagents and teammates, the model's and
 * plugins' alike. */
export function listModAgents(appState: ModRecord | undefined): ModRecord[] {
  const tasks = (appState?.tasks ?? {}) as Record<string, ModRecord>
  return Object.values(tasks).flatMap(task => {
    if (task.type === 'local_agent' && task.agentType !== 'main-session')
      return [{
        id: task.agentId ?? task.id,
        description: task.description ?? '',
        type: task.agentType ?? 'general-purpose',
        status: task.status,
        ...(task.name ? { name: task.name } : {}),
      }]
    if (task.type === 'in_process_teammate')
      return [{
        id: task.agentId ?? task.id,
        description: task.description ?? '',
        type: task.agentType ?? 'teammate',
        status: task.status,
        ...(task.name ?? task.teammateName ? { name: task.name ?? task.teammateName } : {}),
      }]
    return []
  })
}
