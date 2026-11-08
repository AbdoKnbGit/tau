# The mod lab

Tests everything Tau's mods can do, from end to end: the chain of mods and its tiers, the `$` APIs, what mods
draw, `Client` modules, `$.state`, sound, telemetry, `prompt.compose` and `turn.step`. It runs the real built CLI
in a real terminal. Build first with `npm run build` (this also updates your linked `tau`), or point it at
another build with `--cli`. Run it from the repo root.

## Three ways to use it

| Command | What it does | Cost |
|---|---|---|
| `node labs/mods/lab.mjs` | Every check, on its own, in a hidden real terminal with a scripted model | Free, about a minute |
| `node labs/mods/lab.mjs --play` | The same lab in your own terminal, to try everything by hand, with the scripted model | Free |
| `node labs/mods/lab.mjs --play --provider <name>` | By hand with a real model on that provider, using your normal sign-in for it | **Uses your quota** |

**Neutral.** Every run gets its own folder with its own settings (the lab's tier lists), its own workspace and, when
offline, its own home and a fake sign-in, so your settings, plugins and account are never read or changed. With
`--provider`, the lab uses your sign-in for that provider (it lives in your home folder) and the lab's own settings.
An Anthropic subscription login lives in your own settings, so either run `/login` inside the lab session or use
the scripted model.

**The scripted model** answers every message with `LAB-ANSWER to "<what you typed>". The word SECRET-7 must never
show. LAB-WORD=<word>`. That one line shows the `turn.step` rewrite (SECRET hidden) and whether the section
`prompt.compose` added reached the model (`LAB-WORD=KIWI-42`). `LAB-TOOL` in a message makes it read a file, and
`LAB-BASH` makes it ask to run a command that writes one.

## Options

| Option | What it does |
|---|---|
| `--cli <path>` | Test another build's `cli.mjs` |
| `--keep` | Keep the run's folder (workspace, debug log, captured model requests) and print where it is |
| `--columns <n>`, `--rows <n>` | The hidden terminal's size, 200x50 by default (wide enough to dock panes) |
| `--no-fullscreen` | Without fullscreen: panes sit above the prompt, and there is no mouse |
| `--provider <name>`, `--model <id>` | With `--play`: a real model, as above |

Results: `PASS` or `FAIL` per check, and the exit code is 1 when anything fails. Each run writes
`labs/mods/results/<time>.json`, with the whole screen of every failure.

## The lab's mods

| Mod | Tier | What it does |
|---|---|---|
| `lab-org` | prepend (the organization's) | Watches every event (`*`), refuses other mods' writes into `secret/`, refuses `lab-refused` at `plugin.register`, adds `$.labkit` for every mod (`engine.create`), reads the whole chain (`next.trace`), sends `/lab-skip` past the user tier (`next.to`), sees every telemetry record |
| `lab-app` | user | The API battery (`/lab-api`), the shared counter in `$.state`, sound, questions, notifications, toasts, a ticking status line, every `classic.*` event, a note under a Bash permission dialog |
| `lab-ui` | user | The band above the prompt, the lab pane, tabbed panes, every element and control, `Client` modules, focus, scroll, close, message and fault events |
| `lab-stream` | user | `turn.step` (hides SECRET, or answers without the model) and `prompt.compose` (adds the lab word) |
| `lab-tail` | append | Where `lab-org`'s `next.to` lands |
| `lab-refused` | none | `lab-org` refuses it: nothing of it may run |

What the mods record goes to `workspace/.lab/`. After `--play`, the lab prints what is there, the `/lab-api`
result, and the mod warnings from the debug log.

## By hand: the checklist

Run `node labs/mods/lab.mjs --play` in a wide terminal (at least 144 columns: a pane a mod opens by itself waits
below that, and docking needs fullscreen and 110 columns).

**Round 1: the chain and the APIs**

1. At start, the line under the prompt counts `lab-app: ticks N` (`clock.every`, `ui.status`), and a toast says
   `lab-app: loaded at session.start`.
2. `/lab-api`: every line should read `PASS`. The first line shows `$.session.version()`: `2.1.319`, the Claude
   Code release whose mods contract Tau follows, with Tau's own release as `tau`.
3. `/lab-skip`: `lab-tail` answers it. `lab-org` sent it straight to the append tier, so `lab-app`'s hook for it
   never ran (`.lab/app-skip.json` must not exist).
4. After any message, `.lab/org-trace.json` lists `lab-app` (user), `lab-tail` (append) and the engine (core).
5. When you leave, `.lab/org-seen-events.json` lists every kind of event the session raised, and the summary shows
   `lab-refused: hooks module refused by lab-org`.

**Round 2: what mods draw**

6. The band above the prompt shows clicks, `lab-app`'s count, whether a turn is running, and `[+1]`.
   Ctrl+X Tab gives it the keys, then `p` presses `+1`. Ctrl+X Ctrl+A hides it and brings it back.
7. `/lab-pane` opens the lab pane with the keys: docked at the right in a wide fullscreen terminal, above the prompt
   otherwise. Its first line shows where it sits and its size. Try:
   - `a` (Add), `b` (Blit: the gradient's colors move), `c` (Copy, then paste it somewhere).
   - Tab through the controls (`.lab/ui-focus.json` records `ui.focus`).
   - In Note: type, use the arrows and Home/End, paste, Shift+Enter for a new line. Enter submits (`.lab/note.txt`).
   - Color: Up/Down and Enter.
   - `Collapse band` is a Button with an `action`: it runs the engine's own key action.
   - In fullscreen, hover "Hover this row", and "hover me" (two texts in one scope light up together).
   - Scroll with PgUp/PgDn or the wheel (`.lab/ui-scroll.json` records `ui.scroll`).
   - Ctrl+X and an arrow resize it, Ctrl+X X closes it, Esc gives the keys back.
8. `/lab-tabs` opens three more panes, and a row of tabs names them (cut short with `…` when long, the Esc hint
   whole). Tab to a name and press Enter to show that pane.
   - Tab A holds toasts: with Tab A showing, run `/lab-toast`. The toast shows only once you switch away.
   - Tab B closes on Esc at an empty prompt.
9. Type `please LAB-BASH now` (or ask a real model to write a file). The permission dialog shows `lab-app: this
   note sits under the dialog` (`$.ui.notice`). Esc rejects it cleanly.
10. `/lab-ask` asks a question, `/lab-notify` sends a terminal notification, `/lab-toast` shows a toast.
11. `/lab-close` closes every pane, each through `ui.close` (a toast per pane).

**Round 3**

12. `$.state`: `/lab-state` changes "lab-app count" in the band by itself, and `a` in the lab pane changes the
    band's clicks too. Nobody calls `$.ui.invalidate`: the drawings read the values, so a write redraws them.
13. `Client` modules: the band's clock ticks every second. In the lab pane, the spark animates and another clock
    ticks. Their labels end in "(answered)": each posted once when it mounted, and `lab-ui`'s `ui.message` hook
    answered with new props. In fullscreen:
    - Hovering a clock shows "pointer here".
    - Clicking it counts the click (one more `ui.message`) and gives it the keys. Type, and its "key" changes.
      Esc gives the keys back.
    - `/lab-faults` opens a pane whose Client throws: one dimmed line takes its place, and `.lab/client-fault.json`
      records `ui.fault`.
14. `turn.step`:
    - With the scripted model, the answer reads `The word [hidden by lab-stream]-7`, both while it streams and in
      the transcript. `/lab-stream` turns the rewrite off, and the next answer shows SECRET-7.
    - With a real model, ask it to write the word SECRET a few times.
    - `/lab-canned`, then any message: the hook answers it, and no model request is sent.
    - `please LAB-TOOL now`: a tool call still streams through the hook and runs.
15. `prompt.compose`: the scripted answer ends `LAB-WORD=KIWI-42`. Ask a real model "what is the lab word?".
16. `/lab-audio`: you hear a chime, then a tone, then the chime looping for about 1.5 s. Then "Tau mod lab" is spoken.
    Windows uses MediaPlayer and System.Speech, macOS afplay and say, Linux paplay or pw-play and espeak.
17. Telemetry: after `/lab-api`, `.lab/org-telemetry-lab_check.json` shows the record `lab-app` logged, with `to`
    left out and read as `anthropic`.

**What a terminal cannot do.** A Client's pointer gets clicks and crossings only, and only in fullscreen: the
terminal reports no moves or drags. Inputs and Selects inside a Client draw but do not take keys; the Client's
`onKey` does. A real model may split a word across two chunks, and `lab-stream` rewrites one chunk at a time.
