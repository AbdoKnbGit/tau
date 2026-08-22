import { EXIT_PLAN_MODE_TOOL_NAME } from '../ExitPlanModeTool/constants.js'

export const ASK_USER_QUESTION_TOOL_NAME = 'AskUserQuestion'

export const ASK_USER_QUESTION_TOOL_CHIP_WIDTH = 12

export const DESCRIPTION =
  'Ask the user 1-4 multiple-choice questions when a decision or clarification is required.'

export const PREVIEW_FEATURE_PROMPT = {
  markdown:
    '\nFor a single-select visual comparison, an option may include a multiline Markdown `preview` (mockup, code, diagram, or configuration). Omit previews for ordinary choices and whenever `multiSelect` is true.\n',
  html:
    '\nFor a single-select visual comparison, an option may include a self-contained HTML-fragment `preview`. Use inline styles only: no html/body wrapper and no script/style tags. Omit previews for ordinary choices and whenever `multiSelect` is true.\n',
} as const

export const ASK_USER_QUESTION_TOOL_PROMPT = `Ask only when a user decision, preference, or missing requirement materially affects the work. "Other" is added automatically, so never include it. Use multiSelect only for non-exclusive choices. Put a recommended option first and suffix its label with "(Recommended)". In plan mode, ask requirement/approach questions before finalizing; never ask for plan approval or refer to a plan the user cannot yet see—use ${EXIT_PLAN_MODE_TOOL_NAME} for approval.`
