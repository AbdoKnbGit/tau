/**
 * Antigravity Gemini transport profile: how a request left the process
 * (dispatcher, proxy routing, TLS material), as recorded on every traced
 * dispatch, and the dispatcher of the opt-in keep-alive experiment
 * (antigravity_keepalive.ts). Connection identity lives in
 * antigravity_connection.ts.
 */

import { getCACertificates } from '../../utils/caCerts.js'
import { hasNodeOption } from '../../utils/envUtils.js'
import { getMTLSConfig } from '../../utils/mtls.js'
import { getProxyUrl, shouldBypassProxy } from '../../utils/proxy.js'
import {
  ANTIGRAVITY_KEEPALIVE_IDLE_MS,
  antigravityKeepAliveRequested,
  chooseAntigravityKeepAlive,
  type AntigravityTlsMaterial,
} from './antigravity_keepalive.js'

export interface AntigravityTransportProfile {
  /** Which dispatcher fetch() used: the process-wide default, or the experiment's. */
  dispatcher: 'global' | 'keepalive'
  /** Configured proxy routing for this URL (NO_PROXY applied). */
  route: 'direct' | 'proxy'
  /** Custom TLS material configured for the process. */
  tls: 'default' | 'custom-ca' | 'mtls'
  runtime: 'node' | 'bun'
  /** Present when TAU_ANTIGRAVITY_KEEPALIVE=1 asked for the experiment. */
  keepAlive?: {
    effective: 'keepalive' | 'baseline'
    idleMs?: number
    skipped?: string
    undici?: string
  }
}

export interface AntigravityTransport {
  profile: AntigravityTransportProfile
  /** undici dispatcher to hand to fetch(); absent for the default transport. */
  dispatcher?: object
}

export function describeAntigravityTransport(url: string): AntigravityTransportProfile {
  const proxied = !!getProxyUrl() && !shouldBypassProxy(url)
  const mtls = !!(process.env.CLAUDE_CODE_CLIENT_CERT || process.env.CLAUDE_CODE_CLIENT_KEY)
  // Same inputs caCerts.ts uses to decide whether it replaces the CA store.
  const customCa = !!process.env.NODE_EXTRA_CA_CERTS
    || hasNodeOption('--use-system-ca')
    || hasNodeOption('--use-openssl-ca')
  return {
    dispatcher: 'global',
    route: proxied ? 'proxy' : 'direct',
    tls: mtls ? 'mtls' : customCa ? 'custom-ca' : 'default',
    runtime: typeof Bun !== 'undefined' ? 'bun' : 'node',
  }
}

// The material utils/mtls.ts getTLSFetchOptions() gives the default dispatcher.
function customTlsMaterial(): AntigravityTlsMaterial | undefined {
  const mtls = getMTLSConfig()
  const ca = getCACertificates()
  if (!mtls && !ca) return undefined
  return { ...mtls, ...(ca && { ca }) }
}

/**
 * Transport for one Antigravity Gemini request. Without
 * TAU_ANTIGRAVITY_KEEPALIVE=1 this is always the default dispatcher.
 */
export function antigravityTransportFor(url: string): AntigravityTransport {
  const profile = describeAntigravityTransport(url)
  if (!antigravityKeepAliveRequested()) return { profile }
  const choice = chooseAntigravityKeepAlive({
    proxied: profile.route === 'proxy',
    runtime: profile.runtime,
    tls: profile.route === 'direct' ? customTlsMaterial() : undefined,
  })
  return {
    profile: {
      ...profile,
      dispatcher: choice.dispatcher ? 'keepalive' : 'global',
      keepAlive: {
        effective: choice.effective,
        ...(choice.dispatcher && { idleMs: ANTIGRAVITY_KEEPALIVE_IDLE_MS }),
        ...(choice.skipped && { skipped: choice.skipped }),
        ...(choice.undici && { undici: choice.undici }),
      },
    },
    dispatcher: choice.dispatcher,
  }
}
