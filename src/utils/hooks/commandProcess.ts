import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'child_process'
import { stat } from 'fs/promises'
import { getErrnoCode } from '../errors.js'
import { buildPowerShellArgs } from '../shell/powershellProvider.js'
import { execa } from 'execa'

/** Hook stdin/stdout is UTF-8 JSON, including under Windows PowerShell 5.1. */
export async function powerShellHookArgs(
  shell: string,
  command: string,
  options: { cwd: string; env: NodeJS.ProcessEnv; signal: AbortSignal; timeout: number },
): Promise<string[]> {
  const setup = '[Console]::InputEncoding = [Console]::OutputEncoding = $OutputEncoding = [System.Text.UTF8Encoding]::new($false);\n'
  let offset = 0
  let begin = false
  // A statement before param/using or a named block changes valid PowerShell
  // syntax. For those commands, ask its parser for the insertion point. Do not
  // wrap the command in a scriptblock: that loses the automatic $input stream.
  if (/\b(?:using|param|begin|process|end|clean)\b/i.test(command)) {
    const encoded = Buffer.from(command, 'utf8').toString('base64')
    const parse = `$source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'));
$tokens = $null; $errors = $null;
$ast = [System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors);
if ($errors.Count) { exit 1 };
$offset = 0; $begin = $false;
if ($ast.ParamBlock) { $offset = $ast.ParamBlock.Extent.EndOffset };
foreach ($using in $ast.UsingStatements) { $offset = [Math]::Max($offset, $using.Extent.EndOffset) };
if ($ast.BeginBlock) { $start = $ast.BeginBlock.Extent.StartOffset; $opening = $tokens | Where-Object { $_.Kind -eq 'LCurly' -and $_.Extent.StartOffset -ge $start } | Select-Object -First 1; $offset = $opening.Extent.EndOffset }
elseif ($ast.ProcessBlock -or $ast.CleanBlock -or ($ast.EndBlock -and -not $ast.EndBlock.Unnamed)) { $begin = $true };
@{offset = $offset; begin = $begin} | ConvertTo-Json -Compress`
    const result = await execa(shell, buildPowerShellArgs(parse), {
      cwd: options.cwd, env: options.env, cancelSignal: options.signal,
      timeout: Math.min(options.timeout, 5000), windowsHide: true,
      input: '', reject: false,
    })
    options.signal.throwIfAborted()
    // Preserve the original shell diagnosis for malformed source or unavailable
    // parser features. This process only parses text; it never runs the hook.
    if (result.exitCode !== 0) return buildPowerShellArgs(command)
    try {
      const parsed = JSON.parse(result.stdout)
      if (!Number.isInteger(parsed.offset) || parsed.offset < 0 || parsed.offset > command.length || typeof parsed.begin !== 'boolean') {
        return buildPowerShellArgs(command)
      }
      offset = parsed.offset
      begin = parsed.begin
    } catch { return buildPowerShellArgs(command) }
  }
  return buildPowerShellArgs(command.slice(0, offset) + '\n' +
    (begin ? `begin { ${setup} }\n` : setup) + command.slice(offset))
}

export async function isHookDirectory(path: string): Promise<boolean> {
  try { return (await stat(path)).isDirectory() } catch { return false }
}

export async function hookWorkingDirectory(current: string, original: string): Promise<string> {
  if (await isHookDirectory(current)) return current
  if (current !== original && await isHookDirectory(original)) return original
  throw new Error(`Hook working directory is unavailable: ${current}` +
    (original !== current ? ` (original directory: ${original})` : ''))
}

/** Only a script in command position needs the Windows Git Bash accommodation. */
export function prepareWindowsHookScript(command: string): string {
  return /^\s*(?:"[^"\n]+\.sh"|'[^'\n]+\.sh'|[^\s"';&|<>]+\.sh)(?=\s|$)/.test(command)
    ? `bash ${command}` : command
}

/** Await spawn before transferring ownership to the background hook registry. */
export function startHookProcess(
  command: string,
  args: string[],
  options: SpawnOptionsWithoutStdio & { cwd: string },
  signal?: AbortSignal,
): Promise<ChildProcessWithoutNullStreams> {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const fail = (error: unknown) => {
      const code = getErrnoCode(error) ?? 'spawn error'
      const executable = typeof options.shell === 'string' ? options.shell
        : options.shell ? '/bin/sh' : command
      const hint = code === 'ENOENT'
        ? 'Check the executable or script interpreter, PATH, and working directory.'
        : code === 'EACCES' || code === 'EPERM'
          ? 'Check executable and directory permissions.'
          : process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)
            ? 'Batch scripts require an explicit cmd.exe or PowerShell command.'
            : 'Check the executable and arguments in the hook configuration.'
      // Do not include argv, stdin or the environment: these can contain secrets.
      reject(new Error(`Unable to start hook executable ${JSON.stringify(executable)} (${code}). Working directory: ${options.cwd}. ${hint}`, { cause: error }))
    }
    try {
      const child = spawn(command, args, options) as ChildProcessWithoutNullStreams
      // Fast exits may close stdin before even the first write drains. Install
      // this before any write, including config-based async hooks. Process exit
      // and stderr remain authoritative; a closed pipe must not crash Tau.
      child.stdin.on('error', () => {})
      child.once('error', fail)
      child.once('spawn', () => {
        if (signal?.aborted) {
          child.kill()
          child.stdin.destroy()
          child.stdout.destroy()
          child.stderr.destroy()
          reject(signal.reason)
        } else resolve(child)
      })
    } catch (error) { fail(error) }
  })
}
