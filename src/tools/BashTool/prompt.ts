import { feature } from 'bun:bundle'
import { prependBullets } from '../../constants/prompts.js'
import { getAttributionTexts } from '../../utils/attribution.js'
import { hasEmbeddedSearchTools } from '../../utils/embeddedTools.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { shouldIncludeGitInstructions } from '../../utils/gitSettings.js'
import { getClaudeTempDir } from '../../utils/permissions/filesystem.js'
import { getPlatform } from '../../utils/platform.js'
import { SandboxManager } from '../../utils/sandbox/sandbox-adapter.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import {
  getDefaultBashTimeoutMs,
  getMaxBashTimeoutMs,
} from '../../utils/timeouts.js'
import {
  getUndercoverInstructions,
  isUndercover,
} from '../../utils/undercover.js'
import { FILE_EDIT_TOOL_NAME } from '../FileEditTool/constants.js'
import { FILE_READ_TOOL_NAME } from '../FileReadTool/prompt.js'
import { FILE_WRITE_TOOL_NAME } from '../FileWriteTool/prompt.js'
import { GLOB_TOOL_NAME } from '../GlobTool/prompt.js'
import { GREP_TOOL_NAME } from '../GrepTool/prompt.js'
import {
  getBashCommandBestPractices,
  getBashPlatformBestPractices,
} from './bashBestPractices.js'
import { BASH_TOOL_NAME } from './toolName.js'

export function getDefaultTimeoutMs(): number {
  return getDefaultBashTimeoutMs()
}

export function getMaxTimeoutMs(): number {
  return getMaxBashTimeoutMs()
}

function getBackgroundUsageNote(): string | null {
  if (isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS)) {
    return null
  }
  return 'For servers/watchers/tunnels/port-forwards and other long-lived work, set `run_in_background: true`. Never detach inside `command` with `&`, `nohup`, `disown`, `echo $!`, `docker compose up -d`, or `docker run -d`; Tau tracks completion.'
}

function getCommitAndPRInstructions(): string {
  // Defense-in-depth: undercover instructions must survive even if the user
  // has disabled git instructions entirely. Attribution stripping and model-ID
  // hiding are mechanical and work regardless, but the explicit "don't blow
  // your cover" instructions are the last line of defense against the model
  // volunteering an internal codename in a commit message.
  const undercoverSection =
    process.env.USER_TYPE === 'ant' && isUndercover()
      ? getUndercoverInstructions() + '\n'
      : ''

  if (!shouldIncludeGitInstructions()) return undercoverSection

  // For ant users, use the short version pointing to skills
  if (process.env.USER_TYPE === 'ant') {
    const skillsSection = !isEnvTruthy(process.env.CLAUDE_CODE_SIMPLE)
      ? `For git commits and pull requests, use the \`/commit\` and \`/commit-push-pr\` skills:
- \`/commit\` - Create a git commit with staged changes
- \`/commit-push-pr\` - Commit, push, and create a pull request

These skills handle git safety protocols, proper commit message formatting, and PR creation.

Before creating a pull request, run \`/simplify\` to review your changes, then test end-to-end (e.g. via \`/tmux\` for interactive features).

`
      : ''
    return `${undercoverSection}# Git/GitHub

${skillsSection}IMPORTANT: NEVER skip hooks (--no-verify, --no-gpg-sign, etc) unless the user explicitly requests it.

Use \`gh\` for GitHub issues, pull requests, checks, and releases.`
  }

  // Keep the model-visible contract compact. Permission checks, destructive
  // command checks, hook failures, and command diagnostics are enforced by the
  // execution path and return actionable errors at the point of use.
  const { commit: commitAttribution, pr: prAttribution } = getAttributionTexts()

  return `# Git/GitHub

- Commit, push, amend, or create a PR only when requested. Changing git config or force-pushing main/master requires explicit authorization.
- Before committing, inspect status, staged/unstaged diff, and recent log; stage named files, exclude secrets, and never create empty commits.${commitAttribution ? ` End the commit message with:\n${commitAttribution}` : ''}
- Use \`gh\` for GitHub work. Before a PR, inspect the complete branch diff/history against its base. Title: under 70 characters. Include a concise summary and test plan${prAttribution ? `, then append:\n${prAttribution}` : ''}. Return the PR URL.`
}

// SandboxManager merges config from multiple sources (settings layers, defaults,
// CLI flags) without deduping, so paths like ~/.cache appear 3× in allowOnly.
// Dedup here before inlining into the prompt — affects only what the model sees,
// not sandbox enforcement. Saves ~150-200 tokens/request when sandbox is enabled.
function dedup<T>(arr: T[] | undefined): T[] | undefined {
  if (!arr || arr.length === 0) return arr
  return [...new Set(arr)]
}

