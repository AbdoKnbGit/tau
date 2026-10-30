#!/usr/bin/env node
/**
 * Tau Build Script (Node + esbuild)
 *
 * Bundles the CLI from TypeScript source into a single distributable JS
 * file that runs on Node.js >=20. Mirrors the original Bun-based build
 * but uses esbuild so contributors can build from source with only Node
 * installed (Bun is not required).
 */

import { build } from 'esbuild'
import { spawnSync } from 'child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { isBuiltin } from 'module'
import { isAbsolute, join, resolve } from 'path'

const pkg = JSON.parse(readFileSync('./package.json', 'utf8'))
const bundledRuntimePackages = new Set(['e2b', 'google-auth-library'])
const optionalExternalPackages = new Set([
  '@azure/identity',
  '@computer-use/nut-js',
  'modifiers-napi',
  'node-pty',
])
// Imports esbuild leaves unresolved because they sit in a try block: the code
// around each one copes with the package being absent. Anything else missing at
// runtime is the bug the audit below stops, so add to this list only with such a guard.
const toleratedMissingImports = new Set([
  'bun:ffi', // upstreamproxy: Bun only
  'cacache', // cleanup: clearing npm's cache is best effort
  'encoding', // node-fetch: optional charset conversion
  'image-processor-napi', // falls back to sharp
  'source-map-support', // typescript: optional stack mapping
  'url-handler-napi', // deep links: macOS app bundle only
])
const runtimeDependencies = Object.keys(pkg.dependencies ?? {})
const externalRuntimePackages = [
  ...runtimeDependencies.filter(name => !bundledRuntimePackages.has(name)),
  ...optionalExternalPackages,
]
const externalRuntimePatterns = externalRuntimePackages.flatMap(name => [
  name,
  `${name}/*`,
])

// ─── Shim for missing internal/ant assets ──────────────────────────

if (!existsSync('./dist')) {
  mkdirSync('./dist')
}
const shimPath = resolve(process.cwd(), 'dist/shim.js')
writeFileSync(
  shimPath,
  `
export const checkProtectedNamespace = () => false;
export const checkProtectedCluster = () => false;
export const checkManagedSettingsSecurity = () => {};
export const handleSecurityCheckResult = () => {};
export const TungstenTool = null;
export const SuggestBackgroundPRTool = null;
export const VerifyPlanExecutionTool = null;
export const isConnectorTextBlock = () => false;
export const AgentTool = null;
export const initBundledWorkflows = () => {};
export const WorkflowTool = null;
export const run = () => {};
export const DESCRIPTION = '';
export const PROMPT = '';
export const getToolUseSummary = () => '';
export const renderToolUseMessage = () => null;
export const renderToolUseRejectedMessage = () => null;
export const renderToolUseErrorMessage = () => null;
export const renderToolResultMessage = () => null;
export const createClaudeForChromeMcpServer = () => {};
export const BROWSER_TOOLS = [];
export const COMPUTER_USE_TOOLS = [];
export const DEFAULT_UPLOAD_CONCURRENCY = 1;
export const FILE_COUNT_LIMIT = 100;
export const OUTPUTS_SUBDIR = 'outputs';
export const buildComputerUseTools = () => [];
export const isCoordinatorMode = () => false;
export class SandboxManager {
  constructor() {}
  start() {}
  stop() {}
  isEnabled() { return false; }
  getViolations() { return []; }
  static isSupportedPlatform() { return false; }
  static checkDependencies() { return { supported: false, errors: ['Sandbox runtime is unavailable in this build'], warnings: [] }; }
  static wrapWithSandbox(command) { return command; }
  static async initialize() {}
  static updateConfig() {}
  static reset() {}
  static getFsReadConfig() { return {}; }
  static getFsWriteConfig() { return {}; }
  static getNetworkRestrictionConfig() { return {}; }
  static getIgnoreViolations() { return false; }
  static getAllowUnixSockets() { return true; }
  static getAllowLocalBinding() { return true; }
  static getEnableWeakerNestedSandbox() { return false; }
  static getProxyPort() { return 0; }
  static getSocksProxyPort() { return 0; }
  static getLinuxHttpSocketPath() { return ''; }
  static getLinuxSocksSocketPath() { return ''; }
  static async waitForNetworkInitialization() {}
  static getSandboxViolationStore() { return new SandboxViolationStore(); }
  static annotateStderrWithSandboxFailures(stderr) { return stderr; }
  static cleanupAfterCommand() {}
}
export class SandboxViolationStore { constructor() {} getViolations() { return []; } clear() {} }
export const SandboxRuntimeConfigSchema = { parse: (v) => v, safeParse: (v) => ({ success: true, data: v }) };
export const runChromeNativeHost = () => {};
export const runComputerUseMcpServer = () => {};
export const runDaemonWorker = () => {};
export const daemonMain = () => {};
export const templatesMain = () => {};
export const environmentRunnerMain = () => {};
export const selfHostedRunnerMain = () => {};
// Additional exports imported by stripped-out features. esbuild requires
// named exports be statically present; Bun's bundler was more forgiving.
export const WORKFLOW_TOOL_NAME = '';
export const API_RESIZE_PARAMS = {};
export const targetImageSize = () => ({ width: 0, height: 0 });
export const getSentinelCategory = () => null;
export const DEFAULT_GRANT_FLAGS = {};
export const bindSessionContext = (fn) => fn;
export const createComputerUseMcpServer = () => null;
const proxy = new Proxy({}, { get: () => () => {} });
export default proxy;
`,
)

