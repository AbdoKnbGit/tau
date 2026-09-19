/**
 * Antigravity Gemini transport profile: how a request left the process
 * (dispatcher, proxy routing, TLS material), as recorded on every traced
 * dispatch. Connection identity lives in antigravity_connection.ts.
 */

import { hasNodeOption } from '../../utils/envUtils.js'
import { getProxyUrl, shouldBypassProxy } from '../../utils/proxy.js'

export interface AntigravityTransportProfile {
  /** Which dispatcher fetch() used: the process-wide default, or a treatment's. */
  dispatcher: 'global'
  /** Configured proxy routing for this URL (NO_PROXY applied). */
  route: 'direct' | 'proxy'
  /** Custom TLS material configured for the process. */
  tls: 'default' | 'custom-ca' | 'mtls'
  runtime: 'node' | 'bun'
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
