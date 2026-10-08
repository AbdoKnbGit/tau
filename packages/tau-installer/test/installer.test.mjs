import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  ALLOWED_SCRIPTS,
  acquireInstallerUpdateLease,
  buildInstallArguments,
  buildRebuildArguments,
  cleanDanglingLaunchers,
  createInstallerEnvironment,
  getInstallerLeaseEnvironment,
  getGlobalTauPackageRoot,
  getLifecycleMarkerStatus,
  isExactVersion,
  npmSupportsAllowScripts,
  parseArguments,
  releaseInstallerUpdateLease,
  resolveNpmInvocation,
  resolveWindowsTaskkillPath,
  runInstaller,
} from "../lib/installer.mjs";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const binPath = fileURLToPath(new URL("../bin/tau-installer.mjs", import.meta.url));

function createGlobalFixture(testContext, version = "0.92.15", withMarker = false) {
  const prefix = mkdtempSync(join(tmpdir(), "tau-installer-test-"));
  const installedPackageRoot = getGlobalTauPackageRoot(prefix, process.platform);
  mkdirSync(installedPackageRoot, { recursive: true });
  writeFileSync(
    join(installedPackageRoot, "package.json"),
    `${JSON.stringify({ name: "@abdoknbgit/tau", version })}\n`,
  );

  const writeMarker = () => {
    writeFileSync(
      join(installedPackageRoot, ".tau-lifecycle-complete.json"),
      `${JSON.stringify({
        schema: 1,
        packageName: "@abdoknbgit/tau",
        version,
      })}\n`,
    );
  };
  if (withMarker) writeMarker();
  testContext.after(() => rmSync(prefix, { recursive: true, force: true }));
  return { prefix, installedPackageRoot, writeMarker };
}

function isVersionProbe(args) {
  return args.at(-1) === "--version";
}

function isPrefixProbe(args) {
  return args.at(-2) === "prefix" && args.at(-1) === "--global";
}

function createChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  return child;
}

function createSuccessfulInstallerSpawn({ prefix, calls, onCommand }) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    const child = createChild();
    queueMicrotask(() => {
      if (isVersionProbe(args)) {
        child.stdout.end("12.4.1\n");
        child.stderr.end();
        child.emit("close", 0, null);
      } else if (isPrefixProbe(args)) {
        child.stdout.end(`${prefix}\n`);
        child.stderr.end();
        child.emit("close", 0, null);
      } else {
        const code = onCommand?.(args) ?? 0;
        child.emit("close", code, null);
      }
    });
    return child;
  };
}

test("package has no dependencies or lifecycle scripts", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const lifecycleNames = [
    "preinstall",
    "install",
    "postinstall",
    "prepublish",
    "prepublishOnly",
    "prepare",
  ];

  assert.equal(manifest.dependencies, undefined);
  assert.equal(manifest.optionalDependencies, undefined);
  assert.equal(manifest.peerDependencies, undefined);
  assert.equal(manifest.devDependencies, undefined);
  assert.equal(manifest.scripts, undefined);
  assert.equal(lifecycleNames.some((name) => manifest.scripts?.[name]), false);
});

test("reviewed policies cover every lifecycle script in the published production graph", async () => {
  const lockfile = JSON.parse(
    await readFile(
      new URL("../../../release/npm-shrinkwrap.production.json", import.meta.url),
      "utf8",
    ),
  );
  const tauManifest = JSON.parse(
    await readFile(new URL("../../../package.json", import.meta.url), "utf8"),
  );
  const localInstallerSource = await readFile(
    new URL("../../../src/utils/localInstaller.ts", import.meta.url),
    "utf8",
  );
  const packageNameFromPath = (path, metadata) => {
    if (!path) return metadata.name;
    const relative = path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
    const segments = relative.split("/");
    return segments[0].startsWith("@") ? `${segments[0]}/${segments[1]}` : segments[0];
  };

  const productionScriptPackages = Object.entries(lockfile.packages)
    .filter(([, metadata]) => metadata.hasInstallScript && !metadata.dev)
    .map(([path, metadata]) => packageNameFromPath(path, metadata))
    .sort();

  assert.deepEqual(productionScriptPackages, [...ALLOWED_SCRIPTS].sort());
  assert.deepEqual(
    Object.keys(tauManifest.allowScripts).sort(),
    [...ALLOWED_SCRIPTS, "esbuild"].sort(),
  );
  const localPolicyBlock = localInstallerSource.match(
    /export const LOCAL_ALLOW_SCRIPTS = \[(.*?)\] as const/s,
  );
  assert.ok(localPolicyBlock, "managed-local allowScripts policy is missing");
  const localPolicy = [...localPolicyBlock[1].matchAll(/'([^']+)'/g)].map(
    ([, name]) => name,
  );
  assert.deepEqual(localPolicy.sort(), [...ALLOWED_SCRIPTS].sort());
});

