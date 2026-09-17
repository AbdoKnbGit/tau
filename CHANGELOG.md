# Changelog

All notable changes to **Tau**, from the first release to the latest.
Each version lists what was fixed or added, newest first.

## v0.92.35 (2026-09-17)

- Stop shipping docs in the npm package (03afa3b7)
- Explain blocky inline images behind an old Windows ConPTY (90da3706)
- Keep inline images sharp after new turns, batches and resizes (47b64137)
- Fix /remote local timing out on phones under WSL 2 (cbd488f1)
- Fix the wordmark's A and E so the logo reads TAUCODE (0779c2ea)

## v0.92.34 (2026-09-14)

- Remove Antigravity from cheap mode (ab4e75c2)
- Update direct provider models (b3b615dd)
- Sync Cline models and gateway (2879d51b)
- Fix Cline catalog refetching, double-counted usage, and /models wait (7d223f49)
- Rewrite README intro and features with screenshots (2e2f5df3)

## v0.92.33 (2026-09-13)

- Use the real taskkill.exe when stopping commands on Windows (d2f90696)
- Give slow connections 2 seconds per address instead of 250 ms (d5233e68)
- Add !! to run shell commands without sending them to the model (c47a6ef2)
- Make Grep honor gitignore outside repos (03b949ca)
- Tell shell commands which Tau session and model started them (b5e57cfe)
- Draw mermaid diagrams in the terminal (a36ed98d)
- Preserve recent context during automatic compaction (d5d7ef3f)
- Improve the /files read inspection command (5536ccbb)

## v0.92.32 (2026-09-11)

- Show real context usage and each model's own context window (64b8dd96)
- Add full-canvas Tau themes (890e7564)
- Fix themed canvas rendering (4e77d6ba)
- Improve themed output and edit highlighting (2d718d25)
- Keep syntax highlighting aligned with themes (e0498601)

## v0.92.31 (2026-09-09)

- Stop shipping source maps to installs (32f890ac)
- Keep the voice startup deadline holding the event loop (68c45fcc)
- Prepare per-platform voice packages so installs stop carrying six addons (71b46b29)
- Keep platform voice pins in step with the Tau version (d8a70666)
- Never fail a Tau install because of the voice addon (b4c6faed)
- Add one command that releases Tau and its addons in order (5a23ecaf)
- Version the voice addons separately from Tau (9150ef48)
- Reject unknown options in the release script (85bd1e9d)
- Fix pinning on CRLF manifests and never publish an unverified edit (c86a4595)

## v0.92.30 (2026-09-09)

- Run voice regressions with exact paths on Windows Node 20 (5524d7bc)
- Verify the real voice installer without compiler dependencies (c1940831)
- Fix voice startup freeze and unsafe port reclaim in /login (15d1b309)

## v0.92.29 (2026-09-08)

- Add /remote: drive a session from your phone (9d5c7708)
- Fix Antigravity report quota routing (76f63b80)
- Ungate the subagent system from team mode (20d7c2a3)
- Remove /team-mode (4ab3d739)
- Retire the agent-teams gate (04e4ce34)
- Delete TeamCreate and TeamDelete tools (4ceb4cb4)
- Delete the teammate spawn path (6b0690a2)
- Name the viewed-agent module for what it does (d3f2c59a)
- Give concurrent subagents file-write ownership (4ef5f89d)
- Check file ownership before the mutating tools do any work (ccb0fe0e)
- Update README for remote control, Python kernel, and subagents (5da1db6b)
- Improve Antigravity cache accounting (ffa12280)
- Refuse to key a file claim from a relative path (e0c89664)
- Attribute Eval bridge tool calls to the cell's own agent (0eb6d472)
- Show the continuation flow in the subagents feature entry (dbcd19be)
- Register resumed agents for file-write ownership (cb3d1758)
- Claim file ownership when the write happens (8bf9db38)
- Read rule files other coding agents already wrote (4d1f6d13)
- Enhance Browser tool with eval integration (0b647933)
- Fix model context windows silently defaulting to 200K (88366fae)
- Keep unrelated voice work out of the context-window commit (0369dc66)
- Add /compact-settings with model-agnostic compaction controls (96009318)
- Fix compaction settings tick labels and a cap-induced false block (fa0f3a52)
- Show compaction progress on its own spinner row (5ea2f397)
- Report compaction progress on the cache-sharing path too (2d7d5bed)
- Show the session's initial context in the status line (34a78233)
- Fix five defects found auditing the compaction work (eaf27126)
- Contain two failure paths in the compaction feature (4b0790db)
- Support Meta Muse Spark on OpenRouter, and steer effort per model (cb6c4cd3)
- Replace legacy voice stack with native Codex push-to-talk (a6b55929)
- Make voice libc regression independent of the test host (d2595793)

