# Supported Providers

Tau ships **25 native provider adapters**. Each speaks the provider's API directly: there's no routing proxy, no translation middleware, no shared bottleneck. Full streaming, rate-limit handling, and automatic tool-schema sanitization are wired per provider.

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

## LM Studio note

Before using **LM Studio**, start its local API server first:

```bash
lms server start
```

LM Studio defaults to `http://localhost:1234/v1` in Tau. Make sure LM Studio is running and a model is loaded before you select it in `/login`.

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

## Switching providers mid-session

Hit a rate limit, run out of credit, or want to compare outputs? Type `/login` or `/models` at any time. Tau swaps the active provider without ending the session: your conversation, file context, and tool history stay intact. The new provider just picks up where the last one left off.
