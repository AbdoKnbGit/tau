<p align="center">
  <img src="Logo.png" alt="Tau logo" width="120">
</p>

# Tau - Your Adaptive Coding Agent

[![npm version](https://img.shields.io/npm/v/%40abdoknbgit%2Ftau.svg)](https://www.npmjs.com/package/@abdoknbgit/tau)
[![License](https://img.shields.io/npm/l/%40abdoknbgit%2Ftau.svg)](https://www.npmjs.com/package/@abdoknbgit/tau)

<p align="center">
  🌐 <strong><a href="https://tau-site-ten.vercel.app/">Visit the Tau website</a></strong> for more information
</p>

---

## What is Tau?

Tau has become the best free coding agent: a single tool that fuses the **Claude Code** and **OpenCode** ecosystems into one mixed agentic environment. You get the strongest parts of both agents, plus new features and optimizations layered on top.

Native adapters for **22 providers**. Not a proxy, not a wrapper around someone else's wrapper. When you use OpenAI, Tau speaks OpenAI's API directly. Same for GLM, DeepSeek, Mistral, OpenRouter, AgentRouter, Vercel AI Gateway, Requesty, Command Code, MiniMax, OpenCode Zen, and the rest. Full list with per-provider notes in [PROVIDERS.md](PROVIDERS.md).

Install once. Type `/login`. Pick a provider. Work.

That's it: plug and play with one command and one login flow. No shell configuration. No export statements. No environment variable archaeology. A first-run wizard handles credentials and saves them.

---

## Why Tau exists

The price of AI keeps climbing. The leading agents either lock you into a single subscription, gate the good features behind enterprise tiers, or quietly burn through your wallet on per-token billing the moment you do real work. Hit a rate limit on one provider and your day stops.

Tau gives you a way out. **You can work with any provider without that provider's official tool installed on your machine.** Not Codex CLI, not Antigravity, not Cline, not KiloCode, not Kiro, not Copilot. None of them downloaded, none of them configured, none of them present. Tau brings the runtime. You bring whatever API key or auth flow you already have.

---

## Install

```bash
npx -y @abdoknbgit/tau-installer@latest
```

**Requirements:** Node.js 20.19+ or 22.12+ (require(esm) support), Git, Bash, `gh` for GitHub automation, and Go 1.25.8+ to build the optional native Tau helpers from source.

### Rustcode mode (optional)

Rustcode keeps Tau's normal tools and adds native, read-only Rust workspace analysis, focused Cargo planning, test mapping, compiler-diagnostic parsing, dependency and artifact inspection, profile advice, unsafe auditing, generated-code mapping, build-environment analysis, and change-impact planning.

Install Rust **before** Tau so Tau can build and expose these native capabilities. Rust requires additional disk space. If `rustup` is not installed yet, follow the official [Rust installation instructions](https://www.rust-lang.org/tools/install). Then install and activate the stable toolchain:

```bash
rustup default stable
```

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
  <img src="tau_docs.PNG" alt="Tau commands overview" width="720">
</p>

## Commands

**`/models`** - Browse available models and switch the active model.

**`/tools`** - Toggle the optional tools available in normal mode.

**`/mode cheap`** - Use a compact, cache-stable core with bounded tool output. **`/mode normal`** - Use your configured tools.

See the full command list and usage notes in **[COMMANDS.md](COMMANDS.md)**.

---

## Supported Providers

22 providers with native adapters. See the full list and per-provider notes in **[PROVIDERS.md](PROVIDERS.md)**.

---

## Features

**Multi-provider, natively**
22 providers with native adapters. Not a routing layer, not a translation proxy. Each provider speaks its own API through its own adapter. Full streaming, rate-limit handling, and automatic tool-schema sanitization per provider.

**The full agent loop**
File editing, bash execution, glob, grep, web search, web fetch, MCP servers, hooks (PreToolUse, PostToolUse, UserPromptSubmit, Stop, Notification), skills (/commit, /review-pr, /simplify), and task management: all present, all working across every provider.

**LSP native integration**
Built-in Language Server Protocol support. The agent gets real diagnostics, definitions, references, and hover information from project LSPs (TypeScript, Python, Bash, YAML, and more) without spawning external editor tooling. Type errors, unused symbols, and cross-file references are first-class signal in the agent loop.

**Snapshot with time traveling**
Per-turn working-tree snapshots stored in a shadow git repo separate from your project's `.git`. The agent can `save`, `list`, `diff`, and `restore`: instant undo for any change the agent made, large files (>2 MB) auto-excluded so the store stays small, weekly garbage collection. Travel back to any prior state without touching your branches.

**`web_search` tool**
Firecrawl provides 1k searches/month free for deep searching. Just enter your API key through `/login` -> **Firecrawl Search**.

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

**Self-learning & self-improvement**
Tau gets better the more you use it. After a substantial task, or on demand via `/learned`, it proposes one critical, general, reusable lesson (a framework gotcha, a whole class of bug to avoid, a hard-won constraint, or your own preference) for you to Approve / Edit / Skip. Approved lessons are saved to memory and carried from this session into future ones and other projects, so the work keeps compounding instead of starting cold. Review, edit, delete, or toggle everything it learns with `/learned`.

---

## License

MIT
