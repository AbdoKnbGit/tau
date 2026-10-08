import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmdirSync,
  closeSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, posix, resolve, win32 } from "node:path";

export const TAU_PACKAGE = "@abdoknbgit/tau";

export const ALLOWED_SCRIPTS = Object.freeze([
  "@abdoknbgit/tau",
  "@whiskeysockets/baileys",
  "core-js",
  "fsevents",
  "node-pty",
  "protobufjs",
  "sharp",
]);

export const MINIMUM_ALLOW_SCRIPTS_NPM_VERSION = "11.16.0";

const BIN_NAMES = Object.freeze(["tau", "claudex"]);
const WINDOWS_BIN_EXTENSIONS = Object.freeze(["", ".cmd", ".ps1"]);
const TERMINATION_GRACE_MS = 5_000;
const UPDATE_LOCK_STALE_MS = 15 * 60 * 1000;
const UPDATE_LOCK_HEARTBEAT_MS = 60 * 1000;
const LOCK_OWNER_PATTERN = /^owner-[0-9a-f-]{36}\.lease$/i;
export const INSTALLER_LOCK_CONTENDED_EXIT_CODE = 75;

const EXACT_SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function isExactVersion(value) {
  const match = EXACT_SEMVER_PATTERN.exec(value);
  if (!match) return false;

  const prerelease = match[4];
  if (!prerelease) return true;

  return prerelease
    .split(".")
    .every((identifier) => !/^\d+$/.test(identifier) || identifier === "0" || !identifier.startsWith("0"));
}

export function parseArguments(argv) {
  let tauVersion;
  let dryRun = false;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--help" || argument === "-h") {
      help = true;
      continue;
    }

    if (argument === "--dry-run") {
      dryRun = true;
      continue;
    }

    if (argument === "--tau-version") {
      if (tauVersion !== undefined) {
        throw new Error("--tau-version may only be provided once.");
      }

      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--tau-version requires an exact version, for example 0.92.15.");
      }

      tauVersion = value;
      index += 1;
      continue;
    }

    if (argument.startsWith("--tau-version=")) {
      if (tauVersion !== undefined) {
        throw new Error("--tau-version may only be provided once.");
      }

      tauVersion = argument.slice("--tau-version=".length);
      continue;
    }

    throw new Error(`Unknown argument: ${argument}`);
  }

  if (tauVersion !== undefined && !isExactVersion(tauVersion)) {
    throw new Error(
      `Invalid Tau version "${tauVersion}". Pass an exact semantic version such as 0.92.15 or 0.93.0-rc.1.`,
    );
  }

  return { tauVersion, dryRun, help };
}

export function npmSupportsAllowScripts(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/.exec(version);
  if (!match) return false;

  const actual = match.slice(1, 4).map(Number);
  const minimum = MINIMUM_ALLOW_SCRIPTS_NPM_VERSION.split(".").map(Number);

  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index] > minimum[index]) return true;
    if (actual[index] < minimum[index]) return false;
  }

  return true;
}

export function buildInstallArguments(tauVersion, npmVersion) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(npmVersion ?? "")) {
    throw new Error("A detected npm version is required to build the install command.");
  }

  const target = `${TAU_PACKAGE}@${tauVersion ?? "latest"}`;
  const args = [
    "install",
    "--global",
    target,
    "--ignore-scripts=false",
    "--dry-run=false",
    "--package-lock-only=false",
    "--bin-links=true",
    "--include=optional",
  ];

  if (npmSupportsAllowScripts(npmVersion)) {
    args.push("--dangerously-allow-all-scripts=false");
    args.push("--strict-allow-scripts=true");
    args.push(`--allow-scripts=${ALLOWED_SCRIPTS.join(",")}`);
  }

  args.push("--no-audit", "--no-fund");
  return args;
}

export function createInstallerEnvironment(env = process.env) {
  const childEnv = { ...env };
  const overriddenConfigs = new Set([
    "npm_config_allow_scripts",
    "npm_config_ignore_scripts",
    "npm_config_dangerously_allow_all_scripts",
    "npm_config_strict_allow_scripts",
    "npm_config_dry_run",
    "npm_config_global",
    "npm_config_location",
    "npm_config_package_lock_only",
    "npm_config_omit",
    "npm_config_include",
    "npm_config_optional",
    "npm_config_production",
    "npm_config_bin_links",
  ]);

  for (const key of Object.keys(childEnv)) {
    if (overriddenConfigs.has(key.toLowerCase().replaceAll("-", "_"))) {
      delete childEnv[key];
    }
  }

  if (!("SHARP_IGNORE_GLOBAL_LIBVIPS" in childEnv)) {
    childEnv.SHARP_IGNORE_GLOBAL_LIBVIPS = "1";
  }

  return childEnv;
}

