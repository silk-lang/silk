param(
  [Parameter(Mandatory=$true)][string]$InstrumentedCompiler,
  [Parameter(Mandatory=$true)][string]$Project,
  [string]$Source='src/main.silk',
  [string]$Label='project'
)
# Opt-in measurement, not a correctness test or CI timing gate. See CACHE-WRITER.md.
# Use a disposable project: this restores its source but retains its measured cache files.
$ErrorActionPreference = 'Stop'
$compiler = (Resolve-Path -LiteralPath $InstrumentedCompiler).Path
$projectRoot = [IO.Path]::GetFullPath($Project)
$sourcePath = Join-Path $projectRoot $Source
$original = [IO.File]::ReadAllText($sourcePath)
$evidence = [IO.Path]::GetFullPath(".scratch/cache-probe-results-$Label-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $evidence | Out-Null
$arguments = @('check', '--manifest-path', (Join-Path $projectRoot 'silk.toml'), '--stdlib', [IO.Path]::GetFullPath('stdlib'))
function Checked([string]$Log) {
  $start = [Diagnostics.ProcessStartInfo]::new()
  $start.FileName = $compiler
  $start.Arguments = (@($arguments | ForEach-Object { '"' + ($_ -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"' }) -join ' ')
  $start.UseShellExecute=$false; $start.CreateNoWindow=$true
  $start.RedirectStandardOutput=$true; $start.RedirectStandardError=$true
  $process=[Diagnostics.Process]::new(); $process.StartInfo=$start
  try {
    $watch=[Diagnostics.Stopwatch]::StartNew()
    if(!$process.Start()) {throw 'Start failed'}
    $stdout=$process.StandardOutput.ReadToEndAsync(); $stderr=$process.StandardError.ReadToEndAsync()
    if(!$process.WaitForExit(600000)) { $process.Kill(); throw 'Check timed out' }
    $watch.Stop()
    [IO.File]::WriteAllText($Log, $stdout.GetAwaiter().GetResult()+$stderr.GetAwaiter().GetResult())
    if($process.ExitCode -ne 0) {throw "Check failed: $($process.ExitCode); $Log"}
    return $watch.Elapsed.TotalMilliseconds
  } finally { $process.Dispose() }
}
try {
  $env:SILK_CACHE_PROBE_RECONSTRUCT=$null
  $env:SILK_CACHE_PROBE_LOG=Join-Path $evidence 'seed.times'
  $seed=Checked (Join-Path $evidence 'seed.log')
  Copy-Item -LiteralPath (Join-Path $projectRoot 'build') -Destination (Join-Path $evidence 'baseline-build') -Recurse
  $rows=@()
  for($trial=1; $trial -le 3; $trial++) {
    # Changing a literal invalidates the same module for each contender. The worker gets exactly
    # the cache that preceded this edit, never the synchronous contender's completed image.
    $edit=$original.IndexOf('return 0')
    if($edit -lt 0) {throw 'Choose a source with a return 0 body to edit'}
    $changed=$original.Remove($edit,8).Insert($edit,('return ' + $trial))
    [IO.File]::WriteAllText($sourcePath,$changed)
    foreach($mode in @('synchronous','reconstruct')) {
      Copy-Item -Path (Join-Path $evidence 'baseline-build/*') -Destination (Join-Path $projectRoot 'build') -Recurse -Force
      $env:SILK_CACHE_PROBE_LOG=Join-Path $evidence "$trial-$mode.times"
      if($mode -eq 'synchronous') {
        $env:SILK_CACHE_PROBE_RECONSTRUCT=$null
        $wall=Checked (Join-Path $evidence "$trial-$mode.log")
      } else {
        $env:SILK_CACHE_PROBE_RECONSTRUCT='1'
        $result=& "$PSScriptRoot/cache-writer-detached.ps1" -Compiler $compiler -CompilerArguments $arguments | ConvertFrom-Json
        $wall=$result.wallMs
      }
      $times=@(Get-Content $env:SILK_CACHE_PROBE_LOG | ForEach-Object { [long](($_ -split ' ')[1]) })
      if(($mode -eq 'synchronous' -and $times.Count -ne 2) -or ($mode -eq 'reconstruct' -and $times.Count -ne 1)) {throw 'Missing persistence measurement'}
      $rows += @{trial=$trial; mode=$mode; readyUs=$times[0]; persistUs=$(if($times.Count -eq 2){$times[1]-$times[0]}else{$null}); wallMs=$wall}
    }
  }
  @{ label=$Label; compilerSha256=(Get-FileHash $compiler).Hash; seedWallMs=$seed; measurements=$rows } | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $evidence 'results.json')
  Get-Content (Join-Path $evidence 'results.json')
  Write-Output $evidence
} finally {
  [IO.File]::WriteAllText($sourcePath,$original)
  $env:SILK_CACHE_PROBE_LOG=$null; $env:SILK_CACHE_PROBE_RECONSTRUCT=$null
}
