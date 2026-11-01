param(
  [Parameter(Mandatory = $true)][string]$ArtifactDirectory,
  [string]$LlvmBin = "$env:USERPROFILE\silk-windows-tools\clang+llvm-22.1.8-x86_64-pc-windows-msvc\bin"
)
$ErrorActionPreference = 'Stop'
$artifact = (Resolve-Path -LiteralPath $ArtifactDirectory).Path
$readobj = Join-Path $LlvmBin 'llvm-readobj.exe'
$results = @()
$failed = $false
foreach ($name in @('hello', 'hello-speed', 'storage', 'host-check', 'providers', 'filesystem',
    'native-thread-spawn-join', 'native-thread-cross-wake', 'atomic-wait-notify', 'native-termination-source-trap')) {
  $executable = Join-Path $artifact "$name.exe"
  if ($name -eq 'filesystem') { $executable = Join-Path $artifact 'windows-filesystem/provider.exe' }
  if (!(Test-Path -LiteralPath $executable)) {
    $results += @{ program = $name; status = 'not-checked'; reason = 'cross-build executable missing' }
    $failed = $true
    continue
  }
  $inspection = & $readobj --file-headers --coff-imports $executable
  if ($LASTEXITCODE -ne 0) { throw "llvm-readobj failed for $name" }
  $inspection | Set-Content -LiteralPath (Join-Path $artifact "$name-native-pe.txt")
  $imports = @($inspection | Select-String '^\s+Name: (.+\.dll)$' | ForEach-Object { $_.Matches[0].Groups[1].Value })
  $allowed = '^(kernel32|ntdll)\.dll$'
  if ($name -eq 'providers') { $allowed = '^(kernel32|ntdll|bcryptprimitives)\.dll$' }
  $corpusThread = $name -like 'native-thread-*' -or $name -like 'atomic-*'
  if ($corpusThread) { $allowed = '^(kernel32|ntdll|api-ms-win-core-synch-l1-2-0)\.dll$' }
  if ($imports.Count -eq 0 -or @($imports | Where-Object { $_ -notmatch $allowed }).Count -ne 0) {
    throw "Unexpected or missing DLL imports for $name`: $imports"
  }
  if ($name -eq 'host-check' -or $name -eq 'providers' -or $name -eq 'filesystem') {
    try {
      if ($name -eq 'host-check') {
        $detail = & (Join-Path $PSScriptRoot 'run-host.ps1') -Executable $executable
      } elseif ($name -eq 'providers') {
        $detail = & (Join-Path $PSScriptRoot 'run-providers.ps1') -SilkExecutable $executable `
          -LlvmBin $LlvmBin -OutputDirectory (Join-Path $artifact 'providers-native')
      } else {
        $filesystemOutput = Join-Path $artifact 'filesystem-native'
        & (Join-Path $PSScriptRoot '../windows-filesystem/run.ps1') -SilkExecutable $executable `
          -LlvmBin $LlvmBin -OutputDirectory $filesystemOutput | Out-Host
        $detail = Get-Content -Raw -LiteralPath (Join-Path $filesystemOutput 'results.json')
      }
      $results += @{ program = $name; status = 'pass'; imports = $imports; detail = ($detail | ConvertFrom-Json) }
    } catch {
      $results += @{ program = $name; status = 'fail'; imports = $imports; reason = $_.Exception.Message }
      $failed = $true
    }
    continue
  }
  $start = New-Object System.Diagnostics.ProcessStartInfo
  $start.FileName = $executable
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $start.StandardOutputEncoding = [System.Text.Encoding]::UTF8
  $start.StandardErrorEncoding = [System.Text.Encoding]::UTF8
  $child = New-Object System.Diagnostics.Process
  $child.StartInfo = $start
  try {
    if (!$child.Start()) { throw "Cannot start $name" }
    $stdout = $child.StandardOutput.ReadToEndAsync()
    $stderr = $child.StandardError.ReadToEndAsync()
    if (!$child.WaitForExit(30000)) {
      $child.Kill()
      throw "$name timed out"
    }
    $output = $stdout.GetAwaiter().GetResult()
    $errorOutput = $stderr.GetAwaiter().GetResult()
    $expected = ''
    if ($name -eq 'hello' -or $name -eq 'hello-speed') { $expected = "Hello from Silk: $([char]::ConvertFromUtf32(0x1f4a9))`n" }
    $expectedCode = 0
    if ($corpusThread) { $expectedCode = 42 }
    $passed = $child.ExitCode -eq $expectedCode -and $output -ceq $expected -and $errorOutput -ceq ''
    if ($name -eq 'native-termination-source-trap') {
      # This fixture explicitly traps. A high status from an arbitrary child is not a crash oracle.
      $terminated = $child.ExitCode -eq -1073741795 -or $child.ExitCode -eq -1073740791
      $passed = $terminated -and $output -ceq '' -and
        $errorOutput.Contains('fatal trap: checked: the index is not less than the length') -and
        $errorOutput -match '(?m)^  at .*\.main(?:[ (]|$)'
    }
    $results += @{ program = $name; status = $(if ($passed) { 'pass' } else { 'fail' });
      exitCode = $child.ExitCode; stdout = $output; stderr = $errorOutput; imports = $imports }
    if (!$passed) { $failed = $true }
  } finally { $child.Dispose() }
}
$report = @{ sourceCommit = (Get-Content -LiteralPath (Join-Path $artifact 'source-commit.txt')).Trim();
  os = [Environment]::OSVersion.VersionString; programs = $results;
  notChecked = @('interactive WriteConsoleW output', 'i128 compiler-rt arithmetic', 'native compiler self-hosting') }
$report | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $artifact 'native-results.json') -Encoding UTF8
$report | ConvertTo-Json -Depth 5
if ($failed) { exit 1 }
