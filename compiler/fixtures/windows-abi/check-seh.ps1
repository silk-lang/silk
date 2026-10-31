param(
  [string]$LlvmBin = "$env:USERPROFILE\silk-windows-tools\clang+llvm-22.1.8-x86_64-pc-windows-msvc\bin",
  [string]$OutputDirectory = '.scratch/windows-abi-seh'
)
$ErrorActionPreference = 'Stop'
$out = [IO.Path]::GetFullPath($OutputDirectory)
$null = New-Item -ItemType Directory -Force -Path $out
$utf8 = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText("$out/commands.log", '', $utf8)
function Require([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}
function Tool([string]$Name, [string[]]$Arguments) {
  Add-Content "$out/commands.log" "$Name $($Arguments -join ' ')"
  $text = (& "$LlvmBin/$Name.exe" @Arguments 2>&1 | Out-String)
  Require ($LASTEXITCODE -eq 0) "$Name failed: $text"
  return $text
}
function Run-Child([string]$Name, [int]$ExpectedExit) {
  $child = New-Object System.Diagnostics.Process
  $child.StartInfo.FileName = "$out/$Name.exe"
  $child.StartInfo.UseShellExecute = $false
  $child.StartInfo.CreateNoWindow = $true
  try {
    $null = $child.Start()
    if (-not $child.WaitForExit(10000)) {
      $child.Kill()
      throw "$Name exceeded the fixture timeout"
    }
    $code = $child.ExitCode
    Add-Content "$out/commands.log" "$Name.exe exit=$code"
    Require ($code -eq $ExpectedExit) "$Name exited $code, expected $ExpectedExit"
    Write-Output "$Name.exe: exit $code"
  } finally { $child.Dispose() }
}

$version = Tool 'clang' @('--version')
Require ($version -match '^clang version 22\.1\.8\b') 'Use stock LLVM 22.1.8.'
[IO.File]::WriteAllText("$out/clang-version.txt", $version, $utf8)
$cc = @('--target=x86_64-pc-windows-msvc19.33.0', '-O2', '-ffreestanding', '-fno-stack-protector', '-Werror')
$null = Tool 'clang' ($cc + @('-S', '-emit-llvm', '-fno-discard-value-names', '-fdebug-compilation-dir=.',
  "$PSScriptRoot/seh-personality.c", '-o', "$out/seh-personality.ll"))
$oracle = [IO.File]::ReadAllText("$out/seh-personality.ll")
Require ($oracle -match 'define[^\r\n]+ i32 @windows_personality\(ptr[^,]+, i64[^,]+, ptr[^,]+, ptr[^)]+\)') 'Clang did not emit the documented four-argument Windows handler ABI.'
$guard = [IO.File]::ReadAllText("$PSScriptRoot/seh-guard.ll")
Require ($guard -match 'define linkonce_odr hidden i32 @__silk_foreign_personality\(ptr %exception,\s*i64 %frame, ptr %context, ptr %dispatcher\)') 'The reduced guard does not use the independently derived Windows handler signature.'
Require ($oracle.Contains('asm sideeffect "int $$0x29", "{cx}"(i32 7)') -and $guard.Contains('asm sideeffect "int $$0x29", "{cx}"(i32 7)')) 'The guard must use the independently emitted fast-fail instruction and reason.'
$null = Tool 'clang' ($cc + @('-c', "$PSScriptRoot/seh-guard.ll", '-Wno-override-module', '-o', "$out/seh-guard.obj"))
$null = Tool 'clang' ($cc + @('-c', "$PSScriptRoot/seh-caller.c", '-o', "$out/guarded.obj"))
$null = Tool 'clang' ($cc + @('-DUNGUARDED_CONTROL', '-c', "$PSScriptRoot/seh-caller.c", '-o', "$out/control.obj"))
$unwind = Tool 'llvm-readobj' @('--unwind', '--relocations', "$out/seh-guard.obj")
[IO.File]::WriteAllText("$out/seh-unwind.txt", $unwind, $utf8)
Require ($unwind -match 'Handler: __silk_foreign_personality') 'The guard lacks SEH personality registration.'
$defined = Tool 'llvm-nm' @('--defined-only', "$out/seh-guard.obj")
[IO.File]::WriteAllText("$out/seh-defined.txt", $defined, $utf8)
$undefined = Tool 'llvm-nm' @('--undefined-only', "$out/seh-guard.obj")
[IO.File]::WriteAllText("$out/seh-undefined.txt", $undefined, $utf8)
$symbols = @([regex]::Matches($undefined, '(?m) U (\w+)\r?$') | ForEach-Object { $_.Groups[1].Value })
Require ($symbols.Count -eq 1 -and $symbols[0] -eq 'raise_foreign') 'The reduced guard introduced an unexpected runtime dependency.'
[IO.File]::WriteAllText("$out/kernel32.def", "LIBRARY kernel32.dll`nEXPORTS`n  ExitProcess`n  RaiseException`n  SetErrorMode`n", $utf8)
[IO.File]::WriteAllText("$out/ntdll.def", "LIBRARY ntdll.dll`nEXPORTS`n  __C_specific_handler`n", $utf8)
foreach ($dll in 'kernel32', 'ntdll') {
  $null = Tool 'llvm-dlltool' @('-m', 'i386:x86-64', '-d', "$out/$dll.def", '-l', "$out/$dll.lib")
}
foreach ($name in 'guarded', 'control') {
  $null = Tool 'lld-link' @('/nologo', '/nodefaultlib', '/machine:x64', '/subsystem:console',
    '/entry:mainCRTStartup', '/timestamp:0', "/out:$out/$name.exe", "$out/$name.obj",
    "$out/seh-guard.obj", "$out/kernel32.lib", "$out/ntdll.lib")
  $imports = Tool 'llvm-readobj' @('--coff-imports', "$out/$name.exe")
  [IO.File]::WriteAllText("$out/$name-imports.txt", $imports, $utf8)
  $dlls = @([regex]::Matches($imports, '(?m)^  Name: (.+\.dll)\r?$') | ForEach-Object { $_.Groups[1].Value.Trim() })
  Require ((($dlls | Sort-Object) -join ',') -eq 'kernel32.dll,ntdll.dll') "$name imports unexpected DLLs: $dlls"
}
Run-Child 'control' 98
Run-Child 'guarded' -1073740791 # Fast fail (0xC0000409), reason FAST_FAIL_FATAL_APP_EXIT.
@(
  @{ status = 'pass'; claim = 'Clang emits the documented four-argument Windows exception routine' },
  @{ status = 'pass'; claim = 'Reduced LLVM guard registers SEH personality and fast-fails before the outer C catch; unguarded control catches' },
  @{ status = 'not-checked'; claim = 'Full Silk Windows foreign-unwind corpus and fatal observer'; reason = 'Silk Windows runtime and linker are separate work; the guard fixture is reduced handwritten LLVM IR.' },
  @{ status = 'not-checked'; claim = 'Compiler-generated Windows helper inventory'; reason = 'No runnable Silk compiler on this Windows host. No compiler-rt supply or stubs added.' }
) | ConvertTo-Json | Set-Content -Encoding UTF8 "$out/results.json"
Write-Output "PASS: Windows handler ABI and reduced SEH boundary. Evidence: $out"
