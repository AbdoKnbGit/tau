/**
 * Tau Build Script
 *
 * Uses Bun's bundler to compile the CLI from TypeScript source into a
 * single distributable JS file that runs on Node.js >=20.
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { isAbsolute, join, resolve } from 'path';

const pkg = JSON.parse(readFileSync('./package.json', 'utf8'));

// Generate a master shim for all missing internal/ant assets
if (!existsSync('./dist')) {
  mkdirSync('./dist');
}
const shimPath = resolve(process.cwd(), 'dist/shim.js');
writeFileSync(shimPath, `
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
const proxy = new Proxy({}, { get: () => () => {} });
export default proxy;
`);

const result = await Bun.build({
  entrypoints: ['./src/entrypoints/cli.tsx'],
  outdir: './dist',
  target: 'node',
  format: 'esm',
  minify: false,
  sourcemap: 'linked',
  splitting: false,
  naming: 'cli.mjs',

  // Externalize all node_modules — they'll be resolved at runtime from
  // the npm install. Only bundle our own source.
  packages: 'external',

  define: {
    // Build-time MACRO constants
    'MACRO.VERSION': JSON.stringify(pkg.version),
    'MACRO.PACKAGE_URL': JSON.stringify(pkg.name),
    'MACRO.NATIVE_PACKAGE_URL': JSON.stringify(pkg.name),
    'MACRO.BUILD_TIME': JSON.stringify(new Date().toISOString()),
    'MACRO.FEEDBACK_CHANNEL': JSON.stringify('https://github.com/AbdoKnbGit/tau/issues'),
    'MACRO.ISSUES_EXPLAINER': JSON.stringify('report the issue at https://github.com/AbdoKnbGit/tau/issues'),
    'process.env.USER_TYPE': JSON.stringify('external'),
  },

  plugins: [
    {
      name: 'tau-build',
      setup(build) {
        // Shim bun:bundle — feature() returns false for all features
        // in external builds (removes ant-internal code paths)
        build.onResolve({ filter: /^bun:bundle$/ }, () => ({
          path: 'bun:bundle',
          namespace: 'bun-bundle-shim',
        }));
        build.onLoad(
          { filter: /.*/, namespace: 'bun-bundle-shim' },
          () => ({
            contents: `export function feature(_name) { return false; }`,
            loader: 'js',
          }),
        );

        // Load .md files as text (used by skills/bundled/verifyContent.ts etc.)
        build.onLoad({ filter: /\.md$/ }, (args) => {
          try {
            const contents = readFileSync(args.path, 'utf8');
            return { contents: `export default ${JSON.stringify(contents)};`, loader: 'js' };
          } catch {
            return { contents: `export default '';`, loader: 'js' };
          }
        });

        // Universal resolver to handle .js → .ts/tsx mapping AND shimming missing files
        build.onResolve({ filter: /.*/ }, (args) => {
          if (
            args.path.startsWith('node:') ||
            args.namespace === 'bun-bundle-shim'
          ) return;

          // Handle color-diff-napi shim first
          if (args.path === 'color-diff-napi') {
            return { path: resolve(process.cwd(), 'src/native-ts/color-diff/index.ts') };
          }

          // react/compiler-runtime is provided by React 19+ — let it resolve
          // from node_modules as an external package.
          if (args.path === 'react/compiler-runtime') {
            return;
          }

          let absPath: string;
          if (args.path.startsWith('src/')) {
            absPath = resolve(process.cwd(), args.path);
          } else if (args.path.startsWith('.') || isAbsolute(args.path)) {
            absPath = resolve(args.resolveDir, args.path);
          } else if (args.path.startsWith('@ant/') || args.path.startsWith('@anthropic-ai/sandbox')) {
            return { path: shimPath };
          } else {
            return; // Likely a node_module or external
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
          ];

          for (const p of possiblePaths) {
            try {
              if (existsSync(p) && !lstatSync(p).isDirectory()) {
                return { path: p };
              }
            } catch { /* ignore */ }
          }

          // If it's a missing file within OUR source or assets, shim it
          const root = process.cwd();
          if (absPath.startsWith(root) && !absPath.includes('node_modules')) {
            return { path: shimPath };
          }
        });
      },
    },
  ],
});

