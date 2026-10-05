import { getPlatform, type Platform } from '../../utils/platform.js'

export function getBashPlatformBestPractices(
  platform: Platform = getPlatform(),
): string[] {
  switch (platform) {
    case 'windows':
      return [
        'Git Bash: use `/c/path` or `C:/path`, `/dev/null`, and `$TMPDIR`; never backslash paths or reserved null names like `NUL`.',
        'For `\\r` errors, normalize CRLF to LF. Check `command --help` before assuming GNU flags.',
        'MSYS may rewrite remote POSIX paths for native processes. Tau protects common static container/SSH/Kubernetes arguments; dynamic paths need narrow `MSYS2_ARG_CONV_EXCL`. Put remote globs/pipes/redirections in one quoted remote `sh -c` command.',
      ]
    case 'wsl':
      return [
        'WSL: use `/home/...` for Linux files, `/mnt/c/...` for Windows files, and `/dev/null`; never pass `C:\\...` to Linux tools.',
        'Use `wslpath` only for Windows executables. Keep builds in WSL for symlinks, executable bits, case sensitivity, or speed.',
      ]
    case 'macos':
      return [
        'macOS: use `/Users/...` and `/dev/null`. Utilities are BSD; do not assume GNU flags, GNU `sed -i`, or `readlink -f`.',
        'System Bash may be 3.x; use portable syntax and explicitly check important operations.',
      ]
    case 'linux':
      return [
        'Use Linux paths (`/home/...`, `/dev/null`); check versions before relying on optional GNU-only behavior.',
      ]
    default:
      return [
        'Use POSIX paths and `/dev/null` for discarded output, never `NUL`.',
        'Check shell/command versions before relying on shell-specific syntax or GNU/BSD flags.',
      ]
  }
}

export function getBashCommandBestPractices(): string[] {
  return [
    'Quote variables, substitutions, arrays, paths (especially with spaces), and URLs unless splitting/globbing is intended: `"$var"`, `"$(command)"`, `"${array[@]}"`. Use `$(...)`, not backticks.',
    'Handle expected failures with `if`/`||`; use `set -o pipefail` for important pipelines. Redirection order: `>file 2>&1`.',
    'Never parse `ls` or pipe it into destructive commands. Use null-delimited paths for filenames that may contain whitespace.',
    'Use `docker exec -i` for piped input; `-t` only for interactive terminals.',
    'Pass inline programs as one argument; nontrivial code needs a quoted heredoc (`python <<\'PY\'`) or `$TMPDIR` script.',
    'Process substitution requires Bash/Zsh, not `sh`. Check shell/command versions when portability is uncertain.',
    'Keep host and remote/container path syntax distinct.',
    '`export NAME=value` affects later commands in that shell; `NAME=value command` affects only that command.',
  ]
}
