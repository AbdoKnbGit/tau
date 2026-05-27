# Tau Commands

## Auth

**`/login` - Start here**
Pick a provider, enter your credentials, and Tau saves the setup. No env variables, no config hunt.

## Models

**`/models` - Pick your model**
Live model browser. Fetches the real catalog from your provider API, lets you search, filter, and set the active model.

```
/models                     open the full picker
/models <query>             search active provider
/models openrouter:kimi     search a specific provider
/model kimi-k2-5            set a model directly
```

## Web Search

**`WebSearch` - Firecrawl-hosted web search**
The `web_search` tool is hosted with Firecrawl and works across providers. Firecrawl offers 1k searches/month on free trials; just enter your API key.

Setup is one step: `/login` -> **Firecrawl Search** -> paste your Firecrawl API key. After that, agents can search current web information automatically when a question needs live or recent data.

## Voice

**`/hey` - Start a voice conversation**
Turns on voice conversation mode. Hold Space to talk, release to send, and Tau shows what it heard before submitting.

**`/bye` - End the voice conversation**
Turns voice conversation mode off and stops any spoken reply that is still playing.

## Session

**`/tree` - Navigate the session graph**
Move through your conversation history like nodes, so branches and forks stay understandable.

**`/clone` - Clone the session**
Create a copy of the current session when you want a backup or a clean duplicate to continue from.

**`/branch` - Open a fork**
Start a fork from the current point in the session without losing the original path.

**`/resume` - Continue later**
Resume the last useful session or pick an older one when you want to continue where you left off.

## Orchestration

**`/team-mode` - Orchestrator with worker agents**
Multi-provider agent orchestration. One coordinator delegates work to a team of workers and they communicate both **vertically** (coordinator <-> workers, for task delegation and result handoff) and **horizontally** (worker <-> worker, for direct collaboration without round-tripping through the coordinator). Each worker can run on a different provider/model, and the orchestrator automatically falls back when a worker fails so the team keeps moving.

## Monitoring and Reporting

**`/usage` - Watch provider usage**
Shows real streaming provider usage as it happens, so you can see provider consumption while working.

**`/statistics` - Review the current session**
Shows statistics for the active session, including session activity and tool-call details.

**`/report` - Generate a final report**
Creates a clean content report for the session in Markdown, PDF, or HTML. This is for readable session quality, not usage statistics.

## Features

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
- `wrap` - Stage -> commit -> (optional changelog) -> push, with one permission gate before network writes.
- `changelog` - Generate/update changelog notes from commit history in a consistent style.
- `triage` - Classify issues (labels/status) with explicit confirmation before visible changes.
- `release` - Release flow: inspect dirty working tree, check CI/CD workflow status, then tag/publish and list runs.

**`/safetest` - Run a file inside a disposable cloud sandbox**
Upload one file to a fresh E2B VM, run it there, get a clean report back. The local machine never executes anything. Each run gets its own throwaway sandbox that's destroyed at the end.

Setup is one step: `/login` -> **E2B Security** -> pick "Auth login" (opens the E2B dashboard in your browser) or "API key" (just paste). After that, `/safetest` is ready - no env variables, no extra config.

**`/pin` - Pin a constraint to every prompt**
Save a sentence (or two) and Tau quietly appends it to the end of every message you send - a persistent reminder the model carries through the whole session without you retyping it. Use it for style rules ("reply in French"), guardrails ("never edit files outside `src/`"), or task focus ("stay on the auth refactor"). Cache-safe by design: only the dynamic tail of the user message changes, so your provider's prompt cache stays warm and the cost is a few extra tokens per turn.
