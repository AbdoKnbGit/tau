import { execa } from 'execa'
import { createHash, randomUUID } from 'crypto'
import {
  mkdir,
  open,
  readFile,
  writeFile,
  readdir,
  stat,
  lstat,
  realpath,
  rename,
  unlink,
} from 'fs/promises'
import { resolve, join } from 'path'
import {
  getOriginalCwd,
  getProjectRoot,
  getSessionId,
  getIsInteractive,
} from '../../../bootstrap/state.js'
import {
  getSettings_DEPRECATED,
  getSettingsForSource,
} from '../../settings/settings.js'
import { getPluginDataDir } from '../pluginDirectories.js'
import { logForDebugging } from '../../debug.js'
import * as lockfile from '../../lockfile.js'
import { resolveWindowsTaskkillPath } from '../../execFileNoThrow.js'
import type { ModHost, ModRecord } from './runtime.js'
import type { ModToolRegistry, ModToolInfo } from './tools.js'

export type ModCommandSpec = {
  name: string
  description: string
  argumentHint?: string
  immediate?: boolean
}
export type ModHostContext = {
  id: string
  name: string
  commands: Map<string, ModCommandSpec>
  reserved: Set<string>
  commandsChanged(): Promise<void>
  tools?: ModToolRegistry
  listTools?(): Promise<ModToolInfo[]>
  log(text: string): void
}

const MAX_BYTES = 4 * 1024 * 1024
const storeQueues = new Map<string, Promise<unknown>>()

async function useStore<T>(
  id: string,
  operation: (values: Map<string, unknown>) => T,
  write: boolean,
  signal: AbortSignal,
): Promise<T> {
  const directory = getPluginDataDir(id)
  const previous = storeQueues.get(directory) ?? Promise.resolve()
  const pending = previous
    .catch(() => {})
    .then(async () => {
      signal.throwIfAborted()
      let compromised: Error | undefined
      const release = await lockfile.lock(directory, {
        retries: { retries: 50, factor: 1, minTimeout: 20, maxTimeout: 50 },
        stale: 30_000,
        update: 10_000,
        onCompromised: (error: Error) => {
          compromised = error
        },
      })
      const check = () => {
        signal.throwIfAborted()
        if (compromised) throw compromised
      }
      try {
        check()
        // Retain the original filename for its first owner, including stores
        // written before ownership metadata existed. Other exact identities
        // sharing the legacy sanitized directory get distinct filenames.
        const ownerPath = join(directory, 'mod-store-owner.json')
        let owner = await readFile(ownerPath, 'utf8').then(
          (text) => JSON.parse(text),
          (error) => {
            if (error.code === 'ENOENT') return undefined
            throw error
          },
        )
        if (owner === undefined) {
          owner = id
          const temporary = ownerPath + '.' + randomUUID()
          try {
            await writeFile(temporary, JSON.stringify(id), { signal })
            check()
            await rename(temporary, ownerPath)
          } finally {
            await unlink(temporary).catch(() => {})
          }
        }
        const filename =
          owner === id
            ? 'mod-store.json'
            : `mod-store-${createHash('sha256').update(id).digest('hex')}.json`
        const path = join(directory, filename)
        const encoded = await readFile(path, 'utf8').catch((error) => {
          if (error.code === 'ENOENT') return '[]'
          throw error
        })
        const values = new Map<string, unknown>(JSON.parse(encoded))
        const result = operation(values)
        if (write) {
          const text = JSON.stringify([...values])
          if (Buffer.byteLength(text) > MAX_BYTES)
            throw new Error('Mod store exceeds 4 MiB')
          const temporary = path + '.' + randomUUID()
          try {
            await writeFile(temporary, text, { signal })
            check()
            await rename(temporary, path)
          } finally {
            await unlink(temporary).catch(() => {})
          }
        }
        check()
        return result
      } finally {
        await release()
      }
    })
  storeQueues.set(directory, pending)
  try {
    return await pending
  } finally {
    if (storeQueues.get(directory) === pending) storeQueues.delete(directory)
  }
}

