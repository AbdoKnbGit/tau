# Claude Code Git Memory

Git-backed memory plugin for Tau / Claude Code compatible plugin runtimes.

The plugin stores memories as Markdown files in a small per-project Git repository. It has no Docker service, no vector database, and no embeddings dependency.

## Install From This Repository

Register this repository as a plugin marketplace:

```bash
tau plugin marketplace add https://github.com/AbdoKnbGit/Claude-Code-Git-Memory
tau plugin install tau-git-memory@claude-code-git-memory
```

Then restart Tau or run:

```text
/reload-plugins
```

## Use Locally During Development

From any real project:

```bash
tau --plugin-dir /path/to/Claude-Code-Git-Memory/tau-git-memory
```

## Commands

```text
/tau-git-memory:status
/tau-git-memory:remember --tag pinned preferences.coding.style Keep edits focused and follow existing project patterns.
/tau-git-memory:remember --tag fallback project.default.rules When unsure, inspect files before changing behavior.
/tau-git-memory:remember project.setup.commands Use npm test before committing.
/tau-git-memory:recall setup commands
/tau-git-memory:tree
```

## Storage

Default store:

```text
~/.tau/git-memory/<project-slug>
```

Override for testing:

```bash
TAU_GIT_MEMORY_STORE=/tmp/tau-git-memory-test tau --plugin-dir /path/to/tau-git-memory
```

## Context Injection

The plugin does not inject the entire memory repo every turn.

- On `SessionStart`, it injects store status and a compact list of memory paths.
- On every `UserPromptSubmit`, it always injects compact `pinned` snippets, then keyword-searches `normal` memories on the current project memory branch.
- If keyword search finds matches, it injects `pinned + keyword`.
- If keyword search finds no normal match, it injects `pinned + fallback`.
- Pinned and fallback memories are not searched for keyword injection because they belong to separate zones.
- There is no vector database, embedding cache, or background service. The Git-backed Markdown files are the cache/source of truth.

This keeps context small: Tau sees likely-relevant facts, then can use `/tau-git-memory:recall` or the script to fetch exact memory values when needed.
