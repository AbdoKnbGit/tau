# Supported Providers

Tau ships **30 selectable native provider adapters**. Each speaks the provider's API directly: there's no routing proxy, no translation middleware, no shared bottleneck. Full streaming, rate-limit handling, and automatic tool-schema sanitization are wired per provider.

| Provider | Notes |
|---|---|
| Anthropic | No comment |
| OpenAI | Best in class |
| Antigravity | Saving lives from agent server overload errors |
| OpenRouter | Would use this full-time if the bills didn't care |
| Vercel AI Gateway | OpenAI-compatible AI Gateway with saved API-key login, live model browsing, automatic cache controls, and usage checks |
| Requesty | OpenAI-compatible router with saved API-key login, live model browsing, automatic cache controls, and organization usage checks |
| Command Code | 1 euro plan with a solid model pool for budget work, including Kimi 2.6, Qwen 3.7, and MiniMax 3 |
| AgentRouter | Multi-provider router with native adapter and saved login |
| Model Router | Hidden compatibility provider for lxg2it Model Router. Backend support remains wired, but it is not shown in the default provider/model pickers |
| Mistral AI | Direct Mistral and Devstral models with a generous free-trial API that is great for testing agent work |
| Moonshot AI | Direct Kimi models through Moonshot's OpenAI-compatible API, including Kimi K2.6 for coding work |
| MiniMax AI | Direct MiniMax M2 models through MiniMax's OpenAI-compatible API, with saved API-key login, live model browsing, and Token Plan usage checks |
| Alibaba | Alibaba Cloud Model Studio: Qwen plus the DeepSeek / GLM / Kimi rows it hosts, on the pay-as-you-go DashScope API. Per-model thinking ladders and context windows come from the live catalogue, not a table in Tau |
| xAI | Grok direct from xAI on its Responses API, Grok 4.7 included. Encrypted reasoning is replayed between turns and every request carries the session's cache key, so the prompt cache keeps hitting. Effort ladders, context windows and prices come from xAI's live model list |
| Meta | Muse models on Meta's Responses API, with saved API-key login, model browsing, per-model reasoning effort, prompt caching and usage checks |
| NVIDIA NIM | Gets slow under server load, especially for newest models like Kimi K2 |
| DeepSeek | Solid. V4 only — flash, pro and flash-vision-exp, all 1M context. Thinking effort is a per-model chip in `/models` |
| GLM / BigModel | Works with your BigModel plan or the small amount of free credit they give you |
| LM Studio | Local OpenAI-compatible server. Start it with `lms server start`; Tau uses `http://localhost:1234/v1` by default |
| Ollama | Local and private, but you knew that already |
| Cline | Moonshot AI's Kimi K2.6 through here is still the big win. Note: the old free tier is no longer fully free, but you still get some free credit |
| GitHub Copilot | Recommended for enterprise plans; free models are also usable for lighter work |
| KiloCode | Lots of free models and decent to try for low-cost side tasks |
| Kiro | Best performance/cost provider with large free credit |
| OpenCode Zen | deepseek-v4-flash unlimited usage |
| Xiaomi MiMo | MiMo V2.5 Pro and V2.5 direct from Xiaomi, up to 1M context. Authenticates with an `api-key` header; set `MIMO_BASE_URL` to a `token-plan-*` host for a Token Plan subscription |
| LXD API | Open-model relay billed in Xen credits (5/day free, 120/day on the $10 plan). Per-model thinking-effort ladders come straight from its catalog, and the free limited-time event rows are surfaced too |
| OpenCode Go | OpenCode Zen's Go endpoint (`opencode.ai/zen/go`), selected separately from OpenCode Zen |
| Fireworks AI | Open-model inference on Fireworks' OpenAI-compatible API (`api.fireworks.ai`), with account usage checks |
| Cloudflare Workers AI | Cloudflare's hosted open models, authenticated with your account ID and API token |
| Cline Pass | Cline's subscription pass, kept separate from the pay-as-you-go Cline row above |

