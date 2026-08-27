import type { UUID } from 'crypto'
import * as React from 'react'
import { getOriginalCwd, getSessionId } from '../../bootstrap/state.js'
import { SessionTreeDialog } from '../../components/SessionTreeDialog.js'
import type { LocalJSXCommandContext } from '../../commands.js'
import type {
  LocalJSXCommandOnDone,
  ResumeEntrypoint,
} from '../../types/command.js'
import type { LogOption } from '../../types/logs.js'
import { logError } from '../../utils/log.js'
import {
  isLiteLog,
  loadFullLog,
  saveAgentName,
  saveCustomTitle,
} from '../../utils/sessionStorage.js'
import { buildSessionForest } from '../../utils/sessionTree.js'
import { isTeammate } from '../../utils/teammate.js'

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
): Promise<React.ReactNode> {
  const forest = await buildSessionForest(getOriginalCwd())
  if (forest.length === 0) {
    onDone('No sessions found in this project yet.')
    return null
  }

  const handleSelect = async (sessionId: UUID, log: LogOption) => {
    if (sessionId === getSessionId()) {
      onDone('Already in this session.', { display: 'system' })
      return
    }
    try {
      const fullLog = isLiteLog(log) ? await loadFullLog(log) : log
      // 'slash_command_picker' is the same entrypoint /resume uses when the
      // user picks a session out of its picker — keeps the resume code path
      // identical to a normal /resume so we don't introduce a new branch
      // through any cwd / auth / cache guard.
      const entrypoint: ResumeEntrypoint = 'slash_command_picker'
      await context.resume?.(sessionId, fullLog, entrypoint)
      onDone(undefined, { display: 'skip' })
    } catch (error) {
      logError(error as Error)
      onDone(`Failed to switch sessions: ${(error as Error).message}`)
    }
  }

  // Ctrl+R on a row. Titles are appended to the target session's own JSONL,
  // so renaming a session you're not in works exactly like /rename does for
  // the one you are in — no resume, no rebuild of the forest.
  const handleRename = async (
    sessionId: UUID,
    log: LogOption,
    title: string,
  ) => {
    const isActiveSession = sessionId === getSessionId()
    // Same refusal as /rename — a teammate's name belongs to the team leader.
    if (isActiveSession && isTeammate()) {
      throw new Error(
        'This session is a swarm teammate; its name is set by the team leader.',
      )
    }
    // save* falls back to a path guessed from the current project dir when
    // fullPath is missing, which would append (and mkdir) somewhere else
    // entirely for a session that lives under a sibling worktree. Refuse
    // instead of writing a stray transcript.
    if (!log.fullPath) {
      throw new Error(
        'No transcript path for this session — open it and use /rename.',
      )
    }
    await saveCustomTitle(sessionId, title, log.fullPath)
    if (isActiveSession) {
      // Same follow-through as /rename: the agent name is what the prompt bar
      // shows, and appState carries it for the rest of this session.
      await saveAgentName(sessionId, title, log.fullPath)
      context.setAppState(prev => ({
        ...prev,
        standaloneAgentContext: {
          ...prev.standaloneAgentContext,
          name: title,
        },
      }))
    }
  }

  const handleCancel = () => {
    onDone(undefined, { display: 'skip' })
  }

  return (
    <SessionTreeDialog
      forest={forest}
      activeSessionId={getSessionId()}
      onSelect={handleSelect}
      onRename={handleRename}
      onCancel={handleCancel}
    />
  )
}
