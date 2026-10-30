# Tau Print Mode

`tau -p` runs one task with no interface: it does the work, prints the answer and exits. Use it in scripts, CI jobs, git hooks and pipes.

It uses your active provider, model and sign-in, like normal Tau. It skips the folder trust prompt, so run it only in folders you trust.

## Try it

```
tau -p "Explain what this project does"

git diff | tau -p "Review this change. List real bugs only." --tools=
cat error.log | tau -p "Find the cause of this crash" --tools=

tau -p "Fix the typo in README.md" --allowedTools Edit
tau -p "Find security problems in src/auth" --tools Read,Grep,Glob --max-turns 15
tau -p "Fix the lint errors" --permission-mode acceptEdits --allowedTools "Bash(npm run lint:*)" --max-turns 20
```

`--tools=` gives the model no tools, so it answers only from the text you send it.

## What it may do

Nobody is there to say yes, so Tau never asks. With no flags:

| Runs | Refused |
|---|---|
| Reading and searching in this folder | Creating or editing files |
| Safe commands like `echo` | Commands that change things |
| | Web tools, MCP tools, reading outside this folder |

A refusal does not stop the run. The model is told, then tries another way or answers, and the exit code stays 0.

Allow or block only what the task needs:

| To | Use |
|---|---|
| Allow a tool | `--allowedTools Edit` or `--allowedTools Read,Write` |
| Allow one command | `--allowedTools "Bash(npm test:*)"` |
| Allow edits in one folder | `--allowedTools "Edit(src/**)"` |
| Allow edits anywhere in this folder | `--permission-mode acceptEdits` |
| Block a tool or a command | `--disallowedTools Write` or `--disallowedTools "Bash(rm:*)"` |
| Protect a folder | `--disallowedTools "Read(secret/**)"` |
| Reach another folder | `--add-dir ../other` |
| Show the model only some tools | `--tools Read,Grep,Glob` |
| Show it no tools | `--tools=` |
| Turn off all checks, in a sandbox only | `--dangerously-skip-permissions` |

`--tools` decides what the model can see. `--allowedTools` decides what runs without asking, and never adds a tool. Blocking always wins, even over `--dangerously-skip-permissions`.

To keep rules with the project, put them in `.claude/settings.json`:

```json
{ "permissions": { "allow": ["Write"], "deny": ["Read(secret/**)"] } }
```

## Watch out

- **A bare rule has no location limit.** `--allowedTools Write` or `Bash` can also write outside this folder. To stay inside, use `--permission-mode acceptEdits` or a rule like `"Edit(src/**)"`.
- **A command rule limits what starts, not what it does.** `"Bash(node:*)"` runs any script, and that script can touch anything.
- **Names are exact, and a wrong one gives no error.** `--tools read` leaves the model with no tools at all. Use the names below on every provider.
- **`--tools` only limits built-in tools.** MCP tools stay. Remove them with `--disallowedTools mcp__server__tool`.
- **A refused model may keep trying other tools, and each try costs quota.** Set `--max-turns` in scripts.

## Use the result

| Output | You get |
|---|---|
| Default | The final answer as plain text |
| `--output-format json` | One JSON object at the end |
| `--output-format stream-json --verbose` | Live events, one JSON object per line |

The JSON has `result`, `is_error`, `num_turns`, `session_id`, `usage`, `total_cost_usd`, and `permission_denials`, which lists every tool that was refused.

```
tau -p "Name this project" --output-format json | jq -r .result
(tau -p "Name this project" --output-format json | ConvertFrom-Json).result    # PowerShell
```

The exit code is 0 when the run finished, even if a tool was refused, and 1 when it failed or reached `--max-turns`.

## Continue a conversation

```
tau -c -p "Now add tests"                         the latest conversation in this folder
tau -p "Now add tests" --resume <session_id>      a specific one, using session_id from the JSON
tau -p "One-off question" --no-session-persistence    do not save this run
```

## Save money with the cache

Providers reuse their cache when a request starts with the same bytes as before. Tau keeps those bytes stable, so to get the most from it:

- Keep `--tools`, `--disallowedTools` and `--append-system-prompt` the same between runs. Changing them starts the cache again.
- Change `--allowedTools`, `--permission-mode` and the output format freely. They do not affect the cache.

To check, run a task twice with `--output-format json` and compare `cache_read_input_tokens` with `input_tokens` in `usage`.

## Anthropic sign-in

If `ANTHROPIC_API_KEY` is set, `-p` uses that key rather than your subscription, unless you already answered No for that key in normal Tau. To use your subscription, remove the variable or answer No.

## Other useful flags

| Flag | What it does |
|---|---|
| `--model <id>` | Use another model for this run |
| `--max-turns <n>` | Stop after n model turns |
| `--append-system-prompt "Be brief."` | Add to the system prompt |
| `--system-prompt "..."` | Replace the system prompt |
| `--mcp-config mcp.json` | Load MCP servers from a file. Add `--strict-mcp-config` to use only those |
| `--permission-mode plan` | Read and plan only. `explore` also reads only, `dontAsk` refuses what is not allowed, and `bypassPermissions` runs everything |

## Tool names

For `--tools`, `--allowedTools` and `--disallowedTools`. The list can be shorter depending on your provider and settings.

```
Agent, ArtifactCanvas, AskUserQuestion, Bash, Browser, ChangeRisk, CodebaseRetrieval, Edit, EnterPlanMode,
EnterWorktree, Eval, ExitPlanMode, ExitWorktree, FileDiff, GitHistorySearch, Glob, Grep, NativeGitSummary,
NativeSysInfo, NotebookEdit, PackageManager, ProjectWorkflow, Read, RepoContextScout, SendMessage, Skill,
Snapshot, TaskOutput, TaskStop, TodoWrite, ToolOutputRetrieve, ToolSearch, VisualDesignAudit, WebFetch,
WebSearch, WorkflowRecipe, Write
```

In the repo, [`labs/print-mode`](labs/print-mode/README.md) tests all of this end to end.
