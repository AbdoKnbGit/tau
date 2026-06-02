import { execFile, execFileSync } from 'child_process'
import { accessSync, constants as fsConstants } from 'fs'
import { errorMessage } from '../../utils/errors.js'
import { getPlatform } from '../../utils/platform.js'
import { which } from '../../utils/which.js'
import { findGitBashPath } from '../../utils/windowsPaths.js'
import { analyzeNativeShellCommand, type NativeShellAnalysis } from './nativeShellParser.js'

const SYNTAX_CHECK_TIMEOUT_MS = 2_000
const MAX_DIAGNOSTIC_LENGTH = 2_000

export type BashSyntaxValidationResult =
  | { ok: true }
  | { ok: false; message: string; diagnostic: string }

type ExecFileError = Error & {
  code?: number | string
  stdout?: string | Buffer
  stderr?: string | Buffer
  killed?: boolean
  signal?: NodeJS.Signals | string
}

function toText(value: string | Buffer | undefined): string {
  if (value === undefined) return ''
  return Buffer.isBuffer(value) ? value.toString('utf8') : value
}

function cleanDiagnostic(stdout: string, stderr: string): string {
  const diagnostic = [stderr, stdout]
    .map(part => part.replace(/\r\n/g, '\n').trim())
    .filter(Boolean)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  if (!diagnostic) return 'The shell parser rejected the command.'
  if (diagnostic.length <= MAX_DIAGNOSTIC_LENGTH) return diagnostic
  return `${diagnostic.slice(0, MAX_DIAGNOSTIC_LENGTH).trimEnd()}\n...`
}

function formatNativeDiagnostic(analysis: NativeShellAnalysis | null): string | null {
  if (!analysis || analysis.ok) return null
  const diagnostics = analysis.diagnostics ?? []
  if (diagnostics.length === 0) return `${analysis.parser} rejected the command.`
  return diagnostics
    .map(item => {
      const location = item.line || item.column
        ? ` at ${item.line ?? '?'}:${item.column ?? '?'}`
        : ''
      return `${analysis.parser}${location}: ${item.message}`
    })
    .join('\n')
}

function isSupportedShellPath(shellPath: string | undefined): shellPath is string {
  return !!shellPath && /(?:^|[\\/])(bash|zsh)(?:\.exe)?$/i.test(shellPath)
}

function isExecutable(shellPath: string): boolean {
  try {
    accessSync(shellPath, fsConstants.X_OK)
    return true
  } catch {
    try {
      execFileSync(shellPath, ['--version'], {
        timeout: 1_000,
        stdio: 'ignore',
        windowsHide: true,
      })
      return true
    } catch {
      return false
    }
  }
}

async function findSyntaxCheckShell(): Promise<string | null> {
  const shellOverride = process.env.CLAUDE_CODE_SHELL
  if (isSupportedShellPath(shellOverride) && isExecutable(shellOverride)) {
    return shellOverride
  }

  if (getPlatform() === 'windows') {
    return findGitBashPath()
  }

  const envShell = process.env.SHELL
  if (isSupportedShellPath(envShell) && isExecutable(envShell)) {
    return envShell
  }

  const preferBash = envShell?.includes('bash') ?? false
  const discoveredBash = await which('bash')
  const discoveredZsh = await which('zsh')
  const bashCandidates = [
    discoveredBash,
    '/bin/bash',
    '/usr/bin/bash',
    '/usr/local/bin/bash',
  ]
  const zshCandidates = [
    discoveredZsh,
    '/bin/zsh',
    '/usr/bin/zsh',
    '/usr/local/bin/zsh',
  ]
  const candidates = preferBash
    ? [...bashCandidates, ...zshCandidates]
    : [...zshCandidates, ...bashCandidates]

  for (const candidate of candidates) {
    if (isSupportedShellPath(candidate) && isExecutable(candidate)) {
      return candidate
    }
  }

  return null
}

