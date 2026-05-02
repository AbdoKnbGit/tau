# Tau VS Code Companion

The official VS Code companion for [Tau](https://github.com/AbdoKnbGit/tau), the multi-provider AI coding CLI. One install, one click, full IDE awareness - no env-var juggling.

## What it does

When this extension is installed, every Tau run launched inside VS Code automatically:

- Sees your **open file, current selection, and language-server diagnostics**.
- Renders **inline diffs** as real VS Code diff tabs with accept / reject buttons — the CLI waits for your decision before applying changes.
- Auto-attaches to **the right window** when you have multiple VS Code windows open.
- Inherits the **provider** you've selected in the Control Center (Anthropic, OpenAI, Gemini, OpenRouter, Groq, NIM, DeepSeek, Ollama).

You don't have to set `CLAUDE_CODE_USE_*` or `CLAUDE_CODE_SSE_PORT` yourself — the extension injects them into the launched terminal for you.

## How it works (short version)

The extension starts a tiny local WebSocket server on `127.0.0.1:<random_port>` when VS Code activates and writes a lockfile to `~/.claude/ide/<port>.lock`. When `tau` runs in a terminal launched by the extension, it reads the lockfile, opens the WebSocket, and uses MCP to ask the IDE for context (diagnostics, file content, diffs). Tau inherits the integration without any extra config.

If you launch `tau` from an external terminal, it falls back to scanning the lockfile directory and finds the matching VS Code window automatically.

## One-click usage

1. Install the extension.
2. Click the **Tau** icon in the Activity Bar.
3. Click **Launch Tau** in the Control Center.
4. Done - `tau` is running with full IDE context.

## Commands

All commands are also available through `Ctrl+Shift+P` -> search "Tau":

| Command | What it does |
|---|---|
| `Tau: Launch in Terminal` | Project-aware launch (starts beside the active file when possible). |
| `Tau: Launch in Workspace Root` | Always launches from the workspace root. |
| `Tau: Open Control Center` | Opens the sidebar panel. |
| `Tau: Switch Provider` | Quick-pick to choose Anthropic, OpenAI, Gemini, etc. |
| `Tau: Open Workspace Profile` | Open `.claudex-profile.json` for the current workspace. |
| `Tau: Open Repository` | Browse the upstream Tau project on GitHub. |
| `Tau: Open Setup Guide` | Jump to install / provider docs. |
| `Tau: Accept Diff` / `Tau: Reject Diff` | Decide on the active diff tab (also wired into the diff editor toolbar). |

## Settings

| Setting | Default | Notes |
|---|---|---|
| `claudex.launchCommand` | `tau` | Command run in the integrated terminal. |
| `claudex.terminalName` | `Tau` | Terminal tab name. |
| `claudex.activeProvider` | _(auto)_ | Active LLM provider. Drives provider env vars. |

## Requirements

- VS Code `1.95+`.
- `tau` available on your terminal `PATH` — `npm install -g @abdoknbgit/tau`.

## Tools the extension exposes to the CLI

The companion server speaks MCP and exposes:

| Tool | Used by |
|---|---|
| `getDiagnostics(uri?)` | Pulls language-server problems for a file or the whole workspace. |
| `openDiff({ old_file_path, new_file_path, new_file_contents, tab_name })` | Shows a real VS Code diff tab. Resolves with `FILE_CONTENTS:<text>` when accepted, or `FILE_REJECTED` otherwise. |
| `close_tab({ tab_name })` | Closes a previously opened diff tab. |
| `closeAllDiffTabs()` | Bulk-closes every Tau-owned diff tab. |

These are the same RPCs the compatible IDE extension implements. Tau reuses them transparently.

## Themes

Bundled: **Tau Dark** and **Tau Light**. Switch via `Ctrl+K Ctrl+T`.

## Privacy

- The companion server binds to `127.0.0.1` only — it is not reachable from the network.
- Connections are gated by a per-session random `authToken` written into the lockfile and validated via the `X-Claude-Code-Ide-Authorization` header.
- The extension does not phone home and does not collect telemetry.

## Development

```bash
cd tau-vscode
npm install
npm test          # runs node --test on src/**/*.test.js
npm run lint      # syntax-checks every .js file under src/
npm run package   # produces a .vsix via @vscode/vsce
```

The extension activates on `onStartupFinished`. Companion failures are logged to the **Tau Companion** output channel without disrupting the rest of the extension.

## License

MIT.
