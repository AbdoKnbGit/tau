import { readFile, stat } from 'fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'path'
import { pathToFileURL } from 'url'
import { unzipSync } from 'fflate'
import { minVersion, Range, rcompare, satisfies, valid } from 'semver'
import { execFileNoThrow } from '../execFileNoThrow.js'
import { gitExe } from '../git.js'
import { isENOENT } from '../errors.js'
import { qualifyDependency } from './dependencyResolver.js'
import { loadInstalledPluginsFromDisk } from './installedPluginsManager.js'
import {
  getPluginByIdCacheOnly,
  loadKnownMarketplacesConfig,
} from './marketplaceManager.js'
import { parsePluginIdentifier } from './pluginIdentifier.js'
import {
  preferredGitHubPluginUrl,
  resolveGitSubdirUrl,
} from './pluginLoader.js'
import {
  DependencyRefSchema,
  type DependencyRef,
  type PluginMarketplaceEntry,
  type PluginScope,
  type PluginSource,
} from './schemas.js'

export type DependencyRequirement = { range: string; requiredBy: string }
export type DependencyRequirements = Map<string, DependencyRequirement[]>
export type SelectedDependencyVersion = {
  source: PluginSource
  version: string
  sha: string
}

export function addDependencyRequirements(
  requirements: DependencyRequirements,
  declaringId: string,
  dependencies: readonly DependencyRef[],
): void {
  for (const dependency of dependencies) {
    if (typeof dependency === 'string' || !dependency.version) continue
    const id = qualifyDependency(dependency, declaringId)
    const existing = requirements.get(id) ?? []
    if (
      !existing.some(
        r => r.range === dependency.version && r.requiredBy === declaringId,
      )
    ) {
      existing.push({ range: dependency.version, requiredBy: declaringId })
    }
    requirements.set(id, existing)
  }
}

export function dependencyRequirementsKey(
  requirements: DependencyRequirements,
): string {
  return JSON.stringify(
    [...requirements]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, refs]) => [
        id,
        refs.map(r => `${r.requiredBy}: ${r.range}`).sort(),
      ]),
  )
}

// A range can contain alternatives (||). Intersect comparator sets, then
// confirm a witness against the original ranges, preserving prerelease rules.
export function dependencyRangesOverlap(ranges: string[]): boolean {
  let combinations: string[][] = [[]]
  for (const range of ranges) {
    combinations = combinations.flatMap(existing =>
      new Range(range).set.map((set: { value: string }[]) => [
        ...existing,
        ...set.map(c => c.value).filter(Boolean),
      ]),
    )
  }
  return combinations.some(parts => {
    const minimum = minVersion(parts.join(' ') || '*')
    if (minimum === null) return false
    const release = `${minimum.major}.${minimum.minor}.${minimum.patch}`
    return [minimum, release].some(version =>
      ranges.every(range => satisfies(version, range)),
    )
  })
}

export async function readInstalledPluginDependencies(
  path: string,
): Promise<DependencyRef[]> {
  const names = ['.claude-plugin/plugin.json', 'plugin.json']
  let contents: string | undefined
  if (path.endsWith('.zip')) {
    const files = unzipSync(await readFile(path), {
      filter: file => names.includes(file.name),
    })
    for (const name of names) {
      if (files[name]) {
        contents = Buffer.from(files[name]!).toString('utf8')
        break
      }
    }
  } else {
    for (const name of names) {
      try {
        contents = await readFile(join(path, name), 'utf8')
        break
      } catch (error) {
        if (!isENOENT(error)) throw error
      }
    }
  }
  if (!contents) return []
  const manifest = JSON.parse(contents)
  return DependencyRefSchema()
    .array()
    .parse(manifest.dependencies ?? [])
}

/** Read disk state for updates without replacing the running session snapshot. */
export async function getInstalledDependencyRequirements(
  scope: PluginScope,
  projectPath: string | undefined,
  excluding: ReadonlySet<string> = new Set(),
): Promise<DependencyRequirements> {
  const requirements: DependencyRequirements = new Map()
  for (const [id, installations] of Object.entries(
    loadInstalledPluginsFromDisk().plugins,
  )) {
    if (excluding.has(id)) continue
    const installation = installations.find(
      i => i.scope === scope && i.projectPath === projectPath,
    )
    if (!installation) continue
    let dependencies: DependencyRef[] = []
    try {
      dependencies = await readInstalledPluginDependencies(
        installation.installPath,
      )
    } catch (error) {
      if (!isENOENT(error)) throw error
    }
    const marketplace = await getPluginByIdCacheOnly(id)
    addDependencyRequirements(requirements, id, [
      ...dependencies,
      ...(marketplace?.entry.dependencies ?? []),
    ])
  }
  return requirements
}

