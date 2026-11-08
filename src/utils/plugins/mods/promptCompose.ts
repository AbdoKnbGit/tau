import { getIsInteractive } from '../../../bootstrap/state.js'
import type { PromptComposeSection, RenderedSystemPrompt } from '../../../constants/prompts.js'
import type { Tools } from '../../../Tool.js'
import { dispatchModEvent, hasModEvent, type ModDispatchOptions } from './manager.js'

type ModRecord = Record<string, any>

export type ModComposeContext = {
  tools: Tools
  model: string
  boundaryMarker: string
  /** The engine's composition for other facts than the session's. */
  rerender: (tools: Tools, model: string) => Promise<RenderedSystemPrompt>
  facts?: ModRecord
  signal?: AbortSignal
  dispatch?: ModDispatchOptions
  /** Raise the event even when no hook would see it (a mod's own call). */
  always?: boolean
}

const sameSections = (a: readonly PromptComposeSection[], b: readonly PromptComposeSection[]) =>
  a.length === b.length && a.every((item, index) => item.id === b[index]!.id && item.text === b[index]!.text && item.scope === b[index]!.scope)

/**
 * `prompt.compose`: the engine's sections through the mods' hooks. The
 * prompt sent is the engine's own array unless a hook changed a section;
 * then each side is joined as written, the cache boundary between them.
 */
export async function composeWithMods(
  rendered: RenderedSystemPrompt,
  context: ModComposeContext,
): Promise<{ entries: string[]; sections: PromptComposeSection[] }> {
  if (!context.always && !hasModEvent('prompt.compose'))
    return { entries: rendered.entries, sections: rendered.sections }
  const names = context.tools.map(tool => tool.name)
  const facts = context.facts ?? {}
  const model = typeof facts.model === 'string' && facts.model ? facts.model : context.model
  const input = {
    model,
    // Tau renders every model's prompt from its own composition.
    promptModel: model,
    surfaces: Array.isArray(facts.surfaces) ? facts.surfaces.filter((item: unknown) => typeof item === 'string') : getIsInteractive() ? ['terminal'] : [],
    tools: Array.isArray(facts.tools) ? facts.tools.filter((item: unknown) => typeof item === 'string') : names,
    outputStyle: facts.outputStyle !== undefined ? facts.outputStyle : rendered.outputStyle,
    traits: rendered.traits,
  }
  const engine = async (e: ModRecord) => {
    // Rewritten facts are composed afresh: other tools (an unknown name
    // ignored) or another model.
    const wanted = new Set(Array.isArray(e.tools) ? e.tools.filter((item: unknown) => typeof item === 'string') : names)
    const sameTools = names.length === wanted.size && names.every(name => wanted.has(name))
    const again = e.model === context.model && sameTools
      ? rendered
      : await context.rerender(context.tools.filter(tool => wanted.has(tool.name)), String(e.model || context.model))
    return { sections: again.sections }
  }
  const result = (await dispatchModEvent('prompt.compose', input, engine, context.signal, context.dispatch)) as ModRecord
  const sections: PromptComposeSection[] = (result.sections as ModRecord[]).map(item => ({
    id: String(item.id), text: String(item.text), scope: item.scope === 'shared' ? 'shared' : 'session',
  }))
  if (sameSections(sections, rendered.sections)) return { entries: rendered.entries, sections: rendered.sections }
  const side = (scope: PromptComposeSection['scope']) => sections.filter(item => item.scope === scope && item.text).map(item => item.text)
  return {
    entries: [...side('shared'), ...(rendered.boundary ? [context.boundaryMarker] : []), ...side('session')],
    sections,
  }
}
