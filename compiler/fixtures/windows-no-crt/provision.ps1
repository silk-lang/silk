param([string]$ToolsRoot = "$env:USERPROFILE\silk-windows-tools")
$ErrorActionPreference = 'Stop'
$assetName = 'clang+llvm-22.1.8-x86_64-pc-windows-msvc.tar.xz'
$expectedHash = 'd96c2cc1736f4eb7fa43cb9bbdf56d93551a9ae0a9aadb9c99c3c3b2b712a234'
$ToolsRoot = [IO.Path]::GetFullPath($ToolsRoot)
New-Item -ItemType Directory -Force $ToolsRoot | Out-Null
$metadata = & gh api repos/llvm/llvm-project/releases/tags/llvmorg-22.1.8
if ($LASTEXITCODE) { throw 'Official LLVM 22.1.8 release could not be read.' }
$release = ($metadata -join "`n") | ConvertFrom-Json
$assets = @($release.assets | Where-Object name -eq $assetName)
if ($assets.Count -ne 1) { throw "Pinned stock LLVM archive is unavailable: $assetName" }
$asset = $assets[0]
if ($asset.digest -ne "sha256:$expectedHash") { throw 'Release digest differs from the pinned archive.' }
$metadata | Set-Content -Encoding UTF8 "$ToolsRoot\llvm-release.json"
$archive = Join-Path $ToolsRoot $assetName
if (-not (Test-Path -LiteralPath $archive)) {
  & curl.exe --fail --location --silent --show-error $asset.browser_download_url --output $archive
  if ($LASTEXITCODE) { throw 'LLVM download failed.' }
}
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedHash) {
  throw "LLVM checksum mismatch; remove the invalid archive before retrying: $archive"
}
$install = Join-Path $ToolsRoot 'clang+llvm-22.1.8-x86_64-pc-windows-msvc'
# The receipt is written only after extraction and every required tool check succeeds.
$receipt = Join-Path $install 'silk-portable-sha256.txt'
if (-not (Test-Path -LiteralPath $receipt) -or (Get-Content $receipt -Raw).Trim() -ne $expectedHash) {
  & tar.exe -xf $archive -C $ToolsRoot
  if ($LASTEXITCODE) { throw 'LLVM extraction failed.' }
}
foreach ($tool in 'clang', 'lld-link', 'llvm-dlltool', 'llvm-readobj', 'llvm-nm', 'llvm-objdump') {
  if (-not (Test-Path -LiteralPath "$install\bin\$tool.exe")) { throw "Missing $tool" }
}
$version = & "$install\bin\clang.exe" --version
if ($LASTEXITCODE -or ($version -join "`n") -notmatch '^clang version 22\.1\.8\b') {
  throw 'Extracted Clang does not report the pinned version.'
}
$expectedHash | Set-Content -Encoding ASCII $receipt
$version
Write-Output "LLVM bin: $install\bin"
