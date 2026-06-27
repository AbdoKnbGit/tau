import { getPlatform, type Platform } from '../../utils/platform.js'

export function getBashPlatformBestPractices(
  platform: Platform = getPlatform(),
): string[] {
  switch (platform) {
    case 'windows':
      return [
        'This Bash tool runs in Git Bash. Use POSIX paths (`/c/Users/name/project`) or forward-slash drive paths (`C:/Users/name/project`), not backslash paths such as `C:\\Users\\name\\project`. Use `cygpath -w -- "$path"` only when a Windows-native program specifically needs a Windows path.',
        'Use `/dev/null` for discarded output. Never redirect to `NUL`, `nul`, `$null`, `CON`, `PRN`, or `AUX`; in Git Bash these are not POSIX null devices and can create broken reserved-name files.',
        'Files checked out on Windows may contain CRLF. If a script reports `bash\\r`, `env: ...\\r`, or `$\'\\r\': command not found`, normalize it to LF before retrying.',
        'Tau treats Git Bash `/tmp/...`, `$TMPDIR/...`, and file-tool paths as the same native per-user temporary directory. Use `$TMPDIR` when constructing shell paths; do not invent `C:\\tmp`, assume a Docker VM filesystem, or mix a container `/tmp` path with a host-side copy source.',
        'Git Bash supplies a Bash environment, but many installed utilities are Windows or MSYS variants. Check `command --help` before assuming GNU-only flags.',
        'Git Bash/MSYS may rewrite a remote POSIX argument such as `/bigdata/file`, `/var/log/app`, or `host:/srv/file` into a Windows `C:/...` path before a native boundary client receives it. Tau narrowly protects static remote arguments for container exec/run/cp, Kubernetes exec/cp, SSH/SCP/rsync, WSL, ADB, and Hadoop/HDFS commands while preserving normal conversion for host paths and bind mounts.',
        'For a dynamic direct remote path, use a narrow runtime exclusion such as `MSYS2_ARG_CONV_EXCL="$REMOTE_PATH" docker exec container cat "$REMOTE_PATH"`. For remote globs, pipes, redirects, or compound commands, put the complete remote command in one quoted `sh -c` or `bash -c` string, for example `docker compose exec namenode bash -c \'hadoop fs -cat /bigdata/hello.txt\'`. Quoting only the direct `/remote/path` argument does not reliably disable MSYS argument conversion.',
      ]
    case 'wsl':
      return [
        'Use Linux paths for Linux tools: `/home/name/project` for the WSL filesystem and `/mnt/c/Users/name/project` for Windows files. Do not pass `C:\\...` directly to Linux commands.',
        'Use `/dev/null` for discarded output. Never use `NUL`.',
        'Prefer keeping build trees inside the WSL filesystem when Linux tooling needs executable bits, symlinks, case sensitivity, or high filesystem performance.',
        'When invoking a Windows executable from WSL, convert paths only at that boundary (for example with `wslpath -w -- "$path"`).',
      ]
    case 'macos':
      return [
        'Use macOS paths such as `/Users/name/project` and `/dev/null` for discarded output. Never use `NUL`.',
        'macOS ships BSD utilities, so GNU-only flags may fail. In particular, do not assume `ls --time-style`, GNU `sed -i` syntax, or `readlink -f`; use portable flags, `realpath`, or Homebrew GNU tools such as `greadlink` when explicitly available.',
        'The system Bash may be Bash 3.x. Do not rely on newer Bash features, and do not rely on `set -e` alone inside subshells; use explicit error checks for important operations.',
      ]
    case 'linux':
      return [
        'Use Linux paths such as `/home/name/project` and `/dev/null` for discarded output. Never use `NUL`.',
        'GNU utilities and `readlink -f` are common on Linux, but check the installed command/version before relying on optional GNU-only flags in portable scripts.',
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
    'Quote every variable, command substitution, array expansion, path, and URL unless word splitting or glob expansion is explicitly intended: `"$var"`, `"$(command)"`, `"${array[@]}"`, and `"https://host/api?a=1&b=2"`. Use single quotes for literal text and double quotes when expansion is required.',
    'Use `$(command)` instead of backticks. Do not iterate over `$(ls ...)`; iterate over a glob directly or use a null-delimited producer/consumer when filenames may contain whitespace.',
    'Avoid redundant or unsafe pipelines: use `grep pattern file` instead of `cat file | grep pattern`, `wc -l < file` when only the count is needed, and a direct glob instead of piping `ls` into another command. Never pipe an `ls` listing into `rm`.',
    'Use `[[ ... ]]` in Bash/Zsh, or quote variables in portable `[ ... ]` tests. Use `=` rather than Bash-only `==` inside portable `[ ... ]` tests.',
    'Quote globs when they must remain literal; leave them unquoted only when pathname expansion is intended.',
    'Preserve exit status deliberately. Chain dependent commands with `&&`, use explicit `if`/`||` handling for expected failures, and use `set -o pipefail` when a pipeline must fail if any stage fails. Do not rely on `set -e` alone for correctness.',
    'Redirection order matters: use `>file 2>&1` to send both streams to the file. `2>&1 >file` intentionally leaves stderr on the original stdout.',
    'When piping input into a container command, use `docker exec -i CONTAINER COMMAND`; reserve `-t`/`-it` for a genuinely interactive terminal.',
    'Pipelines, heredocs, process substitution, and explicit stdin redirects stay in the foreground automatically because their producer/consumer lifecycle is coupled. Request `run_in_background: true` only when detaching the complete pipeline is intentional.',
    'For nontrivial inline Python, use a single-quoted heredoc (`python <<\'PY\' ... PY`) or a temporary script under `$TMPDIR` instead of fragile multiline `python -c` quoting.',
    'For any inline evaluator (`-c`, `-e`, `--eval`, `--execute`, etc.), pass the program as one shell argument. Tau non-blockingly repairs outer double quotes that conflict with nested code/JSON/BSON quotes, including payloads split across spaces. Prefer a single-quoted payload, quoted heredoc, stdin, or a temporary file for deeply nested code.',
    'Prefer the portable `--option value` spelling for static path-like long-option values. Tau applies this by argument shape rather than maintaining a command-specific option list, while leaving URLs, dynamic values, and non-path equals options unchanged.',
    'Process substitution (`<(...)` and `>(...)`) requires Bash or Zsh. Never place it inside `sh -c` or a script with a plain `#!/bin/sh` shebang.',
    'When shell portability is uncertain, inspect the active shell and features first with `$SHELL`, `bash --version`, and the target command\'s `--help` or version output.',
    'Distinguish host paths from remote/container paths at every process boundary. Host paths should use the host platform spelling; paths interpreted inside a container, VM, WSL distribution, remote SSH host, Hadoop filesystem, or Kubernetes pod must reach that target unchanged.',
    'Use `run_in_background: true` for long-running work such as app servers, watchers, port-forwards, SSH tunnels, and foreground container runs. Keep log redirection if needed, but do not use raw trailing `&`, `nohup`, `disown`, `echo $!`, `docker compose up -d`, or `docker run -d`; Tau must keep the process tracked and stoppable.',
    'Use `export NAME=value` when later commands in the same shell process need the variable. `NAME=value command` affects only that command.',
  ]
}
