/**
 * Antigravity Gemini trajectory envelope: an opt-in experiment
 * (TAU_ANTIGRAVITY_TRAJECTORY=1), minimal profile.
 *
 * The native Antigravity client tags every generation with its conversation's
 * trajectory. Whether the backend uses those tags for cache routing is not
 * known. This sends only the parts whose names, formats and lifetimes are
 * verified against the native client:
 *   - requestId  agent/<uuid>/<epoch ms>/<trajectory id>/<n>
 *   - labels     trajectory_id, used_claude=false, used_claude_conservative=false
 * last_execution_id, last_step_index, model_enum and the request_id label are
 * omitted as unverified, so this is a partial envelope, not native parity.
 * Prompt fields, generationConfig and the wire sessionId are untouched.
 *
 * One trajectory per conversation stream (main thread or one agent) on one
 * model, account and project, held in memory; a new process starts a new one.
 * Helpers never get an envelope and never advance a conversation's counter.
 * <n> advances once per dispatched attempt and is never reused.
 */

import { randomUUID } from 'crypto'

export type AntigravityTrajectoryProfile = 'off' | 'minimal' | 'rejected'

export interface AntigravityTrajectoryScope {
  /** Conversation or agent session id (not the hashed wire session id). */
  sessionId: string | undefined
  querySource: string | undefined
  model: string
  /** Opaque account key; the same for every request of one account. */
  account: string
  project: string | null
}

export interface AntigravityTrajectoryAttempt {
  /** Effective profile of this attempt. */
  profile: AntigravityTrajectoryProfile
  /** `new`: first attempt of the trajectory; `reset`: its state was evicted. */
  state?: 'new' | 'continued' | 'reset'
  /** Envelope identity to send; present only when the profile is `minimal`. */
  identity?: { requestId: string; labels: Record<string, string> }
}

interface TrajectoryState {
  profile: 'off' | 'minimal'
  requestUuid: string
  trajectoryId: string
  /** Last <n> handed out. The first attempt gets 2, as the accepted convention does. */
  step: number
}

// Far above any real session's stream count, so active trajectories are not
// evicted by a small LRU; an eviction is remembered and reported as `reset`.
const MAX_TRAJECTORIES = 2048
const _trajectories = new Map<string, TrajectoryState>()
const _evicted = new Set<string>()
let _rejection: { status: number; fields: string[] } | undefined

export function antigravityTrajectoryRequested(): boolean {
  return process.env.TAU_ANTIGRAVITY_TRAJECTORY === '1'
}

/** Main thread and agents only; helpers keep their current requests. */
function isConversationSource(querySource: string | undefined): boolean {
  return !querySource
    || querySource.startsWith('repl_main_thread')
    || querySource === 'sdk'
    || querySource.startsWith('agent:')
}

function scopeKey(scope: AntigravityTrajectoryScope): string {
  const source = !scope.querySource || scope.querySource.startsWith('repl_main_thread') || scope.querySource === 'sdk'
    ? 'conversation'
    : scope.querySource
  return JSON.stringify([scope.sessionId, source, scope.model.toLowerCase(), scope.account, scope.project ?? ''])
}

/**
 * Identity for one dispatched attempt. Call once per attempt, before the body
 * is wrapped; endpoint hops of that attempt reuse the result.
 */
export function antigravityTrajectoryForAttempt(
  scope: AntigravityTrajectoryScope,
): AntigravityTrajectoryAttempt {
  if (!scope.sessionId || !isConversationSource(scope.querySource)) return { profile: 'off' }
  const key = scopeKey(scope)
  let state = _trajectories.get(key)
  let lifecycle: AntigravityTrajectoryAttempt['state'] = 'continued'
  if (state) {
    _trajectories.delete(key)
  } else {
    // Chosen once per stream and kept, even if the variable changes later.
    state = {
      profile: antigravityTrajectoryRequested() ? 'minimal' : 'off',
      requestUuid: randomUUID(),
      trajectoryId: randomUUID(),
      step: 1,
    }
    lifecycle = _evicted.delete(key) ? 'reset' : 'new'
    if (_trajectories.size >= MAX_TRAJECTORIES) {
      const oldest = _trajectories.keys().next().value
      if (oldest !== undefined) {
        _trajectories.delete(oldest)
        _evicted.add(oldest)
        if (_evicted.size > MAX_TRAJECTORIES) {
          const stale = _evicted.values().next().value
          if (stale !== undefined) _evicted.delete(stale)
        }
      }
    }
  }
  _trajectories.set(key, state)
  if (state.profile === 'off') return { profile: 'off' }
  if (_rejection) return { profile: 'rejected', state: lifecycle }
  state.step++
  return {
    profile: 'minimal',
    state: lifecycle,
    identity: {
      requestId: `agent/${state.requestUuid}/${Date.now()}/${state.trajectoryId}/${state.step}`,
      labels: {
        trajectory_id: state.trajectoryId,
        used_claude: 'false',
        used_claude_conservative: 'false',
      },
    },
  }
}

const EXPERIMENT_FIELDS = /\b(labels|request_?id|requestId|trajectory_id)\b/gi

/**
 * A 400 that names an envelope field means the backend refuses the
 * experiment: disable it for the process. The failing request is not
 * retried. Returns the named fields when it disabled the profile.
 */
export function rejectAntigravityTrajectoryOn(
  status: number,
  body: string,
  attempt: AntigravityTrajectoryAttempt | undefined,
): string[] | undefined {
  if (status !== 400 || !attempt?.identity || _rejection) return undefined
  const fields = [...new Set([...body.matchAll(EXPERIMENT_FIELDS)].map(match => match[1]!))]
  if (fields.length === 0) return undefined
  _rejection = { status, fields }
  return fields
}

export function antigravityTrajectoryRejection(): { status: number; fields: string[] } | undefined {
  return _rejection
}

export function _resetAntigravityTrajectoryForTest(): void {
  _trajectories.clear()
  _evicted.clear()
  _rejection = undefined
}
