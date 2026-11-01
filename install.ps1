# Installs a published x86_64 Windows release without administrator privileges.
#   irm https://raw.githubusercontent.com/silk-lang/silk/main/install.ps1 | iex
# SILK_RELEASE selects an exact v<version>; SILK_CHANNEL is auto, stable, or dev.
# SILK_HOME defaults to USERPROFILE/.silk. GITHUB_TOKEN is used only for the GitHub API.
[CmdletBinding()]
param(
  [string]$Release = $env:SILK_RELEASE,
  [ValidateSet('auto', 'stable', 'dev')][string]$Channel = $(if ($env:SILK_CHANNEL) { $env:SILK_CHANNEL } else { 'auto' }),
  [string]$HomeDirectory = $(if ($env:SILK_HOME) { $env:SILK_HOME } else { Join-Path $env:USERPROFILE '.silk' })
)

$SilkMinisignPublicKey = 'RWQefAo9Dbb8LrlLPaqWdRNlX5th2l7r+4WYhxRNbe5K5URDUht1XUDs'

function Test-SilkTag([string]$Tag) {
  if ($Tag -cnotmatch '^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$') { return $false }
  foreach ($part in ($Matches[4] -split '\.')) {
    if ($part -match '^0[0-9]+$') { return $false }
  }
  return $true
}

function Get-SilkApi([string]$Path) {
  $headers = @{ Accept = 'application/vnd.github+json'; 'User-Agent' = 'silk-windows-installer' }
  if ($env:GITHUB_TOKEN) { $headers.Authorization = "Bearer $env:GITHUB_TOKEN" }
  Invoke-RestMethod -Uri "https://api.github.com/repos/silk-lang/silk/$Path" -Headers $headers
}

function Get-SilkRelease([string]$Requested, [string]$Channel) {
  if ($Requested) {
    if (!(Test-SilkTag $Requested)) { throw 'SILK_RELEASE must be v<semver>, for example v0.1.0' }
    $chosen = Get-SilkApi "releases/tags/$([Uri]::EscapeDataString($Requested))"
    if ($chosen.draft -or $chosen.tag_name -cne $Requested) { throw 'The requested release is not published' }
    return $chosen
  }
  if ($Channel -ne 'dev') {
    try {
      $stable = Get-SilkApi 'releases/latest'
      if ($stable.draft -or $stable.prerelease -or !(Test-SilkTag $stable.tag_name)) { throw 'The latest stable release metadata is invalid' }
      return $stable
    } catch {
      $response = $_.Exception.Response
      if (!$response -or [int]$response.StatusCode -ne 404 -or $Channel -eq 'stable') { throw }
    }
  }
  # GitHub returns releases in descending creation order. Choose the newest published dev
  # release, excluding drafts and the separate bootstrap seed namespace.
  for ($page = 1; ; $page++) {
    $releases = @(Get-SilkApi "releases?per_page=100&page=$page")
    foreach ($candidate in $releases) {
      if (!$candidate.draft -and $candidate.prerelease -and (Test-SilkTag $candidate.tag_name) -and $candidate.tag_name -match '-dev\.') { return $candidate }
    }
    if ($releases.Count -lt 100) { throw 'There is no published Windows-compatible development release' }
  }
}

function Get-SilkAsset($Release, [string]$Name) {
  $found = @($Release.assets | Where-Object { $_.name -ceq $Name })
  if ($found.Count -ne 1) { throw "Release $($Release.tag_name) has no unique $Name asset" }
  $uri = [Uri]$found[0].browser_download_url
  if ($uri.Scheme -cne 'https' -or $uri.Host -cne 'github.com') { throw 'Unexpected release asset URL' }
  return $found[0]
}

function Save-SilkAsset($Asset, [string]$Destination) {
  Invoke-WebRequest -UseBasicParsing -Uri $Asset.browser_download_url -OutFile $Destination
}

