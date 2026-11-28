# Orchestrate other Tau sessions

One Tau session can act as an **orchestrator**: it plans, hands the real work to other Tau sessions on the same machine, and collects their answers. Each **worker** works in its own folder, with its own settings, provider and model, in its own window where you can watch it and step in.

## Quick start

1. In each project that should take tasks, start Tau and run `/peers on`.
2. Start the orchestrator: `tau --orchestrate`.
3. Ask for work in plain words, for example *"Have the api session fix the failing login test"*. The orchestrator finds the sessions, sends the tasks, and tells you what came back.

You don't have to name tools. The orchestrator is told it delegates, and it uses ListPeers, SendMessage and OpenPeer on its own.

## Orchestrator and workers

| | Orchestrator | Worker |
| --- | --- | --- |
| Started with | `tau --orchestrate` | Any `tau`, then `/peers on`. Or a window the orchestrator opened |
| Footer | `◆ orchestrator`, plus the number of tasks it waits on | `● worker`, plus whose task it runs right now |
| Does | Reads, plans, sends tasks, opens sessions | The work, in its own permission mode |
| Never | Changes files or runs commands that change things | Sends tasks |

A session is never both, so a task can't bounce back and forth, and an answer never asks for another answer. Without `--orchestrate` and without `/peers on`, Tau works exactly as before.

## How a task travels

- The orchestrator sends a task with SendMessage to `peer:<name>`. The name is the session's title, or its folder name. When two sessions share a name, an id prefix from ListPeers picks one.
- The worker runs the task as a turn of its own once it is idle. It never runs inside your prompt, and you see it in the worker's window.
- The answer is the last thing the worker wrote for that task. It goes back as soon as that turn is over: when the next task or prompt starts, or when the worker is idle again. If you press Esc in the worker, the orchestrator hears "interrupted". If you close the window, it hears "closed".
- The orchestrator gets each answer as a notification and carries on. It doesn't wait or poll.

## Opening sessions

When no running session fits, the orchestrator uses OpenPeer to open one in a new terminal window. That can be a new session in a folder, or a closed session again with its whole history. It asks your permission each time. A window opened this way takes tasks only from that orchestrator, until you run `/peers on` in it.

Built-in window commands:

| Where Tau runs | Window it opens |
| --- | --- |
| Inside tmux (any OS) | A new tmux window |
| Windows with Windows Terminal | A new tab in the current Windows Terminal window |
| Windows without it | A new console window |
| macOS or Linux outside tmux | None by default; set `peers.openCommand` |

Without a window command, the orchestrator tells you the two lines to run, and the task waits up to 6 hours for that session.

`peers.openCommand` is the command as a list of arguments. `{tau}` becomes the Tau command as separate arguments and must be an argument of its own. `{tauLine}` becomes the same command as one shell line. `{folder}` and `{title}` can appear inside any argument. Examples:

```json
{ "peers": { "openCommand": ["wezterm", "start", "--cwd", "{folder}", "--", "{tau}"] } }
```

```json
{ "peers": { "openCommand": ["kitty", "--directory", "{folder}", "{tau}"] } }
```

```json
{ "peers": { "openCommand": ["gnome-terminal", "--working-directory={folder}", "--", "{tau}"] } }
```

## The orchestrator doesn't do the work itself

In an orchestrator session, any tool call that would change something is refused, with a message telling the model to give the work to a session. This holds in every permission mode, bypass included, and for the orchestrator's own subagents.

- **Refused:** file edits, commands that change things, Python, and MCP actions not marked read-only.
- **Allowed:**
  - Reading: Read, Glob, Grep, web tools, and read-only commands such as `git status`.
  - Running the session itself: its task list, plan mode, skills, and subagents, which may read but not edit.
  - Writing Tau's own files: the plan, memory and scratchpad.

Running tests or builds changes things too, so the orchestrator asks a session to run them. For hands-on work, use a normal `tau` session.

## Permissions

| Orchestrator | Worker | What happens |
| --- | --- | --- |
| Bypass off | Not in bypass | The task runs in the worker's own mode. Prompts appear in the worker's window, and ListPeers shows it as waiting. |
| Bypass on | Default, accept edits or auto | The worker turns bypass on for that task only. A notice says why. When the task's turn ends, it goes back to its own mode. |
| Bypass on | Plan mode | The worker stays in plan mode. Bypass doesn't turn on. |
| Bypass on | Bypass forbidden by its settings or policy | Bypass doesn't turn on, and the worker asks as usual. |
| Bypass off | Bypass on (chosen in the worker) | The worker declines the task. A session with checks off takes tasks only from one that has them off too. |

"Bypass on" includes plan mode with bypass turned on. While a worker runs an orchestrator's task in bypass, other sessions still see its own mode. Another orchestrator's task is therefore taken, and it runs afterwards with the worker's usual checks. To forbid bypass in a project, set `"permissions": { "disableBypassPermissionsMode": "disable" }` in its settings.

## Prompt cache

Taking part changes nothing that providers cache:

- An orchestrator's tools are fixed when it starts. Workers' system prompt and tools never change: not when you run `/peers on` in the middle of work, not when a task arrives, not when bypass turns on or off for a task.
- A task is added at the end of the worker's conversation as a new turn, so everything before it stays cached.
- The footer badges are on screen only and never reach a request.
- Sessions that take no part send exactly the same requests as before.

## Guards

- Answers never trigger answers.
- An orchestrator sends at most `peers.taskLimit` tasks between two of your own messages (default 20).
- A task nobody read within 15 minutes expires. For a window that is still opening, the limit is 6 hours.
- Answers are cut at `peers.replyLimit` characters (default 8000).
- The orchestrator treats an answer as a report from another session, never as your instruction.
- Everything stays on your machine, in `tau-peers` inside Tau's config folder.

## Commands and settings

| | |
| --- | --- |
| `tau --orchestrate` | Start an orchestrator. Not available with `--print`. |
| `/peers` | Show this session's role and the sessions that take tasks |
| `/peers on`, `/peers off` | Start or stop taking tasks in this session |

| Setting | Default | Meaning |
| --- | --- | --- |
| `peers.inbound` | `"off"` | `"on"` makes every new session take tasks without `/peers on` |
| `peers.replyLimit` | `8000` | Most characters of an answer the orchestrator gets back |
| `peers.taskLimit` | `20` | Most tasks an orchestrator sends between two of your messages |
| `peers.openCommand` | built-in | Window command for OpenPeer, see above |

```json
{
  "peers": {
    "inbound": "on",
    "replyLimit": 8000,
    "taskLimit": 20
  }
}
```
