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
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { isAbsolute, join, resolve } from 'path'

const pkg = JSON.parse(readFileSync('./package.json', 'utf8'))
const bundledRuntimePackages = new Set(['e2b', 'google-auth-library'])
const optionalExternalPackages = new Set([
  '@anthropic-ai/bedrock-sdk',
  '@anthropic-ai/foundry-sdk',
  '@anthropic-ai/mcpb',
  '@anthropic-ai/vertex-sdk',
  '@aws-sdk/client-bedrock',
  '@aws-sdk/client-sts',
  '@azure/identity',
  '@computer-use/nut-js',
  '@opentelemetry/exporter-logs-otlp-grpc',
  '@opentelemetry/exporter-logs-otlp-http',
  '@opentelemetry/exporter-logs-otlp-proto',
  '@opentelemetry/exporter-metrics-otlp-grpc',
  '@opentelemetry/exporter-metrics-otlp-http',
  '@opentelemetry/exporter-metrics-otlp-proto',
  '@opentelemetry/exporter-prometheus',
  '@opentelemetry/exporter-trace-otlp-grpc',
  '@opentelemetry/exporter-trace-otlp-http',
  '@opentelemetry/exporter-trace-otlp-proto',
  'modifiers-napi',
  'node-pty',
  'yaml',
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
  static checkDependencies() { return { supported: false }; }
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
  outfile: './dist/cli.mjs',
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
    js: `import { createRequire as __createRequireForESM } from 'node:module';\nconst require = __createRequireForESM(import.meta.url);`,
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
})

if (result.errors?.length) {
  console.error('Build failed:')
  for (const err of result.errors) {
    console.error(err)
  }
  process.exit(1)
}

// ─── Post-process bundle ───────────────────────────────────────────

const outPath = './dist/cli.mjs'
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

// Report size
const outStat = readFileSync(outPath)
console.log(`✓ Built dist/cli.mjs (${(outStat.length / 1024 / 1024).toFixed(1)} MB)`)

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
