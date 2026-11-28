/**
 * OpenPeer: an orchestrator opens a Tau session in a window of its own,
 * either a closed session resumed or a new one in a folder, and gives it a
 * task. The new session takes tasks only from that orchestrator (--peer-of).
 *
 * The window command is settings peers.openCommand: an argv list where
 * "{tau}" is replaced by the Tau command as separate arguments, and
 * {tauLine}, {folder} and {title} inside any argument by their text. Any
 * terminal on any OS can be named that way. Built in are only defaults that
 * need no guessing: a tmux window when Tau runs in tmux, Windows Terminal or
 * cmd's start on Windows. Elsewhere the caller gets the command to run, and
 * the task waits for the session to start.
 */

import { spawn } from 'child_process'
import { randomUUID } from 'crypto'
import { existsSync, lstatSync, statSync } from 'fs'
import { readdir, readFile } from 'fs/promises'
import { basename, delimiter, isAbsolute, join } from 'path'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import {
  listSessionsImpl,
  parseSessionInfoFromLite,
  type SessionInfo,
} from '../../utils/listSessionsImpl.js'
import { getProjectsDir, readSessionLite } from '../../utils/sessionStoragePortable.js'
import {
  deliverPeerTask,
  cannotSendPeerTask,
  sendPeerTask,
  type PeerTaskOptions,
} from './runtime.js'
import { isPidAlive, listLiveCards, thisHost } from './store.js'

/** A window being opened may take a while to be looked at; the task waits. */
const OPENED_TASK_MAX_AGE_MS = 6 * 60 * 60_000
/** How many closed sessions ListPeers shows. */
const CLOSED_SESSIONS_SHOWN = 12

/** This same Tau, so the window runs the version that opened it. */
export function tauCommand(args: readonly string[]): string[] {
  return [process.execPath, ...(process.argv[1] ? [process.argv[1]] : []), ...args]
}

