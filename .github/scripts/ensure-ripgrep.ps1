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
if (-not (Get-Command choco -ErrorAction SilentlyContinue)) {
  throw 'ripgrep is unavailable and Chocolatey is not installed.'
}

$installStatus = 1
for ($attempt = 1; $attempt -le 3; $attempt++) {
  & choco install ripgrep --yes --no-progress
  $installStatus = $LASTEXITCODE
  if ($installStatus -eq 0 -and (Test-UsableRipgrep)) { exit 0 }
  if ($attempt -lt 3) {
    Write-Warning "ripgrep setup failed (attempt $attempt/3, Chocolatey exit $installStatus); retrying..."
    Start-Sleep -Seconds (2 * $attempt)
  }
}

throw "ripgrep is unavailable after 3 installation attempts (last Chocolatey exit code: $installStatus)."