test("default arguments install the latest Tau globally with a command-only allowlist", () => {
  assert.deepEqual(buildInstallArguments(undefined, "12.0.0"), [
    "install",
    "--global",
    "@abdoknbgit/tau@latest",
    "--ignore-scripts=false",
    "--dry-run=false",
    "--package-lock-only=false",
    "--bin-links=true",
    "--include=optional",
    "--dangerously-allow-all-scripts=false",
    "--strict-allow-scripts=true",
    `--allow-scripts=${ALLOWED_SCRIPTS.join(",")}`,
    "--no-audit",
    "--no-fund",
  ]);
});

test("allow-scripts is used only by npm versions that support it", () => {
  assert.equal(npmSupportsAllowScripts("10.9.3"), false);
  assert.equal(npmSupportsAllowScripts("11.15.9"), false);
  assert.equal(npmSupportsAllowScripts("11.16.0"), true);
  assert.equal(npmSupportsAllowScripts("12.4.1"), true);

  assert.deepEqual(buildInstallArguments(undefined, "10.9.3"), [
    "install",
    "--global",
    "@abdoknbgit/tau@latest",
    "--ignore-scripts=false",
    "--dry-run=false",
    "--package-lock-only=false",
    "--bin-links=true",
    "--include=optional",
    "--no-audit",
    "--no-fund",
  ]);
  assert.match(buildInstallArguments(undefined, "11.16.0").join(" "), /--allow-scripts=/);
  assert.match(buildInstallArguments(undefined, "11.16.0").join(" "), /--strict-allow-scripts=true/);
  assert.match(buildInstallArguments(undefined, "12.4.1").join(" "), /--allow-scripts=/);
});

test("rebuild arguments keep lifecycle policy strict and package-scoped", () => {
  assert.deepEqual(buildRebuildArguments(["node-pty", "protobufjs"], "12.4.1"), [
    "rebuild",
    "--global",
    "node-pty",
    "protobufjs",
    "--ignore-scripts=false",
    "--dry-run=false",
    "--package-lock-only=false",
    "--bin-links=true",
    "--include=optional",
    "--dangerously-allow-all-scripts=false",
    "--strict-allow-scripts=true",
    `--allow-scripts=${ALLOWED_SCRIPTS.join(",")}`,
    "--no-audit",
    "--no-fund",
  ]);
});

