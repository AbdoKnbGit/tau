import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const helper = join(root, '.github', 'scripts', 'ensure-ripgrep.ps1')
const hasPowerShell = spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0'], { windowsHide: true }).status === 0

function runScenario(scenario) {
  const temp = mkdtempSync(join(tmpdir(), 'tau-ci-ripgrep-'))
  try {
    const harness = join(temp, 'runner.ps1')
    // Mock command availability, both installers, ripgrep and sleeping. Execute
    // the real setup script in PowerShell; never install packages on the host.
    writeFileSync(harness, `
param([string]$Helper, [string]$Scenario)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
$env:GITHUB_PATH = Join-Path $PSScriptRoot 'github-path'
$global:fixture = @{ attempts = 0; upstream = 0; probes = 0; sleeps = @(); installed = ($Scenario -eq 'installed'); status = 0; error = ''; exported = '' }
function global:Get-Command {
  param([string]$Name)
  if ($Name -eq 'rg') { if ($global:fixture.installed) { return $true }; return $null }
  if ($Name -eq 'choco') { if ($Scenario -notin @('no-choco', 'upstream-no-choco')) { return $true }; return $null }
  throw "Unexpected lookup: $Name"
}
function global:rg {
  if (-not $global:fixture.installed) { throw 'Attempted to run missing rg' }
  $global:fixture.probes++
  $global:LASTEXITCODE = if ($Scenario -in @('broken-rg', 'upstream-broken')) { 1 } else { 0 }
  'ripgrep test version'
}
function global:choco {
  if (($args -join ' ') -ne 'install ripgrep --yes --no-progress') { throw 'Unexpected install arguments' }
  $global:fixture.attempts++
  $succeeds = $Scenario -eq 'success' -or $Scenario -eq 'missing-rg' -or $Scenario -eq 'broken-rg' -or ($Scenario -eq 'transient' -and $global:fixture.attempts -eq 3)
  if ($succeeds -and $Scenario -ne 'missing-rg') { $global:fixture.installed = $true }
  # A real nonzero native exit checks PowerShell's error-preference handling.
  if ($succeeds) { & $env:TAU_CI_TEST_NODE -e 'process.exit(0)' }
  else { & $env:TAU_CI_TEST_NODE -e 'process.exit(1)' }
  $global:LASTEXITCODE = $LASTEXITCODE
}
function global:node {
  if (($args -join ' ') -eq '-p process.arch') {
    $global:LASTEXITCODE = 0
    'x64'
    return
  }
  if ($args.Count -ne 2 -or $args[1] -ne '--ripgrep-only' -or $args[0] -notmatch 'scripts[/\\\\]postinstall\\.mjs$') {
    throw "Unexpected upstream installer arguments: $args"
  }
  $global:fixture.upstream++
  $succeeds = $Scenario -in @('upstream', 'upstream-no-choco', 'upstream-missing', 'upstream-broken')
  if ($succeeds -and $Scenario -ne 'upstream-missing') { $global:fixture.installed = $true }
  if ($succeeds) { & $env:TAU_CI_TEST_NODE -e 'process.exit(0)' }
  else { & $env:TAU_CI_TEST_NODE -e 'process.exit(1)' }
  $global:LASTEXITCODE = $LASTEXITCODE
}
function global:Start-Sleep { param([int]$Seconds); $global:fixture.sleeps += $Seconds }
try {
  & $Helper
  $global:fixture.status = $LASTEXITCODE
} catch {
  $global:fixture.status = 1
  $global:fixture.error = $_.Exception.Message
}
if (Test-Path -LiteralPath $env:GITHUB_PATH) {
  $global:fixture.exported = (Get-Content -LiteralPath $env:GITHUB_PATH -Raw).Trim()
}
Write-Output ('RESULT:' + ($global:fixture | ConvertTo-Json -Compress))
exit $global:fixture.status
`)
    const result = spawnSync('pwsh', ['-NoProfile', '-File', harness, helper, scenario], {
      encoding: 'utf8', windowsHide: true, timeout: 20_000,
      env: { ...process.env, TAU_CI_TEST_NODE: process.execPath },
    })
    assert.ifError(result.error)
    const line = result.stdout.split(/\r?\n/).find(line => line.startsWith('RESULT:'))
    assert.ok(line, `${result.stdout}\n${result.stderr}`)
    return { ...JSON.parse(line.slice(7)), exit: result.status }
  } finally {
    assert.equal(dirname(resolve(temp)), resolve(tmpdir()))
    assert.ok(temp.includes('tau-ci-ripgrep-'))
    rmSync(temp, { recursive: true, force: true })
  }
}

test('both Windows CI paths use the checked retry helper', () => {
  const workflow = readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8')
  assert.equal(workflow.split('.github/scripts/ensure-ripgrep.ps1').length - 1, 2)
  assert.ok(!workflow.includes('choco install ripgrep'))
  assert.ok(workflow.includes('export PATH="$PWD/dist/vendor/ripgrep/$(node -p process.arch)-win32:$PATH"'))
  assert.ok(workflow.includes('node --test test/provider-effort.test.mjs'))
})

for (const [scenario, attempts, probes, exit, upstream] of [
  ['installed', 0, 1, 0, 0],
  ['success', 1, 1, 0, 0],
  ['transient', 3, 1, 0, 0],
  ['permanent', 3, 0, 1, 1],
  ['missing-rg', 3, 0, 1, 1],
  ['broken-rg', 3, 3, 1, 1],
  ['no-choco', 0, 0, 1, 1],
  ['upstream', 3, 1, 0, 1],
  ['upstream-no-choco', 0, 1, 0, 1],
  ['upstream-missing', 3, 0, 1, 1],
  ['upstream-broken', 3, 1, 1, 1],
]) {
  test(`Windows ripgrep setup: ${scenario}`, { skip: !hasPowerShell }, () => {
    const result = runScenario(scenario)
    assert.equal(result.exit, exit, result.error)
    assert.equal(result.attempts, attempts)
    assert.equal(result.upstream, upstream)
    assert.equal(result.probes, probes)
    assert.deepEqual(result.sleeps, attempts === 3 ? [2, 4] : [])
    if (exit) assert.match(result.error, /after Chocolatey retries and the verified upstream fallback/)
    if (scenario === 'upstream' || scenario === 'upstream-no-choco') {
      assert.equal(resolve(result.exported), join(root, 'dist', 'vendor', 'ripgrep', 'x64-win32'))
    } else assert.equal(result.exported, '')
  })
}
