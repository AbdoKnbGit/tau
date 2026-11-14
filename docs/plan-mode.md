# Tau Plan Mode

Plan mode lets Tau read your code and write a plan before it changes anything. You read the plan, then approve it, change it, or send it back.

## Start planning

- Press **Shift+Tab** until the footer says `plan mode on`.
- Or type `/plan`.
- Or start Tau in plan mode: `tau --permission-mode plan`.

In plan mode Tau reads and searches but does not change your code. The one file it writes is its plan.

## Where plans are saved

| Setting | Plans folder |
|---|---|
| nothing (default) | `~/.claude/plans/` |
| `"plansDirectory": "plans"` in `.claude/settings.json` | `plans/` inside your project |

`plansDirectory` is relative to the project folder and must stay inside it. Otherwise Tau uses the default folder.

## How plan files are named

1. A new plan starts with a random name, like `gentle-fluttering-narwhal.md`.
2. When you approve it, Tau gives the session a short title and renames the plan to match: `add-text-slugify.md`.
3. If that name is already taken, Tau adds the time (UTC) and, if needed, a number:
   `add-text-slugify-20261113T094802Z.md`, then `add-text-slugify-20261113T094802Z-1.md`.

The rename never overwrites another file and never changes what is inside the plan: same text, line endings and encoding.

Names work on Windows, macOS and Linux. Letters from any alphabet are kept, accents are removed, other symbols become `-`, and long titles are shortened. A title that is exactly a name Windows reserves, like `con` or `nul`, gets a `plan-` prefix. The word `agent` becomes `agentplan` (`fix-agentplan-loader.md`), because `-agent-` is kept for subagent plans.

### When the name stays random

- You named the session yourself (`/rename`, `--name`), or an earlier approval already did.
- Saving sessions is off (`"cleanupPeriodDays": 0`).
- No title could be made, for example because the provider failed. The plan simply keeps its name.
- The drive cannot give one file two names (some USB drives, FAT32, exFAT).
- It is a subagent's plan (`<plan-name>-agent-<agent-id>.md`). Those never change.

## What you see after approving

One short line in the conversation, as soon as the new name is ready:

```
Plan renamed to plans\add-text-slugify.md
```

Making the title takes a few seconds, so the line can come after the model has started answering. If an earlier message still shows the old name, this line has the current one, and `/plan` always shows the current path.

The model gets the new path with its next step, or with your next message if it had already finished. Tau does not start an extra turn for it, and the earlier conversation is sent unchanged, so the prompt cache keeps working.

## The approval menu

The options depend on your permission mode and settings. Typical ones:

| Option | What happens |
|---|---|
| Yes, auto-accept edits | Tau goes on in this conversation and edits files without asking |
| Yes, and bypass permissions | the same, and nothing asks for permission |
| Yes, manually approve edits | Tau goes on and asks before each edit |
| Yes, clear context and … | Tau starts a fresh conversation that keeps only the plan. Shown when `"showClearContextOnPlanAccept": true`. The plan is then named after the new conversation's title. |
| No, keep planning | type what to change in its box, and Tau keeps planning |

Press **Ctrl+G** in the menu to edit the plan in your editor first.

## Example setup

Plans saved inside the project, and a "clear context" choice when you approve.

Put this in `.claude/settings.json` (shared with your team) or `.claude/settings.local.json` (only you). To use it in every project, put it in `~/.claude/settings.json`.

```json
{
  "plansDirectory": "plans",
  "showClearContextOnPlanAccept": true
}
```

| Setting | What it does |
|---|---|
| `plansDirectory` | Saves plans in `plans/` inside the project instead of `~/.claude/plans/` |
| `showClearContextOnPlanAccept` | Adds a first approval option that starts a fresh conversation with only the plan. Off by default |

When you approve a plan, the menu then looks like this:

```
Would you like to proceed?
❯ 1. Yes, clear context (42% used) and auto-accept edits
  2. Yes, auto-accept edits
  3. Yes, manually approve edits
  4. No, keep planning
```

- The percentage shows how full the current conversation is.
- After "and" you may see `bypass permissions` or `use auto mode` instead, depending on your permission setup.

**Clear context** when planning filled the conversation, for example after reading many files. The work starts with only the plan, so each request is smaller. Your planning conversation is saved and you can `/resume` it later. The plan is then renamed after the new conversation's title:

```
Plan renamed to plans\add-character-count-helper.md
```

**Keep the context** when details from the planning talk still matter for the work.

## Commands

| Command | What it does |
|---|---|
| `/plan` | In plan mode: shows the current plan and its path. Otherwise: turns plan mode on. |
| `/plan <request>` | Outside plan mode: turns it on and sends your request. The request can follow on the same line or start on the next one. |
| `/plan open` | Opens the plan in your editor: `VISUAL`, then `EDITOR`. Without them: Notepad on Windows, otherwise VS Code, vi or nano. |

## Plans and your sessions

| You do | The plan |
|---|---|
| Resume (`--continue`, `--resume`, `/resume`) | comes back, renamed or not |
| `/branch`, `/clone`, `/import`, `--fork-session` | the copy gets its own plan file with the same text. Editing one never changes the other. |
| `/rewind` | restores plan edits too, also after a rename |
| `/compact` | the plan and its current path are kept |
| `/clear` | your next plan starts in a new file |

## The `.plan-metadata` folder

Inside the plans folder, Tau keeps a small `.plan-metadata` folder. It records which file is the current plan of each session and which names are taken. It has its own `.gitignore`, so it is never committed.

Don't edit, move or delete it, and don't rename plan files by hand: Tau finds renamed plans through it. If Tau ever loses track of a plan, it never guesses or overwrites. It makes a new copy instead, with the time in its name.

## Good to know

- Older Tau versions don't know about renamed plans. Resuming such a session there starts a new plan file.
- Your editor or a script can still change a plan file. Tau doesn't block them; it reads the latest text.
- A title you set yourself is never replaced, so the plan keeps its random name. There is no command to pick the plan file name.

For developers: the design and its tests are in [plan-file-naming.md](plan-file-naming.md).
