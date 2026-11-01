param(
  [string]$LlvmBin = "$env:USERPROFILE\silk-windows-tools\clang+llvm-22.1.8-x86_64-pc-windows-msvc\bin",
  [string]$OutputDirectory = "$PSScriptRoot\..\..\..\.scratch\windows-filesystem",
  [string]$SilkExecutable = '',
  [string]$UncSilkExecutable = '',
  [switch]$ProbeUnc
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$LlvmBin = (Resolve-Path -LiteralPath $LlvmBin).Path
$out = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force $out | Out-Null
function Invoke-Tool([string]$Name, [string[]]$Arguments) {
  & "$LlvmBin\$Name.exe" @Arguments
  if ($LASTEXITCODE -ne 0) { throw "$Name failed: $LASTEXITCODE" }
}
foreach ($dll in 'kernel32', 'ntdll') {
  Invoke-Tool 'llvm-dlltool' @('-m', 'i386:x86-64', '-d', "$PSScriptRoot\$dll.def", '-l', "$out\$dll.lib")
}
Invoke-Tool 'clang' @('--target=x86_64-pc-windows-msvc', '-O2', '-ffreestanding', '-fno-stack-protector', '-Wall', '-Wextra', '-Werror', '-DCONTRACT_MAIN', '-c', "$PSScriptRoot\contract.c", '-o', "$out\contract.obj")
Invoke-Tool 'lld-link' @('/nologo', '/nodefaultlib', '/machine:x64', '/subsystem:console', '/entry:mainCRTStartup', "/out:$out\contract.exe", "$out\contract.obj", "$out\kernel32.lib", "$out\ntdll.lib")
$os = Get-CimInstance Win32_OperatingSystem
"$($os.Caption), $($os.Version), $($os.OSArchitecture)" | Set-Content "$out\host.txt"
function Run-Case([string]$Executable, [string]$Name) {
  $scratch = Join-Path $out ($Name + '-' + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory $scratch | Out-Null
  $process = New-Object Diagnostics.Process
  $process.StartInfo.FileName = $Executable
  $process.StartInfo.WorkingDirectory = $scratch
  $process.StartInfo.UseShellExecute = $false
  $process.StartInfo.CreateNoWindow = $true
  $process.StartInfo.RedirectStandardOutput = $true
  $process.StartInfo.RedirectStandardError = $true
  try {
    $null = $process.Start()
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit(30000)) { $process.Kill(); throw "$Name timed out" }
    $text = $stdout.GetAwaiter().GetResult()
    [IO.File]::WriteAllText("$out\$Name.stdout.txt", $text)
    [IO.File]::WriteAllText("$out\$Name.stderr.txt", $stderr.GetAwaiter().GetResult())
    Write-Output $text
    if ($process.ExitCode -eq 77) { throw "$Name UNSUPPORTED: required host capability absent; see its stdout; this is not a pass" }
    if ($process.ExitCode -ne 0) { throw "$Name failed: $($process.ExitCode); scratch retained at $scratch" }
  } finally { $process.Dispose() }
  # Retain this small fixture tree as evidence. No recursive cleanup follows reparse points.
}
Run-Case "$out\contract.exe" 'contract'
$results = @(@{ status = 'pass'; claim = 'independent NT filesystem contracts on local NTFS'; evidence = 'contract.stdout.txt' })
if ($ProbeUnc -or $UncSilkExecutable) {
  Invoke-Tool 'clang' @('--target=x86_64-pc-windows-msvc', '-O2', '-ffreestanding', '-fno-stack-protector', '-Wall', '-Wextra', '-Werror', '-DREMOTE_CONTRACT_MAIN', '-c', "$PSScriptRoot\contract.c", '-o', "$out\unc.obj")
  Invoke-Tool 'lld-link' @('/nologo', '/nodefaultlib', '/machine:x64', '/subsystem:console', '/entry:mainCRTStartup', "/out:$out\unc.exe", "$out\unc.obj", "$out\kernel32.lib", "$out\ntdll.lib")
  Run-Case "$out\unc.exe" 'unc-capabilities'
  $results += @{ status = 'observed'; claim = 'localhost SMB NTFS operation statuses, not provider parity'; evidence = 'unc-capabilities.stdout.txt' }
}
if ($SilkExecutable) {
  Run-Case (Resolve-Path -LiteralPath $SilkExecutable).Path 'provider'
  $results += @{ status = 'pass'; claim = 'Silk filesystem provider integration'; evidence = 'provider.stdout.txt' }
} else {
  Write-Output 'NOT-CHECKED: Silk provider execution; pass -SilkExecutable with the cross-linked provider fixture.'
  $results += @{ status = 'not-checked'; claim = 'Silk filesystem provider integration'; reason = 'No cross-linked provider executable supplied.' }
}
if ($UncSilkExecutable) {
  Run-Case (Resolve-Path -LiteralPath $UncSilkExecutable).Path 'unc-provider'
  $results += @{ status = 'pass'; claim = 'Silk UNC read/write/create/stat/list routing and mutation refusal'; evidence = 'unc-provider.stdout.txt' }
}
$results += @{ status = 'not-checked'; claim = 'Windows 10 minimum, non-NTFS rejection, ACLs, unknown reparse tags, concurrent publication, injected close failures'; reason = 'Not covered by this focused native fixture.' }
$results | ConvertTo-Json | Set-Content -Encoding UTF8 "$out\results.json"
