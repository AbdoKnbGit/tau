import { readFile, stat } from 'fs/promises'
import { homedir } from 'os'
import path, { join } from 'path'
import { Sandbox, type CommandResult, type SandboxOpts } from 'e2b'
import { getE2BSecurityAuth } from './e2bSecurity.js'

const WORKDIR = '/home/user/safetest/work'
const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024
const DEFAULT_COMMAND_TIMEOUT_MS = 60_000
const DEFAULT_SANDBOX_TIMEOUT_MS = 120_000

type TemplateConfig = {
  defaultTemplate: string
  aliases: Record<string, string>
}

type SafetestOptions = {
  allowInternet: boolean
  commandTimeoutMs: number
  files: string[]
  listTemplates: boolean
  maxFileBytes: number
  sandboxTimeoutMs: number
  selectedTemplate: string | null
  showProvider: boolean
  templateMenu: boolean
  autoTemplate: boolean
}

type ResolvedFile = {
  absPath: string
  relativePath: string
  size: number
}

export type SafetestCommandResult = {
  output: string
  ranSandbox: boolean
}

const BUILTIN_TEMPLATE_ALIASES: Record<string, string> = {
  base: 'base',
  default: 'base',
  code: 'code-interpreter-v1',
  'code-interpreter': 'code-interpreter-v1',
  'code-interpreter-v1': 'code-interpreter-v1',
  python: 'code-interpreter-v1',
  mcp: 'mcp-gateway',
  'mcp-gateway': 'mcp-gateway',
  // E2B's official desktop sandbox: ships with xvfb + a lightweight desktop
  // environment, so GUI scripts (tkinter, PyQt, pygame, selenium, …) run
  // without extra configuration.
  desktop: 'desktop',
  gui: 'desktop',
  display: 'desktop',
}