function errnoCode(error) {
  return error && typeof error === "object" && typeof error.code === "string"
    ? error.code
    : undefined;
}

function isMissing(error) {
  return errnoCode(error) === "ENOENT";
}

function isContended(error) {
  return ["EEXIST", "ENOTEMPTY", "EACCES", "EPERM"].includes(errnoCode(error));
}

function sameFile(left, right) {
  if (left.dev !== 0 || left.ino !== 0 || right.dev !== 0 || right.ino !== 0) {
    return left.dev === right.dev && left.ino === right.ino;
  }
  return (
    left.birthtimeMs === right.birthtimeMs &&
    left.mtimeMs === right.mtimeMs &&
    left.size === right.size &&
    left.mode === right.mode
  );
}

function defaultProcessIsAlive(pid, processKillImpl = process.kill) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    processKillImpl(pid, 0);
    return true;
  } catch (error) {
    if (errnoCode(error) === "ESRCH") return false;
    // EPERM proves the process exists. Unknown probe errors fail closed too.
    return true;
  }
}

function readOwnerPid(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return Number.isSafeInteger(parsed?.pid) && parsed.pid > 0 ? parsed.pid : null;
  } catch (error) {
    if (isMissing(error) || error instanceof SyntaxError) return null;
    throw error;
  }
}

