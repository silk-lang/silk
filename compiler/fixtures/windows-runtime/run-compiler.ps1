param(
  [Parameter(Mandatory=$true)][string]$Compiler,
  [Parameter(Mandatory=$true)][string]$OutputDirectory,
  [switch]$SelfHost,
  [string]$SourceRoot = (Join-Path $PSScriptRoot '../../..'),
  [string]$LlvmBin = "$env:USERPROFILE\silk-windows-tools\clang+llvm-22.1.8-x86_64-pc-windows-msvc\bin"
)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath $SourceRoot).Path
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
  # A small source with enough explicit object paths to exceed CreateProcessW's hard limit.
  # Compile one empty C object and copy it; no extra compiler rebuild is needed for this proof.
  $responsePackage = Join-Path $output ("response, $([char]0x03a9) package")
  New-Item -ItemType Directory -Force -Path (Join-Path $responsePackage 'src') | Out-Null
  Copy-Item -LiteralPath $source -Destination (Join-Path $responsePackage 'src/main.silk')
  $emptySource = Join-Path $responsePackage 'empty.c'
  $emptyObject = Join-Path $responsePackage 'empty.obj'
  [IO.File]::WriteAllText($emptySource, '/* An independent COFF object with no definitions. */')
  $null = Invoke-Checked 'response-object' $clang @('--target=x86_64-pc-windows-msvc', '-c', $emptySource, '-o', $emptyObject)
  $links = [System.Collections.Generic.List[string]]::new()
  $objectArgumentLength = 0
  for ($index = 0; $index -lt 400; $index++) {
    $name = ('empty object {0:D3} ' -f $index) + ('x' * 32) + '.obj'
    $destination = Join-Path $responsePackage $name
    Copy-Item -LiteralPath $emptyObject -Destination $destination
    $links.Add('{ object = "' + $name + '" }')
    $objectArgumentLength += $destination.Length + 3
  }
  if ($objectArgumentLength -le 32767) { throw 'Long-link control does not exceed the Windows command-line limit' }
  $manifest = [IO.File]::ReadAllText((Join-Path $package 'silk.toml')) + "`n[native]`nlink = [" + ($links -join ',') + "]`n"
  [IO.File]::WriteAllText((Join-Path $responsePackage 'silk.toml'), $manifest)
  $responseExecutable = Join-Path $responsePackage 'response file program.exe'
  $null = Invoke-Checked 'response-build' $compilerPath @('build', (Join-Path $responsePackage 'src/main.silk'),
    '-o', $responseExecutable, '--stdlib', $library, '--clang', $clang, '--optimization', 'speed', '--debug', 'false')
  if ((Invoke-Checked 'response-execute' $responseExecutable @()) -cne $hello) { throw 'Response-file executable output differs' }
  $results.Add(@{ name = 'response-command-limit'; objectArgumentLength = $objectArgumentLength })
  $archiveSource = Join-Path $responsePackage 'src/library.silk'
  [IO.File]::WriteAllText($archiveSource, 'export "C" fn silk_response_answer(value: i32) -> i32 { return value + 1 }')
  $archiveManifest = "[package]`nname = `"response-library`"`nversion = `"0.0.0`"`nsilk-version = `"0.0.0`"`nmain = `"library.silk`"`nkind = `"static-library`"`n[native]`nlink = [" + ($links -join ',') + "]`n"
  [IO.File]::WriteAllText((Join-Path $responsePackage 'silk.toml'), $archiveManifest)
  $archive = Join-Path $responsePackage 'response library.lib'
  $null = Invoke-Checked 'response-archive' $compilerPath @('build', $archiveSource, '-o', $archive,
    '--stdlib', $library, '--clang', $clang, '--optimization', 'speed', '--debug', 'false')
  $members = Invoke-Checked 'response-archive-members' (Join-Path $LlvmBin 'llvm-ar.exe') @('t', $archive)
  $listed = @($members -split "`r?`n" | Where-Object { $_.Length -gt 0 })
  if ($listed.Count -ne 401) { throw 'Response-file archive did not retain every declared object and the Silk object' }
  $symbols = Invoke-Checked 'response-archive-symbols' (Join-Path $LlvmBin 'llvm-nm.exe') @('--defined-only', $archive)
  if ($symbols -notmatch '\bT silk_response_answer\b') { throw 'Response-file archive lost the Silk export' }
  $null = Invoke-Checked 'check-compiler' $compilerPath @('check', '--manifest-path', (Join-Path $root 'compiler/silk.toml'), '--stdlib', $library) 600000
  if ($SelfHost) {
    $compilerSource = Join-Path $root 'compiler/src/main.silk'
    $n2 = Join-Path $output 'N2.exe'
    $buildArguments = @('--target', 'x86_64-pc-windows-msvc',
      '--stdlib', $library, '--clang', $clang, '--optimization', 'speed', '--debug', 'false')
    $null = Invoke-Checked 'build-n2' $compilerPath (@('build', $compilerSource, '-o', $n2) + $buildArguments) 900000
    $nextVersion = Invoke-Checked 'n2-version' $n2 @('--version')
    if ($nextVersion -cne $version) { throw 'Native N2 reports a different version' }
    $producerIr = Join-Path $output 'producer.ll'
    $nextIr = Join-Path $output 'n2.ll'
    $null = Invoke-Checked 'producer-ir' $compilerPath (@('build', $compilerSource, '-o', $producerIr, '--emit', 'llvm-ir') + $buildArguments) 900000
    $null = Invoke-Checked 'n2-ir' $n2 (@('build', $compilerSource, '-o', $nextIr, '--emit', 'llvm-ir') + $buildArguments) 900000
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