function getSimpleSandboxSection(): string {
  if (!SandboxManager.isSandboxingEnabled()) {
    return ''
  }

  const fsReadConfig = SandboxManager.getFsReadConfig()
  const fsWriteConfig = SandboxManager.getFsWriteConfig()
  const networkRestrictionConfig = SandboxManager.getNetworkRestrictionConfig()
  const allowUnixSockets = SandboxManager.getAllowUnixSockets()
  const ignoreViolations = SandboxManager.getIgnoreViolations()
  const allowUnsandboxedCommands =
    SandboxManager.areUnsandboxedCommandsAllowed()

  // Replace the per-UID temp dir literal (e.g. /private/tmp/claude-1001/) with
  // "$TMPDIR" so the prompt is identical across users — avoids busting the
  // cross-user global prompt cache. The sandbox already sets $TMPDIR at runtime.
  const claudeTempDir = getClaudeTempDir()
  const normalizeAllowOnly = (paths: string[]): string[] =>
    [...new Set(paths)].map(p => (p === claudeTempDir ? '$TMPDIR' : p))

  const filesystemConfig = {
    read: {
      denyOnly: dedup(fsReadConfig.denyOnly),
      ...(fsReadConfig.allowWithinDeny && {
        allowWithinDeny: dedup(fsReadConfig.allowWithinDeny),
      }),
    },
    write: {
      allowOnly: normalizeAllowOnly(fsWriteConfig.allowOnly),
      denyWithinAllow: dedup(fsWriteConfig.denyWithinAllow),
    },
  }

  const networkConfig = {
    ...(networkRestrictionConfig?.allowedHosts && {
      allowedHosts: dedup(networkRestrictionConfig.allowedHosts),
    }),
    ...(networkRestrictionConfig?.deniedHosts && {
      deniedHosts: dedup(networkRestrictionConfig.deniedHosts),
    }),
    ...(allowUnixSockets && { allowUnixSockets: dedup(allowUnixSockets) }),
  }

  const restrictionsLines = []
  if (Object.keys(filesystemConfig).length > 0) {
    restrictionsLines.push(`Filesystem: ${jsonStringify(filesystemConfig)}`)
  }
  if (Object.keys(networkConfig).length > 0) {
    restrictionsLines.push(`Network: ${jsonStringify(networkConfig)}`)
  }
  if (ignoreViolations) {
    restrictionsLines.push(
      `Ignored violations: ${jsonStringify(ignoreViolations)}`,
    )
  }

  const sandboxOverrideItems: Array<string | string[]> =
    allowUnsandboxedCommands
      ? [
          'Default to sandboxed commands. Use `dangerouslyDisableSandbox: true` only when:',
          [
            'The user explicitly requests bypass.',
            'The command just failed with evidence of sandbox restrictions; missing files, wrong arguments, and unrelated network failures do not justify bypass.',
          ],
          'Sandbox evidence includes:',
          [
            '"Operation not permitted" errors for file/network operations',
            'Access denied outside allowed directories',
            'Connection failures to non-allowed hosts',
            'Unix socket connection errors',
          ],
          'After a sandbox-caused failure:',
          [
            'Immediately retry with `dangerouslyDisableSandbox: true`; the tool prompts for permission, so do not ask separately.',
            'Briefly explain the likely restriction and mention `/sandbox` to manage restrictions.',
          ],
          'Decide bypass per command; return to sandbox by default afterward.',
          'Never suggest allowlisting sensitive paths (~/.bashrc, ~/.zshrc, ~/.ssh/*, credentials).',
        ]
      : [
          '`dangerouslyDisableSandbox` is disabled by policy: every command MUST be sandboxed, without exception.',
          'For sandbox-caused failures, work with the user to adjust sandbox settings.',
        ]

  const items: Array<string | string[]> = [
    ...sandboxOverrideItems,
    'For temporary files, always use `$TMPDIR` (automatically sandbox-writable), never `/tmp` directly.',
  ]

  return [
    '',
    '## Command sandbox',
    'Sandbox controls directory/network access and modification unless explicitly overridden:',
    restrictionsLines.join('\n'),
    '',
    ...prependBullets(items),
  ].join('\n')
}

