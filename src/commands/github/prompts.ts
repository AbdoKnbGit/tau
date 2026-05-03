export const ALLOWED_TOOLS = [
  'Bash(gh:*)',
  'Bash(gh issue:*)',
  'Bash(gh issue view:*)',
  'Bash(gh issue list:*)',
  'Bash(gh issue edit:*)',
  'Bash(gh issue close:*)',
  'Bash(gh issue comment:*)',
  'Bash(gh pr:*)',
  'Bash(gh pr view:*)',
  'Bash(gh pr list:*)',
  'Bash(gh pr diff:*)',
  'Bash(gh pr checks:*)',
  'Bash(gh pr edit:*)',
  'Bash(gh pr create:*)',
  'Bash(gh pr review:*)',
  'Bash(gh pr comment:*)',
  'Bash(gh repo:*)',
  'Bash(gh repo view:*)',
  'Bash(gh release:*)',
  'Bash(gh release create:*)',
  'Bash(gh release view:*)',
  'Bash(gh api:*)',
  'Bash(gh workflow:*)',
  'Bash(gh workflow run:*)',
  'Bash(gh workflow view:*)',
  'Bash(gh label:*)',
  'Bash(gh label list:*)',
  'Bash(gh label create:*)',
  'Bash(git:*)',
  'Bash(git status:*)',
  'Bash(git branch:*)',
  'Bash(git checkout:*)',
  'Bash(git checkout -b:*)',
  'Bash(git add:*)',
  'Bash(git commit:*)',
  'Bash(git push:*)',
  'Bash(git fetch:*)',
  'Bash(git pull:*)',
  'Bash(git log:*)',
  'Bash(git diff:*)',
  'Bash(git tag:*)',
  'Bash(git describe:*)',
  'Bash(git remote:*)',
  'Bash(git rev-parse:*)',
  'Bash(git show:*)',
  'Bash(git blame:*)',
  'Read',
  'Edit',
  'Write',
  'Glob',
  'Grep',
  'WebFetch',
]

const SAFETY_RULES = `## GitHub Safety Protocol

- NEVER edit git config or rewrite history (no rebase -i, no force-push to main/master).
- NEVER skip hooks (--no-verify, --no-gpg-sign) unless the user explicitly asked.
- NEVER commit secret-bearing files (.env, *.pem, credentials.json) — warn the user instead.
- ALWAYS create NEW commits, never amend, unless the user explicitly asked.
- If you are about to take a write action that crosses the network (push, gh pr create, gh release create, gh workflow run, closing/labelling an issue), confirm the plan with the user FIRST unless they have already authorized it in this turn.
- Use HEREDOC for multi-line commit/PR/release bodies so quoting stays clean.`

export const HELP_TEXT = `# /github — full repo manager

Run \`/github\` with no arguments to open the interactive picker, or pass a subcommand directly:

- \`/github issue <url|#number>\` — describe an issue and (for #number) propose a fix; labels it only if you have write access (does NOT change code without confirmation)
- \`/github pr <url|#number>\` — review a pull request and surface the Good / Bad / Ugly
- \`/github wrap [--branch=<name>] [--issue=<n>] [instructions]\` — commit, push, optionally close an issue, update changelog
- \`/github changelog\` — audit git history since last release and draft changelog notes
- \`/github triage\` — label, deduplicate, and assign open issues
- \`/github release <version>\` — bundle changelog, tag, push, publish a GitHub release, trigger deployment

Example:
- \`/github issue https://github.com/SleepyCatHey/Ultimate-Win11-Setup/issues/11\`
- \`/github issue 22\`
- \`/github pr 45\`
- \`/github wrap --issue=42 fix mobile checkout button\`
- \`/github release v2.0.1\``

