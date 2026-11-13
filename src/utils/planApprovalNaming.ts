import type { UUID } from 'crypto'
import {
  isSessionPersistenceDisabled,
  onSessionSwitch,
} from '../bootstrap/state.js'
import { generateSessionName } from '../commands/rename/generateSessionName.js'
import type { AppState } from '../state/AppStateStore.js'
import type { FileStateCache } from './fileStateCache.js'
import { logError } from './log.js'
import { createUserMessage } from './messages.js'
import { samePlanPath } from './planFileStorage.js'
import {
  addPlanFileRenameNotice,
  capturePlanFileOwner,
  discardPlanFileRenameNotices,
  isPlanFileOwnerCurrent,
  renamePlanFileFromTitle,
  type PlanFileOwner,
} from './plans.js'
import {
  getCurrentSessionTitle,
  getTranscriptPath,
  saveAgentName,
  saveCustomTitle,
} from './sessionStorage.js'
import { getSettings_DEPRECATED } from './settings/settings.js'

export type PlanApprovalNamingRequest = {
  plan: string
  owner: PlanFileOwner
}

type NamingOptions = {
  setAppState: (updater: (prev: AppState) => AppState) => void
  readFileState?: Pick<FileStateCache, 'delete'> &
    Partial<Pick<FileStateCache, 'keys'>>
}

type PendingNaming = {
  owner: PlanFileOwner
  abortController: AbortController
}

let pendingNaming: PendingNaming | undefined

export function cancelPlanApprovalNaming(discardAllNotices = false): void {
  pendingNaming?.abortController.abort()
  pendingNaming = undefined
  discardPlanFileRenameNotices(discardAllNotices)
}

/** A session transition must never let an older approval name its successor. */
export function cancelStalePlanApprovalNaming(): void {
  if (pendingNaming && !isPlanFileOwnerCurrent(pendingNaming.owner)) {
    cancelPlanApprovalNaming()
  }
  discardPlanFileRenameNotices()
}

// A completed naming request can still have an undelivered path update. Scope
// that pending notice too; aborting only the model request is not sufficient.
onSessionSwitch(cancelStalePlanApprovalNaming)

function persistenceEnabled(): boolean {
  return (
    !isSessionPersistenceDisabled() &&
    getSettings_DEPRECATED()?.cleanupPeriodDays !== 0
  )
}

/** Start only after the approved plan belongs to its execution session. */
export function startPlanApprovalNaming(
  request: PlanApprovalNamingRequest,
  options: NamingOptions,
): void {
  void nameSessionFromApprovedPlan(request, options).catch(logError)
}

/** Transfer an approval only to the fresh session retaining that same plan. */
export function startPlanApprovalNamingAfterClear(
  request: PlanApprovalNamingRequest,
  options: NamingOptions,
): void {
  const owner = capturePlanFileOwner()
  if (
    owner.sessionId === request.owner.sessionId ||
    owner.planId !== request.owner.planId ||
    owner.directory !== request.owner.directory
  ) {
    return
  }
  startPlanApprovalNaming({ plan: request.plan, owner }, options)
}

export async function nameSessionFromApprovedPlan(
  { plan, owner }: PlanApprovalNamingRequest,
  { setAppState, readFileState }: NamingOptions,
): Promise<void> {
  cancelPlanApprovalNaming()
  if (
    !persistenceEnabled() ||
    !isPlanFileOwnerCurrent(owner) ||
    getCurrentSessionTitle(owner.sessionId)
  ) {
    return
  }

  // Capture the intended transcript before the model request; never select a
  // different session from a global getter when that request finishes.
  const transcriptPath = getTranscriptPath()
  const pending: PendingNaming = {
    owner,
    abortController: new AbortController(),
  }
  pendingNaming = pending
  const isCurrent = () =>
    pendingNaming === pending &&
    !pending.abortController.signal.aborted &&
    persistenceEnabled() &&
    isPlanFileOwnerCurrent(owner)

  try {
    // Plans put their goal first; the generic conversation namer tail-slices.
    const name = (
      await generateSessionName(
        [createUserMessage({ content: plan.slice(0, 1000) })],
        pending.abortController.signal,
      )
    )?.trim()
    if (!name || !isCurrent() || getCurrentSessionTitle(owner.sessionId)) return

    await saveCustomTitle(owner.sessionId as UUID, name, transcriptPath, 'auto')
    const stillOwnsTitle = () =>
      isCurrent() && getCurrentSessionTitle(owner.sessionId) === name
    if (!stillOwnsTitle()) return
    await saveAgentName(owner.sessionId as UUID, name, transcriptPath, 'auto')
    if (!stillOwnsTitle()) return
    setAppState((prev) => {
      if (!stillOwnsTitle() || prev.standaloneAgentContext?.name === name) {
        return prev
      }
      return {
        ...prev,
        standaloneAgentContext: { ...prev.standaloneAgentContext, name },
      }
    })

    const renamed = await renamePlanFileFromTitle(owner, name)
    if (!isCurrent() || renamed.status !== 'renamed') return
    readFileState?.delete(renamed.oldPath)
    readFileState?.delete(renamed.newPath)
    // FileStateCache normalizes spelling but does not canonicalize directory
    // aliases. Invalidate equivalent keys too, without discarding other reads.
    if (readFileState?.keys) {
      for (const path of readFileState.keys()) {
        if (
          samePlanPath(path, renamed.oldPath) ||
          samePlanPath(path, renamed.newPath)
        ) {
          readFileState.delete(path)
        }
      }
    }
    // Delivered with the session's next model request: at the next tool
    // boundary, or with the user's next prompt. It never starts a turn or
    // interrupts one, and it appends after earlier messages (prefix intact).
    addPlanFileRenameNotice({
      owner,
      oldPath: renamed.oldPath,
      newPath: renamed.newPath,
    })
  } finally {
    if (pendingNaming === pending) pendingNaming = undefined
  }
}
