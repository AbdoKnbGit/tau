import { getInitialSettings } from '../../utils/settings/settings.js'

export type PeerSettings = {
  inbound: 'on' | 'off'
  replyLimit: number
  taskLimit: number
  openCommand?: string[]
}

/** settings.json `peers`, with the defaults filled in. */
export function readPeerSettings(): PeerSettings {
  const peers = getInitialSettings().peers
  return {
    inbound: peers?.inbound === 'on' ? 'on' : 'off',
    replyLimit: peers?.replyLimit ?? 8_000,
    taskLimit: peers?.taskLimit ?? 20,
    ...(peers?.openCommand?.length ? { openCommand: peers.openCommand } : {}),
  }
}
