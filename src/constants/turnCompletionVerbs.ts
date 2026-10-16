import { getInitialSettings } from '../utils/settings/settings.js'

// Past tense verbs for turn completion messages
// These verbs work naturally with "for [duration]" (e.g., "Worked for 5s")
export const TURN_COMPLETION_VERBS = [
  'Baked',
  'Brewed',
  'Churned',
  'Cogitated',
  'Cooked',
  'Crunched',
  'Sautéed',
  'Worked',
]

/**
 * When your own spinner verbs replace the built-in ones (Off or Custom in
 * /config), the line after a turn says "Worked": there is no past tense to
 * derive from a verb someone typed.
 */
export function getTurnCompletionVerbs(): string[] {
  const config = getInitialSettings().spinnerVerbs
  if (config?.mode === 'replace' && config.verbs.length > 0) {
    return ['Worked']
  }
  return TURN_COMPLETION_VERBS
}