## v0.92.28 (2026-09-04)

- Fix report generation across provider retries (d5436b3a)
- Add inline image rendering in the transcript (9aa17336)
- Add Eval: a persistent Python kernel that can call Tau's own tools (a4ae4c81)
- Warn when a broad search is followed by a cell that re-scans anyway (4e409543)
- Generalise the redundant-scan guard beyond the case that prompted it (4d3a811d)
- Stop leaking kernel internals into tracebacks, and open up the tool bridge (3605ada6)
- Fix Antigravity report session affinity (0b297da0)
- Prune eleven unused tools, remove rust mode, fix custom-agent model routing (2e04000b)
- Fix CI: shrinkwrap test still required the removed AFT platform packages (c6317db6)
- Show a subagent's real model, and pin Antigravity to the authenticated account (3f83f4cc)
- Cover the resolved-model registry, and stop rotation looking live (f23e9958)
- Stop reporting a cut-off turn as a broken tool call (7466dc93)
- Make Eval's contract decidable, and notice when a read-shaped tool did the computing (015c3694)
- Remove the LSP and MermaidRender tools (8b6e3cb2)
- Drop a duplicate import left by the toggle-test rename (47905413)
- Finish the prunes: stop recommending tools that no longer exist (e33f8c98)
- Delete an unreachable tool, drop a dangling import, and make ChangeRisk toggleable (e7b4cc3f)
- Add gemini 3.8 flash to antigravity (a3266cfa)
- Notice when an install skipped its own setup step (61397d3e)
- Point the registered-last test at the real import blocker (8506eeda)
- Stop requesting an npm dist-tag that was never published (675b8f57)
- Route /report around exhausted Antigravity hosts, and add Alibaba Model Studio (f51fa224)

## v0.92.27 (2026-08-28)

- price third-party models from models.dev instead of Claude rates (93f102e4)
- Show per-provider quota in the status bar without writing credentials (93f102e4)
- Never cache a failed lookup as a settled answer (93f102e4)
- Add CLAUDEX_DISABLE_MODEL_PRICING to opt out of price downloads (93f102e4)
- back off failed price-catalog refreshes instead of refetching 4MB per message (dd7902e5)
- Prefer a sibling session's price file over re-downloading it (dd7902e5)
- Treat a backwards clock as due, so refreshes cannot freeze (dd7902e5)
- Isolate throwing quota subscribers from the refresh result (dd7902e5)
- never let rate-limit harvesting throw into a live provider request (7b4b086d)
- Check the price-refresh backoff before touching disk (7b4b086d)
- show the reply header (date, time, model) outside ctrl+O via one /config setting (522de5da)
- Rename any session from /tree with ctrl+R, no resume needed (522de5da)
- Refuse a tree rename with no transcript path or on a swarm teammate (522de5da)
- Cover header modes and timestamp formatting with unit tests (522de5da)
- show OpenRouter credits remaining instead of a lifetime-spent percentage (5cb417dc)
- Refresh quota on turn completion, the moment it actually changed (5cb417dc)
- Price long-context tiers from models.dev instead of base rates only (5cb417dc)
- rank a credit balance above header rate-limit windows, so it can surface (d0ac6a4f)
- Keep a completed turn from re-fetching a settled absence (d0ac6a4f)
- name the 5h session window on Anthropic and OpenAI readings (f0d9fb8f)
- Match OpenAI's "Codex session" so its weekly cap stops outranking it (f0d9fb8f)
- show Fireworks spend in dollars on /usage instead of eighteen zeroed GPU quotas (f899c1f9)

## v0.92.26 (2026-08-26)

