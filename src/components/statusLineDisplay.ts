/**
 * Which of the two status rows the prompt renders.
 *
 * Tau has two of them, and they occupy the same visual slot:
 *   - the legacy `statusLine` row (StatusLine.tsx) — stdout of a user-supplied
 *     shell command, configured in settings.json;
 *   - the built-in session bar (PromptInputStatusBar.tsx) — cwd,
 *     provider/model, and context usage, formatted in code.
 *
 * This module owns the single decision of which one shows, so the two render
 * sites can never disagree. It is deliberately pure — no imports — so the truth
 * table is testable without an ink/React harness. Ambient state (assistant
 * mode, workspace trust, hook policy) is resolved by the callers.
 */

export type StatusLineDisplayInput = {
  /**
   * A `statusLine` command is present in the settings that apply to this
   * session. Configuration intent only: it does not mean the command can run.
   */
  customCommandConfigured: boolean
  /**
   * That command will actually produce output — workspace trust granted and not
   * suppressed by `disableAllHooks`. Only consulted when it is configured.
   */
  customCommandWillRun: boolean
  /** The `sessionStatusBar` setting. `undefined` means auto. */
  sessionStatusBar: boolean | undefined
  /**
   * Assistant/Kairos mode: every field on both rows describes the REPL process
   * rather than the agent child that is actually running, so neither is honest.
   */
  suppressAll: boolean
}

export type StatusLineDisplay = {
  /** Render the legacy `statusLine` command row. */
  custom: boolean
  /** Render the built-in session bar. */
  builtin: boolean
}

/**
 * Resolve both rows at once.
 *
 * With `suppressAll` false, the table is:
 *
 * | configured | willRun | sessionStatusBar | custom | builtin |
 * |------------|---------|------------------|--------|---------|
 * | no         | –       | undefined        | no     | yes     | default
 * | yes        | yes     | undefined        | yes    | no      | custom wins
 * | yes        | no      | undefined        | yes    | yes     | dead command
 * | any        | any     | false            | =cfg   | no      | turned off
 * | any        | any     | true             | =cfg   | yes     | forced on
 */
export function resolveStatusLineDisplay(
  input: StatusLineDisplayInput,
): StatusLineDisplay {
  if (input.suppressAll) return { custom: false, builtin: false }

  // The legacy row is gated on configuration alone, never on whether the
  // command can run. StatusLine.tsx has to mount even when trust is missing —
  // that mount is what raises "statusline skipped · restart to fix", and
  // unmounting it would swallow the only explanation the user ever gets.
  const custom = input.customCommandConfigured

  // Auto: the built-in bar steps aside for a custom row that will actually
  // render something. A configured-but-dead command keeps the bar in place, so
  // the slot is never silently empty.
  const builtin =
    input.sessionStatusBar ??
    !(input.customCommandConfigured && input.customCommandWillRun)

  return { custom, builtin }
}
