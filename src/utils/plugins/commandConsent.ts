/**
 * Consent for commands a marketplace catalog declares: a `command` plugin
 * source, and an archive entry's `headersHelper`. Tau runs one only after the
 * user accepted that exact command for that plugin, in the shell, through
 * `tau plugin install` / `tau plugin update` (or --yes / --accept-command).
 *
 * - An explicit install or update needs consent given in this process, so a
 *   user accepts the command each time they install or update the plugin.
 * - A command source's later runs (once per session, and when its cached
 *   version is missing) reuse the last accepted command; a changed command
 *   does not run until the user accepts it again.
 * - Settings can turn all of this off (disableCommandPluginSources, or
 *   allowManagedHooksOnly unless disableCommandPluginSources is false).
 *
 * Accepted commands are kept in a Tau-owned file under the plugins directory.
 */
import { createHash } from 'crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { logForDebugging } from '../debug.js'
import { errorMessage, isENOENT } from '../errors.js'
import { getInitialSettings, getSettingsForSource } from '../settings/settings.js'
import { isArchiveSource } from './archiveSource.js'
import { isCommandSource } from './commandSource.js'
import { getPluginsDirectory } from './pluginDirectories.js'
import type { PluginMarketplaceEntry } from './schemas.js'

export type DeclaredCommand =
  | {
      kind: 'command-source'
      pluginId: string
      command: string
      mode: 'copy' | 'link'
    }
  | {
      kind: 'headers-helper'
      pluginId: string
      command: string
      archiveUrl: string
    }

/** The command a marketplace entry would have Tau run, if any. */
export function getDeclaredCommand(
  pluginId: string,
  entry: PluginMarketplaceEntry,
): DeclaredCommand | undefined {
  if (isCommandSource(entry.source)) {
    return {
      kind: 'command-source',
      pluginId,
      command: entry.source.command,
      mode: entry.source.mode ?? 'copy',
    }
  }
  if (isArchiveSource(entry.source) && entry.headersHelper) {
    return {
      kind: 'headers-helper',
      pluginId,
      command: entry.headersHelper,
      archiveUrl: entry.source.url,
    }
  }
  return undefined
}

/**
 * What the user accepts, as a SHA-256: the command, plus its mode or the
 * archive URL it fetches. `--accept-command` takes this value.
 */
export function declaredCommandSha256(declared: DeclaredCommand): string {
  const identity =
    declared.kind === 'command-source'
      ? { kind: declared.kind, command: declared.command, mode: declared.mode }
      : { kind: declared.kind, command: declared.command, url: declared.archiveUrl }
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex')
}

/** Lines that show a user what they are asked to accept. */
export function describeDeclaredCommand(declared: DeclaredCommand): string[] {
  return declared.kind === 'command-source'
    ? [
        `Plugin "${declared.pluginId}" is installed by running this command from its marketplace:`,
        `  ${declared.command}`,
        `Mode: ${declared.mode}. It runs now and again once per session.`,
      ]
    : [
        `Plugin "${declared.pluginId}" downloads its archive with credentials printed by this command from its marketplace:`,
        `  ${declared.command}`,
        `Archive: ${declared.archiveUrl}`,
      ]
}

// ── Policy ──

/** Why settings forbid catalog-declared commands, or undefined if they don't. */
export function getDeclaredCommandPolicyBlock(): string | undefined {
  const settings = getInitialSettings()
  const policy = getSettingsForSource('policySettings')
  if (settings.disableCommandPluginSources === true) {
    return 'disableCommandPluginSources'
  }
  if (
    policy?.allowManagedHooksOnly === true &&
    policy.disableCommandPluginSources !== false
  ) {
    return 'allowManagedHooksOnly'
  }
  return undefined
}

// ── Consent ──

type ConsentRecord = { sha256: string; acceptedAt: string }
type ConsentFile = {
  version: 1
  consents: Record<string, Partial<Record<DeclaredCommand['kind'], ConsentRecord>>>
}

const freshConsents = new Set<string>()

function consentKey(declared: DeclaredCommand): string {
  return `${declared.pluginId}\n${declared.kind}\n${declaredCommandSha256(declared)}`
}

function getConsentFilePath(): string {
  return join(getPluginsDirectory(), 'command-consents.json')
}

function readConsentFile(): ConsentFile {
  try {
    const parsed = JSON.parse(readFileSync(getConsentFilePath(), 'utf8'))
    if (parsed && parsed.version === 1 && parsed.consents && typeof parsed.consents === 'object') {
      return parsed as ConsentFile
    }
  } catch (error) {
    if (!isENOENT(error)) {
      logForDebugging(`Ignoring unreadable command consents: ${errorMessage(error)}`, {
        level: 'warn',
      })
    }
  }
  return { version: 1, consents: {} }
}

function writeConsentFile(file: ConsentFile): void {
  const path = getConsentFilePath()
  mkdirSync(getPluginsDirectory(), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(file, null, 2)}\n`, 'utf8')
  renameSync(temporary, path)
}

/** Record that the user accepted this exact command, now and for later runs. */
export function grantDeclaredCommandConsent(declared: DeclaredCommand): void {
  freshConsents.add(consentKey(declared))
  const file = readConsentFile()
  const forPlugin = file.consents[declared.pluginId] ?? {}
  forPlugin[declared.kind] = {
    sha256: declaredCommandSha256(declared),
    acceptedAt: new Date().toISOString(),
  }
  file.consents[declared.pluginId] = forPlugin
  writeConsentFile(file)
}

export function hasStoredConsent(declared: DeclaredCommand): boolean {
  const record = readConsentFile().consents[declared.pluginId]?.[declared.kind]
  return record?.sha256 === declaredCommandSha256(declared)
}

/** Forget a plugin's accepted commands (it was uninstalled). */
export function forgetDeclaredCommandConsents(pluginId: string): void {
  const file = readConsentFile()
  if (!file.consents[pluginId]) return
  delete file.consents[pluginId]
  writeConsentFile(file)
}

/** How a run was started: a user's install/update, or a later run. */
export type DeclaredCommandRun = 'install' | 'later'

/**
 * Throw unless this command may run now. Messages tell the user what to do,
 * since they surface in the shell, in /plugin and in the Errors tab.
 */
export function assertDeclaredCommandMayRun(
  declared: DeclaredCommand,
  run: DeclaredCommandRun,
): void {
  const block = getDeclaredCommandPolicyBlock()
  if (block) {
    throw new Error(
      declared.kind === 'command-source'
        ? `Command-sourced plugins are disabled by your settings (${block}). The plugin was not installed or updated and its command was not run.`
        : `Plugin "${declared.pluginId}" fetches its archive through a headersHelper command, and your settings disable marketplace-declared commands (${block}). The command was not run.`,
    )
  }
  if (run === 'install') {
    if (freshConsents.has(consentKey(declared))) return
    throw new Error(
      `Plugin "${declared.pluginId}" runs a command from its marketplace. ` +
        `Install or update it on its own from your shell to review the command first: tau plugin install ${declared.pluginId}`,
    )
  }
  if (!hasStoredConsent(declared)) {
    throw new Error(
      `The command for "${declared.pluginId}" changed in its marketplace and was not run. ` +
        `Review it with: tau plugin update ${declared.pluginId}`,
    )
  }
}