- Retry network fetch failures and refresh Fireworks AI models (0bc1c5f1)
- Keep tool discovery off providers with an exact prefix cache (70b843d5)

## v0.92.25 (2026-08-26)

- Fix LSP handlers lost on server restart (80191b32)
- Fix antigravity cache-break diagnostics (b91fc10b)
- Cut prefix-cache churn and dead attribution tokens (197f56b9)
- Ignore the generated install-lifecycle marker (855f9b1d)
- Fix(ui): fit the session status bar into the statusLine mechanism (b12d0536)
- Fix(ui): drop both status rows together, and teach the setup agent Windows (e43becad)
- Fix(ui): keep feature() foldable in the status row resolver (705d0b2a)
- Verify the production shrinkwrap with the npm that defines it (f2797ae6)

## v0.92.24 (2026-08-24)

- Add Xiaomi MiMo and LXD API providers (ce046d35)
- Enhance search tool (86480c8e)

## v0.92.23 (2026-08-22)

- Fix(agents): honor each agent's configured provider and model (5f127bf7)
- Feat(prompt): show context token usage in the pinned session row (40db7996)
- Add model favorites to the pickers (fec3d9f4)
- Cost optimization by 50% reduction (076bb45f)

## v0.92.22 (2026-08-14)

- Fix CI ripgrep fallback (fae32cb3)
- Fix production shrinkwrap portability (5af1daf0)
- Skip Ollama prepull in CI (5e88d29e)
- Retry Antigravity network failures (74f23426)
- Save Antigravity credentials (d81f674e)
- Follow active browser tab (c41a5e59)
- Add gemini 3.7 to antigravity (32fd62b3)
- Fix Antigravity auth requests (78624007)

## v0.92.21 (2026-08-12)

- Sharpen Rust workspace analysis (824d049c)
- Isolate marketplace refresh CI fixture (ac515ec1)
- Update docs (fad95f1d)
- Fix antigravity login (c0e623c4)

## v0.92.20 (2026-08-08)

- Add saved-output search and image descriptions for text-only models (c0b925fc)
- Read Word, Excel, and OpenDocument files (6e40709e)
- Recover from gateway payload-too-large rejections (a3ac0436)
- Paste images from the clipboard on Windows, WSL, and Linux (30af6a68)
- Route subagent aliases by provider (2a13d54a)
- Remove obsolete files (4daf2f5e)
- Add native Rustcode capabilities (8b6fe970)
- Tolerate provider Rust action fields (bdfb7179)
- Clarify Rust diagnostics input (9a546c6e)
- Default Rust semantic options (84d69eaa)
- Expand native Rustcode analysis (2bb4be07)
- Retry OpenCode network failures (2ff74105)
- Make Rust analysis host independent (6b4fdb53)
- Make Rust LSP setup self-healing (874e5099)
- Refresh marketplace before plugin updates (06bdb176)
- Make Rust LSP test newline agnostic (d59d8574)

## v0.92.18 (2026-07-27)

- Fix(release): sync shrinkwrap version (0edfe84d)
- Stop the agent from repeating a failing tool call, and verify goal completion claims (37c41810)
- Add opus 5 (10e25c56)
- Fix bash failures hiding the real stderr (31dfe85b)
- Fix image and PDF attachment handling across lanes (8a6fa598)
- Fix output loops, blind repo retrieval, and frozen write prompts (7f6d3c3f)

## v0.92.17 (2026-07-21)

- Add /goal command to loop the session until an objective check passes (7700c866)
- Add Browser tool for real Chrome/Edge automation via CDP (c6c90be9)
- Fix browser automation behavior (fe9101e6)
- Add gemini 3.6 to antigravity (e36e0ea0)

## v0.92.16 (2026-07-17)

- Fix CI: writable test lock path, LF-stable shrinkwrap check, raise Node floor to 20.19/22.12 (require esm); bump 0.92.16 + installer 0.1.3 (e4328300)

## v0.92.15 (2026-07-17)

- Fix package install: shrinkwrap-pinned deps, tau-installer with reviewed scripts, self-healing warning-free installs, cross-OS CI, docs cleanup (fbdb26f6)

## v0.92.14 (2026-07-16)

