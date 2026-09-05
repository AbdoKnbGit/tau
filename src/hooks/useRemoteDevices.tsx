/**
 * Live count of devices paired through /remote.
 *
 * Backed by the bus rather than lifecycle so the prompt footer — which renders
 * on essentially every keystroke — doesn't pull the HTTP server, WebSocket
 * layer and tunnel subprocess into its import graph.
 */

import { useEffect, useState } from 'react'
import { getClientCount, subscribeClients } from '../services/remote/bus.js'

export function useRemoteDevices(): number {
  const [count, setCount] = useState(getClientCount)

  useEffect(() => {
    // Re-read on mount: a device may have connected between the initial
    // useState call and the subscription landing.
    setCount(getClientCount())
    return subscribeClients(setCount)
  }, [])

  return count
}