test("preflight removes only definitely dangling tau launchers", (t) => {
  const root = mkdtempSync(join(tmpdir(), "tau-launcher-cleanup-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const binDirectory = join(root, "bin");
  const tauTarget = join(
    root,
    "healthy",
    "node_modules",
    "@abdoknbgit",
    "tau",
    "dist",
    "cli.mjs",
  );
  const foreignTarget = join(
    root,
    "foreign",
    "node_modules",
    "other-cli",
    "bin.mjs",
  );
  const missingTarget = join(
    root,
    "missing",
    "node_modules",
    "@abdoknbgit",
    "tau",
    "dist",
    "cli.mjs",
  );
  mkdirSync(binDirectory, { recursive: true });
  mkdirSync(dirname(tauTarget), { recursive: true });
  mkdirSync(dirname(foreignTarget), { recursive: true });
  writeFileSync(tauTarget, "// healthy Tau target\n");
  writeFileSync(foreignTarget, "// healthy foreign target\n");

  const healthyTau = join(binDirectory, "tau.cmd");
  const healthyForeign = join(binDirectory, "tau.ps1");
  const dangling = join(binDirectory, "claudex.cmd");
  const unknown = join(binDirectory, "claudex.ps1");
  writeFileSync(healthyTau, `node "${tauTarget}"\n`);
  writeFileSync(healthyForeign, `node "${foreignTarget}"\n`);
  writeFileSync(dangling, `node "${missingTarget}"\n`);
  writeFileSync(unknown, "echo @abdoknbgit/tau documentation only\n");

  assert.deepEqual(cleanDanglingLaunchers(binDirectory, { platform: "win32" }), [
    dangling,
  ]);
  assert.equal(existsSync(healthyTau), true);
  assert.equal(existsSync(healthyForeign), true);
  assert.equal(existsSync(dangling), false);
  assert.equal(existsSync(unknown), true);
});

test("Windows tree termination uses only a validated System32 executable", () => {
  assert.equal(
    resolveWindowsTaskkillPath({ SystemRoot: "D:\\Windows" }),
    "D:\\Windows\\System32\\taskkill.exe",
  );
  assert.equal(
    resolveWindowsTaskkillPath({
      SystemRoot: "relative-root",
      WINDIR: "E:\\Windows\ninvalid",
    }),
    null,
  );
  assert.equal(resolveWindowsTaskkillPath({ WINDIR: "E:\\Windows" }),
    "E:\\Windows\\System32\\taskkill.exe");
});

test("an exact Tau version is accepted and ranges or tags are rejected", () => {
  assert.equal(isExactVersion("0.92.15"), true);
  assert.equal(isExactVersion("1.0.0-rc.1"), true);
  assert.equal(isExactVersion("1.0.0+build.7"), true);
  assert.equal(isExactVersion("1.0.0-01"), false);
  assert.equal(isExactVersion("^0.92.15"), false);
  assert.equal(isExactVersion("latest"), false);

  assert.deepEqual(parseArguments(["--tau-version", "0.92.15"]), {
    tauVersion: "0.92.15",
    dryRun: false,
    help: false,
  });
  assert.throws(() => parseArguments(["--tau-version", "latest"]), /exact semantic version/);
});

test("the npm executable from the invoking npm process is reused safely", () => {
  assert.deepEqual(
    resolveNpmInvocation({
      env: {
        npm_execpath: "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js",
        npm_node_execpath: "C:\\Program Files\\nodejs\\node.exe",
      },
      platform: "win32",
      nodeExecutable: "unused-node.exe",
    }),
    {
      command: "C:\\Program Files\\nodejs\\node.exe",
      prefixArguments: ["C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js"],
    },
  );

  assert.deepEqual(
    resolveNpmInvocation({
      env: {
        npm_execpath: "C:\\Users\\me\\AppData\\Roaming\\npm\\npm.cmd",
        npm_node_execpath: "C:\\Program Files\\nodejs\\node.exe",
      },
      platform: "win32",
      nodeExecutable: "unused-node.exe",
      fileExists: (path) => path.endsWith("node_modules\\npm\\bin\\npm-cli.js"),
    }),
    {
      command: "C:\\Program Files\\nodejs\\node.exe",
      prefixArguments: [
        "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\npm\\bin\\npm-cli.js",
      ],
    },
  );
});

test("installer security flags override inherited npm script settings for one process", () => {
  const original = {
    PATH: "/usr/bin",
    npm_config_allow_scripts: "evil-package",
    NPM_CONFIG_IGNORE_SCRIPTS: "true",
    npm_config_dangerously_allow_all_scripts: "true",
    NPM_CONFIG_STRICT_ALLOW_SCRIPTS: "false",
    npm_config_dry_run: "true",
    npm_config_global: "false",
    NPM_CONFIG_PACKAGE_LOCK_ONLY: "true",
    npm_config_omit: "optional",
    npm_config_bin_links: "false",
  };

  assert.deepEqual(createInstallerEnvironment(original), {
    PATH: "/usr/bin",
    SHARP_IGNORE_GLOBAL_LIBVIPS: "1",
  });
  assert.equal(original.NPM_CONFIG_IGNORE_SCRIPTS, "true");
  assert.equal(
    createInstallerEnvironment({ SHARP_IGNORE_GLOBAL_LIBVIPS: "0" }).SHARP_IGNORE_GLOBAL_LIBVIPS,
    "0",
  );
});

test("installer leases serialize contenders and release for the next run", (t) => {
  const root = mkdtempSync(join(tmpdir(), "tau-installer-lock-"));
  const lockPath = join(root, ".update.lock");
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const first = acquireInstallerUpdateLease({
    env: {},
    lockPath,
    pid: 111,
    isProcessAliveImpl: (pid) => pid === 111,
  });
  assert.equal(first.status, "acquired");

  const contender = acquireInstallerUpdateLease({
    env: {},
    lockPath,
    pid: 222,
    isProcessAliveImpl: (pid) => pid === 111,
  });
  assert.equal(contender.status, "contended");

  releaseInstallerUpdateLease(first.lease);
  const next = acquireInstallerUpdateLease({
    env: {},
    lockPath,
    pid: 222,
    isProcessAliveImpl: () => false,
  });
  assert.equal(next.status, "acquired");
  releaseInstallerUpdateLease(next.lease);
  assert.equal(existsSync(lockPath), false);
});

test("stale installer leases are recovered only after their PID is dead", (t) => {
  const root = mkdtempSync(join(tmpdir(), "tau-installer-stale-lock-"));
  const lockPath = join(root, ".update.lock");
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const owner = acquireInstallerUpdateLease({
    env: {},
    lockPath,
    pid: 111,
    isProcessAliveImpl: () => false,
  });
  assert.equal(owner.status, "acquired");
  const staleTime = new Date(Date.now() - 20 * 60 * 1000);
  utimesSync(owner.lease.leasePath, staleTime, staleTime);

  const liveResult = acquireInstallerUpdateLease({
    env: {},
    lockPath,
    pid: 222,
    isProcessAliveImpl: (pid) => pid === 111,
  });
  assert.equal(liveResult.status, "contended");
  assert.equal(existsSync(owner.lease.leasePath), true);

  const recovered = acquireInstallerUpdateLease({
    env: {},
    lockPath,
    pid: 222,
    isProcessAliveImpl: () => false,
  });
  assert.equal(recovered.status, "acquired");
  assert.equal(existsSync(owner.lease.leasePath), false);
  releaseInstallerUpdateLease(recovered.lease);
});

test("stale legacy PID locks preserve live owners and migrate dead owners", (t) => {
  const root = mkdtempSync(join(tmpdir(), "tau-installer-legacy-lock-"));
  const lockPath = join(root, ".update.lock");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(lockPath, "111");
  const staleTime = new Date(Date.now() - 20 * 60 * 1000);
  utimesSync(lockPath, staleTime, staleTime);

  const liveResult = acquireInstallerUpdateLease({
    env: {},
    lockPath,
    pid: 222,
    isProcessAliveImpl: (pid) => pid === 111,
  });
  assert.equal(liveResult.status, "contended");

  const recovered = acquireInstallerUpdateLease({
    env: {},
    lockPath,
    pid: 222,
    isProcessAliveImpl: () => false,
  });
  assert.equal(recovered.status, "acquired");
  releaseInstallerUpdateLease(recovered.lease);
});

test("a valid outer updater handoff is borrowed and never released by installer", (t) => {
  const root = mkdtempSync(join(tmpdir(), "tau-installer-handoff-"));
  const lockPath = join(root, ".update.lock");
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const outer = acquireInstallerUpdateLease({
    env: {},
    lockPath,
    pid: 111,
    isProcessAliveImpl: () => false,
  });
  assert.equal(outer.status, "acquired");
  const borrowed = acquireInstallerUpdateLease({
    env: getInstallerLeaseEnvironment(outer.lease),
    lockPath,
    pid: 222,
    isProcessAliveImpl: (pid) => pid === 111,
  });
  assert.equal(borrowed.status, "borrowed");
  releaseInstallerUpdateLease(borrowed.lease);
  assert.equal(existsSync(outer.lease.leasePath), true);
  releaseInstallerUpdateLease(outer.lease);
});

test("spawn uses argument arrays, disables the shell, and propagates npm's exit code", async (t) => {
  // The lock must live in a writable fixture: /home/tau-user does not exist on
  // CI runners, and the installer must not touch the developer's real home.
  const lockRoot = mkdtempSync(join(tmpdir(), "tau-installer-spawn-"));
  t.after(() => rmSync(lockRoot, { recursive: true, force: true }));
  const prefix = "/opt/npm-global";
  const calls = [];
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options });
    const child = createChild();
    queueMicrotask(() => {
      if (isVersionProbe(args)) {
        child.stdout.end("12.4.1\n");
        child.stderr.end();
        child.emit("close", 0, null);
      } else if (isPrefixProbe(args)) {
        child.stdout.end(`${prefix}\n`);
        child.stderr.end();
        child.emit("close", 0, null);
      } else {
        child.emit("close", 37, null);
      }
    });
    return child;
  };

  const env = {
    npm_execpath: "/opt/npm/bin/npm-cli.js",
    npm_node_execpath: "/opt/node/bin/node",
  };
  const code = await runInstaller(
    { tauVersion: "0.92.15" },
    {
      env,
      platform: "linux",
      spawnImpl,
      workingDirectory: "/home/tau-user",
      lockPath: join(lockRoot, ".update.lock"),
    },
  );

  assert.equal(code, 37);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0].args, ["/opt/npm/bin/npm-cli.js", "--version"]);
  assert.deepEqual(calls[0].options.stdio, ["ignore", "pipe", "pipe"]);
  assert.equal(calls[0].options.cwd, "/home/tau-user");
  assert.deepEqual(calls[1].args, [
    "/opt/npm/bin/npm-cli.js",
    "prefix",
    "--global",
  ]);
  assert.deepEqual(calls[1].options.stdio, ["ignore", "pipe", "pipe"]);
  assert.equal(calls[2].command, "/opt/node/bin/node");
  assert.deepEqual(calls[2].args, [
    "/opt/npm/bin/npm-cli.js",
    "install",
    "--global",
    "@abdoknbgit/tau@0.92.15",
    "--ignore-scripts=false",
    "--dry-run=false",
    "--package-lock-only=false",
    "--bin-links=true",
    "--include=optional",
    "--dangerously-allow-all-scripts=false",
    "--strict-allow-scripts=true",
    `--allow-scripts=${ALLOWED_SCRIPTS.join(",")}`,
    "--no-audit",
    "--no-fund",
  ]);
  assert.equal(calls[2].options.shell, false);
  assert.equal(calls[2].options.detached, true);
  assert.equal(calls[2].options.stdio, "inherit");
  assert.equal(calls[2].options.cwd, "/home/tau-user");
  assert.notEqual(calls[2].options.env, env);
  assert.equal(calls[2].options.env.npm_execpath, env.npm_execpath);
  assert.equal(calls[2].options.env.npm_node_execpath, env.npm_node_execpath);
  assert.equal(
    calls[2].options.env.TAU_UPDATE_LOCK_PATH,
    join(lockRoot, ".update.lock"),
  );
  assert.match(calls[2].options.env.TAU_UPDATE_LOCK_TOKEN, /^[0-9a-f-]{36}$/i);
  assert.equal(calls[2].options.env.TAU_UPDATE_LOCK_PID, String(process.pid));
});