// ─── esbuild bundle ────────────────────────────────────────────────

const tauPlugin = {
  name: 'tau-build',
  setup(build) {
    // Shim bun:bundle — feature() returns false for all features in external
    // builds (removes ant-internal code paths). Self-learning is interactive
    // (the /learned command + an end-of-task offer baked into the memory
    // guidance), so it does NOT use the EXTRACT_MEMORIES background fork.
    build.onResolve({ filter: /^bun:bundle$/ }, () => ({
      path: 'bun:bundle',
      namespace: 'bun-bundle-shim',
    }))
    build.onLoad({ filter: /.*/, namespace: 'bun-bundle-shim' }, () => ({
      contents: `export function feature(_name) { return false; }`,
      loader: 'js',
    }))

    // Load .md files as text (used by skills/bundled/verifyContent.ts etc.)
    build.onLoad({ filter: /\.md$/ }, args => {
      try {
        const contents = readFileSync(args.path, 'utf8')
        return {
          contents: `export default ${JSON.stringify(contents)};`,
          loader: 'js',
        }
      } catch {
        return { contents: `export default '';`, loader: 'js' }
      }
    })

    // Universal resolver to handle .js → .ts/tsx mapping AND shimming missing files.
    build.onResolve({ filter: /.*/ }, args => {
      if (
        args.path.startsWith('node:') ||
        args.namespace === 'bun-bundle-shim'
      ) {
        return
      }

      // Handle color-diff-napi shim first
      if (args.path === 'color-diff-napi') {
        return { path: resolve(process.cwd(), 'src/native-ts/color-diff/index.ts') }
      }

      // react/compiler-runtime is provided by React 19+ — let it resolve
      // from node_modules as an external package.
      if (args.path === 'react/compiler-runtime') {
        return
      }

      let absPath
      if (args.path.startsWith('src/')) {
        absPath = resolve(process.cwd(), args.path)
      } else if (args.path.startsWith('.') || isAbsolute(args.path)) {
        absPath = resolve(args.resolveDir, args.path)
      } else if (
        args.path.startsWith('@ant/') ||
        args.path.startsWith('@anthropic-ai/sandbox')
      ) {
        return { path: shimPath }
      } else {
        return // Likely a node_module or external
      }

      const possiblePaths = [
        absPath,
        absPath.replace(/\.js$/, '.ts'),
        absPath.replace(/\.js$/, '.tsx'),
        absPath.replace(/\.js$/, '.d.ts'),
        absPath.replace(/\.mjs$/, '.ts'),
        absPath.replace(/\.mjs$/, '.tsx'),
        absPath + '.ts',
        absPath + '.tsx',
        join(absPath, 'index.ts'),
        join(absPath, 'index.tsx'),
        join(absPath, 'index.js'),
      ]

      for (const p of possiblePaths) {
        try {
          if (existsSync(p) && !lstatSync(p).isDirectory()) {
            return { path: p }
          }
        } catch {
          /* ignore */
        }
      }

      // If it's a missing file within OUR source or assets, shim it.
      const root = process.cwd()
      if (absPath.startsWith(root) && !absPath.includes('node_modules')) {
        return { path: shimPath }
      }
    })
  },
}