function Expand-SilkZip([string]$Archive, [string]$Destination, [string]$Top) {
  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [IO.Compression.ZipFile]::OpenRead($Archive)
  try {
    if ($zip.Entries.Count -gt 65535) { throw 'The release ZIP has too many entries' }
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $total = [long]0
    foreach ($entry in $zip.Entries) {
      $name = $entry.FullName
      if ($name.Contains('\') -or $name.Contains(':') -or $name.Contains([string][char]0) -or $name.StartsWith('/')) { throw 'Unsafe ZIP member path' }
      $directory = $name.EndsWith('/')
      $relative = if ($directory) { $name.Substring(0, $name.Length - 1) } else { $name }
      $parts = $relative -split '/'
      if ($parts[0] -cne $Top -or @($parts | Where-Object { $_ -eq '' -or $_ -eq '.' -or $_ -eq '..' }).Count) { throw 'ZIP member escapes its release directory' }
      foreach ($part in $parts) {
        if ($part -match '[\x00-\x1f<>"|?*]' -or $part -match '[. ]$' -or
            $part -match '^(?i:CON|PRN|AUX|NUL|COM[1-9\u00b9\u00b2\u00b3]|LPT[1-9\u00b9\u00b2\u00b3])(?:\.|$)') {
          throw 'ZIP member contains a Windows path alias or reserved name'
        }
      }
      if (!$seen.Add($relative) -or ($entry.ExternalAttributes -ne 0 -and $entry.ExternalAttributes -ne 16)) { throw 'ZIP member is duplicated or is not an ordinary Windows file' }
      $total += $entry.Length
      if ($total -gt 1073741824 -or ($directory -and $entry.Length -ne 0)) { throw 'The release ZIP exceeds its decoded size limit' }
      $target = Join-Path $Destination $relative
      if ($directory) { [IO.Directory]::CreateDirectory($target) | Out-Null; continue }
      [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target)) | Out-Null
      $entryStream = $entry.Open()
      try {
        $output = [IO.File]::Open($target, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try {
          $buffer = [byte[]]::new(65536)
          $written = [long]0
          while (($count = $entryStream.Read($buffer, 0, $buffer.Length)) -ne 0) {
            if ($count -gt $entry.Length - $written) { throw 'ZIP member exceeds its declared length' }
            $output.Write($buffer, 0, $count)
            $written += $count
          }
          if ($written -ne $entry.Length) { throw 'ZIP member is truncated' }
        } finally { $output.Dispose() }
      } finally { $entryStream.Dispose() }
    }
  } finally { $zip.Dispose() }
}

function Remove-SilkStage([string]$Path, [string]$Parent) {
  # Only directories created by this invocation are removed recursively.
  $full = [IO.Path]::GetFullPath($Path)
  $expected = [IO.Path]::GetFullPath($Parent).TrimEnd('\', '/')
  if (![string]::Equals([IO.Path]::GetDirectoryName($full), $expected, [StringComparison]::OrdinalIgnoreCase) -or
      [IO.Path]::GetFileName($full) -notmatch '^\.silk-install-[0-9a-f]{32}$') { throw 'Refusing to clean a path outside the installation staging directory' }
  if (Test-Path -LiteralPath $full) {
    if ((Get-Item -LiteralPath $full).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Refusing to clean a replaced staging directory' }
    Remove-Item -LiteralPath $full -Recurse -Force
  }
}

function Remove-SilkPreviousToolchain([string]$Store) {
  $parent = [IO.Path]::GetFullPath($Store).TrimEnd('\', '/')
  $previous = [IO.Path]::GetFullPath((Join-Path $parent '.silk-previous-toolchain'))
  if ([IO.Path]::GetDirectoryName($previous) -cne $parent) { throw 'Invalid previous toolchain path' }
  if (Test-Path -LiteralPath $previous) {
    if ((Get-Item -LiteralPath $previous).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Refusing to clean a replaced previous toolchain' }
    Remove-Item -LiteralPath $previous -Recurse -Force
  }
}

function Install-Silk([string]$Requested, [string]$Channel, [string]$HomeDirectory) {
  $ErrorActionPreference = 'Stop'
  if (![Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { throw 'This release requires Windows x86_64' }
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  $release = Get-SilkRelease $Requested $Channel
  $version = $release.tag_name.Substring(1)
  $top = "silk-$version-x86_64-pc-windows-msvc"
  $asset = Get-SilkAsset $release "$top.zip"
  $signatureAsset = Get-SilkAsset $release "$top.zip.minisig"
  $silkHome = [IO.Path]::GetFullPath($HomeDirectory)
  $store = Join-Path $silkHome 'toolchains'
  [IO.Directory]::CreateDirectory($store) | Out-Null
  $stage = Join-Path $store ('.silk-install-' + [Guid]::NewGuid().ToString('N'))
  [IO.Directory]::CreateDirectory($stage) | Out-Null
  try {
    $archive = Join-Path $stage "$top.zip"
    $signature = "$archive.minisig"
    Save-SilkAsset $asset $archive
    Save-SilkAsset $signatureAsset $signature
    $minisign = Get-Command minisign -ErrorAction SilentlyContinue
    if ($asset.digest -match '^sha256:([a-f0-9]{64})$') {
      $expectedArchive = $Matches[1]
      if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -cne $expectedArchive) { throw 'Release ZIP SHA-256 differs from GitHub metadata' }
    } elseif (!$minisign) { throw 'This asset has no SHA-256 digest; install minisign to verify its signature before bootstrapping' }
    if ($minisign) {
      $comment = & $minisign.Source -V -P $SilkMinisignPublicKey -m $archive -x $signature -Q
      if ($LASTEXITCODE -ne 0 -or $comment -cne "silk $($release.tag_name) $top.zip") { throw 'Release archive signature or trusted comment is invalid' }
    }
    $seedPath = Join-Path $stage 'native-seed.json'
    Save-SilkAsset (Get-SilkAsset $release 'native-seed.json') $seedPath
    $seed = (Get-Content -LiteralPath $seedPath -Raw | ConvertFrom-Json).seeds.'x86_64-pc-windows-msvc'
    if (!$seed -or $seed.tag -cne $release.tag_name -or $seed.asset -cne 'silk-compiler-x86_64-pc-windows-msvc.exe' -or $seed.sha256 -cnotmatch '^[a-f0-9]{64}$') { throw 'The published pin does not identify this Windows compiler' }
    Expand-SilkZip $archive $stage $top
    $tree = Join-Path $stage $top
    $compiler = Join-Path $tree 'bin/silkc.exe'
    $tool = Join-Path $tree 'bin/silk.exe'
    if (!(Test-Path -LiteralPath $tool -PathType Leaf) -or !(Test-Path -LiteralPath (Join-Path $tree 'lib/silk/stdlib') -PathType Container)) { throw 'The release has no tool or standard library' }
    if ((Get-FileHash -LiteralPath $compiler -Algorithm SHA256).Hash.ToLowerInvariant() -cne $seed.sha256) { throw 'The compiler differs from native-seed.json' }
    $snapshot = Join-Path $stage 'changes-snapshot.toml'
    Save-SilkAsset (Get-SilkAsset $release 'changes-snapshot.toml') $snapshot
    $embedded = Join-Path $tree 'lib/silk/changes-snapshot.toml'
    if ((Get-FileHash -LiteralPath $snapshot).Hash -cne (Get-FileHash -LiteralPath $embedded).Hash) { throw 'The embedded change snapshot differs from the published release' }
    $reported = & $compiler --version
    if ($LASTEXITCODE -ne 0 -or $reported -cne "silk v$version") { throw 'The compiler does not report the selected release version' }
    $bin = Join-Path $silkHome 'bin'
    [IO.Directory]::CreateDirectory($bin) | Out-Null
    $lock = [IO.File]::Open((Join-Path $bin '.update.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    try {
      $destination = Join-Path $store $version
      # Retain old images outside temporary staging: Windows cannot unlink the last name
      # of an executable while it is mapped. Refuse a later update before publication if
      # the previous generation is still running.
      $previous = Join-Path $store '.silk-previous-toolchain'
      $previousTool = Join-Path $bin '.silk-previous.exe'
      if (Test-Path -LiteralPath $previousTool) { Remove-Item -LiteralPath $previousTool -Force }
      Remove-SilkPreviousToolchain $store
      if (Test-Path -LiteralPath $destination) { [IO.Directory]::Move($destination, $previous) }
      try { [IO.Directory]::Move($tree, $destination) } catch {
        if (Test-Path -LiteralPath $previous) { [IO.Directory]::Move($previous, $destination) }
        throw
      }
      $fresh = Join-Path $destination 'bin/silk.exe'
      $front = Join-Path $bin 'silk.exe'
      if (Test-Path -LiteralPath $front) {
        [IO.File]::Replace($fresh, $front, $previousTool)
      } else { [IO.File]::Move($fresh, $front) }
      $settings = Join-Path $silkHome 'settings.toml'
      $automatic = (Test-Path -LiteralPath $settings) -and (Select-String -LiteralPath $settings -Pattern '^\s*auto-install\s*=\s*true\s*(#.*)?$' -Quiet)
      $text = "# Written by install.ps1.`ndefault = `"$version`"`n"
      if ($automatic) { $text += "auto-install = true`n" }
      $settingsStage = Join-Path $stage 'settings.toml'
      [IO.File]::WriteAllText($settingsStage, $text)
      if (Test-Path -LiteralPath $settings) { [IO.File]::Replace($settingsStage, $settings, (Join-Path $stage 'previous-settings.toml')) }
      else { [IO.File]::Move($settingsStage, $settings) }
    } finally { $lock.Dispose() }
    Write-Output "Installed silk v$version to $destination"
    Write-Output "Add $bin to your user PATH. Silk needs LLVM 22 or newer on PATH, or SILK_CLANG set to clang.exe."
  } finally { Remove-SilkStage $stage $store }
}

if ($MyInvocation.InvocationName -ne '.') {
  Install-Silk -Requested $Release -Channel $Channel -HomeDirectory $HomeDirectory
}
