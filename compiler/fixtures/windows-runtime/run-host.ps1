param([Parameter(Mandatory=$true)][string]$Executable)
$ErrorActionPreference = 'Stop'
$info = New-Object System.Diagnostics.ProcessStartInfo
$info.FileName = (Resolve-Path -LiteralPath $Executable).Path
# Fixed raw command-line expectations: one empty argument and one argument containing a space.
$info.Arguments = '"" "a b"'
$info.UseShellExecute = $false
$info.CreateNoWindow = $true
$info.RedirectStandardOutput = $true
$info.RedirectStandardError = $true
$info.StandardOutputEncoding = New-Object System.Text.UTF8Encoding($false, $true)
# ProcessStartInfo serializes a custom environment through a Unicode encoder, which replaces
# lone surrogates on .NET Framework. Inherit the raw Win32 environment instead. This mutation is
# local to this launcher process and restored after the child, including on failure.
$variable = 'SILK_' + [char]0xc9
$previous = [Environment]::GetEnvironmentVariable($variable, 'Process')
[Environment]::SetEnvironmentVariable($variable, [string][char]0xd800, 'Process')
$child = New-Object System.Diagnostics.Process
$child.StartInfo = $info
try {
  if (!$child.Start()) { throw 'Could not start host-input probe' }
  $stdout = $child.StandardOutput.ReadToEndAsync()
  $stderr = $child.StandardError.ReadToEndAsync()
  if (!$child.WaitForExit(30000)) { $child.Kill(); throw 'Host-input probe timed out' }
  $output = $stdout.GetAwaiter().GetResult()
  $errors = $stderr.GetAwaiter().GetResult()
  if ($child.ExitCode -ne 0) { throw "Host-input probe exited $($child.ExitCode): $errors" }
  $expected = 'Windows runtime: ok ' + [char]::ConvertFromUtf32(0x1f4a9) + "`n"
  if ($output -cne $expected -or $errors -ne '') { throw 'Host-input probe output mismatch' }
  [pscustomobject]@{ status='passed'; claim='Silk startup arguments, raw snapshot, aligned heap and redirected UTF-8 output'; notChecked='real-console readback, parking, fault handlers' } | ConvertTo-Json
} finally {
  $child.Dispose()
  [Environment]::SetEnvironmentVariable($variable, $previous, 'Process')
}