test("dry-run probes npm but never starts an install", async () => {
  const spawnedArguments = [];
  let output = "";
  const code = await runInstaller(
    { tauVersion: "0.92.15", dryRun: true },
    {
      env: {},
      platform: "linux",
      spawnImpl: (_command, args) => {
        spawnedArguments.push(args);
        const child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        queueMicrotask(() => {
          child.stdout.end("12.0.0\n");
          child.stderr.end();
          child.emit("close", 0, null);
        });
        return child;
      },
      stdout: { write: (chunk) => (output += chunk) },
    },
  );

  assert.equal(code, 0);
  assert.deepEqual(spawnedArguments, [["--version"]]);
  assert.match(output, /@abdoknbgit\/tau@0\.92\.15/);
  assert.match(output, /--allow-scripts=/);
});

test("a valid exact-version lifecycle marker avoids a redundant rebuild", async (t) => {
  const { prefix, installedPackageRoot } = createGlobalFixture(t, "0.92.15", true);
  const calls = [];
  const code = await runInstaller(
    { tauVersion: "0.92.15" },
    {
      env: {
        npm_execpath: "/virtual/npm-cli.js",
        npm_node_execpath: process.execPath,
      },
      platform: process.platform,
      spawnImpl: createSuccessfulInstallerSpawn({ prefix, calls }),
    },
  );

  assert.equal(code, 0);
  assert.equal(getLifecycleMarkerStatus(installedPackageRoot).ok, true);
  assert.equal(calls.filter(({ args }) => args.includes("rebuild")).length, 0);
});

