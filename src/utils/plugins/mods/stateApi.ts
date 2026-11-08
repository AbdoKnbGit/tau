import { invalidateModSite } from './uiState.js'

/** Which named value a `$.state` call is about: the owning plugin, the key,
 * and a family member's `id`. */
export type ModStateAddress = { plugin: string; key: string; id?: string }
/** Where a read made while drawing comes from: the site it subscribes, and
 * the one moment every read of that drawing sees. */
export type ModStateReader = { site: string; moment: Map<string, { value: unknown; version: number }> }

type Entry = { json: string; version: number }

/** Named values plugins keep for the session, each with its version. They
 * outlive a reload of a plugin's code and end with the session. */
const values = new Map<string, Entry>()
/** The sites whose drawing read each value: a write draws them again. */
const readers = new Map<string, Set<string>>()
/** What each plugin's values weigh, as JSON. */
const weights = new Map<string, number>()
// The same ceiling as a plugin's `$.store`.
const MAX_PLUGIN_BYTES = 4 * 1024 * 1024

const keyOf = (address: ModStateAddress) => JSON.stringify([address.plugin, address.key, address.id ?? null])

/** `$.state.get`: the value and the version it stands at, `undefined` at 0
 * while nothing was written. A read made while a site draws subscribes it,
 * and every read of one drawing sees one moment. */
export function readModState(address: ModStateAddress, reader?: ModStateReader): { value: unknown; version: number } {
  const key = keyOf(address)
  const seen = reader?.moment.get(key)
  if (seen) return { value: seen.value === undefined ? undefined : JSON.parse(JSON.stringify(seen.value)), version: seen.version }
  const entry = values.get(key)
  const read = entry ? { value: JSON.parse(entry.json) as unknown, version: entry.version } : { value: undefined, version: 0 }
  if (reader) {
    reader.moment.set(key, { value: read.value === undefined ? undefined : JSON.parse(entry!.json), version: read.version })
    let sites = readers.get(key)
    if (!sites) readers.set(key, (sites = new Set()))
    sites.add(reader.site)
  }
  return read
}

/** What stands under a reference now, for `e.previous` of a write. */
export function peekModState(address: ModStateAddress): unknown {
  const entry = values.get(keyOf(address))
  return entry ? JSON.parse(entry.json) : undefined
}

/** `$.state.set`: writes JSON data under the reference, only while it stands
 * at `ifVersion` when given; the sites that read it draw again. */
export function writeModState(
  address: ModStateAddress,
  value: unknown,
  ifVersion?: unknown,
): { isSet: boolean; version: number } {
  if (ifVersion !== undefined && (typeof ifVersion !== 'number' || !Number.isInteger(ifVersion) || ifVersion < 0))
    throw new Error('state.set ifVersion is a version number from $.state.get')
  let json: string | undefined
  try {
    json = value === undefined ? undefined : JSON.stringify(value)
  } catch (error) {
    throw new Error(`state.set requires JSON data: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (json === undefined) throw new Error('state.set requires JSON data, never undefined')
  const key = keyOf(address)
  const entry = values.get(key)
  const version = entry?.version ?? 0
  if (ifVersion !== undefined && ifVersion !== version) return { isSet: false, version }
  const weight = (weights.get(address.plugin) ?? 0) - (entry ? Buffer.byteLength(entry.json) : 0) + Buffer.byteLength(json)
  if (weight > MAX_PLUGIN_BYTES) throw new Error('state.set: a plugin\'s values exceed 4 MiB')
  weights.set(address.plugin, weight)
  values.set(key, { json, version: version + 1 })
  const sites = readers.get(key)
  readers.delete(key)
  for (const site of sites ?? []) invalidateModSite(site)
  return { isSet: true, version: version + 1 }
}

/** A new session (`/clear`, `/resume`, a branch) starts with no values. */
export function resetModState(): void {
  values.clear()
  readers.clear()
  weights.clear()
}