/** External programs are argv calls, never interpolated into a shell command. */
export function runModProcess(
  argv: string[],
  init: ModRecord = {},
  signal?: AbortSignal,
): Promise<unknown> {
  if (
    !Array.isArray(argv) ||
    !argv.length ||
    argv.some((arg) => typeof arg !== 'string' || arg.includes('\0'))
  )
    throw new Error('process.run requires a nonempty string argv array')
  const timeout = init.timeoutMs ?? 30_000
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 600_000)
    throw new Error('process.run timeoutMs must be between 1 and 600000')
  if (
    init.env &&
    (typeof init.env !== 'object' ||
      Object.values(init.env).some((value) => typeof value !== 'string'))
  )
    throw new Error('process.run env values must be strings')
  if (init.stdin !== undefined && typeof init.stdin !== 'string')
    throw new Error('process.run stdin must be text')
  if (init.cwd !== undefined && typeof init.cwd !== 'string')
    throw new Error('process.run cwd must be a path')
  signal?.throwIfAborted()
  const child = execa(argv[0]!, argv.slice(1), {
    cwd: resolve(getOriginalCwd(), init.cwd ?? '.'),
    env: { ...process.env, ...init.env },
    // A POSIX process group and Windows taskkill /T keep child programs from
    // surviving the command wrapper that launched them.
    detached: process.platform !== 'win32',
    windowsHide: true,
    // Collect bounded output below so overflow can stop the entire tree before
    // the process library kills its wrapper and orphans descendants.
    buffer: false,
    encoding: 'utf8',
    input: init.stdin ?? '',
    stripFinalNewline: false,
    reject: false,
  })
  let timedOut = false,
    canceled = false,
    maxBuffer = false,
    stopping: Promise<void> | undefined
  const stop = () => {
    if (stopping) return stopping
    stopping = (async () => {
      if (child.pid) {
        if (process.platform === 'win32') {
          const taskkill = resolveWindowsTaskkillPath()
          if (taskkill) {
            // Finish tree enumeration before killing the wrapper itself;
            // killing cmd.exe first can orphan its descendants.
            await execa(taskkill, ['/PID', String(child.pid), '/T', '/F'], {
              reject: false,
              timeout: 10_000,
              stdin: 'ignore', stdout: 'ignore', stderr: 'ignore',
              detached: true,
              cleanup: false,
              windowsHide: true,
            }).catch(() => {})
          }
        } else {
          try { process.kill(-child.pid, 'SIGKILL') } catch {}
        }
      }
      try { child.kill('SIGKILL') } catch {}
    })()
    return stopping
  }
  const stdout: Buffer[] = [], stderr: Buffer[] = []
  const collect = (chunks: Buffer[]) => {
    let bytes = 0
    return (chunk: Buffer | string) => {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      const available = Math.max(0, 1024 * 1024 - bytes)
      if (available) chunks.push(data.subarray(0, available))
      bytes += data.byteLength
      if (bytes > 1024 * 1024) {
        maxBuffer = true
        void stop()
      }
    }
  }
  child.stdout?.on('data', collect(stdout))
  child.stderr?.on('data', collect(stderr))
  const abort = () => {
    canceled = true
    void stop()
  }
  const timer = setTimeout(() => {
    timedOut = true
    void stop()
  }, timeout)
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) abort()
  return child.then(async result => {
    await stopping
    const output = {
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }
    if (timedOut || canceled || maxBuffer) {
      throw Object.assign(new Error(timedOut
        ? `Mod process timed out after ${timeout} milliseconds`
        : canceled ? 'Mod process canceled' : 'Mod process output exceeds 1 MiB'), {
        timedOut, isCanceled: canceled, isMaxBuffer: maxBuffer,
        ...output,
      })
    }
    if (result.timedOut || result.isCanceled || result.isMaxBuffer ||
      result.isTerminated || result.exitCode === undefined)
      throw Object.assign(result, output)
    return { exitCode: result.exitCode, ...output }
  }).finally(() => {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  })
}

