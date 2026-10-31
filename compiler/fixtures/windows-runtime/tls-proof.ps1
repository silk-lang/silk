param(
  [string]$LlvmBin = "$env:USERPROFILE\silk-windows-tools\clang+llvm-22.1.8-x86_64-pc-windows-msvc\bin",
  [string]$OutputDirectory = "$PSScriptRoot\..\..\..\.scratch\windows-tls"
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$out = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force $out | Out-Null
Set-Content -Encoding UTF8 "$out\commands.log" ''
function Tool([string]$Name, [string[]]$Arguments, [switch]$Failure) {
  Add-Content "$out\commands.log" ("$Name " + (($Arguments | ForEach-Object { '"' + $_ + '"' }) -join ' '))
  $saved = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { $lines = & "$LlvmBin\$Name.exe" @Arguments 2>&1; $status = $LASTEXITCODE }
  finally { $ErrorActionPreference = $saved }
  $text = ($lines | ForEach-Object { $_.ToString() }) -join "`n"
  Add-Content "$out\commands.log" "$text`nexit=$status"
  if ($Failure) { if ($status -eq 0) { throw "$Name unexpectedly passed" } }
  elseif ($status -ne 0) { throw "$Name failed: $text" }
  return $text
}
function Require([bool]$Condition, [string]$Reason) { if (!$Condition) { throw $Reason } }
function Run([string]$Name, [int]$Expected) {
  $child = New-Object System.Diagnostics.Process
  $child.StartInfo.FileName = "$out\$Name.exe"
  $child.StartInfo.UseShellExecute = $false
  $child.StartInfo.CreateNoWindow = $true
  try {
    Require ($child.Start()) "Cannot start $Name"
    if (!$child.WaitForExit(15000)) { $child.Kill(); throw "$Name timed out" }
    Require ($child.ExitCode -eq $Expected) "$Name exited $($child.ExitCode), expected $Expected"
  } finally { $child.Dispose() }
}
$driver = Get-Content -Raw "$PSScriptRoot\..\..\src\driver\WindowsLink.silk"
$body = [regex]::Match($driver, 'pub fn tlsSource\(\)[\s\S]*?return """\r?\n([\s\S]*?)\r?\n    """')
Require $body.Success 'Production TLS source was not found'
$support = [regex]::Replace($body.Groups[1].Value, '(?m)^    ', '')
[IO.File]::WriteAllText("$out\silk-tls.c", $support)
@'
LIBRARY kernel32.dll
EXPORTS
  ExitProcess
  CreateEventW
  SetEvent
  WaitForSingleObject
  CreateThread
  GetExitCodeThread
  CloseHandle
'@ | Set-Content -Encoding ASCII "$out\kernel32.def"
$null = Tool 'llvm-dlltool' @('-m', 'i386:x86-64', '-d', "$out\kernel32.def", '-l', "$out\kernel32.lib")
$flags = @('--target=x86_64-pc-windows-msvc', '-ffreestanding', '-fno-stack-protector', '-O2', '-c')
$null = Tool 'clang' ($flags + @("$out\silk-tls.c", '-o', "$out\silk-tls.obj"))
$null = Tool 'clang' ($flags + @("$PSScriptRoot\tls-threads.c", '-o', "$out\threads.obj"))
$null = Tool 'clang' @('--target=x86_64-pc-windows-msvc', '-O2', '-c', "$PSScriptRoot\tls-state.ll", '-o', "$out\state.obj")
$undefined = Tool 'llvm-nm' @('--undefined-only', "$out\state.obj")
Require ($undefined -match '\b_tls_index\b') 'Fixture no longer tests the emitted TLS-index dependency'
$link = @('/nodefaultlib', '/subsystem:console', '/entry:mainCRTStartup')
$missing = Tool 'lld-link' ($link + @("/out:$out\missing.exe", "$out\threads.obj", "$out\state.obj", "$out\kernel32.lib")) -Failure
Require ($missing -match '_tls_index') 'Absent-support control failed for a different symbol'
$null = Tool 'lld-link' ($link + @('/include:_tls_used', "/out:$out\tls.exe", "$out\threads.obj", "$out\state.obj", "$out\silk-tls.obj", "$out\kernel32.lib"))
$object = Tool 'llvm-readobj' @('--sections', '--symbols', '--relocations', "$out\silk-tls.obj")
$object | Set-Content "$out\support-object.txt"
Require ($object -match 'Name: \.tls\s' -and $object -match 'Name: \.tls\$ZZZ') 'TLS template boundary sections are absent'
Require ($object -match 'IMAGE_REL_AMD64_ADDR64 _tls_start' -and $object -match 'IMAGE_REL_AMD64_ADDR64 _tls_end' -and $object -match 'IMAGE_REL_AMD64_ADDR64 _tls_index') 'TLS directory pointers lost their image relocations'
$pe = Tool 'llvm-readobj' @('--file-headers', '--sections', '--coff-tls-directory', '--coff-imports', '--coff-basereloc', "$out\tls.exe")
$pe | Set-Content "$out\tls-pe.txt"
Require ($pe -match 'TLSTableRVA: 0x[1-9A-Fa-f]' -and $pe -match 'AddressOfIndex: 0x[1-9A-Fa-f]') 'Image has no active TLS directory'
Require ($pe -match 'Type: DIR64') 'TLS image pointers have no base relocations'
$imports = @([regex]::Matches($pe, '(?m)^  Name: (.+\.dll)\r?$') | ForEach-Object { $_.Groups[1].Value })
Require ($imports.Count -eq 1 -and $imports[0] -ieq 'kernel32.dll') 'Unexpected runtime import'
Run 'tls' 0
# A global alias must fail the independent initial-state check in the worker.
$global = (Get-Content -Raw "$PSScriptRoot\tls-state.ll").Replace('thread_local global', 'global')
[IO.File]::WriteAllText("$out\global.ll", $global)
$null = Tool 'clang' @('--target=x86_64-pc-windows-msvc', '-O2', '-c', "$out\global.ll", '-o', "$out\global.obj")
$null = Tool 'lld-link' ($link + @("/out:$out\global.exe", "$out\threads.obj", "$out\global.obj", "$out\kernel32.lib"))
Run 'global' 17
@{ status = 'pass'; claim = 'real PE loader initializes independent zero-valued diagnostic TLS on two threads';
  controls = @('missing support fails on _tls_index', 'global alias exits 17');
  source = 'production WindowsLink.tlsSource'; silkExecution = 'not-checked: reduced LLVM/C loader proof';
  os = [Environment]::OSVersion.VersionString } | ConvertTo-Json | Set-Content -Encoding UTF8 "$out\results.json"
Get-Content "$out\results.json"
