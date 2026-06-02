# Tau Bash Syntax Roadmap

This document describes how Tau builds reliable Bash commands and how the
syntax layers work together to reduce failed retries.

## Goal

Tau should avoid guessing Bash and external CLI syntax. The best path is a
stack of deterministic checks:

1. Formulate the command from structured parts when possible.
2. Parse and format the command with a native shell parser.
3. Validate against the actual local shell before execution.
4. Use CLI help and project manifests to discover exact command contracts.
5. Execute only after Tau's normal permissions, sandbox, and retry guards pass.

## Current Pipeline

### 1. Structured Command Formulation

`BashTool` accepts `command_parts` for complex external CLI commands.

Use grouped fields for simple command layouts:

```json
{
  "executable": "pytest",
  "flags": [{ "name": "k", "value": "autoencoder", "style": "equals" }],
  "positionals": ["tests/ml"]
}
```

Use ordered `tokens` when a CLI requires flags in a precise position:

```json
{
  "executable": "docker",
  "tokens": [
    { "kind": "arg", "value": "compose" },
    { "kind": "flag", "name": "file", "value": "docker-compose.yml" },
    { "kind": "arg", "value": "up" },
    { "kind": "flag", "name": "detach", "value": true },
    { "kind": "arg", "value": "api" }
  ]
}
```

Tau compiles this to safely quoted Bash and blocks execution if the raw command
does not match the compiled result.

### 2. Native Shell Parser

Tau now includes a Go helper built from `mvdan.cc/sh/v3/syntax`:

```text
dist/native/tau-shell-parse[.exe]
```

It does not execute commands. It only:

- parses Bash syntax into a native AST
- formats with shfmt-style output
- summarizes command structure
- reports parse diagnostics

This parser is a main analysis pillar when available. If the helper is missing,
Tau falls back to the existing Bash validation path so the CLI remains usable.

### 3. Actual Shell Syntax Validation

Tau still runs the actual shell in no-exec mode:

```bash
bash -n -c '<command>'
```

This remains the final syntax authority because it checks the Bash installed on
the user's machine. Native parser failures are combined with shell diagnostics
when the real shell also rejects the command.

### 4. Dry-Run Planning

For long or unfamiliar external CLI commands, `plan_only: true` returns a dry
run report. It includes:

- command domain, base command, subcommand
- native parser status and shfmt-style format
- preflight/workdir validation
- Bash syntax validation
- suggested discovery commands
- verified local `--help` output when available

The command is not executed during planning.

### 5. Proactive Auto-Plan

Complex Docker, Kubernetes, package manager, Python, build, cloud, and service
commands can be blocked before execution with an automatic plan message.

After checking the plan or running discovery, Tau can rerun with:

```json
{ "syntax_confirmed": true }
```

This only bypasses proactive planning. It does not bypass syntax validation,
permissions, sandboxing, or retry guard.

### 6. Reactive CLI Help

If a command fails with usage or unknown flag errors, Tau asks the installed
binary for authoritative help:

```bash
docker compose --help
git push -h
python -m module --help
```

This gives the model exact local syntax instead of trying random variants.

### 7. Retry Guard

Repeated failed Bash attempts are blocked. Tau must diagnose first with commands
such as:

```bash
pwd
ls
cat package.json
python -m module --help
docker compose config
```

This prevents fail-after-fail loops.

## Why This Rarely Fails

The stack catches different failure classes:

- `command_parts`: bad quoting and argument placement
- native parser: malformed shell structure and unclear command chains
- `bash -n`: actual Bash syntax errors
- preflight: missing workdir and common path mistakes
- planner: uncertain external CLI syntax
- `--help`: wrong flags and subcommands
- retry guard: repeated blind attempts

No single layer is trusted alone. Tau converges by asking deterministic tools
for syntax before executing.

## Roadmap

### Phase 1: Stabilize Native Parser

- Keep `mvdan/sh` as a non-executing analyzer.
- Add more AST summary fields when useful.
- Compare native parser output with Tau's existing tree-sitter-compatible parser.
- Keep fallback behavior for missing helper binaries.

### Phase 2: More Project Discovery

- Node: read `package.json` scripts and package manager lockfiles.
- Python: inspect `pyproject.toml`, `argparse`, `click`, and `typer`.
- Go: use `go list -json`, `go env`, and `go test -json`.
- Rust: use `cargo metadata` and `cargo test -- --list`.
- Docker: use `docker compose config` before complex compose commands.

### Phase 3: Script-Level Linting

- Add optional ShellCheck diagnostics for multiline scripts.
- Keep ShellCheck advisory at first; block only severe syntax or quoting errors.
- Add shfmt formatting suggestions for generated shell scripts.

### Phase 4: Shared Syntax Oracle

- Expose parsing, formatting, help discovery, and command compilation as a local
  MCP server if multiple Tau/OpenClaw-style agents need the same deterministic
  shell intelligence.
- Keep execution inside Tau's existing BashTool security path.

## Safety Rules

- The native parser never executes commands.
- `syntax_confirmed` never skips permissions or sandboxing.
- Missing native helper never breaks simple Bash usage.
- The real shell remains the final execution syntax check.
- Discovery commands are preferred over guessing.