/** The argv as one line for a shell: POSIX quoting, or cmd's on Windows. */
export function peerCommandLine(argv: readonly string[], platform = process.platform): string {
  return argv
    .map(arg => {
      if (/^[\w@%+=:,./\\-]+$/.test(arg)) return arg
      return platform === 'win32' ? `"${arg.replace(/"/g, '""')}"` : `'${arg.replace(/'/g, `'\\''`)}'`
    })
    .join(' ')
}

/** lstat, not stat: Windows app aliases, which is what wt.exe usually is, can't be stat'ed. */
function isOnPeerPath(exe: string, env: NodeJS.ProcessEnv): boolean {
  const dirs = (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean)
  return dirs.some(dir => {
    try {
      lstatSync(join(dir, exe))
      return true
    } catch {
      return false
    }
  })
}

/** The built-in window command for this machine, or null when none is safe to assume. */
export function defaultOpenCommand(
  platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string[] | null {
  if (env.TMUX) return ['tmux', 'new-window', '-n', '{title}', '-c', '{folder}', '{tau}']
  if (platform === 'win32') {
    return isOnPeerPath('wt.exe', env)
      ? ['wt.exe', '-w', '0', 'new-tab', '--title', '{title}', '-d', '{folder}', '{tau}']
      : // start takes a title only in quotes, and Node quotes an empty argument but not "web".
        ['cmd.exe', '/c', 'start', '', '/D', '{folder}', '{tau}']
  }
  return null
}

export function expandOpenCommand(
  template: readonly string[],
  target: { folder: string; title: string; tauArgs: readonly string[] },
  platform = process.platform,
): string[] {
  const tau = tauCommand(target.tauArgs)
  const line = peerCommandLine(tau, platform)
  const out: string[] = []
  for (const part of template) {
    if (part === '{tau}') out.push(...tau)
    else {
      out.push(
        part
          .replaceAll('{tauLine}', line)
          .replaceAll('{folder}', target.folder)
          .replaceAll('{title}', target.title),
      )
    }
  }
  return out
}

/**
 * Session ids open in any Tau or Claude Code window on this machine, from the
 * <config>/sessions registry both keep. Resuming one of those in a second
 * window would have two processes writing one transcript.
 */
export async function openSessionIds(): Promise<Set<string>> {
  const dir = join(getClaudeConfigHomeDir(), 'sessions')
  const ids = new Set<string>()
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return ids
  }
  const host = thisHost().toLowerCase()
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue
    try {
      const entry = JSON.parse(await readFile(join(dir, name), 'utf8')) as {
        sessionId?: unknown
        pid?: unknown
        pidDomain?: unknown
      }
      if (typeof entry.sessionId !== 'string') continue
      const sameHost = typeof entry.pidDomain !== 'string' || entry.pidDomain.toLowerCase() === host
      // Another host's pid can't be checked here: count it as open, to be safe.
      if (!sameHost || isPidAlive(Number(entry.pid))) ids.add(entry.sessionId)
    } catch {
      // A file being rewritten: skip it this time.
    }
  }
  return ids
}

/** Recent sessions not open anywhere, newest first. */
export async function listClosedSessions(limit = CLOSED_SESSIONS_SHOWN): Promise<SessionInfo[]> {
  const open = await openSessionIds()
  const recent = await listSessionsImpl({ limit: limit + open.size + 4 })
  return recent.filter(s => !open.has(s.sessionId) && s.cwd).slice(0, limit)
}

function closedSessionTitle(s: SessionInfo): string {
  const title = (s.customTitle ?? s.summary ?? '').replace(/\s+/g, ' ').trim()
  return title.length > 60 ? `${title.slice(0, 57)}...` : title || basename(s.cwd ?? '') || 'session'
}

export function describeClosedSession(s: SessionInfo, now = Date.now()): string {
  const minutes = Math.floor((now - s.lastModified) / 60_000)
  const age = minutes < 60 ? `${Math.max(minutes, 0)}m ago` : minutes < 2880 ? `${Math.floor(minutes / 60)}h ago` : `${Math.floor(minutes / 1440)}d ago`
  return ['closed', `"${closedSessionTitle(s)}"`, s.cwd, `id ${s.sessionId}`, `last used ${age}`].join(' · ')
}

/**
 * The saved sessions whose id starts with `prefix`, found by listing the
 * project folders (no transcript is read but the matches).
 */
async function findSessions(prefix: string): Promise<SessionInfo[]> {
  const wanted = prefix.toLowerCase()
  let projects: string[]
  try {
    projects = await readdir(getProjectsDir())
  } catch {
    return []
  }
  const found: SessionInfo[] = []
  for (const project of projects) {
    let files: string[]
    try {
      files = await readdir(join(getProjectsDir(), project))
    } catch {
      continue
    }
    for (const file of files) {
      if (!file.endsWith('.jsonl') || !file.toLowerCase().startsWith(wanted)) continue
      const lite = await readSessionLite(join(getProjectsDir(), project, file))
      const info = lite && parseSessionInfoFromLite(file.slice(0, -'.jsonl'.length), lite)
      if (info?.cwd) found.push(info)
    }
  }
  return found
}

/** Starts the window; resolves false when the command could not be started. */
function startWindow(argv: string[], folder: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  return new Promise(resolve => {
    try {
      const child = spawn(argv[0]!, argv.slice(1), {
        cwd: folder,
        env,
        detached: true,
        stdio: 'ignore',
        // detached already opens no console; hiding would also hide a fresh
        // Windows Terminal window (measured 2026-11-28).
        windowsHide: false,
      })
      child.once('error', () => resolve(false))
      child.once('spawn', () => {
        child.unref()
        resolve(true)
      })
    } catch {
      resolve(false)
    }
  })
}

/** The opener's own environment, minus what marks a process as this Tau's child. */
function windowEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const name of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'TAU_LAUNCHER_PID', 'TAU_LAUNCHER_PARENT_PID']) {
    delete env[name]
  }
  return env
}

export type OpenPeerInput = { session?: string; folder?: string; name?: string; message: string }

/** Orchestrator side of OpenPeer. */
export async function openPeerSession(
  input: OpenPeerInput,
  options: PeerTaskOptions & { openCommand?: readonly string[] },
): Promise<{ ok: boolean; message: string }> {
  const problem = cannotSendPeerTask(options)
  if (problem) return { ok: false, message: problem }

  let sessionId: string
  let folder: string
  let title: string
  if (input.session) {
    const wanted = input.session.trim().toLowerCase()
    const open = await openSessionIds()
    if ([...open].some(id => id.toLowerCase().startsWith(wanted))) {
      // Already open somewhere: hand it the task there instead of a second copy.
      const live = (await listLiveCards()).find(c => c.sessionId.toLowerCase().startsWith(wanted))
      if (live) return sendPeerTask(live.sessionId, input.message, options)
      return {
        ok: false,
        message:
          'That session is already open in another window but does not take tasks. Ask the user to run /peers on there, then send it the task with SendMessage.',
      }
    }
    const found = wanted.length >= 4 ? await findSessions(wanted) : []
    if (found.length !== 1) {
      return {
        ok: false,
        message: found.length > 1
          ? `"${input.session}" matches ${found.length} sessions; give more of the id.`
          : `No closed session "${input.session}". ListPeers with closed: true shows them.`,
      }
    }
    sessionId = found[0]!.sessionId
    folder = found[0]!.cwd!
    // The name the session itself will answer under: its title, else its folder.
    title = found[0]!.customTitle?.trim() || basename(folder) || 'tau'
  } else {
    folder = (input.folder ?? '').trim()
    if (!isAbsolute(folder) || !existsSync(folder) || !statSync(folder).isDirectory()) {
      return { ok: false, message: 'Give folder as the absolute path of an existing folder, or session to reopen one.' }
    }
    sessionId = randomUUID()
    title = input.name?.trim() || basename(folder) || 'tau'
  }
  if (!existsSync(folder)) {
    return { ok: false, message: `That session's folder no longer exists: ${folder}` }
  }

  const failed = await deliverPeerTask(
    { sessionId, name: title, cwd: folder, pid: 0, host: thisHost() },
    input.message,
    { ...options, maxAgeMs: OPENED_TASK_MAX_AGE_MS },
  )
  if (failed) return { ok: false, message: failed }

  const tauArgs = input.session
    ? ['--resume', sessionId, '--peer-of', options.sessionId]
    : ['--session-id', sessionId, '-n', title, '--peer-of', options.sessionId]
  const template = options.openCommand?.length ? options.openCommand : defaultOpenCommand()
  const after = `Its answer arrives later as a task notification for peer:${title}. Don't wait or poll for it.`
  if (template) {
    const argv = expandOpenCommand(template, { folder, title, tauArgs })
    if (await startWindow(argv, folder, windowEnv())) {
      return { ok: true, message: `Opening "${title}" in a new window (${folder}); it takes the task as soon as it starts. ${after}` }
    }
  }
  // Two plain lines run the same in cmd, PowerShell and POSIX shells.
  return {
    ok: true,
    message:
      `No terminal window could be opened here (settings peers.openCommand sets one). The task waits for the session: ask the user to run these two lines in a terminal:\n` +
      `cd ${peerCommandLine([folder])}\ntau ${peerCommandLine(tauArgs)}\n${after}`,
  }
}
