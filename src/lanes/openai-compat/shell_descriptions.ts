/**
 * Compact, example-driven shell-tool descriptions for the OpenAI-compat
 * lane.
 *
 * The frontier-tier Bash/PowerShell descriptions (in tools/BashTool/prompt.ts
 * and tools/PowerShellTool/prompt.ts) are long-form rule lists. They work
 * for Claude / Codex / Gemini-2.5 / GPT-5, but weak models on the compat
 * lane (DeepSeek, GLM, Moonshot, MiniMax, Groq, OpenRouter long-tail,
 * Ollama, LM Studio) drown in the volume and emit wrong-shell syntax —
 * PowerShell idioms in a bash command, missing quotes around paths with
 * spaces, relying on cwd-changing prefixes instead of absolute paths/native
 * location flags, here-strings indented
 * past column 0, etc.
 *
 * This module emits ~25-40 line descriptions per shell with concrete
 * good/bad pairs. The mental model is: a small model can imitate
 * patterns much better than it can derive correct syntax from rules.
 *
 * Cache-stability invariant: the output of these functions must be
 * deterministic given (toolName, platform, psEdition). Do not include
 * homedir / tmpdir / session id / timestamps — the compat lane caches
 * tool descriptions per session and any per-call data would churn the
 * upstream prompt-cache prefix every turn.
 */

import type { POSIXShellEdition } from './shell_descriptions_types.js'

export interface CompatShellDescriptionCtx {
  platform: NodeJS.Platform
  psEdition: POSIXShellEdition | null
}

/**
 * Returns a compact description for the named shell tool, or undefined
 * when the tool isn't a known shell tool (caller falls back to the
 * tool's original description).
 */
export function getCompatShellDescription(
  toolName: string,
  ctx: CompatShellDescriptionCtx,
): string | undefined {
  if (toolName === 'Bash') return buildBashDescription(ctx)
  if (toolName === 'PowerShell') return buildPowerShellDescription(ctx)
  return undefined
}

// ─── Bash ─────────────────────────────────────────────────────────

function buildBashDescription(ctx: CompatShellDescriptionCtx): string {
  const isWindows = ctx.platform === 'win32'
  const windowsNote = isWindows
    ? `On Windows this tool runs in Git Bash. Use POSIX paths (\`/c/Users/...\`) — NOT Windows paths (\`C:\\Users\\...\`). Backslashes are escape characters in bash so \`\\U\`, \`\\n\`, \`\\t\` get interpreted instead of passed through literally. Use \`2>/dev/null\`, never \`2>nul\` (writing to \`nul\` creates a literal file that breaks git).`
    : 'POSIX paths only; backslashes are escapes in bash.'

  return [
    'Run a bash command and return its output. Use this for git, npm, build/test runners, package managers, and any other terminal-driven workflow.',
    '',
    'DO NOT use this for file ops — call the dedicated tools:',
    '- Read files → Read tool (NOT `cat` / `head` / `tail`).',
    '- Search filenames → Glob tool (NOT `find` / `ls -R`).',
    '- Search file contents → Grep tool (NOT `grep` / `rg`).',
    '- Edit files → Edit / Write tools (NOT `sed` / `awk` / `echo >`).',
    '',
    'Required: `command`. Optional: `description` (one short active-voice phrase), `timeout` (milliseconds), `run_in_background` (boolean).',
    'For long-running servers, watchers, port-forwards, tunnels, or foreground container runs, set `run_in_background: true`. Do NOT put `&`, `nohup`, `disown`, `echo $!`, `docker compose up -d`, or `docker run -d` in `command`; keep log redirection if needed and let the tool track/stop the process.',
    'Examples: Good command `uvicorn app:app --host 0.0.0.0 > "$TMPDIR/app.log" 2>&1` or `docker compose up` with `run_in_background: true`; bad command `npm run dev > /tmp/app.log 2>&1 & echo $!`.',
    'When targeting another directory, put the absolute path in the command or use the CLI native location flag. Trust `[Ran in /path …]` notes over memory of earlier directory changes.',
    '',
    'Examples — good vs bad:',
    '- Good: `git -C /repo status` · Bad: `cd /repo && git status`.',
    '- Good: `npm --prefix /repo/app run build` · Good: `docker compose -f /repo/compose.yaml up -d`.',
    '- Good: `cat "path with spaces/file.txt"` · Bad: `cat path with spaces/file.txt` (the unquoted path is parsed as four args).',
    '- Good: `git add . && git commit -m "fix"` · Bad: `git add .\\ngit commit -m "fix"` (do not use newlines to separate commands; use `&&` to chain).',
    '- Good: `git commit -m "$(cat <<\'EOF\'\nMultiline\nmessage\nEOF\n)"` · Bad: passing a multi-line message via interpolated double-quoted string (variables and backticks expand).',
    '',
    'Chaining: `&&` runs the next command only if the previous one succeeded; `;` runs it regardless. Independent commands belong in parallel tool calls in the SAME assistant message, not chained.',
    '',
    'When a command fails, read the exit code and stderr before retrying. Don\'t iterate on cosmetic variants of the same call — diagnose first. After two same-cause failures stop and investigate.',
    '',
    windowsNote,
  ].join('\n')
}

