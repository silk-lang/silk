param(
  [Parameter(Mandatory=$true)][string]$Archive,
  [Parameter(Mandatory=$true)][string]$OutputDirectory
)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
. "$root/install.ps1"
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
# Suspended real processes keep their executable images mapped without racing --version's
# exit. No fixture code replaces the release executable or supplies its expected behavior.
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class SilkInstallerMappedImage {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  struct Startup {
    public uint size; public string reserved, desktop, title;
    public uint x, y, width, height, columns, rows, fill, flags;
    public ushort show, reservedBytes; public IntPtr reservedData, input, output, error;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct ProcessInfo { public IntPtr process, thread; public uint pid, tid; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool CreateProcessW(string application, string command, IntPtr processSecurity,
    IntPtr threadSecurity, bool inherit, uint flags, IntPtr environment, string directory,
    ref Startup startup, out ProcessInfo process);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr process, uint timeout);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  public static IntPtr Hold(string path) {
    var startup = new Startup(); startup.size = (uint)Marshal.SizeOf(typeof(Startup));
    ProcessInfo info;
    if (!CreateProcessW(path, null, IntPtr.Zero, IntPtr.Zero, false, 0x08000004,
        IntPtr.Zero, null, ref startup, out info)) throw new Win32Exception();
    CloseHandle(info.thread); return info.process;
  }
  public static void Release(IntPtr process) {
    TerminateProcess(process, 0); WaitForSingleObject(process, 10000); CloseHandle(process);
  }
}
'@
[IO.Directory]::CreateDirectory($OutputDirectory) | Out-Null
$output = (Resolve-Path $OutputDirectory).Path
$assets = Join-Path $output 'assets'
[IO.Directory]::CreateDirectory($assets) | Out-Null
$name = [IO.Path]::GetFileName($Archive)
if ($name -notmatch '^silk-(.+)-x86_64-pc-windows-msvc\.zip$') { throw 'Unexpected fixture archive' }
$version = $Matches[1]
$top = [IO.Path]::GetFileNameWithoutExtension($name)
$fixture = Join-Path $assets $name
Copy-Item -LiteralPath $Archive -Destination $fixture
# Verification-only CI builds have no release projection. Supply an independent published
# snapshot in that case; release-mode archives already carry their actual immutable snapshot.
$zip = [IO.Compression.ZipFile]::Open($fixture, [IO.Compression.ZipArchiveMode]::Update)
try {
  $entry = $zip.GetEntry("$top/lib/silk/changes-snapshot.toml")
  if (!$entry) {
    $entry = $zip.CreateEntry("$top/lib/silk/changes-snapshot.toml")
    $entry.ExternalAttributes = 0
    $writer = [IO.StreamWriter]::new($entry.Open(), [Text.UTF8Encoding]::new($false))
    try { $writer.Write("version = `"$version`"`n") } finally { $writer.Dispose() }
  }
} finally { $zip.Dispose() }
$zip = [IO.Compression.ZipFile]::OpenRead($fixture)
try {
  $compiler = $zip.GetEntry("$top/bin/silkc.exe").Open()
  $sha = [Security.Cryptography.SHA256]::Create()
  try { $compilerHash = ([BitConverter]::ToString($sha.ComputeHash($compiler))).Replace('-', '').ToLowerInvariant() }
  finally { $compiler.Dispose(); $sha.Dispose() }
  $snapshot = [IO.StreamReader]::new($zip.GetEntry("$top/lib/silk/changes-snapshot.toml").Open())
  try { [IO.File]::WriteAllText((Join-Path $assets 'changes-snapshot.toml'), $snapshot.ReadToEnd()) }
  finally { $snapshot.Dispose() }
} finally { $zip.Dispose() }
$seed = @{schemaVersion=2; seeds=@{'x86_64-pc-windows-msvc'=@{tag="v$version"; asset='silk-compiler-x86_64-pc-windows-msvc.exe'; sha256=$compilerHash}}}
[IO.File]::WriteAllText((Join-Path $assets 'native-seed.json'), ($seed | ConvertTo-Json -Depth 6))
[IO.File]::WriteAllText("$fixture.minisig", 'unused by the GitHub SHA-256 verification path')
$releaseAssets = foreach ($file in Get-ChildItem -LiteralPath $assets -File) {
  @{name=$file.Name; browser_download_url="https://github.com/silk-lang/silk/releases/download/v$version/$($file.Name)"; digest=('sha256:'+(Get-FileHash $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant())}
}
$script:fixtureRelease = [pscustomobject]@{tag_name="v$version"; draft=$false; prerelease=$false; assets=$releaseAssets}
$script:fixtureAssets = $assets
# Mock only the external download/API boundary and absence of the optional minisign program.
# The ZIP reader, hash verification, native executables, and publication operations are real.
function Get-SilkApi([string]$Path) { return $script:fixtureRelease }
function Save-SilkAsset($Asset, [string]$Destination) {
  Copy-Item -LiteralPath (Join-Path $script:fixtureAssets $Asset.name) -Destination $Destination
}
function Get-Command([string]$Name, $ErrorAction) {
  if ($Name -eq 'minisign') { return $null }
  Microsoft.PowerShell.Core\Get-Command -Name $Name -ErrorAction $ErrorAction
}
$silkHome = Join-Path $output 'home with spaces'
Install-Silk -Requested "v$version" -Channel stable -HomeDirectory $silkHome
$settings = Join-Path $silkHome 'settings.toml'
[IO.File]::AppendAllText($settings, "auto-install = true`n")
$mappedTool = [SilkInstallerMappedImage]::Hold((Join-Path $silkHome 'bin/silk.exe'))
$mappedCompiler = [IntPtr]::Zero
try {
  $mappedCompiler = [SilkInstallerMappedImage]::Hold((Join-Path $silkHome "toolchains/$version/bin/silkc.exe"))
  Install-Silk -Requested "v$version" -Channel stable -HomeDirectory $silkHome
  $current = (Get-FileHash -LiteralPath (Join-Path $silkHome 'bin/silk.exe')).Hash
  $refused = $false
  try { Install-Silk -Requested "v$version" -Channel stable -HomeDirectory $silkHome }
  catch { $refused = $_.Exception -is [UnauthorizedAccessException] -or $_.Exception -is [IO.IOException] }
  if (!$refused -or (Get-FileHash -LiteralPath (Join-Path $silkHome 'bin/silk.exe')).Hash -cne $current) {
    throw 'An update did not preserve the current tool when its previous image remained mapped'
  }
} finally {
  if ($mappedCompiler -ne [IntPtr]::Zero) { [SilkInstallerMappedImage]::Release($mappedCompiler) }
  [SilkInstallerMappedImage]::Release($mappedTool)
}
Install-Silk -Requested "v$version" -Channel stable -HomeDirectory $silkHome
if (!(Select-String -LiteralPath $settings -Pattern '^auto-install = true$' -Quiet)) { throw 'Reinstallation lost auto-install' }
if (Test-Path -LiteralPath (Join-Path $silkHome "toolchains/$version/bin/silk.exe")) { throw 'The toolchain retained a second tool' }
$oldHome = $env:SILK_HOME
$env:SILK_HOME = $silkHome
try {
  $reported = & (Join-Path $silkHome 'bin/silk.exe') "+$version" --version
  if ($LASTEXITCODE -ne 0 -or $reported -cne "silk v$version") { throw 'The installed tool did not forward to its compiler' }
} finally { $env:SILK_HOME = $oldHome }
# Corrupt the archive while retaining the independently recorded API digest.
$bytes = [IO.File]::ReadAllBytes($fixture)
$bytes[0] = $bytes[0] -bxor 1
[IO.File]::WriteAllBytes($fixture, $bytes)
$refused = $false
$badHome = Join-Path $output 'corrupt home'
try { Install-Silk -Requested "v$version" -Channel stable -HomeDirectory $badHome }
catch { $refused = $_.Exception.Message -eq 'Release ZIP SHA-256 differs from GitHub metadata' }
if (!$refused -or (Test-Path -LiteralPath (Join-Path $badHome 'bin/silk.exe'))) { throw 'A corrupt ZIP was published' }
if (@(Get-ChildItem -LiteralPath (Join-Path $badHome 'toolchains')).Count -ne 0) { throw 'Corrupt archive staging was retained' }
$index = 0
foreach ($member in @('../escaped', '.. /escaped', 'bin/silk.exe.', 'bin/NUL.txt', 'bin/bad?name')) {
  $unsafe = Join-Path $output "unsafe-$index.zip"
  $zip = [IO.Compression.ZipFile]::Open($unsafe, [IO.Compression.ZipArchiveMode]::Create)
  try { $entry = $zip.CreateEntry("$top/$member"); $entry.ExternalAttributes = 0 } finally { $zip.Dispose() }
  $refused = $false
  try { Expand-SilkZip $unsafe (Join-Path $output "unsafe-output-$index") $top }
  catch { $refused = $_.Exception.Message -in @('ZIP member escapes its release directory', 'ZIP member contains a Windows path alias or reserved name') }
  if (!$refused) { throw "Unsafe ZIP member was accepted: $member" }
  $index++
}
@{status='passed'; version=$version; checks=@('install','mapped-image-reinstall','mapped-backup-refusal','reinstall-after-exit','tool-forwarding','preserve-settings','archive-digest-refusal','failed-install-cleanup','zip-traversal-and-alias-refusal')} |
  ConvertTo-Json | Set-Content (Join-Path $output 'results.json')