test("an exact-version install fails if npm leaves a different Tau version", async (t) => {
  const { prefix } = createGlobalFixture(t, "0.92.16", true);
  const calls = [];
  let errorOutput = "";
  const code = await runInstaller(
    { tauVersion: "0.92.15" },
    {
      env: {
        npm_execpath: "/virtual/npm-cli.js",
        npm_node_execpath: process.execPath,
      },
      platform: process.platform,
      spawnImpl: createSuccessfulInstallerSpawn({ prefix, calls }),
      stderr: { write: (chunk) => (errorOutput += chunk) },
    },
  );

  assert.equal(code, 1);
  assert.match(errorOutput, /installed Tau 0\.92\.16 instead of 0\.92\.15/);
  assert.equal(calls.filter(({ args }) => args.includes("rebuild")).length, 0);
});

test("a same-version install without a marker rebuilds reviewed dependencies and Tau last", async (t) => {
  const { prefix, installedPackageRoot, writeMarker } = createGlobalFixture(
    t,
    "0.92.15",
  );
  const calls = [];
  const spawnImpl = createSuccessfulInstallerSpawn({
    prefix,
    calls,
    onCommand: (args) => {
      if (args.includes("rebuild") && args.includes("@abdoknbgit/tau")) {
        writeMarker();
      }
      return 0;
    },
  });
  const code = await runInstaller(
    { tauVersion: "0.92.15" },
    {
      env: {
        npm_execpath: "/virtual/npm-cli.js",
        npm_node_execpath: process.execPath,
      },
      platform: process.platform,
      spawnImpl,
    },
  );

  assert.equal(code, 0);
  assert.equal(getLifecycleMarkerStatus(installedPackageRoot).ok, true);
  const rebuildCalls = calls.filter(({ args }) => args.includes("rebuild"));
  assert.equal(rebuildCalls.length, 2);

  const dependencyPackages = ALLOWED_SCRIPTS.filter(
    (packageName) => packageName !== "@abdoknbgit/tau",
  );
  const dependencyRebuildIndex = rebuildCalls[0].args.indexOf("rebuild");
  assert.deepEqual(
    rebuildCalls[0].args.slice(
      dependencyRebuildIndex + 2,
      dependencyRebuildIndex + 2 + dependencyPackages.length,
    ),
    dependencyPackages,
  );
  assert.match(rebuildCalls[0].args.join(" "), /--strict-allow-scripts=true/);

  const tauRebuildIndex = rebuildCalls[1].args.indexOf("rebuild");
  assert.deepEqual(
    rebuildCalls[1].args.slice(tauRebuildIndex, tauRebuildIndex + 3),
    ["rebuild", "--global", "@abdoknbgit/tau"],
  );
});

