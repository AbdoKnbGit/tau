import { getUserSpecifiedModelSetting } from '../../utils/model/model.js'
import { isLaneCatalogDefaultModel } from '../../utils/model/configs.js'
import type { Lane } from '../types.js'

const LIST_TIMEOUT_MS = 5_000

// One answer per session: a model that changes mid-conversation loses the provider's cache.
const answers = new Map<string, Promise<string>>()

async function pick(lane: Lane, provider: string, model: string): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const listed = await Promise.race([
      lane.listModels(provider),
      new Promise<null>(resolve => {
        timer = setTimeout(() => resolve(null), LIST_TIMEOUT_MS)
      }),
    ])
    if (!listed?.length || listed.some(row => row.id === model)) return model
    return (listed.find(row => row.tags?.includes('free')) ?? listed[0]!).id
  } catch {
    return model
  } finally {
    clearTimeout(timer)
  }
}

/**
 * A provider's catalog moves, and a built-in default can leave it. With no model chosen, one the provider
 * no longer serves gives way to what it lists, a free row when there is one. A model someone chose is
 * theirs, even if the provider will refuse it.
 */
export function servedDefaultModel(
  lane: Lane,
  provider: string | undefined,
  model: string,
): string | Promise<string> {
  if (!provider || !isLaneCatalogDefaultModel(provider, model)) return model
  if (getUserSpecifiedModelSetting() !== undefined) return model
  const key = `${provider}\0${model}`
  let answer = answers.get(key)
  if (!answer) {
    answer = pick(lane, provider, model)
    answers.set(key, answer)
  }
  return answer
}

export function _resetServedDefaultsForTest(): void {
  answers.clear()
}
