/**
 * Transformer registry. Adding a new provider = add a file in this
 * directory + one line here.
 */

import { deepseekTransformer } from './deepseek.js'
import { groqTransformer } from './groq.js'
import { glmTransformer } from './glm.js'
import { moonshotTransformer } from './moonshot.js'
import { minimaxTransformer } from './minimax.js'
import { mistralTransformer } from './mistral.js'
import { nimTransformer } from './nim.js'
import { ollamaTransformer } from './ollama.js'
import { openrouterTransformer } from './openrouter.js'
import { agentrouterTransformer } from './agentrouter.js'
import { clineTransformer } from './cline.js'
import { iflowTransformer } from './iflow.js'
import { kilocodeTransformer } from './kilocode.js'
import { copilotTransformer } from './copilot.js'
import { genericTransformer } from './generic.js'
import type { Transformer, ProviderId } from './base.js'

export const TRANSFORMERS: Record<ProviderId, Transformer> = {
  deepseek: deepseekTransformer,
  groq: groqTransformer,
  glm: glmTransformer,
  moonshot: moonshotTransformer,
  minimax: minimaxTransformer,
  mistral: mistralTransformer,
  nim: nimTransformer,
  ollama: ollamaTransformer,
  openrouter: openrouterTransformer,
  agentrouter: agentrouterTransformer,
  cline: clineTransformer,
  iflow: iflowTransformer,
  kilocode: kilocodeTransformer,
  copilot: copilotTransformer,
  generic: genericTransformer,
}

export function getTransformer(provider: ProviderId): Transformer {
  return TRANSFORMERS[provider] ?? genericTransformer
}

export {
  deepseekTransformer, groqTransformer, mistralTransformer, nimTransformer,
  glmTransformer, moonshotTransformer, minimaxTransformer, ollamaTransformer, openrouterTransformer, agentrouterTransformer, genericTransformer,
  clineTransformer, iflowTransformer, kilocodeTransformer, copilotTransformer,
}
export type { Transformer, ProviderId, TransformContext } from './base.js'
export type { OpenAIChatRequest, OpenAIChatMessage } from './shared_types.js'