if (!result.success) {
  console.error('Build failed:');
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

// Prepend shebang so `tau` works as a direct executable
const outPath = './dist/cli.mjs';
const code = readFileSync(outPath, 'utf8');
if (!code.startsWith('#!')) {
  // Patch jsonc-parser ESM imports to use the UMD (CJS) build instead,
  // which doesn't have extensionless import issues in Node.js strict ESM.
  let patched = code;

  // Disable the config-reading guard — external builds don't need it
  patched = patched.replace(
    /!configReadingAllowed && true/g,
    'false'
  );

  // Disable remote version check — Tau has its own versioning
  patched = patched.replace(
    /async function assertMinVersion\(\)\s*\{/,
    'async function assertMinVersion() { return;'
  );

  // Fix jsonc-parser ESM extensionless import issue → use UMD build
  patched = patched.replace(
    /from\s+"jsonc-parser[^"]*"/g,
    'from "jsonc-parser/lib/umd/main.js"'
  );

  // Fix CJS/ESM interop: convert named imports from npm packages to
  // default import + destructure. Node.js strict ESM doesn't support
  // named exports from CJS modules.
  // e.g. import { foo } from "pkg" → import __pkg0 from "pkg"; const { foo } = __pkg0;
  const builtins = new Set([
    'crypto','fs','path','os','process','child_process','events','http',
    'https','net','stream','tty','url','util','buffer','async_hooks',
    'dns','readline','v8','zlib','assert','perf_hooks','worker_threads',
    'string_decoder','tls','module','cluster','dgram','domain','punycode',
    'querystring','timers','vm','wasi','inspector','diagnostics_channel',
    'trace_events','console',
  ]);
  let shimCounter = 0;

  // Handle combined default + named imports: import Foo, { bar } from "pkg"
  patched = patched.replace(
    /import\s+(\w+)\s*,\s*\{([^}]+)\}\s*from\s*"([^"]+)"/g,
    (_match: string, defName: string, names: string, mod: string) => {
      if (mod.startsWith('node:') || mod.startsWith('./') || mod.startsWith('../')) return _match;
      const pkgName = mod.startsWith('@') ? mod.split('/').slice(0,2).join('/') : mod.split('/')[0];
      if (builtins.has(pkgName)) return _match;
      const cjsPackages2 = new Set([
        'ajv','semver','shell-quote','qrcode','asciichart',
        'vscode-jsonrpc',
        'react','react-reconciler',
      ]);
      if (!cjsPackages2.has(pkgName)) return _match;
      const fixedNames = names.replace(/\bas\b/g, ':');
      return `import ${defName} from "${mod}"; const {${fixedNames}} = ${defName}`;
    }
  );

  // Handle pure named imports: import { bar } from "pkg"
  patched = patched.replace(
    /import\s*\{([^}]+)\}\s*from\s*"([^"]+)"/g,
    (_match: string, names: string, mod: string) => {
      // Skip node builtins and pure ESM packages (they work fine with named imports)
      if (mod.startsWith('node:') || mod.startsWith('./') || mod.startsWith('../')) return _match;
      const pkgName = mod.startsWith('@') ? mod.split('/').slice(0,2).join('/') : mod.split('/')[0];
      if (builtins.has(pkgName)) return _match;
      // Only fix CJS packages — pure ESM packages support named exports
      // CJS packages that lack proper dual ESM exports and need default-import shim.
      // Packages with "exports" conditional maps (import/require) are excluded
      // because Node resolves them to proper ESM when imported from ESM context.
      const cjsPackages = new Set([
        'ajv','semver','shell-quote','qrcode','asciichart',
        'vscode-jsonrpc',
        'react','react-reconciler',
      ]);
      if (!cjsPackages.has(pkgName)) return _match;
      // Convert to default import + destructure
      // Also convert `x as y` → `x: y` for destructuring syntax
      const varName = `__cjs${shimCounter++}`;
      const fixedNames = names.replace(/\bas\b/g, ':');
      return `import ${varName} from "${mod}"; const {${fixedNames}} = ${varName}`;
    }
  );

  // Polyfill React.useEffectEvent — available in React canary/internal builds
  // but not in stable React 19. Provides a stable function ref that always
  // calls the latest callback (used by React Compiler output).
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
`;

  writeFileSync(outPath, `#!/usr/bin/env node\n${useEffectEventPolyfill}${patched}`);
}

console.log(`✓ Built dist/cli.mjs (${(result.outputs[0]?.size / 1024 / 1024).toFixed(1)} MB)`);
