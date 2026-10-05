# Tau Commands

## Auth

**`/login`**
Pick a provider and enter your credentials. Tau saves the setup, so there are no environment variables to set.

## Models

**`/models`**
Browse the live model list from your provider, search it, and set the active model.

```
/models                     open the picker
/models <query>             search the active provider
/models openrouter:kimi     search one provider
/model kimi-k2-5            set a model directly
```

**Favorites**
Press `Ctrl+F` on a model in `/models` to star it. Starred models sit at the top of the quick picker (`Alt+P`) and remember their provider, so picking one switches the provider too. Press `f` in the quick picker to star or unstar. Up to 12.

## Voice

**`/hey`**
Start a voice conversation. Hold Space to talk and release to send. Tau shows what it heard before sending it.

**`/bye`**
End the voice conversation and stop any reply still being spoken.

> **Note:** voice uses OpenAI's voice models, so you need to log in with a ChatGPT Plus or Pro account first.

## Session

**`/tree`**
Browse your sessions and their branches as a tree. Arrows move, Enter resumes, typing filters, and `Ctrl+R` renames the highlighted session. The new name also shows in `/resume`.

**`/clone`**
Copy the current session, as a backup or a fresh starting point.

**`/branch`**
Fork the session from the current point and keep the original intact.

**`/resume`**
Pick up the last session, or choose an older one.

**`/compact-settings`**
Set the compaction threshold, the context cap, and **Preserve recent context**. When preservation is on, automatic compaction keeps the most recent exchanges word for word after the summary. It is off by default. Manual `/compact` and subagents are not affected.

```
/compact-settings status    show the current settings
/compact-settings reset     restore the defaults
```

**`/files`**
List the files Tau counts as read in this session: files the model opened, @-mentioned, edited or wrote, plus the CLAUDE.md and memory files loaded at startup. Use it when Edit says a file has not been read yet. Files read through shell commands or by subagents are not listed, and the limit is 100 files.

## Usage and reports

**`/usage`**
Show provider usage live as you work.

**`/statistics`**
Show activity and tool-call details for the current session.

**`/report`**
Write a readable report of the session as Markdown, PDF or HTML.

## Shell commands

**`!command`**
Run a shell command yourself. The command and its output are added to the conversation, so the model sees them.

**`!!command`**
Run a command the model never sees, for quick checks like `!!git status`. You still see the output, marked `not sent to model`, and it costs no tokens. A few differences from `!`:

- It always runs in the foreground and cannot be moved to the background with `Ctrl+B`.
- `!!cd dir` does not change Tau's working folder. Use `!cd dir` for that.
- If Tau is busy, it waits in the queue until the current turn ends.
- In PowerShell, where `!` means "not", type `!!!(Test-Path x)` to run `!(Test-Path x)`.

## Features

**`/mode`**
Switch between `cheap` and `normal`.

- `cheap`: a small, fixed set of core tools. Optional tools, skills, agents, plugins, MCP and LSP are turned off and hidden from the model, and large results are shown as short previews you can page through. Uses the fewest tokens.
- `normal`: the default. Your `/tools` choices apply, and MCP, skills, agents and LSP load as configured.

```
/mode          open the picker
/mode cheap
/mode normal
```

Antigravity has no cheap mode. Switching to it moves the session to normal. Switching modes changes the tools and system prompt, so the prompt cache rebuilds on the next message.

**`/tools`**
Turn optional tools on or off. Core tools always stay on. Only available in normal mode.

```
/tools                      open the picker
/tools off AFT              hide a tool from the model
/tools on ProjectWorkflow   turn it back on
/tools status               show the current state
```

**`/fallback`**
Set a fallback model so Tau keeps going when a model fails mid-session.

**`/dangerously-skip-permissions`**
Skip permission prompts for this session. Only use it in a trusted sandbox. `/dangerously-skip-permissions off` turns prompts back on. To start in this mode, run `tau --dangerously-skip-permissions`.

**`/whatsapp`**
Link WhatsApp and control Tau from your phone.

**`/github`**
GitHub workflows through the GitHub CLI (`gh` required).

- `issue`: look at the repo's issues, or one issue by URL.
- `pr`: look at pull requests and act on them.
- `wrap`: stage, commit, optionally update the changelog, and push, with one confirmation before anything is pushed.
- `changelog`: write changelog notes from the commit history.
- `triage`: label and sort issues, with confirmation before any change.
- `release`: check the working tree and CI, then tag and publish.

**`/safetest`**
Run a file in a throwaway E2B cloud sandbox and get a report back. Nothing runs on your machine. Set it up once with `/login` -> **E2B Security**.

**`/pin`**
Save a short instruction that Tau adds to the end of every message you send, such as "reply in French" or "only edit files in `src/`". It costs a few tokens per message and does not break the prompt cache.

**`/learned`**
After a substantial task, Tau can suggest one general lesson for you to approve, edit or skip. Approved lessons carry over to future sessions and projects. `/learned` lets you view, add, edit or delete lessons, or turn learning off.

**Message header**
Show the date, time or model above each reply. Set it in `/config` -> **Message header above replies** and press Space to cycle the options. It is display only and never sent to the model.

```
off                      never shown
transcript               only in the Ctrl+O transcript (default)
always:time              10:00 AM
always:time+model        10:00 AM   claude-opus-5
always:date+time         27 Aug 2026 10:00 AM
always:date+time+model   27 Aug 2026 10:00 AM   claude-opus-5
```

Press Enter to leave `/config` and save. Escape discards your changes.

**`/mascot`**
A small figure above the prompt that acts out what Tau is doing: walking while it works, hammering during edits, running during commands, and hopping when a turn ends. He slows down as the context fills up. He is off by default and purely visual, so nothing reaches the model. He needs a terminal of at least 40x24 with 256 colors.

```
/mascot        toggle
/mascot on
/mascot off
```

**`/statusline`**
Customize the row under the prompt. By default it shows the folder, provider and model, and context usage. `/statusline` writes a `statusLine` command into `~/.claude/settings.json` for you.

```
/statusline                              import your shell prompt (bash/zsh)
/statusline show git branch and model    describe what you want
```

On Windows, describe the row you want, since there is no shell prompt to import. Set `sessionStatusBar` to `false` to hide the default row, or `true` to show it alongside your own.
