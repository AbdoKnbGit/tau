// --tools and --allowedTools always take Tau's tool names. Some provider routes use other names on the
// wire, so the lab translates when it reads a request or scripts a tool call.
const GEMINI_NAMES = {
  AskUserQuestion: 'ask_user',
  Bash: 'run_shell_command',
  Edit: 'replace',
  EnterPlanMode: 'enter_plan_mode',
  ExitPlanMode: 'exit_plan_mode',
  Glob: 'glob',
  Grep: 'grep_search',
  Read: 'read_file',
  WebFetch: 'web_fetch',
  WebSearch: 'google_web_search',
  Write: 'write_file',
}
const TAU_NAMES = Object.fromEntries(Object.entries(GEMINI_NAMES).map(([tau, wire]) => [wire, tau]))

export const toTauName = wire => TAU_NAMES[wire] ?? wire

export function toWireName(tau, offered, format) {
  if (offered.includes(tau)) return tau
  const gemini = GEMINI_NAMES[tau]
  if (gemini && offered.includes(gemini)) return gemini
  return format === 'gemini' && gemini ? gemini : tau
}
