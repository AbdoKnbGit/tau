import { EVAL_TOOL_NAME } from './constants.js'

/**
 * MODEL-FACING TEXT. BOTH CONSTANTS BELOW MUST STAY LITERAL.
 *
 * No interpolation of interpreter paths, versions, settings, the bridged tool
 * list, or anything else that can differ between two turns of one session.
 * These strings are hashed into `perToolHashes` on every request; a value that
 * moves invalidates the entire cached prefix. If the model needs to know
 * something session-specific, let it discover that at runtime from inside a
 * cell (`tool.list()`, `sys.version`) — never from this file.
 *
 * A prompt that interpolates backend availability, a discovered agent list or
 * any other live registry state is the same defect wearing a different costume,
 * however tempting the conditionality looks. Conditional text is only safe
 * AFTER the cache boundary — a tool result, never a tool schema.
 */

/**
 * The description is the only thing the model reads when deciding whether this
 * tool is relevant, so it names the trigger rather than the mechanism. The
 * first version described what the tool *was* ("a persistent Python kernel"),
 * and in practice the model only reached for it when a user said "use Eval".
 */
export const DESCRIPTION =
  'Compute an answer in Python instead of reading the raw material into the conversation — counts, rankings and audits over many files or large data, cross-checks, the same edit applied across many files, charts. Persistent kernel; can call your other tools from inside the code; renders figures inline.'

/**
 * WHY THIS PROMPT IS SHAPED THE WAY IT IS.
 *
 * Behaviour used to be gated on two literal lists: triggers ("counting,
 * ranking, correlating...") and prohibitions ("do not use it for ... an edit
 * you already know how to make"). Anything off either list fell through, so one
 * session concluded it could write files from a cell and another concluded it
 * could not. Both lists are gone. One question decides it now, and it gives the
 * same answer every time it is asked.
 *
 * That question shipped once with Bash on the READ rung. A live test then asked
 * for the ten largest files in src/ — a ranking, which the prompt calls
 * computing — and the model correctly followed the rule to `find | xargs wc -l
 * | sort -rn | head`. It took three attempts (xargs batching injected `total`
 * rows into the sort, worked around with `sed -n '5,14p'`) and silently ranked
 * by lines rather than bytes, burying the largest file at #6. Bash is a compute
 * tool; only its command-running half belongs on the read rung.
 *
 * Each correctness section prevents an observed failure, not a hypothetical
 * one: `len()` on a result string reported 4,249 files when it was a character
 * count; a hand-written POSIX root matched nothing, silently, on Windows; an
 * unscoped walk counted one source tree three times and reported 1,736 where
 * the answer was 590; and a helper was written to disk and re-imported every
 * cell, in a kernel that already keeps it.
 *
 * Register is deliberately telegraphic: fragments, arrows, capitals for the
 * imperative. It says more than the prose version it replaced in fewer bytes,
 * which matters because this text sits in the cached prefix of every request
 * and in cheap mode's core tool set.
 */