export function getBashSyntaxCorrectionHints(
  command: string,
  diagnostic: string,
): string[] {
  const hints: string[] = []
  const lowerDiagnostic = diagnostic.toLowerCase()

  if (
    lowerDiagnostic.includes('unexpected eof') ||
    lowerDiagnostic.includes('unexpected end of file') ||
    lowerDiagnostic.includes('here-document') ||
    lowerDiagnostic.includes('wanted')
  ) {
    hints.push(
      'Close any open quote, parenthesis, brace, command substitution, or heredoc terminator.',
    )
  }

  if (
    lowerDiagnostic.includes('syntax error near unexpected token') ||
    /\b(if|then|else|elif|fi|for|while|until|do|done|case|esac)\b/.test(
      command,
    )
  ) {
    hints.push(
      'Check shell control-flow structure: if needs then/fi, loops need do/done, and case needs esac.',
    )
  }

  if (command.includes('\r')) {
    hints.push('Remove Windows CR characters from the command string.')
  }

  if (
    /\b(Get-ChildItem|Select-String|Where-Object|ForEach-Object|Remove-Item|Set-Content|New-Item)\b/.test(
      command,
    ) ||
    /\$env:[A-Za-z_][A-Za-z0-9_]*/.test(command)
  ) {
    hints.push(
      'This looks like PowerShell syntax. Use the PowerShell tool, or rewrite it as POSIX/Bash syntax.',
    )
  }

  if (hints.length === 0) {
    hints.push(
      'Retry with one valid POSIX/Bash command. Keep quoting and command separators minimal.',
    )
  }

  return [...new Set(hints)]
}

export function formatBashSyntaxValidationError(
  command: string,
  diagnostic: string,
): string {
  const hints = getBashSyntaxCorrectionHints(command, diagnostic)
  return [
    'Bash syntax validation failed before execution.',
    '',
    'Reason:',
    diagnostic,
    '',
    'Correction guidance:',
    ...hints.map(hint => `- ${hint}`),
    '',
    'The command was not executed. Correct the syntax and retry.',
  ].join('\n')
}

async function runNoExecSyntaxCheck(
  shellPath: string,
  command: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    execFile(
      shellPath,
      ['-n', '-c', command],
      {
        timeout: SYNTAX_CHECK_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 128 * 1024,
      },
      (error, stdout, stderr) => {
        const err = error as ExecFileError | null
        const fallbackError =
          err?.killed || err?.signal
            ? `Syntax validation timed out after ${SYNTAX_CHECK_TIMEOUT_MS}ms`
            : err
              ? errorMessage(err)
              : ''
        resolve({
          code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
          stdout: toText(err?.stdout) || toText(stdout),
          stderr: toText(err?.stderr) || toText(stderr) || fallbackError,
        })
      },
    )
  })
}

export async function validateBashSyntax(
  command: string,
): Promise<BashSyntaxValidationResult> {
  if (command.trim() === '') return { ok: true }

  const nativeAnalysis = await analyzeNativeShellCommand(command)
  const nativeDiagnostic = formatNativeDiagnostic(nativeAnalysis)

  let shellPath: string
  try {
    const syntaxShellPath = await findSyntaxCheckShell()
    if (!syntaxShellPath) {
      if (nativeDiagnostic) {
        return {
          ok: false,
          diagnostic: nativeDiagnostic,
          message: formatBashSyntaxValidationError(command, nativeDiagnostic),
        }
      }
      return { ok: true }
    }
    shellPath = syntaxShellPath
  } catch {
    // If shell discovery itself fails, let the normal execution path report
    // the environment problem rather than blocking at syntax validation.
    if (nativeDiagnostic) {
      return {
        ok: false,
        diagnostic: nativeDiagnostic,
        message: formatBashSyntaxValidationError(command, nativeDiagnostic),
      }
    }
    return { ok: true }
  }

  let result: { code: number; stdout: string; stderr: string }
  try {
    result = await runNoExecSyntaxCheck(shellPath, command)
  } catch (error) {
    return {
      ok: false,
      diagnostic: errorMessage(error),
      message: formatBashSyntaxValidationError(command, errorMessage(error)),
    }
  }

  if (result.code === 0) return { ok: true }

  const shellDiagnostic = cleanDiagnostic(result.stdout, result.stderr)
  const diagnostic = nativeDiagnostic
    ? `${shellDiagnostic}\n\nNative parser:\n${nativeDiagnostic}`
    : shellDiagnostic
  return {
    ok: false,
    diagnostic,
    message: formatBashSyntaxValidationError(command, diagnostic),
  }
}
