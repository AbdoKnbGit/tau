$ErrorActionPreference = 'Stop'
# Native installer failures must reach the retry loop, even on runners that
# enable PowerShell's native-command error preference.
$PSNativeCommandUseErrorActionPreference = $false

function Test-UsableRipgrep {
  if (-not (Get-Command rg -ErrorAction SilentlyContinue)) { return $false }
  $version = & rg --version
  $probeStatus = $LASTEXITCODE
  # Write-Host keeps version output out of the boolean return value.
  $version | Write-Host
  return ($probeStatus -eq 0)
}

if (Test-UsableRipgrep) { exit 0 }
$installStatus = 1
if (Get-Command choco -ErrorAction SilentlyContinue) {
  for ($attempt = 1; $attempt -le 3; $attempt++) {
    & choco install ripgrep --yes --no-progress
    $installStatus = $LASTEXITCODE
    if ($installStatus -eq 0 -and (Test-UsableRipgrep)) { exit 0 }
    if ($attempt -lt 3) {
      Write-Warning "ripgrep setup failed (attempt $attempt/3, Chocolatey exit $installStatus); retrying..."
      Start-Sleep -Seconds (2 * $attempt)
    }
  }
}

# Chocolatey's feed can be unavailable even when it reports exit code zero.
# Reuse Tau's pinned, SHA-256-verified upstream installer, without npm or other
# postinstall tasks. Node is already installed by both callers of this helper.
Write-Warning 'Chocolatey did not provide ripgrep; trying the verified upstream release.'
$repositoryRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
& node (Join-Path $repositoryRoot 'scripts/postinstall.mjs') --ripgrep-only
$upstreamStatus = $LASTEXITCODE
if ($upstreamStatus -eq 0) {
  $architecture = & node -p process.arch
  if ($LASTEXITCODE -eq 0 -and $architecture -in @('x64', 'arm64')) {
    $vendorDirectory = Join-Path $repositoryRoot "dist/vendor/ripgrep/$architecture-win32"
    $env:PATH = "$vendorDirectory;$env:PATH"
    if (Test-UsableRipgrep) {
      # Current PowerShell callers use PATH above; subsequent Actions steps
      # receive this entry through GITHUB_PATH. Bash callers also export it.
      if ($env:GITHUB_PATH) { Add-Content -LiteralPath $env:GITHUB_PATH -Value $vendorDirectory -Encoding utf8 }
      exit 0
    }
  }
}

throw "ripgrep is unavailable after Chocolatey retries and the verified upstream fallback (exit code: $upstreamStatus)."