export function getSimplePrompt(): string {
  // Ant-native builds alias find/grep to embedded bfs/ugrep in Claude's shell,
  // so we don't steer away from them (and Glob/Grep tools are removed).
  const embedded = hasEmbeddedSearchTools()

  const toolPreferenceItems = [
    ...(embedded
      ? []
      : [
          `File search: Use ${GLOB_TOOL_NAME} (NOT find or ls)`,
          `Content search: Use ${GREP_TOOL_NAME} (NOT grep or rg)`,
        ]),
    `Read files: Use ${FILE_READ_TOOL_NAME} (NOT cat/head/tail)`,
    `Edit files: Use ${FILE_EDIT_TOOL_NAME} (NOT sed/awk)`,
    `Write files: Use ${FILE_WRITE_TOOL_NAME} (NOT echo >/cat <<EOF)`,
    'Communication: Output text directly (NOT echo/printf)',
  ]

  const multipleCommandsSubitems = [
    `Run independent commands as parallel ${BASH_TOOL_NAME} calls; join dependent commands with \`&&\`. Use \`;\` only to continue after failure.`,
    'Do not use unquoted newlines as command separators.',
  ]

  const gitSubitems = [
    'Prefer new commits; after hook failure, fix the cause and make a new commit. Destructive operations, amend, force-push, or hook/signing bypasses require explicit requests.',
    // Dropped in 076bb45f. GIT_EDITOR=true keeps these from hanging, but
    // `rebase -i` then silently does nothing and an editor commit aborts empty.
    '`git rebase -i`/`git add -i` cannot work here (no editor or terminal input). Pass multi-line commit messages through a quoted heredoc.',
  ]

  const sleepSubitems = [
    'Do not sleep, poll, or retry in a loop when work can run immediately; diagnose failures.',
    ...(feature('MONITOR_TOOL')
      ? [
          'Use the Monitor tool to stream events from a background process (each stdout line is a notification). For one-shot "wait until done," use Bash with run_in_background instead.',
        ]
      : []),
    'Use `run_in_background` for long work; Tau reports completion, so do not poll.',
    ...(feature('MONITOR_TOOL')
      ? [
          '`sleep N` as the first command with N ≥ 2 is blocked. If you need a delay (rate limiting, deliberate pacing), keep it under 2 seconds.',
        ]
      : [
          'For external processes, run the status command directly; keep unavoidable delays short.',
        ]),
  ]
  const backgroundNote = getBackgroundUsageNote()
  const platform = getPlatform()
  const platformBestPractices = getBashPlatformBestPractices(platform)
  const commandBestPractices = getBashCommandBestPractices()

  const instructionItems: Array<string | string[]> = [
    'Target the exact user-named directory by absolute path/argument or native flag (`git -C`, `npm --prefix`, `docker compose -f`); never run bare project commands in another cwd.',
    'Before file creation or project build/test/package commands, verify the target directory and relevant manifest exist. Never guess paths.',
    'Run commands directly; `plan_only: true` requires an explicit user request for a dry-run plan, never routine preflight for Python/package/build/test/cleanup commands.',
    `\`timeout\` is milliseconds; default ${getDefaultTimeoutMs()}, maximum ${getMaxTimeoutMs()}.`,
    'For charts/plots/images, print one `data:image/png;base64,...` URI as the entire stdout; Tau renders it inline and sends you the image. Prefer this to ASCII plots (plotext). With matplotlib, use Agg and savefig to an in-memory buffer.',
    ...(backgroundNote !== null ? [backgroundNote] : []),
    'Shell correctness:',
    commandBestPractices,
    'Platform:',
    platformBestPractices,
    'Multiple commands:',
    multipleCommandsSubitems,
    'Git:',
    gitSubitems,
    'Waiting:',
    sleepSubitems,
    ...(embedded
      ? [
          // bfs (which backs `find`) uses Oniguruma for -regex, which picks the
          // FIRST matching alternative (leftmost-first), unlike GNU find's
          // POSIX leftmost-longest. This silently drops matches when a shorter
          // alternative is a prefix of a longer one.
          "When using `find -regex` with alternation, put the longest alternative first. Example: use `'.*\\.\\(tsx\\|ts\\)'` not `'.*\\.\\(ts\\|tsx\\)'` — the second form silently skips `.tsx` files.",
        ]
      : []),
  ]

  return [
    "Executes Bash and returns output. Working directory persists; shell state does not. Shell initializes from the user's bash/zsh profile. A result's bracketed directory note is authoritative.",
    '',
    'Prefer dedicated tools:',
    '',
    ...prependBullets(toolPreferenceItems),
    '',
    '# Instructions',
    ...prependBullets(instructionItems),
    getSimpleSandboxSection(),
    ...(getCommitAndPRInstructions() ? ['', getCommitAndPRInstructions()] : []),
  ].join('\n')
}