const result = await build({
  entryPoints: ['./src/entrypoints/cli.tsx'],
  outfile: './dist/tau.mjs',
  platform: 'node',
  format: 'esm',
  bundle: true,
  minify: false,
  sourcemap: 'linked',
  splitting: false,
  target: 'node20',
  // Externalize declared runtime deps. Bundle selected JS-only integrations
  // whose upstream dependency ranges still pull deprecated packages on install.
  external: externalRuntimePatterns,
  jsx: 'automatic',
  jsxImportSource: 'react',
  loader: {
    '.ts': 'ts',
    '.tsx': 'tsx',
  },
  // ESM output doesn't have `require` in scope, so esbuild replaces any
  // `require(x)` calls in source with a throwing stub. Inject a real
  // `require` built from `createRequire(import.meta.url)` at the top of
  // the bundle so all the lazy-loaded modules (semver, PowerShellTool,
  // etc.) work at runtime.
  banner: {
    js: `import { createRequire as __createRequireForESM } from 'node:module';
import { fileURLToPath as __fileURLToPathForESM } from 'node:url';
import { dirname as __dirnameForESM } from 'node:path';
const require = __createRequireForESM(import.meta.url);
const __filename = __fileURLToPathForESM(import.meta.url);
const __dirname = __dirnameForESM(__filename);`,
  },
  define: {
    // Build-time MACRO constants
    'MACRO.VERSION': JSON.stringify(pkg.version),
    'MACRO.PACKAGE_URL': JSON.stringify(pkg.name),
    'MACRO.NATIVE_PACKAGE_URL': JSON.stringify(pkg.name),
    'MACRO.BUILD_TIME': JSON.stringify(new Date().toISOString()),
    'MACRO.FEEDBACK_CHANNEL': JSON.stringify(
      'https://github.com/AbdoKnbGit/tau/issues',
    ),
    'MACRO.ISSUES_EXPLAINER': JSON.stringify(
      'report the issue at https://github.com/AbdoKnbGit/tau/issues',
    ),
    'process.env.USER_TYPE': JSON.stringify('external'),
  },
  plugins: [tauPlugin],
  logLevel: 'warning',
  metafile: true,
})

if (result.errors?.length) {
  console.error('Build failed:')
  for (const err of result.errors) {
    console.error(err)
  }
  process.exit(1)
}

// ─── Runtime import audit ──────────────────────────────────────────
//
// A package that is imported lazily, left out of the bundle and not installed
// only fails when a user reaches that feature. Declare it in dependencies, or
// in devDependencies to bundle it, instead of letting it ship broken.

const availableAtRuntime = new Set([
  ...externalRuntimePackages,
  ...Object.keys(pkg.optionalDependencies ?? {}),
  ...Object.keys(pkg.peerDependencies ?? {}),
  ...toleratedMissingImports,
])
const missingAtRuntime = new Map()
for (const [file, input] of Object.entries(result.metafile.inputs)) {
  for (const { path, external } of input.imports) {
    // Relative and src/ paths here are type-only imports esbuild dropped.
    if (!external || /^(\.|src\/|<)/.test(path) || isBuiltin(path)) continue
    const name = path.split('/').slice(0, path.startsWith('@') ? 2 : 1).join('/')
    if (!availableAtRuntime.has(name)) missingAtRuntime.set(name, file)
  }
}
if (missingAtRuntime.size > 0) {
  console.error('Build failed: these imports would not exist at runtime:')
  for (const [name, file] of missingAtRuntime) {
    console.error(`  ${name} (imported by ${file})`)
  }
  process.exit(1)
}

// ─── Post-process bundle ───────────────────────────────────────────

