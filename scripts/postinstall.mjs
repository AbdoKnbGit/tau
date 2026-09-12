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

import { existsSync, mkdirSync, mkdtempSync, createWriteStream, createReadStream, readdirSync, renameSync, rmSync, copyFileSync, realpathSync } from 'fs';
import { chmod } from 'fs/promises';
import { createHash } from 'node:crypto';
import { resolve, dirname, join, basename } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { spawnSync } from 'child_process';
import https from 'https';
import { tmpdir } from 'os';
import {
  isLinuxArm64Musl,
  getRipgrepVersion,
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

// Pinned to the latest stable upstream release reviewed on 2026-09-12.
// Digests below are the release asset SHA-256 values published by GitHub:
// https://github.com/BurntSushi/ripgrep/releases/tag/15.2.0
export const RG_VERSION = '15.2.0';

// Map Node's (platform-arch) pair to the ripgrep release info
const PLATFORM_MAP = {
  'win32-x64':   { target: 'x86_64-pc-windows-msvc',   ext: 'zip',    binary: 'rg.exe', dir: 'x64-win32',   sha256: '71b2fef860abe467217a538ff31de02f5258807c0129f771846f87bd029aafc5' },
  'win32-arm64': { target: 'aarch64-pc-windows-msvc',  ext: 'zip',    binary: 'rg.exe', dir: 'arm64-win32', sha256: 'e4abca10c3a64ebea742667dd7009449d49403db5460dd6873e389fa2945360f' },
  'darwin-x64':  { target: 'x86_64-apple-darwin',       ext: 'tar.gz', binary: 'rg',     dir: 'x64-darwin',  sha256: 'af7825fcc69a2afc7a7aea55fc9af90e26421d8f20fe59df32e233c0b8a231c1' },
  'darwin-arm64':{ target: 'aarch64-apple-darwin',      ext: 'tar.gz', binary: 'rg',     dir: 'arm64-darwin',sha256: '3750b2e93f37e0c692657da574d7019a101c0084da05a790c83fd335bad973e4' },
  'linux-x64':   { target: 'x86_64-unknown-linux-musl', ext: 'tar.gz', binary: 'rg',     dir: 'x64-linux',   sha256: '33e15bcf1624b25cdd2a55813a47a2f95dbe126268203e76aa6a585d1e7b149c' },
  'linux-arm64': { target: 'aarch64-unknown-linux-gnu', ext: 'tar.gz', binary: 'rg',     dir: 'arm64-linux', sha256: 'a740b91c82eaf9914cfedd353572f2791cbe0162c84101ee0951058f4dcbc90d' },
  'linux-arm64-musl': { target: 'aarch64-unknown-linux-musl', ext: 'tar.gz', binary: 'rg', dir: 'arm64-linux', sha256: '800b1e7206afe799dfb5a6901f23147cfaabe0e52210538100f61e86e1740915' },
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(__dirname, '..');

export function resolveRipgrepRelease({ platform = process.platform, arch = process.arch, getReport } = {}) {
  const key = `${platform}-${arch}${isLinuxArm64Musl({ platform, arch, getReport }) ? '-musl' : ''}`;
  const info = PLATFORM_MAP[key];
  return info ? { ...info, version: RG_VERSION } : null;
}

/** Install only ripgrep; also used by --ripgrep-only without other lifecycles. */
export async function installRipgrep({
  root = packageRoot,
  platform = process.platform,
  arch = process.arch,
  getReport,
  temporaryRoot = tmpdir(),
  downloadImpl = download,
  verifyArchiveImpl = verifyRipgrepArchive,
  extractImpl = extract,
  versionImpl = getRipgrepVersion,
  renameImpl = renameSync,
  log = console.log,
} = {}) {
  const key = `${platform}-${arch}`;
  const info = resolveRipgrepRelease({ platform, arch, getReport });

  if (!info) {
    return requireSystemRipgrep(
      `there is no vendored ripgrep build for ${key}`,
      versionImpl,
      log,
    );
  }

  const destDir = join(root, 'dist', 'vendor', 'ripgrep', info.dir);
  const destBinary = join(destDir, info.binary);
  const version = info.version;
  // An older executable can still be usable; that must not suppress upgrades.
  if (versionImpl(destBinary, { requireFile: true }) === version) return;
  const archiveName = `ripgrep-${version}-${info.target}.${info.ext}`;
  const url = `https://github.com/BurntSushi/ripgrep/releases/download/${version}/${archiveName}`;
  let temporaryDirectory;
  let stagingDir;

  log(`[tau] Downloading ripgrep ${version} for ${key}...`);

  try {
    // Use a private, unique directory. A predictable shared /tmp filename lets
    // concurrent installs corrupt each other's download and can follow a stale
    // symlink left by another local user. Creation failures use the same safe
    // fallback as download failures rather than breaking a working install.
    temporaryDirectory = mkdtempSync(join(temporaryRoot, 'tau-ripgrep-'));
    const tmpArchive = join(temporaryDirectory, archiveName);
    await downloadImpl(url, tmpArchive);
    await verifyArchiveImpl(tmpArchive, info.sha256);
    mkdirSync(destDir, { recursive: true });
    // Stage on the destination filesystem for an atomic replacement. Keep a
    // working old binary in place until the new archive and executable pass.
    stagingDir = mkdtempSync(join(dirname(destDir), `.${basename(destDir)}-install-`));
    const stagedBinary = join(stagingDir, info.binary);
    await extractImpl(tmpArchive, info.ext, info.binary, stagingDir);
    if (platform !== 'win32') {
      await chmod(stagedBinary, 0o755);
    }
    if (versionImpl(stagedBinary, { requireFile: true }) !== version) {
      throw new Error(`the downloaded ripgrep binary cannot run as version ${version} on this host`);
    }
    renameImpl(stagedBinary, destBinary);
    log(`[tau] ripgrep ${version} installed at ${destBinary}`);
  } catch (err) {
    const existingVersion = versionImpl(destBinary, { requireFile: true });
    if (existingVersion) {
      log(`[tau] Could not update ripgrep to ${version} (${err.message}); keeping working vendored ripgrep ${existingVersion}.`);
      return;
    }
    if (versionImpl('rg')) {
      log(
        `[tau] Vendored ripgrep unavailable (${err.message}); using the working system rg.`,
      );
      return;
    }
    throw new Error(
      `Unable to install ripgrep and no working system rg was found: ${err.message}`,
      { cause: err },
    );
  } finally {
    if (stagingDir) {
      try { rmSync(stagingDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    if (temporaryDirectory) {
      try { rmSync(temporaryDirectory, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
}

/** Verify the pinned upstream digest before unpacking or executing a download. */
export async function verifyRipgrepArchive(archivePath, expectedSha256) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(archivePath)) hash.update(chunk);
  if (hash.digest('hex') !== expectedSha256) {
    throw new Error('ripgrep archive SHA-256 checksum mismatch');
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

function requireSystemRipgrep(reason, versionImpl, log) {
  if (versionImpl('rg')) {
    log(`[tau] ${reason}; using the working system rg.`);
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

  await installRipgrep();

  await verifyDependencyTree();
  // Users never compile Rust or download a speech model: the addon arrives
  // prebuilt. Trimmed or partial trees (repair fixtures, vendored subsets) may
  // not carry the voice helper at all, which is not an install failure.
  const voiceHelper = join(packageRoot, 'scripts', 'native-voice.mjs');
  if (existsSync(voiceHelper)) await verifyBundledVoice();
  try { buildOptionalNativeTools(); } catch { /* native accelerators are optional */ }
  try { primeOllamaCloudModels(); } catch { /* first launch retries */ }

  // This is the final mandatory operation. A missing marker lets the verifier
  // distinguish npm 12's exit-0/script-blocked install from a completed one.
  writeLifecycleCompletionMarker(packageRoot);
}

/**
 * Reports whether this host's voice addon is usable. Never fails the install.
 *
 * Voice is an optional dependency behind a paid plan, so most installs never
 * load it and none of them should break because of it. Everything that can go
 * wrong here -- a glibc or macOS older than the build floor, an antivirus
 * quarantine, a truncated download, a corrupted file -- used to abort the
 * install and leave the lifecycle marker unwritten, condemning a working CLI
 * over a feature the user may not even have access to.
 *
 * Nothing is lost by reporting instead. The integrity check that protects the
 * user runs again in-process, in loadNativeVoice, immediately before the addon
 * is executed: a tampered binary still never runs. This check is an early
 * warning, not the gate.
 */
async function verifyBundledVoice() {
  try {
    await checkBundledVoice();
  } catch (error) {
    console.log(`[tau] Voice audio is unavailable on this host: ${error?.message ?? error}`);
    console.log('[tau] The rest of Tau is unaffected; /hey will report the same reason.');
  }
}

async function checkBundledVoice() {
  const { nativeVoiceTarget, nativeVoiceLoadPath, resolveNativeVoiceArtifact, voicePackageNameFor } =
    await import('./native-voice.mjs');
  let voiceTarget = null;
  try { voiceTarget = nativeVoiceTarget(); } catch (error) { console.log(`[tau] ${error.message}`); }
  if (voiceTarget) {
    // The addon arrives as a per-platform optional dependency, so npm can
    // legitimately skip it (unsupported host, or no network). That is not an
    // install failure: voice degrades and the rest of Tau works. A binary that
    // is present but fails its integrity check still fails the install, because
    // that means tampering or corruption rather than absence.
    if (existsSync(resolveNativeVoiceArtifact(packageRoot, voiceTarget).path)) {
      const { createRequire } = await import('node:module');
      const voice = createRequire(import.meta.url)(nativeVoiceLoadPath(packageRoot));
      if (voice.voiceAbiVersion?.() !== 1 || typeof voice.AudioCapture !== 'function' || typeof voice.LiveWebRtcPeer !== 'function') {
        throw new Error('The Tau audio component is incompatible. Reinstall Tau.');
      }
      console.log('[tau] Native voice ready (no Rust or speech-model installation required).');
    } else {
      console.log(`[tau] Voice audio (${voicePackageNameFor(voiceTarget)}) was not installed; /hey stays unavailable until it is. The rest of Tau is unaffected.`);
    }
  }
}

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  const operation = process.argv.includes('--ripgrep-only') ? installRipgrep : runPostinstall;
  operation().catch(error => {
    console.error(`[tau] postinstall failed: ${error?.message ?? error}`);
    process.exitCode = 1;
  });
}
