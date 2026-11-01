param(
  [Parameter(Mandatory=$true)][string]$Compiler,
  [Parameter(Mandatory=$true)][string]$OutputDirectory,
  [switch]$SelfHost,
  [string]$LlvmBin = "$env:USERPROFILE\silk-windows-tools\clang+llvm-22.1.8-x86_64-pc-windows-msvc\bin"
)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../../..')).Path
$compilerPath = (Resolve-Path -LiteralPath $Compiler).Path
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$output = (Resolve-Path -LiteralPath $OutputDirectory).Path
$results = [System.Collections.Generic.List[object]]::new()

function Invoke-Checked([string]$Name, [string]$Program, [string[]]$Arguments, [int]$Timeout = 180000) {
  $start = [System.Diagnostics.ProcessStartInfo]::new()
  $start.FileName = $Program
  $start.WorkingDirectory = $root
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $start.StandardOutputEncoding = [System.Text.Encoding]::UTF8
  $start.StandardErrorEncoding = [System.Text.Encoding]::UTF8
  # Quote using MSVC's backslash-before-quote rule; this runner also works in Windows PowerShell.
  $quoted = foreach ($argument in $Arguments) {
    '"' + ($argument -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"'
  }
  $start.Arguments = $quoted -join ' '
  $child = [System.Diagnostics.Process]::new()
  $child.StartInfo = $start
  try {
    if (!$child.Start()) { throw "Cannot start $Name" }
    $stdout = $child.StandardOutput.ReadToEndAsync()
    $stderr = $child.StandardError.ReadToEndAsync()
    if (!$child.WaitForExit($Timeout)) {
      $child.Kill()
      throw "$Name timed out"
    }
    $text = $stdout.GetAwaiter().GetResult()
    $errors = $stderr.GetAwaiter().GetResult()
    [IO.File]::WriteAllText((Join-Path $output "$Name.stdout.txt"), $text)
    [IO.File]::WriteAllText((Join-Path $output "$Name.stderr.txt"), $errors)
    $results.Add(@{ name = $Name; exitCode = $child.ExitCode; arguments = $Arguments })
    if ($child.ExitCode -ne 0) { throw "$Name exited $($child.ExitCode): $errors" }
    return $text
  } finally { $child.Dispose() }
}

try {
  $version = Invoke-Checked 'version' $compilerPath @('--version')
  if ([string]::IsNullOrWhiteSpace($version)) { throw 'Compiler version was empty' }
  $library = Join-Path $root 'stdlib'
  $package = Join-Path $output 'hello package'
  New-Item -ItemType Directory -Force -Path (Join-Path $package 'src') | Out-Null
  [IO.File]::WriteAllText((Join-Path $package 'silk.toml'), "[package]`nname = `"windows-compiler-smoke`"`nversion = `"0.0.0`"`nsilk-version = `"0.0.0`"`n")
  $source = Join-Path $package 'src/main.silk'
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'hello.silk') -Destination $source
  $clang = Join-Path $LlvmBin 'clang.exe'
  # Spaces test the compiler's own path conversion and Clang process quoting at the real boundary.
  $program = Join-Path $output 'hello from windows.exe'
  $null = Invoke-Checked 'build' $compilerPath @('build', $source, '-o', $program,
    '--stdlib', $library, '--clang', $clang, '--optimization', 'none', '--debug', 'false')
  $hello = Invoke-Checked 'execute' $program @()
  if ($hello -cne "Hello from Silk: $([char]::ConvertFromUtf32(0x1f4a9))`n") { throw 'Native-built hello output differs' }
  $null = Invoke-Checked 'check-compiler' $compilerPath @('check', '--manifest-path', (Join-Path $root 'compiler/silk.toml'), '--stdlib', $library) 600000
  if ($SelfHost) {
    $compilerSource = Join-Path $root 'compiler/src/main.silk'
    $n2 = Join-Path $output 'N2.exe'
    $buildArguments = @('build', $compilerSource, '--target', 'x86_64-pc-windows-msvc',
      '--stdlib', $library, '--clang', $clang, '--optimization', 'speed', '--debug', 'false')
    $null = Invoke-Checked 'build-n2' $compilerPath ($buildArguments + @('-o', $n2)) 900000
    $nextVersion = Invoke-Checked 'n2-version' $n2 @('--version')
    if ($nextVersion -cne $version) { throw 'Native N2 reports a different version' }
    $producerIr = Join-Path $output 'producer.ll'
    $nextIr = Join-Path $output 'n2.ll'
    $null = Invoke-Checked 'producer-ir' $compilerPath ($buildArguments + @('--emit', 'llvm-ir', '-o', $producerIr)) 900000
    $null = Invoke-Checked 'n2-ir' $n2 ($buildArguments + @('--emit', 'llvm-ir', '-o', $nextIr)) 900000
    $producerHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $producerIr).Hash
    $nextHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $nextIr).Hash
    $results.Add(@{ name = 'native-fixpoint'; producerIrSha256 = $producerHash; n2IrSha256 = $nextHash })
    if ($producerHash -cne $nextHash) { throw 'Native Windows generations emit different compiler IR' }
    $nextProgram = Join-Path $output 'hello from n2.exe'
    $null = Invoke-Checked 'n2-build' $n2 @('build', $source, '-o', $nextProgram,
      '--stdlib', $library, '--clang', $clang, '--optimization', 'none', '--debug', 'false')
    $nextHello = Invoke-Checked 'n2-execute' $nextProgram @()
    if ($nextHello -cne $hello) { throw 'N2-built hello output differs' }
  }
  @{ status = 'passed'; compiler = $compilerPath; checks = $results } |
    ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $output 'results.json')
} catch {
  @{ status = 'failed'; compiler = $compilerPath; reason = $_.Exception.Message; checks = $results } |
    ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $output 'results.json')
  throw
}