test("marker-era Tau fails closed when rebuild does not create its marker", async (t) => {
  const { prefix } = createGlobalFixture(t, "0.92.15");
  const calls = [];
  let errorOutput = "";
  const code = await runInstaller(
    { tauVersion: "0.92.15" },
    {
      env: {
        npm_execpath: "/virtual/npm-cli.js",
        npm_node_execpath: process.execPath,
      },
      platform: process.platform,
      spawnImpl: createSuccessfulInstallerSpawn({ prefix, calls }),
      stderr: { write: (chunk) => (errorOutput += chunk) },
    },
  );

  assert.equal(code, 1);
  assert.equal(calls.filter(({ args }) => args.includes("rebuild")).length, 2);
  assert.match(errorOutput, /valid completion marker/);
});

test("pre-marker Tau versions do not require a lifecycle marker", async (t) => {
  const { prefix, installedPackageRoot } = createGlobalFixture(t, "0.92.14");
  const calls = [];
  const code = await runInstaller(
    { tauVersion: "0.92.14" },
    {
      env: {
        npm_execpath: "/virtual/npm-cli.js",
        npm_node_execpath: process.execPath,
      },
      platform: process.platform,
      spawnImpl: createSuccessfulInstallerSpawn({ prefix, calls }),
    },
  );

  assert.equal(code, 0);
  assert.deepEqual(getLifecycleMarkerStatus(installedPackageRoot), {
    ok: true,
    required: false,
    reason: "legacy",
    version: "0.92.14",
  });
  assert.equal(calls.filter(({ args }) => args.includes("rebuild")).length, 0);
});

test("POSIX cancellation sends TERM to npm's detached process group then bounded KILL", async () => {
  const signalSource = new EventEmitter();
  const groupSignals = [];
  let forceCallback;
  let scheduledDelay;
  let timerCleared = false;
  const fakeTimer = { unref() {} };
  let installChild;
  let installOptions;
  let installStarted;
  const started = new Promise((resolve) => {
    installStarted = resolve;
  });

  const spawnImpl = (_command, args, options) => {
    const child = createChild();
    if (!isVersionProbe(args) && !isPrefixProbe(args)) {
      child.pid = 4242;
      child.kill = () => {
        assert.fail("child.kill must not replace POSIX process-group termination");
      };
      installChild = child;
      installOptions = options;
    }

    queueMicrotask(() => {
      if (isVersionProbe(args)) {
        child.stdout.end("12.0.0\n");
        child.stderr.end();
        child.emit("close", 0, null);
      } else if (isPrefixProbe(args)) {
        child.stdout.end("/opt/npm-global\n");
        child.stderr.end();
        child.emit("close", 0, null);
      } else {
        installStarted();
      }
    });
    return child;
  };

  const result = runInstaller(
    { tauVersion: "0.92.15" },
    {
      env: {},
      platform: "linux",
      spawnImpl,
      processKillImpl: (pid, signal) => {
        groupSignals.push([pid, signal]);
        if (signal === "SIGKILL") {
          queueMicrotask(() => installChild.emit("close", null, signal));
        }
      },
      signalSource,
      terminationGraceMs: 25,
      setTimeoutImpl: (callback, delay) => {
        forceCallback = callback;
        scheduledDelay = delay;
        return fakeTimer;
      },
      clearTimeoutImpl: (timer) => {
        assert.equal(timer, fakeTimer);
        timerCleared = true;
      },
    },
  );

  await started;
  signalSource.emit("SIGTERM");

  assert.equal(installOptions.detached, true);
  assert.equal(installOptions.shell, false);
  assert.deepEqual(groupSignals, [[-4242, "SIGTERM"]]);
  assert.equal(scheduledDelay, 25);

  forceCallback();

  assert.equal(await result, 137);
  assert.deepEqual(groupSignals, [
    [-4242, "SIGTERM"],
    [-4242, "SIGKILL"],
  ]);
  assert.equal(timerCleared, true);
  assert.equal(signalSource.listenerCount("SIGINT"), 0);
  assert.equal(signalSource.listenerCount("SIGTERM"), 0);
  assert.equal(signalSource.listenerCount("SIGHUP"), 0);
});

