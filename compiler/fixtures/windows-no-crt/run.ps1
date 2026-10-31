param(
  [string]$LlvmBin = "$env:USERPROFILE\silk-windows-tools\clang+llvm-22.1.8-x86_64-pc-windows-msvc\bin",
  [string]$OutputDirectory = "$PSScriptRoot\..\..\..\.scratch\windows-no-crt"
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($env:OS -ne 'Windows_NT' -or -not [Environment]::Is64BitProcess) {
  throw 'Run this proof from a 64-bit Windows PowerShell process.'
}
$LlvmBin = (Resolve-Path -LiteralPath $LlvmBin).Path
$out = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force $out | Out-Null
Set-Content -Encoding UTF8 "$out\commands.log" ''
function Invoke-Tool([string]$Name, [string[]]$Arguments, [switch]$ExpectFailure) {
  Add-Content "$out\commands.log" ("$Name " + (($Arguments | ForEach-Object { '"' + $_ + '"' }) -join ' '))
  # Windows PowerShell presents native stderr as ErrorRecord, including expected linker errors.
  $saved = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $lines = & "$LlvmBin\$Name.exe" @Arguments 2>&1
    $code = $LASTEXITCODE
  } finally { $ErrorActionPreference = $saved }
  $result = ($lines | ForEach-Object { $_.ToString() }) -join "`n"
  Add-Content "$out\commands.log" "$result`nexit=$code"
  if ($ExpectFailure) {
    if ($code -eq 0) { throw "$Name unexpectedly succeeded." }
  } elseif ($code -ne 0) { throw "$Name failed ($code): $result" }
  return $result
}
function Require([bool]$Condition, [string]$Claim) {
  if (-not $Condition) { throw $Claim }
}
function Save-Inspection([string]$Name, [string]$Tool, [string[]]$Arguments) {
  $text = Invoke-Tool $Tool $Arguments
  Set-Content -Encoding UTF8 "$out\$Name.txt" $text
  return $text
}
function Check-Imports([string]$Name, [string[]]$ExpectedDlls) {
  $pe = Save-Inspection "$Name-pe" 'llvm-readobj' @('--file-headers', '--coff-imports', "$out\$Name.exe")
  Require ($pe -match 'Machine: IMAGE_FILE_MACHINE_AMD64') "$Name is not AMD64."
  Require ($pe -match 'Subsystem: IMAGE_SUBSYSTEM_WINDOWS_CUI') "$Name is not a console PE."
  Require ($pe -match 'AddressOfEntryPoint: 0x[1-9A-Fa-f]') "$Name has no entry point."
  $actual = @([regex]::Matches($pe, '(?m)^  Name: (.+\.dll)\r?$') | ForEach-Object { $_.Groups[1].Value.Trim() })
  Require ((($actual | Sort-Object) -join ',') -eq (($ExpectedDlls | Sort-Object) -join ',')) "$Name imports unexpected DLLs: $actual"
  return $pe
}
function Run-Executable([string]$Name, [int]$ExpectedExit) {
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo.FileName = "$out\$Name.exe"
  $process.StartInfo.UseShellExecute = $false
  $process.StartInfo.CreateNoWindow = $true
  $process.StartInfo.RedirectStandardOutput = $true
  $process.StartInfo.RedirectStandardError = $true
  try {
    $null = $process.Start()
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit(10000)) {
      $process.Kill()
      throw "$Name did not exit within the smoke harness timeout."
    }
    $code = $process.ExitCode
    [IO.File]::WriteAllText("$out\$Name.stdout.txt", $stdout.GetAwaiter().GetResult())
    [IO.File]::WriteAllText("$out\$Name.stderr.txt", $stderr.GetAwaiter().GetResult())
    Add-Content "$out\commands.log" "$Name.exe exit=$code"
    Require ($code -eq $ExpectedExit) "$Name exited $code; expected $ExpectedExit."
    Write-Output "$Name.exe: exit $code"
  } finally { $process.Dispose() }
}

