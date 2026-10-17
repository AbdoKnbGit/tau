/**
 * Meta Model API account reads for /login and /usage.
 *
 * Meta documents no endpoint that describes a key, a balance or spend: the
 * Model API dashboard's Usage and Billing pages are the only place either is
 * shown (dev.meta.ai/docs/muse-code/auth). What an API key can prove is that
 * it authenticates: `GET /v1/models` answers 401 `invalid_api_key` for a
 * missing or bad key, and lists the models the key may call otherwise.
 *
 * Dependency-light on purpose: ProviderLoginFlow imports it.
 */

export const META_DASHBOARD_URL = 'https://dev.meta.ai'
export const META_USAGE_URL = `${META_DASHBOARD_URL}/usage`
export const META_BILLING_URL = `${META_DASHBOARD_URL}/billing`
export const META_DEFAULT_API_BASE_URL = 'https://api.meta.ai/v1'

const TIMEOUT_MS = 10_000

/**
 * The Meta API key the environment holds. META_API_KEY is what Meta's own CLI
 * (Muse Code) reads, META_MODEL_API_KEY is models.dev's name for it, and
 * Meta's API docs export MODEL_API_KEY — generic enough to hold another
 * vendor's key, so it counts only in Meta's `LLM_<id>_<secret>` shape.
 */
export function metaApiKeyFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = (raw: string | undefined): string | undefined => raw?.trim() || undefined
  const generic = value(env.MODEL_API_KEY)
  return value(env.META_API_KEY)
    ?? value(env.META_MODEL_API_KEY)
    ?? (generic?.startsWith('LLM_') ? generic : undefined)
}

export function metaBaseUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return env.META_BASE_URL?.trim() || META_DEFAULT_API_BASE_URL
}

/** The message in Meta's `{"error":{"message","type","param","code"}}` envelope. */
export function metaAccountErrorText(body: unknown, fallback: string): string {
  const error = (body as { error?: unknown } | null)?.error
  if (error && typeof error === 'object') {
    const { message, code } = error as { message?: unknown; code?: unknown }
    const text = typeof message === 'string' ? message.trim() : ''
    const tag = typeof code === 'string' && code.trim() ? code.trim() : ''
    if (text && tag && !text.includes(tag)) return `${text} (${tag})`
    if (text || tag) return text || tag
  }
  return fallback
}

export type MetaKeyCheck =
  | { ok: true; modelIds: string[] }
  | { ok: false; status: number; message: string }

/** Whether `apiKey` authenticates, and which models it may call. */
export async function checkMetaApiKey(apiKey: string, baseUrl: string): Promise<MetaKeyCheck> {
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/models`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const body = await response.json().catch(() => null) as { data?: unknown } | null
    if (!response.ok) {
      return { ok: false, status: response.status, message: metaAccountErrorText(body, `HTTP ${response.status}`) }
    }
    const modelIds = Array.isArray(body?.data)
      ? body.data
          .map(row => (row && typeof row === 'object' ? (row as { id?: unknown }).id : undefined))
          .filter((id): id is string => typeof id === 'string' && id.length > 0)
      : []
    return { ok: true, modelIds }
  } catch (error) {
    return { ok: false, status: 0, message: error instanceof Error ? error.message : String(error) }
  }
}
