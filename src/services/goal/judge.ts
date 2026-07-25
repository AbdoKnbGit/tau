/**
 * Goal verification: a second opinion on the model's own completion claim.
 *
 * Self-report mode ends the loop when the model emits the completion marker,
 * which means the model grades itself. `--judge` puts one verification step
 * between the claim and the stop.
 *
 * Cost shape. The verifier is a fork of the LIVE conversation via
 * runForkedAgent, not a fresh agent handed a serialized transcript. That means:
 *   - the transcript is already in the fork's messages, so the prompt is the
 *     rubric alone (a few hundred tokens) rather than a re-serialization of the
 *     session;
 *   - the whole prefix is a cache READ against the main thread's entry.
 * It also means the fork must not override a single API parameter. Model,
 * thinking config, and max tokens are all part of the cache key, so "just use
 * Haiku for the judge" would cost a full uncached re-read of the session and be
 * far more expensive than inheriting the parent's model. See the warning in
 * promptSuggestion.ts (PR #18143: a fork-level effort override took the cache
 * hit rate from 92.7% to 61%).
 *
 * Fail-open by construction. Every failure path here returns null, and the
 * caller reads null as "no verdict" and honors the model's claim. A verifier
 * that is broken, rate-limited, or unparseable must never be able to trap the
 * loop; the worst case is exactly today's self-report behavior.
 */

import type { ToolUseContext } from '../../Tool.js'
import { logForDebugging } from '../../utils/debug.js'
import {
  getLastCacheSafeParams,
  runForkedAgent,
} from '../../utils/forkedAgent.js'
import { createUserMessage, extractTextContent } from '../../utils/messages.js'
import {
  buildGoalJudgePrompt,
  parseJudgeVerdict,
  type GoalVerdict,
} from './judgePrompt.js'
import type { GoalState } from './types.js'

/**
 * Safety cap on the verifier's loop. It has no tools, so one round-trip is the
 * expected shape; the second is slack for a model that reacts to a tool denial
 * before answering. Client-side only, so it does not touch the cache key.
 */
const JUDGE_MAX_TURNS = 2

/**
 * Asks the verifier whether the conversation satisfies the goal.
 *
 * Returns null when there is no usable verdict, which the caller treats as
 * "accept the model's claim".
 */
export async function runGoalJudge(
  goal: GoalState,
  toolUseContext: ToolUseContext,
): Promise<GoalVerdict | null> {
  // Written by handleStopHooks each turn; the goal loop runs after stop hooks,
  // so it is populated by the time we get here. Null means no turn has settled
  // yet — verifying without the parent's prefix would be an uncached re-read of
  // the whole session, so skip instead.
  const cacheSafeParams = getLastCacheSafeParams()
  if (!cacheSafeParams) {
    logForDebugging('Goal judge skipped: no cache-safe params for this turn')
    return null
  }

  if (toolUseContext.abortController.signal.aborted) return null

  // Deny via the callback rather than by passing tools: [] — an empty tool list
  // changes the cache key and costs the whole prefix.
  const canUseTool = async () => ({
    behavior: 'deny' as const,
    message: 'The goal verifier does not run tools.',
    decisionReason: {
      type: 'other' as const,
      reason: 'goal verification is read-only',
    },
  })

  try {
    const result = await runForkedAgent({
      promptMessages: [
        createUserMessage({ content: buildGoalJudgePrompt(goal.description) }),
      ],
      // Passed through untouched. Do NOT add model/effort/maxOutputTokens
      // overrides here; see the module comment.
      cacheSafeParams,
      canUseTool,
      // Deliberately not one of the tracked prefixes in
      // promptCacheBreakDetection (repl_main_thread / sdk / agent:*), so a
      // verification fork never registers as a cache break on the main thread.
      querySource: 'goal_judge',
      forkLabel: 'goal_judge',
      maxTurns: JUDGE_MAX_TURNS,
      skipTranscript: true,
      skipCacheWrite: true,
    })

    // Scan every assistant message, last one first: a model that reacts to the
    // tool denial before answering puts the verdict in its final message.
    for (let i = result.messages.length - 1; i >= 0; i--) {
      const message = result.messages[i]
      if (message?.type !== 'assistant') continue
      const text = extractTextContent(message.message.content, '\n')
      if (!text) continue
      const verdict = parseJudgeVerdict(text)
      if (verdict) {
        logForDebugging(
          `Goal judge verdict: passed=${verdict.passed}${
            verdict.feedback ? ` feedback=${verdict.feedback.slice(0, 120)}` : ''
          }`,
        )
        return verdict
      }
    }

    logForDebugging('Goal judge returned no parseable verdict')
    return null
  } catch (error) {
    logForDebugging(
      `Goal judge failed: ${error instanceof Error ? error.message : String(error)}`,
    )
    return null
  }
}
