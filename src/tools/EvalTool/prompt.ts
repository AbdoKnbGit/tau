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
 * cell, in a kernel that already keeps it. A PDF read by shelling out to the
 * pdftotext that Bash had found failed twice in a cell on Windows — first not
 * on the kernel's PATH, then tried by its MSYS path — while pypdf sat in the
 * kernel unused.
 *
 * The re-import happened under a plain "never re-define" rule, so persistence
 * is taught by the two-cell worked example below, not by prohibition alone.
 * That example, "a str, not a list" and the incident's own pipeline are pinned
 * by test/tool-prompt-contracts.test.mjs: shorten around them, not through them.
 *
 * Register is deliberately telegraphic: fragments, arrows, capitals for the
 * imperative. It says more than the prose version it replaced in fewer bytes,
 * which matters because this text sits in the cached prefix of every request
 * and in cheap mode's core tool set.
 */
export const PROMPT = `Run one Python cell in a kernel that lives for the whole session. Two differences from \`python\` through Bash:
1. **State persists.** Variables, imports and parsed data survive between ${EVAL_TOOL_NAME} calls: parse once, query across cells for free.
2. **Your tools are callable.** \`tool.Read\`, \`tool.Grep\`, \`tool.Bash\`… run the real tool; output lands in your variables, **not in the conversation**: only what you \`print\` comes back.

<critical>
Before any search/read: **will you READ the output or COMPUTE on it?**
- Unknown search target → CodebaseRetrieval.
- Will read it — one file, one known edit, hits to open next → Read, Grep, Glob, Edit.
- Compute — count, rank, audit every X, cross-check two sources, the same edit across many files → **this tool**, unasked.
One known edit is reading; thirty patterned edits are computing.
Bash runs commands (build, test, git) whose output you read. A pipeline that enumerates then reduces files (\`find … | xargs wc -l | sort | head\`) is **computing** → cell: \`xargs\` batching silently corrupts totals, and a pipeline keeps no variables to refine.
</critical>

Read/Edit are not more capable than a cell, only cheaper for one known change. Anything Python can do, a cell can, file writes included.
Do the gathering **inside** the cell: a direct Grep/Glob pays for its whole result in context; \`tool.Grep(...)\` or \`Path.rglob\` finds the same files for nothing.

## Calls and output
\`tool.<Name>(...)\` takes the tool's own parameters, as a dict or kwargs, and returns what the conversation would have shown, **as text: a str, not a list**.
- \`len(result)\` counts characters; matches → \`len(result.splitlines())\`.
- Image results → a dict with \`text\`/\`images\`; check \`isinstance(result, str)\` first.
- Failures raise \`ToolBridgeError\`; catch risky calls and keep going.
\`print()\` aggregates, not lists; the last expression also returns. Output cap: 30,000 characters.
Prelude: \`tool.list()\` → callable tools; \`read(path, offset=1, limit=None)\` → str; \`write(path, content)\` → path; \`display(value)\`, \`env(key=None, value=None)\`, \`log(message)\`.

## Gather once, refine for free
\`\`\`python
# cell 1: gather with the real Grep tool, straight into memory
hits = tool.Grep(pattern="TODO", path="src", output_mode="content")
from collections import Counter
counts = Counter(l.split(":")[0] for l in hits.splitlines() if ":" in l)
print(counts.most_common(5))
\`\`\`
\`\`\`python
# cell 2: counts is still here; nothing is re-read
print(sum(n for p, n in counts.items() if p.startswith("src/lanes/")))
\`\`\`
The 412 matched lines never entered the conversation; only the five printed rows did. Never re-import or re-define what an earlier cell created, or write a helper to disk to re-import: the kernel already keeps it. \`names = %who\` lists survivors.

## Filesystem
- Never type an absolute root: \`root = Path(os.getcwd())\`; a path in the wrong form for this OS silently matches nothing.
- Exclude BEFORE walking: dependency/build/VCS dirs (\`node_modules\`, \`.git\`, \`dist\`, \`build\`) and worktree/backup/stale-branch copies of the source. A blind walk multiplies every count, and the inflated figure looks plausible.
- Report the scope you used with every number.

## Cells
- One logical step per cell: set up once, then reuse.
- Top-level \`await\`, never \`asyncio.run()\`.
- Matplotlib renders inline; never save a PNG to read it back.
- Decode with \`errors="replace"\` so a stray binary doesn't abort the cell.
- No \`input()\`. \`%pip install\`, \`%cd\`, \`%pwd\`, \`%ls\`, \`!cmd\` work; magics fire only at line start: bind before printing.
- Check packages here (\`import x\`), never via Bash, whose \`python\` can be another install; \`%pip install x\` installs into this kernel.
- File formats: a kernel library (\`pypdf\`, \`fitz\`, \`openpyxl\`, \`pptx\`, \`zipfile\`) before a program. If a program is needed, find it here with \`shutil.which\`; paths Bash printed (\`/c/…\`, \`/mingw64/…\` on Windows) may not be this Python's form.

## Timeout, failure, reset
Cells are bounded and interruptible; do not refuse long/looping work for fear of hanging the session.
- \`timeout\`: seconds, default 60; \`0\` for genuinely long work. A timeout or user interrupt stops only that cell; the kernel and your variables survive.
- Time inside \`tool.*\` is excluded from the deadline.
- Names defined before a raise persist; fix and rerun only that step.
- \`reset: true\` restarts empty, cheaply and safely; rerun setup after. Run it when asked; do not describe what it would do instead of doing it.`
