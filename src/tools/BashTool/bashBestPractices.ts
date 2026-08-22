import { getPlatform, type Platform } from '../../utils/platform.js'

export function getBashPlatformBestPractices(
  platform: Platform = getPlatform(),
): string[] {
  switch (platform) {
    case 'windows':
      return [
        'This is Git Bash: use `/c/path` or `C:/path`, `/dev/null`, and `$TMPDIR`; never use backslash paths or Windows reserved null names such as `NUL`.',
        'If a script reports `\\r` errors, normalize CRLF to LF. Check `command --help` before assuming GNU flags.',
        'MSYS can rewrite remote POSIX paths at native process boundaries. Tau protects common static container/SSH/Kubernetes arguments; for dynamic paths use a narrow `MSYS2_ARG_CONV_EXCL`, and put remote globs/pipes/redirections in one quoted remote `sh -c` command.',
      ]
    case 'wsl':
      return [
        'Use `/home/...` for WSL files, `/mnt/c/...` for Windows files, and `/dev/null`; do not pass `C:\\...` to Linux tools.',
        'Convert paths with `wslpath` only when invoking a Windows executable. Keep Linux build trees in WSL when they need symlinks, executable bits, case sensitivity, or speed.',
      ]
    case 'macos':
      return [
        'Use `/Users/...` and `/dev/null`. macOS utilities are BSD: do not assume GNU flags, GNU `sed -i`, or `readlink -f`.',
        'System Bash may be 3.x; use portable syntax and explicit checks for important operations.',
      ]
    case 'linux':
      return [
        'Use Linux paths such as `/home/...` and `/dev/null`. Check installed versions before relying on optional GNU-only behavior.',
      ]
    default:
      return [
        'Use POSIX paths and `/dev/null` for discarded output. Never use `NUL`.',
        'Check the active shell and command versions before relying on shell-specific syntax or GNU/BSD-specific flags.',
      ]
  }
}

export function getBashCommandBestPractices(): string[] {
  return [
    'Quote variables, substitutions, arrays, paths, and URLs unless splitting/globbing is intended: `"$var"`, `"$(command)"`, `"${array[@]}"`. Use `$(...)`, not backticks.',
    'Preserve failures deliberately: dependent commands use `&&`; expected failures use `if`/`||`; important pipelines use `set -o pipefail`. Redirection order is `>file 2>&1`.',
    'Do not parse `ls` output or pipe it into destructive commands. Use null-delimited paths when filenames may contain whitespace.',
    'Use `docker exec -i` for piped input; reserve `-t` for interactive terminals.',
    'Pass inline programs as one argument. For nontrivial code, use a quoted heredoc such as `python <<\'PY\'` or a `$TMPDIR` script.',
    'Process substitution requires Bash/Zsh, not `sh`. Check shell/command versions when portability is uncertain.',
    'Keep host and remote/container path syntax distinct across process boundaries.',
    'Use `export NAME=value` for later commands in the same shell process; `NAME=value command` affects only that command.',
  ]
}