const outPath = './dist/tau.mjs'
const code = readFileSync(outPath, 'utf8')
if (!code.startsWith('#!')) {
  let patched = code

  // Disable the config-reading guard — external builds don't need it.
  // Bun's output had `!configReadingAllowed && true`; esbuild's output
  // is `!configReadingAllowed && process.env.NODE_ENV !== "test"`. Match
  // the `!configReadingAllowed &&` prefix regardless of what follows so
  // the `&& …` chain short-circuits to false either way.
  patched = patched.replace(/!configReadingAllowed\s*&&\s*/g, 'false && ')

  // Disable remote version check — Tau has its own versioning
  patched = patched.replace(
    /async function assertMinVersion\(\)\s*\{/,
    'async function assertMinVersion() { return;',
  )

  // Fix jsonc-parser ESM extensionless import issue → use UMD build
  patched = patched.replace(
    /from\s+"jsonc-parser[^"]*"/g,
    'from "jsonc-parser/lib/umd/main.js"',
  )

  // Fix CJS/ESM interop: convert named imports from CJS npm packages to
  // default import + destructure. Node.js strict ESM doesn't support
  // named exports from CJS modules.
  const builtins = new Set([
    'crypto','fs','path','os','process','child_process','events','http',
    'https','net','stream','tty','url','util','buffer','async_hooks',
    'dns','readline','v8','zlib','assert','perf_hooks','worker_threads',
    'string_decoder','tls','module','cluster','dgram','domain','punycode',
    'querystring','timers','vm','wasi','inspector','diagnostics_channel',
    'trace_events','console',
  ])
  let shimCounter = 0
  const cjsPackages = new Set([
    'ajv','semver','shell-quote','qrcode','asciichart',
    'vscode-jsonrpc',
    'react','react-reconciler',
  ])

  // Handle combined default + named imports: import Foo, { bar } from "pkg"
  patched = patched.replace(
    /import\s+(\w+)\s*,\s*\{([^}]+)\}\s*from\s*"([^"]+)"/g,
    (_match, defName, names, mod) => {
      if (
        mod.startsWith('node:') ||
        mod.startsWith('./') ||
        mod.startsWith('../')
      )
        return _match
      const pkgName = mod.startsWith('@')
        ? mod.split('/').slice(0, 2).join('/')
        : mod.split('/')[0]
      if (builtins.has(pkgName)) return _match
      if (!cjsPackages.has(pkgName)) return _match
      const fixedNames = names.replace(/\bas\b/g, ':')
      return `import ${defName} from "${mod}"; const {${fixedNames}} = ${defName}`
    },
  )

  // Handle pure named imports: import { bar } from "pkg"
  patched = patched.replace(
    /import\s*\{([^}]+)\}\s*from\s*"([^"]+)"/g,
    (_match, names, mod) => {
      if (
        mod.startsWith('node:') ||
        mod.startsWith('./') ||
        mod.startsWith('../')
      )
        return _match
      const pkgName = mod.startsWith('@')
        ? mod.split('/').slice(0, 2).join('/')
        : mod.split('/')[0]
      if (builtins.has(pkgName)) return _match
      if (!cjsPackages.has(pkgName)) return _match
      const varName = `__cjs${shimCounter++}`
      const fixedNames = names.replace(/\bas\b/g, ':')
      return `import ${varName} from "${mod}"; const {${fixedNames}} = ${varName}`
    },
  )

  // Polyfill React.useEffectEvent — available in React canary/internal
  // builds but not in stable React 19. Provides a stable function ref
  // that always calls the latest callback (used by React Compiler output).
  const useEffectEventPolyfill = `
import React from "react";
if (!React.useEffectEvent) {
  React.useEffectEvent = function useEffectEvent(fn) {
    const ref = React.useRef(fn);
    ref.current = fn;
    return React.useCallback(function () {
      return ref.current.apply(void 0, arguments);
    }, []);
  };
}
`

  writeFileSync(outPath, `#!/usr/bin/env node\n${useEffectEventPolyfill}${patched}`)
}

// ─── Launcher (bin entry) ──────────────────────────────────────────
//
// `tau` / `claudex` point at dist/cli.mjs, which is now a tiny
// dependency-free launcher: it verifies both runtime dependencies and the
// postinstall completion marker (npm 12 can block scripts while still exiting
// successfully), self-heals via scripts/verify-deps.mjs, then loads the real
// bundle (dist/tau.mjs).

