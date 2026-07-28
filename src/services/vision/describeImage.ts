/**
 * Vision describer.
 *
 * One job: hand an image to a model that can see, get back a paragraph of prose
 * a text-only model can read. Used when OCR found no text, or when OCR is not
 * configured at all.
 *
 * This used to POST to the three provider APIs directly. That was wrong, and it
 * failed silently for exactly the people most likely to use it. Hand-rolled
 * HTTP is only correct for API-key auth: sign into OpenAI through ChatGPT and
 * the credential belongs to `chatgpt.com/backend-api/codex` speaking the
 * Responses API, not `api.openai.com/v1/chat/completions`. Sign into Gemini
 * through the CLI and it goes through Code Assist, not AI Studio. Anthropic
 * OAuth needs its own beta header. Reproducing three lanes' worth of auth,
 * endpoint and envelope knowledge here would mean maintaining it twice and
 * getting it wrong in a different way each time.
 *
 * So the request goes through the ordinary lane stack instead, as a one-shot
 * non-streaming call. Auth, base URL, request shape and response parsing are
 * whatever the lane already does for that provider, which is by definition the
 * thing that works.
 *
 * Deliberately NOT a forked agent: runForkedAgent carries the parent
 * conversation for cache-key parity, which would ship an entire session's
 * history along with a "describe this screenshot" request. This is a standalone
 * two-block conversation with no prefix worth preserving.
 *
 * Everything here is best-effort: any failure returns null and the caller falls
 * back to a marker. An attachment must never break a request.
 */

import type { APIProvider } from '../../utils/model/providers.js'
import { validateProviderAuth } from '../../utils/auth.js'
import { pickVisionModel, visionFamilyFor, type VisionModelChoice } from './visionModels.js'

/** A description, not an essay. Caps both cost and the context it will occupy. */
const MAX_OUTPUT_TOKENS = 700

const PROMPT =
  'Describe this image for a software engineer who cannot see it. ' +
  'State what kind of image it is, then the layout, visible text, colours, and any ' +
  'error messages, diagrams, or UI state that matter. Be concrete and factual. ' +
  'Do not speculate about intent and do not add advice.'

export interface VisionDescribeRequest {
  mime: string
  base64: string
  signal?: AbortSignal
}

export interface VisionDescribeResult {
  text: string
  /** `provider/model`, recorded so the rendered block can attribute the description. */
  model: string
}

function debug(message: string): void {
  if (process.env.DEBUG || process.env.TAU_VISION_DEBUG) {
    // eslint-disable-next-line no-console
    console.error(`[vision] ${message}`)
  }
}

/**
 * Providers this can borrow sight from right now.
 *
 * `validateProviderAuth` rather than the provider-keys file: OAuth logins live
 * under separate keys there (`openai_oauth`, `gemini_oauth_antigravity`), so
 * listing that file's top-level keys reports "not logged in" for every provider
 * you signed into through /login rather than by pasting an API key.
 */
export function authenticatedDescriberProviders(): string[] {
  const candidates: APIProvider[] = [
    'firstParty',
    'openai',
    'antigravity',
    'gemini',
    'bedrock',
    'vertex',
  ]
  return candidates.filter(p => {
    try {
      return validateProviderAuth(p).valid
    } catch {
      return false
    }
  })
}

/** Read the user's stored choice without dragging config types into a leaf path. */
function storedChoice(): VisionModelChoice | null {
  try {
    // Required lazily: this module is reachable from converter-adjacent code
    // and must not pull config machinery in at import time.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getGlobalConfig } = require('../../utils/config.js') as {
      getGlobalConfig: () => { visionModel?: VisionModelChoice | null }
    }
    const stored = getGlobalConfig().visionModel
    if (stored?.provider && stored.model) return stored
    return null
  } catch {
    return null
  }
}

/** The describer Tau will use, or null when nothing is configured for it. */
export function resolveVisionModel(): VisionModelChoice | null {
  if (process.env.TAU_VISION_DISABLED === '1') return null
  try {
    return pickVisionModel(authenticatedDescriberProviders(), storedChoice())
  } catch {
    return null
  }
}

/** Pull plain text out of an Anthropic-shaped assistant message. */
function textFromMessage(message: unknown): string {
  const content = (message as { content?: unknown })?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(b =>
      (b as { type?: string; text?: string })?.type === 'text'
        ? ((b as { text?: string }).text ?? '')
        : '',
    )
    .join('')
    .trim()
}

/**
 * Describe an image, or return null so the caller renders its marker.
 *
 * Never throws: the caller pins whatever comes back into a process-lifetime
 * memo, and a thrown error there would leave the attachment unresolved and let
 * a later turn render different bytes for a block already sent.
 */
export async function describeImage(
  req: VisionDescribeRequest,
): Promise<VisionDescribeResult | null> {
  const choice = resolveVisionModel()
  if (!choice) return null

  // Still gated on a known family: a provider we cannot reason about should not
  // be handed an image on the assumption that its lane will cope.
  if (!visionFamilyFor(choice.provider)) {
    debug(`${choice.provider} is not a known describer family`)
    return null
  }

  const label = `${choice.provider}/${choice.model}`

  try {
    const [{ resolveRoute }, { LaneBackedProvider }] = await Promise.all([
      import('../../lanes/dispatcher.js'),
      import('../../lanes/provider-bridge.js'),
    ])

    const route = resolveRoute(choice.model)
    if (route.type !== 'native') {
      debug(`no native lane for ${label} (${route.reason})`)
      return null
    }

    const provider = new LaneBackedProvider(route.lane, choice.provider)
    const message = await provider.create({
      model: choice.model,
      system: '',
      tools: [],
      max_tokens: MAX_OUTPUT_TOKENS,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: req.mime, data: req.base64 },
            },
            { type: 'text', text: PROMPT },
          ],
        },
      ],
    } as Parameters<typeof provider.create>[0])

    const text = textFromMessage(message)
    if (!text) {
      debug(`${label} returned an empty description`)
      return null
    }
    return { text, model: label }
  } catch (error) {
    if (req.signal?.aborted) return null
    debug(`${label} failed: ${String(error)}`)
    return null
  }
}
