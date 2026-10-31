// Every scenario is plain data, so adding one is a few lines. `steps` is what the fake model does, one
// array per reply, and `expect` is what must be true afterwards. A scenario with `runs` runs the CLI several
// times in the same folder. See README.md for every field.
const read = file => ({ tool: 'Read', input: { file_path: `{workspace}/${file}` } })
const write = (file, content = 'hello') => ({ tool: 'Write', input: { file_path: `{workspace}/${file}`, content } })
const edit = (file, from, to) => ({ tool: 'Edit', input: { file_path: `{workspace}/${file}`, old_string: from, new_string: to } })
const bash = command => ({ tool: 'Bash', input: { command, description: 'lab command' } })
const echoTool = { tool: 'mcp__echo__echo', input: { text: 'hi' } }
const oneByOne = (...calls) => calls.map(call => [call])

const DONE = { printed: /LAB-DONE/ }
const SDK_IDENTITY = "You are a Claude agent, built on Anthropic's Claude Agent SDK."
const TAU_IDENTITY = 'You are Tau, a multi-provider AI coding CLI.'
const SESSION = '11111111-2222-4333-8444-555555555555'
const RUN_SCRIPT = 'node make-file.mjs'
const SCRIPT_RESULT = 'made-by-script.txt'
const PROMPT_HOOK = "process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'LAB-HOOK-CONTEXT' } }))"
const STOP_HOOK = "process.stdout.write(JSON.stringify({ continue: false, stopReason: 'LAB-STOP-HOOK' }))"
const WINDOWS_TERMINAL = { SESSIONNAME: 'Console', WT_SESSION: '11111111-1111-4111-8111-111111111111' }
const RESUME_RUNS = [
  { persist: true, args: ['--session-id', SESSION], steps: oneByOne(read('notes.txt')) },
  { persist: true, args: ['--resume', SESSION], prompt: 'LAB-PROMPT second question' },
]

