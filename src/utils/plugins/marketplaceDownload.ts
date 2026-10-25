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

/** Follow redirects explicitly so credentials and source restrictions survive each hop. */
export async function downloadMarketplaceJson(
  url: string,
  headers: Record<string, string>,
) {
  return downloadPluginResource(url, headers, 5 * 1024 * 1024)
}

export async function downloadPluginArchive(url: string): Promise<Buffer> {
  const response = await downloadPluginResource(url, {}, 50 * 1024 * 1024, 'arraybuffer')
  return Buffer.from(response.data)
}

async function downloadPluginResource(
  url: string,
  headers: Record<string, string>,
  maxContentLength: number,
  responseType?: AxiosRequestConfig['responseType'],
) {
  let current = new URL(url)
  let requestHeaders = { ...headers }
  let guarded = false
  const deadline = Date.now() + 10000
  for (let hop = 0; hop <= 20; hop++) {
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
          'Marketplace redirect must use HTTPS and a non-local destination',
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
            'Marketplace redirect resolves to a local or metadata address',
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
