# Supported Providers

Tau ships **25 selectable native provider adapters**, plus hidden Model Router compatibility support. Each speaks the provider's API directly — there's no routing proxy, no translation middleware, no shared bottleneck. Full streaming, rate-limit handling, and automatic tool-schema sanitization are wired per provider.

| Provider | Notes |
|---|---|
| Anthropic | No comment |
| OpenAI | Best in class |
| Google Gemini | Use your own account — some server configs block certain regions. Currently Gemini servers are throwing 429 in some regions; see [google-gemini/gemini-cli issues](https://github.com/google-gemini/gemini-cli/issues) |
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
| NVIDIA NIM | Gets slow under server load, especially for newest models like Kimi K2 |
| DeepSeek | Solid |
| GLM / BigModel | Works with your BigModel plan or the small amount of free credit they give you |
| LM Studio | Local OpenAI-compatible server. Start it with `lms server start`; Tau uses `http://localhost:1234/v1` by default |
| Ollama | Local and private, but you knew that already |
| Cline | Moonshot AI's Kimi K2.6 through here is still the big win. Note: the old free tier is no longer fully free, but you still get some free credit |
| GitHub Copilot | Recommended for enterprise plans; free models are also usable for lighter work |
| Cursor | Peak performance on Plan mode |
| KiloCode | Lots of free models and decent to try for low-cost side tasks |
| Kiro | Best performance/cost provider with large free credit |
| OpenCode Zen | deepseek-v4-flash unlimited usage |
| OpenCode Go | Direct OpenCode Go access with per-model thinking-effort controls |
| Fireworks AI | $10 in free credit |

## LM Studio note

Before using **LM Studio**, start its local API server first:

```bash
lms server start
```

LM Studio defaults to `http://localhost:1234/v1` in Tau. Make sure LM Studio is running and a model is loaded before you select it in `/login`.

## Switching providers mid-session

Hit a rate limit, run out of credit, or want to compare outputs? Type `/login` or `/models` at any time. Tau swaps the active provider without ending the session — your conversation, file context, and tool history stay intact. The new provider just picks up where the last one left off.