- Simplify README command overview (125b8bf2)
- Add distill, skeleton reads, corrections, coupling, and grep grouping (506a58d4)
- Improve file tools and result handling (5c1d23b3)
- Fix OpenCode Go caching and reliability (598c0db8)
- Fix fatal render-path freeze from the synchronous native highlighter and restore in-process color (64f7c6a9)
- Bound silent gateway stalls with a stream idle watchdog and stop the non-streaming fallback re-hang (da9f3873)
- Read tool: recover invisibly when pages is used on a non-PDF instead of returning a silent no-op (59b3bd63)
- Fix tool-arg _raw recovery for under-escaped Windows paths (57dd4d90)
- OpenCode Go GLM-5.2: add Default/High/Max reasoning selector and stop the usage-field 400 (04cec235)
- Add GPT-5.6 with its thinking variant (f2174e54)

## v0.92.12 (2026-07-08)

- Update README with Firecrawl tool details (ca0e6d5a)
- Update app behavior and usage tracking (9cfef2dd)
- Bundle provider, tool, and mode updates (3cdf4e3b)

## v0.92.11 (2026-06-22)

- Fix diff rendering and harden tool-input validation (259162a8)
- Make LSP default-on and first-class with capability-aware routing (2381d900)
- Gemini retire after stoping it from gemini Cli (b7327472)
- Add DEEPSEEK_BASE_URL to customize the DeepSeek endpoint (c3399e83)
- Gemini cache padding and pacing now default off and apply only to the Gemini lane (9b5fbfec)
- Plan mode now works alongside dangerously-skip-permissions instead of being overridden by it (c62ff647)

## v0.92.10 (2026-06-21)

- Updating the UI/UX design (28b9f958)
- Add visual diffs for snapshots and files (b780cdf9)
- Fix prompt wrapping and @ suggestions (601b23e2)
- Fix Bash workdir schema handling (e8c5b04f)
- Replace workdir parameter with native location-flag anchoring (7e909912)

## v0.92.9 (2026-06-19)

- Self-healing installs (5bc0db47)
- Verify dependencies, repair broken trees, clear stale launchers (5bc0db47)
- Merge master (46e5211e)
- Build tau-vscode (part 1) (e6a85b1a)
- Fix working-directory dynamics + provider/lane updates (2ea3d27e)

## v0.92.6 (2026-06-11)

- Fix linux native tools install (496853f4)
- Fix MD display (9fd2acc5)
- Revise multi-provider orchestration description (8e2d9b85)

## v0.92.4 (2026-06-07)

- Fix MD display (45666014)

## v0.92.3 (2026-06-07)

- Merge community PR (b91e31d4)
- Fix linux native tools install (d286f01a)

## v0.92.2 (2026-06-07)

- Fix kiro arn profile auth (9e0b3ac7)
- Add native Tau helpers (d8fada1d)

## v0.91.0 (2026-06-05)

- Update README DOCS (d4f0422f)
- Checkpoint before munder difflin planning (4edb530b)

## v0.9.98 (2026-06-05)

- Merge community PR (bba7f583)
- Add Command Code provider (accc94d2)

## v0.9.96 (2026-06-03)

- Improve team mode runtime infrastructure (7180f033)
- Fix antigravity model ids (6194e8c7)

## v0.9.95 (2026-06-03)

- Cline and shell fixes (fa750f08)

## v0.9.92 (2026-06-02)

- Make Bash syntax planning safer in 0.9.92 (937e8fda)

## v0.9.91 (2026-05-30)

- Make anthropic provider models use the native websearch tool (faeca19c)

## v0.9.8 (2026-05-29)

- UX/UI: responsive welcome header + refined logo/spinner motion (2fc69212)
- Keep model selection independent per session (32ef13ec)

## v0.9.6 (2026-05-28)

- Fix mismatch between model and provider on team_mode (713b98bb)

## v0.9.5 (2026-05-28)

- Fix mismatch between model and provider on team_mode (cab0e690)

## v0.9.4 (2026-05-28)

- Fix mismatch between model and provider on team_mode (570ca5c4)

## v0.9.3 (2026-05-28)

- Update README command links (433d9b87)
- Fix mismatch between model and provider on team_mode (c50d0c69)

## v0.9.2 (2026-05-27)