// Patterns that almost always require a graphical display. When the auto
// recommender sees one of these in the file, it picks the desktop template
// instead of code-interpreter.
const GUI_IMPORT_PATTERNS: RegExp[] = [
  /\bimport\s+tkinter\b/,
  /\bfrom\s+tkinter\b/,
  /\bimport\s+tk\b/,
  /\bimport\s+pygame\b/,
  /\bfrom\s+PyQt[56]\b/,
  /\bimport\s+PyQt[56]\b/,
  /\bfrom\s+PySide[26]\b/,
  /\bimport\s+wx\b/,
  /\bimport\s+gi\.repository\b/,
  /\bimport\s+pyautogui\b/,
  /\bfrom\s+selenium\b/,
  /\bimport\s+selenium\b/,
  /\bfrom\s+playwright\b/,
  /\bimport\s+playwright\b/,
  /\bcv2\.imshow\s*\(/,
  /\brequire\(['"]electron['"]\)/,
  /\bfrom\s+['"]electron['"]/,
  /\brequire\(['"]puppeteer['"]\)/,
  /\bfrom\s+['"]puppeteer['"]/,
]

const OPTIONAL_TEMPLATE_ALIASES: Record<
  string,
  { files: string; use: string; fallback: string }
> = {
  security: {
    files: 'unknown, docs, archives',
    use: 'static triage tools such as strings, yara, exiftool, binwalk',
    fallback: 'base',
  },
  wine: {
    files: '.exe, .bat, .cmd',
    use: 'Windows detonation with Wine or a Windows-analysis template',
    fallback: 'base',
  },
  powershell: {
    files: '.ps1, .psm1',
    use: 'PowerShell execution with pwsh installed',
    fallback: 'base',
  },
  browser: {
    files: '.html, .svg',
    use: 'browser/DOM behavior checks',
    fallback: 'base',
  },
  network: {
    files: 'network samples',
    use: 'controlled phone-home testing when internet is explicitly allowed',
    fallback: 'base',
  },
}

export async function runSafetestFromArgs(
  args: string,
  cwd: string,
): Promise<SafetestCommandResult> {
  const options = parseSafetestArgs(args)
  const config = await loadTemplateConfig(cwd)

  if (options.showProvider) {
    const { getE2BSecurityStatusLines } = await import('./e2bSecurity.js')
    return {
      output: getE2BSecurityStatusLines().join('\n'),
      ranSandbox: false,
    }
  }

  if (options.templateMenu || options.listTemplates) {
    return {
      output: formatTemplateMenu(config, options.selectedTemplate),
      ranSandbox: false,
    }
  }

  applyPositionalTemplateSelector(options, config)

  if (options.files.length === 0) {
    return {
      output: formatTemplateMenu(config, options.selectedTemplate),
      ranSandbox: false,
    }
  }

  const file = await resolveTargetFile(options.files[0] ?? '', cwd, options)
  const unavailable = getUnavailableTemplateMessage(options.selectedTemplate, config, file)
  if (unavailable) {
    return { output: unavailable, ranSandbox: false }
  }

  const auth = getE2BSecurityAuth()
  if (!auth.apiKey && !auth.accessToken) {
    return {
      output: [
        'Safetest is not logged in to E2B yet.',
        '',
        'Run /login, pick "E2B Security", and Tau will open the dashboard so',
        'you can paste your API key. After that, /safetest works with no extra setup.',
      ].join('\n'),
      ranSandbox: false,
    }
  }

  // Read the file once: we need the bytes for upload AND a content peek for
  // GUI-import detection so the auto-template recommender can pick the
  // desktop template when the script needs a display.
  const bytes = await readFile(file.absPath)
  const contentPeek = peekTextContent(bytes)

  const recommendation = options.autoTemplate
    ? recommendTemplate(file.absPath, contentPeek, config, options.allowInternet)
    : null
  const selectedAlias =
    options.selectedTemplate ??
    recommendation?.selectedAlias ??
    config.defaultTemplate
  const resolvedTemplate = resolveTemplateName(selectedAlias, config)
  const placeholderError = detectPlaceholderTemplateId(selectedAlias, resolvedTemplate)
  if (placeholderError) {
    return { output: placeholderError, ranSandbox: false }
  }
  const templateKind = isWineLikeAlias(selectedAlias) ? 'wine' : 'default'
  const command = deriveDefaultCommand(file.relativePath, templateKind)

  const createOptions: SandboxOpts = {
    apiKey: auth.apiKey,
    accessToken: auth.accessToken,
    timeoutMs: options.sandboxTimeoutMs,
    requestTimeoutMs: options.sandboxTimeoutMs + 30_000,
    allowInternetAccess: options.allowInternet,
    metadata: {
      tool: 'tau-safetest',
      mode: 'manual',
    },
  }

  let sandbox: Sandbox | null = null
  let killed = false

  try {
    sandbox = resolvedTemplate
      ? await Sandbox.create(resolvedTemplate, createOptions)
      : await Sandbox.create(createOptions)

    await sandbox.commands.run(`mkdir -p ${shellQuote(WORKDIR)}`, {
      timeoutMs: 10_000,
      requestTimeoutMs: 20_000,
    })

    const remotePath = `${WORKDIR}/${file.relativePath}`
    await sandbox.commands.run(`mkdir -p ${shellQuote(path.posix.dirname(remotePath))}`, {
      timeoutMs: 10_000,
      requestTimeoutMs: 20_000,
    })
    await sandbox.files.write(remotePath, toArrayBuffer(bytes), {
      requestTimeoutMs: 60_000,
    })

    const fingerprint = await runSandboxCommand(
      sandbox,
      'find . -maxdepth 10 -type f -print0 | xargs -0 sha256sum',
      {
        cwd: WORKDIR,
        timeoutMs: 30_000,
        requestTimeoutMs: 45_000,
      },
    )

    const result = await runSandboxCommand(sandbox, command, {
      cwd: WORKDIR,
      timeoutMs: options.commandTimeoutMs,
      requestTimeoutMs: options.commandTimeoutMs + 30_000,
    })

    await sandbox.kill({ requestTimeoutMs: 30_000 })
    killed = true

    return {
      output: formatSafetestReport({
        sandboxId: sandbox.sandboxId,
        selectedAlias,
        resolvedTemplate: resolvedTemplate || 'sdk-default',
        templateReason: recommendation?.reason,
        network: options.allowInternet ? 'enabled' : 'disabled',
        uploaded: file,
        remotePath,
        command,
        exitCode: exitCode(result),
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        error: commandError(result),
        fingerprints: fingerprint.stdout ?? '',
        killed,
      }),
      ranSandbox: true,
    }
  } finally {
    if (sandbox && !killed) {
      try {
        await sandbox.kill({ requestTimeoutMs: 30_000 })
      } catch {
        // Best effort cleanup; the report path only reaches here on failures.
      }
    }
  }
}

function parseSafetestArgs(args: string): SafetestOptions {
  const tokens = tokenizeArgs(args)
  const options: SafetestOptions = {
    allowInternet: false,
    commandTimeoutMs: numberFromEnv(
      'E2B_SAFETEST_COMMAND_TIMEOUT_MS',
      DEFAULT_COMMAND_TIMEOUT_MS,
    ),
    files: [],
    listTemplates: false,
    maxFileBytes: numberFromEnv(
      'E2B_SAFETEST_MAX_FILE_BYTES',
      DEFAULT_MAX_FILE_BYTES,
    ),
    sandboxTimeoutMs: numberFromEnv(
      'E2B_SAFETEST_SANDBOX_TIMEOUT_MS',
      DEFAULT_SANDBOX_TIMEOUT_MS,
    ),
    selectedTemplate: null,
    showProvider: false,
    templateMenu: tokens.length === 0,
    autoTemplate: false,
  }

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] ?? ''

    if (token === '--allow-internet' || token === '--internet') {
      options.allowInternet = true
      continue
    }
    if (token === '--no-internet') {
      options.allowInternet = false
      continue
    }
    if (token === '--templates' || token === '--list-templates') {
      options.listTemplates = true
      continue
    }
    if (token === '--provider' || token === '--status') {
      options.showProvider = true
      continue
    }
    if (token === '--template-menu' || token === '--menu') {
      options.templateMenu = true
      continue
    }
    if (token === '--auto-template') {
      options.autoTemplate = true
      continue
    }
    if (token === '--template') {
      options.selectedTemplate = requireValue(tokens, ++i, token)
      continue
    }
    if (token === '--file') {
      options.files.push(requireValue(tokens, ++i, token))
      continue
    }
    if (token === '--timeout-ms' || token === '--command-timeout-ms') {
      options.commandTimeoutMs = parsePositiveInteger(
        requireValue(tokens, ++i, token),
        token,
      )
      continue
    }
    if (token === '--sandbox-timeout-ms') {
      options.sandboxTimeoutMs = parsePositiveInteger(
        requireValue(tokens, ++i, token),
        token,
      )
      continue
    }
    if (token === '--max-file-bytes') {
      options.maxFileBytes = parsePositiveInteger(
        requireValue(tokens, ++i, token),
        token,
      )
      continue
    }

    options.files.push(token)
  }

  return options
}

async function loadTemplateConfig(cwd: string): Promise<TemplateConfig> {
  const config: TemplateConfig = {
    defaultTemplate: 'base',
    aliases: { ...BUILTIN_TEMPLATE_ALIASES },
  }
  const candidates = [
    join(homedir(), '.safeclaudecode', 'safetest.config.json'),
    join(cwd, 'safetest.config.json'),
  ]

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(await readFile(candidate, 'utf8')) as {
        defaultTemplate?: string
        aliases?: Record<string, string>
        templates?: Record<string, string>
      }
      if (parsed.defaultTemplate) {
        config.defaultTemplate = parsed.defaultTemplate
      }
      config.aliases = {
        ...config.aliases,
        ...(parsed.aliases ?? {}),
        ...(parsed.templates ?? {}),
      }
    } catch (error) {
      const code = (error as { code?: string }).code
      if (code !== 'ENOENT') throw error
    }
  }

  return config
}

function applyPositionalTemplateSelector(
  options: SafetestOptions,
  config: TemplateConfig,
): void {
  if (options.selectedTemplate || options.files.length === 0) return

  const first = options.files[0] ?? ''
  const selector = first.toLowerCase()

  if (selector === 'auto') {
    options.autoTemplate = true
    options.files.shift()
    return
  }

  if (options.files.length === 1 && isTemplateSelector(selector, config)) {
    options.selectedTemplate = options.files.shift() ?? null
    options.templateMenu = true
    return
  }

  if (options.files.length >= 2) {
    options.selectedTemplate = options.files.shift() ?? null
    return
  }

  options.autoTemplate = true
}

async function resolveTargetFile(
  rawFile: string,
  cwd: string,
  options: SafetestOptions,
): Promise<ResolvedFile> {
  const cleanFile = normalizeFileArgument(rawFile)
  const absPath = path.resolve(cwd, cleanFile)
  const info = await stat(absPath).catch(() => null)

  if (!info) {
    throw new Error(
      [
        'Safetest target file not found.',
        `File: ${absPath}`,
        `Working directory: ${cwd}`,
      ].join('\n'),
    )
  }

  if (!info.isFile()) {
    throw new Error(`Safetest only accepts one regular file: ${absPath}`)
  }

  if (info.size > options.maxFileBytes) {
    throw new Error(
      [
        'Safetest stopped before upload: file is above the upload guard limit.',
        `File: ${absPath}`,
        `Size: ${formatBytes(info.size)} (${info.size} bytes)`,
        `Current limit: ${formatBytes(options.maxFileBytes)} (${options.maxFileBytes} bytes)`,
        '',
        'Raise the limit only when you intentionally want to upload this file to E2B:',
        `  /safetest --max-file-bytes ${Math.ceil(info.size * 1.1)} @${absPath}`,
      ].join('\n'),
    )
  }

  return {
    absPath,
    relativePath: safeRelativePath(absPath, cwd),
    size: info.size,
  }
}

function getUnavailableTemplateMessage(
  selectedTemplate: string | null,
  config: TemplateConfig,
  file: ResolvedFile,
): string | null {
  if (!selectedTemplate) return null
  const key = selectedTemplate.toLowerCase()
  if (!OPTIONAL_TEMPLATE_ALIASES[key]) return null
  if (Object.hasOwn(config.aliases, key)) return null

  const info = OPTIONAL_TEMPLATE_ALIASES[key]
  return [
    'Safetest template is not configured.',
    `Template: ${selectedTemplate}`,
    `File types: ${info.files}`,
    `Use: ${info.use}`,
    '',
    'Run now with the safe fallback:',
    `  /safetest ${info.fallback} @${file.absPath}`,
    '',
    `To enable /safetest ${selectedTemplate} @file, build a custom E2B template (e.g. \`e2b template build\`) and add its ID to safetest.config.json:`,
    JSON.stringify(
      { aliases: { [selectedTemplate]: '<paste-the-id-from-e2b-template-build>' } },
      null,
      2,
    ),
    '',
    'Replace the angle-bracket placeholder with the real template ID — leaving it as <…> will fail with "no such file".',
  ].join('\n')
}

function recommendTemplate(
  absPath: string,
  contentPeek: string,
  config: TemplateConfig,
  allowInternet: boolean,
): { selectedAlias: string; reason: string } {
  const ext = path.extname(absPath).toLowerCase()
  const has = (alias: string) => Object.hasOwn(config.aliases, alias)
  const pick = (aliases: string[], fallback: string) =>
    aliases.find(alias => has(alias)) ?? fallback
  const needsDisplay = detectsGuiUsage(contentPeek)

  if (['.py', '.pyw', '.ipynb'].includes(ext)) {
    if (needsDisplay) {
      return {
        selectedAlias: pick(['desktop', 'gui'], 'desktop'),
        reason: 'Python script imports a GUI library; using the E2B desktop template (xvfb + display).',
      }
    }
    return {
      selectedAlias: pick(['python', 'code', 'code-interpreter'], 'code'),
      reason: 'Python/code file: code-interpreter is the best default.',
    }
  }
  if (['.sh', '.bash', '.zsh', '.fish', '.ksh'].includes(ext)) {
    return {
      selectedAlias: 'base',
      reason: 'Shell script: base Linux is the minimal safe default.',
    }
  }
  if (['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx'].includes(ext)) {
    if (needsDisplay) {
      return {
        selectedAlias: pick(['desktop', 'gui'], 'desktop'),
        reason: 'JS/TS script imports a GUI/automation library; using the E2B desktop template (xvfb + display).',
      }
    }
    return {
      selectedAlias: pick(['node', 'javascript', 'security'], 'base'),
      reason: 'JavaScript/TypeScript file: using a configured JS/security template if available, otherwise base.',
    }
  }
  if (['.ps1', '.psm1', '.psd1'].includes(ext)) {
    return {
      selectedAlias: pick(['powershell', 'pwsh', 'security'], 'base'),
      reason: 'PowerShell file: using a configured PowerShell/security template if available, otherwise base.',
    }
  }
  if (['.exe', '.dll', '.bat', '.cmd', '.msi', '.scr', '.com'].includes(ext)) {
    return {
      selectedAlias: pick(['wine', 'windows', 'windows-analysis', 'security'], 'base'),
      reason: 'Windows executable/script: using a configured Wine/security template if available, otherwise base classifies and explains.',
    }
  }
  if (
    [
      '.pdf',
      '.doc',
      '.docx',
      '.docm',
      '.xls',
      '.xlsx',
      '.xlsm',
      '.ppt',
      '.pptx',
      '.pptm',
      '.rtf',
      '.zip',
      '.rar',
      '.7z',
      '.tar',
      '.gz',
      '.xz',
      '.iso',
      '.apk',
    ].includes(ext)
  ) {
    return {
      selectedAlias: pick(['security', 'document', 'office', 'pdf'], 'base'),
      reason: 'Document/archive sample: using a configured security/document template if available, otherwise base.',
    }
  }
  if (['.html', '.htm', '.svg'].includes(ext)) {
    return {
      selectedAlias: pick(['browser', 'web', 'security'], 'base'),
      reason: 'Browser-rendered file: using a configured browser/security template if available, otherwise base.',
    }
  }

  return {
    selectedAlias: allowInternet ? pick(['network', 'security'], 'base') : pick(['security'], 'base'),
    reason: 'Unknown file type: using a configured security/network template if available, otherwise base.',
  }
}

function resolveTemplateName(template: string | null, config: TemplateConfig): string | null {
  if (!template || template === 'sdk-default' || template === 'none') return null
  return config.aliases[template] ?? template
}

const PLACEHOLDER_TEMPLATE_PATTERNS: RegExp[] = [
  /^your[-_]?(e2b[-_]?)?template[-_]?id$/i,
  /^<.*template.*>$/i,
  /^replace[-_]?(me|with).*$/i,
  /^template[-_]?id[-_]?here$/i,
  /^<your[-_].*>$/i,
]

function detectPlaceholderTemplateId(
  alias: string | null,
  resolved: string | null,
): string | null {
  if (!resolved) return null
  if (!PLACEHOLDER_TEMPLATE_PATTERNS.some(pattern => pattern.test(resolved))) {
    return null
  }
  return [
    `Safetest cannot start: the alias "${alias ?? resolved}" points at "${resolved}", which is a placeholder, not a real E2B template ID.`,
    '',
    'Edit safetest.config.json (in this folder or ~/.safeclaudecode/) and replace the placeholder with the template ID printed by `e2b template build`.',
    'Until then, /safetest will use the built-in templates (auto, base, code, desktop, mcp).',
  ].join('\n')
}

function isWineLikeAlias(alias: string | null): boolean {
  if (!alias) return false
  const lower = alias.toLowerCase()
  return lower === 'wine' || lower === 'windows' || lower === 'windows-analysis'
}

function deriveDefaultCommand(relativePath: string, templateKind: 'wine' | 'default'): string {
  const target = shellQuote(`./${toPosixPath(relativePath)}`)
  const kind = shellQuote(templateKind)

  return [
    `target=${target}`,
    `export SAFETEST_TEMPLATE_KIND=${kind}`,
    'echo "--- safetest file classification ---"',
    'printf "target=%s\\n" "$target"',
    'if command -v file >/dev/null 2>&1; then file "$target"; else echo "file command unavailable"; fi',
    'if command -v stat >/dev/null 2>&1; then stat -c "mode=%A size=%s bytes" "$target" 2>/dev/null || true; fi',
    'lower=$(printf "%s" "$target" | tr "[:upper:]" "[:lower:]")',
    'run_or_explain() { tool="$1"; shift; if command -v "$tool" >/dev/null 2>&1; then "$tool" "$@"; else echo "required runtime not installed in this template: $tool"; return 126; fi; }',
    // ensure_display: try, in order, the existing $DISPLAY, xvfb-run (needs
    // xauth), or a raw Xvfb :99 server. Some templates ship Xvfb without xauth
    // and that breaks xvfb-run with "X authority files" — falling back to a
    // direct Xvfb server keeps GUI runs working in those images.
    'ensure_display() { if [ -n "$DISPLAY" ]; then return 0; fi; if command -v xvfb-run >/dev/null 2>&1 && command -v xauth >/dev/null 2>&1; then export __SAFETEST_DISPLAY_MODE=xvfb-run; return 0; fi; if command -v Xvfb >/dev/null 2>&1; then if [ -z "$XAUTHORITY" ]; then export XAUTHORITY="$HOME/.Xauthority"; fi; [ -f "$XAUTHORITY" ] || touch "$XAUTHORITY"; Xvfb :99 -screen 0 1280x1024x24 -nolisten tcp >/tmp/xvfb.log 2>&1 & __SAFETEST_XVFB_PID=$!; sleep 1; export DISPLAY=:99 __SAFETEST_DISPLAY_MODE=xvfb-direct; return 0; fi; return 1; }',
    'cleanup_display() { if [ -n "$__SAFETEST_XVFB_PID" ]; then kill "$__SAFETEST_XVFB_PID" 2>/dev/null || true; unset __SAFETEST_XVFB_PID; fi; }',
    // run_with_display: route Python/Node/Java/etc through ensure_display so
    // GUI libraries (tkinter, PyQt, pygame, selenium, electron, …) don't crash
    // on $DISPLAY in a headless template.
    'run_with_display() { tool="$1"; shift; if ! command -v "$tool" >/dev/null 2>&1; then echo "required runtime not installed in this template: $tool"; return 126; fi; if ! ensure_display; then echo "headless template: install xvfb (and xauth), or pick the desktop template"; return 126; fi; rc=0; if [ "$__SAFETEST_DISPLAY_MODE" = "xvfb-run" ]; then xvfb-run -a -e /dev/stderr "$tool" "$@"; rc=$?; else "$tool" "$@"; rc=$?; cleanup_display; fi; return $rc; }',
    // static_analysis: comprehensive read-only inspection. Reported as "Static
    // analysis (file not executed)" so the verdict line is honest about not
    // having run the file. Sections only show when the relevant tool exists.
    'static_analysis() { echo "=== Static analysis (file not executed) ==="; if command -v file >/dev/null 2>&1; then echo; echo "[file type]"; file "$target"; fi; echo; echo "[hashes]"; if command -v sha256sum >/dev/null 2>&1; then sha256sum "$target"; fi; if command -v md5sum >/dev/null 2>&1; then md5sum "$target"; fi; if command -v exiftool >/dev/null 2>&1; then echo; echo "[exiftool metadata]"; exiftool "$target" 2>/dev/null | sed -n "1,40p" || true; fi; if command -v objdump >/dev/null 2>&1; then echo; echo "[objdump headers]"; objdump -x "$target" 2>/dev/null | sed -n "1,80p" || true; echo; echo "[imports / dynamic deps]"; objdump -p "$target" 2>/dev/null | grep -iE "DLL Name|NEEDED|Import" | sed -n "1,40p" || true; fi; if command -v strings >/dev/null 2>&1; then echo; echo "[interesting strings: URLs / paths / registry / common APIs]"; strings -a "$target" | grep -iE "^(https?://|file://|ftp://|[A-Z]:\\\\|/etc/|/proc/|/usr/|/root/|/home/|HKEY_|SOFTWARE\\\\|SYSTEM\\\\|RegOpen|RegQuery|RegSet|CreateProcess|ShellExecute|VirtualAlloc|WriteProcess|LoadLibrary|GetProcAddress|InternetOpen|WinHttp|socket|connect|recv|send|user32|kernel32|advapi32|ws2_32|wininet)" 2>/dev/null | sed -n "1,80p" || true; echo; echo "[strings sample (first 60)]"; strings -a "$target" | sed -n "1,60p"; else echo; echo "[hex sample, first 256 bytes]"; od -An -tx1 -N 256 "$target" | sed -n "1,16p"; fi; }',
    'static_preview() { static_analysis; }',
    'run_wine() { if ! command -v wine >/dev/null 2>&1; then echo "Windows binary detected. Wine is not installed in this template, so safetest reports static analysis only."; static_analysis; exit 0; fi; if ! ensure_display; then echo "Wine is installed but no display (xvfb/xauth) is available. Falling back to static analysis."; static_analysis; return 0; fi; rc=0; if [ "$__SAFETEST_DISPLAY_MODE" = "xvfb-run" ]; then xvfb-run -a -e /dev/stderr wine "$@"; rc=$?; else wine "$@"; rc=$?; cleanup_display; fi; return $rc; }',
    'echo "--- safetest execution ---"',
    'case "$lower" in',
    '  *.sh|*.bash) run_or_explain bash "$target" ;;',
    '  *.zsh) run_or_explain zsh "$target" ;;',
    '  *.fish) run_or_explain fish "$target" ;;',
    '  *.py) run_with_display python3 "$target" ;;',
    '  *.js|*.mjs|*.cjs) run_with_display node "$target" ;;',
    '  *.ts|*.tsx) if command -v tsx >/dev/null 2>&1; then run_with_display tsx "$target"; elif command -v deno >/dev/null 2>&1; then run_with_display deno run "$target"; elif command -v node >/dev/null 2>&1; then echo "TypeScript runtime not installed; trying node fallback"; run_with_display node "$target"; else echo "TypeScript runtime not installed in this template: tsx, deno, or node"; exit 126; fi ;;',
    '  *.rb) run_with_display ruby "$target" ;;',
    '  *.pl) run_or_explain perl "$target" ;;',
    '  *.php) run_or_explain php "$target" ;;',
    '  *.lua) run_or_explain lua "$target" ;;',
    '  *.jar) run_with_display java -jar "$target" ;;',
    '  *.ps1) run_or_explain pwsh -File "$target" ;;',
    '  *.dll|*.msi|*.exe|*.scr|*.com|*.bat|*.cmd)',
    '    if [ "$SAFETEST_TEMPLATE_KIND" = "wine" ] && command -v wine >/dev/null 2>&1; then',
    '      case "$lower" in',
    '        *.bat|*.cmd) run_wine cmd /c "$target" ;;',
    '        *.dll) echo "DLLs are not standalone programs — analyzing statically."; static_analysis; exit 0 ;;',
    '        *.msi) echo "MSI installers are not detonated automatically — analyzing statically."; static_analysis; exit 0 ;;',
    '        *) run_wine "$target" ;;',
    '      esac',
    '    else',
    '      echo "Windows binary on a non-Wine template — safetest reports static analysis only (no execution)."',
    '      echo "To execute it, build a custom E2B template with Wine and run /safetest wine @./<file>."',
    '      static_analysis',
    '      exit 0',
    '    fi',
    '    ;;',
    '  *)',
    '    description=$(file -b "$target" 2>/dev/null || true)',
    '    case "$description" in',
    '      *ELF*|*Mach-O*|*executable*|*script*) chmod +x "$target" 2>/dev/null || true; "$target" ;;',
    '      *) echo "No safe default executor for this file type — static analysis only."; static_analysis; exit 0 ;;',
    '    esac',
    '    ;;',
    'esac',
  ].join('\n')
}

async function runSandboxCommand(
  sandbox: Sandbox,
  command: string,
  options: {
    cwd?: string
    timeoutMs: number
    requestTimeoutMs: number
  },
): Promise<CommandResult> {
  try {
    return await sandbox.commands.run(command, options)
  } catch (error) {
    const result = commandResultFromError(error)
    if (result) return result
    throw error
  }
}

function commandResultFromError(error: unknown): CommandResult | null {
  const err = error as {
    result?: Partial<CommandResult>
    exitCode?: number
    stdout?: string
    stderr?: string
    message?: string
    name?: string
  }
  if (!err.result && err.name !== 'CommandExitError') return null

  return {
    exitCode: err.exitCode ?? err.result?.exitCode ?? 1,
    stdout: err.stdout ?? err.result?.stdout ?? '',
    stderr: err.stderr ?? err.result?.stderr ?? '',
    error: err.message ?? err.result?.error ?? null,
  } as CommandResult
}

function formatSafetestReport(report: {
  sandboxId: string
  selectedAlias: string
  resolvedTemplate: string
  templateReason?: string
  network: string
  uploaded: ResolvedFile
  remotePath: string
  command: string
  exitCode: number | null
  stdout: string
  stderr: string
  error: string | null
  fingerprints: string
  killed: boolean
}): string {
  const split = splitClassificationAndOutput(report.stdout)
  const classification = parseClassification(split.classification)
  const programStdout = split.programOutput.trimEnd()
  const programStderr = report.stderr.trimEnd()
  const diagnosticHint = diagnoseStderr(programStderr)

  const verdict = describeVerdict({
    exitCode: report.exitCode,
    error: report.error,
    hasStdout: programStdout.length > 0,
    hasStderr: programStderr.length > 0,
  })

  const targetSha = extractTargetSha(report.fingerprints, report.uploaded.relativePath)

  const fileLineParts = [
    classification.fileType ?? 'file',
    formatBytes(report.uploaded.size),
    targetSha ? `sha256 ${targetSha.slice(0, 12)}…` : null,
  ].filter((part): part is string => Boolean(part))

  const sandboxLineParts = [
    `template ${formatReportTemplate(report.selectedAlias, report.resolvedTemplate)}`,
    `network ${report.network}`,
    `sandbox ${report.sandboxId}`,
  ]

  return [
    `Safetest — ${report.uploaded.relativePath}`,
    `Verdict: ${verdict}`,
    report.templateReason ? `Template reason: ${report.templateReason}` : null,
    '',
    `File: ${fileLineParts.join('  •  ')}`,
    sandboxLineParts.join('  •  '),
    programStdout
      ? ['', 'Output:', truncateOutput(programStdout)].join('\n')
      : null,
    programStderr
      ? ['', 'Errors:', truncateOutput(programStderr)].join('\n')
      : null,
    diagnosticHint ? `\n${diagnosticHint}` : null,
  ]
    .filter((line): line is string => line !== null)
    .join('\n')
}

function describeVerdict(input: {
  exitCode: number | null
  error: string | null
  hasStdout: boolean
  hasStderr: boolean
}): string {
  if (input.error) return `sandbox error — ${input.error}`
  if (input.exitCode === null) return 'unknown — sandbox did not return an exit code'
  if (input.exitCode === 0) {
    return input.hasStdout
      ? 'completed successfully (exit 0)'
      : 'completed silently (exit 0, no output)'
  }
  if (input.exitCode === 124 || input.exitCode === 137) {
    return `timed out (exit ${input.exitCode}) — script ran past the safetest time limit`
  }
  if (input.exitCode === 126) {
    return `runtime missing (exit 126) — required interpreter not installed in this template`
  }
  if (input.exitCode === 127) {
    return `command not found (exit 127)`
  }
  if (input.hasStderr) {
    return `failed (exit ${input.exitCode}) — see Errors`
  }
  return `failed (exit ${input.exitCode})`
}

function splitClassificationAndOutput(stdout: string): {
  classification: string
  programOutput: string
} {
  const marker = '--- safetest execution ---'
  const idx = stdout.indexOf(marker)
  if (idx === -1) {
    return { classification: '', programOutput: stdout }
  }
  return {
    classification: stdout.slice(0, idx),
    programOutput: stdout.slice(idx + marker.length).replace(/^\r?\n/, ''),
  }
}

function parseClassification(block: string): { fileType: string | null } {
  if (!block) return { fileType: null }
  // The `file` command output looks like: "test.py: Python script, ASCII text…"
  // Take the description after the first colon.
  const fileLine = block
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(line => /^[^=\s][^\n]*:\s+.+/.test(line) && !line.startsWith('target='))
  if (!fileLine) return { fileType: null }
  const desc = fileLine.split(':').slice(1).join(':').trim()
  return { fileType: desc.length > 0 ? truncate(desc, 90) : null }
}

function extractTargetSha(fingerprints: string, relativePath: string): string | null {
  if (!fingerprints) return null
  const target = `./${toPosixPath(relativePath)}`
  for (const line of fingerprints.split(/\r?\n/)) {
    const match = line.match(/^([0-9a-f]{64})\s+(.+)$/i)
    if (!match) continue
    if (match[2] === target || match[2] === relativePath) return match[1]
  }
  // Fall back to the first hash if we can't match the path exactly.
  const first = fingerprints.match(/^([0-9a-f]{64})\b/i)
  return first ? first[1] : null
}

function truncateOutput(text: string): string {
  const maxLines = 60
  const maxChars = 6000
  let trimmed = text.length > maxChars ? `${text.slice(0, maxChars)}…` : text
  const lines = trimmed.split(/\r?\n/)
  if (lines.length > maxLines) {
    const dropped = lines.length - maxLines
    trimmed = [...lines.slice(0, maxLines), `… (${dropped} more lines truncated)`].join('\n')
  }
  return trimmed
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function diagnoseStderr(stderr: string): string | null {
  if (!stderr) return null
  const text = stderr.toLowerCase()

  if (
    text.includes('xauth') ||
    text.includes('x authority') ||
    text.includes("couldn't get a file descriptor referring to the console")
  ) {
    return [
      'Hint: the sandbox image has Xvfb but is missing the xauth package, so xvfb-run cannot create an X authority file.',
      'Safetest tries a raw Xvfb :99 fallback when xauth is missing — this hint means even that path is blocked.',
      'Fix: rebuild the E2B template with `apt-get install -y xauth xvfb`, or pick a template that already has both.',
    ].join('\n')
  }

  if (
    text.includes('no display name and no $display') ||
    text.includes('cannot connect to x server') ||
    text.includes('could not connect to display')
  ) {
    return [
      'Hint: the script needs a graphical display, but this template is headless.',
      'Re-run with the desktop template — it ships with xvfb + a display, no extra setup:',
      '  /safetest desktop @./<file>',
    ].join('\n')
  }

  if (
    text.includes('wine: command not found') ||
    text.includes('the active e2b template has no wine installed')
  ) {
    return [
      'Hint: no public E2B template ships with Wine. To detonate .exe/.bat/.cmd files, build your own:',
      '  1. Create a Dockerfile based on `e2bdev/code-interpreter` and `apt-get install -y wine xvfb xauth`',
      '  2. `e2b template build` to publish it',
      '  3. Add the template ID to safetest.config.json under {"aliases":{"wine":"<template-id>"}}',
    ].join('\n')
  }

  return null
}

function formatTemplateMenu(
  config: TemplateConfig,
  selectedAlias: string | null,
): string {
  const rows = templateRows(config)
  const optionalRows = optionalTemplateRows(config)
  const nameWidth = Math.max(
    ...rows.map(row => row.name.length),
    ...optionalRows.map(row => row.name.length),
    'template'.length,
  )
  const filesWidth = Math.max(
    ...rows.map(row => row.files.length),
    ...optionalRows.map(row => row.files.length),
    'file types'.length,
  )

  return [
    'Safetest — run a file inside a disposable E2B sandbox.',
    '',
    'How to use:',
    '  /safetest @./file               auto-pick the template (detects GUI imports)',
    '  /safetest base @./script.sh     minimal Linux (bash, sh, zsh)',
    '  /safetest code @./payload.py    Python + Jupyter (code-interpreter)',
    '  /safetest desktop @./gui.py     GUI scripts (tkinter, PyQt, selenium…)',
    '  /safetest --allow-internet @./file   enable network access in the sandbox',
    selectedAlias
      ? [
          '',
          `Selected template: ${selectedAlias}`,
          `Add a file path to run it:  /safetest ${selectedAlias} @./file`,
        ].join('\n')
      : null,
    '',
    `${'template'.padEnd(nameWidth)}  ${'file types'.padEnd(filesWidth)}  runs`,
    `${'-'.repeat(nameWidth)}  ${'-'.repeat(filesWidth)}  ${'-'.repeat(4)}`,
    ...rows.map(row =>
      `${row.name.padEnd(nameWidth)}  ${row.files.padEnd(filesWidth)}  ${row.runs}`,
    ),
    optionalRows.length > 0 ? '' : null,
    optionalRows.length > 0
      ? 'Optional templates (build a custom E2B template, then add to safetest.config.json):'
      : null,
    ...optionalRows.map(row =>
      `${row.name.padEnd(nameWidth)}  ${row.files.padEnd(filesWidth)}  ${row.runs}`,
    ),
    '',
    'Network is off by default. After /login → E2B Security, /safetest is ready to go.',
  ]
    .filter((line): line is string => line !== null)
    .join('\n')
}

function optionalTemplateRows(config: TemplateConfig): Array<{
  name: string
  files: string
  runs: string
}> {
  // Hide rows the user has already configured — those show up under the
  // built-in table via templateRows-derived data instead.
  return Object.entries(OPTIONAL_TEMPLATE_ALIASES)
    .filter(([alias]) => !Object.hasOwn(config.aliases, alias))
    .map(([alias, info]) => ({
      name: alias,
      files: info.files,
      runs: info.use,
    }))
}

function templateRows(_config: TemplateConfig): Array<{
  name: string
  files: string
  runs: string
}> {
  return [
    { name: 'auto', files: 'any file', runs: 'picks the right template from the file extension' },
    { name: 'base', files: '.sh, .bash, unknown files', runs: 'minimal Linux sandbox' },
    { name: 'code', files: '.py, .ipynb, .js, .ts', runs: 'code-interpreter (Python + Node)' },
    { name: 'desktop', files: 'GUI scripts (tkinter, PyQt, selenium, …)', runs: 'E2B desktop template (xvfb + display)' },
    { name: 'mcp', files: 'MCP workflows', runs: 'mcp-gateway' },
  ]
}

function peekTextContent(bytes: Buffer): string {
  // Read up to 64 KiB so we can scan for GUI imports without loading the whole
  // file into a string. Decode as UTF-8 with replacement; binary files just
  // produce gibberish that won't match the patterns, which is fine.
  const limit = Math.min(bytes.byteLength, 64 * 1024)
  return bytes.subarray(0, limit).toString('utf8')
}

function detectsGuiUsage(content: string): boolean {
  if (!content) return false
  return GUI_IMPORT_PATTERNS.some(pattern => pattern.test(content))
}

function normalizeFileArgument(value: string): string {
  let file = value.trim()
  if (file.startsWith('+@')) file = file.slice(2)
  else if (file.startsWith('@')) file = file.slice(1)
  else if (file.startsWith('+')) file = file.slice(1)
  if (file.endsWith('@')) file = file.slice(0, -1).trimEnd()
  return file
}

function safeRelativePath(absPath: string, cwd: string): string {
  const relativePath = path.relative(cwd, absPath)
  const usable =
    relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath)
      ? relativePath
      : path.basename(absPath)
  const segments = toPosixPath(usable)
    .split('/')
    .filter(segment => segment && segment !== '.' && segment !== '..')
  return segments.length > 0 ? segments.join('/') : path.basename(absPath)
}

function tokenizeArgs(input: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let escaped = false

  const push = () => {
    if (current.length > 0) {
      tokens.push(current)
      current = ''
    }
  }

  for (const ch of input) {
    if (escaped) {
      current += ch
      escaped = false
      continue
    }
    if (ch === '\\' && quote !== "'") {
      escaped = true
      continue
    }
    if (quote) {
      if (ch === quote) quote = null
      else current += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (/\s/.test(ch)) {
      push()
      continue
    }
    current += ch
  }
  push()
  return tokens
}

function isTemplateSelector(value: string, config: TemplateConfig): boolean {
  return (
    Object.hasOwn(config.aliases, value) ||
    Object.values(config.aliases).includes(value) ||
    Object.hasOwn(OPTIONAL_TEMPLATE_ALIASES, value)
  )
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) return value
  return `'${value.replaceAll("'", "'\"'\"'")}'`
}

function toPosixPath(value: string): string {
  return value.replaceAll('\\', '/')
}

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer
}

function exitCode(result: CommandResult): number | null {
  return result.exitCode ?? null
}

function commandError(result: CommandResult): string | null {
  const maybeError = (result as { error?: unknown }).error
  return typeof maybeError === 'string' && maybeError ? maybeError : null
}

function formatReportTemplate(alias: string, template: string): string {
  return alias && alias !== template ? `${alias} -> ${template}` : template
}

function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`
}

function numberFromEnv(name: string, fallback: number): number {
  const value = process.env[name]
  return value ? parsePositiveInteger(value, name) : fallback
}

function parsePositiveInteger(value: string, label: string): number {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`)
  }
  return parsed
}

function requireValue(tokens: string[], index: number, flag: string): string {
  const value = tokens[index]
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`)
  }
  return value
}