function readLegacyOwnerPid(path) {
  try {
    const value = readFileSync(path, "utf8").trim();
    if (!/^\d+$/.test(value)) return null;
    const pid = Number(value);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

function removeEmptyDirectory(path) {
  try {
    rmdirSync(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return true;
    if (isContended(error)) return false;
    throw error;
  }
}

function tryCreateLease(lockPath, { now, pid, randomUUIDImpl }) {
  const token = randomUUIDImpl();
  const leasePath = join(lockPath, `owner-${token}.lease`);
  const createDirectory = () => {
    try {
      mkdirSync(lockPath);
      return true;
    } catch (error) {
      if (errnoCode(error) === "EEXIST") return false;
      throw error;
    }
  };

  let created;
  try {
    created = createDirectory();
  } catch (error) {
    if (!isMissing(error)) throw error;
    mkdirSync(dirname(lockPath), { recursive: true });
    created = createDirectory();
  }
  if (!created) return null;

  try {
    writeFileSync(
      leasePath,
      JSON.stringify({ token, pid, acquiredAt: now() }),
      { encoding: "utf8", flag: "wx" },
    );
    return { lockPath, token, pid, leasePath, borrowed: false };
  } catch (error) {
    try {
      rmdirSync(lockPath);
    } catch {
      // A replacement owner makes the directory non-empty and preserves it.
    }
    if (isMissing(error) || isContended(error)) return null;
    throw error;
  }
}

function recoverLeaseDirectory(
  lockPath,
  observedDirectory,
  { now, staleMs, isProcessAliveImpl },
) {
  let entries;
  try {
    entries = readdirSync(lockPath, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return true;
    throw error;
  }

  if (entries.length === 0) {
    let recheck;
    try {
      recheck = lstatSync(lockPath);
    } catch (error) {
      if (isMissing(error)) return true;
      throw error;
    }
    if (
      !recheck.isDirectory() ||
      !sameFile(observedDirectory, recheck) ||
      now() - recheck.mtimeMs < staleMs
    ) {
      return false;
    }
    return removeEmptyDirectory(lockPath);
  }

  const staleOwners = [];
  for (const entry of entries) {
    if (!entry.isFile() || !LOCK_OWNER_PATTERN.test(entry.name)) return false;
    const path = join(lockPath, entry.name);
    let stats;
    try {
      stats = lstatSync(path);
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    if (!stats.isFile() || now() - stats.mtimeMs < staleMs) return false;
    const ownerPid = readOwnerPid(path);
    if (ownerPid && isProcessAliveImpl(ownerPid)) return false;
    staleOwners.push({ path, stats });
  }

  for (const stale of staleOwners) {
    let recheck;
    try {
      recheck = lstatSync(stale.path);
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    if (
      !recheck.isFile() ||
      !sameFile(stale.stats, recheck) ||
      now() - recheck.mtimeMs < staleMs
    ) {
      return false;
    }
    const ownerPid = readOwnerPid(stale.path);
    if (ownerPid && isProcessAliveImpl(ownerPid)) return false;
    try {
      unlinkSync(stale.path);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  return removeEmptyDirectory(lockPath);
}

function restoreQuarantinedLegacyLock(quarantine, lockPath) {
  try {
    linkSync(quarantine, lockPath);
    unlinkSync(quarantine);
  } catch {
    // Preserve an identity that could not be restored or verified.
  }
}

function recoverLegacyLock(
  lockPath,
  observed,
  { now, staleMs, isProcessAliveImpl, randomUUIDImpl },
) {
  if (now() - observed.mtimeMs < staleMs) return false;
  const ownerPid = readLegacyOwnerPid(lockPath);
  if (ownerPid && isProcessAliveImpl(ownerPid)) return false;

  const quarantine = `${lockPath}.legacy-stale-${randomUUIDImpl()}`;
  let handle;
  try {
    handle = openSync(lockPath, "r");
    const opened = fstatSync(handle);
    const recheck = lstatSync(lockPath);
    if (
      !recheck.isFile() ||
      !sameFile(observed, opened) ||
      !sameFile(opened, recheck) ||
      now() - recheck.mtimeMs < staleMs
    ) {
      return false;
    }
    const recheckedPid = readLegacyOwnerPid(lockPath);
    if (recheckedPid && isProcessAliveImpl(recheckedPid)) return false;

    renameSync(lockPath, quarantine);
    const moved = lstatSync(quarantine);
    if (!moved.isFile() || !sameFile(opened, moved)) {
      restoreQuarantinedLegacyLock(quarantine, lockPath);
      return false;
    }
  } catch (error) {
    if (isMissing(error)) return true;
    throw error;
  } finally {
    if (handle !== undefined) closeSync(handle);
  }

  unlinkSync(quarantine);
  return true;
}

function acquireDirectoryLease(lockPath, options) {
  const fresh = tryCreateLease(lockPath, options);
  if (fresh) return fresh;

  let observed;
  try {
    observed = lstatSync(lockPath);
  } catch (error) {
    if (isMissing(error)) return tryCreateLease(lockPath, options);
    throw error;
  }
  if (!observed.isDirectory()) return null;
  return recoverLeaseDirectory(lockPath, observed, options)
    ? tryCreateLease(lockPath, options)
    : null;
}

function acquireMainLease(lockPath, options) {
  const fresh = tryCreateLease(lockPath, options);
  if (fresh) return fresh;

  let observed;
  try {
    observed = lstatSync(lockPath);
  } catch (error) {
    if (isMissing(error)) return tryCreateLease(lockPath, options);
    throw error;
  }
  const recovered = observed.isDirectory()
    ? recoverLeaseDirectory(lockPath, observed, options)
    : observed.isFile()
      ? recoverLegacyLock(lockPath, observed, options)
      : false;
  return recovered ? tryCreateLease(lockPath, options) : null;
}

function readBorrowedLease(env, platform, isProcessAliveImpl) {
  const path = env.TAU_UPDATE_LOCK_PATH;
  const token = env.TAU_UPDATE_LOCK_TOKEN;
  const pidText = env.TAU_UPDATE_LOCK_PID;
  const supplied = [path, token, pidText].filter((value) => value !== undefined).length;
  if (supplied === 0) return { status: "none" };
  if (supplied !== 3 || !LOCK_OWNER_PATTERN.test(`owner-${token}.lease`)) {
    return { status: "invalid" };
  }
  const pid = /^\d+$/.test(pidText) ? Number(pidText) : NaN;
  const pathIsAbsolute = platform === "win32" ? win32.isAbsolute(path) : posix.isAbsolute(path);
  if (
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    !pathIsAbsolute
  ) {
    return { status: "invalid" };
  }

  const leasePath = join(path, `owner-${token}.lease`);
  try {
    const lockStats = lstatSync(path);
    const leaseStats = lstatSync(leasePath);
    const contents = JSON.parse(readFileSync(leasePath, "utf8"));
    if (
      !lockStats.isDirectory() ||
      !leaseStats.isFile() ||
      contents?.token !== token ||
      contents?.pid !== pid ||
      !isProcessAliveImpl(pid)
    ) {
      return { status: "invalid" };
    }
  } catch {
    return { status: "invalid" };
  }

  return {
    status: "borrowed",
    lease: { lockPath: path, token, pid, leasePath, borrowed: true },
  };
}

export function getInstallerUpdateLockPath(
  env = process.env,
  workingDirectory = homedir(),
) {
  const configured = env.CLAUDE_CONFIG_DIR?.trim();
  const configHome = configured ? resolve(configured) : join(resolve(workingDirectory), ".claude");
  return join(configHome, ".update.lock");
}

/** Acquire the shared global-update lease, or validate an outer updater handoff. */
export function acquireInstallerUpdateLease({
  env = process.env,
  lockPath = getInstallerUpdateLockPath(env),
  platform = process.platform,
  staleMs = UPDATE_LOCK_STALE_MS,
  now = Date.now,
  pid = process.pid,
  randomUUIDImpl = randomUUID,
  isProcessAliveImpl = defaultProcessIsAlive,
} = {}) {
  const borrowed = readBorrowedLease(env, platform, isProcessAliveImpl);
  if (borrowed.status !== "none") return borrowed;

  const options = { now, pid, randomUUIDImpl, staleMs, isProcessAliveImpl };
  const gate = acquireDirectoryLease(`${lockPath}.acquire`, options);
  if (!gate) return { status: "contended" };
  try {
    const lease = acquireMainLease(lockPath, options);
    return lease ? { status: "acquired", lease } : { status: "contended" };
  } finally {
    releaseInstallerUpdateLease(gate);
  }
}

export function getInstallerLeaseEnvironment(lease) {
  return {
    TAU_UPDATE_LOCK_PATH: lease.lockPath,
    TAU_UPDATE_LOCK_TOKEN: lease.token,
    TAU_UPDATE_LOCK_PID: String(lease.pid),
  };
}

export function releaseInstallerUpdateLease(lease) {
  if (!lease || lease.borrowed) return;
  try {
    unlinkSync(lease.leasePath);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  removeEmptyDirectory(lease.lockPath);
}

function startInstallerLeaseHeartbeat(
  lease,
  {
    heartbeatMs = UPDATE_LOCK_HEARTBEAT_MS,
    setIntervalImpl = setInterval,
    clearIntervalImpl = clearInterval,
    onError = () => {},
  } = {},
) {
  if (lease.borrowed) return () => {};
  const timer = setIntervalImpl(() => {
    try {
      const now = new Date();
      utimesSync(lease.leasePath, now, now);
    } catch (error) {
      if (!isMissing(error)) onError(error);
    }
  }, heartbeatMs);
  timer.unref?.();
  return () => clearIntervalImpl(timer);
}

function getEmbeddedLauncherTargets(launcherPath, content) {
  const quotedTargets = [
    ...content.matchAll(/"([^"\r\n]*node_modules\/[^"\r\n]+)"/g),
    ...content.matchAll(/'([^'\r\n]*node_modules\/[^'\r\n]+)'/g),
  ];
  const basedirPrefix =
    /^(?:%~dp0%?|%dp0%|\$(?:basedir|\{basedir\}|PSScriptRoot|\{PSScriptRoot\}))(?:\/|$)/i;

  return quotedTargets.flatMap((match) => {
    let embeddedPath = match[1];
    if (!embeddedPath) return [];

    if (basedirPrefix.test(embeddedPath)) {
      embeddedPath = embeddedPath.replace(
        basedirPrefix,
        `${dirname(launcherPath)}/`,
      );
    } else if (/[$%`]/.test(embeddedPath)) {
      // Unknown variables make the target unprovable, so preserve the file.
      return [];
    }

    return [resolve(dirname(launcherPath), embeddedPath)];
  });
}

function isDefinitelyDanglingLauncher(launcherPath) {
  try {
    const stat = lstatSync(launcherPath);
    if (stat.isSymbolicLink()) {
      return !existsSync(resolve(dirname(launcherPath), readlinkSync(launcherPath)));
    }

    const content = readFileSync(launcherPath, "utf8").split("\\").join("/");
    const targets = getEmbeddedLauncherTargets(launcherPath, content);
    return targets.length > 0 && targets.every((target) => !existsSync(target));
  } catch {
    return false;
  }
}

/** Remove only tau/claudex launchers whose target can be proven missing. */
export function cleanDanglingLaunchers(
  binDirectory,
  { platform = process.platform } = {},
) {
  if (!binDirectory || !existsSync(binDirectory)) return [];

  const extensions = platform === "win32" ? WINDOWS_BIN_EXTENSIONS : [""];
  const removed = [];
  for (const name of BIN_NAMES) {
    for (const extension of extensions) {
      const launcherPath = join(binDirectory, `${name}${extension}`);
      if (!isDefinitelyDanglingLauncher(launcherPath)) continue;
      try {
        unlinkSync(launcherPath);
        removed.push(launcherPath);
      } catch {
        // npm will report EEXIST if a locked dangling launcher remains.
      }
    }
  }
  return removed;
}

export function resolveWindowsTaskkillPath(env = process.env) {
  for (const value of [env.SystemRoot, env.WINDIR]) {
    const windowsRoot = value?.trim();
    if (
      windowsRoot &&
      win32.isAbsolute(windowsRoot) &&
      !/[\0\r\n]/.test(windowsRoot)
    ) {
      return win32.join(windowsRoot, "System32", "taskkill.exe");
    }
  }
  return null;
}

export function resolveNpmInvocation({
  env = process.env,
  platform = process.platform,
  nodeExecutable = process.execPath,
  fileExists = existsSync,
} = {}) {
  const npmExecPath = env.npm_execpath?.trim();
  const pathDirname = platform === "win32" ? win32.dirname : dirname;
  const pathJoin = platform === "win32" ? win32.join : join;

  if (npmExecPath) {
    if (/\.[cm]?js$/i.test(npmExecPath)) {
      return {
        command: env.npm_node_execpath?.trim() || nodeExecutable,
        prefixArguments: [npmExecPath],
      };
    }

    if (platform === "win32" && /\.(?:cmd|bat|ps1)$/i.test(npmExecPath)) {
      const npmCliPath = pathJoin(
        pathDirname(npmExecPath),
        "node_modules",
        "npm",
        "bin",
        "npm-cli.js",
      );
      if (!fileExists(npmCliPath)) {
        throw new Error(
          "Cannot resolve the npm wrapper to npm-cli.js. Run tau-installer through npx so it can reuse the invoking npm executable.",
        );
      }

      return {
        command: env.npm_node_execpath?.trim() || nodeExecutable,
        prefixArguments: [npmCliPath],
      };
    }

    return { command: npmExecPath, prefixArguments: [] };
  }

  if (platform === "win32") {
    const npmCliPath = pathJoin(
      pathDirname(nodeExecutable),
      "node_modules",
      "npm",
      "bin",
      "npm-cli.js",
    );
    if (!fileExists(npmCliPath)) {
      throw new Error(
        "Cannot locate npm-cli.js. Run tau-installer through npx so it can reuse the invoking npm executable.",
      );
    }

    return { command: nodeExecutable, prefixArguments: [npmCliPath] };
  }

  return { command: "npm", prefixArguments: [] };
}

function displayArgument(value) {
  return /^[A-Za-z0-9_@%+=:,./\\-]+$/.test(value) ? value : JSON.stringify(value);
}

function forwardTerminationSignals(
  child,
  signalSource,
  platform,
  stderr,
  {
    env,
    processKillImpl,
    treeKillSpawnImpl,
    terminationGraceMs = TERMINATION_GRACE_MS,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
  },
) {
  const signals = platform === "win32" ? ["SIGINT", "SIGTERM"] : ["SIGINT", "SIGTERM", "SIGHUP"];
  const handlers = new Map();
  let forceTimer;
  let windowsTerminationStarted = false;
  let windowsForceStarted = false;
  let posixTerminationStarted = false;
  let posixForceStarted = false;

  const killDirectly = (signal) => {
    try {
      if (typeof child.kill === "function") {
        child.kill(signal);
      }
    } catch (error) {
      stderr.write(`Unable to forward ${signal} to npm: ${error.message}\n`);
    }
  };

  const killWindowsTree = (force, fallbackSignal) => {
    if (!Number.isInteger(child.pid) || child.pid <= 0) return false;

    const command = resolveWindowsTaskkillPath(env);
    // A missing/invalid SystemRoot is safer than guessing an OS drive or
    // resolving a potentially shadowed taskkill.exe from PATH. Fall back to
    // terminating npm directly; the next run's integrity repair handles any
    // descendants that outlive it.
    if (!command) return false;
    const args = ["/PID", String(child.pid), "/T", ...(force ? ["/F"] : [])];
    let killer;
    try {
      killer = treeKillSpawnImpl(command, args, {
        env,
        shell: false,
        stdio: "ignore",
        windowsHide: true,
      });
    } catch (error) {
      stderr.write(`Unable to terminate npm's process tree: ${error.message}\n`);
      return false;
    }

    let killerSettled = false;
    let fallbackStarted = false;
    const fallbackToDirectKill = (message) => {
      // child_process can report both `error` and `close`. A failed taskkill
      // must forward the fallback signal exactly once for this attempt.
      if (fallbackStarted) return;
      fallbackStarted = true;
      stderr.write(`Unable to terminate npm's process tree: ${message}\n`);
      killDirectly(fallbackSignal);
    };

    killer.once?.("error", (error) => {
      if (killerSettled) return;
      killerSettled = true;
      fallbackToDirectKill(error.message);
    });
    killer.once?.("close", (code, signal) => {
      if (killerSettled) return;
      killerSettled = true;
      if (code === 0) return;
      fallbackToDirectKill(
        Number.isInteger(code)
          ? `taskkill exited with code ${code}`
          : `taskkill exited via ${signal ?? "an unknown failure"}`,
      );
    });
    return true;
  };

  const forceWindowsTree = () => {
    if (windowsForceStarted) return;
    windowsForceStarted = true;
    if (!killWindowsTree(true, "SIGKILL")) {
      killDirectly("SIGKILL");
    }
  };

  const killPosixGroup = (signal) => {
    if (!Number.isInteger(child.pid) || child.pid <= 0) return false;

    try {
      // POSIX accepts a negative PID as a process-group ID. Foreground npm
      // commands are spawned detached below so npm and lifecycle descendants
      // share this dedicated group.
      processKillImpl(-child.pid, signal);
      return true;
    } catch (error) {
      if (error?.code === "ESRCH") return true;
      stderr.write(`Unable to terminate npm's process group: ${error.message}\n`);
      return false;
    }
  };

  const forcePosixGroup = () => {
    if (posixForceStarted) return;
    posixForceStarted = true;
    if (!killPosixGroup("SIGKILL")) {
      killDirectly("SIGKILL");
    }
  };

  for (const signal of signals) {
    const handler = () => {
      if (platform === "win32") {
        if (windowsTerminationStarted) {
          forceWindowsTree();
          return;
        }
        windowsTerminationStarted = true;

        if (!killWindowsTree(false, signal)) {
          killDirectly(signal);
        }

        forceTimer = setTimeoutImpl(forceWindowsTree, terminationGraceMs);
        forceTimer.unref?.();
        return;
      }

      if (posixTerminationStarted) {
        forcePosixGroup();
        return;
      }
      posixTerminationStarted = true;

      if (!killPosixGroup("SIGTERM")) {
        killDirectly("SIGTERM");
      }

      forceTimer = setTimeoutImpl(forcePosixGroup, terminationGraceMs);
      forceTimer.unref?.();
    };
    handlers.set(signal, handler);
    signalSource.on(signal, handler);
  }

  return () => {
    // npm can exit after SIGTERM while a lifecycle descendant remains alive.
    // Before dropping the timer, kill anything still using the process group.
    if (platform !== "win32" && posixTerminationStarted) {
      forcePosixGroup();
    }
    if (forceTimer) clearTimeoutImpl(forceTimer);
    for (const [signal, handler] of handlers) {
      signalSource.off(signal, handler);
    }
  };
}

export function formatCommand(command, args) {
  return [command, ...args].map(displayArgument).join(" ");
}

async function detectNpmVersion(invocation, { env, spawnImpl, stderr, workingDirectory }) {
  let child;
  try {
    child = spawnImpl(invocation.command, [...invocation.prefixArguments, "--version"], {
      env,
      cwd: workingDirectory,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (error) {
    stderr.write(`Unable to detect npm version: ${error.message}\n`);
    return { code: 1 };
  }

  return new Promise((resolve) => {
    let output = "";
    let errorOutput = "";
    let settled = false;

    child.stdout?.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      errorOutput += chunk;
    });

    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    child.once("error", (error) => {
      stderr.write(`Unable to detect npm version: ${error.message}\n`);
      finish({ code: 1 });
    });

    child.once("close", (code) => {
      if (code !== 0) {
        if (errorOutput) stderr.write(errorOutput);
        finish({ code: Number.isInteger(code) ? code : 1 });
        return;
      }

      const version = output.trim();
      if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
        stderr.write(`Unable to detect a valid npm version from: ${JSON.stringify(version)}\n`);
        finish({ code: 1 });
        return;
      }

      finish({ code: 0, version });
    });
  });
}

async function detectGlobalPrefix(
  invocation,
  { env, platform, spawnImpl, workingDirectory },
) {
  let child;
  try {
    child = spawnImpl(
      invocation.command,
      [...invocation.prefixArguments, "prefix", "--global"],
      {
        env,
        cwd: workingDirectory,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
  } catch {
    return null;
  }

  return new Promise((resolvePrefix) => {
    let output = "";
    let settled = false;
    child.stdout?.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr?.resume();

    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolvePrefix(value);
    };

    child.once("error", () => finish(null));
    child.once("close", (code) => {
      const prefix = output.trim();
      const isAbsolute = platform === "win32" ? win32.isAbsolute : posix.isAbsolute;
      if (code !== 0 || !prefix || /[\r\n\0]/.test(prefix) || !isAbsolute(prefix)) {
        finish(null);
        return;
      }
      finish(prefix);
    });
  });
}

export function getGlobalTauPackageRoot(globalPrefix, platform = process.platform) {
  const nodeModulesRoot =
    platform === "win32"
      ? join(globalPrefix, "node_modules")
      : join(globalPrefix, "lib", "node_modules");
  return join(nodeModulesRoot, ...TAU_PACKAGE.split("/"));
}

export function getLifecycleMarkerStatus(packageRoot) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  } catch {
    return { ok: false, required: true, reason: "manifest-missing" };
  }

  if (manifest.name !== TAU_PACKAGE || !isExactVersion(manifest.version)) {
    return { ok: false, required: true, reason: "manifest-invalid" };
  }

  const [major, minor, patch] = manifest.version.split(/[.+-]/, 3).map(Number);
  const markerEra =
    major > 0 ||
    (major === 0 && (minor > 92 || (minor === 92 && patch > 15))) ||
    (major === 0 && minor === 92 && patch === 15 && !manifest.version.includes("-"));
  if (!markerEra) {
    return { ok: true, required: false, reason: "legacy", version: manifest.version };
  }

  let marker;
  try {
    marker = JSON.parse(
      readFileSync(join(packageRoot, ".tau-lifecycle-complete.json"), "utf8"),
    );
  } catch {
    return { ok: false, required: true, reason: "marker-missing", version: manifest.version };
  }

  const ok =
    marker?.schema === 1 &&
    marker?.packageName === TAU_PACKAGE &&
    marker?.version === manifest.version;
  return {
    ok,
    required: true,
    reason: ok ? "complete" : "marker-invalid",
    version: manifest.version,
  };
}

export function buildRebuildArguments(packageNames, npmVersion) {
  const args = [
    "rebuild",
    "--global",
    ...packageNames,
    "--ignore-scripts=false",
    "--dry-run=false",
    "--package-lock-only=false",
    "--bin-links=true",
    "--include=optional",
  ];

  if (npmSupportsAllowScripts(npmVersion)) {
    args.push("--dangerously-allow-all-scripts=false");
    args.push("--strict-allow-scripts=true");
    args.push(`--allow-scripts=${ALLOWED_SCRIPTS.join(",")}`);
  }

  args.push("--no-audit", "--no-fund");
  return args;
}

async function runForegroundNpmCommand(
  invocation,
  commandArguments,
  {
    env,
    platform,
    processKillImpl,
    spawnImpl,
    treeKillSpawnImpl,
    signalSource,
    terminationGraceMs,
    setTimeoutImpl,
    clearTimeoutImpl,
    workingDirectory,
    stderr,
  },
) {
  let child;
  try {
    child = spawnImpl(
      invocation.command,
      [...invocation.prefixArguments, ...commandArguments],
      {
        env,
        cwd: workingDirectory,
        detached: platform !== "win32",
        shell: false,
        stdio: "inherit",
        windowsHide: true,
      },
    );
  } catch (error) {
    stderr.write(`Unable to start npm: ${error.message}\n`);
    return 1;
  }

  return new Promise((resolveCode) => {
    let settled = false;
    const stopForwardingSignals = forwardTerminationSignals(
      child,
      signalSource,
      platform,
      stderr,
      {
        env,
        processKillImpl,
        treeKillSpawnImpl,
        terminationGraceMs,
        setTimeoutImpl,
        clearTimeoutImpl,
      },
    );

    const finish = (code) => {
      if (settled) return;
      settled = true;
      stopForwardingSignals();
      resolveCode(code);
    };

    child.once("error", (error) => {
      stderr.write(`Unable to start npm: ${error.message}\n`);
      finish(1);
    });

    child.once("close", (code, signal) => {
      const signalExitCodes = {
        SIGHUP: 129,
        SIGINT: 130,
        SIGKILL: 137,
        SIGTERM: 143,
      };
      finish(Number.isInteger(code) ? code : (signalExitCodes[signal] ?? 1));
    });
  });
}

export async function runInstaller(
  { tauVersion, dryRun = false } = {},
  {
    env = process.env,
    platform = process.platform,
    nodeExecutable = process.execPath,
    spawnImpl = spawn,
    processKillImpl = process.kill,
    treeKillSpawnImpl = spawn,
    signalSource = process,
    terminationGraceMs = TERMINATION_GRACE_MS,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
    setIntervalImpl = setInterval,
    clearIntervalImpl = clearInterval,
    workingDirectory = homedir(),
    lockPath,
    isProcessAliveImpl = (pid) => defaultProcessIsAlive(pid, processKillImpl),
    stdout = process.stdout,
    stderr = process.stderr,
  } = {},
) {
  const childEnv = createInstallerEnvironment(env);
  let invocation;
  try {
    invocation = resolveNpmInvocation({ env, platform, nodeExecutable });
  } catch (error) {
    stderr.write(`${error.message}\n`);
    return 1;
  }
  const npmVersionResult = await detectNpmVersion(invocation, {
    env: childEnv,
    spawnImpl,
    stderr,
    workingDirectory,
  });
  if (npmVersionResult.code !== 0) return npmVersionResult.code;

  const args = [
    ...invocation.prefixArguments,
    ...buildInstallArguments(tauVersion, npmVersionResult.version),
  ];

  if (dryRun) {
    stdout.write(`${formatCommand(invocation.command, args)}\n`);
    return 0;
  }

  const expectedLockPath = lockPath ?? getInstallerUpdateLockPath(env, workingDirectory);
  let lockResult;
  try {
    lockResult = acquireInstallerUpdateLease({
      env,
      lockPath: expectedLockPath,
      platform,
      isProcessAliveImpl,
    });
  } catch (error) {
    stderr.write(`Unable to acquire Tau's update lock: ${error.message}\n`);
    return 1;
  }
  if (lockResult.status === "invalid") {
    stderr.write("Tau received an invalid update-lock handoff and refused to continue.\n");
    return 1;
  }
  if (lockResult.status === "contended") {
    stderr.write("Another Tau installation or update is already in progress.\n");
    return INSTALLER_LOCK_CONTENDED_EXIT_CODE;
  }

  const lease = lockResult.lease;
  Object.assign(childEnv, getInstallerLeaseEnvironment(lease));
  const stopLockHeartbeat = startInstallerLeaseHeartbeat(lease, {
    setIntervalImpl,
    clearIntervalImpl,
    onError: (error) => stderr.write(`Unable to refresh Tau's update lock: ${error.message}\n`),
  });

  try {
    const globalPrefix = await detectGlobalPrefix(invocation, {
      env: childEnv,
      platform,
      spawnImpl,
      workingDirectory,
    });
    if (!globalPrefix) {
      stderr.write("Unable to determine npm's global prefix safely.\n");
      return 1;
    }

    const binDirectory =
      platform === "win32" ? globalPrefix : join(globalPrefix, "bin");
    cleanDanglingLaunchers(binDirectory, { platform });

    const commandOptions = {
      env: childEnv,
      platform,
      processKillImpl,
      spawnImpl,
      treeKillSpawnImpl,
      signalSource,
      terminationGraceMs,
      setTimeoutImpl,
      clearTimeoutImpl,
      workingDirectory,
      stderr,
    };
    const installCode = await runForegroundNpmCommand(
      invocation,
      buildInstallArguments(tauVersion, npmVersionResult.version),
      commandOptions,
    );
    if (installCode !== 0) return installCode;

    const packageRoot = getGlobalTauPackageRoot(globalPrefix, platform);
    let lifecycleStatus = getLifecycleMarkerStatus(packageRoot);
    if (tauVersion && lifecycleStatus.version && lifecycleStatus.version !== tauVersion) {
      stderr.write(
        `npm reported success, but installed Tau ${lifecycleStatus.version} instead of ${tauVersion}.\n`,
      );
      return 1;
    }
    if (lifecycleStatus.ok) return 0;
    if (lifecycleStatus.reason === "manifest-missing" || lifecycleStatus.reason === "manifest-invalid") {
      stderr.write("npm reported success, but the global Tau package is missing or invalid.\n");
      return 1;
    }

    const dependencyPackages = ALLOWED_SCRIPTS.filter(
      (packageName) => packageName !== TAU_PACKAGE,
    );
    const dependencyRebuildCode = await runForegroundNpmCommand(
      invocation,
      buildRebuildArguments(dependencyPackages, npmVersionResult.version),
      commandOptions,
    );
    if (dependencyRebuildCode !== 0) return dependencyRebuildCode;

    const tauRebuildCode = await runForegroundNpmCommand(
      invocation,
      buildRebuildArguments([TAU_PACKAGE], npmVersionResult.version),
      commandOptions,
    );
    if (tauRebuildCode !== 0) return tauRebuildCode;

    lifecycleStatus = getLifecycleMarkerStatus(packageRoot);
    if (!lifecycleStatus.ok) {
      stderr.write(
        "Tau's lifecycle scripts did not produce a valid completion marker.\n",
      );
      return 1;
    }
    return 0;
  } finally {
    stopLockHeartbeat();
    try {
      releaseInstallerUpdateLease(lease);
    } catch (error) {
      stderr.write(`Unable to release Tau's update lock: ${error.message}\n`);
    }
  }
}

export const HELP_TEXT = `Usage: tau-installer [options]

Installs @abdoknbgit/tau globally while allowing its reviewed lifecycle scripts
for this npm command only.

Options:
  --tau-version <version>  Install an exact Tau version (used by tau update)
  --dry-run                Print the npm command without running it
  -h, --help               Show this help
`;