- Auto-detect OpenCode provider from known models (29f39ee4)
- Update README: clean up providers table (fdb20989)
- Fix README markdown rendering issue near video tag (17f5ed4e)
- Add LM Studio API server startup instructions (59993d3e)
- Add AFT code intelligence tools (00f2b80b)
- Add Bash LSP integration (4a881ad7)
- Add /team-mode for multi-provider agent orchestration (bddf885b)
- Add Kiro "Improperly formed request" diagnostic (3fa47d9a)
- Add /team-mode fallback for worker failure recovery (9f23af14)
- Tighten AFT tool usage guidance (1890f801)
- Fix AFT outline empty file-tree fallback (c0ff03e6)
- Add command-help fetcher and fix Git Bash POSIX path handling (c89dda4b)
- Add snapshot with time-travel, structured compaction overview, opt-in PTY (9610c7ef)

## v0.9.0 (2026-05-23)

- Coerce malformed tool inputs from non-frontier models & prevent bash retry loops (92d22ac4)

## v0.8.9 (2026-05-23)

- Add thinking_effort to OpenCode models + improve shell commands (2ac0dcbf)

## v0.8.8 (2026-05-23)

- Strip x-* vendor extensions from tool schemas (5b802344)
- Add OpenCode Zen provider (3acb4996)

## v0.8.7 (2026-05-22)

- Add Requesty and Vercel providers (f8c58057)

## v0.8.5 (2026-05-20)

- Improve Bash failure diagnostics. (aae7d72f)
- Adding antigravity cli support + variant 3.5 flash (f9402916)

## v0.8.4 (2026-05-19)

- Add tau git memory plugin (ee60a6c9)
- Refresh pinned memory during active sessions (5038a5c8)

## v0.8.3 (2026-05-15)

- Document Firecrawl web search (92a40e30)
- Fix deprecated install dependencies (3fac4344)
- Add fflate runtime dependency (9882e5f7)

## v0.8.1 (2026-05-15)

- Update README.md (7f7eca0e)
- Add desktop computer tool (2aee03ac)
- Add Mistral provider support and cache fixes (cda0011d)

## v0.7.9 (2026-05-09)

- Redact WhatsApp runtime identifiers (2f51d40b)
- Prevent WhatsApp reply echo loops (19e1b0d3)
- Harden WhatsApp echo suppression (9d4cda67)
- Add /pin command for persistent prompt constraints (362012d2)
- Fix /pin: hide from transcript and drop the system-reminder wrapper (139292b2)

## v0.7.8 (2026-05-09)

- /safetest command — phase 1 (787f7ffb)
- /safetest command — phase 2 (eaa17620)
- Fix Gemini cache_read display on CLI / Google-account lane (8f1cdf80)
- Add WhatsApp remote control (be0af76e)

## v0.7.7 (2026-05-08)

- Add Studio theme and modern UI palette slots (11de2baa)
- Refresh prompt frame: side bar + foot character (a6d8cc73)
- Add status row beneath prompt: cwd + MCP indicators (76cc9e4a)
- Use widely-supported glyphs for prompt foot and status indicators (647fafd2)
- Tie slash-command picker selection to primary palette (1752c821)
- Drop top border on prompt frame; vibrant primary color (99fe96bf)
- Fill prompt panel, surface model row, soften welcome chrome (731fb164)
- Replace welcome header with minimal centered layout (d0e0aaac)
- Big centered TAU logo + roomier prompt frame (bc121036)

## v0.7.6 (2026-05-07)

- Fix Moonshot prompt cache key (298ba48c)

## v0.7.5 (2026-05-07)

- Add MiniMax provider (720d28d8)

## v0.7.3 (2026-05-07)

- Clean up install dependency warnings (042e1c92)

## v0.7.2 (2026-05-07)

- Honor dangerous bypass for permission prompts (f272065a)
- Add E2B runtime dependencies (08fd1290)
- Add GLM provider support (5c44e8a6)

## v0.7.1 (2026-05-06)

- Add dangerous skip permissions mode (ffecffe7)

## v0.6.7 (2026-05-06)

- Add AgentRouter compatibility switch (414d3736)

## v0.6.6 (2026-05-06)

