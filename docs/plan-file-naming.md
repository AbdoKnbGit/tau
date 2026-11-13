# Approved plan filenames

Plan approval can generate a session title and publish the main Markdown plan
under a safe filename derived from it. The existing session slug remains the
immutable plan-family ID. Subagent filenames and default worktree naming retain
that ID.

`plans.ts` is the path-resolution boundary. A versioned per-plan record in the
configured plans directory stores the main filename, revision, retired names,
and any incomplete cleanup. Filename reservations protect both published names
and plan identities whose first Markdown write has not happened yet. These
records are read afresh rather than cached indefinitely across processes.

## Mutation and failure handling

Native Edit/Write plan calls, plan editor sessions, rewind, recovery, and
publication use the same per-plan cross-process lock. Ordinary unrelated files
retain their existing behavior. Retired plan paths, including dangling symbolic
file aliases, are rejected for direct writes with the current path supplied to
the caller. Path comparisons resolve directories, then treat two names as one
entry only when they differ in case or Unicode form and open the same file (for
retired names, the same surviving reservation). This follows each directory's
own case rules: APFS and NTFS match such spellings, case-sensitive directories
do not, and hard links under other names stay distinct. A reservation is created
empty and written right after, so readers treat an empty one as still being
written by another process, never as corrupt. History keeps the original
tracking key while resolving the current file at the IO boundary.

Publication creates a same-directory hard link exclusively, commits the new
reference, persists session metadata, and then removes the old pathname. Existing
destinations are never replaced. Collisions use UTC timestamps and counters.
Contents, encoding, line endings, and file permissions are preserved by linking
the original regular file. Filesystems that do not support this operation leave
the original plan usable; there is no destructive copy/delete fallback.

A failed commit retains the original. A failed metadata append or cleanup can
retain both names. Recovery removes an old link only after checking both file
identities; an independently replaced file is retained as a conflict. If the new
name disappears while the original still survives, recovery can restore the
reference to that verified original. An uncommitted link may remain after a
process interruption; ambiguous files are never guessed at and deleted.

Shell commands, external tools, and older application versions do not participate
in these locks. Independent external atomic saves are detected where possible
and kept as conflicts. This protocol provides recoverable application/process
failures; it does not promise a filesystem-independent power-loss transaction.
A lock lost to another process after an event-loop stall or system sleep is
logged rather than ending the process, and a lock that cannot be removed
expires as stale instead of reporting a finished edit as failed.

Plan path checks run inside permission checks and while rendering every file
message. They reject non-Markdown names before touching the disk, compare
names before resolving directories for display, and never inspect UNC, device,
or `//host` paths (compared by spelling only), so a model-supplied path cannot
open a network connection before permission is granted. Reading plan state
never creates a plan identity: compaction and `/branch` of a conversation
without a plan reserve no names. The metadata directory carries a `.gitignore`
so a plans directory inside a repository does not offer it for commit.

## Sessions and portability

Approval jobs capture the plan and execution-session owner. Clear-context jobs
start after the new session exists. Stale results and manual title changes cannot
rename another session's plan. A successful move invalidates the active read
cache entries and holds a notice for the session's next model request: the next
tool boundary of a running turn, or the user's next prompt. It is not a queued
command, so it can neither interrupt a model stream nor start a turn of its own
when the session is idle. Session changes discard undelivered notices owned by
the previous session, and delivery itself checks the owner. Remote snapshots
check ownership across transcript persistence awaits as well.

The notice is a `plan_file_renamed` attachment. The model receives it once as
meta content with the old and new paths as written; the transcript shows one
line, "Plan renamed to …". It appends after earlier messages and does not
rewrite earlier plan instructions or tool results, alter the system prompt/tool
schemas, or reset a provider cache session. Subagents and forked side queries
cannot take it. The terminal regression tests compare the actual requests before
and after delivery and require the existing content prefix to remain unchanged,
including a rename that completes after the turn has ended. They also require
exactly one copy of the notice. Provider cache-control markers can move to newer
boundaries normally. These checks establish prefix stability, not a guarantee
that a remote provider retains or bills a cache hit. Clear-context approval
deliberately starts a new conversation and is tested within that new execution
session.

