param(
  [Parameter(Mandatory=$true)][string]$CrossDirectory,
  [Parameter(Mandatory=$true)][string]$ReleaseDirectory,
  [Parameter(Mandatory=$true)][string]$Snapshot,
  [Parameter(Mandatory=$true)][string]$OutputDirectory,
  [Parameter(Mandatory=$true)][string]$ProducerSha256
)
# The Windows half of release-check.sh: the compiler from the cross-built ZIP emits its own IR,
# which must match the IR N1 emitted on Linux, and rebuilds the silk tool, which must be the ZIP's
# bytes (a full link on Windows that takes nothing from the host).
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$target = 'x86_64-pc-windows-msvc'
$cross = Join-Path $CrossDirectory $target
$version = (Get-Content (Join-Path $CrossDirectory 'version.txt') -Raw).Trim()
function Hash([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }

$unpacked = Join-Path $OutputDirectory 'unpacked'
New-Item -ItemType Directory -Force -Path $unpacked | Out-Null
Expand-Archive -LiteralPath (Join-Path $ReleaseDirectory "silk-$version-$target.zip") -DestinationPath $unpacked
$top = Join-Path $unpacked "silk-$version-$target"
$compiler = Join-Path $top 'bin/silkc.exe'

$native = (Resolve-Path -LiteralPath $OutputDirectory).Path
$arguments = @('--target', $target, '--stdlib', '../stdlib', '--optimization', 'speed', '--debug', 'false', '--clang', $env:SILK_TEST_CLANG)
Push-Location (Join-Path $Snapshot 'compiler')
try {
  & $compiler build src/main.silk -o (Join-Path $native 'compiler.ll') --emit llvm-ir @arguments
  if ($LASTEXITCODE -ne 0) { throw 'Native compiler IR emission failed' }
} finally { Pop-Location }
Push-Location (Join-Path $Snapshot 'tool')
try {
  & $compiler build src/main.silk -o (Join-Path $native 'silk.exe') @arguments
  if ($LASTEXITCODE -ne 0) { throw 'Native tool build failed' }
} finally { Pop-Location }
node "$root/compiler/scripts/SourceSnapshot.mjs" verify $Snapshot > $null
if ($LASTEXITCODE -ne 0) { throw 'Native build changed authored inputs' }

$compilerSha = Hash $compiler
$producerIr = (Get-Content (Join-Path $cross 'compiler.ll.sha256') -Raw).Trim()
$outputIr = Hash (Join-Path $native 'compiler.ll')
$differs = @()
if ((Hash (Join-Path $native 'silk.exe')) -cne (Hash (Join-Path $top 'bin/silk.exe'))) { $differs += 'tool' }
if ($producerIr -cne $outputIr) { $differs += "compiler IR (N1 $producerIr, native $outputIr)" }
if ($differs.Count -gt 0) {
  Write-Output "::error title=Native rebuild differs::$target did not rebuild the cross-built bytes: $($differs -join ', ')"
  throw 'Native rebuild differs'
}

$snapshotReceipt = Get-Content "$Snapshot/input-snapshot.json" -Raw | ConvertFrom-Json
$receipt = [ordered]@{
  schemaVersion = 2; status = 'passed'; target = $target
  profile = @{ optimization = 'speed'; debug = $false; profileGuided = $false }
  inputs = [ordered]@{
    sourceCommit = $snapshotReceipt.sourceCommit; normalizedDigest = $snapshotReceipt.normalizedDigest
    archiveSha256 = $snapshotReceipt.archiveSha256; files = $snapshotReceipt.files; projection = $snapshotReceipt.projection
  }
  origin = 'linux-cross-target-ir-fixpoint'
  producer = @{ generation = 'N1'; sha256 = $ProducerSha256 }
  output = @{ generation = 'N2'; sha256 = $compilerSha }
  fixpoint = @{ producerIrSha256 = $producerIr; outputIrSha256 = $outputIr }
}
[IO.File]::WriteAllText((Join-Path $native 'chain-receipt.json'), ($receipt | ConvertTo-Json -Depth 20))
Remove-Item -LiteralPath (Join-Path $native 'compiler.ll')