- Update README.md (4802e45a)
- Revive Gemini provider support (c1496b55)
- Adding vedio (b94803c5)
- Add AgentRouter as a new provider (51c0bff6)
- Make Tau feel like the true free Claude Code (f8b374bd)
- Keep the local version as the truth (7684a2a4)
- Show the free AgentRouter credit (de3839c5)

## v0.6.5 (2026-05-04)

- Make logo and user prompts render transparently (b8b8cc97)
- Voice feature build phase 1 + fixing /provider file (db6713bd)
- Complete voice mode phase 2 (ac5cf9da)
- Merge community PR (4735e990)
- Sync OpenAI models and TTS preview (17e7c3b3)
- Fix(codex): stabilize prompt cache by splitting volatile env from instructions (541524ea)
- Fix(codex): anchor frozen volatile at input[0] for stable cache prefix (7f1f238a)

## v0.6.4 (2026-05-03)

- Add /github command (phase 1) (51f49e24)
- Harden /github issue: permission gate + silent labeling (eaf1e9db)
- Refine /github wrap prompt and improve statistics cache note (eead65aa)
- Add changelog entry for /github wrap refinement and stats improvement (dd0a3088)
- Refine /github wrap wizard UX and branch handling (8aa16bbe)
- Allow /github release to inspect workflow runs (37116ad9)
- Add changelog entry for /github release run checks (908aee5e)
- Fix /github release version submit (552f6ebe)
- Ignore local detect fallback test (d572213c)
- Document /github automation commands (8be963f2)
- Some UI/UX design (cefceb32)

## v0.6.2 (2026-05-03)

- Fix Tau CI workflow and Kilo cache build (07a9d7b3)
- Update README logo (5bd4fc06)
- Center README logo (65da6031)
- Add /tree, /clone, /import for session navigation (a4484802)
- Fix garbage branch/clone/import names from slash-command launches (eaf8f411)
- Distinguish auto-named branches with last-prompt seed and HH:MM stamp (15027631)
- Add session statistics command (0ebd85a9)
- Add session report command (deeae4ed)

## v0.6.1 (2026-05-02)

- Fix Tau release metadata (b436c091)
- Fix Tau GitHub workflow (7aab4a7d)

## v0.6.0 (2026-05-02)

- Fix OpenRouter cache affinity and Copilot model list (514ce038)
- Fix Cursor tool argument normalization (5c60870a)
- Fix KiloCode tool argument normalization (e0e64f2b)
- Fix Kiro streaming cache and tool handling (908d6cc6)
- Rename to Tau: migration and release metadata (17f66974)

## v0.5.9 (2026-05-01)

- Stabilize OpenRouter cache hit and lock free-tier subagent spawn (92ca7600)
- Stabilize GitHub Copilot cache affinity (0e65f751)

## v0.5.8 (2026-05-01)

- Document '/fallback' feature in README (c318ad30)
- Fix shared context window accounting (2d7d6253)

## v0.5.7 (2026-05-01)

- Merge community PR (b3f844ad)
- Fix Claude Antigravity tool history (7d3d07f4)
- Fix Gemini AskUserQuestion input shaping (dc14a676)
- Revert "Fix Claude Antigravity tool history" (f35958c0)
- Sync local Gemini state and AskUserQuestion fix (e11c6a33)
- Updating the Readme (be2fa3b4)
- Update README.md (dbc3d4db)
- Rewrite /fallback with tight quota-only error detection (c88d14e0)

## v0.5.6 (2026-04-30)

- Add /usage command and tutorial video to README (dd234c8b)
- Replace stripped video tag with clickable thumbnail (0ca2845a)
- Add tutorial video link from README (9ab12d24)
- Add vscode phase 1 building (fee7f07b)
- Ship fallback model recovery (226de0a5)
- Route API failures through fallback (f3f7f3a2)
- Refine fallback API error signals (7ade1c04)

## v0.5.4 (2026-04-26)

- Fix Bash-backed shell tool guidance (8783aabf)
- Fix openrouter and nim model catalogs (9875d3a4)
- Update OpenRouter allowlist to curated model list and trim NIM catalog (ef7af647)
- Filter NIM models to curated catalog allowlist (663b0358)

## v0.5.3 (2026-04-26)

- Fix(deepseek): move V4 thinking toggle into the model picker (9f724951)
- Update README (7e5fc8f0)
- Design the onboarding screen (8ef6c394)

