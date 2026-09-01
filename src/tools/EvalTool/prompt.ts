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
 */

/**
 * The description is the only thing the model reads when deciding whether this
 * tool is relevant, so it names the trigger rather than the mechanism. The
 * first version described what the tool *was* ("a persistent Python kernel"),
 * and in practice the model only reached for it when a user said "use Eval".
 */
export const DESCRIPTION =
  'Answer questions about many files, large data, or repeated commands by computing the answer in Python instead of reading everything into the conversation. Persistent kernel; can call your other tools from inside the code; renders charts inline.'

export const PROMPT = `Run one cell of Python in a kernel that stays alive for the whole session.

Two things make this different from running \`python\` through Bash:

1. **State persists.** Variables, imports, parsed data and open connections
   survive from one ${EVAL_TOOL_NAME} call to the next. Parse something big
   once, then query it across many cells for free.
2. **Your tools are callable from inside the code.** \`tool.Read({...})\`,
   \`tool.Grep({...})\`, \`tool.Bash({...})\` and friends run the real tool and
   return its result as Python data. That output goes into your variables,
   **not into the conversation** — only what you \`print\` comes back to you.

## Reach for this without being asked

Use it whenever the work is "look at many things and compute an answer":

- counting, ranking, or correlating anything across more than a handful of files
- "which files…", "how many…", "what's the distribution of…", "find every X that also Y"
- parsing large logs, CSVs, JSON, lockfiles, or coverage reports
- running a command several times and aggregating the results
- comparing two sources of truth (package.json vs imports, routes vs handlers,
  translation keys vs usages)
- any chart, plot, or distribution the user would find easier to see

The test is simple: **if the intermediate data is much bigger than the answer,
the work belongs in a cell.** Pulling forty files into the conversation to
count something is the mistake this tool exists to prevent.

Do the gathering **inside** the cell — never run a search first and then open a
cell. A separate Grep or Glob pays for its entire result in context, and the
cell can find the same files for nothing with \`tool.Grep(...)\`,
\`tool.Glob(...)\`, \`os.walk\` or \`Path.rglob\`. "Let me scope it first" is the
most common way to waste a turn here: the cell scopes it for free.

Do **not** use it for a single file read, one shell command, or an edit you
already know how to make. Read, Bash and Edit are clearer for those.

## The prelude

Available in every cell without importing anything:

\`\`\`
tool.<Name>(args_dict_or_kwargs)  -> the tool's result (usually its text)
tool.list()                       -> names of the tools this kernel may call
read(path, offset=1, limit=None)  -> str            write(path, content) -> path
display(value)                    -> render a figure, image, table or object
env(key=None, value=None)         -> read or set an environment variable
log(message)                      -> a progress line for the user
\`\`\`

\`tool.Read({"file_path": "/abs/path.py"})\` — arguments are exactly the tool's
own parameters. \`tool.Grep(pattern="TODO", path="src", output_mode="content")\`
works too. A failing tool raises \`ToolBridgeError\`, so wrap risky calls in
try/except and keep going.

## Writing a cell

- One logical step per cell: set up, then use. Re-running setup is wasted work.
- **Never re-import or re-define something an earlier cell already created.**
- \`print()\` what you want to see; the last expression is also returned.
  Everything else stays in the kernel.
- Top-level \`await\` works. Do not call \`asyncio.run()\`.
- Matplotlib figures are captured automatically and rendered inline — do not
  save a PNG and read it back.
- Reading files: skip or ignore-decode binaries (\`errors="replace"\`), or a
  stray asset aborts the whole cell.
- \`input()\` is not supported. Install packages with \`%pip install <pkg>\`;
  \`%cd\`, \`%pwd\`, \`%ls\` and \`!command\` also work. \`names = %who\` lists what
  you have defined (\`%whos\` adds types and sizes) — use it to check what
  survived a restart instead of guessing. Magics only fire at the start of a
  line, so bind the result before printing it.

## Long, looping, and failed cells are safe

Every cell is bounded and interruptible, so do not refuse work for fear of
hanging the session:

- \`timeout\` is in seconds (default 60); pass \`0\` for genuinely long work.
  When it fires, only the cell stops — **the kernel and all your variables
  survive**.
- The user can interrupt a running cell at any time with the same result.
- Time spent inside a \`tool.*\` call does not count against the deadline.
- If a cell raises, the names it defined before the error still exist. Fix the
  failing step and re-run only that step.
- \`reset: true\` restarts the kernel with an empty namespace. It is cheap and
  safe — just re-run your setup afterwards. Run it when asked; do not describe
  what it would do instead of doing it.

## Worked example

\`\`\`python
# cell 1 — gather with the real Grep tool, straight into memory
hits = tool.Grep(pattern="TODO", path="src", output_mode="content")

from collections import Counter
counts = Counter(l.split(":")[0] for l in hits.splitlines() if ":" in l)
for path, n in counts.most_common(5):
    print(f"{n:3}  {path}")
\`\`\`

\`\`\`python
# cell 2 — refine. counts is still here; nothing is re-read.
print(sum(n for p, n in counts.items() if p.startswith("src/lanes/")))
\`\`\`

The 412 matched lines never entered the conversation. Only the five printed
rows did.`