test("POSIX cleanup kills lifecycle descendants after npm exits from TERM", async () => {
  const signalSource = new EventEmitter();
  const groupSignals = [];
  let installChild;
  let installStarted;
  const started = new Promise((resolve) => {
    installStarted = resolve;
  });

  const spawnImpl = (_command, args) => {
    const child = createChild();
    if (!isVersionProbe(args) && !isPrefixProbe(args)) {
      child.pid = 5150;
      child.kill = () => {
        assert.fail("child.kill must not replace POSIX process-group termination");
      };
      installChild = child;
    }

    queueMicrotask(() => {
      if (isVersionProbe(args)) {
        child.stdout.end("12.0.0\n");
        child.stderr.end();
        child.emit("close", 0, null);
      } else if (isPrefixProbe(args)) {
        child.stdout.end("/opt/npm-global\n");
        child.stderr.end();
        child.emit("close", 0, null);
      } else {
        installStarted();
      }
    });
    return child;
  };

  const result = runInstaller(
    { tauVersion: "0.92.15" },
    {
      env: {},
      platform: "linux",
      spawnImpl,
      processKillImpl: (pid, signal) => {
        groupSignals.push([pid, signal]);
        if (signal === "SIGTERM") {
          queueMicrotask(() => installChild.emit("close", null, signal));
        }
      },
      signalSource,
    },
  );

  await started;
  signalSource.emit("SIGINT");

  assert.equal(await result, 143);
  assert.deepEqual(groupSignals, [
    [-5150, "SIGTERM"],
    [-5150, "SIGKILL"],
  ]);
});

test("Windows cancellation terminates npm's descendants and escalates with taskkill", async () => {
  const signalSource = new EventEmitter();
  const taskkillCalls = [];
  let forceCallback;
  let scheduledDelay;
  let timerCleared = false;
  const fakeTimer = { unref() {} };
  let installChild;
  let installOptions;
  let installStarted;
  const started = new Promise((resolve) => {
    installStarted = resolve;
  });

  const spawnImpl = (_command, args, options) => {
    const child = createChild();
    if (!isVersionProbe(args) && !isPrefixProbe(args)) {
      child.pid = 4242;
      child.kill = () => {
        assert.fail("child.kill must not replace Windows tree termination");
      };
      installChild = child;
      installOptions = options;
    }

    queueMicrotask(() => {
      if (isVersionProbe(args)) {
        child.stdout.end("12.0.0\n");
        child.stderr.end();
        child.emit("close", 0, null);
      } else if (isPrefixProbe(args)) {
        child.stdout.end("C:\\Users\\tau\\AppData\\Roaming\\npm\n");
        child.stderr.end();
        child.emit("close", 0, null);
      } else {
        installStarted();
      }
    });
    return child;
  };

  const treeKillSpawnImpl = (command, args, options) => {
    taskkillCalls.push({ command, args, options });
    const child = new EventEmitter();
    queueMicrotask(() => {
      child.emit("close", 0, null);
      if (args.includes("/F")) {
        installChild.emit("close", null, "SIGINT");
      }
    });
    return child;
  };

  const result = runInstaller(
    { tauVersion: "0.92.15" },
    {
      env: {
        SystemRoot: "C:\\Windows",
        npm_execpath: "C:\\node\\node_modules\\npm\\bin\\npm-cli.js",
        npm_node_execpath: "C:\\node\\node.exe",
      },
      platform: "win32",
      spawnImpl,
      treeKillSpawnImpl,
      signalSource,
      terminationGraceMs: 5,
      setTimeoutImpl: (callback, delay) => {
        forceCallback = callback;
        scheduledDelay = delay;
        return fakeTimer;
      },
      clearTimeoutImpl: (timer) => {
        assert.equal(timer, fakeTimer);
        timerCleared = true;
      },
    },
  );

  await started;
  assert.equal(installOptions.detached, false);
  assert.equal(installOptions.shell, false);
  signalSource.emit("SIGINT");
  assert.equal(taskkillCalls.length, 1);
  assert.equal(scheduledDelay, 5);
  forceCallback();

  assert.equal(await result, 130);
  assert.equal(taskkillCalls.length, 2);
  assert.deepEqual(taskkillCalls[0].args, ["/PID", "4242", "/T"]);
  assert.deepEqual(taskkillCalls[1].args, ["/PID", "4242", "/T", "/F"]);
  for (const call of taskkillCalls) {
    assert.equal(call.command, "C:\\Windows\\System32\\taskkill.exe");
    assert.equal(call.options.shell, false);
    assert.equal(call.options.stdio, "ignore");
    assert.equal(call.options.windowsHide, true);
  }
  assert.equal(timerCleared, true);
  assert.equal(signalSource.listenerCount("SIGINT"), 0);
  assert.equal(signalSource.listenerCount("SIGTERM"), 0);
});