export function assertCompatibleDependencyRanges(
  id: string,
  requirements: DependencyRequirement[],
): void {
  if (!dependencyRangesOverlap(requirements.map(r => r.range))) {
    throw new Error(
      `Dependency "${id}" has conflicting version requirements: ${requirements.map(r => `${r.requiredBy} requires ${r.range}`).join('; ')}`,
    )
  }
}

/** Resolve namespaced release tags to immutable commits, never cache a tag lookup. */
export async function selectDependencyVersion(
  id: string,
  entry: PluginMarketplaceEntry,
  marketplaceLocation: string,
  requirements: DependencyRequirement[],
): Promise<SelectedDependencyVersion | undefined> {
  if (!requirements.length) return undefined
  assertCompatibleDependencyRanges(id, requirements)
  const { source } = entry
  let url: string
  let subdir: string | undefined
  const local = typeof source === 'string'
  if (local) {
    const dir = (await stat(marketplaceLocation)).isDirectory()
      ? marketplaceLocation
      : dirname(marketplaceLocation)
    const target = resolve(dir, source)
    const relativePath = relative(dir, target)
    if (
      isAbsolute(relativePath) ||
      relativePath === '..' ||
      relativePath.startsWith(`..${sep}`)
    ) {
      throw new Error(`Plugin source escapes marketplace: ${source}`)
    }
    // ls-remote supports local repositories and reads their tags without a fetch.
    url = pathToFileURL(dir).href
    subdir = relativePath.replaceAll(sep, '/') || undefined
    // A downloaded marketplace is often a shallow clone. Query its upstream
    // for tags; querying only the checkout would miss older release branches.
    const marketplace = parsePluginIdentifier(id).marketplace
    const config = marketplace
      ? (await loadKnownMarketplacesConfig())[marketplace]
      : undefined
    if (config?.source.source === 'github') {
      url = await preferredGitHubPluginUrl(config.source.repo)
    } else if (config?.source.source === 'git') {
      url = await resolveGitSubdirUrl(config.source.url)
    }
  } else if (source.source === 'github') {
    url = await preferredGitHubPluginUrl(source.repo)
  } else if (source.source === 'url' || source.source === 'git-subdir') {
    url = await resolveGitSubdirUrl(source.url)
    subdir = source.path
  } else return undefined

  const name = parsePluginIdentifier(id).name
  const prefix = `refs/tags/${name}--v`
  const tags = await execFileNoThrow(
    gitExe(),
    ['ls-remote', '--tags', '--', url, `${name}--v*`],
    {
      timeout: 120_000,
      useCwd: false,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    },
  )
  if (tags.code !== 0) {
    if (local) return undefined // a non-git local folder uses its current contents
    throw new Error(
      `Cannot resolve dependency "${id}" tags: ${tags.stderr || tags.error}`,
    )
  }
  const releases = new Map<
    string,
    { tag: string; version: string; sha: string; peeled: boolean }
  >()
  for (const line of tags.stdout.split(/\r?\n/)) {
    const [sha, ref] = line.split(/\s+/)
    if (!sha || !ref?.startsWith(prefix) || !/^[a-f0-9]{40,64}$/i.test(sha))
      continue
    const peeled = ref.endsWith('^{}')
    const tag = (peeled ? ref.slice(0, -3) : ref).slice('refs/tags/'.length)
    const version = tag.slice(`${name}--v`.length)
    if (
      !valid(version) ||
      !requirements.every(r => satisfies(version, r.range))
    )
      continue
    if (peeled || !releases.has(tag))
      releases.set(tag, { tag, version, sha, peeled })
  }
  const selected = [...releases.values()].sort((a, b) =>
    rcompare(a.version, b.version),
  )[0]
  if (!selected) {
    if (local) return undefined
    throw new Error(
      `Dependency "${id}" has no git tag satisfying ${requirements.map(r => r.range).join(' and ')}`,
    )
  }
  const selectedSource: PluginSource = subdir
    ? {
        source: 'git-subdir',
        url,
        path: subdir,
        ref: selected.tag,
        sha: selected.sha,
      }
    : { source: 'url', url, ref: selected.tag, sha: selected.sha }
  return {
    source: selectedSource,
    version: selected.version,
    sha: selected.sha,
  }
}
