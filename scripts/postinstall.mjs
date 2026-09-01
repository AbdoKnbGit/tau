#!/usr/bin/env node
/**
 * Tau postinstall — downloads the platform-correct ripgrep binary
 * and pre-pulls the approved Ollama cloud model aliases.
 *
 * Runs automatically when the reviewed Tau installer invokes npm.
 * Optional network/tool setup failures stay non-fatal, while dependency or
 * completion-marker failures fail closed so an incomplete install is never
 * reported as healthy.
 * The CLI falls back to a system `rg` if the vendored binary is absent,
 * and first-launch code will retry any missed Ollama pulls.
 */

import { existsSync, mkdirSync, mkdtempSync, createWriteStream, readdirSync, renameSync, rmSync, copyFileSync } from 'fs';
import { chmod } from 'fs/promises';
import { resolve, dirname, join, basename } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import https from 'https';
import { tmpdir } from 'os';
import {
  isLinuxArm64Musl,
  isUsableRipgrepCommand,
  resolveWindowsSystemExecutable,
} from './platform-support.mjs';

// KEEP IN SYNC with src/utils/model/ollamaCatalog.ts (CLOUD_MODELS_LIST).
const OLLAMA_CLOUD_MODELS = [
  'glm-5.1:cloud',
  'glm-5:cloud',
  'glm-4.7:cloud',
  'glm-4.6:cloud',
  'kimi-k2.5:cloud',
  'kimi-k2-thinking:cloud',
  'qwen3.5:cloud',
  'qwen3-coder-next:cloud',
  'minimax-m2.7:cloud',
  'minimax-m2.5:cloud',
  'minimax-m2.1:cloud',
  'minimax-m2:cloud',
  'nemotron-3-super:cloud',
  'deepseek-v3.2:cloud',
  'gemini-3-flash-preview:cloud',
];

const RG_VERSION = '14.1.1';

