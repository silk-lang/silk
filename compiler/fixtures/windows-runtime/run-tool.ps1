param(
  [Parameter(Mandatory=$true)][string]$ToolDirectory,
  [Parameter(Mandatory=$true)][string]$Compiler,
  [Parameter(Mandatory=$true)][string]$OutputDirectory
)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force $OutputDirectory | Out-Null
$output = (Resolve-Path -LiteralPath $OutputDirectory).Path
$tool = Join-Path $output 'silk.exe'
Copy-Item -LiteralPath (Join-Path $ToolDirectory 'silk.exe') -Destination $tool
Copy-Item -LiteralPath $Compiler -Destination (Join-Path $output 'silkc.exe')
$project = Join-Path $output 'project with spaces'
New-Item -ItemType Directory -Force $project | Out-Null
[IO.File]::WriteAllText((Join-Path $project 'silk.toml'), "[package]`nname = `"windows-tool-fixture`"`nversion = `"0.1.0`"`nsilk-version = `"0.0.0`"`n")
$results = [Collections.Generic.List[object]]::new()
function Invoke-Tool([string]$Name, [string[]]$Arguments) {
  $start = [Diagnostics.ProcessStartInfo]::new()
  $start.FileName = $tool
  $start.WorkingDirectory = $project
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardInput = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $start.Arguments = (($Arguments | ForEach-Object { '"' + ($_ -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"' }) -join ' ')
  $child = [Diagnostics.Process]::Start($start)
  try {
    $child.StandardInput.Close()
    $stdout = $child.StandardOutput.ReadToEndAsync()
    $stderr = $child.StandardError.ReadToEndAsync()
    if (!$child.WaitForExit(60000)) { $child.Kill(); throw "$Name timed out" }
    [IO.File]::WriteAllText((Join-Path $output "$Name.stdout.txt"), $stdout.Result)
    [IO.File]::WriteAllText((Join-Path $output "$Name.stderr.txt"), $stderr.Result)
    if ($child.ExitCode -ne 0) { throw "$Name exited $($child.ExitCode): $($stderr.Result)" }
    $results.Add(@{name=$Name; status='pass'})
    return $stdout.Result
  } finally { $child.Dispose() }
}
$version = Invoke-Tool 'forward-version' @('--version')
if ($version -notmatch '^silk v') { throw 'Forwarded compiler version was missing' }
$null = Invoke-Tool 'changeset' @('change', '--dir', $project, 'patch', 'Verify Windows changeset creation.')
$notes = @(Get-ChildItem -LiteralPath (Join-Path $project '.changes') -Filter '*.md')
if ($notes.Count -ne 1 -or [IO.File]::ReadAllText($notes[0].FullName) -notmatch 'Verify Windows changeset creation\.') {
  throw 'The tool did not create the expected changeset'
}
$fixtureDirectory = Join-Path $output 'mapped-image'
New-Item -ItemType Directory -Force $fixtureDirectory | Out-Null
$fixture = Join-Path $fixtureDirectory 'host.exe'
Copy-Item -LiteralPath (Join-Path $ToolDirectory 'host-files.exe') -Destination $fixture
$original = (Get-FileHash -LiteralPath $fixture -Algorithm SHA256).Hash
& $fixture
if ($LASTEXITCODE -ne 0) { throw "Mapped-image fixture failed with $LASTEXITCODE" }
$preserved = (Get-FileHash -LiteralPath (Join-Path $fixtureDirectory 'previous.exe') -Algorithm SHA256).Hash
if ($original -cne $preserved) { throw 'The retained hard link changed image bytes' }
if ([IO.File]::ReadAllText($fixture) -cne "Windows image replacement`n") { throw 'The mapped image was not replaced' }
$results.Add(@{name='mapped-image-replacement'; status='pass'; retainedImage=$preserved})
$installHome = Join-Path $output 'signed installation'
$installBin = Join-Path $installHome 'bin'
New-Item -ItemType Directory -Force $installBin | Out-Null
$installer = Join-Path $installBin 'silk.exe'
Copy-Item -LiteralPath (Join-Path $ToolDirectory 'install.exe') -Destination $installer
$original = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash
& $installer
if ($LASTEXITCODE -ne 0) { throw "Signed ZIP installation fixture failed with $LASTEXITCODE" }
if ([IO.File]::ReadAllText($installer) -cne "updated Windows tool`n") { throw 'Self-update did not replace the mapped tool' }
$previous = (Get-FileHash -LiteralPath (Join-Path $installBin '.silk-previous.exe') -Algorithm SHA256).Hash
if ($previous -cne $original) { throw 'The retained previous tool image changed' }
if ([IO.File]::ReadAllText((Join-Path $installHome 'toolchains/1.2.3/bin/silkc.exe')) -cne "MZ fixture compiler`n") { throw 'Signed ZIP compiler bytes changed' }
$results.Add(@{name='signed-zip-install-and-self-update'; status='pass'; retainedImage=$previous})
$results | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $output 'results.json')
$results | ConvertTo-Json -Depth 5
