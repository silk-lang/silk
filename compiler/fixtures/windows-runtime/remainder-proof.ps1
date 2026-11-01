param(
  [string]$LlvmBin = "$env:USERPROFILE\silk-windows-tools\clang+llvm-22.1.8-x86_64-pc-windows-msvc\bin",
  [string]$OutputDirectory = "$PSScriptRoot\..\..\..\.scratch\windows-remainder"
)
$ErrorActionPreference = 'Stop'
$out = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force $out | Out-Null
$driver = Get-Content -Raw "$PSScriptRoot\..\..\src\driver\WindowsLink.silk"
$body = [regex]::Match($driver, 'pub fn remainderSource\(\)[\s\S]*?return """\r?\n([\s\S]*?)\r?\n    """')
if (!$body.Success) { throw 'Production remainder source was not found' }
[IO.File]::WriteAllText("$out\remainder.c", [regex]::Replace($body.Groups[1].Value, '(?m)^    ', ''))
[IO.File]::WriteAllText("$out\kernel32.def", "LIBRARY kernel32.dll`nEXPORTS`nLoadLibraryW`nGetProcAddress`nExitProcess`n")
& "$LlvmBin\llvm-dlltool.exe" -m i386:x86-64 -d "$out\kernel32.def" -l "$out\kernel32.lib"
if ($LASTEXITCODE) { throw 'Import library generation failed' }
$flags = @('--target=x86_64-pc-windows-msvc', '-ffreestanding', '-fno-stack-protector', '-Wall', '-Wextra', '-Werror', '-O2', '-c')
& "$LlvmBin\clang.exe" @flags "$out\remainder.c" -o "$out\remainder.obj"
if ($LASTEXITCODE) { throw 'Production remainder compilation failed' }
& "$LlvmBin\clang.exe" @flags "$PSScriptRoot\remainder-contract.c" -o "$out\oracle.obj"
if ($LASTEXITCODE) { throw 'Oracle compilation failed' }
$undefined = & "$LlvmBin\llvm-nm.exe" --undefined-only "$out\remainder.obj"
if ($LASTEXITCODE -or @($undefined | Where-Object { $_ -notmatch '^\s+U _fltused$' }).Count) {
  throw "Production helper has unexpected dependencies: $undefined"
}
$link = @('/nodefaultlib', '/subsystem:console', '/entry:mainCRTStartup', "/out:$out\remainder.exe")
& "$LlvmBin\lld-link.exe" @link "$out\remainder.obj" "$out\oracle.obj" "$out\kernel32.lib"
if ($LASTEXITCODE) { throw 'No-CRT link failed' }
$child = [Diagnostics.Process]::Start("$out\remainder.exe")
try {
  if (!$child.WaitForExit(15000)) { $child.Kill(); throw 'Remainder oracle timed out' }
  if ($child.ExitCode) { throw "Remainder oracle exited $($child.ExitCode)" }
} finally { $child.Dispose() }
& "$LlvmBin\llvm-readobj.exe" --coff-imports "$out\remainder.exe" | Set-Content "$out\imports.txt"
if ($LASTEXITCODE) { throw 'PE inspection failed' }
@{status='passed'; source='WindowsLink.remainderSource'; oracle='Windows UCRT fmod/fmodf';
  cases='IEEE boundary cross product and 20000 deterministic bit-pattern pairs';
  productionUndefinedSymbols=@('_fltused (provided by production TLS object)'); silkExecution='not-checked: production C helper only'} |
  ConvertTo-Json | Set-Content "$out\results.json"
Get-Content "$out\results.json"
