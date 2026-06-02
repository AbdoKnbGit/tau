export type BashCommandFlagScalar = string | number | boolean
export type BashCommandFlagValue = BashCommandFlagScalar | BashCommandFlagScalar[]

export type BashCommandFlagPart = {
  name: string
  value?: BashCommandFlagValue
  style?: 'space' | 'equals' | 'boolean'
}

export type BashCommandToken =
  | {
      kind: 'arg'
      value: string
    }
  | ({
      kind: 'flag'
    } & BashCommandFlagPart)
  | {
      kind: 'separator'
    }

export type BashCommandParts = {
  executable: string
  tokens?: BashCommandToken[]
  subcommands?: string[]
  flags?: BashCommandFlagPart[]
  positionals?: string[]
  trailing_args?: string[]
}

export type CompiledBashCommand = {
  command: string
  argv: string[]
}

export type BashCommandPartsMatch = {
  ok: boolean
  compiledCommand: string
  message?: string
}

function quoteBashArg(value: string): string {
  if (value.length === 0) return "''"
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function normalizeFlagName(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) {
    throw new Error('Command flag name cannot be empty.')
  }
  if (/[\s;&|<>`$(){}[\]"']/.test(trimmed)) {
    throw new Error(`Command flag name contains shell syntax: ${name}`)
  }
  if (trimmed.startsWith('--') || trimmed.startsWith('-')) return trimmed
  return trimmed.length === 1 ? `-${trimmed}` : `--${trimmed}`
}

function normalizeBarePart(value: string, label: string): string {
  const trimmed = value.trim()
  if (!trimmed) {
    throw new Error(`${label} cannot be empty.`)
  }
  return trimmed
}

function expandFlag(flag: BashCommandFlagPart): string[] {
  const name = normalizeFlagName(flag.name)
  const value = flag.value
  const style = flag.style ?? 'space'

  if (style === 'boolean' || value === undefined || value === true) {
    return value === false ? [] : [name]
  }

  const values = Array.isArray(value) ? value : [value]
  const out: string[] = []

  for (const item of values) {
    if (item === false) continue
    if (item === true) {
      out.push(name)
      continue
    }
    const renderedValue = quoteBashArg(String(item))
    if (style === 'equals') {
      out.push(`${name}=${renderedValue}`)
    } else {
      out.push(name, renderedValue)
    }
  }

  return out
}

export function compileBashCommandParts(parts: BashCommandParts): CompiledBashCommand {
  const executable = normalizeBarePart(parts.executable, 'Command executable')
  const argv: string[] = [quoteBashArg(executable)]

  if (parts.tokens && parts.tokens.length > 0) {
    for (const token of parts.tokens) {
      if (token.kind === 'arg') {
        argv.push(quoteBashArg(token.value))
      } else if (token.kind === 'flag') {
        argv.push(...expandFlag(token))
      } else {
        argv.push('--')
      }
    }
  } else {
    for (const subcommand of parts.subcommands ?? []) {
      argv.push(quoteBashArg(normalizeBarePart(subcommand, 'Command subcommand')))
    }

    for (const flag of parts.flags ?? []) {
      argv.push(...expandFlag(flag))
    }

    for (const positional of parts.positionals ?? []) {
      argv.push(quoteBashArg(positional))
    }
  }

  const trailing = parts.trailing_args ?? []
  if (trailing.length > 0) {
    argv.push('--')
    for (const item of trailing) {
      argv.push(quoteBashArg(item))
    }
  }

  return {
    command: argv.join(' '),
    argv,
  }
}

export function validateBashCommandPartsMatch(
  command: string,
  parts: BashCommandParts | undefined,
): BashCommandPartsMatch | null {
  if (!parts) return null

  const compiled = compileBashCommandParts(parts)
  if (command.trim() === compiled.command) {
    return {
      ok: true,
      compiledCommand: compiled.command,
    }
  }

  return {
    ok: false,
    compiledCommand: compiled.command,
    message: [
      'Blocked: command does not match the structured Bash command parts.',
      '',
      'Compiled command:',
      compiled.command,
      '',
      'Use the compiled command exactly, or remove command_parts if you are intentionally writing raw Bash.',
    ].join('\n'),
  }
}
