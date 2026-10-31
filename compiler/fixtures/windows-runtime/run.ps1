param(
  [Parameter(Mandatory = $true)][string]$ArtifactDirectory,
  [string]$LlvmBin = "$env:USERPROFILE\silk-windows-tools\clang+llvm-22.1.8-x86_64-pc-windows-msvc\bin"
)
$ErrorActionPreference = 'Stop'
$artifact = (Resolve-Path -LiteralPath $ArtifactDirectory).Path
$readobj = Join-Path $LlvmBin 'llvm-readobj.exe'
$results = @()
$failed = $false
foreach ($name in @('hello', 'storage')) {
  $executable = Join-Path $artifact "$name.exe"
  if (!(Test-Path -LiteralPath $executable)) {
    $results += @{ program = $name; status = 'not-checked'; reason = 'cross-build executable missing' }
    $failed = $true
    continue
  }
  $inspection = & $readobj --file-headers --coff-imports $executable
  if ($LASTEXITCODE -ne 0) { throw "llvm-readobj failed for $name" }
  $inspection | Set-Content -LiteralPath (Join-Path $artifact "$name-native-pe.txt")
  $imports = @($inspection | Select-String '^\s+Name: (.+\.dll)$' | ForEach-Object { $_.Matches[0].Groups[1].Value })
  if ($imports.Count -eq 0 -or @($imports | Where-Object { $_ -notmatch '^(kernel32|ntdll)\.dll$' }).Count -ne 0) {
    throw "Unexpected or missing DLL imports for $name`: $imports"
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
    if ($name -eq 'hello') { $expected = "Hello from Silk: $([char]::ConvertFromUtf32(0x1f4a9))`n" }
    $passed = $child.ExitCode -eq 0 -and $output -ceq $expected -and $errorOutput -ceq ''
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
