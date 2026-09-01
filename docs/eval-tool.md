# The `Eval` tool — a persistent Python kernel with a tool bridge

A cell of Python runs in a subprocess that stays alive for the session, and the
code inside it can call Tau's own tools. The point is not "Tau can run Python" —
`Bash` could already do that. The point is that work which would otherwise pull
tens of thousands of tokens into the conversation now happens inside the kernel
and returns only the answer.

```python
hits = tool.Grep(pattern="TODO", path="src", output_mode="content")

from collections import Counter
counts = Counter(l.split(":")[0] for l in hits.splitlines() if ":" in l)
for path, n in counts.most_common(5):
    print(f"{n:3}  {path}")
```

412 matched lines were read; five printed rows reached the model. `counts` is
still in memory for the next cell.

## Files

| File | Role |
|---|---|
| `constants.ts` | Names, limits, the bridge allow/forbid lists, and the cache contract |
| `prompt.ts` | Model-facing description and prompt. **Must stay literal** |
| `kernelSource.ts` | The Python kernel, embedded as a `String.raw` literal |
| `pythonRuntime.ts` | Interpreter discovery, env filtering, the availability latch |
| `kernel.ts` | Node-side client: spawn, NDJSON, cancel, kill-tree |
| `toolBridge.ts` | Loopback HTTP server; `tool.<name>()` becomes a real tool call |
| `registry.ts` | One kernel per (session, agent, cwd), plus shutdown cleanup |
| `format.ts` | Pure output clamping and bridge-call summarizing |
| `EvalTool.ts` | The tool definition |
| `UI.tsx` | Transcript rendering: cell source, output, figures, bridged calls |

Tests: `evalTool.test.ts` (48), `lanes.test.ts` (7), `bridge.test.ts` (14),
`figure.test.ts` (4), plus `services/tools/redundantScanGuard.test.ts` (15).
Run them with `bun run src/tools/EvalTool/<name>.test.ts`. The live groups skip
themselves when no interpreter (or no matplotlib) is present.

## Discovery: how the model learns to reach for it

Three layers, all static and all in the cached prefix:

1. **`DESCRIPTION`** names the trigger, not the mechanism. An earlier version
   described what the tool *was* ("a persistent Python kernel"); in a live
   session the model then only used it when a user typed "use Eval". It now
   leads with *when*: many files, large data, repeated commands, charts.
2. **`PROMPT`** carries the rule of thumb — *if the intermediate data is much
   bigger than the answer, the work belongs in a cell* — plus explicit
   permission to run long, looping, and reset cells, because the model was
   observed refusing all three out of a (wrong) fear of wedging the kernel.
3. **A bullet in `constants/prompts.ts`**, in the same "Using your tools"
   orientation list as ToolGuide/CodebaseRetrieval/LSP, gated on
   `enabledTools.has(EVAL_TOOL_NAME)`. This is the layer that makes the model
   reach for it unprompted; the tool description alone did not.

