# MCP setup behavior: investigation and validation

## What caused the reported behavior

The installed SDK is `@modelcontextprotocol/sdk` 1.29.0. Its stdio transport
launches through `cross-spawn` 7.0.6, with `shell: false`. `cross-spawn` handles
Windows executable/shim resolution. Tau nevertheless emitted an unconditional
Windows warning for the name `npx`, recommending a manually added `cmd /c`.
That config-time heuristic did not describe the launcher actually in use.

The shared setup instructions compounded this: the only stdio example selected
user/global scope, scope precedence was unexplained, shell argument conversion
was unmentioned, and connection failure was mostly attributed to a non-MCP
executable. Cheap mode omitted the setup instructions entirely.

The existing health check **does perform MCP initialization**. The original
claim that it only checks JSON was false. The existing connection cache also
includes the complete scoped configuration, including command, argv and env:
editing those values does not reuse the old entry. These mechanisms were tested
and retained, rather than replaced based on the supplied diagnoses.

## Changes

- Remove the executable-name warning without rewriting persisted commands or
  adding a shell. Schema and missing-environment diagnostics remain.
- Reject malformed/non-object `add-json` input with an actionable shell-boundary
  diagnostic, without echoing the supplied JSON or writing configuration.
- Give every provider the same deterministic setup contract, including normal
  and cheap modes, before any server connects. No provider/server/package name,
  OS detection, config snapshot, secret, timestamp or health result is inserted
  into the setup rules.
- Choose local/project/user scope explicitly; explain precedence, project cwd,
  policy, approval and disabled-server restrictions, and preservation of other
  entries. Avoid silently installing globally.
- Preserve executable/argv boundaries using the documented runtime. Address
  setup-shell quoting and MSYS conversion at that boundary, including the
  structured `add-json` route. Do not guess that a received path was a switch.
- Separate saved configuration, initialize success, discovered tools and an
  authorized read-only tool test. Diagnose actual failures before changing
  commands, timeouts or other scopes; keep credentials out of shared files and
  redact displayed output.
- Add build-based regression tests, real-package checks and cross-platform CI
  coverage. The installed/global CLI and the existing MCPtest configurations
  were not modified.

## Evidence on Windows, 2026-09-30

An isolated build was made in `tmp/mcp-setup-build`, leaving `dist` untouched.
Final bundle SHA-256:
`2562f70f3b8689a3f8775084e6445eb836da1f0c448dc4520ae0661cab15bc40`.

- Setup guidance: 18 assertions passed, including actual CLI help, exact prompt
  stability, startup without servers and mode changes.
- Native/stdio/config tests: 10 passed; the POSIX executable test is skipped on
  Windows. Covers six parsed scopes, validation errors, literal argv, environment,
  cache identity/replacement, failed launches, and bare/absolute Windows shims
  with paths containing spaces. Run this file directly with Node, as below.
- CLI persistence: local/project/user round trips, duplicate rejection, scope
  precedence, isolation between projects, removal fallback, JSON preservation,
  unrelated-entry preservation and policy rejection passed in a fresh child
  directory beneath MCPtest.
- Real Git Bash: reproduced unprotected `/c` conversion, then verified exact
  argv with invocation-local `MSYS2_ARG_CONV_EXCL=*`, and exact correctly quoted
  JSON through `add-json`. Both corrected configurations completed initialization.
  The scope suite passed all four tests with this optional shell case enabled.
  An extra Windows-to-Bash `-c` quoting layer in an early test damaged JSON;
  the final fixture supplies shell input directly, matching normal shell use.
- Existing lifecycle and discovery suites: 34 assertions passed, including
  stale connection ownership and in-flight cache invalidation.
- Provider wire matrix: all 28 normal-mode providers and all 27 providers that
  support cheap mode received the setup rules on both turns and retained their
  cache prefixes. Antigravity does not support cheap mode. Requests used real
  provider serializers with intercepted network responses, **not live model
  compliance or live-provider billing/cache measurements**. Evidence directories:
  `tmp/mcp-instr/out/setup-final2-normal-20260930` and
  `tmp/mcp-instr/out/setup-final2-cheap-20260930`.

Real packages were registered through the built CLI with an isolated
`CLAUDE_CONFIG_DIR` and project. Each completed initialize, tools/list, and the
listed read-only operation, without manually added shell wrappers:

| Runner / official server | Scope | Observed server version | Tools | Tested operation |
| --- | --- | --- | ---: | --- |
| `npx -y @playwright/mcp@latest` | user | 1.64.0-alpha-1790635538000 | 25 | browser_tabs/list |
| `uvx mcp-server-git` | project | 1.30.0 | 12 | git_status |
| `npx -y @modelcontextprotocol/server-memory` | local | 0.6.3 | 9 | read_graph |

Results, configuration and the temporary Git repository were retained under
`C:/Users/ok/Desktop/MCPtest/tau-setup-real-uUnJzo/results.json`. Version strings
are server-reported, not claims about package versions. Official setup references:
[Playwright](https://github.com/microsoft/playwright-mcp),
[Git](https://github.com/modelcontextprotocol/servers/blob/main/src/git/README.md),
[reference servers](https://github.com/modelcontextprotocol/servers).

## Reproduce

From the repository root in PowerShell:

```powershell
node test/helpers/derive-mcp-test-build.mjs . tmp/mcp-setup-build
node tmp/mcp-setup-build/build-derived.mjs
$env:TAU_MCP_TEST_BUNDLE = (Resolve-Path tmp/mcp-setup-build/tau.mjs).Path
node test/mcp-setup-launch.test.mjs
node --test test/mcp-plugin-setup-guidance.test.mjs test/mcp-setup-scopes.test.mjs test/mcp-lifecycle-boundaries.test.mjs test/mcp-discovery.test.mjs

# Optional: real MSYS shell test, if Git for Windows is installed here.
$env:TAU_MCP_SETUP_BASH = 'C:\Program Files\Git\bin\bash.exe'
$env:TAU_MCP_SETUP_TEST_ROOT = 'C:\Users\ok\Desktop\MCPtest'
node --test test/mcp-setup-scopes.test.mjs

# Optional: downloads/runs public packages and retains a fresh evidence folder.
node test/mcp-setup-real.mjs C:\Users\ok\Desktop\MCPtest tmp/mcp-setup-build/tau.mjs

node test/mcp-instructions/run.mjs --net fake --cli tmp/mcp-setup-build/tau.mjs --providers all --scenarios nomcp --label setup-normal-new
```

For the cheap matrix, use `--scenarios cheap` with every provider except
`antigravity`; labels must be new for each audit. Provider fixtures are listed
in `test/mcp-instructions/run.mjs`.

## Limits and a separate launcher edge

This is a generic setup-behavior fix, not a guarantee that every external server,
interpreter, dependency install, credential or arbitrary shell program works.
Linux/macOS launch tests are wired into CI but were not executed on this Windows
host. A model receiving instructions is not proof it will follow them every time.

The adversarial Windows shim case passes when the launch suite runs directly
with Node. Under Node 24.19.0's isolated `node --test` worker, the combination of
an absolute `.cmd` path containing spaces and argv containing embedded quotes,
an ampersand and a pipe timed out. Bare command lookup and individual argument
cases passed. A standalone reproduction using only the installed MCP SDK showed
the same failure: it is not caused by Tau's config parser or this patch. It has
**not** been fixed here. The direct-run launch suite is intentional; rerunning
it as `node --test test/mcp-setup-launch.test.mjs` reproduces this limitation on
the tested host. Do not replace failed launches with a blanket shell rewrite or
claim this investigation proves arbitrary Windows shell quoting safe.
