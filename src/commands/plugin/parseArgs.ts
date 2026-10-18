// Parse plugin subcommand arguments into structured commands
export type ParsedCommand =
  | { type: 'menu' }
  | { type: 'help' }
  | { type: 'error'; message: string }
  | { type: 'install'; marketplace?: string; plugin?: string }
  | { type: 'manage' }
  | { type: 'uninstall'; plugin?: string }
  | { type: 'enable'; plugin?: string }
  | { type: 'disable'; plugin?: string }
  | { type: 'validate'; path?: string }
  | {
      type: 'marketplace'
      action?: 'add' | 'remove' | 'update' | 'list'
      target?: string
    }

// Command arguments are not shell code. Preserve backslashes, URL fragments
// and variables literally, while allowing quoted paths containing spaces.
function tokenizePluginArgs(args: string): string[] | null {
  const tokens: string[] = []
  let token = ''
  let quote: string | undefined
  let started = false
  for (const char of args.trim()) {
    if (quote) {
      if (char === quote) quote = undefined
      else token += char
    } else if (char === '"' || char === "'") {
      quote = char
      started = true
    } else if (/\s/.test(char)) {
      if (started) tokens.push(token)
      token = ''
      started = false
    } else {
      token += char
      started = true
    }
  }
  if (quote) return null
  if (started) tokens.push(token)
  return tokens
}

export function parsePluginArgs(args?: string): ParsedCommand {
  if (!args) {
    return { type: 'menu' }
  }

  const parts = tokenizePluginArgs(args)
  if (!parts) return { type: 'error', message: 'Unclosed quote in plugin arguments' }
  const command = parts[0]?.toLowerCase()

  switch (command) {
    case 'help':
    case '--help':
    case '-h':
      return { type: 'help' }

    case 'install':
    case 'i': {
      let target: string | undefined
      let source: string | undefined
      for (let i = 1; i < parts.length; i++) {
        const part = parts[i]!
        if (part === '--marketplace' || part.startsWith('--marketplace=')) {
          const value = part === '--marketplace'
            ? parts[++i]
            : part.slice('--marketplace='.length)
          if (!value || value.startsWith('-')) {
            return { type: 'error', message: '--marketplace requires a marketplace name or source' }
          }
          if (source !== undefined) return { type: 'error', message: 'Specify --marketplace only once' }
          source = value
        } else if (part.startsWith('-')) {
          return { type: 'error', message: `Unknown plugin install option: ${part}` }
        } else if (target !== undefined) {
          return { type: 'error', message: `Unexpected plugin install argument: ${part}` }
        } else {
          target = part
        }
      }
      if (source) {
        if (!target) return { type: 'error', message: 'Specify a plugin to install with --marketplace' }
        const [plugin, marketplace] = target.split('@')
        if (!plugin) return { type: 'error', message: 'Specify a plugin name before @marketplace' }
        if (marketplace && marketplace !== source) {
          return { type: 'error', message: 'The plugin marketplace and --marketplace must agree' }
        }
        return { type: 'install', plugin, marketplace: source }
      }
      if (!target) {
        return { type: 'install' }
      }

      // Check if the target looks like a marketplace (URL or path)
      const isMarketplace =
        target.startsWith('http://') ||
        target.startsWith('https://') ||
        target.startsWith('file://') ||
        target.includes('/') ||
        target.includes('\\')

      if (isMarketplace) {
        // This is a marketplace URL/path, no plugin specified
        return { type: 'install', marketplace: target }
      }

      // Check after source detection so SSH URLs and owner/repo@ref survive.
      if (target.includes('@')) {
        const [plugin, marketplace] = target.split('@')
        if (!plugin || !marketplace) return { type: 'error', message: 'Use plugin@marketplace with both names specified' }
        return { type: 'install', plugin, marketplace }
      }

      // Otherwise treat it as a plugin name
      return { type: 'install', plugin: target }
    }

    case 'manage':
      return { type: 'manage' }

    case 'uninstall':
      return { type: 'uninstall', plugin: parts[1] }

    case 'enable':
      return { type: 'enable', plugin: parts[1] }

    case 'disable':
      return { type: 'disable', plugin: parts[1] }

    case 'validate': {
      const target = parts.slice(1).join(' ').trim()
      return { type: 'validate', path: target || undefined }
    }

    case 'marketplace':
    case 'market': {
      const action = parts[1]?.toLowerCase()
      const target = parts.slice(2).join(' ')

      switch (action) {
        case 'add':
          return { type: 'marketplace', action: 'add', target }
        case 'remove':
        case 'rm':
          return { type: 'marketplace', action: 'remove', target }
        case 'update':
          return { type: 'marketplace', action: 'update', target }
        case 'list':
          return { type: 'marketplace', action: 'list' }
        default:
          // No action specified, show marketplace menu
          return { type: 'marketplace' }
      }
    }

    default:
      // Unknown command, show menu
      return { type: 'menu' }
  }
}
