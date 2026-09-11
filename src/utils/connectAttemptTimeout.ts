import * as net from 'net'

/**
 * Per-address connection attempt timeout for Node's Happy Eyeballs
 * (`autoSelectFamily`, on by default since Node 20). For a host with several
 * addresses, Node gives each but the last 250 ms, then closes the attempt and
 * discards a handshake that completes later. A slow route or a busy event
 * loop can thus close every reachable address and fail with
 * AggregateError [ETIMEDOUT]. 2 s matches pi and RFC 8305's upper bound.
 */
export const CONNECT_ATTEMPT_TIMEOUT_MS = 2_000

/** Node's own switch for the same default. A value set with it always wins. */
const NODE_FLAG = '--network-family-autoselection-attempt-timeout'

type NetDefaults = {
  getDefaultAutoSelectFamilyAttemptTimeout?: () => number
  setDefaultAutoSelectFamilyAttemptTimeout?: (value: number) => void
}

type ConnectAttemptTimeoutDeps = {
  netImpl?: NetDefaults
  execArgv?: readonly string[]
  nodeOptions?: string
}

export type ConnectAttemptTimeoutResult = {
  outcome: 'applied' | 'node-flag' | 'already-longer' | 'unsupported' | 'failed'
  /** Node's default before this call, when the runtime reports it. */
  previousMs?: number
}

/** True for a command-line or NODE_OPTIONS token that names Node's flag. */
function isNodeFlagToken(token: string): boolean {
  // Node accepts `_` for `-` in option names, and NODE_OPTIONS may quote.
  const name = token.split('=')[0]!.replace(/^"+|"+$/g, '').replace(/_/g, '-')
  return name === NODE_FLAG
}

/**
 * Raise Node's connection attempt timeout for every socket this process opens
 * (fetch/undici, axios and ws alike), on every OS. Each connect reads the
 * default when it starts, so call this before the first one. Never throws,
 * never lowers a longer default, and keeps a value set with Node's own flag.
 */
export function configureConnectAttemptTimeout({
  netImpl = net,
  execArgv = process.execArgv,
  nodeOptions = process.env.NODE_OPTIONS ?? '',
}: ConnectAttemptTimeoutDeps = {}): ConnectAttemptTimeoutResult {
  try {
    if (typeof netImpl.setDefaultAutoSelectFamilyAttemptTimeout !== 'function') {
      return { outcome: 'unsupported' }
    }
    const previousMs =
      typeof netImpl.getDefaultAutoSelectFamilyAttemptTimeout === 'function'
        ? netImpl.getDefaultAutoSelectFamilyAttemptTimeout()
        : undefined
    if ([...execArgv, ...nodeOptions.split(/\s+/)].some(isNodeFlagToken)) {
      return { outcome: 'node-flag', previousMs }
    }
    if (previousMs !== undefined && previousMs >= CONNECT_ATTEMPT_TIMEOUT_MS) {
      return { outcome: 'already-longer', previousMs }
    }
    netImpl.setDefaultAutoSelectFamilyAttemptTimeout(CONNECT_ATTEMPT_TIMEOUT_MS)
    return { outcome: 'applied', previousMs }
  } catch {
    // Startup must never fail over a network tuning default.
    return { outcome: 'failed' }
  }
}
