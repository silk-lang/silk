param(
  [string]$LlvmBin = "$env:USERPROFILE\silk-windows-tools\clang+llvm-22.1.8-x86_64-pc-windows-msvc\bin",
  [string]$OutputDirectory = (Join-Path $PSScriptRoot '..\..\..\.scratch\windows-providers'),
  [string]$SilkExecutable = ''
)
$ErrorActionPreference = 'Stop'
function Invoke-CheckedProgram([string]$Executable) {
  $process = Start-Process -FilePath $Executable -WindowStyle Hidden -PassThru
  try {
    if (!$process.WaitForExit(30000)) { $process.Kill(); throw "Program timed out: $Executable" }
    if ($process.ExitCode -ne 0) { throw "Program exited $($process.ExitCode): $Executable" }
  } finally { $process.Dispose() }
}
New-Item -ItemType Directory -Force $OutputDirectory | Out-Null
$out = (Resolve-Path -LiteralPath $OutputDirectory).Path
@'
LIBRARY kernel32.dll
EXPORTS
QueryPerformanceCounter
QueryPerformanceFrequency
GetSystemTimePreciseAsFileTime
SystemTimeToFileTime
FileTimeToSystemTime
CreatePipe
ReadFile
WriteFile
CloseHandle
GetStdHandle
SetStdHandle
GetLastError
Sleep
ExitProcess
'@ | Set-Content -LiteralPath (Join-Path $out 'kernel32.def') -Encoding ascii
@'
LIBRARY bcryptprimitives.dll
EXPORTS
ProcessPrng
'@ | Set-Content -LiteralPath (Join-Path $out 'bcryptprimitives.def') -Encoding ascii
foreach ($name in @('kernel32', 'bcryptprimitives')) {
  & (Join-Path $LlvmBin 'llvm-dlltool.exe') -m i386:x86-64 -d (Join-Path $out "$name.def") -l (Join-Path $out "$name.lib")
  if ($LASTEXITCODE -ne 0) { throw "Import library failed: $name" }
}
& (Join-Path $LlvmBin 'clang.exe') --target=x86_64-pc-windows-msvc -O2 -ffreestanding -fno-stack-protector -Wall -Wextra -Werror -c (Join-Path $PSScriptRoot 'providers-contract.c') -o (Join-Path $out 'contract.obj')
if ($LASTEXITCODE -ne 0) { throw 'Contract compilation failed' }
& (Join-Path $LlvmBin 'lld-link.exe') /nodefaultlib /machine:x64 /subsystem:console /entry:mainCRTStartup "/out:$out\contract.exe" (Join-Path $out 'contract.obj') (Join-Path $out 'kernel32.lib') (Join-Path $out 'bcryptprimitives.lib')
if ($LASTEXITCODE -ne 0) { throw 'Contract link failed' }
$imports = & (Join-Path $LlvmBin 'llvm-readobj.exe') --file-headers --coff-imports (Join-Path $out 'contract.exe')
if ($LASTEXITCODE -ne 0) { throw 'PE inspection failed' }
$imports | Set-Content -LiteralPath (Join-Path $out 'pe.txt')
$dlls = @($imports | Select-String '^  Name: (.+\.dll)$' | ForEach-Object { $_.Matches[0].Groups[1].Value.ToLowerInvariant() } | Sort-Object -Unique)
if ($dlls.Count -ne 2 -or $dlls[0] -ne 'bcryptprimitives.dll' -or $dlls[1] -ne 'kernel32.dll') { throw "Unexpected imports: $dlls" }
Invoke-CheckedProgram (Join-Path $out 'contract.exe')
$silkStatus = 'not-checked: requires cross-built providers.silk with providers-contract.c companion'
if ($SilkExecutable) {
  Invoke-CheckedProgram (Resolve-Path -LiteralPath $SilkExecutable).Path
  $silkStatus = 'passed'
}
@{
  osContract = 'passed'
  silkProviders = $silkStatus
  imports = $dlls
  notChecked = @('interactive console input', 'forced QPC/ProcessPrng failures', 'message-mode pipe partial reads')
} | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath (Join-Path $out 'results.json')
Get-Content -LiteralPath (Join-Path $out 'results.json')