// Map Node's (platform-arch) pair to the ripgrep release info
const PLATFORM_MAP = {
  'win32-x64':   { target: 'x86_64-pc-windows-msvc',   ext: 'zip',    binary: 'rg.exe', dir: 'x64-win32'   },
  // ripgrep first added an official Windows ARM64 artifact in 15.x. Keep the
  // established 14.1.1 binary everywhere else to avoid an unrelated upgrade.
  'win32-arm64': { target: 'aarch64-pc-windows-msvc',  ext: 'zip',    binary: 'rg.exe', dir: 'arm64-win32', version: '15.1.0' },
  'darwin-x64':  { target: 'x86_64-apple-darwin',       ext: 'tar.gz', binary: 'rg',     dir: 'x64-darwin'   },
  'darwin-arm64':{ target: 'aarch64-apple-darwin',      ext: 'tar.gz', binary: 'rg',     dir: 'arm64-darwin' },
  'linux-x64':   { target: 'x86_64-unknown-linux-musl', ext: 'tar.gz', binary: 'rg',     dir: 'x64-linux'    },
  'linux-arm64': { target: 'aarch64-unknown-linux-gnu', ext: 'tar.gz', binary: 'rg',     dir: 'arm64-linux'  },
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(__dirname, '..');

async function main() {
  const key = `${process.platform}-${process.arch}`;
  const info = PLATFORM_MAP[key];

  if (!info) {
    return requireSystemRipgrep(
      `there is no vendored ripgrep build for ${key}`,
    );
  }

  if (isLinuxArm64Musl()) {
    return requireSystemRipgrep(
      'the upstream release has no Linux ARM64 musl binary',
    );
  }

  const destDir = join(packageRoot, 'dist', 'vendor', 'ripgrep', info.dir);
  const destBinary = join(destDir, info.binary);

  if (existsSync(destBinary)) {
    // A file left by a build or interrupted install is not proof that it can
    // execute on this OS/architecture. Probe it before certifying the install.
    if (
      isUsableRipgrepCommand(destBinary, {
        requireFile: true,
      })
    ) {
      return;
    }
    rmSync(destBinary, { force: true });
  }

  const version = info.version ?? RG_VERSION;
  const archiveName = `ripgrep-${version}-${info.target}.${info.ext}`;
  const url = `https://github.com/BurntSushi/ripgrep/releases/download/${version}/${archiveName}`;
  // Use a private, unique directory. A predictable shared /tmp filename lets
  // concurrent installs corrupt each other's download and can follow a stale
  // symlink left by another local user.
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'tau-ripgrep-'));
  const tmpArchive = join(temporaryDirectory, archiveName);

  console.log(`[tau] Downloading ripgrep ${version} for ${key}...`);

  try {
    await download(url, tmpArchive);
    mkdirSync(destDir, { recursive: true });
    await extract(tmpArchive, info.ext, info.binary, destDir);
    if (process.platform !== 'win32') {
      await chmod(destBinary, 0o755);
    }
    if (
      !isUsableRipgrepCommand(destBinary, {
        requireFile: true,
      })
    ) {
      throw new Error('the downloaded ripgrep binary cannot run on this host');
    }
    console.log(`[tau] ripgrep installed at ${destBinary}`);
  } catch (err) {
    rmSync(destBinary, { force: true });
    if (isUsableRipgrepCommand('rg')) {
      console.log(
        `[tau] Vendored ripgrep unavailable (${err.message}); using the working system rg.`,
      );
      return;
    }
    throw new Error(
      `Unable to install ripgrep and no working system rg was found: ${err.message}`,
      { cause: err },
    );
  } finally {
    try { rmSync(temporaryDirectory, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/** Download url → dest, following redirects. */
function download(url, dest) {
  return new Promise((resolve, reject) => {
    function get(currentUrl, redirects = 0) {
      if (redirects > 5) return reject(new Error('Too many redirects'));
      const request = https.get(currentUrl, { headers: { 'User-Agent': 'tau-postinstall' } }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          res.resume(); // drain so the connection is freed
          const location = res.headers.location;
          if (!location) return reject(new Error(`Redirect without Location for ${currentUrl}`));
          let nextUrl;
          try {
            nextUrl = new URL(location, currentUrl);
          } catch {
            return reject(new Error(`Invalid redirect Location for ${currentUrl}`));
          }
          if (nextUrl.protocol !== 'https:') {
            return reject(new Error(`Refusing non-HTTPS redirect for ${currentUrl}`));
          }
          return get(nextUrl.href, redirects + 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} for ${currentUrl}`));
        }
        const file = createWriteStream(dest, { flags: 'wx' });
        res.pipe(file);
        file.on('finish', () => file.close(error => error ? reject(error) : resolve()));
        file.on('error', error => {
          res.destroy();
          reject(error);
        });
        res.on('error', error => {
          file.destroy();
          reject(error);
        });
      });
      request.setTimeout(60_000, () => {
        request.destroy(new Error(`Download timed out for ${currentUrl}`));
      });
      request.on('error', reject);
    }

    get(url);
  });
}

/**
 * Extract the ripgrep binary from the archive into destDir.
 *
 * Uses `tar` for both `.tar.gz` and `.zip`. On Linux/macOS that's the
 * system tar (GNU or BSD — either handles tar.gz fine). On Windows we
 * pin to the libarchive `tar.exe` in the SystemRoot/WINDIR System32 directory
 * Windows 10 1803 — the only tool guaranteed to be present that can read
 * ZIPs without PowerShell. We avoid PATH on Windows because dev shells
 * (Git Bash, WSL, MSYS2) commonly shadow it with GNU tar, which can't
 * read ZIPs. If no usable tar is found we throw and the caller falls
 * back to system `rg` at runtime.
 */
async function extract(archivePath, ext, binaryName, destDir) {
  const tarBin = resolveTarBin(ext);
  if (!tarBin) {
    throw new Error(
      process.platform === 'win32'
        ? 'No ZIP-capable extractor found in the Windows System32 directory.'
        : '`tar` not found on PATH.'
    );
  }

  // Extract into a tmp sibling, then promote the binary so the layout
  // matches what the runtime expects regardless of how the archive nests.
  const stagingDir = mkdtempSync(
    join(dirname(destDir), `.${basename(destDir)}-extract-`),
  );

  // Copy the archive into the staging dir and run tar with that dir as
  // cwd. bsdtar can mis-parse arguments like `C:\path` as a `host:path`
  // SSH spec; passing only the basename + cwd keeps every tar argument
  // colon-free and works identically on every platform.
  const archiveBase = basename(archivePath);
  const stagingArchive = join(stagingDir, archiveBase);
  try {
    copyFileSync(archivePath, stagingArchive);

    const args = ext === 'tar.gz' ? ['-xzf', archiveBase] : ['-xf', archiveBase];
    const result = spawnSync(tarBin, args, { cwd: stagingDir, stdio: 'pipe' });
    if (result.status !== 0) {
      throw new Error(`tar extraction failed: ${result.stderr?.toString().trim() || `exit ${result.status}`}`);
    }

    const found = findBinary(stagingDir, binaryName);
    if (!found) {
      throw new Error(`Binary ${binaryName} not found in archive ${archivePath}.`);
    }
    renameSync(found, join(destDir, binaryName));
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }
}

function requireSystemRipgrep(reason) {
  if (isUsableRipgrepCommand('rg')) {
    console.log(`[tau] ${reason}; using the working system rg.`);
    return;
  }
  throw new Error(
    `Tau requires ripgrep for search, but ${reason} and no working system rg was found.`,
  );
}

/**
 * Pick the right tar binary for the archive type. Returns the path to a
 * working extractor, or null if none is available.
 */
function resolveTarBin(ext) {
  if (process.platform === 'win32' && ext === 'zip') {
    // Pin to the absolute path so Git Bash / WSL / MSYS2 GNU tar can't
    // shadow Windows' libarchive bsdtar (the only one that reads ZIPs).
    const bsdtar = resolveWindowsSystemExecutable('tar.exe');
    if (!bsdtar) return null;
    const probe = spawnSync(bsdtar, ['--version'], { stdio: 'pipe' });
    return probe.status === 0 ? bsdtar : null;
  }
  // Linux/macOS use tar.gz — GNU tar or bsdtar both handle it fine.
  const probe = spawnSync('tar', ['--version'], { stdio: 'ignore' });
  return probe.status === 0 ? 'tar' : null;
}

/** Recursively locate a file by exact name under root. */
function findBinary(root, name) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = findBinary(full, name);
      if (nested) return nested;
    } else if (entry.name === name) {
      return full;
    }
  }
  return null;
}

/**
 * Pre-pull the approved Ollama cloud aliases so the /models picker shows
 * them as ready to use. Cloud aliases resolve instantly (just register a
 * client-side reference), so the cost is a handful of fast round-trips.
 * Any failure — Ollama not installed, daemon not running, network hiccup,
 * model missing — is swallowed; first-launch code retries what's missing.
 */
function primeOllamaCloudModels() {
  if (process.env.TAU_SKIP_OLLAMA_PREPULL === '1') return;
  // Detect ollama CLI first so we skip silently on machines without it.
  const probe = spawnSync('ollama', ['--version'], { stdio: 'ignore', timeout: 5000 });
  if (probe.status !== 0) return;

  console.log(`[tau] Pre-pulling ${OLLAMA_CLOUD_MODELS.length} Ollama cloud aliases...`);
  let ok = 0;
  let fail = 0;
  for (const model of OLLAMA_CLOUD_MODELS) {
    const res = spawnSync('ollama', ['pull', model], {
      stdio: 'ignore',
      timeout: 60_000,
    });
    if (res.status === 0) ok += 1; else fail += 1;
  }
  console.log(`[tau] Ollama pre-pull: ${ok} ok, ${fail} skipped/failed (first launch will retry).`);
}

/**
 * Verify every runtime dependency landed in node_modules, with a progress
 * bar, and repair the tree if an interrupted/locked install left holes.
 * Skipped when this postinstall was itself triggered by a repair run
 * (TAU_REPAIR=1) to avoid recursion. A dependency tree that remains broken
 * is fatal so the lifecycle-completion marker cannot certify it.
 */
async function verifyDependencyTree() {
  if (process.env.TAU_REPAIR === '1') return;
  const { ensureDeps, manualFixInstructions } = await import('./verify-deps.mjs');
  console.log('[tau] Verifying runtime dependencies...');
  // The completion marker is deliberately written after every postinstall
  // step below. Do not interpret its temporary absence as a repair request.
  const ok = ensureDeps(packageRoot, {
    repair: true,
    skipLifecycleMarker: true,
  });
  if (!ok) {
    throw new Error(manualFixInstructions('@abdoknbgit/tau'));
  }
}

function runOptionalNativeBuild(scriptName, requiredEnvName) {
  const script = join(packageRoot, 'scripts', scriptName);
  if (!existsSync(script)) return;

  const result = spawnSync(process.execPath, [script], {
    cwd: packageRoot,
    stdio: 'inherit',
    windowsHide: true,
    env: {
      ...process.env,
      [requiredEnvName]: process.env[requiredEnvName] ?? '0',
    },
  });

  if (result.status !== 0 && process.env[requiredEnvName] === '1') {
    process.exit(result.status ?? 1);
  }
}

function buildOptionalNativeTools() {
  if (process.env.TAU_SKIP_NATIVE_TOOLS_POSTINSTALL === '1') return;

  runOptionalNativeBuild('build-native-shell-parser.mjs', 'TAU_REQUIRE_NATIVE_SHELL_PARSER');
  runOptionalNativeBuild('build-native-tools.mjs', 'TAU_REQUIRE_NATIVE_TOOLS');
}

async function runPostinstall() {
  // Invalidate a previous same-version install before doing any work. If this
  // run fails, the missing marker makes the updater repair it on next launch.
  const {
    clearLifecycleCompletionMarker,
    writeLifecycleCompletionMarker,
  } = await import('./verify-deps.mjs');
  clearLifecycleCompletionMarker(packageRoot);

  await main();

  await verifyDependencyTree();
  try { buildOptionalNativeTools(); } catch { /* native accelerators are optional */ }
  try { primeOllamaCloudModels(); } catch { /* first launch retries */ }

  // This is the final mandatory operation. A missing marker lets the verifier
  // distinguish npm 12's exit-0/script-blocked install from a completed one.
  writeLifecycleCompletionMarker(packageRoot);
}

runPostinstall().catch(error => {
  console.error(`[tau] postinstall failed: ${error?.message ?? error}`);
  process.exitCode = 1;
});
