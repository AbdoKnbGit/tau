import { getLocalMonthYear } from 'src/constants/common.js'

export const WEB_SEARCH_TOOL_NAME = 'WebSearch'

export const WEB_SEARCH_AUTO_USE_GUIDANCE =
  'Use WebSearch automatically, without waiting for the user to say "websearch", when the request depends on current, live, recent, or changing public web information. This includes weather today/now, news, current events, prices, exchange rates, sports scores, schedules, availability, laws/regulations, product details, recent releases, latest documentation, status pages, and facts likely to have changed after the model knowledge cutoff. If enough context is present, search with the best reasonable interpretation and state any assumption in the answer instead of asking the user to search manually.'

export const WEB_SEARCH_NATIVE_DESCRIPTION =
  'Search the web for current, live, recent, or changing public information and return answerable results with source URLs. Use automatically for weather today/now, news, prices, exchange rates, sports, schedules, availability, laws/regulations, product details, recent releases, latest documentation, and facts likely to have changed after the model knowledge cutoff. Do not tell the user to search manually when this tool can answer.'

export function getWebSearchPrompt(): string {
  const currentMonthYear = getLocalMonthYear()
  return `
- Allows the agent to search the web and use the results to inform responses
- Provides up-to-date information for current events and recent data
- Returns search result information formatted as search result blocks, including links as markdown hyperlinks
- Use this tool for accessing information beyond the model knowledge cutoff
- Searches are performed automatically within a single API call

Automatic use policy:
  - ${WEB_SEARCH_AUTO_USE_GUIDANCE}
  - Do not answer "I cannot access live information" or give manual search instructions when WebSearch is available and the requested information is public on the web. Call WebSearch first, then answer from the results.
  - Do not use WebSearch for stable general knowledge, local codebase/file questions, private account data, or questions the user explicitly says not to search.

CRITICAL REQUIREMENT - You MUST follow this:
  - After answering the user's question, you MUST include a "Sources:" section at the end of your response
  - In the Sources section, list all relevant URLs from the search results as markdown hyperlinks: [Title](URL)
  - This is MANDATORY - never skip including sources in your response
  - Example format:

    [Your answer here]

    Sources:
    - [Source Title 1](https://example.com/1)
    - [Source Title 2](https://example.com/2)

Usage notes:
  - WebSearch is provider-neutral. Always call the WebSearch tool with its documented input schema; do not pass provider-specific fields or Firecrawl API fields.
  - Search results can include extracted page excerpts. When excerpts contain the answer, answer directly from them and cite the source URLs; do not return only a list of links.
  - Domain filtering is supported to include or block specific websites
  - Domain filters must be plain hostnames only, for example "example.com" or "docs.example.com", not URLs, paths, or wildcards
  - Web search is only available in the US

IMPORTANT - Use the correct year in search queries:
  - The current month is ${currentMonthYear}. You MUST use this year when searching for recent information, documentation, or current events.
  - Example: If the user asks for "latest React docs", search for "React documentation" with the current year, NOT last year
`
}
