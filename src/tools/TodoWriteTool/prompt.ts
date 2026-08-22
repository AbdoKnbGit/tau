export const PROMPT = `Replace the current session task list. Use for meaningful multi-step work or when the user asks for tracking; skip simple, single-step, conversational, or informational requests.

Send the complete list only when its items or statuses change. Each item needs imperative \`content\`, present-continuous \`activeForm\`, and status \`pending\`, \`in_progress\`, or \`completed\`. Keep items specific. Start work by marking its item in progress; mark it completed only after it is fully done and verified. Keep blocked or partial work unfinished, and remove obsolete items. Tau normalizes unfinished lists to exactly one in-progress item. After the final completion update, do not call again unless new work is discovered.

Track "add dark mode, then update the settings page and its tests" — several steps across files. Skip "what does this function do?" or "fix this typo" — one step, nothing to track.`

export const DESCRIPTION =
  'Replace the session task list when multi-step work changes; each item has content, activeForm, and status.'
