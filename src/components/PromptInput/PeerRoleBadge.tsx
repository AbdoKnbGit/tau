import figures from 'figures'
import * as React from 'react'
import { Text } from '../../ink.js'
import { getPeerRole, subscribePeerRole } from '../../services/peers/runtime.js'

/**
 * Footer chip for tasks between sessions: which window orchestrates and which
 * works for it. Nothing in a session that takes no part. Screen only: no
 * request ever sees it.
 */
export function PeerRoleBadge(): React.ReactNode {
  const role = React.useSyncExternalStore(subscribePeerRole, getPeerRole)
  if (!role) return null
  if (role.kind === 'orchestrator') {
    return (
      <Text wrap="truncate">
        <Text backgroundColor="claude" color="inverseText" bold>
          {` ${figures.lozenge} orchestrator `}
        </Text>
        {role.openTasks > 0 ? <Text dimColor>{` ${role.openTasks} open`}</Text> : null}
      </Text>
    )
  }
  return (
    <Text wrap="truncate">
      <Text backgroundColor="permission" color="inverseText" bold>
        {` ${figures.bullet} worker `}
      </Text>
      {role.workingFor ? <Text dimColor>{` for ${role.workingFor}`}</Text> : null}
    </Text>
  )
}