## LM Studio note

Before using **LM Studio**, start its local API server first:

```bash
lms server start
```

LM Studio defaults to `http://localhost:1234/v1` in Tau. Make sure LM Studio is running and a model is loaded before you select it in `/login`.

## Local models (Ollama, LM Studio, other local servers)

Tau tunes every request it sends to a model on your machine. Hosted providers
are untouched, and so are Ollama's `:cloud` models. Every setting is an
environment variable: set it in your shell, or in the `env` block of
`~/.claude/settings.json` to keep it.

| Setting | Default | What it does |
|---|---|---|
| `OLLAMA_NUM_CTX` | `auto` | Ollama context per request. `auto` uses the context Ollama itself gives the model on your machine: Ollama picks 4K, 32K or 256K from your GPU's memory, or takes your `OLLAMA_CONTEXT_LENGTH` or the model's Modelfile, and never more than the model's own limit. When that is too small for Tau's prompt, Tau asks for the least it can work in instead, worked out from the size of its own prompt (32K with the default tools, more with many MCP tools). It never shrinks during a session, because Ollama reloads the model whenever it changes. A number fixes it. |
| `OLLAMA_NUM_CTX_MAX` | none | Instead of the context Ollama picks, `auto` grows as the conversation needs, up to this many tokens. It doubles each time, since every change reloads the model. The model's own limit still caps it. |
| `OLLAMA_KEEP_ALIVE` | `30m` | How long Ollama keeps the model loaded after a request; after that Ollama unloads it by itself. Closing Tau doesn't unload it: `ollama stop <model>` frees the GPU at once. |
| `OLLAMA_TRUNCATE` | off | Tau asks Ollama to refuse a request that doesn't fit instead of silently dropping your oldest messages. On `auto`, Tau then grows the context once and resends; past the limit you get the exact sizes and what to change. `1` brings back Ollama's silent truncation. |
| `TAU_LOCAL_MAX_OUTPUT_TOKENS` | none | Most tokens an answer may use. Tau also fits the answer to the room left in the context, so a long answer never pushes the model's instructions out. |
| `TAU_LOCAL_TEMPERATURE`, `TAU_LOCAL_TOP_P`, `TAU_LOCAL_TOP_K` | the model's own | Sampling. Unset, the model keeps its own settings: its Ollama Modelfile or its LM Studio preset. |
| `TAU_LOCAL_THINKING` | follows `/thinking` | Thinking, on any local server. `off` asks a thinking model not to think (much faster answers), `on` to think, `low`/`medium`/`high` for models that take a level. Tau sends it the way each server takes it: Ollama as `think`, to models that list thinking; LM Studio as `reasoning_effort`, within the thinking options LM Studio lists for the model; any other server (llama.cpp, vLLM, Jan) as `chat_template_kwargs.enable_thinking`, or `reasoning_effort` for a level, and without it again if the server refuses it. Unset, `/thinking on` asks for thinking the same way, and with `/thinking` off nothing is sent: each model keeps its own default. Some models think whatever they're told; with `off` they put their reasoning into the answer instead. |
| `TAU_LOCAL_PRELOAD` | on | Loads this session's prompt into a local model while you type, so the first answer doesn't wait for the model to load and read it. `0` turns it off. |

Server addresses: `OLLAMA_HOST` (default `http://localhost:11434`) and
`LMSTUDIO_BASE_URL` (default `http://localhost:1234/v1`), or set them in
`/provider`. Any other OpenAI-compatible server on your machine (llama.cpp,
vLLM, Jan) works through the LM Studio provider: point `LMSTUDIO_BASE_URL` at
it and the same settings apply.

To learn what your machine gives a model, Tau asks Ollama once per model per
session. When the model isn't loaded yet, that loads it the way any other app
would, which costs one extra load when Ollama's own context turns out too small
(about 2 seconds for a small model on an 8 GB laptop GPU). Setting
`OLLAMA_NUM_CTX` or `OLLAMA_NUM_CTX_MAX` skips the question.

