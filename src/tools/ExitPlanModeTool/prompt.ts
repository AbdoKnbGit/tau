// External stub for ExitPlanModeTool prompt - excludes Ant-only allowedPrompts section

// Hardcoded to avoid relative import issues in stub
const ASK_USER_QUESTION_TOOL_NAME = 'AskUserQuestion'

export const EXIT_PLAN_MODE_V2_TOOL_PROMPT = `Use only while in plan mode, and only after the plan file is written. Finish implementation planning and request approval. First resolve open requirements with ${ASK_USER_QUESTION_TOOL_NAME} and write a complete, unambiguous plan to the plan file; this tool reads that file, so do not pass plan text. Use only for a coding implementation plan, not research or codebase exploration. Do not ask separately whether the plan is acceptable—this call performs that approval step.`