## v0.5.2 (2026-04-25)

- Restore Ollama auth and require bash setup (1565269f)
- Fix(gemini): keep google oauth lanes isolated (54b37424)
- Fix(webfetch): use active model for fetch prompts (b3013571)

## v0.5.1 (2026-04-25)

- V0.5.0 esbuild bundle — inject require + fix config-guard patch (dfc3c3e1)
- Cross-platform matrix — Linux + macOS + Windows, Node 20 & 22 (8f003e56)
- Strip thinking-block signatures on model/provider switch (44f17700)
- Scope thinking-signature stripping to Anthropic (firstParty) only (37b34f1d)

## v0.4.8 (2026-04-24)

- Add Anthropic model picker support (94df1fe1)
- Restore provider picker for login (494c17e9)
- Apply provider API keys without restart (84688dfe)
- Replay deepseek thinking for tool calls (8af0609d)
- Add provider usage command (e9c7b263)
- Clean provider usage rows (6df4e3de)
- Show connected usage providers (8bb900ca)
- Filter antigravity usage models (938c616b)

## v0.4.7 (2026-04-24)

- Fix(kilo): cache-hit parity with Kilo CLI — eliminates 2x overbilling (v0.4.7) (b7ebad55)

## v0.8.1a (2026-04-24, early numbering)

- Add GPT-5.5 OpenAI model support (e5fb491e)

## v0.4.5 (2026-04-24)

- Feat(kilo): native Kilo Code lane with subscription-aware catalog (ae178e74)

## v0.4.4 (2026-04-23)

- Feat(cursor): harden native auth, models, and tool streaming (15126393)
- Fix(cursor): preserve tool results across follow-up turns (f3472134)
- Fix(cursor): use native auto model wiring and errors (47d83ee2)
- Fix(cursor): fix tool call InputValidationError — protobuf arg extraction and schema adaptation (bc44ae47)
- Sanitize Cursor tool IDs for provider switching (a6caff62)
- Add native Cline lane and curated model badges (a4e14575)

## v0.4.3 (2026-04-22)

- Feat(kiro): wire chat via dedicated kiro lane (v0.4.2) (10630174)
- Feat(kiro): tighten native provider routing and payload control (e57b9117)
- Sync local workspace state (6efb1e13)
- Delete prompt.txt (f527db74)
- Feat(copilot): tighten provider catalog and free-tier gating (v0.4.3) (9ab58edb)

## v0.4.1 (2026-04-21)

- Feat(copilot): wire chat via openai-compat lane (v0.4.1) (1673ed20)

## v0.4.0 (2026-04-21)

- Feat(antigravity): add Claude Sonnet 4.6 + Opus 4.6 thinking (Phase 3) (9cf7976e)
- Fix(antigravity): preserve tool_use.id when routing Claude through Antigravity (3dde2289)
- Fix(gemini): preserve server functionCall.id in streaming response parser (e23cdd3b)
- Fix(gemini): propagate tool_use.id through lane history converter (4c78da9e)
- Feat(providers): 6 OAuth providers — Cline/iFlow/KiloCode + stubs (v0.4.0) (799dd2a4)

## v0.3.0b (2026-04-20, early numbering)

- Fix(ollama): drop dead cloud IDs, auto-pull the rest on install (1f81603c)
- Fix(repl): unfreeze CLI on first launch and after Esc cancel (a41af970)
- Feat(providers): split Antigravity into its own provider row (v0.3.0) (b0558d2e)

## v0.2.7 (2026-04-19)

- Fix(providers): snapshot active provider per session (0e72f4d9)

## v0.2.6 (2026-04-19)

- Fix(cache): propagate OpenAI prompt-cache hits end-to-end (5b48e3c2)
- Fix(cache): keep store:false on Responses API (b88b24f0)
- Fix(cache): split OpenAI total input_tokens into fresh vs cached (d46f8c1c)
- Fix(cache): send session_id + originator HTTP headers on codex lane (6efcbde0)
- Fix(gemini): self-heal auth/quota/signatures + correct pro thinking level (adb5c75e)
- Fix(providers): hide Groq from CLI — TPM cap too tight for tool-heavy use (952383e6)

