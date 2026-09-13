# Direct provider model metadata

Verified 2026-09-13 against the supplied `models.dev-dev` and `opencode-dev`
checkouts, the live models.dev catalog, and official provider documentation.

`/models` requests the selected provider's model list. When that endpoint only
returns IDs, models.dev supplies model-specific names, context windows, output
limits and reasoning options. If the endpoint is unavailable, the metadata
catalog supplies the list. Unknown live IDs remain usable, but do not get
invented context sizes or thinking controls. A `max_tokens` field is an output
limit and is never interpreted as a context window.

Metadata refreshes daily and is persisted in
`~/.config/claude-code/direct-models.json`. The bundled `directProviderSeed.json`
contains 46 resolved first-party rows from the supplied local reference, including
inherited lab limits. It supplies an offline first-run fallback. Regional and
coding-plan endpoints select their corresponding models.dev provider surface.
Essential-traffic mode disables the models.dev request.

The picker displays exact token counts and uses left/right arrows to cycle only
the model's supported settings. Choices persist per provider and model in
`~/.claude/direct-provider-thinking.json`; DeepSeek retains its existing store.
Text searches (`/models <provider>`) display context and supported thinking choices.

| Native model | Context tokens | Thinking choices |
| --- | ---: | --- |
| DeepSeek V4.1 Flash (`deepseek-flash`) | 1,000,000 | None / Low / High / Max |
| GLM-5.3, GLM-5.3-Flash | 1,000,000 | Low / High / Max |
| GLM-5.2 | 1,000,000 | High / Max |
| Kimi K3 | 1,048,576 | Low / High / Max |
| Kimi K2.7 Code / Highspeed | 262,144 | Always on |
| Kimi K2.6 | 262,144 | Off / On |
| MiniMax M3 | 1,000,000 | Off / On |
| MiniMax M2.x | 204,800 | Always on |

Two explicit corrections take precedence over models.dev for native Chat Completions:

- Kimi K3 always reasons and uses top-level `reasoning_effort`. The local catalog's
  toggle and `output_config.effort` comment do not describe this transport's current API.
- MiniMax M3's hosted OpenAI endpoint documents 1,000,000 context tokens; the local
  catalog has 1,048,576. Explicit context metadata from a live provider response
  takes precedence over both fallback values.

GLM and Moonshot replay reasoning on tool calls **and** final assistant answers.
GLM preserved thinking uses `clear_thinking: false` for its supporting generations.
MiniMax keeps its native `<think>...</think>` content intact; split reasoning output
is not requested. Its output ceiling is model-specific (131,072 for M2.x, 512,000
for M3), replacing the obsolete 2,048-token cap. MiniMax streaming requests include
usage so automatic cache hits can be reported.

GLM, Moonshot and MiniMax pin the dynamic system snapshot at a stable position for
the session, while subsequent user/tool turns extend history. Both native and legacy
transports use these contracts. DeepSeek's cache/history transformer is unchanged;
only its new Flash alias is recognized by the existing effort selector.

Official references:

- [DeepSeek thinking controls](https://api-docs.deepseek.com/guides/thinking_mode/)
- [GLM-5.3](https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3)
- [GLM thinking and preserved thinking](https://docs.bigmodel.cn/cn/guide/capabilities/thinking)
- [Kimi reasoning effort](https://platform.kimi.ai/docs/guide/use-reasoning-effort)
- [Kimi model availability and retirements](https://platform.kimi.ai/docs/models)
- [Kimi context caching](https://platform.kimi.ai/docs/guide/use-context-caching-feature-of-kimi-api)
- [MiniMax OpenAI API, limits and reasoning replay](https://platform.minimax.io/docs/api-reference/text-openai-api)
- [MiniMax automatic caching](https://platform.minimax.io/docs/api-reference/text-prompt-caching)

Regression coverage: `bun test src/lanes/openai-compat/direct_providers.test.ts`.
It checks exact contexts, thinking selection and payloads, offline/live discovery,
output caps, cache accounting, tool adjacency, and consecutive request prefixes
through both transports. Tests mock inference; they do not measure paid live cache
hit rates, which remain controlled by the provider's cache lifetime and routing.
