# OpenAI effort settings (#40)

## Investigation

The settings schema discarded `xhigh` and `max` for external users. The persistence helper also discarded them. The valid values `low`, `medium` and `high` survived settings parsing, but OpenAI requests still ignored them because the picker maintained a separate process-wide effort value.

The issue's description of the native fallback was incomplete: the Codex lane could omit reasoning or derive a level from an Anthropic thinking budget, as well as choose medium. Fixing only the initial medium value would leave CLI overrides, `/effort`, agents and the picker disconnected.

## Behavior

- Persist `none`, `low`, `medium`, `high`, `xhigh` and `max` for every user. Load them through the existing merged settings cascade. `none` explicitly disables reasoning on supported OpenAI models; it is distinct from auto/unset and clamps to the lowest supported effort on other models.
- Resolve environment overrides first, then request-scoped choices (including CLI, picker and agent state), then the session/settings fallback. Explicit auto/unset omits the effort field and lets the server choose its default.
- Use the same effort resolver for native Codex, legacy OpenAI Chat Completions/Responses, and the displayed level. Anthropic thinking budgets no longer select a separate OpenAI effort.
- Clamp unsupported levels when creating a request without modifying the saved preference. Capability rules are shared with the picker and normalize OpenAI prefixes and model versions. The API supports different effort subsets for different models; see [OpenAI's reasoning guide](https://developers.openai.com/api/docs/guides/reasoning), [GPT-5](https://developers.openai.com/api/docs/models/gpt-5), and [GPT-5.2 Pro](https://developers.openai.com/api/docs/models/gpt-5.2-pro).
- Keep picker previews local until selected. A canceled picker cannot change another request. Surf agents carry their effort in their own request state rather than changing the parent's global preference.
- Load settings at request time for standalone transports. This avoids an initialization cycle through the provider subclasses.

### GPT-6.1 Terra

The OpenAI lane lists `gpt-6.1-terra` with a 1,050,000-token context window, a 922,000-token input ceiling, and 128,000 tokens reserved for output. The input ceiling is available before any model catalog has been downloaded. Reasoning options are `none`, `low`, `medium` (server default), `high`, `xhigh`, and `max`, including the picker, `/effort`, `--effort`, and request-scoped agent settings. Tool calls use Responses with both API-key and ChatGPT authentication. These values were checked on 2026-11-10 against [models.dev](https://models.dev/api.json) and the [official model page](https://developers.openai.com/api/docs/models/gpt-6.1-terra).

Terra regression tests cover HTTP and WebSocket cache affinity, stable prompt/tool bytes, persisted encrypted reasoning, and model-switch isolation. They intercept transports locally and do not establish a live backend cache-hit rate.

## Cache and portability

Effort stays in its native request field. It is not added to instructions, conversation content, tools, or cache keys. Tests verify identical requests for repeated settings and unchanged prompt/tool/cache fields when only effort changes. Native requests resolve asynchronous settings before selecting the singleton client's cache session, preventing concurrent sessions from taking each other's cache keys.

The implementation uses the existing settings paths and cache invalidation. Tests use Node temporary directories and platform-independent path utilities. The new suite runs in the existing Windows/macOS/Linux, Node 20/22 CI matrix. Local execution was on Windows; remote matrix results are not yet available.

## Verification

- 26 new bundled regression tests plus 16 native-routing tests passed.
- The 46 Codex lane tests and 10 legacy-provider tests passed using the production esbuild configuration. Direct Bun execution is unavailable in this checkout because `src/entrypoints/sdk/runtimeTypes.js` is missing; the normal production build supplies its existing shim.
- An initial regression suite failed 14 tests against the previous bundle, confirming the persistence and resolution defects.
- Live ChatGPT OAuth requests to `gpt-6-luna` succeeded for all five effort levels. Each returned HTTP 200, echoed the requested effort, and produced the expected `OK` response. The check used an in-memory settings snapshot and did not edit user settings. Node needed `--use-system-ca` for this machine's certificate chain; certificate verification remained enabled.

The live check confirms acceptance and routing of effort values. It does not measure reasoning quality or prove a particular backend cache-hit rate. The unspecified error in the issue comment cannot be identified without its error text.

After a build, run the portable regression suite with:

```sh
node --test test/openai-effort.test.mjs test/openai-native-routing.test.mjs
```
