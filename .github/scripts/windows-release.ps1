param(
  [Parameter(Mandatory=$true)][string]$ProducerDirectory,
  [Parameter(Mandatory=$true)][string]$Snapshot,
  [Parameter(Mandatory=$true)][string]$OutputDirectory
)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$producer = Join-Path $ProducerDirectory 'W1.exe'
$cross = Get-Content (Join-Path $ProducerDirectory 'cross-producer.json') -Raw | ConvertFrom-Json
if ((Get-FileHash $producer -Algorithm SHA256).Hash.ToLowerInvariant() -cne $cross.output) {
  throw 'Cross compiler digest differs'
}
& "$root/compiler/fixtures/windows-runtime/run-compiler.ps1" -Compiler $producer -OutputDirectory $OutputDirectory -SelfHost `
  -SourceRoot $Snapshot -LlvmBin (Split-Path $env:SILK_TEST_CLANG)
$n2 = Join-Path $OutputDirectory 'N2.exe'
& $n2 build "$Snapshot/tool/src/main.silk" -o "$OutputDirectory/silk.exe" --stdlib "$Snapshot/stdlib" `
  --clang $env:SILK_TEST_CLANG --optimization speed --debug false
if ($LASTEXITCODE -ne 0) { throw 'Native tool build failed' }
node "$root/compiler/scripts/CompilerRelease.mjs" verify-build $n2 $Snapshot
if ($LASTEXITCODE -ne 0) { throw 'Compiler identity differs' }
node "$root/compiler/scripts/SourceSnapshot.mjs" verify $Snapshot > $null
if ($LASTEXITCODE -ne 0) { throw 'Native build changed authored inputs' }
$snapshotReceipt = Get-Content "$Snapshot/input-snapshot.json" -Raw | ConvertFrom-Json
$producerIr = (Get-FileHash "$OutputDirectory/producer.ll" -Algorithm SHA256).Hash.ToLowerInvariant()
$outputIr = (Get-FileHash "$OutputDirectory/n2.ll" -Algorithm SHA256).Hash.ToLowerInvariant()
if ($producerIr -cne $outputIr) { throw 'Native IR fixpoint differs' }
$receipt = @{
  schemaVersion = 2; status = 'passed'; target = 'x86_64-pc-windows-msvc'
  profile = @{ optimization = 'speed'; debug = $false; profileGuided = $false }
  origin = 'cross-compiled-native-chain'; crossProducerSha256 = $cross.producer
  producer = @{ generation = 'W1'; sha256 = $cross.output }
  output = @{ generation = 'N2'; sha256 = (Get-FileHash $n2 -Algorithm SHA256).Hash.ToLowerInvariant() }
  inputs = $snapshotReceipt
  fixpoint = @{ producerIrSha256 = $producerIr; outputIrSha256 = $outputIr }
}
[IO.File]::WriteAllText((Join-Path $OutputDirectory 'chain-receipt.json'), ($receipt | ConvertTo-Json -Depth 20))
$version = & $n2 --version
if ($LASTEXITCODE -ne 0 -or $version -notmatch '^silk v') { throw 'Native compiler version missing' }
[IO.File]::WriteAllText((Join-Path $OutputDirectory 'version.txt'), $version.Substring(6).Trim())
