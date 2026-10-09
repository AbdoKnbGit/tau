export const PROMPT = `Replace the current session task list. Use for meaningful multi-step work or user-requested tracking; skip simple, single-step, conversational, or informational requests.

Send the complete list only when items/statuses change. Each item needs imperative \`content\`, present-continuous \`activeForm\`, and status \`pending\`, \`in_progress\`, or \`completed\`. Keep items specific. Mark in progress when starting; completed only when fully done and verified. Keep blocked/partial work unfinished; remove obsolete items. Tau normalizes unfinished lists to exactly one in-progress item. After final completion, call again only if new work is discovered.

Track "add dark mode, then update the settings page and its tests" — several steps across files. Skip "what does this function do?" or "fix this typo" — one step, nothing to track.`

export const DESCRIPTION =
  'Replace the session task list when multi-step work changes; each item has content, activeForm, and status.'
