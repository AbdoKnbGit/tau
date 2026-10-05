# Tool prompt compression

4–5 October 2026. Only model-facing instructions were shortened; tool names, parameter schemas and runtime implementations were preserved.

## Measured result

| Tool | Original | First pass | Final | Saved | Reduction |
|---|---:|---:|---:|---:|---:|
| Browser | 3,761 | 2,153 | 2,556 | 1,205 | 32.0% |
| Agent | 1,743 | 879 | 1,035 | 708 | 40.6% |
| Bash | 1,354 | 1,082 | 1,119 | 235 | 17.4% |
| Eval | 1,349 | 841 | 1,137 | 212 | 15.7% |
| **Total** | **8,207** | **4,955** | **5,847** | **2,360** | **28.8%** |

The original prompts make 193 distinct points (listed in [tool-prompt-points.json](../test/tool-prompt-points.json)). The first pass covered 158 of them (81.9%); the final text covers all 193, plus two older git rules (H27/H28, see below).

These are Tau's estimates: Math.round((JSON.stringify(renderedPrompt).length - 2) / 4), rendered the way the contract test renders them (Windows, local configuration, three bundled agents, claude-sonnet-4-6). The original was rendered from a build of HEAD de2e0189 in an isolated copy. Counts cover prompt text, not schemas; with the unchanged schemas the four full definitions are 8,915 instead of 11,275. They are not provider-tokenizer measurements.

## Why the first pass was revised

It dropped 35 points, and several were fixes for failures that had already happened:

- **Eval.** The two-cell worked example was added in 015c3694 after a session that had read "never re-define" still wrote a helper to disk and re-imported it every cell; the first pass kept only the prohibition. It also softened "a string, not a list" (`len()` once reported 4,249 files that do not exist), and dropped the incident's own `find … | xargs wc -l | sort | head` pipeline, "thirty patterned edits are computing" and "the inflated figure looks plausible" (an unscoped walk answered 1,736 where the truth was 590).
- **Browser.** Text from fe9101e6 ("Fix browser automation behavior") was dropped: coordinates are blind, do NOT repeat a no-effect action, on failure SEE the page because most failures are a changed DOM, ref clicks strongly preferred, and a coordinate_guessing block is no cue to try another coordinate. "A covered centre may be clicked at an uncovered point" read as permission for the model to click coordinates; the tool does that itself, and now says so.
- **Agent.** The "smart colleague who just walked into the room" briefing frame, "genuinely independent" background work and the original proactive rule ("if an agent's description says to use it proactively") were lost; "when their descriptions call for it" was broader.
- **Dead branches.** The fork section and fork examples, the ant-only Git and remote-isolation text, and the MONITOR_TOOL and embedded-`find` lines never render in the external build (`feature()` is false; `USER_TYPE` is `'external'`). Shortening them saved nothing, so they are back to HEAD text.

## What stayed shortened

- **Browser:** one rule set instead of repeated targeting/failure/recovery sections, tighter action references, and an intro without the capability list each action already covers.
- **Agent:** tighter usage notes and briefing rules; the prime/greeting examples are one sentence.
- **Bash:** the first pass lost no point; it is unchanged apart from "paths (especially with spaces)".
- **Eval:** the telegraphic register and a one-line prelude; the rest of the gain is small because the original was already compressed in 015c3694.

## Cache and contract checks

- Input schemas are byte-identical to the original (fingerprint test), including descriptions, types, enums, defaults and bounds.
- Repeated and fresh renders produce byte-identical tool definitions; per-request cache/defer overlays do not mutate the cached base.
- No new interpolation, condition or volatile input was added. Eval's PROMPT is still a literal (its own tests check this). Tool order, gates and attachment placement are unchanged.
- New text changes the cached prefix once, for sessions that start on it.

## Validation

- node build.mjs — passed.
- node --test test/tool-prompt-contracts.test.mjs — 9 passed: schema fingerprints, stable rendering and overlays, every Browser action, Browser/Eval/Agent fix pins, 195-point coverage and a 5,950-token budget.
- node --test test/core-tool-contracts.test.mjs — 7 passed.
- bun run src/tools/BashTool/prompt.test.ts — 5 passed.
- bun run src/tools/EvalTool/evalTool.test.ts — 53 passed, including live Python execution, interruption and recovery.
- node --test test/optional-argument-placeholders.test.mjs — 13 passed; test/tool-execution-unavailable-tools.test.mjs — 6; test/openrouter-tool-execution.test.mjs — 15.
- bun run src/utils/prebuiltToolToggles.test.ts — 5; src/lanes/gemini/lazy_tools.test.ts — 15; src/lanes/openai-compat/lazy_tools.test.ts — 9.
- src/constants/prompts.compaction.test.ts cannot load in this tree (optional `@anthropic-ai/sandbox-runtime` is not installed); it fails the same way on HEAD.
- git diff --check passed; the edited files contain no control, bidi, zero-width or combining characters.