// ─── PowerShell ───────────────────────────────────────────────────

function buildPowerShellDescription(ctx: CompatShellDescriptionCtx): string {
  const edition = ctx.psEdition
  const chainLine =
    edition === 'core'
      ? '- Chain operators: `&&` and `||` ARE available (PowerShell 7+); prefer them when later commands should only run on success.'
      : '- Chain operators: `&&` and `||` are NOT available in Windows PowerShell 5.1 (parser error). To chain on success use `A; if ($?) { B }`. To chain unconditionally use `A; B`.'

  const editionNotes =
    edition === 'core'
      ? '- Edition: PowerShell 7+ (pwsh). UTF-8 default encoding. Ternary `$c ? $a : $b`, null-coalescing `??`, and null-conditional `?.` are available.'
      : edition === 'desktop'
        ? '- Edition: Windows PowerShell 5.1 (powershell.exe). Default file encoding is UTF-16 LE with BOM — pass `-Encoding utf8` to `Out-File` / `Set-Content` when other tools will read the file. Ternary `?:`, null-coalescing `??`, and null-conditional `?.` are NOT available — use `if/else` and explicit `$null -eq` checks.'
        : '- Edition: not yet resolved. Assume Windows PowerShell 5.1 syntax for compatibility (no `&&`, no ternary, no `??`, no `?.`).'

  return [
    'Run a PowerShell command and return its output. Use this for git, npm, build/test runners, and PowerShell cmdlets on Windows.',
    '',
    'DO NOT use this for file ops — call the dedicated tools:',
    '- Read files → Read tool (NOT `Get-Content`).',
    '- Search filenames → Glob tool (NOT `Get-ChildItem -Recurse`).',
    '- Search file contents → Grep tool (NOT `Select-String`).',
    '- Edit/write files → Edit / Write tools (NOT `Set-Content` / `Out-File`).',
    '',
    'Required: `command`. Optional: `description`, `timeout` (milliseconds).',
    'When targeting another directory, put the absolute path in the command or use the CLI native location flag. Trust `[Ran in C:\\path …]` notes over memory of earlier directory changes.',
    '',
    'PowerShell syntax (re-read before each call):',
    editionNotes,
    chainLine,
    '- Variables: `$myVar = "value"`. Escape character is backtick (`), NOT backslash.',
    '- Cmdlet naming: prefer full Verb-Noun (`Get-ChildItem`, `Remove-Item`) over aliases (`ls`, `rm`).',
    '- Environment vars: read with `$env:NAME`, set with `$env:NAME = "value"` (NOT `export`, NOT `Set-Variable`).',
    '- Native exe with spaces in path: use the call operator `& "C:\\Program Files\\app\\app.exe" arg1`.',
    '- Multi-line strings to native exes: use a single-quoted here-string and the closing `\'@` MUST be at column 0 (no indent — that\'s a parser error):',
    '',
    '<example>',
    'git commit -m @\'',
    'Commit subject.',
    'Body line.',
    '\'@',
    '</example>',
    '',
    'Examples — good vs bad:',
    '- Good: `Get-ChildItem -LiteralPath "C:\\Path With Spaces"` · Bad: `Get-ChildItem -LiteralPath C:\\Path With Spaces` (path splits at the space).',
    '- Good: `git -C "C:\\repo" status` · Good: `npm --prefix "C:\\repo\\app" run build`.',
    edition === 'core'
      ? '- Good: `npm install && npm test` · Bad: `npm install; npm test` (the `;` runs the second even on failure).'
      : '- Good: `npm install; if ($?) { npm test }` · Bad: `npm install && npm test` (`&&` is a parser error on 5.1).',
    '- Good: `Remove-Item -Recurse -Force -Confirm:$false "$tmp"` · Bad: `Remove-Item -Recurse "$tmp"` (cmdlet will prompt; this tool is non-interactive and the prompt hangs).',
    '',
    'Never use interactive cmdlets — they hang under `-NonInteractive`: `Read-Host`, `Get-Credential`, `Out-GridView`, `pause`, `git rebase -i`, `git add -i`. For destructive cmdlets pass `-Confirm:$false`. Use `-Force` only for read-only/hidden items.',
    '',
    'When a command fails, read the exit code and stderr before retrying. Don\'t iterate on cosmetic variants — diagnose first. After two same-cause failures stop and investigate.',
  ].join('\n')
}
