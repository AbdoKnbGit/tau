/**
 * Antigravity Gemini connection persistence: an opt-in experiment
 * (TAU_ANTIGRAVITY_KEEPALIVE=1). A leaf module so Node tests can load it.
 *
 * Node's fetch closes a connection 4 s after its last response unless the
 * server sends a keep-alive hint, so a conversation that pauses longer opens
 * a new TCP + TLS connection for its next request. Whether that changes
 * access to a warm prompt cache is not known. This keeps Antigravity Gemini
 * connections open through 60 s of idleness so it can be measured.
 *
 * Everything else matches the default dispatcher: HTTP/1.1, pipelining 1,
 * no cap on connections per origin, the same timeouts (undici 7 defaults,
 * checked against Node's bundled undici) and the same TLS material when a
 * custom CA or client certificate is configured. There is no warm-up
 * request, no ping and no connection cap, and the global dispatcher is left
 * alone: only these requests use this one.
 *
 * Reported as skipped, with the default transport kept: a proxy route (the
 * keep-alive would then apply to the proxy tunnel, a different variable) and
 * the Bun runtime (its fetch does not take undici dispatchers).
 */

export const ANTIGRAVITY_KEEPALIVE_IDLE_MS = 60_000

/** TLS material the default dispatcher uses (see utils/mtls.ts). */
export interface AntigravityTlsMaterial {
  cert?: string
  key?: string
  passphrase?: string
  ca?: string | string[]
}

export interface AntigravityTransportInputs {
  /** The URL goes through a proxy (NO_PROXY already applied). */
  proxied: boolean
  runtime: 'node' | 'bun'
  tls?: AntigravityTlsMaterial
}

export interface AntigravityKeepAliveChoice {
  effective: 'keepalive' | 'baseline'
  /** Why a requested treatment was not applied. */
  skipped?: 'proxy' | 'bun-runtime' | 'undici-unavailable'
  dispatcher?: object
  /** Version of the undici package that built the dispatcher. */
  undici?: string
}

interface UndiciLike {
  Agent: new (options: Record<string, unknown>) => { close(): Promise<void> }
}

export type UndiciLoader = () => { module: UndiciLike; version?: string }

function loadNpmUndici(): { module: UndiciLike; version?: string } {
  // Lazy like utils/mtls.ts: the package is only loaded when the experiment runs.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const module = require('undici') as UndiciLike
  let version: string | undefined
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    version = (require('undici/package.json') as { version?: string }).version
  } catch {
    // The version is only reported.
  }
  return { module, version }
}

export function antigravityKeepAliveRequested(): boolean {
  return process.env.TAU_ANTIGRAVITY_KEEPALIVE === '1'
}

interface CurrentDispatcher {
  tls: AntigravityTlsMaterial | undefined
  dispatcher: { close(): Promise<void> }
  undici?: string
}

let _current: CurrentDispatcher | undefined

function sameTls(a: AntigravityTlsMaterial | undefined, b: AntigravityTlsMaterial | undefined): boolean {
  if (!a || !b) return a === b
  const ca = (value: AntigravityTlsMaterial['ca']) => Array.isArray(value) ? value : value === undefined ? [] : [value]
  const caA = ca(a.ca)
  const caB = ca(b.ca)
  return a.cert === b.cert && a.key === b.key && a.passphrase === b.passphrase
    && caA.length === caB.length && caA.every((cert, i) => cert === caB[i])
}

/**
 * The dispatcher for one Antigravity Gemini request when the experiment is
 * requested. One long-lived dispatcher is reused; a TLS configuration change
 * builds a new one and closes the old one once its requests finish.
 */
export function chooseAntigravityKeepAlive(
  inputs: AntigravityTransportInputs,
  loadUndici: UndiciLoader = loadNpmUndici,
): AntigravityKeepAliveChoice {
  if (inputs.runtime === 'bun') return { effective: 'baseline', skipped: 'bun-runtime' }
  if (inputs.proxied) return { effective: 'baseline', skipped: 'proxy' }
  if (_current && sameTls(_current.tls, inputs.tls)) {
    return { effective: 'keepalive', dispatcher: _current.dispatcher, undici: _current.undici }
  }
  let loaded: ReturnType<UndiciLoader>
  try {
    loaded = loadUndici()
  } catch {
    return { effective: 'baseline', skipped: 'undici-unavailable' }
  }
  const tls = inputs.tls
  // Same options utils/mtls.ts gives the default dispatcher, plus the idle
  // keep-alive; undici's other defaults are the baseline's.
  const dispatcher = new loaded.module.Agent({
    keepAliveTimeout: ANTIGRAVITY_KEEPALIVE_IDLE_MS,
    ...(tls && {
      connect: {
        cert: tls.cert,
        key: tls.key,
        passphrase: tls.passphrase,
        ...(tls.ca && { ca: tls.ca }),
      },
      pipelining: 1,
    }),
  })
  const previous = _current
  _current = { tls, dispatcher, undici: loaded.version }
  // close() lets in-flight requests finish, then releases the old pool.
  previous?.dispatcher.close().catch(() => {})
  return { effective: 'keepalive', dispatcher, undici: loaded.version }
}

/** Close the experiment's dispatcher (in-flight requests finish first). */
export async function closeAntigravityKeepAlive(): Promise<void> {
  const current = _current
  _current = undefined
  await current?.dispatcher.close().catch(() => {})
}
