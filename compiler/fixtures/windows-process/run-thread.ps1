param(
  [string]$LlvmBin = "$env:USERPROFILE\silk-windows-tools\clang+llvm-22.1.8-x86_64-pc-windows-msvc\bin",
  [string]$OutputDirectory = "$PSScriptRoot\..\..\..\.scratch\windows-thread"
)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force $OutputDirectory | Out-Null
$out = (Resolve-Path -LiteralPath $OutputDirectory).Path
@'
LIBRARY kernel32.dll
EXPORTS
CreateThread
WaitForSingleObject
GetExitCodeThread
CloseHandle
GetActiveProcessorCount
GetLastError
ExitProcess
'@ | Set-Content -LiteralPath "$out/kernel32.def" -Encoding ascii
& "$LlvmBin/llvm-dlltool.exe" -m i386:x86-64 -d "$out/kernel32.def" -l "$out/kernel32.lib"
if ($LASTEXITCODE -ne 0) { throw 'Kernel32 import generation failed' }
& "$LlvmBin/llvm-dlltool.exe" -m i386:x86-64 -d "$PSScriptRoot/../windows-no-crt/synchronization.def" -l "$out/synchronization.lib"
if ($LASTEXITCODE -ne 0) { throw 'Synchronization import generation failed' }
& "$LlvmBin/clang.exe" --target=x86_64-pc-windows-msvc -O2 -ffreestanding -fno-stack-protector `
  -Wall -Wextra -Werror -c "$PSScriptRoot/thread.c" -o "$out/thread.obj"
if ($LASTEXITCODE -ne 0) { throw 'Thread oracle compilation failed' }
& "$LlvmBin/lld-link.exe" /nodefaultlib /subsystem:console /entry:mainCRTStartup `
  "/out:$out/thread.exe" "$out/thread.obj" "$out/kernel32.lib" "$out/synchronization.lib"
if ($LASTEXITCODE -ne 0) { throw 'Thread oracle link failed' }
$inspection = & "$LlvmBin/llvm-readobj.exe" --file-headers --coff-imports "$out/thread.exe"
if ($LASTEXITCODE -ne 0) { throw 'Thread PE inspection failed' }
$inspection | Set-Content -LiteralPath "$out/thread-pe.txt"
$dlls = @($inspection | Select-String '^\s+Name: (.+\.dll)$' | ForEach-Object { $_.Matches[0].Groups[1].Value })
if ($dlls.Count -ne 2 -or @($dlls | Where-Object { $_ -notmatch '^(kernel32|api-ms-win-core-synch-l1-2-0)\.dll$' }).Count) {
  throw "Unexpected thread imports: $dlls"
}
$process = Start-Process -FilePath "$out/thread.exe" -WindowStyle Hidden -PassThru
try {
  if (!$process.WaitForExit(30000)) { $process.Kill(); throw 'Thread oracle timed out' }
  if ($process.ExitCode -ne 0) { throw "Thread oracle failed: $($process.ExitCode)" }
} finally { $process.Dispose() }
@{
  status = 'pass'
  claims = @('DWORD thread callback and argument', 'join orders result access', 'processor count',
    'WaitOnAddress mismatch and timeout', 'single and all address wakeups')
  notChecked = @('Silk NativeThread and Atomic execution', 'forced creation failures')
} | ConvertTo-Json -Depth 3 | Tee-Object -FilePath "$out/thread-results.json"
