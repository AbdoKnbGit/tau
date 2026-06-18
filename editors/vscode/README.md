# Tau for VS Code

A native chat panel for the **Tau** agent, with its own UI — message bubbles,
collapsible thoughts, tool-call chips, a model/thinking picker, slash-command
autocomplete, and a cache-hit bar.

It is an **ACP client**: it spawns `tau acp` and speaks the Agent Client
Protocol over stdio, then renders everything in a custom webview. All of Tau's
engine (auth, tools, models) is reused as-is — this is purely the UI.

## Run it (development)

1. Make sure `tau` works in your terminal (the bundle is built and on PATH).
2. Open **this folder** (`editors/vscode`) in VS Code.
3. Press **F5** → "Run Tau Extension". A second VS Code window opens with the
   Tau icon in the Activity Bar. Click it to open the chat.

The build runs automatically (esbuild) before launch. No `npm install` is
needed here — `esbuild` and the ACP SDK resolve from the parent repo's
`node_modules`.

## Install it (use day to day)

```sh
# from editors/vscode
npx @vscode/vsce package --no-dependencies   # produces tau-vscode-0.1.0.vsix
code --install-extension tau-vscode-0.1.0.vsix
```

## Settings (`tau.*`)

| Setting             | Default   | Notes |
| ------------------- | --------- | ----- |
| `tau.command`       | `tau`     | Command that starts the ACP agent. |
| `tau.args`          | `["acp"]` | Args for that command. |
| `tau.cwd`           | *(empty)* | Working dir; empty = first workspace folder. |
| `tau.showCacheBar`  | `true`    | Show the cache-hit / cost bar. |

Running from a checkout instead of the global `tau`? Set
`tau.command` = `node` and `tau.args` = `["<abs>/dist/tau.mjs", "acp"]`.

## How it maps to ACP

- streaming text → `agent_message_chunk`
- collapsible thoughts → `agent_thought_chunk`
- tool chips → `tool_call` / `tool_call_update`
- model + thinking pickers → `configOptions` / `setSessionConfigOption`
- slash-command menu → `available_commands_update`
- cache bar → parsed from Tau's `⚡ N% cached` usage line
- Stop → `session/cancel`; New Chat → fresh session (restarts the agent)
