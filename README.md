<p align="center">
  <img src="Logo.webp" alt="Tau logo" width="120">
</p>

# Tau

---

## What is Tau?

Tau is an open-source, multi-provider AI coding CLI that runs a full agentic coding environment - tools, MCP servers, hooks, skills, the whole thing - with every major LLM provider, natively.

Not a proxy. Not a wrapper around someone else's wrapper. Native adapters, built from scratch, for each provider. When you use Gemini through Tau, it speaks Gemini's API directly. Same for OpenAI, DeepSeek, OpenRouter, all of them.

You install it once. You type `/login`. You pick a provider. You work.

That's it. No shell configuration. No export statements. No environment variable archaeology. No "works on my machine" moments. A first-run wizard handles credentials and saves them. Cross-platform — Windows, macOS, Linux. No brainrot config required.

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

**Requirements:** Node.js >= 20.0.0, Bash

---

## Launch

```bash
tau
```

---
## Update

```bash
tau update
```

---
## The Commands You Need to Know

### `/login` — Start here

Pick a provider, enter your credentials, done. Tau saves everything so you never do this twice. No env variables. No config files to hunt down.

### `/providers` — See the full picture

Shows every connected provider and their current status. Configured, available, needing login — all of it at a glance.

### `/models` — Pick your weapon

Live model browser. Fetches the actual catalog from your provider's API in real time. Search, filter, and set any model as your active one.

```
/models                     open the full picker
/models <query>             search active provider
/models openrouter:kimi     search a specific provider
/model kimi-k2-5            set a model directly
```

### `/fallback` — Recover automatically

Automatic recovery when a model fails mid-session. Configure a fallback and never lose your work to a provider outage again.

### `/usage` — Watch the meter

Tracks usage across every provider you're logged into. Quotas, remaining credit, request counts — see what each one has left before you hit a wall.

---

## Supported Providers

| Provider | Notes |
|---|---|
| Anthropic | No comment |
| OpenAI | Best in class, but GPT-5.5 is paywalled behind Plus/Pro |
| Google Gemini | Use your own account — some server configs block certain regions-currently gemini servers are not working and giving some error 429 u can check here https://github.com/google-gemini/gemini-cli/issues |
| Antigravity | Saving lives from agent server overload errors |
| OpenRouter | Would use this full-time if the bills didn't care |
| NVIDIA NIM | Gets slow under server load, especially for newest models like Kimi K2 |
| DeepSeek | Solid |
| Ollama | Local and private, but you knew that already |
| Cline | Moonshot AI's Kimi K2.6 through here is still the big win. Note: the old free tier is no longer fully free, but you still get some free credit |
| GitHub Copilot | Recommended for enterprise plans; free models are also usable for lighter work |
| Cursor | Peak performance on Plan mode |
| KiloCode | Lots of free models and decent to try for low-cost side tasks |
| Kiro | Best performance/cost provider with large free credit |

---

## Features

**Multi-provider, natively**
Twelve providers with native adapters. Not a routing layer, not a translation proxy — each provider speaks its own API through its own adapter. Full streaming, rate-limit handling, and automatic tool schema sanitization per provider.

**The full agent loop**
File editing, bash execution, glob, grep, web search, web fetch, MCP servers, hooks (PreToolUse, PostToolUse, UserPromptSubmit, Stop, Notification), skills (/commit, /review-pr, /simplify), and task management — all present, all working across every provider.

**Scalable context across providers**
Tau adapts context windows when switching between models and providers, so larger-context models can carry more history while smaller-context models stay usable.

**Fallback recovery**
A configurable fallback system can move work to another model/provider when the current one fails or overloads.

---

## Coming Soon

**`/surf`** - Intelligent model routing. Tau reads the task and routes to the best available model automatically. Experimental, in progress.

**`/github-me`** — A tool that handles the full development lifecycle: review, edit, CI/CD, testing, and automation of every GitHub action you'd otherwise do manually.

**`tau-vscode`** - VS Code extension. Provider switching from the command palette, Control Center webview, and project-aware session launch. In progress.

---

## License

MIT
