/**
 * What a provider's model catalogs say about image input.
 *
 * The vision decision (lanes/shared/vision_capability.ts) asks this before it
 * borrows another provider's evidence. Every answer is data the catalogs
 * already carry: the provider's own catalog (its live /models fields folded
 * in, or the bundled snapshot that stands in until those load), then the
 * models.dev row for the same host. Undefined means nothing describes the
 * model, which is not evidence that it is blind.
 */

import { lookupCatalogImageInput, lookupCatalogImageInputAnyHost } from '../modelPricingCatalog.js'
import { getAlibabaModelMeta } from './alibabaCatalog.js'
import { commandCodeRegistryImageInput } from './commandCodeRegistry.js'
import { getDirectModelMeta, isDirectProvider } from './directProviderCatalog.js'
import { getFireworksModelMeta, qualifyFireworksId } from './fireworksCatalog.js'
import { getLxdModelMeta } from './lxdCatalog.js'
import { getMetaModelMeta } from './metaCatalog.js'
import { getMimoModelMeta } from './mimoCatalog.js'
import { getOpencodeModelMeta } from './opencodeModelsDevCatalog.js'
import { getXaiModelMeta } from './xaiCatalog.js'

export function catalogImageInput(provider: string, model: string): boolean | undefined {
  return providerCatalogImageInput(provider, model)
    // Fireworks takes a bare name (`glm-5p3`) as well as the full path.
    ?? lookupCatalogImageInput(provider, provider === 'fireworks' ? [model, qualifyFireworksId(model)] : [model])
    // Fireworks rows models.dev does not describe (Nexus Auto, on-demand-only
    // models): what Fireworks' model page states.
    ?? (provider === 'fireworks' ? getFireworksModelMeta(model)?.imageInput : undefined)
    // A model this host does not describe yet, where every host that does
    // agrees: a new release reaches some hosts before others.
    ?? lookupCatalogImageInputAnyHost([model])
}

function providerCatalogImageInput(provider: string, model: string): boolean | undefined {
  if (isDirectProvider(provider)) return getDirectModelMeta(provider, model)?.vision
  switch (provider) {
    case 'alibaba':
      return getAlibabaModelMeta(model)?.vision
    case 'commandcode':
      return commandCodeRegistryImageInput(model)
    case 'lxd':
      return getLxdModelMeta(model)?.vision
    case 'meta':
      return getMetaModelMeta(model)?.imageInput
    case 'mimo':
      return getMimoModelMeta(model)?.vision
    case 'opencode':
    case 'opencodego':
      return getOpencodeModelMeta(provider, model)?.imageInput
    case 'xai':
      return getXaiModelMeta(model)?.imageInput
    default:
      return undefined
  }
}