$version = Save-Inspection 'clang-version' 'clang' @('--version')
Require ($version -match '^clang version 22\.1\.8\b') 'This proof pins stock LLVM 22.1.8.'
$os = Get-CimInstance Win32_OperatingSystem
"$($os.Caption), $($os.Version), $($os.OSArchitecture)" | Set-Content "$out\host.txt"

# Validate every physical-DLL import definition against this host's export table.
foreach ($name in 'kernel32', 'ntdll') {
  $exports = Save-Inspection "$name-exports" 'llvm-readobj' @('--coff-exports', "$env:SystemRoot\System32\$name.dll")
  foreach ($line in Get-Content "$PSScriptRoot\$name.def") {
    if ($line -match '^  (\w+)$') {
      $symbol = $Matches[1]
      Require ($exports -match "(?m)^  Name: $symbol`r?$") "$name.dll does not export $symbol."
    }
  }
}
# API-set contracts need not exist as files. Execution below checks loader resolution.
foreach ($name in 'kernelbase', 'ws2_32', 'bcryptprimitives', 'crypt32') {
  $null = Save-Inspection "$name-exports" 'llvm-readobj' @('--coff-exports', "$env:SystemRoot\System32\$name.dll")
}
foreach ($name in 'kernel32', 'ntdll', 'synchronization') {
  $null = Invoke-Tool 'llvm-dlltool' @('-m', 'i386:x86-64', '-d', "$PSScriptRoot\$name.def", '-l', "$out\$name.lib")
}
$cc = @('--target=x86_64-pc-windows-msvc', '-O2', '-ffreestanding', '-fno-stack-protector', '-Wno-override-module')
foreach ($name in 'smoke', 'float-support', 'foreign-seh') {
  $null = Invoke-Tool 'clang' ($cc + @('-c', "$PSScriptRoot\$name.c", '-o', "$out\$name.obj"))
}
$null = Invoke-Tool 'clang' ($cc + @('-DUNGUARDED_CONTROL', '-c', "$PSScriptRoot\foreign-seh.c", '-o', "$out\foreign-control.obj"))
foreach ($name in 'builtins', 'builtins-entry', 'foreign-guard') {
  $null = Invoke-Tool 'clang' ($cc + @('-c', "$PSScriptRoot\$name.ll", '-o', "$out\$name.obj"))
}
$undefined = Save-Inspection 'smoke-undefined' 'llvm-nm' @('--undefined-only', "$out\smoke.obj")
foreach ($symbol in '__chkstk', '_fltused', 'memcpy', 'memmove', 'memset', 'memcmp') {
  Require ($undefined -match "(?m) U $symbol`r?$") "Smoke lost its emitted reference to $symbol."
}
$null = Save-Inspection 'smoke-disassembly' 'llvm-objdump' @('-dr', "$out\smoke.obj")
$link = @('/nologo', '/nodefaultlib', '/machine:x64', '/subsystem:console', '/entry:mainCRTStartup', '/timestamp:0')
$smoke = @("$out\smoke.obj", "$out\kernel32.lib", "$out\ntdll.lib", "$out\synchronization.lib")
$missingFloat = Invoke-Tool 'lld-link' ($link + @("/out:$out\missing-float.exe") + $smoke) -ExpectFailure
Require ($missingFloat -match '_fltused') 'Missing-float control failed for an unrelated reason.'
$null = Invoke-Tool 'lld-link' ($link + @("/out:$out\smoke.exe", "$out\float-support.obj") + $smoke)
$pe = Check-Imports 'smoke' @('kernel32.dll', 'ntdll.dll', 'api-ms-win-core-synch-l1-2-0.dll')
foreach ($symbol in '__chkstk', 'memcpy', 'memmove', 'memset', 'memcmp', 'WaitOnAddress', 'WakeByAddressAll', 'WakeByAddressSingle') {
  Require ($pe -match "Symbol: $symbol \(") "Smoke does not import $symbol."
}
Run-Executable 'smoke' 0
Require ((Get-Content "$out\smoke.stdout.txt" -Raw) -ceq "windows-no-crt: ok`n") 'Unexpected smoke output.'