function parseIssueOrPrTarget(raw: string): {
  display: string
  parsedHint: string
  isUrl: boolean
} {
  const trimmed = raw.trim()
  if (!trimmed) {
    return {
      display: '<none provided>',
      parsedHint:
        'No target was supplied. Tell the user the command needs a URL or a number, then stop.',
      isUrl: false,
    }
  }
  const urlMatch = trimmed.match(
    /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/(issues|pull)\/(\d+)/i,
  )
  if (urlMatch) {
    const [, owner, repo, kind, num] = urlMatch
    return {
      display: trimmed,
      parsedHint: `The user supplied a full GitHub URL.
- owner: \`${owner}\`
- repo: \`${repo}\`
- kind: \`${kind}\`
- number: \`${num}\`
Use \`--repo ${owner}/${repo}\` on every \`gh\` call. Do NOT assume the current repo.`,
      isUrl: true,
    }
  }
  if (/^#?\d+$/.test(trimmed)) {
    const num = trimmed.replace(/^#/, '')
    return {
      display: `#${num}`,
      parsedHint: `The user supplied just a number (\`${num}\`). Resolve it against the current repo (run \`gh repo view --json nameWithOwner -q .nameWithOwner\` once if you need the slug). Do NOT pass \`--repo\` unless the lookup fails.`,
      isUrl: false,
    }
  }
  return {
    display: trimmed,
    parsedHint: `The argument did not parse as a URL or number. Show the user this help text:\n\n  Usage: <subcommand> <github-url> | <number>\n\nThen stop.`,
    isUrl: false,
  }
}

export function buildIssuePrompt(args: string): string {
  const { display, parsedHint, isUrl } = parseIssueOrPrTarget(args)

  const finalSection = isUrl
    ? `### Step 5: Stop here

The user supplied a URL — the issue may live in a repo other than this checkout, so the source code is not necessarily available. Do NOT \`Grep\`/\`Glob\`/\`Read\` source files and do NOT propose a code fix.

End your reply with the description from Step 4 plus this note: "Issue referenced by URL — open the repo locally if you want a code-level investigation." Then STOP.`
    : `### Step 5: Investigate and propose a fix

The user supplied a number — the issue lives in this checkout's repo, so the source is available.

1. Use \`Grep\`/\`Glob\`/\`Read\` (and \`git log\` / \`git blame\` when ownership matters) to locate the affected code paths. Cite \`file:line\` for every claim.
2. Form a hypothesis for the root cause and a small, concrete fix. No unrelated cleanup.
3. After the description from Step 4, add:
   - **Root cause:** the file/function and why it fails.
   - **Proposed fix:** the concrete change (a few lines or a short patch sketch).
   - **Question:** "Apply this fix now?" — and STOP.

DO NOT modify code, open a PR, or push anything until the user replies "yes" / "go ahead". Only the labels (when permission allowed it in Step 3) happened automatically.`

  return `# /github issue — investigate

User target: \`${display}\`

${parsedHint}

${SAFETY_RULES}

## Your task

Run these steps in order. Do NOT skip ahead. The whole point of the ordering is to avoid \`gh\` commands that will fail visibly — diagnose first, act only when safe.

### Step 1: Read the issue

1. Resolve the target repo:
   - URL target → use the \`<owner>/<repo>\` from the parsed hint above; pass \`--repo <owner>/<repo>\` on every \`gh\` call.
   - Number target → resolve current repo once: \`gh repo view --json nameWithOwner -q .nameWithOwner\`.
2. Fetch the issue:
   \`gh issue view <number> [--repo <owner/repo>] --json number,title,body,state,labels,assignees,author,comments\`
3. If \`state\` is \`CLOSED\`, tell the user the issue is already closed and STOP — do not relabel it.

### Step 2: Check write permission (silent)

Run exactly one check before touching any labels:
\`\`\`
gh api "repos/<owner>/<repo>" --jq '.permissions.push // false' 2>/dev/null || echo false
\`\`\`
- Output \`true\` → you have write access (author / collaborator / maintainer) → proceed to Step 3.
- Output \`false\` or empty → you do NOT have write access → SKIP Step 3 entirely and jump straight to Step 4. Do NOT attempt \`gh issue edit\`, \`gh label create\`, or any label-mutating call — they would fail and clutter the output.

### Step 3: Apply labels by category and criticality (only if Step 2 returned \`true\`)

1. List the repo's existing labels once: \`gh label list [--repo <owner/repo>] --limit 100 --json name --jq '.[].name'\`. Hold the set in memory.
2. From the issue body, decide which labels apply — only ones already in that set:
   - **Category** — \`bug\`, \`enhancement\`, \`documentation\`, \`question\`, or \`chore\`.
   - **Criticality** — only if labels like \`P0\`/\`P1\`/\`P2\`, \`high priority\`, \`critical\`, \`low priority\` exist in the set. Be conservative: \`high\`/\`critical\`/\`P0\` is reserved for broken core flows, security holes, or data loss.
   - **Status** — \`in progress\` if it exists.
3. Apply each chosen label with:
   \`gh issue edit <n> [--repo ...] --add-label "<name>" 2>/dev/null || true\`
   Do NOT create new labels. If a label you wanted is missing from the set, silently skip it.

### Step 4: Describe the issue (always — both URL and number paths)

Read every signal attached to the issue:
- Title, body, and every comment.
- Image attachments — extract URLs from \`![](url)\` and \`<img src="url">\` blocks. Use the URL VERBATIM (do not append a stray \`.\`, \`,\`, \`)\`, or any trailing punctuation that markdown rendering may have left behind). Fetch each image ONCE with \`WebFetch\`. If it 404s or times out, write "attachment unavailable" and move on — never retry the same URL.
- PDFs / file attachments linked in the body — same one-shot fetch rule.

If the issue body is *only* an image and that image is unreachable, reply: "Cannot describe the issue — the only attachment is unreachable. Please paste the error text or describe the screenshot." Then STOP. Do NOT speculate about the bug.

Otherwise, write a 2–4 sentence **Description** that captures: what the user is reporting, key error messages or screenshot contents, and any reproduction steps the issue mentions.

${finalSection}`
}

export function buildPrPrompt(args: string): string {
  const { display, parsedHint } = parseIssueOrPrTarget(args)
  return `# /github pr — review

User target: \`${display}\`

${parsedHint}

${SAFETY_RULES}

## Your task

1. Read the PR metadata: \`gh pr view <number> [--repo <owner/repo>] --json number,title,author,state,isDraft,baseRefName,headRefName,additions,deletions,changedFiles,labels,reviews,reviewRequests,statusCheckRollup,body\`.
2. Read the diff: \`gh pr diff <number> [--repo <owner/repo>]\`.
3. Read existing review comments and conversation: \`gh pr view <number> --comments\` and, if relevant, \`gh api repos/<owner>/<repo>/pulls/<number>/comments\`.
4. Audit:
   - **Tests:** were tests added or updated? Are they meaningful, or token boxes?
   - **Docs:** did public-facing behavior change without a doc / README / CHANGELOG update?
   - **Risk:** any new dependencies, schema migrations, security-sensitive code (auth, crypto, file IO, shell exec, eval), or breaking API changes?
   - **CI:** any failed required checks (\`statusCheckRollup\`)?
5. Reply with the **Good / Bad / Ugly** report:
   - **Good** — what is solid and ready to ship.
   - **Bad** — meaningful problems the author should fix before merge (missing tests, missing docs, regressions, unsafe patterns).
   - **Ugly** — nits, style, naming, dead code — clearly marked as optional.
   Cite \`file:line\` for every Bad / Ugly point. End with a one-line verdict: "approve / request-changes / comment".

DO NOT post the review to GitHub, do NOT \`gh pr review\`, do NOT comment on the PR. The user reads your report and decides.`
}

function parseFlag(raw: string, name: string): { value: string; rest: string } {
  const long = new RegExp(`(?:^|\\s)--${name}(?:=(\\S+)|\\s+(\\S+))`)
  const m = raw.match(long)
  if (!m) return { value: '', rest: raw }
  const value = m[1] ?? m[2] ?? ''
  const rest = (raw.slice(0, m.index) + raw.slice((m.index ?? 0) + m[0].length))
    .replace(/\s+/g, ' ')
    .trim()
  return { value, rest }
}

export function buildWrapPrompt(args: string): string {
  const branchFlag = parseFlag(args, 'branch')
  const issueFlag = parseFlag(branchFlag.rest, 'issue')
  const instructions = issueFlag.rest.trim()

  const branchSection = branchFlag.value
    ? `The user pre-selected branch \`${branchFlag.value}\`. Verify it exists locally (\`git branch --list ${branchFlag.value}\`); if not, look for it on the remote (\`git branch -r --list origin/${branchFlag.value}\`) and check it out tracking the remote. If neither exists, ask the user before creating a brand-new branch.`
    : `The user did NOT pre-select a branch. Do this:
1. Run \`git branch --show-current\` and \`git branch --sort=-committerdate --format='%(refname:short)\\t%(committerdate:relative)\\t%(subject)' | head -15\`.
2. Show the user a numbered list of recent branches and the current branch (marked \`(current)\`).
3. Ask: "Which branch should I commit to? Reply with the number, the branch name, or 'new' for a fresh branch." STOP and wait for the answer.
4. Once they reply, check it out (\`git checkout <name>\`). For 'new', ask for a name suggestion based on the diff first.`

  const issueSection = issueFlag.value
    ? `The user wants to close issue #${issueFlag.value}. Add the trailer \`Closes #${issueFlag.value}\` on its own line at the bottom of the commit message (after a blank line). Do NOT also call \`gh issue close\` — the trailer + push closes the issue automatically once merged.`
    : `No issue number was provided. Scan the diff and the user's instructions for an obvious \`#NNN\` reference; if you find one, ASK the user "Should I link this commit to #NNN?" before adding any \`Closes\` trailer.`

  const instructionsSection = instructions
    ? `User instructions for this wrap: ${instructions}`
    : `No extra instructions — derive the commit message from the diff and recent commits.`

  return `# /github wrap — stage → commit → changelog → push

${SAFETY_RULES}

> By invoking \`/github wrap\`, the user has authorized stage, commit, changelog, AND push for this turn. Do NOT re-ask permission for any of them — stop only if the push fails or you find secrets in the diff. The branch was already chosen in the wizard (see **Branch** below); use it.

## Writing style — applies to every line of text you write

Every line must be **concentrated** (dense, no padding, every word earns its place) and **high quality** (specific, accurate, useful). Covers commit subjects, body bullets, changelog entries, and the final report.
- Be specific about WHAT changed and WHY. Banned filler: "improved X", "refactored Y", "various updates", "minor changes", "this commit ...".
- Imperative voice for commit subjects ("Fix race in stream parser", not "Fixed" / "Fixing").
- Subject ≤60 chars. Add a body bullet ONLY if it tells a reader something the subject does not.
- Cut wordy phrases: "in order to" → "to", "make use of" → "use", "due to the fact that" → "because".
- No emojis, no celebration, no PR-style preamble, no "Generated with Claude" trailers.
- Plain English. A teammate reading the diff in six months should understand instantly.

## Branch

${branchSection}

## Issue link

${issueSection}

## Instructions

${instructionsSection}

## Your task

Run in this exact order. The four numbered phases (Stage+Commit → Changelog → Push) are the whole job. One push at the end carries both commits.

### Step 1: Survey

\`git status\`, \`git diff HEAD\`, \`git log --oneline -10\`. Understand what is staged and the repo's commit-message style so the new commit blends in.

If the working tree is clean and nothing is staged, tell the user "nothing to commit" and STOP.

### Step 2: Branch

Handle the branch section above. Never commit to \`main\` / \`master\` without explicit user confirmation in this turn.

### Step 3: Stage + commit the change (concentrated + high quality)

1. Stage only files relevant to this change. If anything looks like a secret (\`.env\`, \`*.pem\`, \`credentials.json\`, key-shaped strings), STOP and warn the user — do not stage.
2. Compose the message per **Writing style** above. Match repo style from Step 1's \`git log\`.
3. Commit with HEREDOC so multi-line bodies stay clean:
\`\`\`
git commit -m "$(cat <<'EOF'
<subject>

- <why bullet 1>
- <why bullet 2>

Closes #N
EOF
)"
\`\`\`

### Step 4: Update changelog (concentrated + high quality, only if CHANGELOG.md exists)

1. If \`CHANGELOG.md\` does not exist at the repo root, SKIP this step — never create one.
2. Read it. Find or create the \`## [Unreleased]\` section at the top.
3. Append ONE concentrated bullet in user-facing terms (what the user gains, what bug is gone). If the change is purely internal with no user impact, SKIP and mark \`Changelog: skipped (no user-facing change)\` in the report — do not pad the file.
4. Match the file's existing entry style (Keep-a-Changelog past tense, plain bullets, whatever it uses).
5. Stage \`CHANGELOG.md\` and commit it as a SECOND commit with a concentrated repo-style message (e.g. \`Add changelog entry for <subject>\`). Do NOT amend the Step 3 commit.

### Step 5: Push to origin (most important — sends both commits at once)

1. \`git push -u origin <branch>\` — where \`<branch>\` is the branch from Step 2 (the one the user picked in the wizard).
2. If the push is rejected (non-fast-forward), STOP — do NOT force-push. Tell the user the remote moved and suggest \`git pull --rebase origin <branch>\` first.

### Step 6: Report

Reply with EXACTLY these lines, no other prose, no congratulations:

\`\`\`
Branch:    <name>
Commit:    <short SHA> <subject>
Changelog: updated (<short SHA>) | not present | skipped (no user-facing change)
Push:      ok
Issue:     #N | none
Next:      gh pr create --base <main> --head <branch> --title "<subject>"
\`\`\`

If any step failed, replace that line's value with \`failed: <one-line reason>\` and stop. Do not attempt recovery without asking.`
}

export function buildChangelogPrompt(args: string): string {
  const trimmed = args.trim()
  return `# /github changelog — audit & draft

${SAFETY_RULES}

## Your task

1. **Find the boundary**:
   - Latest tag: \`git describe --tags --abbrev=0\` (if no tags exist, fall back to the first commit on this branch).
   - HEAD: \`git rev-parse HEAD\`.
2. **Collect commits**: \`git log <last-tag>..HEAD --pretty=format:"%H|%s|%an"\`. Skip merge commits (\`--no-merges\`).
3. **Read \`CHANGELOG.md\`** if it exists. Note the format (Keep-a-Changelog, conventional, plain bullets) so your draft matches.
4. **Categorize** every commit into:
   - **Added** — new features
   - **Changed** — enhancements to existing features
   - **Fixed** — bug fixes
   - **Removed** — removals
   - **Security** — security-relevant fixes
   - **Docs / Chore / Internal** — group at the bottom (or omit if the project's style does)
   Use commit messages, but if a subject is uninformative, run \`git show --stat <sha>\` and infer from the diff.
5. **Detect missing entries**: for each commit, check whether the existing \`CHANGELOG.md\` already mentions it. List any that were merged but never recorded.
6. **Draft the new section** for the next release. Use the project's existing format. Mark the version as \`[Unreleased]\` unless the user told you a target version${trimmed ? ` (they passed: \`${trimmed}\`)` : ''}.
7. **Reply** with:
   - The proposed new section (markdown, ready to paste).
   - A bullet list of "missed" commits that were merged but never made it into the changelog.
   - The question: "Write this to CHANGELOG.md now?" — STOP.

DO NOT edit \`CHANGELOG.md\` until the user says yes.`
}

export function buildTriagePrompt(args: string): string {
  const trimmed = args.trim()
  const scope = trimmed
    ? `User scope override: ${trimmed}`
    : `Default scope: open issues with no assignee OR no priority/type label.`
  return `# /github triage — dispatch open issues

${SAFETY_RULES}

${scope}

## Your task

1. **Resolve repo**: \`gh repo view --json nameWithOwner -q .nameWithOwner\`.
2. **Pull issues**: \`gh issue list --state open --limit 100 --json number,title,body,labels,assignees,createdAt,author\`. If a scope was given above, filter accordingly (e.g. \`--label\`, \`--search\`).
3. **Pull existing labels**: \`gh label list --limit 100 --json name,description,color\` — only apply labels that already exist. If a needed label is missing, ASK the user before creating it.
4. **For each issue**, classify:
   - **Type** — bug, enhancement, documentation, question, chore.
   - **Priority** — high (broken core flow / security / data loss), medium (degraded UX, blocking few users), low (cosmetic, nice-to-have). Be conservative on "high".
   - **Duplicate** — search older issues by title keywords (\`gh issue list --search "<keywords>" --state all\`). If you find a high-confidence duplicate, note it.
   - **Suggested assignee** — for code-related issues, run \`git log --pretty=format:"%an" -- <relevant-file> | head -10 | sort | uniq -c | sort -rn\` to find the most recent contributor on the affected area. Suggest only — do NOT assign.
5. **Build a triage table** in markdown:
   | # | Title | Type | Priority | Action | Notes |
   Action is one of: \`label\`, \`close as duplicate of #N\`, \`needs info\`, \`assign to @user\` (suggestion only).
6. **Show the table to the user and STOP.** Then ask: "Apply these labels and close the duplicates? (yes / partial — give me numbers)".
7. **On user approval**, batch-apply with \`gh issue edit <n> --add-label "<label>"\` and \`gh issue close <n> --comment "Duplicate of #M"\` for the approved subset only. Print a one-line summary per change.

NEVER auto-close, auto-assign, or auto-label without the user's explicit yes.`
}

export function buildReleasePrompt(args: string): string {
  const version = args.trim().split(/\s+/)[0]
  const versionSection = version
    ? `Target version: \`${version}\`. Validate it matches the project's tag pattern (\`vMAJOR.MINOR.PATCH\` is the most common — check existing tags with \`git tag --sort=-v:refname | head -5\`). If the format clashes, ASK the user before tagging.`
    : `No version was supplied. Read the latest tag (\`git tag --sort=-v:refname | head -1\`), propose the next version (patch bump by default; minor if there are new features in the diff; major if there are breaking changes), and ASK the user to confirm before continuing.`

  return `# /github release — launch

${SAFETY_RULES}

${versionSection}

## Your task

Walk these steps in order. STOP at every checkpoint that says "ASK".

1. **Pre-flight**:
   - \`git status\` — must be clean. If dirty, STOP and tell the user.
   - \`git branch --show-current\` — must be the project's main branch (\`main\` or \`master\`). If not, ASK before continuing.
   - \`git fetch --tags\` then \`git pull --ff-only\` to make sure local matches remote. If the pull is not fast-forward, STOP.
   - \`gh pr checks <main-branch>\` if the project gates releases on green CI — STOP if any required check is failing.
2. **Build changelog notes**: same logic as \`/github changelog\` — diff against last tag, categorize, format. Hold the notes in memory; do NOT write them yet.
3. **ASK** the user to confirm: version number, list of changes, target branch. Show the proposed notes inline. STOP and wait.
4. **On approval**, in this exact order:
   - Update \`CHANGELOG.md\`: move \`[Unreleased]\` content under the new version + today's date, leave a fresh empty \`[Unreleased]\` on top. Commit: \`chore(release): <version>\`.
   - Tag: \`git tag -a <version> -m "<version>"\`.
   - Push: \`git push origin <main-branch>\` then \`git push origin <version>\`.
   - GitHub release: \`gh release create <version> --title "<version>" --notes-file <(printf '%s' "$NOTES")\` (or \`--notes\` with a heredoc). Mark it as latest unless the user said otherwise.
5. **Deploy hook**: list available workflows with \`gh workflow list\`. If a release/deploy workflow exists, ASK the user "Run \`<workflow>\` against tag <version>?" before \`gh workflow run\`. Do not assume.
6. **Report**: print the release URL (\`gh release view <version> --json url -q .url\`), the tag SHA, and the workflow run URL if you triggered one.

If anything in steps 4–5 fails after the tag has been pushed, STOP and surface the exact error — do NOT try to clean up by deleting the tag without asking.`
}

export const SUBCOMMANDS: Record<string, (args: string) => string> = {
  issue: buildIssuePrompt,
  pr: buildPrPrompt,
  wrap: buildWrapPrompt,
  changelog: buildChangelogPrompt,
  triage: buildTriagePrompt,
  release: buildReleasePrompt,
}

export type Subcommand = keyof typeof SUBCOMMANDS
