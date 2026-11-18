/**
 * `headersHelper` commands: credentials too short-lived to list in `headers`.
 *
 * - A marketplace url source's helper is declared in a settings file, so the
 *   file's trust decides whether it runs: user, --settings and managed files
 *   run it; a project's files only after the user trusted that folder in an
 *   interactive session; --add-dir files never. Its output is reused for up
 *   to 60 seconds, for marketplace.json and for archive downloads on the
 *   marketplace URL's origin.
 * - An archive entry's helper is declared by the catalog, so it runs only
 *   with the user's consent for that install (commandConsent.ts).
 *
 * Every helper runs through the platform shell from the config directory,
 * prints one JSON object of string values and exits 0 within 10 seconds.
 */
import isEqual from 'lodash-es/isEqual.js'
import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import { checkHasTrustDialogAccepted } from '../config.js'
import { logForDebugging } from '../debug.js'
import { getClaudeConfigHomeDir } from '../envUtils.js'
import { execFileNoThrowWithCwd } from '../execFileNoThrow.js'
import { getSettingsForSource } from '../settings/settings.js'
import { getDeclaredCommandPolicyBlock } from './commandConsent.js'
import { withoutCredentials } from './commandSource.js'
import type { MarketplaceSource } from './schemas.js'

const HELPER_TIMEOUT_MS = 10_000
const MARKETPLACE_HELPER_REUSE_MS = 60_000

/** Run a headersHelper command and return the headers it printed. */
export async function runHeadersHelper(
  command: string,
  env: NodeJS.ProcessEnv,
): Promise<Record<string, string>> {
  const result = await execFileNoThrowWithCwd(command, [], {
    shell: true,
    timeout: HELPER_TIMEOUT_MS,
    killTreeOnTimeout: true,
    cwd: getClaudeConfigHomeDir(),
    env,
    // Exactly `env`: variables removed from it must not come back.
    extendEnv: false,
    stdin: 'ignore',
    maxBuffer: 1_000_000,
  })
  if (result.code !== 0) {
    throw new Error(
      `headersHelper failed: ${result.error ?? `exit code ${result.code}`}`,
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(result.stdout.trim())
  } catch {
    throw new Error('headersHelper did not print a JSON object')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('headersHelper did not print a JSON object')
  }
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(parsed)) {
    if (typeof value !== 'string') {
      throw new Error(`headersHelper printed a non-string value for "${name}"`)
    }
    headers[name] = value
  }
  return headers
}

type DeclaringSettings =
  | 'policySettings'
  | 'flagSettings'
  | 'localSettings'
  | 'projectSettings'
  | 'userSettings'

// Highest precedence first: the file whose entry the merged settings use.
const DECLARING_ORDER: DeclaringSettings[] = [
  'policySettings',
  'flagSettings',
  'localSettings',
  'projectSettings',
  'userSettings',
]

/**
 * The settings file that declares a marketplace, by name, or (before the
 * name is known, on a first fetch) by its source object.
 */
function findDeclaration(
  source: MarketplaceSource,
  marketplaceName: string | undefined,
): { declaredBy?: DeclaringSettings; name?: string } {
  for (const settingsSource of DECLARING_ORDER) {
    const known = getSettingsForSource(settingsSource)?.extraKnownMarketplaces
    if (!known) continue
    if (marketplaceName) {
      if (known[marketplaceName]) {
        return { declaredBy: settingsSource, name: marketplaceName }
      }
      continue
    }
    for (const [name, declared] of Object.entries(known)) {
      if (isEqual(declared?.source, source)) {
        return { declaredBy: settingsSource, name }
      }
    }
  }
  return {}
}

/** Why a url source's helper may not run now, or undefined when it may. */
function marketplaceHelperRefusal(
  source: Extract<MarketplaceSource, { source: 'url' }>,
  declaredBy: DeclaringSettings | undefined,
): string | undefined {
  if (!source.url.toLowerCase().startsWith('https://')) {
    return 'the marketplace URL does not use https://'
  }
  // A marketplace only --add-dir settings declare: its helper is ignored.
  if (!declaredBy) return 'no settings file the session trusts declares it'
  const block = getDeclaredCommandPolicyBlock()
  if (block && declaredBy !== 'policySettings') return `your settings disable it (${block})`
  if (declaredBy === 'projectSettings' || declaredBy === 'localSettings') {
    if (getIsNonInteractiveSession()) {
      return 'a project declares it, and a non-interactive session does not count as trusting the folder'
    }
    if (!checkHasTrustDialogAccepted()) {
      return 'a project declares it, and this folder has not been trusted'
    }
  }
  return undefined
}

const marketplaceHelperCache = new Map<
  string,
  { at: number; headers: Record<string, string> }
>()

/**
 * Headers for requests to a marketplace url source: its static `headers`,
 * with what its headersHelper prints laid over them when it may run.
 */
export async function getMarketplaceRequestHeaders(
  source: Extract<MarketplaceSource, { source: 'url' }>,
  marketplaceName: string | undefined,
): Promise<Record<string, string>> {
  const headers: Record<string, string> = { ...(source.headers ?? {}) }
  const helper = source.headersHelper
  if (!helper) return headers

  const { declaredBy, name } = findDeclaration(source, marketplaceName)
  const refusal = marketplaceHelperRefusal(source, declaredBy)
  if (refusal) {
    logForDebugging(`Marketplace headersHelper not run: ${refusal}`, {
      level: 'warn',
    })
    return headers
  }

  const key = `${new URL(source.url).origin}\n${helper}`
  const cached = marketplaceHelperCache.get(key)
  let printed: Record<string, string>
  if (cached && Date.now() - cached.at < MARKETPLACE_HELPER_REUSE_MS) {
    printed = cached.headers
  } else {
    // A project's helper runs without credential-like variables.
    const projectDeclared =
      declaredBy === 'projectSettings' || declaredBy === 'localSettings'
    const env: NodeJS.ProcessEnv = {
      ...(projectDeclared ? withoutCredentials(process.env) : process.env),
      CLAUDE_CODE_MARKETPLACE_URL: source.url,
    }
    if (name) env.CLAUDE_CODE_MARKETPLACE_NAME = name
    else delete env.CLAUDE_CODE_MARKETPLACE_NAME
    printed = await runHeadersHelper(helper, env)
    marketplaceHelperCache.set(key, { at: Date.now(), headers: printed })
  }
  return { ...headers, ...printed }
}

/** Headers an archive entry's own helper prints, run without credentials. */
export async function getArchiveEntryHelperHeaders(
  command: string,
  pluginName: string,
  archiveUrl: string,
): Promise<Record<string, string>> {
  return runHeadersHelper(command, {
    ...withoutCredentials(process.env),
    CLAUDE_CODE_PLUGIN_NAME: pluginName,
    CLAUDE_CODE_PLUGIN_ARCHIVE_URL: archiveUrl,
  })
}