For comparison, oh-my-pi keeps `eval` as a plain tool with
`loadMode = "essential"` and adds system-prompt pressure only behind a magic
keyword (`workflowz` → `prompts/system/workflow-notice.md`, "Orchestrate in
`eval`"). Its base system prompt never mentions eval. The always-on orientation
bullet here goes further than the reference on purpose.

## Rendering

`UI.tsx` renders the cell, not a summary. The first version had no UI module at
all: the result was a one-line `N lines` string and Ctrl+O expanded to nothing,
so there was no way to see what code had run. Now:

- the cell source is syntax-highlighted (8 lines collapsed, all of it expanded)
- stdout/stderr/result follow it (10 lines collapsed)
- captured figures render inline above the body
- every bridged tool call is listed (individually up to 6, tallied beyond),
  with failures always shown
- a status line carries timeout / interrupt / restart / truncation / duration

`isResultTruncated` gates the click-to-expand affordance so the hint only
appears when expanding actually reveals more.

## Reaching every provider

Tau speaks 22 providers across 16 lanes, and a tool can be registered, enabled,
and still never arrive. `lanes.test.ts` pins each filter it has to survive:

- **Cursor** is the one lane with a hardcoded exclusion set; Eval is core
  capability, not a Tau addition, so it stays.
- **Groq small tier** (`llama-*`, `gpt-oss`) and **NIM fast** are curated
  subsets inside the openai-compat lane. Both now include Eval: the models that
  can least afford to spend a context window re-reading files are the ones that
  benefit most, and both sets already carry Agent/Skill. Remove the entry from
  `groq_tool_policy.ts` / `nim_tool_policy.ts` if a small model is measured
  writing worse cells than it saves.
- **Never deferred.** `isDeferredTool` ends at `tool.shouldDefer === true`, and
  Eval does not set it, so every provider receives the full schema on turn one
  rather than behind a ToolSearch round-trip. That also keeps cheap mode's
  promise that it never hides a tool behind a lookup.
- **Images per lane** are already handled upstream: the OpenAI adapter hoists
  tool-result images into a following user message, Gemini uses `inlineData`,
  and text-only models get OCR or a borrowed vision description through
  `lanes/shared/media_extract.ts`.

## Cheap power mode

Eval is in `CHEAP_MODE_CORE_TOOL_NAME_SET`. Cheap mode exists to spend fewer
tokens, and this is the tool that spends the fewest — a scan costing six turns
and ~190K tokens of file bodies costs one turn and a printed table. Cheap mode
also turns subagents off, which normally leaves nothing to keep bulk output out
of context; the kernel is now the only remaining route, so the mode's
capability section says so explicitly.

## The redundant-scan guard

Observed in a live session, answering "how many .tsx files are here":

    Glob for every .tsx   ->  1,737 paths into context
    Eval  os.walk('.')    ->  walked the tree again, ignored the paths

The search was not a stepping stone — the cell never referenced its result. Its
output was paid for in context and thrown away.

`services/tools/redundantScanGuard.ts` catches exactly that: a Glob or Grep
immediately followed by a cell whose code scans the filesystem itself
(`os.walk`, `glob.glob`, `Path.rglob`, `os.listdir`, `tool.Glob`, `tool.Grep`).
It returns an advisory line appended to that cell's own tool result.

It costs **zero tokens** on every turn where the pattern does not occur, and it
never touches the cached prefix — same contract as the neighbouring
`repeatToolGuard`, which it deliberately mirrors. It is narrow on purpose: a
cell that *consumes* the search result does not self-scan and is left alone, an
intervening tool call clears the pending search, and it fires at most once.

Two things keep it from being fitted to the one transcript that prompted it:

- **The tool set is a principle, not a list.** Only searches whose entire
  output is a path or match list a cell can regenerate for free — Glob and
  Grep. CodebaseRetrieval, AFTAstSearch, GitHistorySearch and TestSearch are
  excluded because a cell cannot reproduce them, so calling one first is not
  waste. Names come from the real constants, so a rename cannot silently
  disable the guard.
- **The pattern matches the method, not the receiver.** `glob.glob(...)`,
  `Path(x).glob(...)`, `Path(x).rglob(...)` and `p.iglob(...)` all trip the
  same branch. The first version was written around the `os.walk` it happened
  to observe and missed `Path(x).glob(...)` entirely — the commonest spelling
  of all. `fnmatch` and comprehensions are deliberately not matched: they
  filter a list that already exists, which means the search *was* used.

## Errors: what the model gets vs what you see

Two separate concerns, deliberately handled in two places.

**The traceback the model receives is the user's frames only.** Frames are
filtered by FILE — user code compiles with the filename `<cell>`, so anything
from another file is plumbing. An earlier version filtered by function name
(`_run_cell`, `_exec_compiled`) and therefore leaked whatever else happened to
be on the stack: `Lib/ast.py` for a SyntaxError, because the raise happens
inside `ast.parse`, and two `tau_kernel.py` frames for a bridge failure. Note
that a frame is not always one list element — a SyntaxError splits the
location, the source line and the caret across three, and only the first names
the file, so continuation lines inherit the decision. Dropping them is how the
caret went missing on the first attempt.

A cell that fails to parse also gets an explicit note: nothing in it ran and
the namespace is unchanged, so fix the syntax and re-send only that cell rather
than repeating setup.

**What you see is one line.** `splitFailure` in `format.ts` excises the
traceback block for display and shows
`SyntaxError: f-string: unmatched ')' · line 34`, with the frames behind
Ctrl+O. The block is excised rather than truncated from, because the
`[tool bridge]` summary comes *after* the traceback and cutting to the end
would swallow it. Anything the cell printed before dying is kept. The model's
copy is untouched — it is the one that has to debug the cell.

## The cache contract

This is the part to read before editing anything here.

`promptCacheBreakDetection.ts` hashes every tool's schema on every request
(`perToolHashes`). Its own comment records that 77% of tool cache breaks are
"tool prompt/schema changed, same tool set", caused by `AgentTool`/`SkillTool`
interpolating live registry state into their descriptions. Three rules keep
`Eval` from becoming the third offender, and `evalTool.test.ts` enforces each:

1. **`DESCRIPTION` and `PROMPT` are constants.** No interpreter path, no Python
   version, no bridged-tool list, no settings. The kernel can answer those
   questions at runtime — `tool.list()`, `sys.version` — which costs nothing in
   the prefix.
2. **Availability is latched.** `isEvalToolEnabled()` probes once per process
   and memoizes. A tool that appears on turn 3 because a venv showed up is a
   `+1 tools` break on a ~50–70K prefix.
3. **Registration is last.** `EvalTool` is the final entry in
   `getAllBaseTools()`. Tool order is the prefix; anything inserted mid-list
   shifts every schema after it.

The tool adds roughly 1,000 tokens to the tool block: one cache write at
session start, then cache reads. Set against that, a scan that used to take six
turns now takes one — and with one message-level `cache_control` marker per
request (`claude.ts:3869`), turns are what cost.

## Cancellation, and why it is a socket

Node's documented behavior on Windows is to ignore the signal argument to
`subprocess.kill()` and terminate the process. So the reference design this was
modelled on — `kill("SIGINT")` raising `KeyboardInterrupt` inside the cell while
the kernel survives — cannot work on Node/Windows. Every Ctrl+C would destroy
the namespace.

Instead the kernel opens a loopback socket at startup and reports its port in
the `ready` frame. The host connects and presents a shared token; a daemon
thread parked in `accept()` calls `_thread.interrupt_main()`. That raises
`KeyboardInterrupt` in the main thread on every platform. Measured here:
interrupt to `done` in 0.05s, with the namespace intact afterwards.

Escalation if the interrupt does not land within 5s (native code holding the
GIL): shut down, kill the tree, recreate on the next call. The cell is reported
as `crashed` and the model is told its state is gone.

## Windows specifics

- **Do not pass `windowsHide: true` when spawning the kernel.** It maps to
  `CREATE_NO_WINDOW`, which detaches the child from the console; NumPy's native
  extensions can deadlock inside `LoadLibraryExW` with no console attached.
  Node defaults it to `false`; `kernel.ts` spells it out so nobody re-adds it.
  Note that `lanes/shared/sandbox.ts` *does* pass it — routing the kernel
  through `runSandboxed` on Windows would reintroduce that hang.
- **Requests are dispatched serially.** A thread parked in a blocking stdin read
  deadlocks native-extension imports under a pipe-backed child on Windows
  (numpy#24290). The kernel never reads stdin while a cell is running.
- **`taskkill /T /F` for shutdown.** Windows has no process groups, so signalling
  the direct pid leaves grandchildren (a `%pip install`, a `subprocess.run`)
  holding the kernel's pipes open for the rest of the host's life.

## Permissions

The permission unit is the **cell**, not the individual bridged call. That is
already how `permissions.ts` reasons about kernel code: *"REPL code can contain
VM escapes between inner tool calls; the classifier must see the glue."*

The bridge itself is deny-based. It began as a 28-name allowlist, which
silently refused `ArtifactCanvas`, every MCP tool, and anything written later —
not because those are unsafe, but because they were not on a list typed by
hand. The bridge is a *correctness* boundary, not a security one, so the only
entries in `EVAL_BRIDGE_BLOCKED_TOOLS` are tools whose effect is on the SESSION
rather than the workspace (plan mode, worktree switches) plus Eval itself,
which would deadlock. Interactive tools are excluded generically by asking each
tool's own `requiresUserInteraction()`, so a new one is covered the day it is
written. `Snapshot` is deliberately not blocked: it manages a shadow git repo,
which is workspace state.

- `checkPermissions` returns `passthrough`, which becomes `ask` — the same
  treatment an unrecognized Bash command gets. The default (`allow`) would
  auto-approve arbitrary code execution; that would be wrong.
- `toAutoClassifierInput` returns the cell source, so auto mode classifies the
  actual Python.
- Each bridged call additionally goes through `canUseTool`, so deny/ask rules
  and the interactive prompt still apply per call.
- Per-call `PreToolUse`/`PostToolUse` hooks do **not** run. The compensating
  control is `EVAL_BRIDGE_ALLOWED_TOOLS`.
- The prelude's `write()` deliberately routes through the `Write` tool rather
  than `open(path, "w")`. A direct write would leave `FileStateCache` stale and
  the agent's next `Edit` on that file would fail with "File has been modified
  since read". Raw `open()` is still reachable from a cell; that is the user's
  own risk, and the same risk `Bash` already carries.
- Secrets are filtered out of the kernel environment by name
  (`API_KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|...`) on top of an allowlist. Note
  this does not stop a cell reading `~/.claude.json` from disk — no worse than
  `Bash`, but worth knowing, especially as there is no working filesystem
  sandbox on Windows (`lanes/shared/sandbox.ts` degrades to an env-scoped spawn
  and `@anthropic-ai/sandbox-runtime` is not installed).

## Figures

`MPLBACKEND=Agg` is set before the kernel starts. After every cell the runner
walks `pyplot.get_fignums()`, saves each figure to PNG, emits it as an
`image/png` display bundle, and closes it. Those become image blocks in the tool
result and render inline through the sixel/Kitty path added in `9aa1733`.

This closes the gap named in `docs/inline-images-handoff.md` §8: *"No
live-process capture. A plot must reach a file, a data URI, or a notebook. A
figure existing only inside a running process would need a persistent Python
kernel."*

`maxResultSizeChars` is `Infinity` on purpose — spilling a result to disk would
replace a captured figure with a file path. The cell output is already bounded
by `clampOutput` (30K chars, head and tail kept).

For text-only models, `lanes/shared/media_extract.ts` already OCRs or
vision-describes image blocks, memoized by content hash and pinned per process
so the serialized history stays byte-stable.

## Configuration

| Variable | Effect |
|---|---|
| `TAU_EVAL_DISABLE=1` | Do not register the tool |
| `TAU_EVAL_PYTHON=<path>` | Use this interpreter; skip discovery |
| `TAU_EVAL_SKIP_PROBE=1` | Assume Python is available (testing) |
| `TAU_EVAL_TRACE=1` | Log every NDJSON frame (with `--debug`) |

Discovery order: `TAU_EVAL_PYTHON` → `$VIRTUAL_ENV` → `$CONDA_PREFIX` →
`<cwd>/.venv` → `<cwd>/venv` → `python3`/`python` on PATH. Requires Python 3.10+
(the kernel uses `str | None` annotations).

## Known limits

- **Magics are rewritten line by line.** A `%` or `!` that begins a line inside
  a triple-quoted string will be rewritten incorrectly. A full AST-aware
  transform was not judged worth the surface area.
- **No stdin.** `input()` blocks until the cell is cancelled.
- **One kernel per (session, agent, cwd).** Changing cwd mid-session starts a
  second kernel rather than moving the first.
- **A killed parent does not leak a kernel.** `registerCleanup` covers a
  graceful exit; a hard kill is covered by the read loop, which exits on stdin
  EOF when the parent's pipe closes. That is load-bearing on Windows, where
  there are no process groups to clean up with, and `evalTool.test.ts` pins it.
- **Bridge calls do not appear as individual transcript entries.** They are
  summarized in the cell result (individually up to 12, aggregated beyond). The
  virtual-message path used by the dead `REPLTool` was deliberately not reused:
  `sessionStorage.ts:4508` promotes virtual messages to real ones on disk for
  external users, which for a Python cell would write a tool history that never
  happened and re-inflate on `--resume` the context the feature just saved.
