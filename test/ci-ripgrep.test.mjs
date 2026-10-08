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
    // Mock only command availability, Chocolatey, ripgrep and sleeping. Execute
    // the real setup script in PowerShell; never install packages on the host.
    writeFileSync(harness, `
param([string]$Helper, [string]$Scenario)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
$global:fixture = @{ attempts = 0; probes = 0; sleeps = @(); installed = ($Scenario -eq 'installed'); status = 0; error = '' }
function global:Get-Command {
  param([string]$Name)
  if ($Name -eq 'rg') { if ($global:fixture.installed) { return $true }; return $null }
  if ($Name -eq 'choco') { if ($Scenario -ne 'no-choco') { return $true }; return $null }
  throw "Unexpected lookup: $Name"
}
function global:rg {
  if (-not $global:fixture.installed) { throw 'Attempted to run missing rg' }
  $global:fixture.probes++
  $global:LASTEXITCODE = if ($Scenario -eq 'broken-rg') { 1 } else { 0 }
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
function global:Start-Sleep { param([int]$Seconds); $global:fixture.sleeps += $Seconds }
try {
  & $Helper
  $global:fixture.status = $LASTEXITCODE
} catch {
  $global:fixture.status = 1
  $global:fixture.error = $_.Exception.Message
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
})

for (const [scenario, attempts, probes, exit] of [
  ['installed', 0, 1, 0],
  ['success', 1, 1, 0],
  ['transient', 3, 1, 0],
  ['permanent', 3, 0, 1],
  ['missing-rg', 3, 0, 1],
  ['broken-rg', 3, 3, 1],
  ['no-choco', 0, 0, 1],
]) {
  test(`Windows ripgrep setup: ${scenario}`, { skip: !hasPowerShell }, () => {
    const result = runScenario(scenario)
    assert.equal(result.exit, exit, result.error)
    assert.equal(result.attempts, attempts)
    assert.equal(result.probes, probes)
    assert.deepEqual(result.sleeps, attempts === 3 ? [2, 4] : [])
    if (exit && scenario !== 'no-choco') assert.match(result.error, /after 3 installation attempts/)
    if (scenario === 'no-choco') assert.match(result.error, /Chocolatey is not installed/)
  })
}