test("Windows cancellation falls back once when taskkill exits nonzero", async () => {
  const signalSource = new EventEmitter();
  const directSignals = [];
  const taskkillCalls = [];
  const stderrChunks = [];
  const fakeTimer = { unref() {} };
  let timerCleared = false;
  let installChild;
  let installStarted;
  const started = new Promise((resolve) => {
    installStarted = resolve;
  });

  const spawnImpl = (_command, args) => {
    const child = createChild();
    if (!isVersionProbe(args) && !isPrefixProbe(args)) {
      child.pid = 4343;
      child.kill = (signal) => {
        directSignals.push(signal);
        queueMicrotask(() => child.emit("close", null, signal));
      };
      installChild = child;
    }

    queueMicrotask(() => {
      if (isVersionProbe(args)) {
        child.stdout.end("12.0.0\n");
        child.stderr.end();
        child.emit("close", 0, null);
      } else if (isPrefixProbe(args)) {
        child.stdout.end("D:\\npm-prefix\n");
        child.stderr.end();
        child.emit("close", 0, null);
      } else {
        installStarted();
      }
    });
    return child;
  };

  const treeKillSpawnImpl = (command, args, options) => {
    taskkillCalls.push({ command, args, options });
    const killer = new EventEmitter();
    queueMicrotask(() => {
      killer.emit("close", 1, null);
      // Guard against platforms that report both events for one failure.
      killer.emit("error", new Error("already reported"));
    });
    return killer;
  };

  const result = runInstaller(
    { tauVersion: "0.92.15" },
    {
      env: {
        SystemRoot: "D:\\Windows",
        npm_execpath: "D:\\node\\node_modules\\npm\\bin\\npm-cli.js",
        npm_node_execpath: "D:\\node\\node.exe",
      },
      platform: "win32",
      spawnImpl,
      treeKillSpawnImpl,
      signalSource,
      setTimeoutImpl: () => fakeTimer,
      clearTimeoutImpl: (timer) => {
        assert.equal(timer, fakeTimer);
        timerCleared = true;
      },
      stderr: { write: (chunk) => stderrChunks.push(chunk) },
    },
  );

  await started;
  signalSource.emit("SIGINT");

  assert.equal(await result, 130);
  assert.deepEqual(directSignals, ["SIGINT"]);
  assert.equal(taskkillCalls.length, 1);
  assert.equal(
    taskkillCalls[0].command,
    "D:\\Windows\\System32\\taskkill.exe",
  );
  assert.match(stderrChunks.join(""), /taskkill exited with code 1/);
  assert.doesNotMatch(stderrChunks.join(""), /already reported/);
  assert.equal(timerCleared, true);
  assert.equal(installChild.listenerCount("close"), 0);
  assert.equal(signalSource.listenerCount("SIGINT"), 0);
  assert.equal(signalSource.listenerCount("SIGTERM"), 0);
});

test("the packaged CLI can be spawned in dry-run mode without installing Tau", () => {
  const result = spawnSync(
    process.execPath,
    [binPath, "--dry-run", "--tau-version", "0.92.15"],
    {
      cwd: packageRoot,
      encoding: "utf8",
      env: { ...process.env, npm_execpath: "", npm_node_execpath: "" },
      shell: false,
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.match(
    result.stdout,
    /(?:npm-cli\.js"?|npm) install --global @abdoknbgit\/tau@0\.92\.15/,
  );
  assert.match(result.stdout, /--no-fund/);
});
