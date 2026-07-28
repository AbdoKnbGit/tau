import type { Command } from '../../commands.js'
import { modelAcceptsImages } from '../../lanes/shared/vision_capability.js'
import { getGlobalConfig } from '../../utils/config.js'
import { getMainLoopModel } from '../../utils/model/model.js'
import { getAPIProvider } from '../../utils/model/providers.js'

/**
 * The command is pointless when the model you are actually coding with can see
 * a screenshot itself: nothing will ever call a describer, so offering to pick
 * one is just a setting that does nothing.
 *
 * `modelAcceptsImages` rather than `decideImageSupport`: the latter memoizes a
 * per-model verdict for the session, and freezing that from a menu render,
 * before any attachment exists, would pin an answer from whatever catalog data
 * happened to have loaded by then.
 */
function activeModelSeesImages(): boolean {
  try {
    return modelAcceptsImages(getAPIProvider(), getMainLoopModel() ?? undefined) === true
  } catch {
    return false
  }
}

export default {
  type: 'local-jsx',
  name: 'vision-model',
  get description() {
    const stored = getGlobalConfig().visionModel
    if (stored === null) return 'Pick a model to describe images (currently off)'
    if (stored?.provider) {
      return `Pick a model to describe images (currently ${stored.provider} / ${stored.model})`
    }
    return 'Pick a model to describe images your coding model cannot see'
  },
  isEnabled: () => !activeModelSeesImages(),
  load: () => import('./vision-model.js'),
} satisfies Command
