/**
 * Outbound half of /remote: mirrors the live session to any paired phone.
 *
 * Modeled on useWhatsAppMirror's "track a last-written index, forward the new
 * tail" pattern, with one addition — while a turn is in flight the final
 * message is held back, because it is the streaming tail and its content
 * mutates in place rather than appending. Holding it back means tool lines and
 * settled text still reach the phone mid-turn without any risk of sending the
 * same reply twice.
 *
 * The hook also installs the snapshot provider the WebSocket server calls when
 * a phone connects, and the interrupt handler the Stop button drives — and,
 * for `tau --remote-local`, starts the listener once those are in place.
 */

import { useEffect, useRef } from 'react'
import { useNotifications } from '../context/notifications.js'
import { takeLocalAtStartup } from '../services/remote/autostart.js'
import { broadcast, isRemoteActive as isOn } from '../services/remote/bus.js'
import { listDevices } from '../services/remote/devices.js'
import {
  RemoteCancelledError,
  setInboundHandlers,
  setSnapshotProvider,
  turnOn,
  type Snapshot,
} from '../services/remote/lifecycle.js'
import type { RemoteState } from '../services/remote/state.js'
import { listRemoteCommands } from '../services/remote/commands.js'
import { getPendingAsks } from '../services/remote/interactive.js'
import {
  routeInboundPrompt,
  routeInterrupt,
  routeReply,
  setInterruptHandler,
} from '../services/remote/router.js'
import { projectAll } from '../services/remote/transcript.js'
import { isBridgeSafeCommand, type Command } from '../commands.js'
import type { Message } from '../types/message.js'

/** One line: the address a phone opens, without the session token. */
function startedNotice(state: RemoteState): string {
  const parts = [`Remote local on · http://${state.host}:${state.port}`]
  if (state.preferredPortBusy) parts.push('port 7777 was taken')
  const remembered = listDevices().length
  parts.push(
    remembered > 0
      ? `${remembered} remembered phone${remembered === 1 ? '' : 's'} can reconnect · /remote local for a new one`
      : '/remote local shows the QR code',
  )
  return parts.join(' · ')
}

export function useRemoteMirror(
  messages: readonly Message[],
  isLoading: boolean,
  abortControllerRef: React.RefObject<AbortController | null>,
  mainLoopModel: string,
  commands: readonly Command[],
): void {
  const sentRef = useRef(0)

  // Keep the values the server reads out-of-band fresh without re-registering
  // the provider on every render.
  const liveRef = useRef({ messages, isLoading, mainLoopModel, commands })
  liveRef.current = { messages, isLoading, mainLoopModel, commands }

  useEffect(() => {
    const snapshot = (): Snapshot => {
      const live = liveRef.current
      return {
        cwd: process.cwd(),
        model: live.mainLoopModel,
        busy: live.isLoading,
        messages: projectAll(live.messages),
        asks: getPendingAsks(),
        commands: listRemoteCommands(live.commands, isBridgeSafeCommand),
      }
    }
    setSnapshotProvider(snapshot)
    setInterruptHandler(() => abortControllerRef.current?.abort())
    setInboundHandlers({
      onPrompt: routeInboundPrompt,
      onInterrupt: routeInterrupt,
      onReply: routeReply,
    })
    return () => {
      setSnapshotProvider(null)
      setInterruptHandler(null)
      setInboundHandlers(null)
    }
  }, [abortControllerRef])

  const { addNotification } = useNotifications()

  // `tau --remote-local`. Declared after the effect above, so React runs it
  // later in the same commit: by the time a phone can connect, the snapshot
  // provider and inbound handlers are installed, and nothing it sends is lost.
  useEffect(() => {
    if (!takeLocalAtStartup()) return
    void turnOn('local').then(
      state =>
        addNotification({
          key: 'remote-local',
          text: startedNotice(state),
          priority: 'medium',
          timeoutMs: 20_000,
        }),
      err => {
        // `/remote off` landed while it was starting: that is the answer.
        if (err instanceof RemoteCancelledError) return
        const reason = String((err as Error)?.message ?? err).split('\n')[0]
        addNotification({
          key: 'remote-local',
          text: `Remote local did not start: ${reason} · /remote local for details`,
          color: 'warning',
          priority: 'high',
          timeoutMs: 30_000,
        })
      },
    )
  }, [addNotification])

  // Busy flag goes out immediately so the phone shows progress the moment a
  // turn starts, well before any text settles.
  useEffect(() => {
    if (!isOn()) return
    broadcast({ t: 'state', busy: isLoading })
  }, [isLoading])

  useEffect(() => {
    if (!isOn()) {
      sentRef.current = messages.length
      return
    }

    // /clear, /compact and /resume rewrite the array. An incremental diff
    // can't express that, so resend the whole transcript; the client's
    // `hello` handler clears its log before replaying.
    if (messages.length < sentRef.current) {
      sentRef.current = messages.length
      broadcast({
        t: 'hello',
        cwd: process.cwd(),
        model: mainLoopModel,
        busy: isLoading,
        messages: projectAll(messages),
        asks: getPendingAsks(),
        commands: listRemoteCommands(liveRef.current.commands, isBridgeSafeCommand),
      })
      return
    }

    const safeEnd = isLoading ? Math.max(0, messages.length - 1) : messages.length
    if (safeEnd <= sentRef.current) return

    const items = projectAll(messages.slice(sentRef.current, safeEnd))
    sentRef.current = safeEnd
    if (items.length > 0) broadcast({ t: 'messages', messages: items })
  }, [messages, isLoading, mainLoopModel])
}
