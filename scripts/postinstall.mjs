#!/usr/bin/env node
/**
 * Tau postinstall — downloads the platform-correct ripgrep binary
 * and pre-pulls the approved Ollama cloud model aliases.
 *
 * Runs automatically after `npm install -g @abdoknbgit/tau`.
 * Skips silently on any error so a network hiccup never breaks the install.
 * The CLI falls back to a system `rg` if the vendored binary is absent,
 * and first-launch code will retry any missed Ollama pulls.
 */

import { existsSync, mkdirSync, createWriteStream, unlinkSync, readdirSync, renameSync, rmSync, copyFileSync } from 'fs';
import { chmod } from 'fs/promises';
import { resolve, dirname, join, basename } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import https from 'https';
import { tmpdir } from 'os';

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
  'win32-arm64': { target: 'aarch64-pc-windows-msvc',  ext: 'zip',    binary: 'rg.exe', dir: 'arm64-win32'  },
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
    console.log(`[tau] ripgrep: unsupported platform ${key}, skipping download (system rg will be used)`);
    return;
  }

  const destDir = join(packageRoot, 'dist', 'vendor', 'ripgrep', info.dir);
  const destBinary = join(destDir, info.binary);

  if (existsSync(destBinary)) {
    // Already present (e.g. local dev build that bundled it)
    return;
  }

  const archiveName = `ripgrep-${RG_VERSION}-${info.target}.${info.ext}`;
  const url = `https://github.com/BurntSushi/ripgrep/releases/download/${RG_VERSION}/${archiveName}`;
  const tmpArchive = join(tmpdir(), archiveName);

  console.log(`[tau] Downloading ripgrep ${RG_VERSION} for ${key}...`);

  try {
    await download(url, tmpArchive);
    mkdirSync(destDir, { recursive: true });
    await extract(tmpArchive, info.ext, info.binary, destDir);
    if (process.platform !== 'win32') {
      await chmod(destBinary, 0o755);
    }
    console.log(`[tau] ripgrep installed at ${destBinary}`);
  } catch (err) {
    console.warn(`[tau] ripgrep download failed (${err.message}). The Grep tool will fall back to system rg.`);
  } finally {
    try { if (existsSync(tmpArchive)) unlinkSync(tmpArchive); } catch { /* ignore */ }
  }
}

/** Download url → dest, following redirects. */
function download(url, dest) {
  return new Promise((resolve, reject) => {
    function get(currentUrl, redirects = 0) {
      if (redirects > 5) return reject(new Error('Too many redirects'));
      https.get(currentUrl, { headers: { 'User-Agent': 'tau-postinstall' } }, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) {
          res.resume(); // drain so the connection is freed
          return get(res.headers.location, redirects + 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} for ${currentUrl}`));
        }
        const file = createWriteStream(dest);
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve()));
        file.on('error', reject);
        res.on('error', reject);
      }).on('error', reject);
    }

    get(url);
  });
}

/**
 * Extract the ripgrep binary from the archive into destDir.
 *
 * Uses `tar` for both `.tar.gz` and `.zip`. On Linux/macOS that's the
 * system tar (GNU or BSD — either handles tar.gz fine). On Windows we
 * pin to the libarchive `bsdtar.exe` shipped at C:\Windows\System32 since
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
        ? 'No ZIP-capable extractor found. Need C:\\Windows\\System32\\tar.exe (ships with Windows 10 1803+).'
        : '`tar` not found on PATH.'
    );
  }

  // Extract into a tmp sibling, then promote the binary so the layout
  // matches what the runtime expects regardless of how the archive nests.
  const stagingDir = `${destDir}_tmp`;
  rmSync(stagingDir, { recursive: true, force: true });
  mkdirSync(stagingDir, { recursive: true });

  // Copy the archive into the staging dir and run tar with that dir as
  // cwd. bsdtar can mis-parse arguments like `C:\path` as a `host:path`
  // SSH spec; passing only the basename + cwd keeps every tar argument
  // colon-free and works identically on every platform.
  const archiveBase = basename(archivePath);
  const stagingArchive = join(stagingDir, archiveBase);
  copyFileSync(archivePath, stagingArchive);

  const args = ext === 'tar.gz' ? ['-xzf', archiveBase] : ['-xf', archiveBase];
  const result = spawnSync(tarBin, args, { cwd: stagingDir, stdio: 'pipe' });
  unlinkSync(stagingArchive);
  if (result.status !== 0) {
    rmSync(stagingDir, { recursive: true, force: true });
    throw new Error(`tar extraction failed: ${result.stderr?.toString().trim() || `exit ${result.status}`}`);
  }

  const found = findBinary(stagingDir, binaryName);
  if (!found) {
    rmSync(stagingDir, { recursive: true, force: true });
    throw new Error(`Binary ${binaryName} not found in archive ${archivePath}.`);
  }
  renameSync(found, join(destDir, binaryName));
  rmSync(stagingDir, { recursive: true, force: true });
}

/**
 * Pick the right tar binary for the archive type. Returns the path to a
 * working extractor, or null if none is available.
 */
function resolveTarBin(ext) {
  if (process.platform === 'win32' && ext === 'zip') {
    // Pin to the absolute path so Git Bash / WSL / MSYS2 GNU tar can't
    // shadow Windows' libarchive bsdtar (the only one that reads ZIPs).
    const bsdtar = 'C:\\Windows\\System32\\tar.exe';
    if (!existsSync(bsdtar)) return null;
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

function buildOptionalNativeTools() {
  if (process.env.TAU_SKIP_NATIVE_TOOLS_POSTINSTALL === '1') return;

  const script = join(packageRoot, 'scripts', 'build-native-tools.mjs');
  if (!existsSync(script)) return;

  const result = spawnSync(process.execPath, [script], {
    cwd: packageRoot,
    stdio: 'inherit',
    windowsHide: true,
    env: {
      ...process.env,
      TAU_REQUIRE_NATIVE_TOOLS: process.env.TAU_REQUIRE_NATIVE_TOOLS ?? '0',
    },
  });

  if (result.status !== 0 && process.env.TAU_REQUIRE_NATIVE_TOOLS === '1') {
    process.exit(result.status ?? 1);
  }
}

main()
  .catch(() => { /* never propagate — ripgrep is optional */ })
  .finally(() => {
    try { buildOptionalNativeTools(); } catch { /* swallow */ }
    try { primeOllamaCloudModels(); } catch { /* swallow */ }
    process.exit(0);
  });
