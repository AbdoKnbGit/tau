import * as React from 'react'
import { useMainLoopModel } from '../../hooks/useMainLoopModel.js'
import { useSetAppState } from '../../state/AppState.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import { antigravityEffortCommand } from '../../utils/model/antigravityClaudeTiers.js'

/**
 * /effort on Antigravity. Its requests carry no effort field, so the global
 * setting would be saved and then never sent. On a Claude 5.5 model the level
 * lives in the model id, so the command switches the id instead, the way the
 * /models chip does.
 */
export function AntigravityEffort({
  args,
  onDone,
}: {
  args: string
  onDone: LocalJSXCommandOnDone
}): React.ReactNode {
  const model = useMainLoopModel()
  const setAppState = useSetAppState()
  React.useEffect(() => {
    const result = antigravityEffortCommand(model, args)
    if (result.model) {
      const nextModel = result.model
      setAppState(prev => ({
        ...prev,
        mainLoopModel: nextModel,
        mainLoopModelForSession: null,
      }))
    }
    onDone(result.message)
    // Runs once per command; the model it read is the one being changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return null
}
