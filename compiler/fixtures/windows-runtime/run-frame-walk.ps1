param(
  [string]$LlvmBin = "$env:USERPROFILE\silk-windows-tools\clang+llvm-22.1.8-x86_64-pc-windows-msvc\bin",
  [string]$OutputDirectory = "$PSScriptRoot\..\..\..\.scratch\windows-frame-walk"
)
$ErrorActionPreference = 'Stop'
$out = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force $out | Out-Null
$driver = Get-Content -Raw "$PSScriptRoot\..\..\src\driver\WindowsLink.silk"
foreach ($name in @('tlsSource', 'kernel32', 'ntdll')) {
  $body = [regex]::Match($driver, "fn $name\(\)[\s\S]*?return """"""\r?\n([\s\S]*?)\r?\n    """"""")
  if (!$body.Success) { throw "Missing production source: $name" }
  $source = [regex]::Replace($body.Groups[1].Value, '(?m)^    ', '')
  $extension = if ($name -eq 'tlsSource') { 'c' } else { 'def' }
  [IO.File]::WriteAllText("$out\$name.$extension", $source)
}
foreach ($name in @('kernel32', 'ntdll')) {
  & "$LlvmBin\llvm-dlltool.exe" -m i386:x86-64 -d "$out\$name.def" -l "$out\$name.lib"
  if ($LASTEXITCODE -ne 0) { throw "Import library failed: $name" }
}
& "$LlvmBin\clang.exe" --target=x86_64-pc-windows-msvc -ffreestanding -fno-stack-protector -funwind-tables -O0 `
  -Wall -Wextra -Werror -c "$PSScriptRoot\frame-walk.c" -o "$out\frame-walk.obj"
if ($LASTEXITCODE -ne 0) { throw 'Frame oracle compilation failed' }
& "$LlvmBin\clang.exe" --target=x86_64-pc-windows-msvc -ffreestanding -fno-stack-protector `
  -c "$out\tlsSource.c" -o "$out\support.obj"
if ($LASTEXITCODE -ne 0) { throw 'Production support compilation failed' }
& "$LlvmBin\lld-link.exe" /nodefaultlib /subsystem:console /entry:mainCRTStartup /include:_tls_used `
  "$out\frame-walk.obj" "$out\support.obj" "$out\kernel32.lib" "$out\ntdll.lib" "/out:$out\frame-walk.exe"
if ($LASTEXITCODE -ne 0) { throw 'Frame oracle link failed' }
& "$LlvmBin\llvm-readobj.exe" --coff-imports --unwind "$out\frame-walk.exe" | Set-Content "$out\inspection.txt"
if ($LASTEXITCODE -ne 0) { throw 'PE inspection failed' }
$child = Start-Process -FilePath "$out\frame-walk.exe" -WindowStyle Hidden -PassThru
try {
  if (!$child.WaitForExit(15000)) { $child.Kill(); throw 'Frame oracle timed out' }
  $status = $child.ExitCode
  if ($status -ne 0) { throw "Frame oracle exited $status" }
} finally { $child.Dispose() }
& "$LlvmBin\clang.exe" --target=x86_64-pc-windows-msvc -ffreestanding -fno-stack-protector -fno-unwind-tables -O0 `
  -c "$PSScriptRoot\frame-walk.c" -o "$out\without-unwind.obj"
if ($LASTEXITCODE -ne 0) { throw 'Negative-control compilation failed' }
& "$LlvmBin\lld-link.exe" /nodefaultlib /subsystem:console /entry:mainCRTStartup /include:_tls_used `
  "$out\without-unwind.obj" "$out\support.obj" "$out\kernel32.lib" "$out\ntdll.lib" "/out:$out\without-unwind.exe"
if ($LASTEXITCODE -ne 0) { throw 'Negative-control link failed' }
$control = Start-Process -FilePath "$out\without-unwind.exe" -WindowStyle Hidden -PassThru
try {
  if (!$control.WaitForExit(15000)) { $control.Kill(); throw 'Negative control timed out' }
  if ($control.ExitCode -ne 13) { throw "Missing-unwind control exited $($control.ExitCode), expected 13" }
} finally { $control.Dispose() }
@{ nativeFrameWalk = 'pass'; missingUnwindControl = 'pass'; silkExecution = 'not-checked'; exitCode = $status } |
  ConvertTo-Json | Set-Content "$out\results.json"
Get-Content "$out\results.json"
