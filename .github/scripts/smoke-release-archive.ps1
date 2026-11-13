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
  # No --clang or SILK_CLANG either: the archive's bundled LLVM, which makes its tool links on
  # first use.
  $selectedClang = $env:SILK_CLANG
  $env:SILK_CLANG = $null
  & $tool build main.silk -o program.exe --optimization none --debug false
  $env:SILK_CLANG = $selectedClang
  if ($LASTEXITCODE -ne 0) { throw 'The packaged tool could not build a new project' }
  foreach ($link in 'clang.exe', 'lld-link.exe', 'llvm-ar.exe', 'llvm-dlltool.exe') {
    if (-not (Test-Path -LiteralPath (Join-Path $release "lib/silk/llvm/bin/$link"))) { throw "The bundled LLVM has no $link" }
  }
  & (Join-Path $project 'program.exe')
  if ($LASTEXITCODE -ne 42) { throw 'The packaged compiler produced the wrong program result' }

  # A cold git dependency checkout through the tool and through the bundled compiler: the tool
  # must hand the compiler SILK_HOME in Windows' own spelling, and git must get normal names.
  $repository = Join-Path $OutputDirectory 'git-repository'
  New-Item -ItemType Directory -Path (Join-Path $repository 'answer') | Out-Null
  [IO.File]::WriteAllText((Join-Path $repository 'answer/silk.toml'), "[package]`nname = `"answer`"`nversion = `"0.1.0`"`nsource = `".`"`nexports = [`"value`"]`n")
  [IO.File]::WriteAllText((Join-Path $repository 'answer/value.silk'), "pub fn value() -> i32 { return 42 }`n")
  git -C $repository init --quiet
  if ($LASTEXITCODE -ne 0) { throw 'git init of the dependency repository failed' }
  git -C $repository add .
  git -C $repository -c user.name=Silk -c user.email=silk@example.com -c commit.gpgsign=false commit --quiet -m answer
  if ($LASTEXITCODE -ne 0) { throw 'git commit of the dependency repository failed' }
  $commit = (git -C $repository rev-parse HEAD).Trim()
  $url = ([Uri]$repository).AbsoluteUri
  $consumer = Join-Path $OutputDirectory 'git consumer'
  New-Item -ItemType Directory -Path $consumer | Out-Null
  [IO.File]::WriteAllText((Join-Path $consumer 'silk.toml'), "[package]`nname = `"git-smoke`"`nversion = `"0.1.0`"`nsilk-version = `"$version`"`nsource = `".`"`n`n[dependencies]`nanswer = { git = `"$url`", rev = `"$commit`", path = `"answer`" }`n")
  [IO.File]::WriteAllText((Join-Path $consumer 'main.silk'), "import answer.value { value }`n`npub fn main() -> i32 { return value() }`n")
  Set-Location $consumer
  & $tool build main.silk -o program.exe --clang $env:SILK_TEST_CLANG --optimization none --debug false
  if ($LASTEXITCODE -ne 0) { throw 'The packaged tool could not fetch a git dependency' }
  & (Join-Path $consumer 'program.exe')
  if ($LASTEXITCODE -ne 42) { throw 'The git dependency program produced the wrong result' }
  if (-not (Test-Path -LiteralPath (Join-Path $env:SILK_HOME "git/$commit.fetched"))) { throw 'The git checkout is not in the store SILK_HOME names' }
  $env:SILK_HOME = Join-Path $OutputDirectory 'compiler home'
  & $compiler check --progress never
  if ($LASTEXITCODE -ne 0) { throw 'The bundled compiler could not fetch a git dependency' }
  if (-not (Test-Path -LiteralPath (Join-Path $env:SILK_HOME "git/$commit.fetched"))) { throw 'The compiler did not fetch into SILK_HOME' }
} finally {
  Pop-Location
  $env:SILK_HOME = $oldHome
}