No live LLM before/after task evaluation was run, so identical model behavior cannot be guaranteed.

## Measuring behavior afterwards

`tmp/prompt-compression-baseline/` (gitignored) holds scan_tools.py and a baseline from 206 Tau transcripts (26 August – 4 October, original prompts): Eval cells and advisories, helper re-imports, Browser clicks, bare x/y clicks, no-effect and covered results, identical retries, Bash retries after errors and Agent briefing lengths. The final prompts (and the InspectSite/WebBrowser removal) shipped in the build of 2026-10-05 01:05 UTC; after a week or two run `python scan_tools.py --since 2026-10-05T01:05` and compare rates per 100 calls. The counts are small, so only large regressions will show. coverage.py and render_prompts.mjs in the same folder re-score any future trimming against the 193 points.

## History and provider audit (5 October)

**Commit history.** Every commit that touched these prompts was read (Browser 5, Agent 4, Bash 11 + 3, Eval 5). All fixes they added are in the final text, with three exceptions decided on evidence:

- Two git rules the 076bb45f cost cut dropped, which the runtime only half covers, are restored: `git rebase -i`/`git add -i` cannot work (GIT_EDITOR=true makes `rebase -i` a silent no-op), and multi-line commit messages go through a quoted heredoc (an editor commit aborts empty). They are points H27/H28.
- The other 076bb45f drops are covered elsewhere: `lsof`/`fuser` and Windows `/FLAG` CLIs by bashFailureGuidance and defensiveRewrites, `> nul` by a rewrite, destructive git operations by the system prompt's "Executing actions with care".
- "Never run a search first and then open a cell" (4e409543) was reworded in 015c3694 and is backed by the redundantScanGuard advisory.

**What each provider receives** (tmp/cache28 harness, all 28 providers, provider_tools.py):

| Tool | Result |
|---|---|
| Browser, Agent, Eval | Every provider that gets them receives 100% of the points. Lanes only append text; Kiro moves Browser's text into a "## Tool: Browser" conversation section; NIM's tool policy drops Browser. |
| Bash | Our prompt reaches 7 providers (firstParty, agentrouter, commandcode, cline, clinepass, kilocode, kiro as `shell`). The other 21 get lane-written shell text: 19 OpenAI-compat providers a 2,942-char example-driven description, OpenAI/Codex a 423-char `shell`, Antigravity gemini-cli's `run_shell_command`. |

That Bash split predates this work and is a per-lane design (weak-model compat text, codex-rs and gemini-cli parity). The lane texts carry the background, directory, quoting and (compat) Git Bash rules but not commit-only-when-asked, hook, `plan_only` or chart guidance. Transcripts show no measured harm (`plan_only` never used; `> nul` rewritten at runtime), so they are left as they are.

## InspectSite and WebBrowser removed

Both predate Browser (27 June and 8 July; Browser 18 July) and were regex HTML scrapers whose prompts still pointed at "Chrome/Playwright MCP" and at each other for everything Browser does. Over all transcripts: Browser 739 calls, WebFetch 88, WebBrowser 27 (22 snapshots, mostly tool sweeps; 5 opens), InspectSite 10, of which 5 checked Streamlit dev servers and all 5 reported "Find text: not found" on the empty client-rendered shell before the model switched to Browser.

- Removed from the registry, /tools toggles, the async-agent allowlist, the Cursor filter and the mascot list; folders deleted.
- The system prompt's dev-server nudge now names Browser ("check the real page before relying on code inspection alone"); its artifact advice moved into the Browser line, which also says to show the user a page in their own browser with the OS opener (start, open, xdg-open) through Bash — WebBrowser's only unique action.
- Browser's prompt contrasts itself with "a plain HTTP fetch" instead of the removed tools (point B02 updated).
- On eager lanes this drops two tool definitions (about 650 estimated tokens) and their system-prompt lines; async agents keep WebFetch for page checks.

## Files

- [Browser prompt](../src/tools/BrowserTool/BrowserTool.tsx)
- [Agent prompt](../src/tools/AgentTool/prompt.ts)
- [Bash prompt](../src/tools/BashTool/prompt.ts) and [shell best practices](../src/tools/BashTool/bashBestPractices.ts)
- [Eval prompt](../src/tools/EvalTool/prompt.ts)
- [Regression checks](../test/tool-prompt-contracts.test.mjs) and [original prompt points](../test/tool-prompt-points.json)