Transcript metadata and remote snapshots carry the current reference.
Compaction readers preserve it, including metadata before the boundary. Local
sessions sharing a plan ID resolve through the local record. Portable historical
sessions recover the reference and contents captured in their saved snapshot;
they do not claim knowledge of later renames elsewhere. A matching title already
present on the destination machine is never assumed to belong to the restored
plan: recovery allocates an exclusive filename instead.

Forks allocate a new identity and copy their own plan. The branch transcript
persists that identity before new model turns, so restarting cannot reattach it
to the original plan. This holds for `/branch`, `/clone`, and `/import` alike,
and also when the source plan was never written: copied rows can still name the
source slug, so the fork's own reference is always recorded. A reference for a
fresh session whose transcript does not exist yet stays cached until its first
message, like other startup metadata, and disabled session persistence keeps
references out of transcripts. Inherited history paths are rebased onto the fork while
their backup contents remain intact. Source plans are resolved in their saved
project/worktree directory before copying or restoring them. Inherited source
snapshots cannot change the fork's plan identity. Legacy transcripts without
the new metadata continue to resolve their original slug filename.

Plan-mode reminders are tied to their designated file, not just a turn count.
An inherited source reminder cannot delay the first reminder for a fork's new
file. A changed filename, agent binding, or recorded reentry refreshes the
current instructions and resets their full/sparse cycle. This adds context at
the conversation tail and preserves inherited messages and their request prefix.

## Regression tests

Run from the repository root:

```sh
npm run test:plans
```

This builds Tau and discovers every `test/plan-*.test.mjs` file, including the
existing plan-mode permission tests. After an existing build, use
`npm run test:plans -- --no-build`.

| Area | Scenarios exercised |
| --- | --- |
| Actual terminal approval | Keep context and clear context; real Write/Read/ExitPlanMode tools, delayed naming during an active HTTP model stream, continued execution, exact SHA-256 contents, and path notice delivery; a rename after the turn has ended starts no model request and reaches the next prompt once; the screen shows "Plan renamed to" and no reminder markup |
| Request prefixes | Actual CLI requests preserve system/tools and earlier message content after the notice; native Codex HTTP preserves instructions, tools, cache affinity, session headers, and every earlier input item across the rename and a later turn |
| Session ownership | Manual rename wins; stale/superseded naming; clear/resume session changes; queued notices; remote snapshots during transcript awaits |
| Plan-mode binding | Fork/rename/subagent paths refresh immediately; stable paths and directory aliases keep normal throttling; reentry resets guidance; inherited network paths cause no filesystem comparison probes |
| Persistence | Fresh-runtime `/branch` resume, independent fork edits and rewind, explicit JSONL/CLI loaders, legacy logs, compact boundaries, split metadata markers, worktree/project directories |
| Filesystem | Unicode and reserved names, long UTF-8 titles, timestamp/counter collisions, parallel processes, directory/file aliases, case semantics, no overwrite, exact bytes and file identity; UNC/device/`//host` paths cause no filesystem access; rendering unrelated files resolves no directories; metadata `.gitignore` |
| Failures | Unsupported hard links, missing source, failed manifest commit, failed transcript append, interrupted cleanup, external replacement, corrupt ownership/metadata, read-only metadata, a lock lost mid-operation, a lock that cannot be released |
| Identity | `/clone` of an unwritten plan records its own identity for a fresh runtime; `/branch` without a plan reserves nothing; fresh-session references create no metadata-only transcript; disabled persistence writes none |
| Existing consumers | Permission prefix isolation, read-cache invalidation, fresh-read requirement, Write/Edit serialization, rewind and plan editor lifecycle |
| Plan preview | Literal Windows/POSIX paths survive final Markdown rendering, including an 80-character path, longer paths, punctuation/backticks, complete plan content, and editor hints |

The provider in terminal tests is a local HTTP fixture: no paid model requests
or real project changes are required. Tests use temporary projects and settings.
The CI job runs this command in its Windows/macOS/Linux and Node 20/22 matrix.
The file-symlink integration test skips only when the host denies symlink
creation; an injected-filesystem test still exercises chained dangling aliases
and the no-network-probe boundary on those hosts. A passing local run verifies
that host, not every filesystem or an arbitrary external writer.

Ordinary preview paths display literally. Paths containing control characters,
Unicode line/format controls, or angle brackets use a JSON-quoted escaped
representation, so Markdown cannot fold a filename newline into a space or let
a path terminate the command-output wrapper. Decoding that representation with
JSON restores the original path; the filesystem path itself is never changed.
