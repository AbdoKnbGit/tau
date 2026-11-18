/**
 * Asking in the shell before `tau plugin install` / `tau plugin update` runs
 * a command the plugin's marketplace declares (a `command` source, or an
 * archive entry's `headersHelper`). The user sees the exact command and its
 * SHA-256 and accepts it at a y/N prompt, with --yes, or with
 * --accept-command <sha256> for exactly the command a script reviewed.
 */
import { createInterface } from 'readline'
import { isatty } from 'tty'
import {
  assertDeclaredCommandMayRun,
  declaredCommandSha256,
  describeDeclaredCommand,
  getDeclaredCommand,
  getDeclaredCommandPolicyBlock,
  grantDeclaredCommandConsent,
} from '../../utils/plugins/commandConsent.js'
import { loadInstalledPluginsV2 } from '../../utils/plugins/installedPluginsManager.js'
import {
  getMarketplace,
  getPluginByIdCacheOnly,
  loadKnownMarketplacesConfig,
  refreshMarketplace,
} from '../../utils/plugins/marketplaceManager.js'
import { parsePluginIdentifier } from '../../utils/plugins/pluginIdentifier.js'
import type { PluginMarketplaceEntry } from '../../utils/plugins/schemas.js'
import { cliError } from '../exit.js'

export type CommandConsentOptions = {
  yes?: boolean
  acceptCommand?: string
}

/** The marketplace entry `plugin` names: `name@marketplace`, or a bare name. */
async function findEntry(
  plugin: string,
): Promise<{ pluginId: string; entry: PluginMarketplaceEntry } | undefined> {
  const { name, marketplace } = parsePluginIdentifier(plugin)
  if (!name) return undefined
  const candidates: string[] = []
  if (marketplace) {
    candidates.push(`${name}@${marketplace}`)
  } else {
    // A bare name: an installed plugin of that name, then any marketplace.
    for (const id of Object.keys(loadInstalledPluginsV2().plugins)) {
      if (parsePluginIdentifier(id).name === name) candidates.push(id)
    }
    try {
      for (const known of Object.keys(await loadKnownMarketplacesConfig())) {
        candidates.push(`${name}@${known}`)
      }
    } catch {
      // No marketplaces configured: nothing more to try.
    }
  }
  for (const pluginId of candidates) {
    const found = await getPluginByIdCacheOnly(pluginId)
    if (found) return { pluginId, entry: found.entry }
  }
  return undefined
}

async function ask(question: string): Promise<string> {
  const prompt = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return await new Promise<string>(resolve => {
      prompt.once('close', () => resolve(''))
      prompt.question(question, resolve)
    })
  } finally {
    prompt.close()
  }
}

/**
 * Before an install or update, ask the user to accept the command the
 * plugin's marketplace declares, if it declares one. Exits the CLI when the
 * command is not accepted; does nothing for a plugin that declares none.
 */
export async function confirmDeclaredCommand(
  plugin: string,
  options: CommandConsentOptions,
): Promise<void> {
  let found = await findEntry(plugin)
  if (!found || !getDeclaredCommand(found.pluginId, found.entry)) return

  // Show the command from a current catalog, so the one accepted is the one
  // the install or update is going to see.
  const { marketplace } = parsePluginIdentifier(found.pluginId)
  if (marketplace) {
    try {
      await refreshMarketplace(marketplace, undefined, { skipIfRecent: true })
      const entry = (await getMarketplace(marketplace)).plugins.find(
        p => p.name === found!.entry.name,
      )
      if (entry) found = { pluginId: found.pluginId, entry }
    } catch {
      // Offline or unreadable: the cached catalog is what will be used.
    }
  }

  const declared = getDeclaredCommand(found.pluginId, found.entry)
  if (!declared) return
  const block = getDeclaredCommandPolicyBlock()
  if (block) {
    // Throws with the policy message; nothing is shown or asked.
    try {
      assertDeclaredCommandMayRun(declared, 'install')
    } catch (error) {
      cliError((error as Error).message)
    }
  }

  const sha256 = declaredCommandSha256(declared)
  // biome-ignore lint/suspicious/noConsole: the user reviews this command
  console.log(`${describeDeclaredCommand(declared).join('\n')}\nSHA-256: ${sha256}\n`)

  if (options.acceptCommand !== undefined) {
    if (options.acceptCommand.trim().toLowerCase() !== sha256) {
      cliError(
        `The command shown has SHA-256 ${sha256}, not ${options.acceptCommand}. ` +
          `Nothing was run. Review it, then pass --accept-command ${sha256} to accept it.`,
      )
    }
  } else if (!options.yes) {
    // The OS answer for the real descriptors: a pipe a session marked as a
    // terminal must refuse, not wait forever for an answer.
    if (!process.stdin.isTTY || !process.stdout.isTTY || !isatty(0) || !isatty(1)) {
      cliError(
        'This command needs your approval, and there is no terminal to ask in. ' +
          `Re-run with --yes to accept it, or with --accept-command ${sha256} to accept exactly this command.`,
      )
    }
    const answer = await ask('Run this command? [y/N] ')
    if (!/^y(es)?$/i.test(answer.trim())) {
      cliError('Command not accepted. Nothing was installed or updated.')
    }
  }
  grantDeclaredCommandConsent(declared)
}