const launcher = `#!/usr/bin/env node
// Tau launcher - verifies dependency and lifecycle integrity, repairs
// incomplete installs, then starts the CLI. Set TAU_SKIP_PREFLIGHT=1 to bypass.
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { findCompatibleNodeRuntime, getNodeRuntimeIssue, nodeEndOfLifeMessage, nodeRuntimeMessage } from '../scripts/node-runtime.mjs'

// The dependency tree needs require(esm) (e.g. e2b's CommonJS build requires
// the ESM-only chalk 5): Node 20.19+, 22.12+, or 23+. Fail with a clear
// message instead of a raw ERR_REQUIRE_ESM crash from deep inside a dependency.
const runtimeIssue = getNodeRuntimeIssue(process.versions.node)
let useCurrentRuntime = !runtimeIssue
if (runtimeIssue) {
  const compatibleNode = findCompatibleNodeRuntime()
  if (compatibleNode) {
    const result = await new Promise(resolve => {
      const child = spawn(compatibleNode, [
        ...process.execArgv, fileURLToPath(import.meta.url), ...process.argv.slice(2),
      ], { cwd: process.cwd(), env: process.env, stdio: 'inherit', windowsHide: true })
      const signals = new Map()
      for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
        const forward = () => {
          // Windows console interrupts already reach the inherited child.
          if (process.platform === 'win32' && signal === 'SIGINT') return
          try { child.kill(signal) } catch {}
        }
        signals.set(signal, forward)
        process.on(signal, forward)
      }
      const finish = result => {
        for (const [signal, forward] of signals) process.off(signal, forward)
        resolve(result)
      }
      child.once('error', error => finish({ error, status: 1 }))
      child.once('close', (status, signal) => finish({ status, signal }))
    })
    if (result.error) {
      if (runtimeIssue === 'windows-shutdown') useCurrentRuntime = true
      else {
        process.stderr.write('[tau] Could not start a compatible Node.js runtime: ' + result.error.message + '\\n')
        process.exitCode = 1
      }
    } else if (result.signal && process.platform !== 'win32') {
      // Restore the child's signal termination after removing forwarding
      // listeners, so callers can distinguish an interrupt from an error.
      process.kill(process.pid, result.signal)
    } else process.exitCode = result.status ?? 1
  } else {
    if (runtimeIssue === 'windows-shutdown') useCurrentRuntime = true
    else {
      process.stderr.write(nodeRuntimeMessage(process.version, runtimeIssue))
      process.exitCode = 1
    }
  }
}

async function loadAgent() {
const distDir = dirname(fileURLToPath(import.meta.url))
const packageRoot = dirname(distDir)
// Preserve the canonical package location even when npm's POSIX bin symlink
// leaves process.argv[1] pointing at <prefix>/bin/tau.
globalThis.__TAU_PACKAGE_ROOT__ = packageRoot
const isSourceCheckout = existsSync(join(packageRoot, 'src'))
const agentBundlePath = join(distDir, 'tau.mjs')
const integrityLoadErrorCodes = new Set([
  'MODULE_NOT_FOUND',
  'ERR_MODULE_NOT_FOUND',
  'ERR_DLOPEN_FAILED',
  'ERR_PACKAGE_PATH_NOT_EXPORTED',
  'ERR_PACKAGE_IMPORT_NOT_DEFINED',
])

function isIntegrityLoadFailure(error) {
  const seen = new Set()
  let current = error
  while (current && typeof current === 'object' && !seen.has(current)) {
    if (integrityLoadErrorCodes.has(current.code)) return true
    seen.add(current)
    current = current.cause
  }
  return false
}

function stopForIntegrityFailure(reason, verifier) {
  process.stderr.write('[tau] Installation integrity check failed: ' + reason + '.\\n')
  if (isSourceCheckout) {
    process.stderr.write('Rebuild this source checkout with:\\n\\n  npm run build\\n')
  } else if (verifier?.manualFixInstructions) {
    process.stderr.write('\\n' + verifier.manualFixInstructions(${JSON.stringify(pkg.name)}) + '\\n')
  } else {
    process.stderr.write(
      'Retry the installation with:\\n\\n' +
      '  npx -y @abdoknbgit/tau-installer@latest\\n'
    )
  }
  process.exit(1)
}

// This file cannot be repaired after startup has entered the agent bundle.
// Check it even when the optional dependency preflight was explicitly skipped.
if (!existsSync(agentBundlePath)) {
  stopForIntegrityFailure('the agent bundle is missing')
}

if (process.env.TAU_SKIP_PREFLIGHT !== '1') {
  let verifier
  try {
    const verifierPath = join(packageRoot, 'scripts', 'verify-deps.mjs')
    if (!existsSync(verifierPath)) {
      // Published packages always contain this dependency-free verifier.
      // A source checkout may intentionally run a hand-built bundle without it.
      if (!isSourceCheckout) {
        stopForIntegrityFailure('the installation verifier is missing')
      }
    } else {
      verifier = await import(pathToFileURL(verifierPath).href)
      // Package directories alone are not proof that npm ran lifecycle
      // scripts: npm 12 can block them and still finish the reification. The
      // marker is written only at the end of Tau's successful postinstall.
      // Source checkouts intentionally have no generated marker.
      const lifecycleComplete = isSourceCheckout ||
        verifier.getLifecycleMarkerStatus(packageRoot).ok
      // Fast silent check first (<10ms); only show output when broken.
      if (verifier.findMissingDeps(packageRoot).length > 0 || !lifecycleComplete) {
        process.stderr.write('[tau] Incomplete installation detected - repairing...\\n')
        const ok = verifier.ensureDeps(packageRoot, { repair: true })
        if (!ok) {
          process.stderr.write('\\n' + verifier.manualFixInstructions(${JSON.stringify(pkg.name)}) + '\\n')
          process.exit(1)
        }
      }
    }
  } catch (error) {
    // An integrity-check exception is itself an unverified installation.
    // Fail closed instead of importing the bundle and surfacing a later raw
    // module/native crash from the incomplete tree.
    stopForIntegrityFailure('the integrity verifier could not run', verifier)
  }
}

try {
  await import(pathToFileURL(agentBundlePath).href)
} catch (error) {
  // Only installation-shaped load failures belong to the recovery bridge.
  // Unrelated agent initialization/programming errors retain their original
  // stack and behavior instead of being mislabeled as package corruption.
  if (isIntegrityLoadFailure(error)) {
    stopForIntegrityFailure('the agent bundle could not load a required module')
  }
  throw error
}
}
if (useCurrentRuntime) {
  // On stderr, because stdout belongs to print mode and MCP. NODE_NO_WARNINGS is
  // Node's own off switch.
  const warning = runtimeIssue
    ? nodeRuntimeMessage(process.version, runtimeIssue)
    : nodeEndOfLifeMessage(process.version)
  if (warning && process.env.NODE_NO_WARNINGS !== '1' && typeof Bun === 'undefined') {
    process.stderr.write(warning)
  }
  await loadAgent()
}
`
// Keep startup recovery self-contained even if an interrupted installation
// omitted the scripts directory. Only Node built-ins remain external.
await build({
  stdin: { contents: launcher, resolveDir: resolve('dist'), sourcefile: 'tau-launcher-entry.mjs', loader: 'js' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20.19',
  charset: 'utf8',
  outfile: './dist/cli.mjs',
})
// Stale artifact from builds that bundled directly to cli.mjs.
try { rmSync('./dist/cli.mjs.map', { force: true }) } catch { /* ignore */ }

// Report size
const outStat = readFileSync(outPath)
console.log(`✓ Built dist/tau.mjs (${(outStat.length / 1024 / 1024).toFixed(1)} MB) + dist/cli.mjs launcher`)

const nativeShellParserBuild = spawnSync(
  process.execPath,
  ['scripts/build-native-shell-parser.mjs'],
  {
    stdio: 'inherit',
    windowsHide: true,
  },
)
if (nativeShellParserBuild.status !== 0) {
  process.exit(nativeShellParserBuild.status ?? 1)
}

const nativeToolsBuild = spawnSync(
  process.execPath,
  ['scripts/build-native-tools.mjs'],
  {
    stdio: 'inherit',
    windowsHide: true,
  },
)
if (nativeToolsBuild.status !== 0) {
  process.exit(nativeToolsBuild.status ?? 1)
}
