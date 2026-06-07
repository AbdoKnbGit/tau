# Optional Native Tau Helpers

Tau bundles `dist/native/tau-tools[.exe]` as optional helper plumbing. The
bundle is resolved relative to Tau's installed package, so it is portable across
machines and not hardcoded to one local path.

Generated Markdown, Markdown tables, and code blocks are UI rendering concerns,
not agent tools. Tau's normal Markdown and code-block renderers call the native
helper underneath when available:

- `render-markdown` uses Charm Glamour with Tau's compact style for Markdown
  and table rendering.
- `highlight-code` uses Chroma for broad language syntax highlighting.

If the helper is unavailable, Tau falls back to the existing TypeScript renderer
instead of breaking the session.

The helper is built by `npm run build` and `npm run build:native-tools`.
During npm install, `postinstall` also tries to build it when Go is available.
Current helper dependencies require Go 1.25.8 or newer when building from
source.

Published packages include the prebuilt helper under `dist/native`. Source
installs can rebuild it with Go, or skip it without breaking Tau.

Bubble Tea `pick` remains manual because it is interactive, not a safe automatic
agent call.

## Commands

```bash
dist/native/tau-tools highlight-code --in src/main.tsx --lang tsx
dist/native/tau-tools git-summary --repo . --pretty
dist/native/tau-tools sysinfo --pretty
dist/native/tau-tools fuzzy-rank --query model --in models.txt
dist/native/tau-tools pick --title "Model" --in models.txt
dist/native/tau-tools render-markdown --in README.md --style tau-compact-dark
```

## Included

- Bubble Tea, Bubbles, Lip Gloss: standalone manual picker only.
- go-git: exposed as the read-only `NativeGitSummary` agent tool.
- gopsutil: exposed as the read-only `NativeSysInfo` agent tool.
- Fuzzy matching: helper command only.
- Chroma code highlighting and Charm Glamour Markdown rendering: helper
  commands used implicitly by Tau rendering.

`NativeRenderMarkdown` and `NativeHighlightCode` are deliberately not exposed as
agent tools. Normal generated code and requests like "make a summary Markdown
table" stay as regular Tau UI-rendered answers.

## Deliberately Avoided

- Gum: useful for scripts, but not a Tau runtime dependency.
- fzf: useful when already installed, but not required by Tau.
- Cobra and Viper: useful for large Go CLIs, but unnecessary for this helper.

To make a missing Go toolchain fail CI instead of skipping the helper, set:

```bash
TAU_REQUIRE_NATIVE_TOOLS=1 npm run build:native-tools
```
