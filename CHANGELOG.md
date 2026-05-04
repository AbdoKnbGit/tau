# Changelog

## [Unreleased]

## [v0.6.5] - 2026-05-04

### Voice
- Added `/hey` to start a voice conversation and `/bye` to end it cleanly.
- Added the hold-to-talk voice flow for recording, transcribing, and sending spoken prompts.
- Added optional spoken replies, local voice support, and Gemini voice conversation setup.

### Providers and models
- Improved provider setup and switching so login, provider choice, and model selection are easier to follow.
- Refreshed OpenAI and provider model handling for the next release.

### Fixes and polish
- Fixed provider file handling and tightened the voice startup checks.
- Improved Codex session stability around prompt caching.
- Refreshed README visuals and release documentation.

## [v0.6.3] - 2026-05-03

### /github issue
- Inspect issues for the current repo, or inspect a specific issue by URL.

### /github pr
- Inspect pull requests and drive gh-backed review actions from a guided prompt.

### /github wrap
- Wrap local work into stage → commit → changelog → push with explicit authorization rules.

### /github changelog
- Generate concentrated changelog bullets from commit history.

### /github triage
- Classify issues (labels/status) with a strict permission gate before any visible action.

### /github release
- Release workflow: inspect dirty working tree before publishing, check CI/CD workflow status, then tag/publish and list runs.
- Fix: version input no longer auto-submits on every keystroke; partial semver stops and requests a full tag.

## 0.6.2

### Added
- Session report command (`/report`) for generating detailed session summaries.
- Session statistics command (`/stats`) to track usage and performance.
- Navigation commands: `/tree`, `/clone`, and `/import` for enhanced session management.
- Improved branch naming: auto-named branches now use a `last-prompt` seed and `HH:MM` timestamp for better uniqueness.

### Fixed
- Resolved "garbage" names for branches, clones, and imports when launched via slash commands.
- Fixed Tau CI workflow and Kilo cache build issues.

### Changed
- Refined README with centered logo and updated branding assets.

## 0.6.0 - Claudex to Tau migration

- Renamed the product surface from Claudex to Tau across the CLI, docs, terminal UI, and VS Code companion.
- Added the `tau` command and changed install/update flows to use `@abdoknbgit/tau`.
- Kept legacy `claudex` command/config compatibility where needed so existing users are not stranded.
- Reworked the startup logo/theme around the Tau math-symbol identity with the darker red, brown, and black terminal style.
- Renamed the VS Code companion workspace to `tau-vscode` and updated launch defaults to run `tau`.
- Updated provider notes and documented scalable context handling plus fallback recovery.