## v0.2.5 (2026-04-17)

- Fix(gemini): safety filters OFF, proper thinking budgets, and model-tuned generation config (f1273e9b)
- Fix(gemini): dynamic config instead of hardcoded — derives from model name, all overridable (5a9f7abd)
- Fix(gemini): cut thinking budgets for speed — pro 8K, flash 2K, cap at 16K (a0f50d17)
- Fix(gemini): dynamic thinking + system split + stale project recovery (f0325e00)
- Feat(lanes): native lane architecture — every model runs in its own ecosystem (7723b395)
- Fix(gemini): strip unknown tool params, auto-retry 429, smart rate limits (885beab9)
- Fix(gemini): slash token usage 80% — tiered optimization for flash/lite (7db41266)
- Fix(gemini): report real input_tokens, cap 3P retry waterfall (2818bce7)
- Fix(routing): auto-correct provider for misrouted models, add all Antigravity models (c27958c5)
- Fix(gemini): don't retry on quota exhaustion, clear error messages (5bc516d0)
- Faster Gemini, each model now runs in its home environment (5295d90c)
- Fix(tools): preserve MCP tool args through Zod validation (aad01892)
- Fix(logout): clear all Gemini OAuth variants + Antigravity account store (be6be547)
- Fix(gemini): remove unsupported Antigravity models, fix dual-token configure() wipe (1c826f25)

## v0.1.9 (2026-04-13)

- Fix(providers): Groq and NIM tool calling now works correctly (405416a7)
- Google Gemini now works like a native provider — full tool support, smart caching, accurate cost tracking (d92d0205)

## v0.1.7 (2026-04-12)

- Fix(auth): remove scope from token exchange so API key gets full permissions (093e42fb)
- OpenRouter full tool support, prompt caching, and stream cancel fix (777dbaf9)

## v0.1.6 (2026-04-12)

- OpenAI Codex models now work — switched to the Responses API (95f78d51)

## v0.1.5 (2026-04-12)

- OpenAI Codex models with reasoning levels — browse, pick, and think (19b65df6)

## v0.1.4 (2026-04-12)

- Gemini API key login works, settings tool no longer crashes (e7f4e54f)

## v0.1.3 (2026-04-12)

- Sign in once for flash, once for pro — use all 6 Gemini models at the same time (32262f84)
- Login shows 3 Gemini options, provider only shows status, 6 models only, cleaner success page (4347b292)
- Fix cli models: separate onboarding per executor, proper headers, api/oauth mutex (ffe4eb05)
- Gemini tool calls now work — use agents, MCP servers, plugins, and plan mode with all Gemini models (73a85545)

## v0.1.1 (2026-04-12)

- Surf mode auto-picks the right model for what you're doing (d2e27a1a)

## v0.1.0 (2026-04-11)

- Fix(groq): ultra-aggressive token optimization for 6K TPM limit (7c8e10dc)
- Fix(login): skip OAuth for OpenAI/Gemini when client IDs not configured (d9c111c7)
- Feat(oauth): automatic OAuth login for OpenAI and Google Gemini (54439ec1)
- Fix(oauth): fix redirect, auth priority, and Gemini scopes (f32f8c89)
- Easier sign-in, rainbow look, snappier local replies (d61a57d5)

## v0.9.0 (2026-04-11)

- Fix provider compatibility bugs, add /thinking command (cbdbe22d)

## v0.7.0 (2026-04-10)

- Replace Windows process streams for proper TTY support (8335f5c6)
- Add startup screen with gradient logo before Ink loads (a5f27c88)

## v0.5.0 (2026-04-05)

- Fix interactive TUI not launching on Windows (CMD, PowerShell, WSL) (93d6a4c6)

## v0.3.2 (2026-04-04)

- Eliminate deprecated node-domexception, upgrade Anthropic SDK (560c4d15)

## v0.3.1 (2026-04-04)

- Fix diff vulnerability (GHSA-73rr-hh4g-fpgx), pin react 18.x (52eea964)

## v0.3.0 (2026-04-04)

- Fix CLI launch failure, OS portability, add VS Code extension (2a34aa18)

## v0.2.0 (2026-04-04)

- Initial release: Claudex, a multi-provider AI coding CLI (ecd7165f)