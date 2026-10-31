# The `-p` lab

Tests `tau -p` from end to end: which tools the model is offered, what runs without asking, permission
modes, MCP tools, what `-p` reports, and the prompt cache. It runs the real built CLI. Build first with
`npm run build`, and run these from the repo root.

## Three ways to use it

| Command | What it does | Cost |
|---|---|---|
| `node labs/print-mode/lab.mjs` | Every offline scenario on the Anthropic route | Free, about 5 minutes |
| `node labs/print-mode/lab.mjs --provider agy` | The same on the Antigravity route | Free, about 5 minutes |
| `node labs/print-mode/lab.mjs --real --provider agy` | A smaller set with the real model on that provider | **Uses your quota** |
| `node labs/print-mode/lab.mjs --real` | The same on whichever provider is active right now, with your own settings and plugins | **Uses your quota** |
| `node labs/print-mode/lab.mjs --play` | A sample project and commands to try by hand | Your quota, when you run them |

**Offline** runs use a scripted fake model. Everything else is real: the tools, the permission checks and
the request building. They use fake sign-ins in a throwaway folder, so they cannot read or change your real
account, and every model request is captured byte for byte. `--provider` takes any provider name, such as
`mistral`, `openai` or `deepseek`.

**Real** runs happen in a throwaway folder. The real model chooses what to do, so they check what happened on
disk. Each run stops after 6 model turns or 150 seconds, and the permission-skipping flags are never used. With
`--provider`, they use your normal sign-in for that provider and throwaway settings, so your active provider is
neither read nor changed. Anthropic is the exception: your login lives in your own settings, so switch to it
with `/provider` and run `--real` without `--provider`. Plain `--real` follows whichever provider is active, so
check the first line it prints.

## Useful options

| Option | What it does |
|---|---|
| `--only cache` | Only scenarios whose group or id contains the word: `tools`, `allowlist`, `paths`, `modes`, `mcp`, `output`, `cache`, `sign-in`, `antigravity` |
| `--list` | List the scenarios without running them |
| `--show <id>` | Run one scenario and print the exact command, tools offered, what was refused and what the model saw |
| `--keep` | Keep each scenario's folder, with every captured request, and print where it is |
| `--cli <path>` | Test another build, such as an older one, against the same scenarios |
| `--jobs <n>` | Run n scenarios at once. Each CLI run uses a few hundred MB of memory |
| `--max-turns <n>` | Real runs only: change the limit of 6 model turns |

Results: `PASS`, `FAIL`, `SKIP` (only for another route), and `WARN` (a known issue, or a cache number the
provider decides). The exit code is 1 only when something fails. Each run saves every command and result in
`labs/print-mode/results/`.

## What the results mean

- **`--tools` decides what the model can see.** `--allowedTools` decides what runs without permission, and
  never adds a tool. `--tools` only limits built-in tools: MCP tools stay unless you disallow them.
- **Names are exact.** `--tools read`, `--tools read_file` and `--tools Nope` all give zero tools with no
  error. `--tools=` gives zero tools on purpose and needs no quotes in any shell.
- **A refusal is not an error.** The tool does not run, the model is told, and the run ends with exit code 0.
  Look at `permission_denials` in `--output-format json`.
- **A refused real model often keeps trying other tools**, and every try costs quota. Use `--max-turns` in
  your own scripts.
- **A bare allow rule has no location limit.** `--allowedTools Write` and `--allowedTools Bash` can write
  outside the project (`path-write-outside`, `path-bash-outside`). To stay inside, use
  `--permission-mode acceptEdits` or a rule like `"Edit(src/**)"`.
- **Rules limit which commands start, not what they do.** `"Bash(node:*)"` runs any node script, and that
  script can touch anything.
- **`"Bash(mkdir:*)"` does not allow `mkdir`.** Plain `Bash` or `acceptEdits` does.

## Reading the cache results

A provider reuses its cache when the start of a request is byte for byte the same as before. So the lab
compares what was really sent:

- **Across turns** (`cache-turns*`): tools, system prompt and settings stay identical, and history only grows.
- **Across runs** (`cache-two-runs`, `cache-allowlist`, `cache-mode-*`, `cache-output-format`): these flags do
  not change the start of the request.
- **Expected changes** (`cache-tools-changes`, `cache-disallow-changes`, `cache-append-changes`): these flags do
  change it, so keep them the same between runs if you want cache hits.
- **Across a resume** (`cache-resume-*`, `cache-continue`, `real-cache-resume`): `--resume` and `-c` send the
  history that was already sent, byte for byte, including reminders, folder rules and hook context that reached the
  model. Sessions saved before this was fixed do not have those on disk, so they still re-send them once.

`--real` shows real numbers. A provider can take a while to store a new cache entry, so the real cache scenarios
pause 30 seconds between runs. To check by hand, run this twice, a little apart, and compare
`cache_read_input_tokens` with `input_tokens`:

```
tau -p "Read package.json and tell me the package name" --allowedTools Read --output-format json
```

## Add your own scenario

Add one line to `scenarios` in `scenarios.mjs`:

```js
{ id: 'my-case', group: 'allowlist', title: 'What I expect',
  args: ['--allowedTools', 'Write'],            // flags for this run
  steps: oneByOne(write('made.txt')),           // what the fake model does, reply by reply
  expect: { exists: ['made.txt'], denied: [] } }
```

| In `expect` | Meaning |
|---|---|
| `exit` | Exit code, default 0 (offline only) |
| `printed`, `notPrinted` | Pattern for the final answer |
| `offered` | `'all'`, `{ minus: [...] }`, an exact list, or `{ includes, excludes }`, in Tau tool names |
| `denied` | Exact list of tools in `permission_denials` |
| `saw`, `notSaw` | Pattern for what the tools returned to the model |
| `exists`, `missing`, `contains` | Files, relative to the working folder |
| `requests` | How many model requests were made |
| `sentOnce`, `notSent` | Text that must appear exactly once, or not at all, in the first request |
| `stable` | Tools, system and settings identical across turns, and history only grows |
| `usage` | Exact numbers in the reported `usage` |
| `credential` | `'login'` or `'key'` |
| `systemHas`, `systemLacks` | Text in the system prompt |
| `subtype`, `isError` | Fields of the JSON result |
| `cleanOutput` | No escape codes on stdout or stderr, and JSON parses as it is |

On a scenario itself: `runs` runs the CLI several times in the same folder, `compare: 'same'` or `'different'`
compares the start of the first and last run's requests, `continues: true` checks that history survives,
`only: ['agy']` limits it to a route, `setup` adds project files, a sign-in or environment variables, `mcp: true`
adds a small MCP server, and `soft: true` turns a failure into a warning. Paths can use `{workspace}` and
`{outside}`. Offline runs remove terminal variables like `WT_SESSION`, so a scenario about terminals has to set
them with `setup: { env }`, as `output-clean-json` does.