export const PROMPT = `Run one cell of Python in a kernel alive for the whole session.

Two differences from \`python\` through Bash:

1. **State persists.** Variables, imports, parsed data survive to the next
   ${EVAL_TOOL_NAME} call. Parse once, query across many cells for free.
2. **Your tools are callable.** \`tool.Read({...})\`, \`tool.Grep({...})\`,
   \`tool.Bash({...})\` run the real tool; output lands in your variables,
   **not in the conversation** — only what you \`print\` comes back.

<critical>
Before any search or read, one question: **will you READ that output, or
COMPUTE on it?**

- Don't know what to search for yet → CodebaseRetrieval.
- Will read it — one file, one known edit, hits you open next → Read, Grep,
  Glob, Edit.
- Will compute on it — count, rank, audit every X, cross-check two sources,
  same edit across many files → **this tool**, unasked.

One known edit is reading; thirty patterned edits are computing.

Bash **runs commands** — build, test, git — and you read their output. But a
pipeline that enumerates files then reduces them
(\`find … | xargs wc -l | sort | head\`) is **computing** → cell. \`xargs\`
batching silently corrupts totals, and a pipeline leaves you no variables to
refine.
</critical>

Read and Edit are not more capable than a cell — cheaper for one known change.
Anything Python can do, a cell can do, writing files included.

Do the gathering **inside** the cell: a separate Grep or Glob pays for its
whole result in context; \`tool.Grep(...)\` or \`Path.rglob\` finds the same
files for nothing.

## What a call returns

\`tool.<Name>(...)\` returns the tool's output **as text** — what you would have
seen in the conversation. A string, not a list:

- \`len(result)\` counts **characters**. Matches → \`len(result.splitlines())\`.
- Images produced → a dict with \`text\`/\`images\` keys instead; check
  \`isinstance(result, str)\` first.
- Failure raises \`ToolBridgeError\`; wrap risky calls, keep going.

Your own output is capped at 30,000 characters. Print aggregates, not lists.

## Walking the filesystem

- **Never type an absolute root.** \`root = Path(os.getcwd())\`. A hand-written
  path in the wrong form for this OS matches nothing, silently.
- **Exclude before walking:** dependency, build and VCS dirs (\`node_modules\`,
  \`.git\`, \`dist\`, \`build\`) and any worktree, backup or stale-branch copy of
  the source. A repo often holds several copies of its own tree; a blind walk
  multiplies every count, and the inflated figure looks plausible.
- Say which scope you used when you report a number.

## Prelude

\`\`\`
tool.<Name>(args_dict_or_kwargs)  -> the tool's output, as text
tool.list()                       -> tools this kernel may call
read(path, offset=1, limit=None)  -> str      write(path, content) -> path
display(value)    env(key=None, value=None)    log(message)
\`\`\`

Arguments are the tool's own parameters, dict or kwargs:
\`tool.Grep(pattern="TODO", path="src", output_mode="content")\`.

## Writing a cell

- One logical step per cell: set up, then use. Re-running setup is waste.
- \`print()\` what you want to see; the last expression is returned too.
- Top-level \`await\` works; never \`asyncio.run()\`.
- Matplotlib figures render inline — never save a PNG and read it back.
- Ignore-decode binaries (\`errors="replace"\`), or a stray asset aborts the cell.
- \`input()\` unsupported. \`%pip install\`, \`%cd\`, \`%pwd\`, \`%ls\` and \`!cmd\`
  work; magics fire only at line start, so bind before printing.

## Long, looping and failed cells are safe

Bounded and interruptible — do not refuse work for fear of hanging the session.

- \`timeout\` in seconds, default 60, \`0\` for genuinely long work. When it
  fires only that cell stops; **the kernel and your variables survive**. A user
  interrupt does the same.
- Time inside \`tool.*\` does not count against the deadline.
- After a raise, names defined before it still exist. Fix that step, re-run it.
- \`reset: true\` restarts empty. Cheap and safe — re-run setup afterwards. Run
  it when asked; do not describe what it would do instead of doing it.

## Reuse what you defined

Definitions survive between cells: gather once, refine for free.

\`\`\`python
# cell 1 — gather with the real Grep tool, straight into memory
hits = tool.Grep(pattern="TODO", path="src", output_mode="content")
from collections import Counter
counts = Counter(l.split(":")[0] for l in hits.splitlines() if ":" in l)
for path, n in counts.most_common(5):
    print(f"{n:3}  {path}")
\`\`\`

\`\`\`python
# cell 2 — counts is still here; nothing was re-read
print(sum(n for p, n in counts.items() if p.startswith("src/lanes/")))
\`\`\`

The 412 matched lines never entered the conversation; only the five printed
rows did. Never write a helper to a file and re-import it — the kernel already
keeps it. Never re-import or re-define what an earlier cell created.
\`names = %who\` lists what survived.`
