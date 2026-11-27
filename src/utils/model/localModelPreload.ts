/**
 * Loading this session's prompt into a local model ahead of the first message.
 *
 * The first request of a session on a local model server makes the server
 * load the model and read Tau's whole prompt (instructions, tools, project
 * context) before it can answer: about 15-25 seconds for a 4B-9B model on an
 * 8 GB laptop GPU, more on the CPU. Every later request finds that prompt in
 * the server's cache and reads only what is new. So when an interactive
 * session starts on a local model, the REPL sends that same prompt once in
 * the background while the user types (hooks/useLocalModelPreload.ts).
 *
 * The request goes through the normal pipeline under its own query source, so
 * it carries exactly the instructions, tools and context the first message
 * will. The lane plans it like any request, so the server keeps the same
 * context size, and only cuts the answer to one token; query() stops right
 * after that one model call, so no tool runs, no hook fires and nothing is
 * retried. A request that starts while the preload is still being read waits
 * for it instead of reading the same prompt next to it
 * (lanes/openai-compat/local_model_settings.ts).
 *
 * TAU_LOCAL_PRELOAD=0 (or off, false, no) turns it off.
 *
 * No app imports, so every layer can use it.
 */

/** The query source of a preload request. */
export const LOCAL_PRELOAD_QUERY_SOURCE = 'local_preload'

export function isLocalPreloadSource(querySource: unknown): boolean {
  return querySource === LOCAL_PRELOAD_QUERY_SOURCE
}

/** On unless TAU_LOCAL_PRELOAD turns it off. */
export function localPreloadEnabled(): boolean {
  const value = process.env.TAU_LOCAL_PRELOAD?.trim().toLowerCase()
  return !(value === '0' || value === 'off' || value === 'false' || value === 'no')
}

/**
 * The main conversation's own requests (REPL or SDK): the ones whose prompt a
 * preload stands in for.
 */
export function isMainConversationSource(querySource: unknown): boolean {
  return typeof querySource === 'string'
    && (querySource.startsWith('repl_main_thread') || querySource === 'sdk')
}