export const scenarios = [
  // ── Which tools the model is offered ──
  { id: 'tools-default', group: 'tools', title: 'No flag offers every built-in tool', expect: { ...DONE, offered: 'all' } },
  { id: 'tools-default-word', group: 'tools', title: '--tools default offers the same list', args: ['--tools', 'default'], expect: { ...DONE, offered: 'all' } },
  { id: 'tools-none', group: 'tools', title: '--tools "" offers no tools', args: ['--tools', ''], expect: { ...DONE, offered: [] } },
  { id: 'tools-none-equals', group: 'tools', title: '--tools= also offers no tools, and needs no quotes in any shell', args: ['--tools='], expect: { ...DONE, offered: [] } },
  { id: 'tools-comma', group: 'tools', title: '--tools Read,Grep offers those two', args: ['--tools', 'Read,Grep'], expect: { ...DONE, offered: ['Grep', 'Read'] } },
  { id: 'tools-spaces', group: 'tools', title: '--tools Read Grep offers those two', args: ['--tools', 'Read', 'Grep'], expect: { ...DONE, offered: ['Grep', 'Read'] } },
  { id: 'tools-wrong-case', group: 'tools', title: '--tools read gives zero tools and no error', note: 'Names are case-sensitive and a wrong name is not reported. The model simply has no tools.', args: ['--tools', 'read'], expect: { ...DONE, offered: [] } },
  { id: 'tools-wire-name', group: 'tools', title: '--tools read_file gives zero tools and no error', note: 'Use Tau names on every provider, including Antigravity, even though it calls this tool read_file on the wire.', args: ['--tools', 'read_file'], expect: { ...DONE, offered: [] } },
  { id: 'tools-unknown', group: 'tools', title: '--tools Nope gives zero tools and no error', args: ['--tools', 'Nope'], expect: { ...DONE, offered: [] } },
  { id: 'tools-one-unknown', group: 'tools', title: '--tools Read,Nope keeps Read and ignores Nope', args: ['--tools', 'Read,Nope'], expect: { ...DONE, offered: ['Read'] } },
  { id: 'tools-old-name', group: 'tools', title: '--tools Task still means Agent', args: ['--tools', 'Task'], expect: { ...DONE, offered: ['Agent'] } },
  { id: 'tools-disallow-one', group: 'tools', title: '--disallowedTools Write removes that one tool', args: ['--disallowedTools', 'Write'], expect: { ...DONE, offered: { minus: ['Write'] } } },
  { id: 'tools-disallow-many', group: 'tools', title: '--disallowedTools Write,Edit,Bash removes all three', args: ['--disallowedTools', 'Write,Edit,Bash'], expect: { ...DONE, offered: { minus: ['Write', 'Edit', 'Bash'] } } },
  { id: 'tools-allow-keeps-list', group: 'tools', title: '--allowedTools does not shrink the list', args: ['--allowedTools', 'Read'], expect: { ...DONE, offered: 'all' } },
  { id: 'tools-allow-cannot-add', group: 'tools', title: '--tools Read --allowedTools Bash offers only Read', args: ['--tools', 'Read', '--allowedTools', 'Bash'], expect: { ...DONE, offered: ['Read'] } },
  { id: 'tools-hidden-call', group: 'tools', title: 'A tool hidden by --tools cannot run if called anyway', args: ['--tools', 'Read'], steps: oneByOne(write('made.txt')), expect: { ...DONE, missing: ['made.txt'], offered: ['Read'] } },
  { id: 'tools-removed-call', group: 'tools', title: 'A tool removed by --disallowedTools cannot run if called anyway', args: ['--disallowedTools', 'Write'], steps: oneByOne(write('made.txt')), expect: { ...DONE, missing: ['made.txt'] } },

  // ── What runs without asking ──
  { id: 'allow-read-default', group: 'allowlist', title: 'Read runs with no flags', steps: oneByOne(read('notes.txt')), expect: { ...DONE, saw: /Pineapple/, denied: [] } },
  { id: 'allow-grep-default', group: 'allowlist', title: 'Grep runs with no flags', steps: oneByOne({ tool: 'Grep', input: { pattern: 'Pineapple', output_mode: 'content' } }), expect: { ...DONE, saw: /Pineapple/, denied: [] } },
  { id: 'allow-glob-default', group: 'allowlist', title: 'Glob runs with no flags', steps: oneByOne({ tool: 'Glob', input: { pattern: '*.txt' } }), expect: { ...DONE, saw: /notes\.txt/, denied: [] } },
  { id: 'allow-echo-default', group: 'allowlist', title: 'A read-only shell command runs with no flags', steps: oneByOne(bash('echo lab-echo-output')), expect: { ...DONE, saw: /lab-echo-output/, denied: [] } },
  { id: 'allow-write-refused', group: 'allowlist', title: 'Write is refused with no flags, and the run carries on', steps: oneByOne(write('made.txt')), expect: { ...DONE, missing: ['made.txt'], denied: ['Write'], saw: /haven't granted/ } },
  { id: 'allow-edit-refused', group: 'allowlist', title: 'Edit is refused with no flags', steps: oneByOne(read('src/app.js'), edit('src/app.js', 'old text', 'new text')), expect: { ...DONE, contains: { 'src/app.js': /old text/ }, denied: ['Edit'] } },
  { id: 'allow-script-refused', group: 'allowlist', title: 'A command that changes things is refused with no flags', steps: oneByOne(bash(RUN_SCRIPT)), expect: { ...DONE, missing: [SCRIPT_RESULT], denied: ['Bash'] } },
  { id: 'allow-write', group: 'allowlist', title: '--allowedTools Write allows Write', args: ['--allowedTools', 'Write'], steps: oneByOne(write('made.txt')), expect: { ...DONE, contains: { 'made.txt': /hello/ }, denied: [] } },
  { id: 'allow-edit', group: 'allowlist', title: '--allowedTools Edit allows Edit', args: ['--allowedTools', 'Edit'], steps: oneByOne(read('src/app.js'), edit('src/app.js', 'old text', 'new text')), expect: { ...DONE, contains: { 'src/app.js': /new text/ }, denied: [] } },
  { id: 'allow-edit-covers-write', group: 'allowlist', title: '--allowedTools Edit does not allow the Write tool on a new file', args: ['--allowedTools', 'Edit'], steps: oneByOne(write('made.txt')), expect: { ...DONE, missing: ['made.txt'], denied: ['Write'] } },
  { id: 'allow-write-covers-edit', group: 'allowlist', title: '--allowedTools Write does not allow the Edit tool', args: ['--allowedTools', 'Write'], steps: oneByOne(read('src/app.js'), edit('src/app.js', 'old text', 'new text')), expect: { ...DONE, contains: { 'src/app.js': /old text/ }, denied: ['Edit'] } },
  { id: 'allow-comma', group: 'allowlist', title: '--allowedTools Read,Write takes a comma list', args: ['--allowedTools', 'Read,Write'], steps: oneByOne(write('made.txt')), expect: { ...DONE, exists: ['made.txt'], denied: [] } },
  { id: 'allow-spaces', group: 'allowlist', title: '--allowedTools Read Write takes a space list', args: ['--allowedTools', 'Read', 'Write'], steps: oneByOne(write('made.txt')), expect: { ...DONE, exists: ['made.txt'], denied: [] } },
  { id: 'allow-dashed-name', group: 'allowlist', title: '--allowed-tools is the same flag', args: ['--allowed-tools', 'Write'], steps: oneByOne(write('made.txt')), expect: { ...DONE, exists: ['made.txt'], denied: [] } },
  { id: 'allow-other-tool', group: 'allowlist', title: 'Allowing Read does not allow Write', args: ['--allowedTools', 'Read'], steps: oneByOne(write('made.txt')), expect: { ...DONE, missing: ['made.txt'], denied: ['Write'] } },
  { id: 'allow-bash-all', group: 'allowlist', title: '--allowedTools Bash allows every command', args: ['--allowedTools', 'Bash'], steps: oneByOne(bash(RUN_SCRIPT)), expect: { ...DONE, exists: [SCRIPT_RESULT], denied: [] } },
  { id: 'allow-bash-rule', group: 'allowlist', title: '"Bash(node:*)" allows node commands', args: ['--allowedTools', 'Bash(node:*)'], steps: oneByOne(bash(RUN_SCRIPT)), expect: { ...DONE, exists: [SCRIPT_RESULT], denied: [] } },
  { id: 'allow-bash-exact', group: 'allowlist', title: '"Bash(node make-file.mjs)" allows that exact command', args: ['--allowedTools', `Bash(${RUN_SCRIPT})`], steps: oneByOne(bash(RUN_SCRIPT)), expect: { ...DONE, exists: [SCRIPT_RESULT], denied: [] } },
  { id: 'allow-bash-prefix', group: 'allowlist', title: '"Bash(node make-file.mjs:*)" allows that command with any arguments', args: ['--allowedTools', `Bash(${RUN_SCRIPT}:*)`], steps: oneByOne(bash(`${RUN_SCRIPT} extra`)), expect: { ...DONE, exists: [SCRIPT_RESULT], denied: [] } },
  { id: 'allow-bash-prefix-other', group: 'allowlist', title: 'A two-word rule does not allow the same program with other words', args: ['--allowedTools', 'Bash(node other.mjs:*)'], steps: oneByOne(bash(RUN_SCRIPT)), expect: { ...DONE, missing: [SCRIPT_RESULT], denied: ['Bash'] } },
  { id: 'allow-bash-exact-other', group: 'allowlist', title: 'An exact rule does not allow a different command', args: ['--allowedTools', 'Bash(node --version)'], steps: oneByOne(bash(RUN_SCRIPT)), expect: { ...DONE, missing: [SCRIPT_RESULT], denied: ['Bash'] } },
  { id: 'allow-bash-other-rule', group: 'allowlist', title: '"Bash(git:*)" does not allow node', args: ['--allowedTools', 'Bash(git:*)'], steps: oneByOne(bash(RUN_SCRIPT)), expect: { ...DONE, missing: [SCRIPT_RESULT], denied: ['Bash'] } },
  { id: 'allow-bash-chain', group: 'allowlist', title: 'A rule for echo does not allow a chained second command', args: ['--allowedTools', 'Bash(echo:*)'], steps: oneByOne(bash(`echo hi && ${RUN_SCRIPT}`)), expect: { ...DONE, missing: [SCRIPT_RESULT], denied: ['Bash'] } },
  { id: 'allow-mkdir-rule', group: 'allowlist', title: '"Bash(mkdir:*)" does not allow mkdir, plain Bash does', note: 'mkdir is checked by path before command rules. The message says the folder is outside the working directories even when it is inside. Use --allowedTools Bash or --permission-mode acceptEdits.', runs: [
    { args: ['--allowedTools', 'Bash(mkdir:*)'], steps: oneByOne(bash('mkdir made-one')), expect: { ...DONE, missing: ['made-one'], denied: ['Bash'] } },
    { args: ['--allowedTools', 'Bash'], steps: oneByOne(bash('mkdir made-two')), expect: { ...DONE, exists: ['made-two'], denied: [] } },
  ] },
  { id: 'allow-deny-wins', group: 'allowlist', title: 'Disallowing wins over allowing the same tool', args: ['--allowedTools', 'Write', '--disallowedTools', 'Write'], steps: oneByOne(write('made.txt')), expect: { ...DONE, missing: ['made.txt'], offered: { minus: ['Write'] } } },
  { id: 'allow-deny-one-command', group: 'allowlist', title: 'Allow Bash but deny one command with a rule', args: ['--allowedTools', 'Bash', '--disallowedTools', 'Bash(node:*)'], steps: oneByOne(bash(RUN_SCRIPT), bash('echo still-works')), expect: { ...DONE, missing: [SCRIPT_RESULT], saw: /still-works/ } },
  { id: 'allow-mixed-reply', group: 'allowlist', title: 'One reply with an allowed and a refused tool: only the allowed one runs', steps: [[read('notes.txt'), write('made.txt')]], expect: { ...DONE, saw: /Pineapple/, missing: ['made.txt'], denied: ['Write'] } },
  { id: 'allow-after-refusal', group: 'allowlist', title: 'The model can keep working after a refusal', steps: oneByOne(write('made.txt'), read('notes.txt')), expect: { ...DONE, saw: /Pineapple/, missing: ['made.txt'], denied: ['Write'] } },
  { id: 'allow-ask-refused', group: 'allowlist', title: 'AskUserQuestion is refused: -p has nobody to ask', steps: oneByOne({ tool: 'AskUserQuestion', input: { questions: [{ question: 'Which one?', header: 'Pick', multiSelect: false, options: [{ label: 'A', description: 'first' }, { label: 'B', description: 'second' }] }] } }), expect: { ...DONE, denied: ['AskUserQuestion'] } },
  { id: 'allow-websearch-refused', group: 'allowlist', title: 'WebSearch is refused with no flags', steps: oneByOne({ tool: 'WebSearch', input: { query: 'lab test' } }), expect: { ...DONE, denied: ['WebSearch'] } },
  { id: 'allow-webfetch-refused', group: 'allowlist', title: 'WebFetch is refused with no flags', steps: oneByOne({ tool: 'WebFetch', input: { url: 'https://example.com/', prompt: 'summarise https://example.com/' } }), expect: { ...DONE, denied: ['WebFetch'] } },
  { id: 'allow-settings-allow', group: 'allowlist', title: 'An allow rule in project settings works in -p', setup: { files: { '.claude/settings.json': { permissions: { allow: ['Write'] } } } }, steps: oneByOne(write('made.txt')), expect: { ...DONE, exists: ['made.txt'], denied: [] } },
  { id: 'allow-settings-deny', group: 'allowlist', title: 'A deny rule in project settings hides the tool in -p', setup: { files: { '.claude/settings.json': { permissions: { deny: ['Write'] } } } }, steps: oneByOne(write('made.txt')), expect: { ...DONE, missing: ['made.txt'], offered: { minus: ['Write'] } } },
  { id: 'allow-settings-both', group: 'allowlist', title: 'Project settings can allow a tool and protect a folder together', setup: { files: { '.claude/settings.json': { permissions: { allow: ['Write'], deny: ['Read(secret/**)'] } } } }, steps: oneByOne(write('made.txt'), read('secret/hidden.txt')), expect: { ...DONE, exists: ['made.txt'], notSaw: /Papaya/ } },
  { id: 'allow-settings-deny-wins', group: 'allowlist', title: 'A flag cannot override a deny rule in settings', setup: { files: { '.claude/settings.json': { permissions: { deny: ['Write'] } } } }, args: ['--allowedTools', 'Write'], steps: oneByOne(write('made.txt')), expect: { ...DONE, missing: ['made.txt'] } },

  // ── Files and folders ──
  { id: 'path-read-inside', group: 'paths', title: 'Reading inside the working folder is allowed', steps: oneByOne(read('secret/hidden.txt')), expect: { ...DONE, saw: /Papaya/, denied: [] } },
  { id: 'path-read-outside', group: 'paths', title: 'Reading outside the working folder is refused', steps: oneByOne({ tool: 'Read', input: { file_path: '{outside}/far.txt' } }), expect: { ...DONE, notSaw: /Coconut/, denied: ['Read'] } },
  { id: 'path-read-add-dir', group: 'paths', title: '--add-dir allows reading that folder', args: ['--add-dir', '{outside}'], steps: oneByOne({ tool: 'Read', input: { file_path: '{outside}/far.txt' } }), expect: { ...DONE, saw: /Coconut/, denied: [] } },
  { id: 'path-write-outside', group: 'paths', title: 'WATCH: --allowedTools Write also allows writing OUTSIDE the working folder', note: 'A bare allow rule has no location limit. To keep writes inside the project use --permission-mode acceptEdits or a rule like "Edit(src/**)".', args: ['--allowedTools', 'Write'], steps: oneByOne({ tool: 'Write', input: { file_path: '{outside}/made.txt', content: 'x' } }), expect: { ...DONE, exists: ['../outside/made.txt'], denied: [] } },
  { id: 'path-edit-rule-write-tool', group: 'paths', title: '--allowedTools Edit does not let the Write tool write outside', args: ['--allowedTools', 'Edit'], steps: oneByOne({ tool: 'Write', input: { file_path: '{outside}/made-by-edit-rule.txt', content: 'x' } }), expect: { ...DONE, missing: ['../outside/made-by-edit-rule.txt'], denied: ['Write'] } },
  { id: 'path-bash-outside', group: 'paths', title: 'WATCH: --allowedTools Bash also allows writing OUTSIDE the working folder', note: 'A bare Bash rule runs any command, including ones that write elsewhere.', args: ['--allowedTools', 'Bash'], steps: oneByOne(bash('echo x > "{outsideSlash}/made-by-bash.txt"')), expect: { ...DONE, exists: ['../outside/made-by-bash.txt'], denied: [] } },
  { id: 'path-script-outside', group: 'paths', title: 'A bare Bash rule runs a script that writes anywhere', note: 'The shell tool cannot see what a script does. Rules limit which commands start, not what they touch.', args: ['--allowedTools', 'Bash'], steps: oneByOne(bash('node -e "require(\'fs\').writeFileSync(\'{outsideSlash}/made-by-node.txt\',\'x\')"')), expect: { ...DONE, exists: ['../outside/made-by-node.txt'], denied: [] } },
  { id: 'path-deny-folder', group: 'paths', title: 'Deny one folder with "Read(secret/**)", the rest stays readable', args: ['--disallowedTools', 'Read(secret/**)'], steps: oneByOne(read('secret/hidden.txt'), read('notes.txt')), expect: { ...DONE, saw: /Pineapple/, notSaw: /Papaya/ } },
  { id: 'path-edit-rule-inside', group: 'paths', title: '"Edit(allowed/**)" allows writing in that folder', args: ['--allowedTools', 'Edit(allowed/**)'], steps: oneByOne(write('allowed/in.txt')), expect: { ...DONE, exists: ['allowed/in.txt'], denied: [] } },
  { id: 'path-edit-rule-edit-tool', group: 'paths', title: '"Edit(src/**)" allows the Edit tool in that folder', args: ['--allowedTools', 'Edit(src/**)'], steps: oneByOne(read('src/app.js'), edit('src/app.js', 'old text', 'new text')), expect: { ...DONE, contains: { 'src/app.js': /new text/ }, denied: [] } },
  { id: 'path-add-dir-relative', group: 'paths', title: '--add-dir takes a relative path', args: ['--add-dir', '../outside'], steps: oneByOne({ tool: 'Read', input: { file_path: '{outside}/far.txt' } }), expect: { ...DONE, saw: /Coconut/, denied: [] } },
  { id: 'path-edit-rule-outside', group: 'paths', title: '"Edit(allowed/**)" refuses other folders', args: ['--allowedTools', 'Edit(allowed/**)'], steps: oneByOne(write('other/out.txt')), expect: { ...DONE, missing: ['other/out.txt'], denied: ['Write'] } },

  // ── Permission modes ──
  { id: 'mode-accept-write', group: 'modes', title: 'acceptEdits allows writing a file', args: ['--permission-mode', 'acceptEdits'], steps: oneByOne(write('made.txt')), expect: { ...DONE, exists: ['made.txt'], denied: [] } },
  { id: 'mode-accept-edit', group: 'modes', title: 'acceptEdits allows editing a file', args: ['--permission-mode', 'acceptEdits'], steps: oneByOne(read('src/app.js'), edit('src/app.js', 'old text', 'new text')), expect: { ...DONE, contains: { 'src/app.js': /new text/ }, denied: [] } },
  { id: 'mode-accept-mkdir', group: 'modes', title: 'acceptEdits allows mkdir in the working folder', args: ['--permission-mode', 'acceptEdits'], steps: oneByOne(bash('mkdir made-folder')), expect: { ...DONE, exists: ['made-folder'], denied: [] } },
  { id: 'mode-accept-script', group: 'modes', title: 'acceptEdits does not allow other commands', args: ['--permission-mode', 'acceptEdits'], steps: oneByOne(bash(RUN_SCRIPT)), expect: { ...DONE, missing: [SCRIPT_RESULT], denied: ['Bash'] } },
  { id: 'mode-accept-outside', group: 'modes', title: 'acceptEdits still refuses outside the working folder', args: ['--permission-mode', 'acceptEdits'], steps: oneByOne({ tool: 'Write', input: { file_path: '{outside}/made.txt', content: 'x' } }), expect: { ...DONE, missing: ['../outside/made.txt'], denied: ['Write'] } },
  { id: 'mode-plan-read', group: 'modes', title: 'plan allows reading', args: ['--permission-mode', 'plan'], steps: oneByOne(read('notes.txt')), expect: { ...DONE, saw: /Pineapple/, denied: [] } },
  { id: 'mode-plan-write', group: 'modes', title: 'plan refuses writing', args: ['--permission-mode', 'plan'], steps: oneByOne(write('made.txt')), expect: { ...DONE, missing: ['made.txt'], denied: ['Write'] } },
  { id: 'mode-dont-ask', group: 'modes', title: 'dontAsk refuses anything not already allowed', args: ['--permission-mode', 'dontAsk'], steps: oneByOne(write('made.txt')), expect: { ...DONE, missing: ['made.txt'], denied: ['Write'] } },
  { id: 'mode-dont-ask-allowed', group: 'modes', title: 'dontAsk still runs what --allowedTools allows', args: ['--permission-mode', 'dontAsk', '--allowedTools', 'Write'], steps: oneByOne(write('made.txt')), expect: { ...DONE, exists: ['made.txt'], denied: [] } },
  { id: 'mode-explore-read', group: 'modes', title: 'explore allows reading', args: ['--permission-mode', 'explore'], steps: oneByOne(read('notes.txt')), expect: { ...DONE, saw: /Pineapple/, denied: [] } },
  { id: 'mode-explore-write', group: 'modes', title: 'explore refuses writing', args: ['--permission-mode', 'explore'], steps: oneByOne(write('made.txt')), expect: { ...DONE, missing: ['made.txt'], denied: ['Write'] } },
  { id: 'mode-bypass', group: 'modes', title: '--permission-mode bypassPermissions runs everything', args: ['--permission-mode', 'bypassPermissions'], steps: oneByOne(write('made.txt'), bash(RUN_SCRIPT)), expect: { ...DONE, exists: ['made.txt', SCRIPT_RESULT], denied: [] } },
  { id: 'mode-accept-plus-rule', group: 'modes', title: 'acceptEdits and a command rule work together', args: ['--permission-mode', 'acceptEdits', '--allowedTools', 'Bash(node:*)'], steps: oneByOne(write('made.txt'), bash(RUN_SCRIPT)), expect: { ...DONE, exists: ['made.txt', SCRIPT_RESULT], denied: [] } },
  { id: 'mode-skip-all', group: 'modes', title: '--dangerously-skip-permissions runs everything', args: ['--dangerously-skip-permissions'], steps: oneByOne(write('made.txt'), bash(RUN_SCRIPT)), expect: { ...DONE, exists: ['made.txt', SCRIPT_RESULT], denied: [] } },
  { id: 'mode-skip-deny-wins', group: 'modes', title: 'Skipping permissions does not bring back a disallowed tool', args: ['--dangerously-skip-permissions', '--disallowedTools', 'Write'], steps: oneByOne(write('made.txt')), expect: { ...DONE, missing: ['made.txt'] } },
  { id: 'mode-skip-tools-limit', group: 'modes', title: 'Skipping permissions does not bring back a tool hidden by --tools', args: ['--dangerously-skip-permissions', '--tools', 'Read'], steps: oneByOne(write('made.txt')), expect: { ...DONE, missing: ['made.txt'], offered: ['Read'] } },

  // ── MCP tools ──
  { id: 'mcp-offered', group: 'mcp', title: 'An MCP tool is offered next to the built-in ones', mcp: true, expect: { ...DONE, offered: { includes: ['mcp__echo__echo', 'Read'] } } },
  { id: 'mcp-not-limited-by-tools', group: 'mcp', title: '--tools does not hide MCP tools', note: '--tools only limits built-in tools. Use --disallowedTools to remove an MCP tool.', mcp: true, args: ['--tools', 'Read'], expect: { ...DONE, offered: ['Read', 'mcp__echo__echo'] } },
  { id: 'mcp-refused', group: 'mcp', title: 'An MCP tool is refused with no flags', mcp: true, steps: oneByOne(echoTool), expect: { ...DONE, notSaw: /lab-echo-reply/, denied: ['mcp__echo__echo'] } },
  { id: 'mcp-allow-tool', group: 'mcp', title: '--allowedTools mcp__echo__echo allows that tool', mcp: true, args: ['--allowedTools', 'mcp__echo__echo'], steps: oneByOne(echoTool), expect: { ...DONE, saw: /lab-echo-reply/, denied: [] } },
  { id: 'mcp-allow-server', group: 'mcp', title: '--allowedTools mcp__echo allows the whole server', mcp: true, args: ['--allowedTools', 'mcp__echo'], steps: oneByOne(echoTool), expect: { ...DONE, saw: /lab-echo-reply/, denied: [] } },
  { id: 'mcp-disallow', group: 'mcp', title: '--disallowedTools removes an MCP tool', mcp: true, args: ['--disallowedTools', 'mcp__echo__echo'], expect: { ...DONE, offered: { excludes: ['mcp__echo__echo'], includes: ['Read'] } } },

  // ── What -p reports ──
  { id: 'output-text', group: 'output', title: 'Plain output prints only the final answer', format: 'text', expect: { printed: /^LAB-DONE/ } },
  { id: 'output-refusal-exit', group: 'output', title: 'A refusal is not an error: exit 0 and is_error false', steps: oneByOne(write('made.txt')), expect: { ...DONE, exit: 0, isError: false, subtype: 'success', denied: ['Write'] } },
  { id: 'output-refusal-text', group: 'output', title: 'In plain output a refusal shows only through the answer', format: 'text', steps: oneByOne(write('made.txt')), expect: { printed: /^LAB-DONE/, missing: ['made.txt'] } },
  { id: 'output-stream', group: 'output', title: 'stream-json ends with a result line that lists refusals', format: 'stream-json', steps: oneByOne(write('made.txt')), expect: { ...DONE, denied: ['Write'], isError: false } },
  { id: 'output-clean-json', group: 'output', title: 'JSON stays parseable in a Windows terminal session', note: 'Windows sets SESSIONNAME in every terminal. Before the fix, stdout was treated as a terminal even when piped, so escape codes followed the JSON and jq or ConvertFrom-Json failed.', setup: { env: WINDOWS_TERMINAL }, expect: { ...DONE, cleanOutput: true } },
  { id: 'output-clean-text', group: 'output', title: 'Plain output stays clean in a Windows terminal session', format: 'text', setup: { env: WINDOWS_TERMINAL }, expect: { printed: /^LAB-DONE/, cleanOutput: true } },
  { id: 'output-clean-failure', group: 'output', title: 'A failed run leaves parseable JSON too', setup: { env: WINDOWS_TERMINAL }, args: ['--max-turns', '1'], steps: oneByOne(read('notes.txt'), read('second.txt')), expect: { exit: 1, subtype: 'error_max_turns', cleanOutput: true } },
  { id: 'output-usage-one', group: 'output', title: 'usage reports cache numbers for one model call', usage: { input: 200, cached: 800 }, expect: { ...DONE, requests: 1, usage: { input_tokens: 200, cache_read_input_tokens: 800 } } },
  { id: 'output-usage-two', group: 'output', title: 'usage adds up over two model calls', usage: { input: 200, cached: 800 }, steps: oneByOne(read('notes.txt')), expect: { ...DONE, requests: 2, usage: { input_tokens: 400, cache_read_input_tokens: 1600 } } },
  { id: 'output-max-turns', group: 'output', title: '--max-turns 1 stops a run that wants a second turn', args: ['--max-turns', '1'], steps: oneByOne(read('notes.txt'), read('second.txt')), expect: { exit: 1, subtype: 'error_max_turns', requests: 1 } },
  { id: 'output-max-turns-retries', group: 'output', title: '--max-turns stops a model that keeps retrying after refusals', note: 'A real model that is refused often tries other tools, and every try costs quota. Use --max-turns in your own scripts.', args: ['--max-turns', '2'], steps: oneByOne(write('made.txt'), bash(RUN_SCRIPT), write('again.txt'), bash(RUN_SCRIPT)), expect: { exit: 1, subtype: 'error_max_turns', requests: 2, missing: ['made.txt', 'again.txt', SCRIPT_RESULT] } },
  { id: 'output-no-prompt-file', group: 'output', title: 'Reading a missing file comes back as a normal tool error', steps: oneByOne(read('does-not-exist.txt')), expect: { ...DONE, denied: [], saw: /does not exist|No such file|not found/i } },

  // ── The prompt cache ──
  { id: 'cache-turns', group: 'cache', title: 'Over several turns the prefix stays identical and history only grows', steps: oneByOne(read('notes.txt'), read('second.txt'), bash('echo third')), expect: { ...DONE, stable: true, requests: 4 } },
  { id: 'cache-turns-refusal', group: 'cache', title: 'A refused tool does not change the prefix', steps: oneByOne(write('made.txt'), read('notes.txt')), expect: { ...DONE, stable: true, denied: ['Write'] } },
  { id: 'cache-turns-mixed', group: 'cache', title: 'Two tools in one reply do not change the prefix', steps: [[read('notes.txt'), read('second.txt')], [write('made.txt')]], expect: { ...DONE, stable: true } },
  { id: 'cache-turns-write', group: 'cache', title: 'A successful write does not change the prefix', args: ['--allowedTools', 'Write'], steps: oneByOne(write('made.txt'), read('made.txt')), expect: { ...DONE, stable: true, exists: ['made.txt'] } },
  { id: 'cache-turns-bash', group: 'cache', title: 'Running shell commands does not change the prefix', args: ['--allowedTools', 'Bash'], steps: oneByOne(bash(RUN_SCRIPT), bash('echo after')), expect: { ...DONE, stable: true } },
  { id: 'cache-turns-mcp', group: 'cache', title: 'Calling an MCP tool does not change the prefix', mcp: true, args: ['--allowedTools', 'mcp__echo__echo'], steps: oneByOne(echoTool, read('notes.txt')), expect: { ...DONE, stable: true } },
  { id: 'cache-two-runs', group: 'cache', title: 'Two separate runs share one prefix', compare: 'same', runs: [{}, {}] },
  { id: 'cache-allowlist', group: 'cache', title: '--allowedTools does not change the prefix', compare: 'same', runs: [{}, { args: ['--allowedTools', 'Read,Write,Bash(node:*)'] }] },
  { id: 'cache-mode-accept', group: 'cache', title: '--permission-mode acceptEdits does not change the prefix', compare: 'same', runs: [{}, { args: ['--permission-mode', 'acceptEdits'] }] },
  { id: 'cache-mode-dont-ask', group: 'cache', title: '--permission-mode dontAsk does not change the prefix', compare: 'same', runs: [{}, { args: ['--permission-mode', 'dontAsk'] }] },
  { id: 'cache-output-format', group: 'cache', title: 'The output format does not change the prefix', compare: 'same', runs: [{ format: 'json' }, { format: 'text' }] },
  { id: 'cache-tools-order', group: 'cache', title: '--tools order does not change the prefix', compare: 'same', runs: [{ args: ['--tools', 'Read,Grep'] }, { args: ['--tools', 'Grep,Read'] }] },
  { id: 'cache-tools-changes', group: 'cache', title: '--tools changes the prefix (expected: keep it the same between runs)', compare: 'different', runs: [{}, { args: ['--tools', 'Read,Grep'] }] },
  { id: 'cache-disallow-changes', group: 'cache', title: '--disallowedTools changes the prefix (expected)', compare: 'different', runs: [{}, { args: ['--disallowedTools', 'Write'] }] },
  { id: 'cache-append-changes', group: 'cache', title: '--append-system-prompt changes the prefix (expected)', compare: 'different', runs: [{}, { args: ['--append-system-prompt', 'Be brief.'] }] },
  { id: 'cache-resume-history', group: 'cache', title: '--resume sends the history it already sent, byte for byte', continues: true, runs: RESUME_RUNS },
  { id: 'cache-resume-prefix', group: 'cache', title: '--resume keeps tools, system prompt and settings', compare: 'same', runs: RESUME_RUNS },
  { id: 'cache-resume-reminder-once', group: 'cache', title: '--resume does not send the skills reminder a second time', runs: RESUME_RUNS, expect: { ...DONE, sentOnce: ['The following skills are available'] } },
  { id: 'cache-resume-twice', group: 'cache', title: 'Resuming twice stays byte for byte both times', continues: true, runs: [
    { persist: true, args: ['--session-id', SESSION], steps: oneByOne(read('notes.txt')) },
    { persist: true, args: ['--resume', SESSION], prompt: 'LAB-PROMPT second question', steps: oneByOne(read('second.txt')) },
    { persist: true, args: ['--resume', SESSION], prompt: 'LAB-PROMPT third question' },
  ] },
  { id: 'cache-continue', group: 'cache', title: '-c sends the history it already sent, byte for byte', continues: true, runs: [
    { persist: true, args: ['--session-id', SESSION], steps: oneByOne(read('notes.txt')) },
    { persist: true, args: ['-c'], prompt: 'LAB-PROMPT second question' },
  ] },
  { id: 'cache-resume-refusal', group: 'cache', title: '--resume keeps a refused tool in the history', continues: true, runs: [
    { persist: true, args: ['--session-id', SESSION], steps: oneByOne(write('made.txt'), read('notes.txt')) },
    { persist: true, args: ['--resume', SESSION], prompt: 'LAB-PROMPT second question' },
  ] },
  { id: 'cache-resume-nested-rules', group: 'cache', title: '--resume keeps folder rules that loaded mid-session', setup: { files: { 'sub/CLAUDE.md': 'LAB-NESTED-RULE applies here.\n', 'sub/file.txt': 'in a subfolder\n' } }, continues: true, runs: [
    { persist: true, args: ['--session-id', SESSION], steps: oneByOne(read('sub/file.txt'), read('notes.txt')) },
    { persist: true, args: ['--resume', SESSION], prompt: 'LAB-PROMPT second question', expect: { ...DONE, sentOnce: ['LAB-NESTED-RULE applies here'] } },
  ] },
  { id: 'cache-resume-hook-context', group: 'cache', title: '--resume keeps context a hook added to a prompt', setup: { files: { 'prompt-hook.mjs': PROMPT_HOOK, '.claude/settings.json': { hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'node prompt-hook.mjs' }] }] } } } }, continues: true, runs: RESUME_RUNS },
  { id: 'cache-resume-stop-hook', group: 'cache', title: 'A Stop hook that ended the turn does not read as an interruption', setup: { files: { 'stop-hook.mjs': STOP_HOOK, '.claude/settings.json': { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node stop-hook.mjs' }] }] } } } }, continues: true, runs: RESUME_RUNS, expect: { notSent: /Continue from where you left off/ } },
  { id: 'cache-resume-fork', group: 'cache', title: '--fork-session keeps the same history in a new session', continues: true, runs: [
    { persist: true, args: ['--session-id', SESSION], steps: oneByOne(read('notes.txt')) },
    { persist: true, args: ['--resume', SESSION, '--fork-session'], prompt: 'LAB-PROMPT second question' },
  ] },
  { id: 'cache-resume-mention', group: 'cache', title: '--resume keeps a file you mentioned with @', continues: true, runs: [
    { persist: true, args: ['--session-id', SESSION], prompt: 'LAB-PROMPT look at @notes.txt' },
    { persist: true, args: ['--resume', SESSION], prompt: 'LAB-PROMPT second question', expect: { ...DONE, sentOnce: ['Pineapple is the first word'] } },
  ] },
  { id: 'cache-resume-compact', group: 'cache', title: '/compact works on a resumed session, and it can be resumed again', runs: [
    { persist: true, args: ['--session-id', SESSION], steps: oneByOne(read('notes.txt')) },
    { persist: true, args: ['--resume', SESSION], prompt: '/compact', expect: { exit: 0 } },
    { persist: true, args: ['--resume', SESSION], prompt: 'LAB-PROMPT after compacting', expect: { ...DONE } },
  ] },
  { id: 'cache-resume-next-turn', group: 'cache', title: 'After the first resumed request, the turns are stable again', runs: [
    { persist: true, args: ['--session-id', SESSION], steps: oneByOne(read('notes.txt')) },
    { persist: true, args: ['--resume', SESSION], prompt: 'LAB-PROMPT second question', steps: oneByOne(read('second.txt')), expect: { ...DONE, stable: true } },
  ] },
  { id: 'cache-markers', group: 'cache', title: 'Cache markers stay the same size each turn', only: ['anthropic'], steps: oneByOne(read('notes.txt'), read('second.txt')), expect: { ...DONE, cacheMarkers: 3 } },

  // ── Which sign-in -p uses (Anthropic) ──
  { id: 'signin-refused-login', group: 'sign-in', title: 'Refused key and a login: uses the login', only: ['anthropic'], setup: { key: 'rejected', login: true }, expect: { ...DONE, credential: 'login' } },
  { id: 'signin-refused-no-login', group: 'sign-in', title: 'Refused key and no login: still uses the key', only: ['anthropic'], setup: { key: 'rejected' }, expect: { ...DONE, credential: 'key' } },
  { id: 'signin-new-key-login', group: 'sign-in', title: 'A key never answered and a login: uses the key', note: 'This is what CI relies on. Remove the variable, or refuse the key in interactive mode, to use the login.', only: ['anthropic'], setup: { key: 'new', login: true }, expect: { ...DONE, credential: 'key' } },
  { id: 'signin-approved-login', group: 'sign-in', title: 'An approved key and a login: uses the key', only: ['anthropic'], setup: { key: 'approved', login: true }, expect: { ...DONE, credential: 'key' } },
  { id: 'signin-login-only', group: 'sign-in', title: 'No key at all: uses the login', only: ['anthropic'], setup: { key: 'none', login: true }, expect: { ...DONE, credential: 'login' } },
  { id: 'signin-stable', group: 'sign-in', title: 'The login stays in use, and the prefix stable, across turns', only: ['anthropic'], setup: { key: 'rejected', login: true }, steps: oneByOne(read('notes.txt'), read('second.txt')), expect: { ...DONE, credential: 'login', stable: true } },
  { id: 'identity-anthropic', group: 'sign-in', title: '-p on Anthropic keeps its own identity line', only: ['anthropic'], expect: { ...DONE, systemHas: SDK_IDENTITY } },

  // ── The Antigravity 429 ──
  { id: 'agy-identity', group: 'antigravity', title: '-p sends the Tau identity, not the one Google refuses', only: ['agy'], expect: { ...DONE, systemHas: TAU_IDENTITY, systemLacks: SDK_IDENTITY } },
  { id: 'agy-gets-answer', group: 'antigravity', title: 'A stand-in that refuses that identity still answers', only: ['agy'], refuse: [SDK_IDENTITY], expect: { ...DONE, requests: 1 } },
  { id: 'agy-append-identity', group: 'antigravity', title: '--append-system-prompt keeps the identity Google accepts', only: ['agy'], args: ['--append-system-prompt', 'Be brief.'], expect: { ...DONE, systemHas: `${TAU_IDENTITY.slice(0, -1)}, running within the Claude Agent SDK.` } },
]

// The real model chooses what to do, so these check what happened on disk rather than exact words. Nothing
// here uses --dangerously-skip-permissions: only the scripted offline scenarios do.
const CREATE = 'Create a file named made.txt that contains the word hello. Do nothing else.'
const RUN = `Run exactly this shell command and tell me when it finished: ${RUN_SCRIPT}`
const READ_FIRST_WORD = 'Read the file notes.txt and answer with only its first word.'
const READ_BOTH = 'Read notes.txt, then read second.txt, then answer with only the first word of each.'

export const realScenarios = [
  { id: 'real-read', group: 'real: allowlist', title: 'Reading works with no flags', prompt: READ_FIRST_WORD, expect: { printed: /pineapple/i } },
  { id: 'real-write-refused', group: 'real: allowlist', title: 'Writing is refused with no flags', prompt: CREATE, expect: { missing: ['made.txt'] } },
  { id: 'real-write-allowed', group: 'real: allowlist', title: '--allowedTools Write allows writing', prompt: CREATE, args: ['--allowedTools', 'Write'], expect: { exists: ['made.txt'] } },
  { id: 'real-script-refused', group: 'real: allowlist', title: 'A command that changes things is refused with no flags', prompt: RUN, expect: { missing: [SCRIPT_RESULT] } },
  { id: 'real-script-allowed', group: 'real: allowlist', title: '"Bash(node:*)" allows that command', prompt: RUN, args: ['--allowedTools', 'Bash(node:*)'], expect: { exists: [SCRIPT_RESULT] } },
  { id: 'real-accept-edits', group: 'real: allowlist', title: 'acceptEdits allows writing', prompt: CREATE, args: ['--permission-mode', 'acceptEdits'], expect: { exists: ['made.txt'] } },
  { id: 'real-tools-read-only', group: 'real: tools', title: '--tools Read means it cannot write even when asked', prompt: CREATE, args: ['--tools', 'Read'], expect: { missing: ['made.txt'] } },
  { id: 'real-tools-none', group: 'real: tools', title: '--tools "" means it cannot read the file', prompt: READ_FIRST_WORD, args: ['--tools', ''], expect: { notPrinted: /pineapple/i } },
  { id: 'real-protect-folder', group: 'real: tools', title: '"Read(secret/**)" protects that folder from the Read tool', prompt: 'Use only the Read tool to read secret/hidden.txt and answer with only its first word.', args: ['--tools', 'Read', '--disallowedTools', 'Read(secret/**)'], expect: { notPrinted: /papaya/i } },
  { id: 'real-cache-tools', group: 'real: cache', title: 'Two turns in one run: the second reuses the first', prompt: READ_BOTH, reportCache: 40, expect: { printed: /pineapple[\s\S]*mango/i } },
  { id: 'real-cache-runs', group: 'real: cache', title: 'The same prompt twice, 30 seconds apart: the second run reuses the first', reportCache: 50, runs: [{ prompt: READ_FIRST_WORD }, { prompt: READ_FIRST_WORD, pauseMs: 30_000 }] },
  { id: 'real-cache-resume', group: 'real: cache', title: 'The first request after --resume, 30 seconds later', reportCache: 50, runs: [
    { persist: true, prompt: READ_FIRST_WORD, args: ['--session-id', SESSION] },
    { persist: true, prompt: 'Now answer with only the word done.', args: ['--resume', SESSION], pauseMs: 30_000 },
  ] },
  { id: 'real-clean-json', group: 'real: output', title: 'JSON output can be piped into another program', prompt: 'Answer with only the word ok.', expect: { printed: /ok/i, cleanOutput: true } },
  { id: 'real-sign-in', group: 'real: sign-in', title: 'Which credential -p uses (none means your login or provider sign-in)', prompt: 'Answer with only the word ok.', format: 'stream-json', reportSignIn: true, expect: { printed: /ok/i } },
]
