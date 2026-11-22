import { useEffect } from 'react'
import { useNotifications } from 'src/context/notifications.js'
import { onLocalModelNotice } from '../../utils/model/localModelNotices.js'

/**
 * Shows one-time notices about models on this machine, such as a model that
 * no longer fits on the GPU (utils/model/localModelNotices.ts). Idle for
 * every other provider, which never publishes one.
 */
export function useLocalModelNotices(): void {
  const { addNotification } = useNotifications()
  useEffect(
    () =>
      onLocalModelNotice(notice => {
        addNotification({
          key: notice.key,
          text: notice.text,
          color: 'warning',
          priority: 'medium',
          timeoutMs: 15_000,
        })
      }),
    [addNotification],
  )
}
