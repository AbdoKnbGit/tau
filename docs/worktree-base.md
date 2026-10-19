# Configurable worktree base

A Git worktree is another checkout of your repository, in a separate folder and on its own branch. It lets Tau work on a task while your original checkout stays available. The **base** is the commit that the new branch starts from.

Tau starts new worktrees from your current commit by default. You can instead choose the remote's current default branch when you want to begin from the shared code. This setting applies to `tau --worktree`, the EnterWorktree tool, and subagents using Git worktree isolation.

## Choose a starting point

| Option in `/config` | Setting value | What the new worktree contains |
| --- | --- | --- |
| **Current commit** (default) | `"head"` | The committed code in the checkout you are working from, including unpushed commits. No remote connection is needed. |
| **Remote default branch** | `"remote-default"` | The current default branch fetched from the configured remote. Your local-only commits are not included unless they are also on that remote branch. |

For example, suppose you have made six commits locally but have not pushed them. **Current commit** includes all six. **Remote default branch** starts from the remote's code instead. Choose based on the task: either mode can be useful whether you work alone or with a team.

`HEAD` means the commit currently checked out. It does **not** include uncommitted edits, staged changes that have not been committed, or untracked files. Commit code you want included in a new worktree first. Existing support for explicitly copying ignored files through `.worktreeinclude` still applies, and Tau propagates local settings separately.

## Configure it in Tau

1. Start Tau in your project and open `/config`.
2. Find **Worktree base (new worktrees)**. You can type `worktree` to filter the settings.
3. Select **Current commit** or **Remote default branch**, then save with Enter. Escape cancels changes.

The selection is saved in the project's `.claude/settings.local.json`. It affects subsequent new worktrees; it does not move an existing worktree to another commit.

## Configure it in a settings file

You can edit `.claude/settings.local.json` directly. To share a preference with collaborators, put it in the repository's `.claude/settings.json` instead. A local value overrides the shared project value; command-line and managed settings still follow Tau's normal settings precedence.

Merge the `worktree` values into your existing settings, preserving any other keys. The examples below show complete minimal files, not a requirement to replace your whole configuration.

For the current committed checkout:

```json
{
  "worktree": {
    "base": "head"
  }
}
```

For the remote's current default branch:

```json
{
  "worktree": {
    "base": "remote-default"
  }
}
```

If no setting supplies `worktree.base`, the default is `"head"`. If no setting supplies `worktree.remote`, the remote is `"origin"`.

### Choose a different remote

`origin` is a default remote name, not a requirement. For example, if your repository already has a remote named `upstream`, use:

```json
{
  "worktree": {
    "base": "remote-default",
    "remote": "upstream"
  }
}
```

Check your configured remote names with:

```sh
git remote -v
```

The remote must exist and be accessible to Git. Setting `worktree.remote` chooses a remote; it does not add one. The remote may point to a Git hosting service or a local bare repository. It is used for remote-default and explicit pull-request worktrees; ordinary Current commit creation does not fetch from it.

Tau asks the remote for its current default branch. It does not assume that the branch is named `main` or `master`, or that a locally cached `origin/HEAD` is still correct. `upstream` above is just an example: substitute the remote name your project uses.

## Create a worktree

From your repository, start a new Tau session in a named worktree:

```sh
tau --worktree review-login
```

Or, during a Tau session, ask:

> Create a new worktree named review-login. Tell me its starting commit, then review the login code without editing it.

Tau uses EnterWorktree and follows the selected base. Its result identifies the worktree path and actual commit. New Git worktrees are placed under the main repository's `.claude/worktrees/` directory. `review-login` is an example name; choose a new name for each independent experiment.

The setting also applies when a subagent is explicitly given Git worktree isolation. It does not enable worktrees for every task or change an ordinary session's branch.

To leave a worktree entered during the session, ask Tau to exit it and keep the worktree. ExitWorktree returns the session to the original directory. Leave the active worktree before asking the same session to enter another one.

## Check that it starts from the right code

For Current commit mode, run this in your original checkout before creating the worktree:

```sh
git rev-parse HEAD
```

Create a worktree with a new name, then run the same command inside its folder. The hashes should match, even if the original commit has not been pushed. An uncommitted edit in the original checkout should remain there; it is not part of the new worktree's starting commit.

For Remote default branch mode, inspect the remote's current commit:

```sh
git ls-remote origin HEAD
```

Replace `origin` with your configured remote name if needed. Create a worktree with a new name, then compare its `git rev-parse HEAD` output with the first column of the remote result. They should match if the remote has not advanced between the two operations. You can also ask Tau:

> Report this worktree's full Git commit hash and read the file I changed. Do not edit or commit anything.

To check freshness, publish a new commit to the remote's default branch from another checkout. Without manually fetching in your original checkout, create another worktree in remote-default mode. It should include the newly published code even while the local `origin/main` tracking ref is stale. Here `main` is only an example of a tracking branch.

These Git commands work in PowerShell, macOS shells, and Linux shells. The base selection uses Git and is independent of the AI provider. Git authentication and access to your chosen remote must already work.

## Existing worktrees and unavailable remotes

Reusing a name resumes that worktree at its own current commit. Tau does not fetch a new base or reset its existing commits and edits. Changing `/config` affects new worktrees only, so use a fresh name when comparing the two modes.

Remote-default mode fetches for every new worktree. If the remote is unavailable, authentication fails, or the default cannot be fetched, creation fails with an error. Tau does not silently substitute cached remote code or your local HEAD. Current commit mode remains available for offline work.

The selected commit is resolved before the worktree is created. Concurrent creations use separate temporary fetch refs, so one operation does not take another operation's fetched starting point.

## Troubleshooting

| What you see | What to check |
| --- | --- |
| The option is missing from `/config` | Start a Tau build that includes this feature. Restart an existing session after changing builds. |
| Local edits are missing in the new worktree | Check whether they were committed. Current commit includes unpushed commits, but not uncommitted code. |
| Changing the mode seems to have no effect | Use a new worktree name. Also check for a local, command-line, or managed setting overriding the value you edited. |
| Remote creation fails | Check `git remote -v`, then `git ls-remote origin HEAD` using the configured remote name. Resolve Git access/default-branch problems, or choose Current commit. |
| The repository has no commits | Create an initial commit before using Current commit mode. |
| The worktree branch name already exists without a resumable worktree | Choose another name. Tau refuses to overwrite that branch's commits. |

## Other worktree options

Current commit mode also supports detached HEAD and starting from another linked checkout. In the latter case, the source is that checkout's commit, while the new worktree's folder is still placed under the main repository. Existing sparse-checkout and directory-symlink settings can be used alongside `worktree.base` and `worktree.remote`.

An explicitly requested pull-request worktree uses the requested PR's commit rather than this base preference. Custom `WorktreeCreate` hooks take precedence over Git creation and choose their own starting point, including for non-Git version-control systems. The base preference does not override those hooks.

[Back to Tau features](../README.md#features)
