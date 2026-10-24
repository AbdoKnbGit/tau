import { HOOK_EVENTS } from 'src/entrypoints/agentSdkTypes.js'
import type { AppState } from 'src/state/AppState.js'
import { logForDebugging } from '../debug.js'
import type { HooksSettings } from '../settings/types.js'
import { addSessionHook, removeSessionHook } from './sessionHooks.js'

/**
 * Registers hooks from a skill's frontmatter as session hooks.
 *
 * Hooks are registered as session-scoped hooks that persist for the duration
 * of the session. If a hook has `once: true`, it will be automatically removed
 * after its first successful execution.
 *
 * @param setAppState - Function to update the app state
 * @param sessionId - The current session ID
 * @param hooks - The hooks settings from the skill's frontmatter
 * @param skillName - The name of the skill (for logging)
 * @param skillRoot - The base directory of the skill (CLAUDE_SKILL_DIR)
 */
export function registerSkillHooks(
  setAppState: (updater: (prev: AppState) => AppState) => void,
  sessionId: string,
  hooks: HooksSettings,
  skillName: string,
  skillRoot?: string,
  plugin?: { root: string; id: string },
  isAgent = false,
): void {
  let registeredCount = 0

  for (const eventName of HOOK_EVENTS) {
    const matchers = hooks[eventName]
    if (!matchers) continue
    const targetEvent =
      isAgent && eventName === 'Stop' ? 'SubagentStop' : eventName

    for (const matcher of matchers) {
      for (const configuredHook of matcher.hooks) {
        // Each registration owns its one-shot callback, even when another
        // skill declares an identical hook object.
        const hook = { ...configuredHook }
        // For once: true hooks, use onHookSuccess callback to remove after execution
        const onHookSuccess = hook.once
          ? () => {
              logForDebugging(
                `Removing one-shot hook for event ${eventName} in skill '${skillName}'`,
              )
              removeSessionHook(setAppState, sessionId, targetEvent, hook, true)
            }
          : undefined

        addSessionHook(
          setAppState,
          sessionId,
          targetEvent,
          matcher.matcher || '',
          hook,
          onHookSuccess,
          skillRoot,
          plugin,
        )
        registeredCount++
      }
    }
  }

  if (registeredCount > 0) {
    logForDebugging(
      `Registered ${registeredCount} hooks from skill '${skillName}'`,
    )
  }
}
