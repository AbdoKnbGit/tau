<p align="center">
  <img src="Logo.png" alt="Tau logo" width="120">
</p>

# The True Free Claude Code

[![npm version](https://img.shields.io/npm/v/%40abdoknbgit%2Ftau.svg)](https://www.npmjs.com/package/@abdoknbgit/tau)
[![npm downloads](https://img.shields.io/npm/dm/%40abdoknbgit%2Ftau.svg)](https://www.npmjs.com/package/@abdoknbgit/tau)
[![License](https://img.shields.io/npm/l/%40abdoknbgit%2Ftau.svg)](https://www.npmjs.com/package/@abdoknbgit/tau)





---

## What is Tau?

Tau is the true free Claude Code agent. It gives you a full agentic Claude Code environment - tools, MCP servers, hooks, skills, file editing, shell execution, and session control - without locking you into one paid route.

It is not a proxy and not a wrapper around someone else's wrapper. Tau has native adapters for 19 providers, built to make them work directly inside your agentic Claude Code environment. When you use Gemini, Tau speaks Gemini's API directly. Same for OpenAI, GLM, DeepSeek, Mistral, OpenRouter, AgentRouter, MiniMax, and the rest.

You install it once. You type `/login`. You pick a provider. You work.

That's it: plug and play with one command and one login flow. No shell configuration. No export statements. No environment variable archaeology. A first-run wizard handles credentials and saves them. Cross-platform — Windows, macOS, Linux.

---

## Why does this exist?

Because Anthropic rate limits are real, and sometimes you just want to say hi to your terminal without getting a 429 back.

Tau lets you swap providers mid-session. Anthropic giving you the cold shoulder? Switch to Kimi K2.6. Still need the agent loop, the file editing, the bash execution, the MCP servers, the hooks? You have all of it. Nothing changes except who's doing the thinking.

And here's the part that actually matters: you can work with any provider - Codex CLI, Gemini CLI, Antigravity, Cline, Cursor, KiloCode, Kiro, GitHub Copilot - without any of them installed on your machine. Not downloaded, not configured, not even present. Tau brings the runtime. You bring the auth most of them or API key.

That's the point. Same experience. Different brain. Zero dependencies on the original tool.

---

## Install

```bash
npm install -g @abdoknbgit/tau
```

**Requirements:** Node.js >= 20.0.0, Git, Bash, gh for GitHub automation

---

## Launch

```bash
tau
```

Launch with skip permission mode:

```bash
tau --dangerously-skip-permissions
```

---
## Update

```bash
tau update
```

<p align="center">
  <img src="tau_docs.PNG" alt="Tau docs" width="720">
</p>
<video src="https://github.com/user-attachments/assets/07862fa1-5f0f-4027-97e7-9e147d74f999" controls width="100%"></video>
---
## The Commands You Need to Know

### Auth

**`/login` - Start here**
Pick a provider, enter your credentials, and Tau saves the setup. No env variables, no config hunt.

Before using **LM Studio**, start its local API server first:

```bash
lms server start
```

LM Studio defaults to `http://localhost:1234/v1` in Tau. Make sure LM Studio is running and a model is loaded before you select it in `/login`.

### Models

**`/models` - Pick your model**
Live model browser. Fetches the real catalog from your provider API, lets you search, filter, and set the active model.

```
/models                     open the full picker
/models <query>             search active provider
/models openrouter:kimi     search a specific provider
/model kimi-k2-5            set a model directly
```

### Web Search

**`WebSearch` - Firecrawl-hosted web search**
The `web_search` tool is hosted with Firecrawl and works across providers. Firecrawl offers 1k searches/month on free trials; just enter your API key.

Setup is one step: `/login` -> **Firecrawl Search** -> paste your Firecrawl API key. After that, agents can search current web information automatically when a question needs live or recent data.

### Voice

**`/hey` - Start a voice conversation**
Turns on voice conversation mode. Hold Space to talk, release to send, and Tau shows what it heard before submitting.

**`/bye` - End the voice conversation**
Turns voice conversation mode off and stops any spoken reply that is still playing.

### Session

**`/tree` - Navigate the session graph**
Move through your conversation history like nodes, so branches and forks stay understandable.

**`/clone` - Clone the session**
Create a copy of the current session when you want a backup or a clean duplicate to continue from.

**`/branch` - Open a fork**
Start a fork from the current point in the session without losing the original path.

**`/resume` - Continue later**
Resume the last useful session or pick an older one when you want to continue where you left off.

### Monitoring and Reporting

**`/usage` - Watch provider usage**
Shows real streaming provider usage as it happens, so you can see provider consumption while working.

**`/statistics` - Review the current session**
Shows statistics for the active session, including session activity and tool-call details.

**`/report` - Generate a final report**
Creates a clean content report for the session in Markdown, PDF, or HTML. This is for readable session quality, not usage statistics.

### Features

**`/fallback` - Recover automatically**
Automatic recovery when a model fails mid-session. Configure a fallback and keep working through provider outages.

**`/dangerously-skip-permissions` - Skip permission prompts in a trusted sandbox**
Session-only Bypass Permissions mode. Tau shows a warning before enabling it, permission prompts include the same session option, and `/dangerously-skip-permissions off` returns to Default mode.

Launch Tau directly in this mode:

```bash
tau --dangerously-skip-permissions
```

**`/whatsapp` - Remote control Tau from WhatsApp**
Link WhatsApp and control Tau from your phone.

**`/github` - GitHub automation (gh required)**
GitHub workflows inside Tau, powered by the GitHub CLI.

- `issue` - Inspect issues for the current repo, or pass an issue URL to inspect that issue.
- `pr` - Inspect pull requests (repo-local or via PR URL) and generate gh-backed actions.
- `wrap` - Stage → commit → (optional changelog) → push, with one permission gate before network writes.
- `changelog` - Generate/update changelog notes from commit history in a consistent style.
- `triage` - Classify issues (labels/status) with explicit confirmation before visible changes.
- `release` - Release flow: inspect dirty working tree, check CI/CD workflow status, then tag/publish and list runs.

**`/safetest` - Run a file inside a disposable cloud sandbox**
Upload one file to a fresh E2B VM, run it there, get a clean report back. The local machine never executes anything. Each run gets its own throwaway sandbox that's destroyed at the end.

Setup is one step: `/login` → **E2B Security** → pick "Auth login" (opens the E2B dashboard in your browser) or "API key" (just paste). After that, `/safetest` is ready — no env variables, no extra config.

**`/pin` - Pin a constraint to every prompt**
Save a sentence (or two) and Tau quietly appends it to the end of every message you send — a persistent reminder the model carries through the whole session without you retyping it. Use it for style rules ("reply in French"), guardrails ("never edit files outside `src/`"), or task focus ("stay on the auth refactor"). Cache-safe by design: only the dynamic tail of the user message changes, so your provider's prompt cache stays warm and the cost is a few extra tokens per turn.



---

## Supported Providers

| Provider | Notes |
|---|---|
| Anthropic | No comment |
| OpenAI | Best in class, but GPT-5.5 is paywalled behind Plus/Pro |
| Google Gemini | Use your own account — some server configs block certain regions-currently gemini servers are not working and giving some error 429 u can check here https://github.com/google-gemini/gemini-cli/issues |
| Antigravity | Saving lives from agent server overload errors |
| OpenRouter | Would use this full-time if the bills didn't care |
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
| AgentRouter | Includes free $125 usage. Latency is server-side, and the API still has issues. claude_haiku is currently the only model I made work well. For AgentRouter only, Windows is currently supported; Linux and macOS support is being worked on |

---

## Features

**Multi-provider, natively**
19 providers with native adapters. Not a routing layer, not a translation proxy — each provider speaks its own API through its own adapter. Full streaming, rate-limit handling, and automatic tool schema sanitization per provider.

**The full agent loop**
File editing, bash execution, glob, grep, web search, web fetch, MCP servers, hooks (PreToolUse, PostToolUse, UserPromptSubmit, Stop, Notification), skills (/commit, /review-pr, /simplify), and task management — all present, all working across every provider.

**web_search tool**
Firecrawl provides 1k searches/month free for deep searching. Just enter your API key through `/login` -> **Firecrawl Search**.

**Voice conversation**
Use `/hey` to start a voice conversation and `/bye` to end it. Tau can listen, transcribe what you said, send it as your prompt, and optionally speak replies back.

**WhatsApp remote control**
Use `/whatsapp` to link WhatsApp and remotely control Tau from your phone.

**GitHub automation and repo management**
The `/github` command brings common GitHub work into Tau through `gh`: inspect issues and pull requests, review repo state, triage labels/status, generate changelog notes, run wrap-up flows for stage/commit/push, and inspect workflow or release status before publishing changes.

**Scalable context across providers**
Tau adapts context windows when switching between models and providers, so larger-context models can carry more history while smaller-context models stay usable.

**Fallback recovery**
A configurable fallback system can move work to another model/provider when the current one fails or overloads.

**Session management and flexibility**
Tree navigation, cloning, branching, and resume commands make long sessions easier to control without losing context.

**High-visibility monitoring and reporting**
Tau separates live usage, session statistics, and final reports, so you can monitor consumption while still producing readable end-of-session summaries.

---

## Coming Soon

**`/surf`** - Intelligent model routing. Tau reads the task and routes to the best available model automatically. Experimental, in progress.

**`tau-vscode`** - VS Code extension. Provider switching from the command palette, Control Center webview, and project-aware session launch. In progress.

---

## License

MIT
