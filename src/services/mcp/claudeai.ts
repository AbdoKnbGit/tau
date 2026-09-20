import axios from 'axios'
import memoize from 'lodash-es/memoize.js'
import { getOauthConfig } from 'src/constants/oauth.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import { getClaudeAIOAuthTokens } from 'src/utils/auth.js'
import { getGlobalConfig, saveGlobalConfig } from 'src/utils/config.js'
import { logForDebugging } from 'src/utils/debug.js'
import { isEnvDefinedFalsy } from 'src/utils/envUtils.js'
import { clearMcpAuthCache } from './client.js'
import { normalizeNameForMCP } from './normalization.js'
import type { ScopedMcpServerConfig } from './types.js'

type ClaudeAIMcpServer = {
  type: 'mcp_server'
  id: string
  display_name: string
  url: string
  created_at: string
}

type ClaudeAIMcpServersResponse = {
  data: ClaudeAIMcpServer[]
  has_more: boolean
  next_page: string | null
}

// Per-request timeout. The whole listing is bounded separately by
// TOTAL_FETCH_BUDGET_MS, so a paginated list cannot multiply this by the
// page count and stall startup for a minute.
const FETCH_TIMEOUT_MS = 5000
const TOTAL_FETCH_BUDGET_MS = 15_000
const CONNECTOR_PAGE_SIZE = 1000
const MAX_CONNECTOR_PAGES = 20
const MCP_SERVERS_BETA_HEADER = 'mcp-servers-2025-12-04'

/**
 * Fetches MCP server configurations from Claude.ai org configs.
 * These servers are managed by the organization via Claude.ai.
 *
 * Results are memoized for the session lifetime (fetch once per CLI session).
 */
export const fetchClaudeAIMcpConfigsIfEligible = memoize(
  async (): Promise<Record<string, ScopedMcpServerConfig>> => {
    try {
      if (isEnvDefinedFalsy(process.env.ENABLE_CLAUDEAI_MCP_SERVERS)) {
        logForDebugging('[claudeai-mcp] Disabled via env var')
        logEvent('tengu_claudeai_mcp_eligibility', {
          state:
            'disabled_env_var' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
        return {}
      }

      const tokens = getClaudeAIOAuthTokens()
      if (!tokens?.accessToken) {
        logForDebugging('[claudeai-mcp] No access token')
        logEvent('tengu_claudeai_mcp_eligibility', {
          state:
            'no_oauth_token' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
        return {}
      }

      // Check for user:mcp_servers scope directly instead of isClaudeAISubscriber().
      // In non-interactive mode, isClaudeAISubscriber() returns false when ANTHROPIC_API_KEY
      // is set (even with valid OAuth tokens) because preferThirdPartyAuthentication() causes
      // isAnthropicAuthEnabled() to return false. Checking the scope directly allows users
      // with both API keys and OAuth tokens to access claude.ai MCPs in print mode.
      if (!tokens.scopes?.includes('user:mcp_servers')) {
        logForDebugging(
          `[claudeai-mcp] Missing user:mcp_servers scope (scopes=${tokens.scopes?.join(',') || 'none'})`,
        )
        logEvent('tengu_claudeai_mcp_eligibility', {
          state:
            'missing_scope' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
        return {}
      }

      const baseUrl = getOauthConfig().BASE_API_URL

      // Follow has_more/next_page. `limit=1000` is a page size, not a promise
      // that one page is the whole list: an org past that many connectors had
      // the rest silently missing.
      const servers: ClaudeAIMcpServer[] = []
      const listingDeadline = Date.now() + TOTAL_FETCH_BUDGET_MS
      let page: string | undefined
      for (let requests = 1; ; requests++) {
        const url =
          `${baseUrl}/v1/mcp_servers?limit=${CONNECTOR_PAGE_SIZE}` +
          (page ? `&page=${encodeURIComponent(page)}` : '')

        logForDebugging(`[claudeai-mcp] Fetching from ${url}`)

        const response = await axios.get<ClaudeAIMcpServersResponse>(url, {
          headers: {
            Authorization: `Bearer ${tokens.accessToken}`,
            'Content-Type': 'application/json',
            'anthropic-beta': MCP_SERVERS_BETA_HEADER,
            'anthropic-version': '2023-06-01',
          },
          timeout: FETCH_TIMEOUT_MS,
        })
        servers.push(...response.data.data)

        const next = response.data.next_page
        // Bounded, and a repeated page token ends the loop rather than
        // spinning on it: the cursor comes from the server.
        const outOfBudget = Date.now() >= listingDeadline
        if (
          !response.data.has_more ||
          !next ||
          next === page ||
          requests >= MAX_CONNECTOR_PAGES ||
          outOfBudget
        ) {
          if (response.data.has_more && (outOfBudget || requests >= MAX_CONNECTOR_PAGES)) {
            logForDebugging(
              `[claudeai-mcp] Stopped after ${requests} page(s) with ${servers.length} server(s); listing is incomplete`,
            )
          }
          break
        }
        page = next
      }

      const configs: Record<string, ScopedMcpServerConfig> = {}
      // Track used normalized names to detect collisions and assign (2), (3), etc. suffixes.
      // We check the final normalized name (including suffix) to handle edge cases where
      // a suffixed name collides with another server's base name (e.g., "Example Server 2"
      // colliding with "Example Server! (2)" which both normalize to claude_ai_Example_Server_2).
      const usedNormalizedNames = new Set<string>()

      for (const server of servers) {
        const baseName = `claude.ai ${server.display_name}`

        // Try without suffix first, then increment until we find an unused normalized name
        let finalName = baseName
        let finalNormalized = normalizeNameForMCP(finalName)
        let count = 1
        while (usedNormalizedNames.has(finalNormalized)) {
          count++
          finalName = `${baseName} (${count})`
          finalNormalized = normalizeNameForMCP(finalName)
        }
        usedNormalizedNames.add(finalNormalized)

        configs[finalName] = {
          type: 'claudeai-proxy',
          url: server.url,
          id: server.id,
          scope: 'claudeai',
        }
      }

      logForDebugging(
        `[claudeai-mcp] Fetched ${Object.keys(configs).length} servers`,
      )
      logEvent('tengu_claudeai_mcp_eligibility', {
        state:
          'eligible' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
      return configs
    } catch {
      logForDebugging(`[claudeai-mcp] Fetch failed`)
      return {}
    }
  },
)

/**
 * Clears the memoized cache for fetchClaudeAIMcpConfigsIfEligible.
 * Call this after login so the next fetch will use the new auth tokens.
 */
export function clearClaudeAIMcpConfigsCache(): void {
  fetchClaudeAIMcpConfigsIfEligible.cache.clear?.()
  // Also clear the auth cache so freshly-authorized servers get re-connected
  clearMcpAuthCache()
}

/**
 * Record that a claude.ai connector successfully connected. Idempotent.
 *
 * Gates the "N connectors unavailable/need auth" startup notifications: a
 * connector that was working yesterday and is now failed is a state change
 * worth surfacing; an org-configured connector that's been needs-auth since
 * it showed up is one the user has demonstrably ignored.
 */
export function markClaudeAiMcpConnected(name: string): void {
  saveGlobalConfig(current => {
    const seen = current.claudeAiMcpEverConnected ?? []
    if (seen.includes(name)) return current
    return { ...current, claudeAiMcpEverConnected: [...seen, name] }
  })
}

export function hasClaudeAiMcpEverConnected(name: string): boolean {
  return (getGlobalConfig().claudeAiMcpEverConnected ?? []).includes(name)
}
