param(
  [Parameter(Mandatory=$true)][string]$Archive,
  [Parameter(Mandatory=$true)][string]$OutputDirectory
)
$ErrorActionPreference = 'Stop'
$name = [IO.Path]::GetFileName($Archive)
if ($name -notmatch '^silk-(.+)-x86_64-pc-windows-msvc\.zip$') { throw 'Unexpected Windows release archive name' }
$version = $Matches[1]
Expand-Archive -LiteralPath $Archive -DestinationPath $OutputDirectory
$OutputDirectory = (Resolve-Path -LiteralPath $OutputDirectory).Path
$release = Join-Path $OutputDirectory ([IO.Path]::GetFileNameWithoutExtension($name))
$compiler = Join-Path $release 'bin/silkc.exe'
$tool = Join-Path $release 'bin/silk.exe'
$reported = & $compiler --version
if ($LASTEXITCODE -ne 0 -or $reported -cne "silk v$version") { throw 'Packaged compiler identity differs' }
$project = Join-Path $OutputDirectory 'new project'
New-Item -ItemType Directory -Path $project | Out-Null
[IO.File]::WriteAllText((Join-Path $project 'silk.toml'), "[package]`nname = `"release-smoke`"`nversion = `"0.1.0`"`nsilk-version = `"$version`"`nsource = `".`"`n")
[IO.File]::WriteAllText((Join-Path $project 'main.silk'), "pub fn main() -> i32 { return 42 }`n")
$oldHome = $env:SILK_HOME
$env:SILK_HOME = Join-Path $OutputDirectory 'isolated home'
Push-Location $project
try {
  # No --stdlib: test the archive's actual installed library discovery and bundled compiler.
  & $tool build main.silk -o program.exe --clang $env:SILK_TEST_CLANG --optimization none --debug false
  if ($LASTEXITCODE -ne 0) { throw 'The packaged tool could not build a new project' }
  & (Join-Path $project 'program.exe')
  if ($LASTEXITCODE -ne 42) { throw 'The packaged compiler produced the wrong program result' }
} finally {
  Pop-Location
  $env:SILK_HOME = $oldHome
}
