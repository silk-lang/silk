param(
  [string]$LlvmBin = "$env:USERPROFILE\silk-windows-tools\clang+llvm-22.1.8-x86_64-pc-windows-msvc\bin",
  [string]$OutputDirectory = "$PSScriptRoot\..\..\..\.scratch\windows-process"
)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force $OutputDirectory | Out-Null
$out = (Resolve-Path -LiteralPath $OutputDirectory).Path
@'
LIBRARY kernel32.dll
EXPORTS
GetCommandLineW
GetModuleFileNameW
CreateProcessW
WaitForSingleObject
GetExitCodeProcess
TerminateProcess
CloseHandle
ExitProcess
LocalFree
'@ | Set-Content -LiteralPath "$out/kernel32.def" -Encoding ascii
@'
LIBRARY shell32.dll
EXPORTS
CommandLineToArgvW
'@ | Set-Content -LiteralPath "$out/shell32.def" -Encoding ascii
foreach ($name in @('kernel32', 'shell32')) {
  & "$LlvmBin/llvm-dlltool.exe" -m i386:x86-64 -d "$out/$name.def" -l "$out/$name.lib"
  if ($LASTEXITCODE -ne 0) { throw "Import generation failed: $name" }
}
& "$LlvmBin/clang.exe" --target=x86_64-pc-windows-msvc -O2 -ffreestanding -fno-stack-protector `
  -Wall -Wextra -Werror -c "$PSScriptRoot/command-line.c" -o "$out/command-line.obj"
if ($LASTEXITCODE -ne 0) { throw 'Command-line oracle compilation failed' }
& "$LlvmBin/lld-link.exe" /nodefaultlib /subsystem:console /entry:mainCRTStartup `
  "/out:$out/command-line.exe" "$out/command-line.obj" "$out/kernel32.lib" "$out/shell32.lib"
if ($LASTEXITCODE -ne 0) { throw 'Command-line oracle link failed' }
$inspection = & "$LlvmBin/llvm-readobj.exe" --file-headers --coff-imports "$out/command-line.exe"
if ($LASTEXITCODE -ne 0) { throw 'PE inspection failed' }
$inspection | Set-Content -LiteralPath "$out/command-line-pe.txt"
$dlls = @($inspection | Select-String '^\s+Name: (.+\.dll)$' | ForEach-Object { $_.Matches[0].Groups[1].Value })
if ($dlls.Count -ne 2 -or @($dlls | Where-Object { $_ -notmatch '^(kernel32|shell32)\.dll$' }).Count) {
  throw "Unexpected test imports: $dlls"
}
$process = Start-Process -FilePath "$out/command-line.exe" -WindowStyle Hidden -PassThru
try {
  if (!$process.WaitForExit(30000)) { $process.Kill(); throw 'Command-line oracle timed out' }
  if ($process.ExitCode -ne 0) { throw "Command-line oracle failed: $($process.ExitCode)" }
} finally { $process.Dispose() }
@{
  status = 'pass'
  claims = @('explicit application with independent argv[0]', 'MSVC quote and slash boundaries',
    'empty arguments and raw UTF-16', 'exit 259 after completed wait', 'explicit high-bit exit status')
  notChecked = @('Silk encoder execution', 'Silk child-process provider', 'capture and job cleanup')
} | ConvertTo-Json -Depth 3 | Tee-Object -FilePath "$out/command-line-results.json"
