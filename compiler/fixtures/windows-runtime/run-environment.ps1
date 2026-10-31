param(
  [string]$LlvmBin = 'C:\Users\Administrator\silk-windows-tools\clang+llvm-22.1.8-x86_64-pc-windows-msvc\bin',
  [string]$OutputDirectory = (Join-Path $PSScriptRoot '..\..\..\.scratch\windows-environment')
)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force $OutputDirectory | Out-Null
$out = (Resolve-Path -LiteralPath $OutputDirectory).Path
@'
LIBRARY KERNEL32.dll
EXPORTS
SetEnvironmentVariableW
GetEnvironmentVariableW
GetEnvironmentStringsW
FreeEnvironmentStringsW
CompareStringOrdinal
ExitProcess
'@ | Set-Content -LiteralPath (Join-Path $out 'kernel32.def') -Encoding ascii
& (Join-Path $LlvmBin 'llvm-dlltool.exe') -m i386:x86-64 -d (Join-Path $out 'kernel32.def') -l (Join-Path $out 'kernel32.lib')
if ($LASTEXITCODE -ne 0) { throw 'Import library generation failed' }
& (Join-Path $LlvmBin 'clang.exe') --target=x86_64-pc-windows-msvc -O2 -ffreestanding -fno-stack-protector -Wall -Wextra -Werror -c (Join-Path $PSScriptRoot 'environment-contract.c') -o (Join-Path $out 'environment.obj')
if ($LASTEXITCODE -ne 0) { throw 'Contract probe compilation failed' }
& (Join-Path $LlvmBin 'lld-link.exe') /nodefaultlib /machine:x64 /subsystem:console /entry:mainCRTStartup "/out:$out\environment.exe" (Join-Path $out 'environment.obj') (Join-Path $out 'kernel32.lib')
if ($LASTEXITCODE -ne 0) { throw 'Contract probe link failed' }
$imports = & (Join-Path $LlvmBin 'llvm-readobj.exe') --file-headers --coff-imports (Join-Path $out 'environment.exe')
if ($LASTEXITCODE -ne 0) { throw 'PE inspection failed' }
$imports | Set-Content -LiteralPath (Join-Path $out 'pe.txt')
$dlls = @($imports | Select-String '^  Name: (.+\.dll)$' | ForEach-Object { $_.Matches[0].Groups[1].Value.ToLowerInvariant() } | Sort-Object -Unique)
if ($dlls.Count -ne 1 -or $dlls[0] -ne 'kernel32.dll') { throw "Unexpected imports: $dlls" }
$process = Start-Process -FilePath (Join-Path $out 'environment.exe') -WindowStyle Hidden -PassThru -Wait
if ($process.ExitCode -ne 0) { throw "Environment contract failed: $($process.ExitCode)" }
@{
  status = 'passed'
  claim = 'Windows ordinal environment lookup, lone-surrogate values, and OS environment snapshot lifetime'
  imports = $dlls
  exitCode = $process.ExitCode
  notChecked = @('Silk provider execution', 'Silk allocator lifetime', 'real-console readback', 'Win32 child command-line parser')
} | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath (Join-Path $out 'results.json')
Get-Content -LiteralPath (Join-Path $out 'results.json')
