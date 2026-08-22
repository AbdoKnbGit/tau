import { getLocalMonthYear } from 'src/constants/common.js'

export const WEB_SEARCH_TOOL_NAME = 'WebSearch'

export const WEB_SEARCH_AUTO_USE_GUIDANCE =
  'Use WebSearch automatically when an answer depends on current or changing public information (for example news, weather, prices, schedules, laws, product availability, releases, or latest documentation). Search with a reasonable stated assumption instead of asking the user to search manually.'

export const WEB_SEARCH_NATIVE_DESCRIPTION =
  'Search current or changing public web information and return answerable results with source URLs. Use automatically when live information is required.'

export function getWebSearchPrompt(): string {
  const currentMonthYear = getLocalMonthYear()
  return `${WEB_SEARCH_AUTO_USE_GUIDANCE} Do not search stable general knowledge, local files, private-account data, or when the user says not to search. Use only the documented provider-neutral fields. Domain filters are plain hostnames, never URLs, paths, or wildcards. Answer from useful excerpts instead of returning only links, then end with a Sources section containing relevant [Title](URL) links. Web search is US-only. Current month: ${currentMonthYear}; use its year for recent/latest queries.`
}
