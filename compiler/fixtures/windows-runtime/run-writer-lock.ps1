param(
  [string]$LlvmBin = "$env:USERPROFILE\silk-windows-tools\clang+llvm-22.1.8-x86_64-pc-windows-msvc\bin",
  [string]$OutputDirectory = "$PSScriptRoot\..\..\..\.scratch\windows-writer-lock"
)
$ErrorActionPreference = 'Stop'
$out = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force $out | Out-Null
$driver = Get-Content -Raw "$PSScriptRoot\..\..\src\driver\WindowsLink.silk"
foreach ($name in @('tlsSource', 'kernel32')) {
  $body = [regex]::Match($driver, "fn $name\(\)[\s\S]*?return """"""\r?\n([\s\S]*?)\r?\n    """"""")
  if (!$body.Success) { throw "Missing production source: $name" }
  $source = [regex]::Replace($body.Groups[1].Value, '(?m)^    ', '')
  $extension = if ($name -eq 'tlsSource') { 'c' } else { 'def' }
  if ($name -eq 'kernel32') { $source += "`nTryEnterCriticalSection`nGetExitCodeThread`n" }
  [IO.File]::WriteAllText("$out\$name.$extension", $source)
}
& "$LlvmBin\llvm-dlltool.exe" -m i386:x86-64 -d "$out\kernel32.def" -l "$out\kernel32.lib"
if ($LASTEXITCODE -ne 0) { throw 'Import library failed' }
& "$LlvmBin\clang.exe" --target=x86_64-pc-windows-msvc -ffreestanding -fno-stack-protector -O2 `
  -Wall -Wextra -Werror -c "$PSScriptRoot\writer-lock.c" -o "$out\writer-lock.obj"
if ($LASTEXITCODE -ne 0) { throw 'Lock oracle compilation failed' }
& "$LlvmBin\clang.exe" --target=x86_64-pc-windows-msvc -ffreestanding -fno-stack-protector `
  -c "$out\tlsSource.c" -o "$out\support.obj"
if ($LASTEXITCODE -ne 0) { throw 'Production support compilation failed' }
& "$LlvmBin\lld-link.exe" /nodefaultlib /subsystem:console /entry:mainCRTStartup /include:_tls_used `
  "$out\writer-lock.obj" "$out\support.obj" "$out\kernel32.lib" "/out:$out\writer-lock.exe"
if ($LASTEXITCODE -ne 0) { throw 'Lock oracle link failed' }
$inspection = & "$LlvmBin\llvm-readobj.exe" --coff-imports "$out\writer-lock.exe"
if ($LASTEXITCODE -ne 0) { throw 'PE inspection failed' }
$inspection | Set-Content "$out\inspection.txt"
$imports = @($inspection | Select-String '^\s+Name: (.+\.dll)$' | ForEach-Object { $_.Matches[0].Groups[1].Value })
if ($imports.Count -ne 1 -or $imports[0] -ine 'kernel32.dll') { throw "Unexpected imports: $imports" }
$child = Start-Process -FilePath "$out\writer-lock.exe" -WindowStyle Hidden -PassThru
try {
  if (!$child.WaitForExit(15000)) { $child.Kill(); throw 'Lock oracle timed out' }
  if ($child.ExitCode -ne 0) { throw "Lock oracle exited $($child.ExitCode)" }
} finally { $child.Dispose() }
@{ recursiveOwnership = 'pass'; singleReleaseStillExcludesOtherThread = 'pass'; finalReleaseAllowsOtherThread = 'pass';
  sharedInitialization = 'pass'; silkExecution = 'not-checked' } |
  ConvertTo-Json | Set-Content "$out\results.json"
Get-Content "$out\results.json"
