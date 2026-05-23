/**
 * Detects if a command contains a heredoc pattern
 * Matches patterns like: <<EOF, <<'EOF', <<"EOF", <<-EOF, <<-'EOF', <<\EOF, etc.
 */
function containsHeredoc(command: string): boolean {
  // Match heredoc patterns: << followed by optional -, then optional quotes or backslash, then word
  // Matches: <<EOF, <<'EOF', <<"EOF", <<-EOF, <<-'EOF', <<\EOF
  // Check for bit-shift operators first and exclude them
  if (
    /\d\s*<<\s*\d/.test(command) ||
    /\[\[\s*\d+\s*<<\s*\d+\s*\]\]/.test(command) ||
    /\$\(\(.*<<.*\)\)/.test(command)
  ) {
    return false
  }

  // Now check for heredoc patterns
  const heredocRegex = /<<-?\s*(?:(['"]?)(\w+)\1|\\(\w+))/
  return heredocRegex.test(command)
}

/**
 * Quotes a shell command appropriately, preserving heredocs and multiline strings
 * @param command The command to quote
 * @param addStdinRedirect Whether to add < /dev/null
 * @returns The properly quoted command
 */
export function quoteShellCommand(
  command: string,
  addStdinRedirect: boolean = true,
): string {
  const quoted = singleQuoteForEval(command)
  if (!addStdinRedirect || containsHeredoc(command)) {
    return quoted
  }
  return `${quoted} < /dev/null`
}

/**
 * Single-quote a command for use as one eval argument.
 *
 * Do not use shell-quote here: it can reinterpret valid bash while quoting the
 * whole command, for example turning `!=` inside jq filters into `\!=`.
 */
function singleQuoteForEval(command: string): string {
  return "'" + command.replace(/'/g, `'"'"'`) + "'"
}

/**
 * Detects if a command already has a stdin redirect
 * Match patterns like: < file, </path/to/file, < /dev/null, etc.
 * But not <<EOF (heredoc), << (bit shift), or <(process substitution)
 */
export function hasStdinRedirect(command: string): boolean {
  // Look for < followed by whitespace and a filename/path
  // Negative lookahead to exclude: <<, <(
  // Must be preceded by whitespace or command separator or start of string
  return /(?:^|[\s;&|])<(?![<(])\s*\S+/.test(command)
}

/**
 * Checks if stdin redirect should be added to a command
 * @param command The command to check
 * @returns true if stdin redirect can be safely added
 */
export function shouldAddStdinRedirect(command: string): boolean {
  // Don't add stdin redirect for heredocs as it interferes with the heredoc terminator
  if (containsHeredoc(command)) {
    return false
  }

  // Don't add stdin redirect if command already has one
  if (hasStdinRedirect(command)) {
    return false
  }

  // For other commands, stdin redirect is generally safe
  return true
}

/**
 * Rewrites Windows CMD-style `>nul` redirects to POSIX `/dev/null`.
 *
 * The model occasionally hallucinates Windows CMD syntax (e.g., `ls 2>nul`)
 * even though our bash shell is always POSIX (Git Bash / WSL on Windows).
 * When Git Bash sees `2>nul`, it creates a literal file named `nul` — a
 * Windows reserved device name that is extremely hard to delete and breaks
 * `git add .` and `git clone`. See anthropics/claude-code#4928.
 *
 * Matches: `>nul`, `> NUL`, `2>nul`, `&>nul`, `>>nul` (case-insensitive)
 * Does NOT match: `>null`, `>nullable`, `>nul.txt`, `cat nul.txt`
 *
 * Limitation: this regex does not parse shell quoting, so `echo ">nul"`
 * will also be rewritten. This is acceptable collateral — it's extremely
 * rare and rewriting to `/dev/null` inside a string is harmless.
 */
const NUL_REDIRECT_REGEX = /(\d?&?>+\s*)[Nn][Uu][Ll](?=\s|$|[|&;)\n])/g

export function rewriteWindowsNullRedirect(command: string): string {
  return command.replace(NUL_REDIRECT_REGEX, '$1/dev/null')
}