$builtins = Save-Inspection 'builtins-undefined' 'llvm-nm' @('--undefined-only', "$out\builtins.obj")
$helpers = @('__divti3', '__udivti3', '__modti3', '__umodti3', '__floattidf', '__floatuntidf', '__fixdfti', '__fixunsdfti', '_fltused')
$actual = @([regex]::Matches($builtins, '(?m) U (\w+)\r?$') | ForEach-Object { $_.Groups[1].Value })
Require ((($actual | Sort-Object) -join ',') -eq (($helpers | Sort-Object) -join ',')) "Unexpected compiler helper inventory: $actual"
$builtinObjects = @("$out\builtins-entry.obj", "$out\builtins.obj", "$out\float-support.obj", "$out\kernel32.lib")
$missingBuiltins = Invoke-Tool 'lld-link' ($link + @("/out:$out\missing-builtins.exe") + $builtinObjects) -ExpectFailure
foreach ($helper in ($helpers | Where-Object { $_ -ne '_fltused' })) {
  Require ($missingBuiltins -match $helper) "Missing-builtins control did not require $helper."
}
$runtime = Join-Path $LlvmBin '..\lib\clang\22\lib\windows\clang_rt.builtins-x86_64.lib'
$stockBuiltins = Invoke-Tool 'lld-link' ($link + @("/out:$out\builtins.exe") + $builtinObjects + @($runtime)) -ExpectFailure
Set-Content -Encoding UTF8 "$out\stock-builtins-link.txt" $stockBuiltins
foreach ($dependency in '__security_cookie', '__security_check_cookie') {
  Require ($stockBuiltins -match $dependency) "Stock builtins did not expose the expected $dependency dependency."
}
Write-Output 'BLOCKED: executing i128 arithmetic/conversions requires a no-CRT compiler-builtins supply; stock archive requires security-cookie support.'

$unwind = Save-Inspection 'foreign-guard-unwind' 'llvm-readobj' @('--unwind', '--relocations', "$out\foreign-guard.obj")
Require ($unwind -match 'Handler: __silk_foreign_personality') 'The guard has no SEH personality registration.'
$null = Save-Inspection 'foreign-guard-disassembly' 'llvm-objdump' @('-dr', "$out\foreign-guard.obj")
foreach ($name in 'foreign-seh', 'foreign-control') {
  $null = Invoke-Tool 'lld-link' ($link + @("/out:$out\$name.exe", "$out\$name.obj", "$out\foreign-guard.obj", "$out\kernel32.lib", "$out\ntdll.lib"))
  $null = Check-Imports $name @('kernel32.dll', 'ntdll.dll')
}
Run-Executable 'foreign-control' 98
Run-Executable 'foreign-seh' -1073741795 # STATUS_ILLEGAL_INSTRUCTION, 0xC000001D.
@(
  @{ status = 'pass'; claim = 'native no-CRT console PE, memory routines, large frame, floating point, heap, synchronization API set' },
  @{ status = 'pass'; claim = 'reduced foreign SEH guard traps before outer C catch; unguarded control catches' },
  @{ status = 'not-checked'; claim = 'i128 arithmetic/conversion execution'; reason = 'Stock compiler-rt archive requires __security_cookie and __security_check_cookie; no no-CRT supply implemented.' },
  @{ status = 'not-checked'; claim = 'Silk hello and direct/indirect/callback foreign-unwind corpus on Windows'; reason = 'Windows Silk target/runtime is separate work; these are isolated C and handwritten LLVM IR fixtures.' }
) | ConvertTo-Json | Set-Content -Encoding UTF8 "$out\results.json"
Write-Output "PASS: baseline no-CRT executable and reduced foreign SEH proof. Extended builtins remain BLOCKED. Evidence: $out"
