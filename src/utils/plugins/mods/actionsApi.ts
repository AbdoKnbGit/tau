import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { execa } from 'execa'
import { getOriginalCwd } from '../../../bootstrap/state.js'
import { AGENT_AUTO_COMPACT_WINDOW_MIN } from '../../../tools/AgentTool/agentFrontmatterFields.js'
import { killModProcessTree, modProcessCommand } from './host.js'
import type { ModChunkSink, ModRecord, ModStreamPressure } from './runtime.js'

/** How much of a spawned child's output may wait unread, in characters: past
 * it the child blocks on its next write until a reader pulls, so nothing is
 * dropped (Claude Code's ProcessSpawnChunk). */
export const MOD_SPAWN_UNREAD_LIMIT = 1_048_576

const isRecord = (value: unknown): value is ModRecord =>
  !!value && typeof value === 'object' && !Array.isArray(value)

/** One spawn's unread output, wherever it waits: in the streams of the hooks
 * above the caller and in the caller's own queue. */
class SpawnPressure implements ModStreamPressure {
  private unread = 0
  private readonly listeners = new Set<() => void>()
  private static size(chunk: unknown): number {
    const text = isRecord(chunk) ? chunk.text : undefined
    return typeof text === 'string' ? text.length : 0
  }
  get full(): boolean {
    return this.unread >= MOD_SPAWN_UNREAD_LIMIT
  }
  add(chunk: unknown): void {
    this.unread += SpawnPressure.size(chunk)
  }
  release(chunks: readonly unknown[]): void {
    if (!chunks.length) return
    for (const chunk of chunks) this.unread -= SpawnPressure.size(chunk)
    if (this.unread < 0) this.unread = 0
    for (const listener of [...this.listeners]) listener()
  }
  /** Calls `listener` each time a reader took some. */
  watch(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
}

type Spawned = {
  owner: object
  chunks: unknown[]
  pressure: SpawnPressure
  stop: AbortController
  settled: Promise<void>
  done: boolean
  result?: unknown
  error?: string
  wake?: () => void
}
const spawned = new Map<string, Spawned>()

/** The request a spawn runs, checked once the hooks above passed it on. */
function spawnRequest(request: unknown): { argv: string[]; cwd?: string; env?: Record<string, string>; input?: string } {
  if (!isRecord(request)) throw new Error('process.spawn takes a request { argv, cwd, env, input }')
  const { argv, cwd, env, input } = request
  if (!Array.isArray(argv) || !argv.length || argv.some(arg => typeof arg !== 'string' || arg.includes('\0')))
    throw new Error('process.spawn requires a nonempty string argv array')
  if (cwd !== undefined && typeof cwd !== 'string') throw new Error('process.spawn cwd must be a path')
  if (env !== undefined && (!isRecord(env) || Object.values(env).some(value => typeof value !== 'string')))
    throw new Error('process.spawn env values must be strings')
  if (input !== undefined && typeof input !== 'string') throw new Error('process.spawn input must be text')
  return { argv, cwd, env, input }
}

/** Whether a spawn's children started, and ran to their end. */
type SpawnRun = { started: boolean; ended: boolean }

/**
 * The engine at the bottom of a spawn's chain: starts the command by its
 * argument vector (no shell, git with repository hooks off) and streams what
 * it writes as `{ stream, text }` pieces, decoded as they arrive, never empty
 * and never splitting a character. While the spawn's unread output is at the
 * limit the child waits on its next write. Resolves `{ value: { code, signal }
 * }` once the child exited and every piece was handed on; `signal` stops it.
 */
async function runSpawnedChild(
  request: ModRecord,
  out: ModChunkSink,
  signal: AbortSignal,
  pressure: SpawnPressure,
  run: SpawnRun,
): Promise<ModRecord> {
  const { argv, cwd, env, input } = spawnRequest(request)
  signal.throwIfAborted()
  const command = modProcessCommand(argv, { ...process.env, ...env })
  const child = execa(command.argv[0]!, command.argv.slice(1), {
    cwd: resolve(getOriginalCwd(), cwd ?? '.'),
    env: command.env,
    // A POSIX process group and Windows taskkill /T stop what it started too.
    detached: process.platform !== 'win32',
    windowsHide: true,
    buffer: false,
    // Absent, standard input is closed from the start.
    input: input ?? '',
    stripFinalNewline: false,
    reject: false,
  })
  run.started = true
  const pipes = [child.stdout, child.stderr].filter((pipe): pipe is NonNullable<typeof pipe> => !!pipe)
  const unwatch = pressure.watch(() => {
    for (const pipe of pipes) if (pressure.full) pipe.pause(); else pipe.resume()
  })
  let stopping: Promise<void> | undefined
  const stop = () => {
    stopping ??= killModProcessTree(child)
    // A paused pipe would never end: let go of what it holds.
    for (const pipe of pipes) pipe.destroy()
  }
  signal.addEventListener('abort', stop, { once: true })
  if (signal.aborted) stop()
  const drain = (pipe: NodeJS.ReadableStream | null | undefined, stream: 'stdout' | 'stderr') => new Promise<void>(done => {
    if (!pipe) return done()
    const decoder = new StringDecoder('utf8')
    const emit = (text: string) => {
      if (!text) return
      out({ stream, text })
      if (pressure.full) for (const each of pipes) each.pause()
    }
    pipe.on('data', (data: Buffer | string) => emit(typeof data === 'string' ? data : decoder.write(data)))
    pipe.once('end', () => { emit(decoder.end()); done() })
    pipe.once('close', () => done())
  })
  try {
    const [result] = await Promise.all([child, drain(child.stdout, 'stdout'), drain(child.stderr, 'stderr')])
    await stopping
    if (typeof result.exitCode !== 'number' && !result.signal)
      throw new Error(result.shortMessage ?? 'the command could not start')
    // Ran to its end: exited by itself, every piece handed on, nobody stopped it.
    if (!signal.aborted) run.ended = true
    // On Windows a killed child reads as an exit code, its signal null.
    if (process.platform === 'win32' && result.signal)
      return { value: { code: typeof result.exitCode === 'number' ? result.exitCode : 1, signal: null } }
    return { value: { code: typeof result.exitCode === 'number' ? result.exitCode : null, signal: result.signal ?? null } }
  } finally {
    signal.removeEventListener('abort', stop)
    unwatch()
  }
}

/** A spawn's chain: the hooks above the caller, the engine's child beneath. */
export type ModSpawnDispatch = (
  core: (event: ModRecord, out: ModChunkSink, signal: AbortSignal | undefined) => Promise<unknown>,
  sink: ModChunkSink,
  signal: AbortSignal,
  pressure: ModStreamPressure,
) => Promise<unknown>

/**
 * `$.process.spawn(request)`: the request streams through the hooks above
 * the caller (each may read, rewrite or refuse what the child writes), the
 * engine's child at the bottom; the caller pulls what reaches it with
 * `readModSpawn`. The child lives as long as the caller's loop: leaving it
 * (`stopModSpawn`), the caller's event being abandoned or its mod unloading
 * (`lifetime`) stops it; the caller's hook returning does not.
 */
export function startModSpawn(owner: object, caller: string, lifetime: AbortSignal, dispatch: ModSpawnDispatch): ModRecord {
  lifetime.throwIfAborted()
  const id = 'spawn_' + randomUUID()
  const stop = new AbortController()
  const pressure = new SpawnPressure()
  const run: SpawnRun = { started: false, ended: false }
  const signal = AbortSignal.any([lifetime, stop.signal])
  const entry = { owner, chunks: [], pressure, stop, done: false } as unknown as Spawned
  spawned.set(id, entry)
  const wake = () => { const done = entry.wake; entry.wake = undefined; done?.() }
  entry.settled = dispatch(
    (event, out, below) => runSpawnedChild(event, out, below ?? signal, pressure, run),
    chunk => { entry.chunks.push(chunk); pressure.add(chunk); wake() },
    signal,
    pressure,
  ).then(answer => {
    const settled = isRecord(answer) ? answer : {}
    if (typeof settled.deny === 'string') {
      // A refusal after the command started undoes nothing it did; a command
      // still running stops.
      entry.error = `${caller}: $.process.spawn${run.started ? ` ${run.ended ? 'ran' : 'started'}, and a plugin withheld its result` : ''}: ${settled.deny}`
      stop.abort(new Error('a plugin withheld the result'))
    } else entry.result = settled.value
  }, (error: unknown) => {
    entry.error = error instanceof Error ? error.message : String(error)
  }).finally(() => {
    entry.done = true
    // Nobody reads a spawn whose mod unloaded or whose event was abandoned.
    if (lifetime.aborted) {
      spawned.delete(id)
      pressure.release(entry.chunks.splice(0))
    }
    wake()
  })
  return { id }
}

/** The next pieces of a spawn that reached its caller, waiting until there
 * are some or it ended; `done` carries how it ended, and the entry goes. */
export async function readModSpawn(input: unknown, owner: object, signal: AbortSignal): Promise<ModRecord> {
  const id = isRecord(input) ? input.id : undefined
  const entry = typeof id === 'string' ? spawned.get(id) : undefined
  if (!entry || entry.owner !== owner) throw new Error('process.spawn: no such running command')
  while (!entry.chunks.length && !entry.done) {
    await new Promise<void>((done, reject) => {
      const abort = () => reject(signal.reason ?? new Error('Mod event aborted'))
      entry.wake = () => { signal.removeEventListener('abort', abort); done() }
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })
  }
  const chunks = entry.chunks.splice(0)
  entry.pressure.release(chunks)
  if (chunks.length) return { chunks, done: false }
  spawned.delete(id as string)
  if (entry.error !== undefined) return { chunks: [], done: true, error: entry.error }
  return { chunks: [], done: true, result: entry.result }
}

/** The caller left its loop: the chain stops, the child with it, and nobody
 * reads the spawn again. Resolves once the child is gone. */
export async function stopModSpawn(input: unknown, owner: object): Promise<void> {
  const id = isRecord(input) ? input.id : undefined
  const entry = typeof id === 'string' ? spawned.get(id) : undefined
  if (!entry || entry.owner !== owner) return
  entry.stop.abort(new Error('the stream was closed'))
  await entry.settled
  spawned.delete(id as string)
  entry.pressure.release(entry.chunks.splice(0))
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
  if (spec.autoCompactWindow !== undefined && (!Number.isSafeInteger(spec.autoCompactWindow) ||
    (spec.autoCompactWindow as number) < AGENT_AUTO_COMPACT_WINDOW_MIN))
    throw new Error(`agent.register autoCompactWindow must be a whole number of at least ${AGENT_AUTO_COMPACT_WINDOW_MIN}`)
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
    ...(spec.autoCompactWindow !== undefined ? { autoCompactWindow: spec.autoCompactWindow } : {}),
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
