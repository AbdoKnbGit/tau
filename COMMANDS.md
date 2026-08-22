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

**Favorites - quick switching between the models you actually use**
Press `Ctrl+F` on any model in `/models` to star it. Starred models are pinned
to the top of the quick picker (`Alt+P`), so hopping between, say, a Gemini on
Antigravity and a DeepSeek is two keys instead of a walk through the browser.
Each favorite remembers its provider, so picking one switches the lane too.
Press `f` in the quick picker to star or unstar the highlighted model. Up to 12.

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

**`/tools` - Toggle optional prebuilt tools**
Opens an interactive picker for optional Tau prebuilt tools. Basic agent tools stay fixed. Only available in normal power mode: cheap forces every optional tool off and full forces them all on, so `/tools` is hidden there.

```
/tools                     open the picker
/tools off AFT             hide AFT tools from the agent
/tools on ProjectWorkflow  enable a tool again
/tools status              print current state
```

**`/mode` - Switch Tau mode (cheap / normal / rust)**
One switch for how Tau operates, with a matching identity and accent color that cross-fades on change.

- `cheap` - a compact core-tool contract. Optional tools, skills, agents, plugins, MCP, and LSP are all off AND hidden from the model (system prompt and listings included); folder configs (`.claude/skills`, `.claude/agents`, `.mcp.json`, plugins) are ignored. Repetitive guidance is enforced by runtime guards, large results are parked with bounded previews and paginated retrieval, and every provider receives the whole compact schema block up front - cheap never hides a tool behind a lookup, so the model always has real parameter schemas and the request prefix stays byte-stable. Soft bronze accents.
- `normal` - default behavior. Your `/tools` toggles apply; MCP, skills, agents, and LSP load as configured. Standard theme.
- `rust` - normal behavior plus Rust-focused guidance and native Rust capabilities when available. The TAUCODE wordmark becomes RUSTCODE with a green gradient. The native `Rust` tool provides `workspace_context`, `focused_command`, `test_map`, `diagnostics`, `dependency_cost`, `artifact_size`, `profile_advice`, and `unsafe_audit`.
- `full` - everything on. Every optional tool is enabled regardless of saved `/tools` toggles. Soft gold accents.

```
/mode          open the picker (live palette preview)
/mode cheap    minimal footprint
/mode normal   back to default
/mode rust     Rust-focused capabilities and identity
/mode full     everything on
```

Saved `/tools` toggles are never rewritten - cheap/full override them while active, and normal or Rust mode restores them (`/tools` appears in both normal-compatible modes). Switching modes changes the tool set and system prompt once, so the prompt cache re-warms on the next message. Cheap then sends every schema eagerly on every provider and stays byte-stable for the rest of the session. In normal/full mode, optional schemas are deferred behind ToolSearch: client-native lanes append a loaded schema once and keep it, so each newly loaded batch can cause one additional expected re-warm but never removal or reordering, while Anthropic-native discovery keeps its physical tool block fixed and hides definitions server-side. A tool called before its schema arrived is not refused - its arguments are checked against the schema Tau holds locally and the call runs when they match, so a correct call costs no extra turn; only a parameter the schema does not define is rejected, and that rejection carries the real schema for a single direct retry.

The Rust capability is a stateless native helper built during install when Cargo 1.85+ is available. It plans focused Cargo argv and inspects existing source, diagnostics, lockfiles, profiles, and artifacts; it does not run builds/tests, edit files, resolve dependencies, create `Cargo.lock`, write into the inspected project's `target/`, or maintain a runtime cache. Tau's existing tool layer remains responsible for mode gating, permissions, provider schemas, timeout, cancellation, and output limits; Bash remains the only execution path for recommended Cargo commands.

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

**`/learned` - Self-learning control hub**
Tau learns as you work: after a substantial task (or on demand) it proposes one critical, general, reusable lesson - a framework gotcha, a whole class of bug to avoid, a hard-won constraint, or your own preference - for you to Approve / Edit / Skip, then carries approved ones into future sessions and projects. Approve and it's saved and used from the next session, no extra step; lessons are always a single portable principle, never project-specific trivia. Open `/learned` for a navigable menu: view what it has learned, learn from this session, edit or delete a lesson, or toggle self-learning on/off.