export function createModHost(context: ModHostContext): ModHost {
  const filePath = (value: unknown) => {
    if (typeof value !== 'string' || value.includes('\0'))
      throw new Error('Expected a filesystem path')
    if (/^[\\/]{2}/.test(value) || /^[a-z][a-z0-9+.-]*:\/\//i.test(value))
      throw new Error('Mod filesystem calls do not accept network locations')
    return resolve(getOriginalCwd(), value)
  }
  const storeKey = (key: unknown) => {
    if (typeof key !== 'string') throw new Error('Store key must be a string')
    return key
  }
  return async (method, args, signal) => {
    signal.throwIfAborted()
    const [first, second] = args
    switch (method) {
      case 'session.cwd':
        return getOriginalCwd()
      case 'session.root':
        return getProjectRoot()
      case 'session.id':
        return getSessionId()
      case 'session.surfaces':
        return getIsInteractive() ? ['terminal'] : []
      case 'session.surface':
        return getIsInteractive() ? 'terminal' : null
      case 'tool.register':
        if (!context.tools)
          throw new Error('Tool registration requires a bound plugin session')
        return context.tools.register(first)
      case 'tool.list':
        if (!context.listTools)
          throw new Error('Tool listing requires a bound plugin session')
        return context.listTools()
      case 'command.register': {
        if (
          !first ||
          !/^[a-zA-Z0-9][a-zA-Z0-9:_-]*$/.test(first.name) ||
          typeof first.description !== 'string'
        )
          throw new Error('Invalid command registration')
        if (
          context.reserved.has(first.name) &&
          !context.commands.has(first.name)
        )
          throw new Error(`Command /${first.name} is already registered`)
        context.commands.set(first.name, {
          name: first.name,
          description: first.description,
          argumentHint: first.argumentHint,
          immediate: first.immediate === true,
        })
        context.reserved.add(first.name)
        await context.commandsChanged()
        return { command: first.name }
      }
      case 'command.list': {
        const { getCommands } = await import('../../../commands.js')
        const commands = await getCommands(getOriginalCwd())
        const inventory = new Map(
          commands.map((command) => [
            command.name,
            {
              name: command.name,
              description: command.description,
              source:
                command.loadedFrom === 'plugin'
                  ? 'plugin'
                  : command.type === 'prompt'
                    ? command.source
                    : 'builtin',
              ...(context.commands.has(command.name)
                ? { plugin: context.name }
                : {}),
            },
          ]),
        )
        // Registrations made during session.start are private until publish,
        // but the registering mod can already inspect its own commands.
        for (const command of context.commands.values())
          inventory.set(command.name, {
            name: command.name,
            description: command.description,
            source: 'plugin',
            plugin: context.name,
          })
        return [...inventory.values()]
      }
      case 'fs.read': {
        if (second?.as && !['text', 'bytes'].includes(second.as))
          throw new Error('fs.read as must be text or bytes')
        const handle = await open(filePath(first), 'r')
        try {
          const data = Buffer.alloc(MAX_BYTES + 1)
          let size = 0
          while (size < data.length) {
            signal.throwIfAborted()
            const { bytesRead } = await handle.read(
              data,
              size,
              data.length - size,
              null,
            )
            if (!bytesRead) break
            size += bytesRead
          }
          if (size > MAX_BYTES) throw new Error('Mod file read exceeds 4 MiB')
          return second?.as === 'bytes'
            ? { base64: data.subarray(0, size).toString('base64') }
            : data.toString('utf8', 0, size)
        } finally {
          await handle.close()
        }
      }
      case 'fs.write': {
        if (typeof second !== 'string')
          throw new Error('fs.write requires text')
        if (Buffer.byteLength(second) > MAX_BYTES)
          throw new Error('Mod file write exceeds 4 MiB')
        const path = filePath(first)
        await mkdir(resolve(path, '..'), { recursive: true })
        await writeFile(path, second, { signal })
        return
      }
      case 'fs.exists':
        return stat(filePath(first)).then(
          () => true,
          () => false,
        )
      case 'fs.list':
        return Promise.all(
          (await readdir(filePath(first ?? '.'), { withFileTypes: true }))
            .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
            .map(async (entry) => {
              const info = await lstat(join(filePath(first ?? '.'), entry.name))
              return {
                name: entry.name,
                kind: info.isDirectory()
                  ? 'dir'
                  : info.isFile()
                    ? 'file'
                    : 'other',
                size: info.size,
                isLink: info.isSymbolicLink(),
              }
            }),
        )
      case 'fs.stat': {
        const path = filePath(first),
          link = await lstat(path),
          info = await stat(path)
        return {
          kind: info.isDirectory() ? 'dir' : info.isFile() ? 'file' : 'other',
          size: info.size,
          mtimeMs: info.mtimeMs,
          isLink: link.isSymbolicLink(),
          ...(second?.resolve ? { realPath: await realpath(path) } : {}),
        }
      }
      case 'store.get':
        return useStore(
          context.id,
          (values) => values.get(storeKey(first)),
          false,
          signal,
        )
      case 'store.set':
        return useStore(
          context.id,
          (values) => {
            if (second === undefined)
              throw new Error('store.set requires JSON data')
            values.set(storeKey(first), second)
          },
          true,
          signal,
        )
      case 'store.delete':
        return useStore(
          context.id,
          (values) => {
            values.delete(storeKey(first))
          },
          true,
          signal,
        )
      case 'store.keys':
        return useStore(
          context.id,
          (values) => [...values.keys()],
          false,
          signal,
        )
      case 'clock.now':
        return Date.now()
      case 'clock.sleep':
        return new Promise<void>((done, reject) => {
          if (!Number.isFinite(first) || first < 0 || first > 600_000) {
            reject(new Error('Invalid sleep duration'))
            return
          }
          const abort = () => {
            clearTimeout(timer)
            reject(new Error('Mod event aborted'))
          }
          const timer = setTimeout(() => {
            signal.removeEventListener('abort', abort)
            done()
          }, first)
          signal.addEventListener('abort', abort, { once: true })
        })
      case 'process.run':
        return runModProcess(first, second, signal)
      case 'env.get':
        return process.env[String(first)]
      case 'settings.read': {
        const sources = {
          user: 'userSettings',
          project: 'projectSettings',
          local: 'localSettings',
          flag: 'flagSettings',
          policy: 'policySettings',
        } as const
        if (first?.source && !(first.source in sources))
          throw new Error('Unknown settings source')
        const value = first?.source
          ? (getSettingsForSource(
              sources[first.source as keyof typeof sources],
            ) ?? {})
          : getSettings_DEPRECATED()
        return first?.key ? (value as ModRecord)[first.key] : value
      }
      case 'ui.log': {
        if (typeof first !== 'string') throw new Error('ui.log requires text')
        if (second?.to && !['transcript', 'debug'].includes(second.to))
          throw new Error('Unknown ui.log destination')
        logForDebugging(`${context.name}: ${first}`)
        if (second?.to !== 'debug') context.log(`${context.name}: ${first}`)
        return
      }
      default:
        throw new Error(`Tau does not yet support mod API $.${method}`)
    }
  }
}
