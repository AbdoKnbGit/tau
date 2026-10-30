import type * as https from 'https'
import { Agent as HttpsAgent } from 'https'
import memoize from 'lodash-es/memoize.js'
import type * as tls from 'tls'
import type * as undici from 'undici'
import { getCACertificates } from './caCerts.js'
import { logForDebugging } from './debug.js'
import { getFsImplementation } from './fsOperations.js'

export type MTLSConfig = {
  cert?: string
  key?: string
  passphrase?: string
}

export type TLSConfig = MTLSConfig & {
  ca?: string | string[] | Buffer
}

/**
 * Get mTLS configuration from environment variables
 */
export const getMTLSConfig = memoize((): MTLSConfig | undefined => {
  const config: MTLSConfig = {}

  // Note: NODE_EXTRA_CA_CERTS is automatically handled by Node.js at runtime
  // We don't need to manually load it - Node.js appends it to the built-in CAs automatically

  // Client certificate
  if (process.env.CLAUDE_CODE_CLIENT_CERT) {
    try {
      config.cert = getFsImplementation().readFileSync(
        process.env.CLAUDE_CODE_CLIENT_CERT,
        { encoding: 'utf8' },
      )
      logForDebugging(
        'mTLS: Loaded client certificate from CLAUDE_CODE_CLIENT_CERT',
      )
    } catch (error) {
      logForDebugging(`mTLS: Failed to load client certificate: ${error}`, {
        level: 'error',
      })
    }
  }

  // Client key
  if (process.env.CLAUDE_CODE_CLIENT_KEY) {
    try {
      config.key = getFsImplementation().readFileSync(
        process.env.CLAUDE_CODE_CLIENT_KEY,
        { encoding: 'utf8' },
      )
      logForDebugging('mTLS: Loaded client key from CLAUDE_CODE_CLIENT_KEY')
    } catch (error) {
      logForDebugging(`mTLS: Failed to load client key: ${error}`, {
        level: 'error',
      })
    }
  }

  // Key passphrase
  if (process.env.CLAUDE_CODE_CLIENT_KEY_PASSPHRASE) {
    config.passphrase = process.env.CLAUDE_CODE_CLIENT_KEY_PASSPHRASE
    logForDebugging('mTLS: Using client key passphrase')
  }

  // Only return config if at least one option is set
  if (Object.keys(config).length === 0) {
    return undefined
  }

  return config
})

/**
 * Create an HTTPS agent with mTLS configuration
 */
export const getMTLSAgent = memoize((): HttpsAgent | undefined => {
  const mtlsConfig = getMTLSConfig()
  const caCerts = getCACertificates()

  if (!mtlsConfig && !caCerts) {
    return undefined
  }

  const agentOptions: https.AgentOptions = {
    ...mtlsConfig,
    ...(caCerts && { ca: caCerts }),
    // Enable keep-alive for better performance
    keepAlive: true,
  }

  logForDebugging('mTLS: Creating HTTPS agent with custom certificates')
  return new HttpsAgent(agentOptions)
})

/**
 * Get TLS options for WebSocket connections
 */
export function getWebSocketTLSOptions(): tls.ConnectionOptions | undefined {
  const mtlsConfig = getMTLSConfig()
  const caCerts = getCACertificates()

  if (!mtlsConfig && !caCerts) {
    return undefined
  }

  return {
    ...mtlsConfig,
    ...(caCerts && { ca: caCerts }),
  }
}

/**
 * Load the undici package to build a dispatcher from it.
 *
 * Node's built-in fetch is a separate copy of undici, and it can only read
 * responses from a dispatcher of its own major or older. With a newer built-in
 * copy (undici 8 in Node 26, against a package on 7) every response arrives with
 * no headers: JSON bodies stop parsing, retry-after is lost and HTTP MCP servers
 * fail to connect. Plain fetch() also ignores the package's global dispatcher, so
 * it skips a configured proxy. In that case the fetch classes come from the package
 * too, so both sides are one copy. Callers read the global fetch when they run, so
 * none of them have to change.
 */
export const loadUndiciForDispatcher = memoize((): typeof undici => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const undiciMod = require('undici') as typeof undici
  let packaged: string | undefined
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    packaged = (require('undici/package.json') as { version?: string }).version
  } catch {
    // Unknown, so the comparison below can't vouch for Node's copy.
  }
  const major = (version: string | undefined) => Number(version?.split('.')[0])
  // Node's copy stays only when known to fit: distribution builds may not report
  // a version, and the package's own pair works on every Node.
  const builtinCopyFits = major(process.versions.undici) <= major(packaged)
  // A fetch someone else installed, a preload's for instance, stays in place.
  // Node's own has the shape WebIDL gives it: named fetch, one required argument.
  // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
  const current = globalThis.fetch as typeof fetch | undefined
  if (
    typeof Bun === 'undefined' &&
    !builtinCopyFits &&
    current?.name === 'fetch' &&
    current.length === 1
  ) {
    logForDebugging(
      `undici: using the package's fetch (${packaged}) over Node's (${process.versions.undici})`,
    )
    Object.assign(globalThis, {
      fetch: undiciMod.fetch,
      Headers: undiciMod.Headers,
      Request: undiciMod.Request,
      Response: undiciMod.Response,
      FormData: undiciMod.FormData,
    })
  }
  return undiciMod
})

/**
 * Get fetch options with TLS configuration (mTLS + CA certs) for undici
 */
export function getTLSFetchOptions(): {
  tls?: TLSConfig
  dispatcher?: undici.Dispatcher
} {
  const mtlsConfig = getMTLSConfig()
  const caCerts = getCACertificates()

  if (!mtlsConfig && !caCerts) {
    return {}
  }

  const tlsConfig: TLSConfig = {
    ...mtlsConfig,
    ...(caCerts && { ca: caCerts }),
  }

  if (typeof Bun !== 'undefined') {
    return { tls: tlsConfig }
  }
  logForDebugging('TLS: Created undici agent with custom certificates')
  // Create a custom undici Agent with TLS options. Lazy-loaded so that
  // the ~1.5MB undici package is only loaded when mTLS/CA certs are configured.
  const undiciMod = loadUndiciForDispatcher()
  const agent = new undiciMod.Agent({
    connect: {
      cert: tlsConfig.cert,
      key: tlsConfig.key,
      passphrase: tlsConfig.passphrase,
      ...(tlsConfig.ca && { ca: tlsConfig.ca }),
    },
    pipelining: 1,
  })

  return { dispatcher: agent }
}

/**
 * Clear the mTLS configuration cache.
 */
export function clearMTLSCache(): void {
  getMTLSConfig.cache.clear?.()
  getMTLSAgent.cache.clear?.()
  logForDebugging('Cleared mTLS configuration cache')
}

/**
 * Configure global Node.js TLS settings
 */
export function configureGlobalMTLS(): void {
  const mtlsConfig = getMTLSConfig()

  if (!mtlsConfig) {
    return
  }

  // NODE_EXTRA_CA_CERTS is automatically handled by Node.js at runtime
  if (process.env.NODE_EXTRA_CA_CERTS) {
    logForDebugging(
      'NODE_EXTRA_CA_CERTS detected - Node.js will automatically append to built-in CAs',
    )
  }
}
