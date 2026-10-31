// What a missing internal file or an optional package resolves to, for the bundle (build.mjs) and for
// a test run straight from source (test/helpers/bun-source-shims.ts), so the two cannot drift apart.
export const SHIM_SOURCE = `
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
`
