import axios, { type AxiosRequestConfig } from 'axios'
import { lookup } from 'dns/promises'
import { BlockList, isIP } from 'net'

const blocked = new BlockList()
blocked.addSubnet('127.0.0.0', 8)
blocked.addSubnet('0.0.0.0', 8)
blocked.addSubnet('169.254.0.0', 16)
blocked.addAddress('100.100.100.200')
blocked.addAddress('::', 'ipv6')
blocked.addAddress('::1', 'ipv6')
blocked.addSubnet('fe80::', 10, 'ipv6')
blocked.addAddress('fd00:ec2::254', 'ipv6')

export function isBlockedMarketplaceRedirectHost(host: string): boolean {
  const name = host
    .replace(/^\[|\]$/g, '')
    .toLowerCase()
    .replace(/\.$/, '')
  return (
    name === 'localhost' ||
    name.endsWith('.localhost') ||
    [
      'metadata.google.internal',
      'metadata.goog',
      'instance-data.ec2.internal',
    ].includes(name) ||
    (isIP(name) !== 0 &&
      blocked.check(name, isIP(name) === 6 ? 'ipv6' : 'ipv4'))
  )
}

type DownloadPolicy = {
  maxBytes: number
  timeoutMs: number
  maxRedirects: number
  /**
   * Every hop, the first included, must use HTTPS and resolve to a host that
   * isn't loopback, link-local or cloud metadata. Otherwise only a hop that
   * left the original origin is held to that.
   */
  secureEveryHop: boolean
}

const MARKETPLACE_JSON_POLICY: DownloadPolicy = {
  maxBytes: 5 * 1024 * 1024,
  timeoutMs: 10_000,
  maxRedirects: 20,
  secureEveryHop: false,
}

// --plugin-dir URLs: a zip the user named on the command line.
const SESSION_ARCHIVE_POLICY: DownloadPolicy = {
  maxBytes: 50 * 1024 * 1024,
  timeoutMs: 10_000,
  maxRedirects: 20,
  secureEveryHop: false,
}

// `archive` plugin sources named by a catalog: Claude Code's documented limits.
const ARCHIVE_SOURCE_POLICY: DownloadPolicy = {
  maxBytes: 256 * 1024 * 1024,
  timeoutMs: 120_000,
  maxRedirects: 5,
  secureEveryHop: true,
}

/** Follow redirects explicitly so credentials and source restrictions survive each hop. */
export async function downloadMarketplaceJson(
  url: string,
  headers: Record<string, string>,
) {
  return downloadPluginResource(url, headers, MARKETPLACE_JSON_POLICY)
}

export async function downloadPluginArchive(url: string): Promise<Buffer> {
  const response = await downloadPluginResource(url, {}, SESSION_ARCHIVE_POLICY, 'arraybuffer')
  return Buffer.from(response.data)
}

/**
 * Download the zip of an `archive` plugin source. `headers` go only to the
 * archive URL's origin: a redirect elsewhere carries none of them.
 */
export async function downloadArchiveSource(
  url: string,
  headers: Record<string, string>,
): Promise<Buffer> {
  const response = await downloadPluginResource(url, headers, ARCHIVE_SOURCE_POLICY, 'arraybuffer')
  return Buffer.from(response.data)
}

async function downloadPluginResource(
  url: string,
  headers: Record<string, string>,
  policy: DownloadPolicy,
  responseType?: AxiosRequestConfig['responseType'],
) {
  let current = new URL(url)
  let requestHeaders = { ...headers }
  let guarded = policy.secureEveryHop
  const maxContentLength = policy.maxBytes
  const deadline = Date.now() + policy.timeoutMs
  for (let hop = 0; hop <= policy.maxRedirects; hop++) {
    if (Date.now() >= deadline)
      throw new Error('Marketplace download timed out')
    if (!['http:', 'https:'].includes(current.protocol))
      throw new Error('Marketplace downloads require HTTP or HTTPS')
    let pinnedLookup: AxiosRequestConfig['lookup']
    if (guarded) {
      if (
        current.protocol !== 'https:' ||
        isBlockedMarketplaceRedirectHost(current.hostname)
      ) {
        throw new Error(
          hop === 0
            ? 'Plugin archive URLs must use HTTPS and a non-local destination'
            : 'Marketplace redirect must use HTTPS and a non-local destination',
        )
      }
      const host = current.hostname.replace(/^\[|\]$/g, '')
      if (!isIP(host)) {
        let timer: ReturnType<typeof setTimeout> | undefined
        const addresses = await Promise.race([
          lookup(host, { all: true }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('Marketplace DNS lookup timed out')),
              Math.max(1, deadline - Date.now()),
            )
          }),
        ]).finally(() => clearTimeout(timer))
        if (
          !addresses.length ||
          addresses.some((a) => isBlockedMarketplaceRedirectHost(a.address))
        ) {
          throw new Error(
            hop === 0
              ? 'Plugin archive URL resolves to a local or metadata address'
              : 'Marketplace redirect resolves to a local or metadata address',
          )
        }
        // Bind the request to the addresses just checked, including IPv6.
        pinnedLookup = async () => [
          addresses.map((a) => ({
            address: a.address,
            family: a.family as 4 | 6,
          })),
        ]
      }
    }
    const response = await axios.get(current.href, {
      timeout: Math.max(1, deadline - Date.now()),
      maxContentLength,
      responseType,
      maxRedirects: 0,
      headers: requestHeaders,
      lookup: pinnedLookup,
      validateStatus: (status) =>
        (status >= 200 && status < 300) ||
        [301, 302, 303, 307, 308].includes(status),
    })
    if (response.status < 300) return response
    if (!response.headers.location)
      throw new Error('Marketplace redirect has no Location header')
    const next = new URL(response.headers.location, current)
    if (next.origin !== current.origin) {
      requestHeaders = {}
      guarded = true
    }
    current = next
  }
  throw new Error('Too many marketplace redirects')
}