A larger context needs more GPU memory. When part of an Ollama model ends up
on the CPU, which makes it answer much slower, Tau tells you once, with the
share and the context (`ollama ps` shows it too). Give Ollama
`OLLAMA_FLASH_ATTENTION=1` and `OLLAMA_KV_CACHE_TYPE=q8_0` and restart it: that
halves the context's memory, so more of the model stays on the GPU. Or switch
to `/mode cheap`, which roughly halves Tau's prompt and so the context Tau
needs, or pick a smaller model.

When a local model thinks, Tau shows its thinking as it streams, the same way
it shows other models' thinking, instead of dropping it while you wait: Ollama
sends it apart from the answer, and so do LM Studio and other servers that
split it out (`reasoning_content`). The thinking is never sent back to the
model.

Before the first answer of a session, a local model has to load and read
Tau's whole prompt: its instructions, tools and your project context, often
10,000 to 20,000 tokens. On a laptop GPU that can take 10 to 20 seconds;
every later message only reads what is new. So when an interactive session
starts on a local model (Ollama's models on your machine, LM Studio, or a
server behind LM Studio's address), Tau sends the model this session's prompt
once in the background with a one-token answer, and the model reads it while
you type. Tau waits for your MCP servers first, so the prompt is exactly the
one your first message starts with. A message you send before it is done
waits for it rather than making the model read the same prompt twice. It runs
once per model (again after `/model`), only in interactive sessions, and never
for cloud models. Its tokens show in `/cost` like any request's, at no charge,
and the context bar then shows the model's own count of the prompt.
`TAU_LOCAL_PRELOAD=0` turns it off.

The Ollama model picker takes what each model on your machine can do from
Ollama itself: tools, thinking and image input. A model that can't chat, such
as an embedding model, isn't offered. Tau's list of model names is only the
fallback for an older Ollama that doesn't report this.

Auto-compact on Ollama plans for the context the model really has, not the
size it was trained for or a 200K default. Once Tau has sent a model its first
request, it compacts the conversation at 80% of a small context (26K of 32K),
keeping room for the summary, and with the usual reserves on a large one (from
about 165K up, the same as any model that size). After compacting it restores
recently read files and skills within a share of the context, never more than
usual, so the conversation fits again. Tau calibrates its own size estimates
against the exact token counts Ollama reports. When even Tau's system prompt
and tools leave less than 8K of room in a context you fixed, compacting can't
help, so Tau doesn't try: raise `OLLAMA_NUM_CTX`, or use `/mode cheap`. Your
`/compact-settings` percentage still applies, inside that context.

LM Studio sets the context when it loads a model, and only LM Studio changes
it. Tau reads that loaded context before every request, fits each answer to
it, and auto-compact plans for it the same way as on Ollama (at 80% of a small
context), instead of the larger maximum LM Studio lists for the model. Tau
asks LM Studio for its exact token counts and calibrates its estimates with
them; a server that refuses the request for counts gets it without, from then
on. When the loaded context is too small for Tau's prompt, or a request still
doesn't fit, Tau tells you how to reload the model with a larger one. Other
servers you point the LM Studio provider at get the same answer fitting and
token counts, but compaction can plan only with LM Studio's own loaded context.

## DeepSeek thinking effort

DeepSeek V4 splits thinking across two body fields — `thinking.type` toggles it
and `reasoning_effort` sets how hard. Tau folds both onto one chip in
`/models`; use `←` / `→` on a row to cycle it:

```
deepseek-v4-pro - DeepSeek V4 Pro                        ◀ Max ▶
deepseek-v4-flash - DeepSeek V4 Flash                    ◀ Low ▶
deepseek-v4-flash-vision-exp - V4 Flash Vision (exp)     ◀ None ▶
```

`None` sends `thinking: {"type": "disabled"}` and no effort; `Low` / `High` /
`Max` send `thinking: {"type": "enabled"}` plus the matching
`reasoning_effort`. DeepSeek collapses `medium` and `xhigh` onto `high`, so
only the three distinct stops are offered.

The chip starts on `None`, which is exactly what Tau sent before it existed.
DeepSeek's own default is thinking-on at high effort — one press of `→` twice
gets you there. The pick is per model and persists in
`~/.claude/deepseek-thinking.json`.

A custom id pointed at by `DEEPSEEK_BASE_URL` shows no chip and keeps the old
behavior: the caller's thinking budget drives it, and no `reasoning_effort`
field is sent.

## LXD thinking effort

LXD publishes a different effort ladder per model, so the `/models` picker reads
each row's ladder out of the API instead of showing a fixed low/medium/high set.
Use `←` / `→` on a row to cycle it:

```
gpt-oss-120b - GPT OSS 120B                 ◀ Medium ▶   [reasoning] [tools]
deepseek-v4-pro-0813 - DeepSeek V4 PRO      ◀ Max ▶      [reasoning] [FREE]
nemotron-3-ultra - Nemotron 3 Ultra         ◀ High ▶     [reasoning] [tools]
llama-4-scout - LLaMA 4 Scout                            [tools]
```

`Default` sends no `reasoning_effort` at all and lets LXD pick. The choice is
per model and persists in `~/.claude/lxd-thinking.json`. Rows that publish no
ladder (llama-4-scout, minimax-m3) show no chip, and Tau never sends a level a
model hasn't declared.

## Alibaba Model Studio thinking effort

Qwen has three thinking knobs, not one — `enable_thinking`, `reasoning_effort`
and `thinking_budget` — and which ones a model accepts is per model. Sending
one a model does not take is a 400, so Tau never guesses: each row's ladder is
read out of the published catalogue (models.dev `reasoning_options`, the same
document Tau prices from) and rendered verbatim. Use `←` / `→` on a row in
`/models` to cycle it:

```
qwen3.8-max - Qwen3.8 Max                     ◀ xHigh ▶    [reasoning] [tools]
qwen3.7-max - Qwen3.7 Max                     ◀ Off ▶      [reasoning] [tools]
glm-5.2 - GLM 5.2                             ◀ Minimal ▶  [reasoning] [tools]
qwen3-coder-plus - Qwen3 Coder Plus                        [tools]
```

The stops differ per row because the API does:

- a **toggle + effort** row (qwen3.8-max) cycles `Default / Off` plus the
  effort values that model publishes;
- a **toggle-only** row (qwen3.7-max) cycles `Default / Off / On`;
- an **effort-only** row (glm-5.2) cycles `Default` plus its own values,
  including its own `none`;
- a row that does not reason shows no chip at all.

`Default` means no per-model override: the session's own `/thinking` setting
drives the row, through whichever fields it published. Model Studio turns
thinking ON by default on the hybrid rows, so a chip that sent nothing would
quietly bill a thinking request to someone who had turned thinking off. An
explicit pick always outranks the session budget, and the pick is per model,
persisted in `~/.claude/alibaba-thinking.json`.

`thinking_budget` is never sent: Model Studio documents it as mutually
exclusive with `reasoning_effort`, and the ladder speaks in efforts.

## Alibaba Model Studio regions

A Model Studio API key is bound to the region that issued it, and the two
pay-as-you-go regions bill differently — qwen3-coder-flash is $0.30/$1.50 per
1M internationally and $0.144/$0.574 in Beijing. `DASHSCOPE_BASE_URL` picks
the endpoint, and the same setting picks the price table `/cost` and `/usage`
report against:

```bash
# international / Singapore (default, no env var needed)
https://dashscope-intl.aliyuncs.com/compatible-mode/v1

# mainland China / Beijing
export DASHSCOPE_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
```

`/login alibaba` verifies the key against whichever endpoint is configured, so
a Beijing key pointed at the international host fails at login rather than on
your first message.

Model Studio meters spend through Alibaba Cloud billing, which an account
AccessKey pair can read and an API key cannot, so `/usage` reports connection
state and links to the console rather than inventing a balance. Per-request
cost is still computed locally from the published rates for the active region,
with cached prompt tokens billed at the cache-read rate — Model Studio's
implicit cache is always on, and Tau keeps the request prefix stable so it
actually hits.

## Xiaomi MiMo endpoints

One `MIMO_API_KEY` serves both billing surfaces — pick one with `MIMO_BASE_URL`:

```bash
# pay-as-you-go (default, no env var needed)
https://api.xiaomimimo.com/v1

# Token Plan subscription
export MIMO_BASE_URL=https://token-plan-sgp.xiaomimimo.com/v1   # or token-plan-cn
```

Both MiMo rows reason on a low / medium / high ladder (MiMo's own default is
medium); cycle it with `←` / `→` in `/models`. An explicit pick outranks the
session's thinking budget, and the choice persists in
`~/.claude/mimo-thinking.json`.

## xAI thinking effort

Each Grok row cycles its own ladder in `/models` with `←` / `→`. The ladder
comes from xAI's model list, not a fixed low/medium/high set:

| Model | Ladder | xAI's default |
|---|---|---|
| grok-4.7, grok-4.6 | low / medium / high / xhigh | high |
| grok-4.5 | low / medium / high | high |
| grok-4.3 | none / low / medium / high | not published |
| grok-build-0.1, grok-4.20-0309-reasoning | always reasons, no chip | — |
| grok-4.20-0309-non-reasoning | does not reason, no chip | — |

`Default` means no per-model pick. If the session's `/effort` is a level on
that row's ladder, it drives the row. Otherwise no `reasoning.effort` is sent
and xAI applies its own default. Tau never sends a level a model hasn't
declared, so grok-4.5 has no `xhigh` (xAI treats it as `high` there). An
explicit pick outranks the session setting. Picks are per model and persist
in `~/.claude/xai-thinking.json`.

## xAI login, regions and usage

```bash
# global endpoint (default, no env var needed)
https://api.x.ai/v1

# US regional endpoint, billed at 1.1x
export XAI_BASE_URL=https://us.api.x.ai/v1
```

`/login xai` saves the API key and checks it against xAI's `/v1/api-key`
endpoint, so a rejected, disabled or blocked key fails at login rather than on
your first message. A second, optional step takes a management key (console.x.ai
→ Settings → Management Keys). xAI only exposes billing through that key; press
Esc to skip. `/logout xai` removes both keys. The environment variables
`XAI_API_KEY` and `XAI_MANAGEMENT_API_KEY` work too.

`/usage` shows the key's state and this session's spend as billed by xAI
(every response carries its own cost). With a management key it also shows
prepaid credits, the postpaid invoice against your spending limit, and
month-to-date spend per model.

`/cost` prices each request from the same live model list `/models` reads. If a
request's prompt reaches 200k tokens, every token in it is billed at the
long-context rate, and the US endpoint adds its 1.1x multiplier.

xAI's prompt cache only hits on an identical prefix, so Tau keeps the prefix
stable:

- every request carries the session id as `prompt_cache_key` and
  `x-grok-conv-id`
- the instructions and tool list stay byte-identical between turns
- every tool, MCP tools included, is sent up front; tools from a server that
  connects later are appended, never reordered in
- requests go out with `store: false`, and earlier turns' encrypted reasoning
  is replayed in place

If xAI rejects an MCP tool's schema, Tau drops that one tool and retries
instead of failing every turn.

## Switching providers mid-session

Hit a rate limit, run out of credit, or want to compare outputs? Type `/login` or `/models` at any time. Tau swaps the active provider without ending the session: your conversation, file context, and tool history stay intact. The new provider just picks up where the last one left off.
